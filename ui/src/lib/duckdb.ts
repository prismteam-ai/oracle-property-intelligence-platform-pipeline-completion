/**
 * Single shared query path for the whole app.
 *
 * UI components never touch duckdb-wasm directly: they call `initDb()` /
 * `query()` from this module. The engine is instantiated exactly once
 * (module-level singleton promise) and every query goes through one
 * connection, serialized to keep result streams from interleaving.
 *
 * Instantiation follows the official duckdb-wasm Vite recipe
 * (https://duckdb.org/docs/current/clients/wasm/instantiation.html):
 * import the wasm modules and workers as URLs, selectBundle(), spawn the
 * worker, AsyncDuckDB.instantiate().
 */
import * as duckdb from '@duckdb/duckdb-wasm';
import duckdb_wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvp_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import duckdb_wasm_eh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import eh_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

export interface QueryResult {
  columns: string[];
  /** Row-major values, already converted to display-safe JS primitives. */
  rows: unknown[][];
}

export type InitPhase =
  | 'idle'
  | 'downloading' // fetching the wasm bundle
  | 'instantiating' // compiling + starting the worker
  | 'connecting'
  | 'ready'
  | 'error';

type PhaseListener = (phase: InitPhase, detail?: string) => void;

const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
  mvp: { mainModule: duckdb_wasm, mainWorker: mvp_worker },
  eh: { mainModule: duckdb_wasm_eh, mainWorker: eh_worker },
};

let initPromise: Promise<duckdb.AsyncDuckDBConnection> | null = null;
let phaseListeners: PhaseListener[] = [];
let currentPhase: InitPhase = 'idle';

function setPhase(phase: InitPhase, detail?: string) {
  currentPhase = phase;
  for (const l of phaseListeners) l(phase, detail);
}

export function getPhase(): InitPhase {
  return currentPhase;
}

export function onPhaseChange(listener: PhaseListener): () => void {
  phaseListeners.push(listener);
  return () => {
    phaseListeners = phaseListeners.filter((l) => l !== listener);
  };
}

async function doInit(): Promise<duckdb.AsyncDuckDBConnection> {
  setPhase('downloading', 'Downloading DuckDB engine (~10 MB, one time)');
  const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
  setPhase('instantiating', 'Starting SQL engine in a Web Worker');
  const worker = new Worker(bundle.mainWorker!);
  const logger = new duckdb.VoidLogger();
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  setPhase('connecting', 'Opening connection');
  const conn = await db.connect();
  setPhase('ready');
  return conn;
}

/** Initialize the engine once; safe to call from anywhere, any number of times. */
export function initDb(): Promise<duckdb.AsyncDuckDBConnection> {
  if (!initPromise) {
    initPromise = doInit().catch((err) => {
      initPromise = null; // allow a retry after a hard failure
      setPhase('error', errorMessage(err));
      throw err;
    });
  }
  return initPromise;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Convert Arrow cell values into plain, render-safe JS values. */
function toDisplayValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') {
    return v <= BigInt(Number.MAX_SAFE_INTEGER) &&
      v >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(v)
      : v.toString();
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    // Arrow structs/lists/decimals -- stringify defensively, never crash a cell.
    try {
      return JSON.stringify(v, (_k, val) =>
        typeof val === 'bigint' ? val.toString() : val,
      );
    } catch {
      return String(v);
    }
  }
  return v;
}

// Serialize queries: one connection, one in-flight statement at a time.
let queryChain: Promise<unknown> = Promise.resolve();

const RETRYABLE = /429|too many requests|failed to fetch|network/i;

/**
 * Run SQL against the shared connection. Retries once on transient HTTP
 * errors (the IPFS gateway rate-limits bursts with 429).
 */
export function query(sql: string): Promise<QueryResult> {
  const run = async (): Promise<QueryResult> => {
    const conn = await initDb();
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const table = await conn.query(sql);
        const columns = table.schema.fields.map((f) => f.name);
        const rows: unknown[][] = [];
        for (const row of table) {
          if (row == null) continue;
          const rec = row as unknown as Record<string, unknown>;
          rows.push(columns.map((c) => toDisplayValue(rec[c])));
        }
        return { columns, rows };
      } catch (err) {
        lastErr = err;
        if (attempt === 0 && RETRYABLE.test(errorMessage(err))) {
          await new Promise((r) => setTimeout(r, 2500));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  };

  const chained = queryChain.then(run, run);
  queryChain = chained.catch(() => undefined); // errors surface to the caller, not the chain
  return chained;
}

/** Escape a user-supplied string for inclusion in a SQL literal. */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
