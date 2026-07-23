import { snapshotIdSchema, sourceIdSchema } from '@oracle/contracts/ids';
import type { RealCountyReleaseInput } from '@oracle/data-runtime/serving/real-county-release';
import { describe, expect, it } from 'vitest';

import {
  capabilityStates,
  createDefaultPipelineProcessors,
  schemaSetSha256,
  sourceSnapshotGates,
} from './default-processors.js';
import type { SourceExecutionManifest } from './types.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function manifest(
  suffix: string,
  terminalState: SourceExecutionManifest['terminalState'],
  capability = 'transit_511_fallback',
  schemaHashes: readonly string[] = [HASH_A],
  limitations: readonly string[] = terminalState === 'complete'
    ? Object.freeze([])
    : Object.freeze(['test limitation']),
): SourceExecutionManifest {
  const sourceId = sourceIdSchema.parse(`sc:source:${suffix}`);
  const snapshotId = snapshotIdSchema.parse(`sc:snapshot:${suffix}:${HASH_A}`);
  return Object.freeze({
    sourceId,
    snapshotId,
    snapshotIdentity: Object.freeze({
      intentId: snapshotId,
      observedContentId: snapshotId,
      method: 'configured_intent_plus_observed_content_v1' as const,
    }),
    scope: 'test scope',
    capability,
    executionMode: 'execute' as const,
    supportState: terminalState === 'blocked' ? ('blocked' as const) : ('available' as const),
    requiredForCountyCompletion: true,
    terminalState,
    sourceHash: HASH_A,
    sourceAsOf: '2026-07-17T00:00:00.000Z',
    license: Object.freeze({
      redistribution: 'approved' as const,
      containsPersonalData: false,
      defaultVisibility: 'restricted' as const,
    }),
    schemaHashes: Object.freeze([...schemaHashes]),
    checkpointRevision: null,
    coverage: Object.freeze({
      expectedRecords: 1,
      observedRecords: terminalState === 'complete' ? 1 : 0,
      acceptedRecords: terminalState === 'complete' ? 1 : 0,
      quarantinedRecords: 0,
      denominatorMethod: 'configured' as const,
      ratio: terminalState === 'complete' ? 1 : 0,
    }),
    timings: Object.freeze([]),
    artifacts: Object.freeze([]),
    limitations: Object.freeze([...limitations]),
    errorCodes: Object.freeze([]),
    summary: null,
  });
}

describe('portable real-county mart input', () => {
  it('marks a split 511 outcome partial and an absent 511 configuration explicitly not configured', () => {
    const split = capabilityStates([
      manifest('511-vta', 'complete'),
      manifest('511-caltrain', 'failed'),
    ]).find(({ capability }) => capability === 'transit_511_fallback');
    expect(split).toMatchObject({ state: 'partial' });

    const absent = capabilityStates([]).find(
      ({ capability }) => capability === 'transit_511_fallback',
    );
    expect(absent).toMatchObject({
      state: 'not_configured',
      sourceIds: [],
      limitations: [
        'No 511 fallback feed was configured; direct operator GTFS remains authoritative.',
      ],
    });
  });

  it('binds the complete sorted schema-hash set and preserves a single schema hash', () => {
    expect(schemaSetSha256(manifest('single', 'complete', 'vta_gtfs', [HASH_A]))).toBe(HASH_A);
    const first = schemaSetSha256(manifest('multi', 'complete', 'vta_gtfs', [HASH_A, HASH_B]));
    const reordered = schemaSetSha256(
      manifest('multi', 'complete', 'vta_gtfs', [HASH_B, HASH_A, HASH_A]),
    );
    expect(first).toBe(reordered);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(first).not.toBe(HASH_A);
    expect(first).not.toBe(HASH_B);
  });

  it('deduplicates capability and snapshot limitations and propagates personal-data gates', () => {
    const input = Object.freeze({
      ...manifest(
        'osm',
        'blocked',
        'osm_pedestrian_graph',
        [HASH_A],
        ['duplicate limitation', 'duplicate limitation'],
      ),
      license: Object.freeze({
        redistribution: 'approved' as const,
        containsPersonalData: true,
        defaultVisibility: 'restricted' as const,
      }),
    });
    const capability = capabilityStates([input]).find(
      ({ capability: name }) => name === 'osm_pedestrian_graph',
    );
    expect(capability?.limitations).toEqual(['duplicate limitation']);
    const snapshot = sourceSnapshotGates([input])[0];
    expect(snapshot?.limitations).toEqual(['duplicate limitation']);
    expect(snapshot?.containsOwnerData).toBe(true);
  });

  it('cannot turn absent graph, raster, or service topology into supported feature values', async () => {
    const processors = createDefaultPipelineProcessors();
    const output = (await processors.buildMarts(
      {
        reconciled: {
          canonical: {
            entities: [
              {
                entity: {
                  id: 'sc:property:test',
                  entityKind: 'property',
                  apn: 'TEST-APN',
                  jurisdiction: 'Santa Clara, CA',
                  lineage: [
                    {
                      sourceRecord: { sourceId: 'sc:source:parcels' },
                    },
                  ],
                },
              },
            ],
          },
          links: [],
        },
        features: [],
        run: {
          runId: 'sc:run:feature-input-test' as never,
          pipelineVersion: 'test',
          profile: 'pilot',
          requestedAt: '2026-07-17T00:00:00.000Z',
          completedAt: '2026-07-17T00:01:00.000Z',
        },
        sources: [manifest('parcels', 'complete', 'santa_clara_parcels')],
      },
      new AbortController().signal,
    )) as Readonly<{
      portableReleaseInput: Omit<RealCountyReleaseInput, 'outputDirectory'>;
    }>;
    const restricted = output.portableReleaseInput.build.profiles.find(
      ({ visibility }) => visibility === 'restricted',
    );
    expect(restricted?.relations.property_query?.[0]).toMatchObject({
      water_support_class: 'unknown',
      water_distance_meters: null,
      transit_support_class: 'unknown',
      transit_distance_meters: null,
      starbucks_support_class: 'unknown',
      starbucks_distance_meters: null,
    });
  });
});
