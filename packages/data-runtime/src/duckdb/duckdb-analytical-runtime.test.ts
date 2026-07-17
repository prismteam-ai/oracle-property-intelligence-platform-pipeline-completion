import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { AnalyticalQuery, AnalyticalSnapshot } from '../analytical-runtime.js';
import {
  DuckDBAnalyticalRuntime,
  QueryTimeoutError,
  ScanBudgetExceededError,
  ScanBudgetUnavailableError,
  SessionDisposedError,
  SnapshotIntegrityError,
} from './duckdb-analytical-runtime.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'oracle-duckdb-'));
  roots.push(root);
  const csvPath = join(root, 'fixture.csv');
  const jsonPath = join(root, 'fixture.json');
  const parquetPath = join(root, 'fixture.parquet');
  await writeFile(csvPath, 'id,name\n1,alpha\n2,beta\n', 'utf8');
  await writeFile(jsonPath, '{"id":3,"name":"gamma"}\n', 'utf8');
  const manifestBytes = Buffer.from(
    '{"releaseId":"release-1","fixtures":["csv","json","parquet"]}\n',
  );
  const snapshot: AnalyticalSnapshot = {
    releaseId: 'release-1',
    manifestUri: pathToFileURL(join(root, 'manifest.json')).href,
    manifestSha256: sha256(manifestBytes),
  };
  let clock = 100;
  const runtime = new DuckDBAnalyticalRuntime({
    nowMilliseconds: () => clock++,
    loadSnapshot: () =>
      Promise.resolve({
        manifestBytes,
        scanBytesByOperation: {
          csv: 24,
          json: 24,
          parquet: 1024,
          parameters: 1,
          bounded: 1,
          concurrent: 1,
          error: 1,
          timeout: 1,
          abort: 1,
          binding: manifestBytes.byteLength,
        },
        initialize: async (connection) => {
          await connection.run('CREATE TABLE generated_fixture AS SELECT * FROM range(1, 4) t(id)');
          await connection.run(
            `COPY generated_fixture TO '${parquetPath.replaceAll('\\', '/')}' (FORMAT PARQUET, COMPRESSION UNCOMPRESSED)`,
          );
          await connection.run(
            `CREATE VIEW csv_fixture AS SELECT * FROM read_csv('${sqlPath(csvPath)}', header = true)`,
          );
          await connection.run(
            `CREATE VIEW json_fixture AS SELECT * FROM read_json('${sqlPath(jsonPath)}')`,
          );
          await connection.run(
            `CREATE VIEW parquet_fixture AS SELECT * FROM read_parquet('${sqlPath(parquetPath)}')`,
          );
        },
      }),
  });
  return { runtime, snapshot, manifestBytes };
}

function sqlPath(path: string): string {
  return path.replaceAll('\\', '/').replaceAll("'", "''");
}

function query(overrides: Partial<AnalyticalQuery> = {}): AnalyticalQuery {
  return {
    operation: 'parameters',
    statement: 'SELECT $1::INTEGER AS value',
    parameters: [42],
    timeoutMs: 5_000,
    maximumScanBytes: 1024,
    maximumRows: 10,
    ...overrides,
  };
}

describe('DuckDBAnalyticalRuntime', () => {
  it('opens a verified immutable snapshot and queries real CSV, JSON, and generated Parquet', async () => {
    const { runtime, snapshot } = await harness();
    const session = await runtime.open(snapshot);
    const csv = await session.execute(
      query({
        operation: 'csv',
        statement: 'SELECT id, name FROM csv_fixture ORDER BY id',
        parameters: [],
      }),
    );
    expect(csv).toMatchObject({
      rows: [
        { id: 1n, name: 'alpha' },
        { id: 2n, name: 'beta' },
      ],
      scannedBytes: 24,
      truncated: false,
    });
    expect(
      (
        await session.execute(
          query({
            operation: 'json',
            statement: 'SELECT id, name FROM json_fixture',
            parameters: [],
          }),
        )
      ).rows,
    ).toEqual([{ id: 3n, name: 'gamma' }]);
    expect(
      (
        await session.execute(
          query({
            operation: 'parquet',
            statement: 'SELECT sum(id) AS total FROM parquet_fixture',
            parameters: [],
          }),
        )
      ).rows,
    ).toEqual([{ total: 6n }]);
    const binding = await session.execute(
      query({
        operation: 'binding',
        statement: 'SELECT release_id, manifest_sha256 FROM oracle_snapshot_binding',
        parameters: [],
      }),
    );
    expect(binding.rows).toEqual([
      { release_id: snapshot.releaseId, manifest_sha256: snapshot.manifestSha256 },
    ]);
    await session[Symbol.asyncDispose]();
  });

  it('binds positional values including blobs and deterministically truncates rows', async () => {
    const { runtime, snapshot } = await harness();
    const session = await runtime.open(snapshot);
    const parameterized = await session.execute(
      query({
        statement: 'SELECT $1::VARCHAR AS text, octet_length($2::BLOB) AS bytes',
        parameters: ['safe', new Uint8Array([1, 2, 3])],
      }),
    );
    expect(parameterized.rows).toEqual([{ text: 'safe', bytes: 3n }]);
    const bounded = await session.execute(
      query({
        operation: 'bounded',
        statement: 'SELECT * FROM range(10) t(value)',
        parameters: [],
        maximumRows: 3,
      }),
    );
    expect(bounded.rows).toEqual([{ value: 0n }, { value: 1n }, { value: 2n }]);
    expect(bounded.truncated).toBe(true);
    expect(bounded.elapsedMs).toBe(1);
    await session[Symbol.asyncDispose]();
  });

  it('fails closed for snapshot integrity and missing/exceeded immutable scan bounds', async () => {
    const { runtime, snapshot } = await harness();
    await expect(
      runtime.open({ ...snapshot, manifestSha256: '0'.repeat(64) }),
    ).rejects.toBeInstanceOf(SnapshotIntegrityError);
    const session = await runtime.open(snapshot);
    await expect(session.execute(query({ operation: 'unknown' }))).rejects.toBeInstanceOf(
      ScanBudgetUnavailableError,
    );
    await expect(
      session.execute(query({ maximumScanBytes: 1, operation: 'csv' })),
    ).rejects.toBeInstanceOf(ScanBudgetExceededError);
    await session[Symbol.asyncDispose]();
  });

  it('propagates SQL errors, serializes concurrent calls, and rejects use after disposal', async () => {
    const { runtime, snapshot } = await harness();
    const session = await runtime.open(snapshot);
    await expect(
      session.execute(
        query({ operation: 'error', statement: 'SELECT * FROM missing_relation', parameters: [] }),
      ),
    ).rejects.toThrow();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        session.execute(
          query({
            operation: 'concurrent',
            statement: 'SELECT $1::INTEGER AS value',
            parameters: [index],
          }),
        ),
      ),
    );
    expect(results.map((result) => result.rows[0]?.value)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    await session[Symbol.asyncDispose]();
    await expect(session.execute(query())).rejects.toBeInstanceOf(SessionDisposedError);
  });

  it('interrupts native DuckDB on timeout and abort', async () => {
    const { runtime, snapshot } = await harness();
    const session = await runtime.open(snapshot);
    await expect(
      session.execute(
        query({
          operation: 'timeout',
          statement: 'SELECT sum(i) FROM range(1000000000000) t(i)',
          parameters: [],
          timeoutMs: 5,
        }),
      ),
    ).rejects.toBeInstanceOf(QueryTimeoutError);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('operator aborted')), 5);
    await expect(
      session.execute(
        query({
          operation: 'abort',
          statement: 'SELECT sum(i) FROM range(1000000000000) t(i)',
          parameters: [],
          timeoutMs: 5_000,
          signal: controller.signal,
        }),
      ),
    ).rejects.toThrow('operator aborted');
    await session[Symbol.asyncDispose]();
  });

  it('propagates an already-aborted open signal without allocating a session', async () => {
    const { runtime, snapshot } = await harness();
    const controller = new AbortController();
    controller.abort(new Error('cancel open'));
    await expect(runtime.open(snapshot, controller.signal)).rejects.toThrow('cancel open');
  });
});
