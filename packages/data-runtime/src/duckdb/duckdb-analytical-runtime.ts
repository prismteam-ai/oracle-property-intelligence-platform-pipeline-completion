import { createHash } from 'node:crypto';

import {
  DuckDBInstance,
  blobValue,
  type DuckDBConnection,
  type DuckDBValue,
} from '@duckdb/node-api';
import { sha256Schema } from '@oracle/contracts/foundation';

import {
  assertAnalyticalQueryBounds,
  type AnalyticalParameter,
  type AnalyticalQuery,
  type AnalyticalResult,
  type AnalyticalRow,
  type AnalyticalRuntime,
  type AnalyticalSession,
  type AnalyticalSnapshot,
} from '../analytical-runtime.js';

export type DuckDBSnapshotBinding = Readonly<{
  manifestBytes: Uint8Array;
  scanBytesByOperation: Readonly<Record<string, number>>;
  initialize?: (connection: DuckDBConnection, snapshot: AnalyticalSnapshot) => Promise<void>;
}>;

export type DuckDBRuntimeOptions = Readonly<{
  loadSnapshot: (
    snapshot: AnalyticalSnapshot,
    signal?: AbortSignal,
  ) => Promise<DuckDBSnapshotBinding>;
  nowMilliseconds: () => number;
  instanceOptions?: Readonly<Record<string, string>>;
}>;

export class DuckDBAnalyticalRuntime implements AnalyticalRuntime {
  readonly #options: DuckDBRuntimeOptions;

  public constructor(options: DuckDBRuntimeOptions) {
    this.#options = options;
  }

  public async open(
    snapshot: AnalyticalSnapshot,
    signal?: AbortSignal,
  ): Promise<AnalyticalSession> {
    assertSnapshot(snapshot);
    throwIfAborted(signal);
    const binding = await this.#options.loadSnapshot(snapshot, signal);
    throwIfAborted(signal);
    const digest = createHash('sha256').update(binding.manifestBytes).digest('hex');
    if (digest !== snapshot.manifestSha256) {
      throw new SnapshotIntegrityError(
        `Manifest SHA-256 mismatch: expected ${snapshot.manifestSha256}, received ${digest}`,
      );
    }
    validateScanMap(binding.scanBytesByOperation);

    const instance = await DuckDBInstance.create(':memory:', {
      threads: '2',
      ...(this.#options.instanceOptions ?? {}),
    });
    let connection: DuckDBConnection | undefined;
    try {
      throwIfAborted(signal);
      connection = await instance.connect();
      await connection.run(
        'CREATE TEMP TABLE oracle_snapshot_binding(release_id VARCHAR, manifest_uri VARCHAR, manifest_sha256 VARCHAR)',
      );
      await connection.run('INSERT INTO oracle_snapshot_binding VALUES ($1, $2, $3)', [
        snapshot.releaseId,
        snapshot.manifestUri,
        snapshot.manifestSha256,
      ]);
      await binding.initialize?.(connection, snapshot);
      throwIfAborted(signal);
      return new DuckDBAnalyticalSession({
        instance,
        connection,
        scanBytesByOperation: binding.scanBytesByOperation,
        nowMilliseconds: this.#options.nowMilliseconds,
      });
    } catch (error) {
      connection?.closeSync();
      instance.closeSync();
      throw error;
    }
  }
}

class DuckDBAnalyticalSession implements AnalyticalSession {
  readonly #instance: DuckDBInstance;
  readonly #connection: DuckDBConnection;
  readonly #scanBytesByOperation: Readonly<Record<string, number>>;
  readonly #nowMilliseconds: () => number;
  #tail: Promise<void> = Promise.resolve();
  #disposing = false;
  #disposed = false;

  public constructor(options: {
    instance: DuckDBInstance;
    connection: DuckDBConnection;
    scanBytesByOperation: Readonly<Record<string, number>>;
    nowMilliseconds: () => number;
  }) {
    this.#instance = options.instance;
    this.#connection = options.connection;
    this.#scanBytesByOperation = options.scanBytesByOperation;
    this.#nowMilliseconds = options.nowMilliseconds;
  }

  public execute<TRow extends AnalyticalRow = AnalyticalRow>(
    query: AnalyticalQuery,
  ): Promise<AnalyticalResult<TRow>> {
    if (this.#disposing || this.#disposed) return Promise.reject(new SessionDisposedError());
    const run = this.#tail.then(() => this.#executeSerialized<TRow>(query));
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed || this.#disposing) return;
    this.#disposing = true;
    await this.#tail;
    this.#connection.closeSync();
    this.#instance.closeSync();
    this.#disposed = true;
  }

  async #executeSerialized<TRow extends AnalyticalRow>(
    query: AnalyticalQuery,
  ): Promise<AnalyticalResult<TRow>> {
    assertAnalyticalQueryBounds(query);
    const scannedBytes = this.#scanBytesByOperation[query.operation];
    if (scannedBytes === undefined) {
      throw new ScanBudgetUnavailableError(query.operation);
    }
    if (scannedBytes > query.maximumScanBytes) {
      throw new ScanBudgetExceededError(query.operation, scannedBytes, query.maximumScanBytes);
    }
    throwIfAborted(query.signal);
    const started = this.#nowMilliseconds();
    let cancellationReason: Error | undefined;
    const onAbort = (): void => {
      cancellationReason = toError(query.signal?.reason, 'Query aborted');
      this.#connection.interrupt();
    };
    query.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      cancellationReason = new QueryTimeoutError(query.operation, query.timeoutMs);
      this.#connection.interrupt();
    }, query.timeoutMs);
    try {
      const statement = query.statement.trim().replace(/;$/, '');
      const boundedStatement = `SELECT * FROM (${statement}) AS oracle_bounded_query LIMIT ${query.maximumRows + 1}`;
      const result = await this.#connection.stream(
        boundedStatement,
        query.parameters.map(toDuckDBValue),
      );
      const rows: TRow[] = [];
      for await (const batch of result.yieldRowObjectJs()) {
        for (const row of batch) {
          if (rows.length <= query.maximumRows) rows.push(Object.freeze(row) as TRow);
        }
      }
      if (cancellationReason !== undefined) throw cancellationReason;
      const truncated = rows.length > query.maximumRows;
      if (truncated) rows.length = query.maximumRows;
      const elapsedMs = this.#nowMilliseconds() - started;
      if (!Number.isFinite(elapsedMs) || elapsedMs < 0)
        throw new TypeError('Injected monotonic clock moved backwards');
      return Object.freeze({
        rows: Object.freeze(rows),
        elapsedMs,
        scannedBytes,
        truncated,
      });
    } catch (error) {
      if (cancellationReason !== undefined) throw cancellationReason;
      throw error;
    } finally {
      clearTimeout(timeout);
      query.signal?.removeEventListener('abort', onAbort);
    }
  }
}

function toDuckDBValue(value: AnalyticalParameter): DuckDBValue {
  return value instanceof Uint8Array ? blobValue(value) : value;
}

function assertSnapshot(snapshot: AnalyticalSnapshot): void {
  if (snapshot.releaseId.trim().length === 0)
    throw new TypeError('Analytical releaseId is required');
  if (snapshot.manifestUri.trim().length === 0)
    throw new TypeError('Analytical manifestUri is required');
  sha256Schema.parse(snapshot.manifestSha256);
}

function validateScanMap(scanBytesByOperation: Readonly<Record<string, number>>): void {
  for (const [operation, bytes] of Object.entries(scanBytesByOperation)) {
    if (operation.trim().length === 0 || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw new TypeError(
        'Snapshot scan-byte estimates must use non-empty operations and non-negative safe integers',
      );
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw toError(signal.reason, 'Operation aborted');
}

function toError(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback, { cause: reason });
}

export class SnapshotIntegrityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SnapshotIntegrityError';
  }
}
export class ScanBudgetUnavailableError extends Error {
  public constructor(operation: string) {
    super(`No immutable scan-byte bound for operation: ${operation}`);
    this.name = 'ScanBudgetUnavailableError';
  }
}
export class ScanBudgetExceededError extends Error {
  public constructor(operation: string, actual: number, maximum: number) {
    super(`Scan budget exceeded for ${operation}: ${actual} > ${maximum}`);
    this.name = 'ScanBudgetExceededError';
  }
}
export class QueryTimeoutError extends Error {
  public constructor(operation: string, timeoutMs: number) {
    super(`Query timed out after ${timeoutMs}ms: ${operation}`);
    this.name = 'QueryTimeoutError';
  }
}
export class SessionDisposedError extends Error {
  public constructor() {
    super('Analytical session is disposed');
    this.name = 'SessionDisposedError';
  }
}
