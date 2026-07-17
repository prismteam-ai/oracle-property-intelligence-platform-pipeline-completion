import { describe, expect, it } from 'vitest';

import { checkpointPayloadSha256, createCheckpointEnvelope } from './checkpoint-store.js';

describe('checkpoint store boundary', () => {
  it('creates stable content-addressed revisions independent of object key order', () => {
    const first = { cursor: 'next', page: 2 } as const;
    const second = { page: 2, cursor: 'next' } as const;

    expect(checkpointPayloadSha256(first)).toBe(checkpointPayloadSha256(second));
    expect(
      createCheckpointEnvelope({
        scope: 'source:santa-clara-parcels',
        previousRevision: null,
        writtenAt: '2026-07-17T00:00:00.000Z',
        payload: first,
      }),
    ).toEqual(
      createCheckpointEnvelope({
        scope: 'source:santa-clara-parcels',
        previousRevision: null,
        writtenAt: '2026-07-17T00:00:00.000Z',
        payload: second,
      }),
    );
  });

  it('rejects ambiguous non-JSON values and invalid scope metadata', () => {
    expect(() => checkpointPayloadSha256(Number.POSITIVE_INFINITY)).toThrow(/finite/u);
    expect(() =>
      createCheckpointEnvelope({
        scope: ' ',
        previousRevision: null,
        writtenAt: 'not-a-date',
        payload: null,
      }),
    ).toThrow(/scope/u);
  });
});
