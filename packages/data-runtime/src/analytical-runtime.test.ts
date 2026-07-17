import { describe, expect, it } from 'vitest';

import { assertAnalyticalQueryBounds } from './analytical-runtime.js';

const boundedQuery = {
  operation: 'property.search.v1',
  statement: 'select property_id from property_search where city = ? order by property_id',
  parameters: ['Palo Alto'],
  timeoutMs: 2_000,
  maximumScanBytes: 1_000_000,
  maximumRows: 100,
} as const;

describe('analytical runtime boundary', () => {
  it('accepts a bounded deterministic operation', () => {
    expect(() => assertAnalyticalQueryBounds(boundedQuery)).not.toThrow();
  });

  it('rejects unbounded, empty, and already-aborted work', () => {
    expect(() => assertAnalyticalQueryBounds({ ...boundedQuery, maximumRows: 0 })).toThrow(
      /maximumRows/u,
    );
    expect(() => assertAnalyticalQueryBounds({ ...boundedQuery, maximumScanBytes: 0 })).toThrow(
      /maximumScanBytes/u,
    );
    expect(() => assertAnalyticalQueryBounds({ ...boundedQuery, statement: ' ' })).toThrow(
      /must not be empty/u,
    );

    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    expect(() =>
      assertAnalyticalQueryBounds({ ...boundedQuery, signal: controller.signal }),
    ).toThrow(/cancelled/u);
  });
});
