import { describe, expect, it } from 'vitest';

import { classifyRetry } from './retry.js';

describe('source retry classification', () => {
  it('retries only typed transient failures and preserves retry-after', () => {
    expect(
      classifyRetry(
        {
          code: 'TRANSIENT_SOURCE',
          retryable: true,
          message: 'rate limited',
        },
        1_500,
      ),
    ).toEqual({ kind: 'retry', retryAfterMs: 1_500 });
    expect(classifyRetry({ code: 'SCHEMA_DRIFT', retryable: false, message: 'changed' })).toEqual({
      kind: 'fail',
      code: 'SCHEMA_DRIFT',
    });
  });

  it('does not retry aborts, unknown failures, or malformed retry hints', () => {
    expect(classifyRetry(new DOMException('stopped', 'AbortError'))).toEqual({
      kind: 'aborted',
    });
    expect(classifyRetry(new Error('unknown'))).toEqual({
      kind: 'fail',
      code: 'RECORD_QUALITY',
    });
    expect(
      classifyRetry({ code: 'TRANSIENT_SOURCE', retryable: true, message: 'bad hint' }, -1),
    ).toEqual({ kind: 'fail', code: 'RECORD_QUALITY' });
  });
});
