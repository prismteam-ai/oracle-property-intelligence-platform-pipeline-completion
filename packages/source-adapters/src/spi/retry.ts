import { oracleErrorSchema, type OracleErrorCode } from '@oracle/contracts/errors';

export type RetryDisposition =
  | Readonly<{ kind: 'retry'; retryAfterMs?: number }>
  | Readonly<{ kind: 'fail'; code: Exclude<OracleErrorCode, 'TRANSIENT_SOURCE'> }>
  | Readonly<{ kind: 'aborted' }>;

function hasName(value: unknown, name: string): boolean {
  return typeof value === 'object' && value !== null && 'name' in value && value.name === name;
}

function validRetryAfter(retryAfterMs: number | undefined): boolean {
  return retryAfterMs === undefined || (Number.isFinite(retryAfterMs) && retryAfterMs >= 0);
}

/** Fail closed: unknown failures are never retried implicitly. */
export function classifyRetry(error: unknown, retryAfterMs?: number): RetryDisposition {
  if (hasName(error, 'AbortError')) {
    return Object.freeze({ kind: 'aborted' });
  }

  const parsed = oracleErrorSchema.safeParse(error);
  if (!parsed.success || !validRetryAfter(retryAfterMs)) {
    return Object.freeze({ kind: 'fail', code: 'RECORD_QUALITY' });
  }

  if (parsed.data.code === 'TRANSIENT_SOURCE') {
    return retryAfterMs === undefined
      ? Object.freeze({ kind: 'retry' })
      : Object.freeze({ kind: 'retry', retryAfterMs });
  }

  return Object.freeze({ kind: 'fail', code: parsed.data.code });
}
