import { describe, expect, it } from 'vitest';

import { linkEntities } from '../entity-linking/engine.js';
import type { LinkableEntity } from '../entity-linking/model.js';
import { buildCoverageReport, measureCoverage, relationCoverageFromLinkingRun } from './report.js';
import type { CoverageMetricInput } from './model.js';

const lineage = Object.freeze([
  Object.freeze({
    sourceId: 'sc:source:coverage-fixture',
    snapshotId: `sc:snapshot:coverage-fixture:${'4'.repeat(64)}`,
    artifactId: `sc:artifact:sha256:${'5'.repeat(64)}`,
    recordKey: 'coverage-fixture',
    recordSha256: '6'.repeat(64),
  }),
]);

function input(overrides: Partial<CoverageMetricInput> = {}): CoverageMetricInput {
  return {
    dimension: 'source',
    dataset: 'permits',
    subject: 'source records',
    jurisdiction: 'Santa Clara County',
    timeWindow: { start: '2010-01-01T00:00:00.000Z', end: '2026-07-17T00:00:00.000Z' },
    numerator: 8,
    denominator: {
      value: 10,
      method: 'authoritative_count',
      scope: 'Santa Clara County permits in the declared time window',
      asOf: '2026-07-17T00:00:00.000Z',
      lineage,
    },
    terminalState: 'partial',
    gapReasons: [
      { code: 'source_partial', count: 2, detail: 'Two expected records were not acquired.' },
    ],
    sourceIds: ['sc:source:coverage-fixture'],
    visibilityCounts: { public: 5, authenticated: 1, restricted: 1, prohibited_public: 1 },
    duplicateCounts: {},
    lineage,
    ...overrides,
  };
}

function linkEntity(
  entityId: string,
  entityKind: LinkableEntity['entityKind'],
  apn: string | null,
  visibility: LinkableEntity['visibility'] = 'public',
): LinkableEntity {
  return {
    entityId,
    entityKind,
    jurisdiction: 'Santa Clara County',
    identifiers: [],
    normalizedKeys: apn === null ? [] : [{ kind: 'apn', value: apn }],
    candidateAttributes: {},
    evidenceAvailability: 'complete',
    visibility,
    lineage,
  };
}

describe('coverage measurement', () => {
  it('computes denominator-based arithmetic and audience visibility without changing scope', () => {
    const metric = measureCoverage(input());

    expect(metric.coverageRatio).toBe(0.8);
    expect(metric.completenessState).toBe('partial');
    expect(metric.audienceCoverage).toEqual({
      public: { numerator: 5, ratio: 0.5 },
      authenticated: { numerator: 6, ratio: 0.6 },
      operator: { numerator: 7, ratio: 0.7 },
    });
    expect(Object.isFrozen(metric.lineage)).toBe(true);
    expect(Object.isFrozen(metric.denominator.lineage)).toBe(true);
  });

  it('represents a blocked source and unknown denominator as unknown coverage', () => {
    const metric = measureCoverage(
      input({
        dataset: 'ownership-events',
        subject: 'transfer history',
        numerator: 0,
        denominator: {
          value: null,
          method: 'capability_unavailable',
          scope: 'Santa Clara County ownership history',
          asOf: '2026-07-17T00:00:00.000Z',
          lineage,
        },
        terminalState: 'blocked',
        gapReasons: [
          {
            code: 'source_blocked',
            count: null,
            detail: 'The ownership adapter is not integrated.',
          },
          {
            code: 'denominator_unavailable',
            count: null,
            detail: 'No authoritative history denominator is available.',
          },
        ],
        visibilityCounts: { public: 0, authenticated: 0, restricted: 0, prohibited_public: 0 },
      }),
    );

    expect(metric).toMatchObject({
      coverageRatio: null,
      completenessState: 'blocked',
      numerator: 0,
    });
  });

  it('rejects misleading zero denominators and unexplained arithmetic overages', () => {
    expect(() =>
      measureCoverage(input({ denominator: { ...input().denominator, value: 0 } })),
    ).toThrow(/zero denominator/u);
    expect(() =>
      measureCoverage(
        input({
          numerator: 11,
          visibilityCounts: { public: 11, authenticated: 0, restricted: 0, prohibited_public: 0 },
          terminalState: 'succeeded',
          gapReasons: [],
        }),
      ),
    ).toThrow(/above its denominator/u);
  });

  it('derives relation methods, confidence, duplicate classes, and unresolved gaps from linking', () => {
    const run = linkEntities(
      'permit_property',
      [
        linkEntity('permit-linked', 'permit', '12345678', 'restricted'),
        linkEntity('permit-orphan', 'permit', null),
      ],
      [linkEntity('property-linked', 'property', '12345678')],
    );
    const metric = relationCoverageFromLinkingRun(run, {
      dataset: 'permit-property-links',
      subject: 'permit to property',
      jurisdiction: 'Santa Clara County',
      timeWindow: { start: '2010-01-01T00:00:00.000Z', end: '2026-07-17T00:00:00.000Z' },
      sourceIds: ['sc:source:coverage-fixture'],
      asOf: '2026-07-17T00:00:00.000Z',
      lineage,
    });

    expect(metric).toMatchObject({
      numerator: 1,
      coverageRatio: 0.5,
      completenessState: 'partial',
      methodCounts: { normalized_exact: 1 },
      confidenceCounts: { high: 1 },
      audienceCoverage: {
        public: { numerator: 0, ratio: 0 },
        operator: { numerator: 1, ratio: 0.5 },
      },
    });
    expect(metric.gapReasons.map(({ code }) => code)).toEqual([
      'restricted_visibility',
      'unmatched_records',
    ]);
  });

  it('builds replay/order-independent source, entity, field, and relation reports', () => {
    const metrics = [
      input({ dimension: 'source', dataset: 'properties', subject: 'source rows' }),
      input({ dimension: 'entity', dataset: 'properties', subject: 'canonical properties' }),
      input({ dimension: 'field', dataset: 'properties', subject: 'year_built' }),
      input({
        dimension: 'relation',
        dataset: 'permits',
        subject: 'permit to property',
        methodCounts: { normalized_exact: 8 },
        confidenceCounts: { high: 8 },
      }),
    ];
    const forward = buildCoverageReport('Santa Clara County', '2026-07-17T00:00:00.000Z', metrics);
    const replayed = buildCoverageReport(
      'Santa Clara County',
      '2026-07-17T00:00:00.000Z',
      [...metrics].reverse().concat(metrics[0] ?? []),
    );

    expect(replayed).toEqual(forward);
    expect(forward.dimensionCounts).toEqual({ source: 1, entity: 1, field: 1, relation: 1 });
  });
});
