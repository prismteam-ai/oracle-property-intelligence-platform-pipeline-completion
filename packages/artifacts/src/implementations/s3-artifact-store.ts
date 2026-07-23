import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type GetObjectOutput,
  type HeadObjectOutput,
  type S3Client,
} from '@aws-sdk/client-s3';

import {
  assertArtifactByteRange,
  assertSha256,
  type ArtifactByteRange,
  type ImmutableArtifactWrite,
  type RecoverableArtifactStore,
  type StreamingImmutableArtifactWrite,
  type StoredArtifact,
} from '../artifact-store.js';
import {
  ArtifactIntegrityError,
  ImmutableArtifactConflictError,
  assertLogicalKey,
  canonicalJson,
  cloneMetadata,
  consumeBody,
} from './internal.js';

const SHA_METADATA = 'oracle-sha256';
const KEY_METADATA = 'oracle-logical-key';
const USER_METADATA = 'oracle-user-metadata';
const STORED_AT_METADATA = 'oracle-stored-at';

export class S3ArtifactStore implements RecoverableArtifactStore {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #spool: string;
  readonly #now: () => string;
  readonly #signal: AbortSignal | undefined;

  public constructor(options: {
    client: S3Client;
    bucket: string;
    prefix?: string;
    spoolDirectory: string;
    now: () => string;
    signal?: AbortSignal;
  }) {
    if (options.bucket.trim().length === 0) throw new TypeError('S3 bucket is required');
    this.#client = options.client;
    this.#bucket = options.bucket;
    this.#prefix = options.prefix?.replace(/^\/+|\/+$/g, '') ?? '';
    this.#spool = resolve(options.spoolDirectory);
    this.#now = options.now;
    this.#signal = options.signal;
  }

  public async putImmutable(request: ImmutableArtifactWrite): Promise<StoredArtifact> {
    return this.putImmutableStreaming(request);
  }

  public async putImmutableStreaming(
    request: StreamingImmutableArtifactWrite,
  ): Promise<StoredArtifact> {
    this.#throwIfAborted();
    assertLogicalKey(request.logicalKey);
    if (request.expectedSha256 !== undefined) assertSha256(request.expectedSha256);
    const metadata = cloneMetadata(request.metadata);
    await mkdir(this.#spool, { recursive: true });
    const temporaryDirectory = await mkdtemp(join(this.#spool, '.oracle-s3-'));
    const temporaryPath = join(temporaryDirectory, 'body');
    const handle = await open(temporaryPath, 'wx');
    try {
      let position = 0;
      const measured = await consumeBody(request.body, async (chunk) => {
        this.#throwIfAborted();
        await handle.write(chunk, 0, chunk.byteLength, position);
        position += chunk.byteLength;
      });
      await handle.sync();
      if (request.expectedSha256 !== undefined && measured.sha256 !== request.expectedSha256) {
        throw new ArtifactIntegrityError(
          `Artifact SHA-256 mismatch: expected ${request.expectedSha256}, received ${measured.sha256}`,
        );
      }
      await handle.close();
      const key = this.#key(request.logicalKey);
      const storedAt = this.#now();
      try {
        await this.#client.send(
          new PutObjectCommand({
            Bucket: this.#bucket,
            Key: key,
            Body: createReadStream(temporaryPath),
            ContentLength: measured.byteSize,
            ContentType: request.mediaType,
            IfNoneMatch: '*',
            Metadata: {
              [SHA_METADATA]: measured.sha256,
              [KEY_METADATA]: request.logicalKey,
              [STORED_AT_METADATA]: storedAt,
              [USER_METADATA]: Buffer.from(canonicalJson(metadata), 'utf8').toString('base64url'),
            },
          }),
          this.#signal === undefined ? undefined : { abortSignal: this.#signal },
        );
      } catch (error) {
        if (isPreconditionFailure(error))
          throw new ImmutableArtifactConflictError(request.logicalKey);
        throw error;
      }
      return Object.freeze({
        logicalKey: request.logicalKey,
        uri: `s3://${this.#bucket}/${key}`,
        mediaType: request.mediaType,
        byteSize: measured.byteSize,
        sha256: measured.sha256,
        storedAt,
        metadata,
      });
    } finally {
      await handle.close().catch(() => undefined);
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  public async head(uri: string): Promise<StoredArtifact | undefined> {
    this.#throwIfAborted();
    const key = this.#keyFromUri(uri);
    let response: HeadObjectOutput;
    try {
      response = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: key }),
        this.#signal === undefined ? undefined : { abortSignal: this.#signal },
      );
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    const metadata = response.Metadata ?? {};
    const byteSize = response.ContentLength;
    const sha256 = metadata[SHA_METADATA];
    const logicalKey = metadata[KEY_METADATA];
    const storedAt = metadata[STORED_AT_METADATA];
    const userMetadata = metadata[USER_METADATA];
    if (
      !Number.isSafeInteger(byteSize) ||
      byteSize === undefined ||
      byteSize < 0 ||
      sha256 === undefined ||
      logicalKey === undefined ||
      storedAt === undefined ||
      userMetadata === undefined ||
      response.ContentType === undefined
    )
      throw new ArtifactIntegrityError(`Incomplete S3 metadata for ${uri}`);
    assertSha256(sha256);
    const parsedMetadata: unknown = JSON.parse(
      Buffer.from(userMetadata, 'base64url').toString('utf8'),
    );
    if (
      parsedMetadata === null ||
      typeof parsedMetadata !== 'object' ||
      Array.isArray(parsedMetadata)
    ) {
      throw new ArtifactIntegrityError(`Invalid S3 user metadata for ${uri}`);
    }
    const record = Object.freeze({
      logicalKey,
      uri,
      mediaType: response.ContentType,
      byteSize,
      sha256,
      storedAt,
      metadata: cloneMetadata(parsedMetadata as Record<string, string>),
    });
    if (this.#key(record.logicalKey) !== key) {
      throw new ArtifactIntegrityError(`S3 logical-key metadata mismatch for ${uri}`);
    }
    return record;
  }

  public async headByLogicalKey(logicalKey: string): Promise<StoredArtifact | undefined> {
    assertLogicalKey(logicalKey);
    const key = this.#key(logicalKey);
    const uri = `s3://${this.#bucket}/${key}`;
    const record = await this.head(uri);
    if (record === undefined) return undefined;
    for await (const chunk of this.read(uri)) {
      // A complete read performs byte-length and SHA-256 verification without retaining the body.
      void chunk;
    }
    return record;
  }

  public async *read(uri: string, range?: ArtifactByteRange): AsyncIterable<Uint8Array> {
    this.#throwIfAborted();
    if (range !== undefined) assertArtifactByteRange(range);
    const stored = await this.head(uri);
    if (stored === undefined) throw new Error(`Artifact not found: ${uri}`);
    if (range !== undefined && range.endInclusive >= stored.byteSize)
      throw new RangeError('Artifact range exceeds content length');
    const expectedLength =
      range === undefined ? stored.byteSize : range.endInclusive - range.start + 1;
    const response = (await this.#client.send(
      new GetObjectCommand({
        Bucket: this.#bucket,
        Key: this.#keyFromUri(uri),
        Range: range === undefined ? undefined : `bytes=${range.start}-${range.endInclusive}`,
      }),
      this.#signal === undefined ? undefined : { abortSignal: this.#signal },
    )) as GetObjectOutput;
    if (response.Body === undefined || response.ContentLength !== expectedLength) {
      throw new ArtifactIntegrityError(`S3 content-length mismatch for ${uri}`);
    }
    if (
      range !== undefined &&
      response.ContentRange !== `bytes ${range.start}-${range.endInclusive}/${stored.byteSize}`
    ) {
      throw new ArtifactIntegrityError(`S3 content-range mismatch for ${uri}`);
    }
    const hash = createHash('sha256');
    let received = 0;
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      this.#throwIfAborted();
      const bytes = new Uint8Array(chunk);
      received += bytes.byteLength;
      if (range === undefined) hash.update(bytes);
      yield bytes;
    }
    if (received !== expectedLength) throw new ArtifactIntegrityError(`Short S3 read for ${uri}`);
    if (range === undefined && hash.digest('hex') !== stored.sha256)
      throw new ArtifactIntegrityError(`S3 SHA-256 mismatch for ${uri}`);
  }

  #key(logicalKey: string): string {
    return this.#prefix.length === 0 ? logicalKey : `${this.#prefix}/${logicalKey}`;
  }

  #keyFromUri(uri: string): string {
    const url = new URL(uri);
    if (url.protocol !== 's3:' || url.hostname !== this.#bucket)
      throw new TypeError('S3 URI does not belong to this store');
    const key = decodeURIComponent(url.pathname.slice(1));
    if (
      key.length === 0 ||
      key.includes('\\') ||
      key.split('/').some((part) => part.length === 0 || part === '.' || part === '..') ||
      (this.#prefix.length > 0 && !key.startsWith(`${this.#prefix}/`))
    )
      throw new TypeError('S3 URI escapes configured prefix');
    return key;
  }

  #throwIfAborted(): void {
    if (this.#signal?.aborted === true) throw this.#signal.reason;
  }
}

function isPreconditionFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'PreconditionFailed' || ('statusCode' in error && error.statusCode === 412))
  );
}
function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'NotFound' || ('statusCode' in error && error.statusCode === 404))
  );
}
