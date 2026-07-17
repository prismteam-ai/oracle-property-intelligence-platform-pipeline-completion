import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  checkpointPayloadSha256,
  createCheckpointEnvelope,
  type CheckpointCommit,
  type CheckpointCommitResult,
  type CheckpointEnvelope,
  type CheckpointStore,
  type CheckpointValue,
} from '../checkpoint-store.js';
import { canonicalJson } from './internal.js';

export class LocalCheckpointStore implements CheckpointStore {
  readonly #root: string;

  public constructor(options: { rootDirectory: string }) {
    this.#root = resolve(options.rootDirectory);
  }

  public async load(scope: string): Promise<CheckpointEnvelope | undefined> {
    assertScope(scope);
    try {
      return parseCheckpoint(await readFile(this.#checkpointPath(scope), 'utf8'), scope);
    } catch (error) {
      if (isCode(error, 'ENOENT')) return undefined;
      throw error;
    }
  }

  public async commit<TPayload extends CheckpointValue>(
    request: CheckpointCommit<TPayload>,
  ): Promise<CheckpointCommitResult<TPayload>> {
    validateCheckpoint(request.checkpoint);
    const scope = request.checkpoint.scope;
    await mkdir(this.#root, { recursive: true });
    const lockPath = `${this.#checkpointPath(scope)}.lock`;
    try {
      await mkdir(lockPath);
    } catch (error) {
      if (isCode(error, 'EEXIST')) return { status: 'conflict', current: await this.load(scope) };
      throw error;
    }
    try {
      const current = await this.load(scope);
      if ((current?.revision ?? null) !== request.expectedRevision) {
        return { status: 'conflict', current };
      }
      if (request.checkpoint.previousRevision !== request.expectedRevision) {
        throw new TypeError('Checkpoint previousRevision must equal expectedRevision');
      }
      const target = this.#checkpointPath(scope);
      const temporary = `${target}.${request.checkpoint.revision}.tmp`;
      await writeFile(temporary, `${canonicalJson(request.checkpoint)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      try {
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
      return { status: 'committed', checkpoint: request.checkpoint };
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  #checkpointPath(scope: string): string {
    const digest = createHash('sha256').update(scope).digest('hex');
    return join(this.#root, `${digest}.json`);
  }
}

export function validateCheckpoint(checkpoint: CheckpointEnvelope): void {
  assertScope(checkpoint.scope);
  if (checkpointPayloadSha256(checkpoint.payload) !== checkpoint.payloadSha256) {
    throw new TypeError('Checkpoint payload hash is not canonical');
  }
  const expected = createCheckpointEnvelope({
    scope: checkpoint.scope,
    previousRevision: checkpoint.previousRevision,
    writtenAt: checkpoint.writtenAt,
    payload: checkpoint.payload,
  });
  if (expected.revision !== checkpoint.revision)
    throw new TypeError('Checkpoint revision is invalid');
}

function parseCheckpoint(raw: string, expectedScope: string): CheckpointEnvelope {
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== 'object')
    throw new TypeError('Invalid checkpoint document');
  const checkpoint = value as Partial<CheckpointEnvelope>;
  if (
    checkpoint.scope !== expectedScope ||
    typeof checkpoint.revision !== 'string' ||
    !(checkpoint.previousRevision === null || typeof checkpoint.previousRevision === 'string') ||
    typeof checkpoint.payloadSha256 !== 'string' ||
    typeof checkpoint.writtenAt !== 'string' ||
    !('payload' in checkpoint)
  )
    throw new TypeError('Invalid checkpoint document');
  validateCheckpoint(checkpoint as CheckpointEnvelope);
  return Object.freeze(checkpoint) as CheckpointEnvelope;
}

function assertScope(scope: string): void {
  if (scope.trim().length === 0) throw new TypeError('Checkpoint scope must not be empty');
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
