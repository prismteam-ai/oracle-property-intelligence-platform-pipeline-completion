import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createCheckpointEnvelope } from '../checkpoint-store.js';
import { ImmutableArtifactConflictError } from './internal.js';
import { LocalArtifactStore } from './local-artifact-store.js';
import { LocalCheckpointStore } from './local-checkpoint-store.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oracle-artifacts-'));
  roots.push(root);
  return root;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe('LocalArtifactStore', () => {
  it('persists immutable bytes, exact metadata, integrity, and ranges across instances', async () => {
    const root = await temporaryRoot();
    const bytes = Buffer.from('0123456789', 'utf8');
    const request = {
      logicalKey: 'release/data.csv',
      mediaType: 'text/csv',
      body: bytes,
      expectedSha256: sha256(bytes),
      metadata: { source: 'official', release: 'v1' },
      ifAbsent: true as const,
    };
    const stored = await new LocalArtifactStore({
      rootDirectory: root,
      now: () => '2026-07-17T12:00:00.000Z',
    }).putImmutable(request);
    const reopened = new LocalArtifactStore({ rootDirectory: root, now: () => 'never-used' });
    expect(await reopened.head(stored.uri)).toEqual(stored);
    expect((await collect(reopened.read(stored.uri))).toString()).toBe('0123456789');
    expect(
      (await collect(reopened.read(stored.uri, { start: 2, endInclusive: 5 }))).toString(),
    ).toBe('2345');
    await expect(reopened.putImmutable(request)).rejects.toBeInstanceOf(
      ImmutableArtifactConflictError,
    );
    await expect(
      collect(reopened.read(stored.uri, { start: 9, endInclusive: 10 })),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('rejects hash mismatches, traversal, malformed chunks, and corrupted persisted bytes', async () => {
    const root = await temporaryRoot();
    const store = new LocalArtifactStore({
      rootDirectory: root,
      now: () => '2026-07-17T12:00:00.000Z',
    });
    const bytes = Buffer.from('safe');
    await expect(
      store.putImmutable({
        logicalKey: '../escape',
        mediaType: 'text/plain',
        body: bytes,
        expectedSha256: sha256(bytes),
        metadata: {},
        ifAbsent: true,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      store.putImmutable({
        logicalKey: 'bad/hash',
        mediaType: 'text/plain',
        body: bytes,
        expectedSha256: '0'.repeat(64),
        metadata: {},
        ifAbsent: true,
      }),
    ).rejects.toThrow('SHA-256 mismatch');
    const stored = await store.putImmutable({
      logicalKey: 'good/body',
      mediaType: 'text/plain',
      body: bytes,
      expectedSha256: sha256(bytes),
      metadata: {},
      ifAbsent: true,
    });
    await writeFile(fileURLToPath(stored.uri), 'evil');
    await expect(collect(store.read(stored.uri))).rejects.toThrow('SHA-256 mismatch');
  });

  it('accepts nested children and rejects separator-neutral sibling-prefix URI escapes', async () => {
    const root = await temporaryRoot();
    const store = new LocalArtifactStore({
      rootDirectory: root,
      now: () => '2026-07-17T12:00:00.000Z',
    });
    const bytes = Buffer.from('portable');
    const stored = await store.putImmutable({
      logicalKey: 'nested/deeper/body',
      mediaType: 'text/plain',
      body: bytes,
      expectedSha256: sha256(bytes),
      metadata: {},
      ifAbsent: true,
    });
    expect(await store.head(stored.uri)).toEqual(stored);

    const sibling = `${root}-sibling`;
    roots.push(sibling);
    await (await import('node:fs/promises')).mkdir(sibling, { recursive: true });
    const siblingUri = pathToFileURL(join(sibling, 'body')).href;
    await expect(store.head(siblingUri)).rejects.toThrow('escapes storage root');
  });
});

describe('LocalCheckpointStore', () => {
  it('commits, reloads, and rejects stale optimistic writers', async () => {
    const root = await temporaryRoot();
    const firstStore = new LocalCheckpointStore({ rootDirectory: root });
    const secondStore = new LocalCheckpointStore({ rootDirectory: root });
    const first = createCheckpointEnvelope({
      scope: 'source/run',
      previousRevision: null,
      writtenAt: '2026-07-17T12:00:00.000Z',
      payload: { cursor: 1, nested: { b: 2, a: 1 } },
    });
    expect(await firstStore.commit({ expectedRevision: null, checkpoint: first })).toEqual({
      status: 'committed',
      checkpoint: first,
    });
    expect(await secondStore.load('source/run')).toEqual(first);
    const stale = createCheckpointEnvelope({
      scope: 'source/run',
      previousRevision: null,
      writtenAt: '2026-07-17T12:01:00.000Z',
      payload: { cursor: 2 },
    });
    expect(await secondStore.commit({ expectedRevision: null, checkpoint: stale })).toEqual({
      status: 'conflict',
      current: first,
    });
    const next = createCheckpointEnvelope({
      scope: 'source/run',
      previousRevision: first.revision,
      writtenAt: '2026-07-17T12:02:00.000Z',
      payload: { cursor: 2 },
    });
    expect(
      (await secondStore.commit({ expectedRevision: first.revision, checkpoint: next })).status,
    ).toBe('committed');
  });

  it('detects persisted checkpoint tampering', async () => {
    const root = await temporaryRoot();
    const store = new LocalCheckpointStore({ rootDirectory: root });
    const checkpoint = createCheckpointEnvelope({
      scope: 'tamper',
      previousRevision: null,
      writtenAt: '2026-07-17T12:00:00.000Z',
      payload: { cursor: 1 },
    });
    await store.commit({ expectedRevision: null, checkpoint });
    const files = (await import('node:fs/promises')).readdir(root);
    const path = join(root, (await files)[0] ?? 'missing-checkpoint');
    const document = JSON.parse(await readFile(path, 'utf8'));
    document.payload.cursor = 99;
    await writeFile(path, JSON.stringify(document));
    await expect(store.load('tamper')).rejects.toThrow('payload hash');
  });
});
