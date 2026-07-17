import { describe, expect, it } from 'vitest';

import { createHash } from 'node:crypto';

import {
  DeterministicClock,
  InMemoryArtifactStore,
  InMemoryCheckpointStore,
  ScriptedAnalyticalRuntime,
  ScriptedHttpTransport,
} from './fakes.js';

describe('deterministic adapter fakes', () => {
  it('advances a scripted clock and holds its final instant', () => {
    const clock = new DeterministicClock(['2026-07-17T00:00:00.000Z', '2026-07-17T00:00:01.000Z']);
    expect([clock.now(), clock.now(), clock.now()]).toEqual([
      '2026-07-17T00:00:00.000Z',
      '2026-07-17T00:00:01.000Z',
      '2026-07-17T00:00:01.000Z',
    ]);
  });

  it('records pagination requests and propagates abort before transport', async () => {
    const transport = new ScriptedHttpTransport([
      { status: 200, headers: {}, chunks: [new Uint8Array([1])] },
    ]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      transport.send(
        { method: 'GET', url: 'https://data.example/page/1', headers: {} },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport.requests).toEqual([]);
  });

  it('returns an async immutable body and defensively records POST bytes', async () => {
    const configuredChunk = new Uint8Array([1, 2]);
    const requestBody = new Uint8Array([3, 4]);
    const transport = new ScriptedHttpTransport([
      {
        status: 200,
        headers: { etag: 'fixture' },
        chunks: [configuredChunk, configuredChunk],
      },
    ]);
    configuredChunk[0] = 9;

    const response = await transport.send(
      {
        method: 'POST',
        url: 'https://data.example/query',
        headers: { accept: 'application/octet-stream' },
        body: requestBody,
      },
      new AbortController().signal,
    );
    requestBody[0] = 9;
    const firstRead: Uint8Array[] = [];
    const valuesBeforeMutation: number[][] = [];
    for await (const chunk of response.body) {
      valuesBeforeMutation.push([...chunk]);
      firstRead.push(chunk);
      chunk[0] = 8;
    }

    expect(firstRead).toHaveLength(2);
    expect(valuesBeforeMutation).toEqual([
      [1, 2],
      [1, 2],
    ]);
    const recordedRequest = transport.requests.at(0);
    if (recordedRequest?.body === undefined) {
      throw new Error('Expected a recorded POST request body');
    }
    expect([...recordedRequest.body]).toEqual([3, 4]);
    const inspectedBody = recordedRequest.body;
    inspectedBody[0] = 7;
    const reinspectedBody = transport.requests.at(0)?.body;
    if (reinspectedBody === undefined) {
      throw new Error('Expected a defensively copied POST request body');
    }
    expect([...reinspectedBody]).toEqual([3, 4]);
    expect(response).toMatchObject({ status: 200, headers: { etag: 'fixture' } });
    expect(firstRead.map((chunk) => [...chunk])).toEqual([
      [8, 2],
      [8, 2],
    ]);
  });

  it('propagates abort during async body consumption before the next chunk', async () => {
    const controller = new AbortController();
    const transport = new ScriptedHttpTransport([
      {
        status: 200,
        headers: {},
        chunks: [new Uint8Array([1]), new Uint8Array([2])],
      },
    ]);
    const response = await transport.send(
      { method: 'GET', url: 'https://data.example/pages', headers: {} },
      controller.signal,
    );
    const iterator = response.body[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: new Uint8Array([1]) });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('stores immutable bytes, supports ranges, and rejects overwrite', async () => {
    const clock = new DeterministicClock(['2026-07-17T00:00:00.000Z']);
    const store = new InMemoryArtifactStore(clock);
    const bytes = new TextEncoder().encode('PAR1payload');
    const expectedSha256 = createHash('sha256').update(bytes).digest('hex');
    const stored = await store.putImmutable({
      logicalKey: 'raw/parcels/fixture.parquet',
      mediaType: 'application/vnd.apache.parquet',
      body: bytes,
      expectedSha256,
      metadata: { sourceId: 'sc:source:parcels' },
      ifAbsent: true,
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of store.read(stored.uri, { start: 0, endInclusive: 3 })) {
      chunks.push(chunk);
    }
    expect(new TextDecoder().decode(chunks[0])).toBe('PAR1');
    await expect(
      store.putImmutable({
        logicalKey: 'raw/parcels/fixture.parquet',
        mediaType: stored.mediaType,
        body: bytes,
        expectedSha256,
        metadata: {},
        ifAbsent: true,
      }),
    ).rejects.toThrow('already exists');
  });

  it('models checkpoint conflicts and deterministic analytical results', async () => {
    const checkpoints = new InMemoryCheckpointStore();
    const checkpoint = {
      scope: 'source:parcels',
      revision: 'rev-1',
      previousRevision: null,
      payloadSha256: 'a'.repeat(64),
      writtenAt: '2026-07-17T00:00:00.000Z',
      payload: { page: 1 },
    } as const;
    await expect(
      checkpoints.commit({ expectedRevision: 'wrong', checkpoint }),
    ).resolves.toMatchObject({ status: 'conflict' });
    await expect(checkpoints.commit({ expectedRevision: null, checkpoint })).resolves.toMatchObject(
      { status: 'committed' },
    );

    const runtime = new ScriptedAnalyticalRuntime([{ count: 2 }, { count: 1 }]);
    const session = await runtime.open({}, new AbortController().signal);
    await expect(
      session.execute({ operation: 'count', statement: 'select 1', maximumRows: 1 }),
    ).resolves.toMatchObject({ rows: [{ count: 2 }], truncated: true });
    expect(runtime.queries).toEqual([{ operation: 'count', statement: 'select 1' }]);
  });
});
