import {
  artifactIdSchema,
  runIdSchema,
  snapshotIdSchema,
  sourceIdSchema,
} from '@oracle/contracts/ids';

import type { CanonicalNormalizationContext } from './core.js';

export function testContext(
  overrides: Partial<CanonicalNormalizationContext> = {},
): CanonicalNormalizationContext {
  const sourceId = overrides.sourceId ?? sourceIdSchema.parse('sc:source:test-source');
  const sourceSlug = sourceId.replace('sc:source:', '');
  return {
    sourceId,
    snapshotId:
      overrides.snapshotId ?? snapshotIdSchema.parse(`sc:snapshot:${sourceSlug}:${'1'.repeat(64)}`),
    artifactId:
      overrides.artifactId ?? artifactIdSchema.parse(`sc:artifact:sha256:${'2'.repeat(64)}`),
    runId: overrides.runId ?? runIdSchema.parse(`sc:run:${'3'.repeat(64)}`),
    sourceRecordKey: overrides.sourceRecordKey ?? 'row-1',
    sourceRecordSha256: overrides.sourceRecordSha256 ?? '4'.repeat(64),
    rawPointer: overrides.rawPointer ?? '/rows/0',
    observedAt: overrides.observedAt ?? '2026-07-17T10:00:00.000Z',
    sourceAsOf:
      overrides.sourceAsOf === undefined ? '2026-07-16T00:00:00.000Z' : overrides.sourceAsOf,
    transformName: overrides.transformName ?? 'canonical-test-normalizer',
    transformVersion: overrides.transformVersion ?? '1.0.0',
    authorityRank: overrides.authorityRank ?? 50,
    confidence: overrides.confidence ?? 1,
    visibility: overrides.visibility ?? 'public',
    sequenceStart: overrides.sequenceStart ?? 0,
  };
}
