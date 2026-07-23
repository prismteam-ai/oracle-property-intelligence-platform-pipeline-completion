import { createHash } from 'node:crypto';

import {
  GetObjectCommand,
  PutObjectCommand,
  type GetObjectOutput,
  type S3Client,
} from '@aws-sdk/client-s3';

import type {
  CheckpointCommit,
  CheckpointCommitResult,
  CheckpointEnvelope,
  CheckpointStore,
  CheckpointValue,
} from '../checkpoint-store.js';
import { canonicalJson } from './internal.js';
import { validateCheckpoint } from './local-checkpoint-store.js';

export class S3CheckpointStore implements CheckpointStore {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #signal: AbortSignal | undefined;

  public constructor(options: {
    client: S3Client;
    bucket: string;
    prefix?: string;
    signal?: AbortSignal;
  }) {
    if (options.bucket.trim().length === 0) throw new TypeError('S3 bucket is required');
    this.#client = options.client;
    this.#bucket = options.bucket;
    this.#prefix = options.prefix?.replace(/^\/+|\/+$/g, '') ?? 'checkpoints';
    this.#signal = options.signal;
  }

  public async load(scope: string): Promise<CheckpointEnvelope | undefined> {
    return (await this.#loadVersion(scope)).checkpoint;
  }

  public async commit<TPayload extends CheckpointValue>(
    request: CheckpointCommit<TPayload>,
  ): Promise<CheckpointCommitResult<TPayload>> {
    this.#throwIfAborted();
    validateCheckpoint(request.checkpoint);
    if (request.checkpoint.previousRevision !== request.expectedRevision) {
      throw new TypeError('Checkpoint previousRevision must equal expectedRevision');
    }
    const current = await this.#loadVersion(request.checkpoint.scope);
    if ((current.checkpoint?.revision ?? null) !== request.expectedRevision) {
      return { status: 'conflict', current: current.checkpoint };
    }
    const body = `${canonicalJson(request.checkpoint)}\n`;
    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: this.#key(request.checkpoint.scope),
          Body: body,
          ContentLength: Buffer.byteLength(body),
          ContentType: 'application/json',
          IfMatch: current.etag,
          IfNoneMatch: current.etag === undefined ? '*' : undefined,
          Metadata: { 'oracle-checkpoint-revision': request.checkpoint.revision },
        }),
        this.#signal === undefined ? undefined : { abortSignal: this.#signal },
      );
      return { status: 'committed', checkpoint: request.checkpoint };
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error;
      return {
        status: 'conflict',
        current: (await this.#loadVersion(request.checkpoint.scope)).checkpoint,
      };
    }
  }

  async #loadVersion(scope: string): Promise<{ checkpoint?: CheckpointEnvelope; etag?: string }> {
    this.#throwIfAborted();
    if (scope.trim().length === 0) throw new TypeError('Checkpoint scope must not be empty');
    let response: GetObjectOutput;
    try {
      response = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: this.#key(scope) }),
        this.#signal === undefined ? undefined : { abortSignal: this.#signal },
      );
    } catch (error) {
      if (isNotFound(error)) return {};
      throw error;
    }
    if (response.Body === undefined || response.ETag === undefined)
      throw new TypeError('Incomplete S3 checkpoint response');
    let raw = '';
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      raw += Buffer.from(chunk).toString('utf8');
    }
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object')
      throw new TypeError('Invalid S3 checkpoint document');
    const checkpoint = value as CheckpointEnvelope;
    if (checkpoint.scope !== scope) throw new TypeError('S3 checkpoint scope mismatch');
    validateCheckpoint(checkpoint);
    return { checkpoint: Object.freeze(checkpoint), etag: response.ETag };
  }

  #key(scope: string): string {
    return `${this.#prefix}/${createHash('sha256').update(scope).digest('hex')}.json`;
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
    (error.name === 'NoSuchKey' ||
      error.name === 'NotFound' ||
      ('statusCode' in error && error.statusCode === 404))
  );
}
