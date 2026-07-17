import { evidenceSourceReferenceSchema } from '@oracle/contracts/evidence';
import { entityIdSchema } from '@oracle/contracts/ids';

import type { InquiryCoverage, SourceObservation } from './common.js';

const DIGEST = 'a'.repeat(64);

export const PROPERTY_ID = entityIdSchema.parse('sc:entity:property:test-property');
export const PERMIT_ID = entityIdSchema.parse('sc:entity:permit:test-permit');
export const SECOND_PERMIT_ID = entityIdSchema.parse('sc:entity:permit:second-permit');
export const HYDRO_ID = entityIdSchema.parse('sc:entity:hydro-feature:test-water');
export const PARTY_ID = entityIdSchema.parse('sc:entity:party:test-owner');
export const SECOND_PARTY_ID = entityIdSchema.parse('sc:entity:party:second-owner');
export const INTEREST_ID = entityIdSchema.parse('sc:entity:ownership-interest:test-interest');
export const SECOND_INTEREST_ID = entityIdSchema.parse(
  'sc:entity:ownership-interest:second-interest',
);
export const EVENT_ID = entityIdSchema.parse('sc:entity:ownership-event:test-transfer');
export const SECOND_EVENT_ID = entityIdSchema.parse('sc:entity:ownership-event:second-transfer');

export function sourceObservation(
  kind: string,
  recordKey: string,
  fields: Readonly<Record<string, string | number | boolean | null>> = {},
  visibility: SourceObservation['visibility'] = 'public',
  sourceSlug = 'test-evidence',
): SourceObservation {
  return Object.freeze({
    observationId: `observation-${recordKey}`,
    kind,
    reference: evidenceSourceReferenceSchema.parse({
      sourceId: `sc:source:${sourceSlug}`,
      snapshotId: `sc:snapshot:${sourceSlug}:${DIGEST}`,
      artifactId: `sc:artifact:sha256:${DIGEST}`,
      recordKey,
      fieldPaths: Object.keys(fields).map((field) => `/${field}`),
    }),
    observedAt: '2026-07-17T00:00:00.000Z',
    sourceAsOf: '2026-07-16T00:00:00.000Z',
    visibility,
    fields: Object.freeze(fields),
  });
}

export function completeCoverage(overrides: Partial<InquiryCoverage> = {}): InquiryCoverage {
  return Object.freeze({
    state: 'complete',
    jurisdiction: 'Santa Clara County, CA',
    windowStart: '1990-01-01T00:00:00.000Z',
    windowEnd: '2026-07-17T00:00:00.000Z',
    measuredAt: '2026-07-17T00:00:00.000Z',
    sourceIds: Object.freeze(['sc:source:test-evidence']),
    limitations: Object.freeze([]),
    observations: Object.freeze([
      sourceObservation('coverage', 'coverage-manifest', { state: 'complete' }),
    ]),
    ...overrides,
  });
}
