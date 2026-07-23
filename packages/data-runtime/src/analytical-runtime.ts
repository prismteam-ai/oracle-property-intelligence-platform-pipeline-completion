export type AnalyticalParameter = null | boolean | number | bigint | string | Uint8Array;

export type AnalyticalRow = Readonly<Record<string, unknown>>;

export type AnalyticalSnapshot = Readonly<{
  releaseId: string;
  manifestUri: string;
  manifestSha256: string;
}>;

export type AnalyticalQuery = Readonly<{
  operation: string;
  statement: string;
  parameters: readonly AnalyticalParameter[];
  timeoutMs: number;
  maximumScanBytes: number;
  maximumRows: number;
  signal?: AbortSignal;
}>;

export type AnalyticalResult<TRow extends AnalyticalRow = AnalyticalRow> = Readonly<{
  rows: readonly TRow[];
  elapsedMs: number;
  scannedBytes: number | null;
  truncated: boolean;
}>;

export interface AnalyticalSession extends AsyncDisposable {
  execute<TRow extends AnalyticalRow = AnalyticalRow>(
    query: AnalyticalQuery,
  ): Promise<AnalyticalResult<TRow>>;
}

export interface AnalyticalRuntime {
  open(snapshot: AnalyticalSnapshot, signal?: AbortSignal): Promise<AnalyticalSession>;
}

export function assertAnalyticalQueryBounds(query: AnalyticalQuery): void {
  if (query.operation.trim().length === 0 || query.statement.trim().length === 0) {
    throw new TypeError('Analytical operation and statement must not be empty');
  }
  if (!Number.isSafeInteger(query.timeoutMs) || query.timeoutMs <= 0) {
    throw new RangeError('Analytical timeoutMs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(query.maximumRows) || query.maximumRows <= 0) {
    throw new RangeError('Analytical maximumRows must be a positive safe integer');
  }
  if (!Number.isSafeInteger(query.maximumScanBytes) || query.maximumScanBytes <= 0) {
    throw new RangeError('Analytical maximumScanBytes must be a positive safe integer');
  }
  if (query.signal?.aborted === true) {
    throw query.signal.reason;
  }
}
