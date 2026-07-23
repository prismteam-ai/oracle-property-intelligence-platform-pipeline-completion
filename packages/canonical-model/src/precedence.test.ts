import { describe, expect, it } from 'vitest';

import { selectByCanonicalPrecedence } from './precedence.js';

const observedAt = '2026-07-17T00:00:00.000Z';

describe('canonical precedence', () => {
  it('selects deterministically by authority, freshness, confidence, then ID', () => {
    const decision = selectByCanonicalPrecedence([
      {
        observationId: 'obs-b',
        authorityPriority: 10,
        sourceAsOf: '2026-07-16T00:00:00.000Z',
        observedAt,
        confidence: 1,
        value: 'secondary',
      },
      {
        observationId: 'obs-a',
        authorityPriority: 20,
        sourceAsOf: '2026-01-01T00:00:00.000Z',
        observedAt,
        confidence: 0.8,
        value: 'authoritative',
      },
    ]);

    expect(decision.selected.observationId).toBe('obs-a');
    expect(decision.orderedObservationIds).toEqual(['obs-a', 'obs-b']);
    expect(decision.hasConflict).toBe(true);
  });

  it('does not mutate caller order and rejects duplicate identities', () => {
    const candidates = Object.freeze([
      {
        observationId: 'obs-2',
        authorityPriority: 1,
        sourceAsOf: observedAt,
        observedAt,
        confidence: 1,
        value: { city: 'Palo Alto', tags: ['parcel', 'official'] },
      },
      {
        observationId: 'obs-1',
        authorityPriority: 1,
        sourceAsOf: observedAt,
        observedAt,
        confidence: 1,
        value: { tags: ['parcel', 'official'], city: 'Palo Alto' },
      },
    ] as const);

    expect(selectByCanonicalPrecedence(candidates).hasConflict).toBe(false);
    expect(candidates[0].observationId).toBe('obs-2');
    expect(() => selectByCanonicalPrecedence([candidates[0], candidates[0]])).toThrow(/unique/u);
  });
});
