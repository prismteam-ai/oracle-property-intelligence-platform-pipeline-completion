import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  ApiClient,
  ApiEnvelope,
  ApplicationOperation,
  DataRow,
  QueryState,
  TruthState,
} from './types.js';

const FIXTURE_LABEL = 'TEST_ONLY_DETERMINISTIC_FIXTURE';

export class OracleApiError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'OracleApiError';
  }
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsFixtureLabel(value: unknown): boolean {
  if (value === FIXTURE_LABEL) return true;
  if (Array.isArray(value)) return value.some((item) => containsFixtureLabel(item));
  if (!isRecord(value)) return false;
  return Object.values(value).some((item) => containsFixtureLabel(item));
}

function stringField(value: Readonly<Record<string, unknown>>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) {
    throw new OracleApiError('DATA_CORRUPTION', `The API response is missing ${key}.`);
  }
  return field;
}

function parseEnvelope(value: unknown): ApiEnvelope {
  if (!isRecord(value)) {
    throw new OracleApiError('DATA_CORRUPTION', 'The API returned an invalid response envelope.');
  }
  if (containsFixtureLabel(value)) {
    throw new OracleApiError(
      'FIXTURE_REJECTED',
      'A deterministic test fixture was rejected by the production API client.',
    );
  }
  const timing = isRecord(value.timing) ? value.timing : {};
  const limitations = Array.isArray(value.limitations)
    ? value.limitations.filter((item): item is string => typeof item === 'string')
    : [];
  return Object.freeze({
    schemaVersion: stringField(value, 'schemaVersion'),
    releaseId: stringField(value, 'releaseId'),
    runId: stringField(value, 'runId'),
    manifestCid: stringField(value, 'manifestCid'),
    asOf: stringField(value, 'asOf'),
    coverage: value.coverage ?? {},
    limitations: Object.freeze(limitations),
    data: value.data ?? {},
    nextCursor: typeof value.nextCursor === 'string' ? value.nextCursor : null,
    truncated: value.truncated === true,
    timing: Object.freeze({
      elapsedMs: typeof timing.elapsedMs === 'number' ? timing.elapsedMs : 0,
      bytesScanned: typeof timing.bytesScanned === 'number' ? timing.bytesScanned : null,
    }),
  });
}

function parseError(value: unknown, status: number): OracleApiError {
  if (isRecord(value) && isRecord(value.error)) {
    const code = typeof value.error.code === 'string' ? value.error.code : 'INTERNAL_ERROR';
    const message =
      typeof value.error.message === 'string'
        ? value.error.message
        : 'The Oracle API could not complete this request.';
    return new OracleApiError(code, message, value.error.retryable === true);
  }
  return new OracleApiError(
    status === 503 ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR',
    status === 503
      ? 'The verified release adapter is not composed in this environment.'
      : 'The Oracle API could not complete this request.',
    status >= 500,
  );
}

export function createProductionApiClient(baseUrl: string): ApiClient {
  const normalizedBase = baseUrl.replace(/\/$/u, '');
  return Object.freeze({
    async execute(
      operation: ApplicationOperation,
      input: Readonly<Record<string, unknown>>,
      signal?: AbortSignal,
    ): Promise<ApiEnvelope> {
      let response: Response;
      try {
        response = await fetch(`${normalizedBase}/${operation}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        throw new OracleApiError(
          'SERVICE_UNAVAILABLE',
          'The Oracle API is unreachable. Check the hosted runtime and try again.',
          true,
        );
      }
      let payload: unknown;
      try {
        payload = (await response.json()) as unknown;
      } catch {
        throw new OracleApiError('DATA_CORRUPTION', 'The Oracle API returned a non-JSON response.');
      }
      if (!response.ok) throw parseError(payload, response.status);
      return parseEnvelope(payload);
    },
  });
}

export function useApiQuery(
  client: ApiClient,
  operation: ApplicationOperation,
  input: Readonly<Record<string, unknown>>,
  enabled = true,
): QueryState & Readonly<{ retry: () => void }> {
  const inputKey = JSON.stringify(input);
  const stableInput = useMemo(
    () => JSON.parse(inputKey) as Readonly<Record<string, unknown>>,
    [inputKey],
  );
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<QueryState>(
    enabled
      ? { status: 'loading', data: null, error: null }
      : { status: 'idle', data: null, error: null },
  );
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) {
      setState({ status: 'idle', data: null, error: null });
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading', data: null, error: null });
    void client.execute(operation, stableInput, controller.signal).then(
      (data) => setState({ status: 'success', data, error: null }),
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState({
          status: 'error',
          data: null,
          error: error instanceof Error ? error : new Error('Unknown API failure'),
        });
      },
    );
    return () => controller.abort();
  }, [attempt, client, enabled, operation, stableInput]);

  return { ...state, retry };
}

export function rowsFromData(data: unknown): readonly DataRow[] {
  if (Array.isArray(data)) return data.filter(isRecord);
  if (!isRecord(data)) return [];
  const candidates = ['results', 'items', 'properties', 'runs', 'artifacts', 'fields', 'evidence'];
  for (const key of candidates) {
    const value = data[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return Object.keys(data).length === 0 ? [] : [data];
}

export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Not available';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) return value.map((item) => displayValue(item)).join(', ');
  return JSON.stringify(value);
}

export function valueFor(row: DataRow, keys: readonly string[]): unknown {
  for (const key of keys) if (row[key] !== undefined) return row[key];
  return undefined;
}

export function truthStateFrom(value: unknown): TruthState {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.toLowerCase().replace(/[\s-]+/gu, '_');
  if (normalized.includes('direct') || normalized === 'supported') return 'direct';
  if (normalized.includes('derived')) return 'derived';
  if (normalized.includes('proxy') || normalized.includes('candidate')) return 'proxy';
  if (normalized.includes('partial')) return 'partial';
  if (normalized.includes('blocked')) return 'blocked';
  if (normalized.includes('unsupported')) return 'unsupported';
  return 'unknown';
}

export { FIXTURE_LABEL };
