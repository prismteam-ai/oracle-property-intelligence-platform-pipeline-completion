import { runIdSchema, snapshotIdSchema, sourceIdSchema } from '@oracle/contracts/ids';
import { describe, expect, it } from 'vitest';

import {
  assertConfiguration,
  assertCountyProcessorProfile,
  countyCompletion,
  REQUIRED_COUNTY_CAPABILITIES,
  selectDiscoveryDenominator,
  UnboundedCountyPhaseError,
} from './runner.js';
import type {
  PipelineConfiguration,
  SourceConfiguration,
  SourceExecutionManifest,
} from './types.js';

const HASH = 'a'.repeat(64);

function configuredSource(
  suffix: string,
  capability: string,
  requiredForCountyCompletion = true,
): SourceConfiguration {
  const sourceId = sourceIdSchema.parse(`sc:source:${suffix}`);
  return {
    adapter: {
      describe: () => ({ sourceId, contractVersion: 'test' }),
    } as SourceConfiguration['adapter'],
    snapshotId: snapshotIdSchema.parse(`sc:snapshot:${suffix}:${HASH}`),
    scope: 'test',
    capability,
    executionMode: 'execute',
    supportState: 'available',
    acquisitionItemCap: null,
    discoveryDenominatorStrategy: 'first_non_null',
    requiredForCountyCompletion,
  };
}

function executionManifest(
  suffix: string,
  terminalState: SourceExecutionManifest['terminalState'],
  requiredForCountyCompletion = true,
  capability = suffix,
): SourceExecutionManifest {
  const sourceId = sourceIdSchema.parse(`sc:source:${suffix}`);
  const snapshotId = snapshotIdSchema.parse(`sc:snapshot:${suffix}:${HASH}`);
  return {
    sourceId,
    snapshotId,
    snapshotIdentity: {
      intentId: snapshotId,
      observedContentId: null,
      method: 'configured_intent_plus_observed_content_v1',
    },
    scope: 'test',
    capability,
    executionMode: 'execute',
    supportState: terminalState === 'blocked' ? 'blocked' : 'available',
    requiredForCountyCompletion,
    terminalState,
    sourceHash: HASH,
    sourceAsOf: null,
    license: {
      redistribution: 'approved',
      containsPersonalData: false,
      defaultVisibility: 'public',
    },
    schemaHashes: [],
    checkpointRevision: null,
    coverage: {
      expectedRecords: null,
      observedRecords: 0,
      acceptedRecords: 0,
      quarantinedRecords: 0,
      denominatorMethod: 'unavailable',
      ratio: null,
    },
    timings: [],
    artifacts: [],
    limitations: [],
    errorCodes: [],
    summary: null,
  };
}

describe('source coverage denominator selection', () => {
  const resources = [
    { expectedRecords: 2_000 },
    { expectedRecords: 2_000 },
    { expectedRecords: 873 },
    { expectedRecords: null },
  ];

  it('uses the first authoritative denominator for alternate parcel views', () => {
    expect(selectDiscoveryDenominator('first_non_null', resources)).toBe(2_000);
  });

  it('sums page-family denominators for 3DHP resources', () => {
    expect(selectDiscoveryDenominator('sum_non_null', resources)).toBe(4_873);
  });

  it('can explicitly suppress a non-comparable discovered denominator', () => {
    expect(selectDiscoveryDenominator('unavailable', resources)).toBeNull();
  });
});

describe('full county completion guard', () => {
  it('allows the exact full inventory to retain reviewed tiny legacy capability lanes', () => {
    const configuration: PipelineConfiguration = {
      runId: runIdSchema.parse(`sc:run:${'c'.repeat(64)}`),
      pipelineVersion: 'test',
      requestedAt: '2026-07-17T00:00:00.000Z',
      profile: {
        name: 'full',
        recordCap: null,
        maxConcurrentSources: 2,
        maxBufferedRecords: 1,
      },
      sources: REQUIRED_COUNTY_CAPABILITIES.map((capability) =>
        configuredSource(capability.replaceAll('_', '-'), capability),
      ),
      maximumPhaseAttempts: 1,
    };
    expect(() => assertConfiguration(configuration)).not.toThrow();
    expect(() => assertCountyProcessorProfile('full', 'small_run_only_v1')).toThrow(
      UnboundedCountyPhaseError,
    );
    expect(() => assertCountyProcessorProfile('incremental', 'small_run_only_v1')).toThrow(
      UnboundedCountyPhaseError,
    );
    expect(() => assertCountyProcessorProfile('pilot', 'small_run_only_v1')).not.toThrow();
  });

  it('rejects a parcel-only full configuration', () => {
    const configuration: PipelineConfiguration = {
      runId: runIdSchema.parse(`sc:run:${HASH}`),
      pipelineVersion: 'test',
      requestedAt: '2026-07-17T00:00:00.000Z',
      profile: {
        name: 'full',
        recordCap: null,
        maxConcurrentSources: 1,
        maxBufferedRecords: 1,
      },
      sources: [configuredSource('parcels', 'santa_clara_parcels')],
      maximumPhaseAttempts: 1,
    };
    expect(() => assertConfiguration(configuration)).toThrow(
      'A full run cannot compose fewer than two source lanes',
    );
  });

  it('rejects a multi-source full configuration missing the production inventory', () => {
    const configuration: PipelineConfiguration = {
      runId: runIdSchema.parse(`sc:run:${'b'.repeat(64)}`),
      pipelineVersion: 'test',
      requestedAt: '2026-07-17T00:00:00.000Z',
      profile: {
        name: 'full',
        recordCap: null,
        maxConcurrentSources: 2,
        maxBufferedRecords: 10,
      },
      sources: [
        configuredSource('parcels', 'santa_clara_parcels'),
        configuredSource('permits', 'san_jose_permits'),
      ],
      maximumPhaseAttempts: 1,
    };
    expect(() => assertConfiguration(configuration)).toThrow(
      'A full run requires the exact production capability inventory',
    );
  });

  it.each(['partial', 'blocked'] as const)(
    'cannot claim complete with a required %s lane',
    (terminalState) => {
      const result = countyCompletion(
        { name: 'full', recordCap: null, maxConcurrentSources: 2, maxBufferedRecords: 10 },
        [executionManifest('parcels', 'complete'), executionManifest('permits', terminalState)],
      );
      expect(result.state).toBe(terminalState === 'blocked' ? 'blocked' : 'partial');
      expect(result.claim).not.toContain('Every required configured source lane reached complete');
    },
  );

  it('keeps an all-complete two-lane full manifest ineligible', () => {
    const result = countyCompletion(
      { name: 'full', recordCap: null, maxConcurrentSources: 2, maxBufferedRecords: 10 },
      [executionManifest('parcels', 'complete'), executionManifest('permits', 'complete')],
    );
    expect(result.state).toBe('partial');
    expect(result.missingRequiredCapabilities.length).toBeGreaterThan(0);
  });

  it('claims complete only for the exact required inventory and ignores optional 511 failure', () => {
    const required = REQUIRED_COUNTY_CAPABILITIES.map((capability) =>
      executionManifest(capability.replaceAll('_', '-'), 'complete', true, capability),
    );
    const result = countyCompletion(
      { name: 'full', recordCap: null, maxConcurrentSources: 2, maxBufferedRecords: 10 },
      [...required, executionManifest('511-fallback', 'failed', false, 'transit_511_fallback')],
    );
    expect(result).toMatchObject({
      state: 'complete',
      requiredSourceCount: 14,
      completeRequiredSourceCount: 14,
      blockingSourceIds: [],
      missingRequiredCapabilities: [],
      unexpectedRequiredCapabilities: [],
    });
  });
});
