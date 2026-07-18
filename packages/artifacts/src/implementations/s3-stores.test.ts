import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it } from 'vitest';

import { createCheckpointEnvelope } from '../checkpoint-store.js';
import { ImmutableArtifactConflictError } from './internal.js';
import { S3ArtifactStore } from './s3-artifact-store.js';
import { S3CheckpointStore } from './s3-checkpoint-store.js';

interface ObjectRecord {
  body: Buffer;
  contentType: string | undefined;
  metadata: Record<string, string> | undefined;
  etag: string;
}

class FakeS3 {
  readonly objects = new Map<string, ObjectRecord>();
  failNextPut = false;

  async send(command: unknown): Promise<unknown> {
    if (command instanceof PutObjectCommand) {
      const input = command.input;
      const id = `${input.Bucket}/${input.Key}`;
      if (
        this.failNextPut ||
        (input.IfNoneMatch === '*' && this.objects.has(id)) ||
        (input.IfMatch !== undefined && this.objects.get(id)?.etag !== input.IfMatch)
      ) {
        this.failNextPut = false;
        const error = new Error('precondition');
        error.name = 'PreconditionFailed';
        throw error;
      }
      const body = await bodyBuffer(input.Body);
      if (input.ContentLength !== body.byteLength)
        throw new Error('fake observed content-length mismatch');
      const etag = `"${createHash('md5').update(body).digest('hex')}"`;
      this.objects.set(id, {
        body,
        contentType: input.ContentType,
        metadata: input.Metadata,
        etag,
      });
      return { ETag: etag };
    }
    if (command instanceof HeadObjectCommand) {
      const input = command.input;
      const item = this.objects.get(`${input.Bucket}/${input.Key}`);
      if (item === undefined) {
        const error = new Error('missing');
        error.name = 'NotFound';
        throw error;
      }
      return {
        ContentLength: item.body.byteLength,
        ContentType: item.contentType,
        Metadata: item.metadata,
        ETag: item.etag,
      };
    }
    if (command instanceof GetObjectCommand) {
      const input = command.input;
      const item = this.objects.get(`${input.Bucket}/${input.Key}`);
      if (item === undefined) {
        const error = new Error('missing');
        error.name = 'NoSuchKey';
        throw error;
      }
      const match = /^bytes=(\d+)-(\d+)$/.exec(input.Range ?? '');
      const start = match === null ? 0 : Number(match[1]);
      const end = match === null ? item.body.length - 1 : Number(match[2]);
      const body = item.body.subarray(start, end + 1);
      return {
        Body: stream(body),
        ContentLength: body.byteLength,
        ContentRange: match === null ? undefined : `bytes ${start}-${end}/${item.body.length}`,
        ETag: item.etag,
      };
    }
    throw new Error('unexpected command');
  }
}

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);
async function spool(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oracle-s3-'));
  roots.push(root);
  return root;
}
function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
async function* stream(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield await Promise.resolve(bytes);
}
async function bodyBuffer(body: unknown): Promise<Buffer> {
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe('S3ArtifactStore with injected fake', () => {
  it('uses conditional immutable writes and validates exact full/range reads and metadata', async () => {
    const fake = new FakeS3();
    const bytes = Buffer.from('abcdefghij');
    const store = new S3ArtifactStore({
      client: fake as unknown as S3Client,
      bucket: 'bucket',
      prefix: 'artifacts',
      spoolDirectory: await spool(),
      now: () => '2026-07-17T12:00:00.000Z',
    });
    const request = {
      logicalKey: 'release/data.csv',
      mediaType: 'text/csv',
      body: stream(bytes),
      expectedSha256: sha256(bytes),
      metadata: { release: 'one' },
      ifAbsent: true as const,
    };
    const stored = await store.putImmutable(request);
    expect(await store.head(stored.uri)).toEqual(stored);
    expect(await store.headByLogicalKey(request.logicalKey)).toEqual(stored);
    expect((await collect(store.read(stored.uri, { start: 3, endInclusive: 6 }))).toString()).toBe(
      'defg',
    );
    expect((await collect(store.read(stored.uri))).toString()).toBe('abcdefghij');
    await expect(store.putImmutable({ ...request, body: stream(bytes) })).rejects.toBeInstanceOf(
      ImmutableArtifactConflictError,
    );
    const persisted = fake.objects.get('bucket/artifacts/release/data.csv');
    if (persisted === undefined) throw new Error('fake object was not persisted');
    persisted.body = Buffer.from('abcdefghix');
    await expect(store.headByLogicalKey(request.logicalKey)).rejects.toThrow('SHA-256 mismatch');
    await expect(collect(store.read(stored.uri))).rejects.toThrow('SHA-256 mismatch');
  });

  it('propagates abort and rejects corrupt mocked S3 responses', async () => {
    const fake = new FakeS3();
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    const store = new S3ArtifactStore({
      client: fake as unknown as S3Client,
      bucket: 'bucket',
      spoolDirectory: await spool(),
      now: () => '2026-07-17T12:00:00.000Z',
      signal: controller.signal,
    });
    await expect(store.head('s3://bucket/missing')).rejects.toThrow('stop');
  });
});

describe('S3CheckpointStore with injected fake', () => {
  it('commits canonically and returns current state on conditional conflict', async () => {
    const fake = new FakeS3();
    const store = new S3CheckpointStore({ client: fake as unknown as S3Client, bucket: 'bucket' });
    const first = createCheckpointEnvelope({
      scope: 'source',
      previousRevision: null,
      writtenAt: '2026-07-17T12:00:00.000Z',
      payload: { z: 2, a: 1 },
    });
    expect((await store.commit({ expectedRevision: null, checkpoint: first })).status).toBe(
      'committed',
    );
    expect(await store.load('source')).toEqual(first);
    const next = createCheckpointEnvelope({
      scope: 'source',
      previousRevision: first.revision,
      writtenAt: '2026-07-17T12:01:00.000Z',
      payload: { cursor: 2 },
    });
    fake.failNextPut = true;
    expect(await store.commit({ expectedRevision: first.revision, checkpoint: next })).toEqual({
      status: 'conflict',
      current: first,
    });
  });
});
