import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { finished } from 'node:stream/promises';

import {
  assertArtifactByteRange,
  assertSha256,
  type ArtifactByteRange,
  type ArtifactStore,
  type ImmutableArtifactWrite,
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

type LocalRecord = StoredArtifact & Readonly<{ formatVersion: 1 }>;

export class LocalArtifactStore implements ArtifactStore {
  readonly #root: string;
  readonly #now: () => string;

  public constructor(options: { rootDirectory: string; now: () => string }) {
    this.#root = resolve(options.rootDirectory);
    this.#now = options.now;
  }

  public async putImmutable(request: ImmutableArtifactWrite): Promise<StoredArtifact> {
    assertLogicalKey(request.logicalKey);
    assertSha256(request.expectedSha256);
    if (request.mediaType.trim().length === 0)
      throw new TypeError('Artifact mediaType is required');

    const target = this.#directoryFor(request.logicalKey);
    await mkdir(dirname(target), { recursive: true });
    const temporary = await mkdtemp(join(dirname(target), '.oracle-artifact-'));
    const bodyPath = join(temporary, 'body');
    const output = createWriteStream(bodyPath, { flags: 'wx' });
    try {
      const measured = await consumeBody(request.body, async (chunk) => {
        if (!output.write(chunk))
          await new Promise<void>((resolveDrain) => output.once('drain', resolveDrain));
      });
      output.end();
      await finished(output);
      if (measured.sha256 !== request.expectedSha256) {
        throw new ArtifactIntegrityError(
          `Artifact SHA-256 mismatch: expected ${request.expectedSha256}, received ${measured.sha256}`,
        );
      }
      const stored: LocalRecord = Object.freeze({
        formatVersion: 1,
        logicalKey: request.logicalKey,
        uri: pathToFileURL(join(target, 'body')).href,
        mediaType: request.mediaType,
        byteSize: measured.byteSize,
        sha256: measured.sha256,
        storedAt: this.#now(),
        metadata: cloneMetadata(request.metadata),
      });
      await writeFile(join(temporary, 'record.json'), `${canonicalJson(stored)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      try {
        await rename(temporary, target);
      } catch (error) {
        if (await this.#exists(target))
          throw new ImmutableArtifactConflictError(request.logicalKey);
        throw error;
      }
      return stored;
    } finally {
      if (!output.closed) output.destroy();
      await rm(temporary, { recursive: true, force: true });
    }
  }

  public async head(uri: string): Promise<StoredArtifact | undefined> {
    const bodyPath = this.#pathFromUri(uri);
    const recordPath = join(dirname(bodyPath), 'record.json');
    let raw: string;
    try {
      raw = await readFile(recordPath, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    const record = parseLocalRecord(raw);
    if (record.uri !== uri)
      throw new ArtifactIntegrityError(`Artifact URI metadata mismatch for ${uri}`);
    const bodyStat = await stat(bodyPath);
    if (!bodyStat.isFile() || bodyStat.size !== record.byteSize) {
      throw new ArtifactIntegrityError(`Artifact content-length mismatch for ${uri}`);
    }
    return record;
  }

  public async *read(uri: string, range?: ArtifactByteRange): AsyncIterable<Uint8Array> {
    if (range !== undefined) assertArtifactByteRange(range);
    const record = await this.head(uri);
    if (record === undefined) throw new Error(`Artifact not found: ${uri}`);
    if (range !== undefined && range.endInclusive >= record.byteSize) {
      throw new RangeError('Artifact range exceeds content length');
    }
    const hash = createHash('sha256');
    let received = 0;
    const expectedLength =
      range === undefined ? record.byteSize : range.endInclusive - range.start + 1;
    const stream = createReadStream(
      this.#pathFromUri(uri),
      range === undefined ? undefined : { start: range.start, end: range.endInclusive },
    );
    for await (const chunk of stream) {
      const bytes = new Uint8Array(chunk);
      received += bytes.byteLength;
      if (range === undefined) hash.update(bytes);
      yield bytes;
    }
    if (received !== expectedLength)
      throw new ArtifactIntegrityError(`Short artifact read for ${uri}`);
    if (range === undefined && hash.digest('hex') !== record.sha256) {
      throw new ArtifactIntegrityError(`Artifact SHA-256 mismatch while reading ${uri}`);
    }
  }

  #directoryFor(logicalKey: string): string {
    const target = resolve(this.#root, ...logicalKey.split('/'));
    if (!isContainedPath(this.#root, target)) {
      throw new TypeError('Artifact logicalKey escapes storage root');
    }
    return target;
  }

  #pathFromUri(uri: string): string {
    const url = new URL(uri);
    if (url.protocol !== 'file:') throw new TypeError('Local artifact URI must use file:');
    const path = resolve(fileURLToPath(url));
    if (!isContainedPath(this.#root, path))
      throw new TypeError('Artifact URI escapes storage root');
    return path;
  }

  async #exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation.length > 0 &&
    relation !== '..' &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function parseLocalRecord(raw: string): LocalRecord {
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== 'object')
    throw new ArtifactIntegrityError('Invalid artifact record');
  const record = value as Record<string, unknown>;
  if (
    record.formatVersion !== 1 ||
    typeof record.logicalKey !== 'string' ||
    typeof record.uri !== 'string' ||
    typeof record.mediaType !== 'string' ||
    !Number.isSafeInteger(record.byteSize) ||
    typeof record.sha256 !== 'string' ||
    typeof record.storedAt !== 'string' ||
    record.metadata === null ||
    typeof record.metadata !== 'object'
  ) {
    throw new ArtifactIntegrityError('Invalid artifact record');
  }
  assertSha256(record.sha256);
  return Object.freeze({
    ...record,
    metadata: cloneMetadata(record.metadata as Record<string, string>),
  }) as LocalRecord;
}
