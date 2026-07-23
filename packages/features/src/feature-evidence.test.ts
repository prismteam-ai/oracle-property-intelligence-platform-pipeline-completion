import { describe, expect, it } from 'vitest';

import { createFeatureEvidence } from './feature-evidence.js';

const digest = 'a'.repeat(64);
const secondDigest = 'b'.repeat(64);

const evidence = {
  evidenceId: `sc:evidence:${digest}`,
  entityId: 'sc:entity:property:123-45-678',
  feature: 'roof_age',
  supportState: 'supported',
  confidence: 0.95,
  value: { ageYears: 18 },
  sourceReferences: [
    {
      sourceId: 'sc:source:san-jose-permits',
      snapshotId: `sc:snapshot:san-jose-permits:${digest}`,
      artifactId: `sc:artifact:sha256:${digest}`,
      recordKey: 'permit-42',
      fieldPaths: ['completed_at', 'description'],
    },
  ],
  algorithm: {
    name: 'roof-age-from-finaled-permit',
    version: '1.0.0',
    parameters: { minimumAgeYears: 15 },
  },
  asOf: '2026-07-17T00:00:00.000Z',
  visibility: 'public',
  limitations: [],
} as const;

describe('feature evidence primitive', () => {
  it('validates and freezes source-backed feature evidence', () => {
    const created = createFeatureEvidence(evidence);

    expect(created).toMatchObject({ feature: 'roof_age', supportState: 'supported' });
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.sourceReferences)).toBe(true);
    expect(Object.isFrozen(created.sourceReferences[0]?.fieldPaths)).toBe(true);
    expect(Object.isFrozen(created.algorithm.parameters)).toBe(true);
  });

  it('rejects unsupported certainty and duplicate source identity', () => {
    expect(() =>
      createFeatureEvidence({ ...evidence, supportState: 'unsupported', limitations: [] }),
    ).toThrow(/limitation/u);
    expect(() =>
      createFeatureEvidence({
        ...evidence,
        evidenceId: `sc:evidence:${secondDigest}`,
        sourceReferences: [evidence.sourceReferences[0], evidence.sourceReferences[0]],
      }),
    ).toThrow(/unique/u);
  });
});
