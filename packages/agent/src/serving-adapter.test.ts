import type { LanguageModel } from 'ai';
import type { RankingWeight } from '@oracle/query-core/inquiries/contracts';
import type {
  ProductionServingEnvelope,
  ProductionServingService,
  ServingCapabilities,
} from '@oracle/query-core/serving/contracts';
import { describe, expect, it, vi } from 'vitest';

import { namedEvidenceEnvelopeSchema } from './contracts.js';
import {
  createProductionAgentSemanticPolicy,
  createProductionOracleAgent,
} from './production-composition.js';
import {
  ORACLE_AGENT_SERVING_ADAPTER_VERSION,
  createProductionServingExecutor,
} from './serving-adapter.js';

const RELEASE_ID = 'release-santa-clara-2026-07-17';
const EVIDENCE_ID = `sc:evidence:${'a'.repeat(64)}`;
const release = {
  schemaVersion: '1.0.0',
  releaseId: RELEASE_ID,
  runId: 'run-santa-clara-2026-07-17',
  manifestCid: 'bafy-manifest',
  manifestSha256: 'b'.repeat(64),
  asOf: '2026-07-17T00:00:00.000Z',
  policyVersion: 'owner-free-public-serving@1.0.0',
  county: 'Santa Clara',
  state: 'CA',
  immutable: true,
  verified: true,
} as const;
const rankingWeights: readonly RankingWeight[] = Object.freeze([
  { criterion: 'roof_age', weight: 1, proxyMultiplier: 0.5 },
  { criterion: 'water_view_candidate', weight: 2, proxyMultiplier: 0.5 },
  { criterion: 'ownership_age', weight: 3, proxyMultiplier: 0.5 },
  { criterion: 'regional_owner', weight: 4, proxyMultiplier: 0.5 },
  { criterion: 'transit_walkability', weight: 5, proxyMultiplier: 0.5 },
  { criterion: 'starbucks_walkability', weight: 6, proxyMultiplier: 0.5 },
]);
const capability = Object.freeze({
  state: 'supported' as const,
  supportClasses: Object.freeze(['supported', 'proxy', 'unknown', 'unsupported'] as const),
  numerator: 1,
  denominator: 1,
  limitations: Object.freeze([]),
});
const capabilities: ServingCapabilities = Object.freeze({
  roof_age: capability,
  water_view_candidate: capability,
  ownership_age: capability,
  regional_owner: capability,
  transit_walkability: capability,
  starbucks_walkability: capability,
});

function envelope(data: unknown = { results: [] }): ProductionServingEnvelope {
  return {
    schemaVersion: release.schemaVersion,
    releaseId: release.releaseId,
    runId: release.runId,
    manifestCid: release.manifestCid,
    asOf: release.asOf,
    coverage: { roof_age: capability },
    limitations: [],
    data,
    nextCursor: null,
    truncated: false,
    timing: { elapsedMs: 1, bytesScanned: 100 },
  };
}

function serving(
  result: ProductionServingEnvelope = envelope(),
): ProductionServingService & { requests: { operation: string; input: unknown }[] } {
  const requests: { operation: string; input: unknown }[] = [];
  return {
    release: { ...release },
    requests,
    validateCursor: () => undefined,
    execute: async (request) => {
      requests.push({ operation: request.operation, input: request.input });
      return await Promise.resolve(result);
    },
  };
}

describe('oracle-agent-serving@1.0.0 translation adapter', () => {
  it('exports a version separate from the serving envelope schema', () => {
    expect(ORACLE_AGENT_SERVING_ADAPTER_VERSION).toBe('oracle-agent-serving@1.0.0');
    expect(release.schemaVersion).toBe('1.0.0');
  });

  it('translates every named tool into the exact frozen serving operation input', async () => {
    const target = serving();
    const executor = createProductionServingExecutor(target, rankingWeights);
    const cases = [
      ['get_dataset_info', { releaseId: RELEASE_ID }, {}],
      ['get_dataset_coverage', {}, { releaseId: RELEASE_ID }],
      ['list_pipeline_runs', { limit: 7 }, { releaseId: RELEASE_ID, limit: 7 }],
      ['get_pipeline_run', { runId: 'run-1' }, { releaseId: RELEASE_ID, runId: 'run-1' }],
      [
        'search_properties',
        { query: '123-456', city: 'Palo Alto' },
        { releaseId: RELEASE_ID, city: 'Palo Alto', parcelIdentifier: '123-456' },
      ],
      [
        'get_property',
        { propertyId: 'property-1' },
        { releaseId: RELEASE_ID, propertyId: 'property-1' },
      ],
      [
        'get_property_evidence',
        { propertyId: 'property-1', feature: 'roof_age', limit: 5 },
        { releaseId: RELEASE_ID, propertyId: 'property-1', feature: 'roof_age', limit: 5 },
      ],
      [
        'find_roof_age_candidates',
        { minimumAgeYears: 15 },
        { releaseId: RELEASE_ID, minimumAgeYears: 15 },
      ],
      [
        'find_water_view_candidates',
        { maximumDistanceMeters: 5000 },
        { releaseId: RELEASE_ID, maximumWaterDistanceMeters: 5000 },
      ],
      [
        'find_ownership_age_candidates',
        { minimumTenureYears: 10 },
        { releaseId: RELEASE_ID, minimumTenureYears: 10, requireCompleteHistory: true },
      ],
      [
        'find_regional_owner_properties',
        {},
        {
          releaseId: RELEASE_ID,
          regionPolicyId: 'bay-area-nine-counties-v1',
          requireCurrentOwner: true,
        },
      ],
      [
        'find_transit_walkable_properties',
        { maximumNetworkDistanceMeters: 800 },
        {
          releaseId: RELEASE_ID,
          maximumNetworkDistanceMeters: 800,
          maximumSnapDistanceMeters: 200,
        },
      ],
      [
        'find_starbucks_walkable_properties',
        { maximumNetworkDistanceMeters: 800 },
        {
          releaseId: RELEASE_ID,
          maximumNetworkDistanceMeters: 800,
          maximumSnapDistanceMeters: 200,
          minimumPlaceConfidence: 0.7,
        },
      ],
      [
        'rank_review_candidates',
        { minimumEvidenceCoverage: 0.5 },
        {
          releaseId: RELEASE_ID,
          criteria: rankingWeights.map(({ criterion }) => criterion),
          weights: rankingWeights,
          minimumEvidenceCoverage: 0.5,
        },
      ],
      [
        'list_artifacts',
        { limit: 3 },
        { releaseId: RELEASE_ID, publicationClass: 'public', limit: 3 },
      ],
      ['get_data_dictionary', { limit: 4 }, { releaseId: RELEASE_ID, limit: 4 }],
    ] as const;
    for (const [name, input, expected] of cases) {
      await executor.execute(name, input, {});
      expect(target.requests.at(-1)).toEqual({ operation: name, input: expected });
    }
  });

  it('extracts, deduplicates, sorts, and redacts public evidence without nested evidence', async () => {
    const result = envelope({
      results: [
        {
          propertyId: 'property-1',
          owner: 'restricted',
          ownerName: 'restricted',
          artifactPath: 's3://private/object',
          evidence: [
            {
              evidenceId: EVIDENCE_ID,
              supportClass: 'supported',
              sourceIds: ['source-z', 'source-a'],
              limitations: [],
              visibility: 'public',
            },
          ],
        },
      ],
    });
    const adapted = namedEvidenceEnvelopeSchema.parse(
      await createProductionServingExecutor(serving(result), rankingWeights).execute(
        'find_roof_age_candidates',
        {},
        {},
      ),
    );
    expect(adapted).toMatchObject({
      evidence: [
        {
          evidenceId: EVIDENCE_ID,
          propertyId: 'property-1',
          sourceIds: ['source-a', 'source-z'],
        },
      ],
      data: { results: [{ propertyId: 'property-1' }] },
    });
    expect(JSON.stringify(adapted)).not.toContain('ownerName');
    expect(JSON.stringify(adapted)).not.toContain('restricted');
    expect(JSON.stringify(adapted)).not.toContain('artifactPath');
    expect(JSON.stringify(adapted.data)).not.toContain('evidence');
  });

  it('fails closed for malformed/non-public evidence and artifacts', async () => {
    for (const data of [
      {
        results: [
          {
            evidence: [
              { evidenceId: EVIDENCE_ID, supportClass: 'supported', visibility: 'public' },
            ],
          },
        ],
      },
      {
        results: [
          {
            evidence: [
              {
                evidenceId: EVIDENCE_ID,
                supportClass: 'supported',
                sourceIds: ['source-a'],
                limitations: [],
              },
            ],
          },
        ],
      },
      { artifacts: [{ relation: 'secret', visibility: 'restricted' }] },
      {
        results: [
          {
            evidence: [
              {
                evidenceId: EVIDENCE_ID,
                supportClass: 'supported',
                sourceIds: [],
                limitations: [],
                visibility: 'restricted',
              },
            ],
          },
        ],
      },
    ]) {
      const executor = createProductionServingExecutor(serving(envelope(data)), rankingWeights);
      await expect(executor.execute('list_artifacts', {}, {})).rejects.toThrow(
        /Malformed public evidence|Non-public serving data|Evidence without explicit public visibility/,
      );
    }
  });

  it('rejects release drift, nested release drift, unknown fields/tools, and unverified services', async () => {
    const drifted = envelope({ release: { ...release, runId: 'wrong-run' } });
    await expect(
      createProductionServingExecutor(serving(drifted), rankingWeights).execute(
        'get_dataset_info',
        {},
        {},
      ),
    ).rejects.toThrow('Nested serving release');
    const executor = createProductionServingExecutor(serving(), rankingWeights);
    await expect(
      executor.execute('get_dataset_coverage', { dataset: 'unsupported' }, {}),
    ).rejects.toThrow();
    await expect(
      Reflect.apply(executor.execute, executor, ['unknown_tool', {}, {}]),
    ).rejects.toThrow('Unknown');
    await expect(
      executor.execute('get_dataset_info', { releaseId: 'stale-release' }, {}),
    ).rejects.toThrow('does not match');
    const unverified = serving();
    Object.defineProperty(unverified.release, 'verified', { value: false });
    expect(() => createProductionServingExecutor(unverified, rankingWeights)).toThrow(
      'not verified',
    );
  });

  it('enforces abort/timeout, row, scan, and 900 KiB payload bounds', async () => {
    const abortedService = serving();
    abortedService.execute = () => new Promise(() => undefined);
    const controller = new AbortController();
    const aborted = expect(
      createProductionServingExecutor(abortedService, rankingWeights).execute(
        'get_dataset_info',
        {},
        { signal: controller.signal },
      ),
    ).rejects.toThrow('aborted');
    controller.abort();
    await aborted;
    vi.useFakeTimers();
    try {
      const never = serving();
      never.execute = () => new Promise(() => undefined);
      const pending = expect(
        createProductionServingExecutor(never, rankingWeights).execute('get_dataset_info', {}, {}),
      ).rejects.toThrow('5 seconds');
      await vi.advanceTimersByTimeAsync(5_001);
      await pending;
    } finally {
      vi.useRealTimers();
    }
    const tooManyRows = envelope({ results: Array.from({ length: 101 }, () => ({})) });
    await expect(
      createProductionServingExecutor(serving(tooManyRows), rankingWeights).execute(
        'find_roof_age_candidates',
        {},
        {},
      ),
    ).rejects.toThrow('row page');
    const tooMuchScan = {
      ...envelope(),
      timing: { elapsedMs: 1, bytesScanned: 512 * 1024 * 1024 + 1 },
    };
    await expect(
      createProductionServingExecutor(serving(tooMuchScan), rankingWeights).execute(
        'get_dataset_info',
        {},
        {},
      ),
    ).rejects.toThrow('budget');
    await expect(
      createProductionServingExecutor(
        serving(envelope({ value: 'x'.repeat(901 * 1024) })),
        rankingWeights,
      ).execute('get_dataset_info', {}, {}),
    ).rejects.toThrow('900 KiB');
  });
});

describe('production model composition', () => {
  const model: LanguageModel = {
    specificationVersion: 'v3',
    provider: 'amazon-bedrock',
    modelId: 'test-profile',
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error('not invoked by construction')),
    doStream: () => Promise.resolve({ stream: new ReadableStream() }),
  };

  it('fails configuration, policy drift, construction, and probe errors without a fallback', async () => {
    const target = serving();
    const policy = createProductionAgentSemanticPolicy(capabilities);
    const base = {
      serving: target,
      rankingWeights,
      capabilities,
    };
    await expect(createProductionOracleAgent({ ...base, environment: {} })).rejects.toThrow(
      'configuration',
    );
    const environment = {
      ORACLE_MODEL_PROVIDER: 'amazon-bedrock',
      ORACLE_BEDROCK_MODEL_ID: 'test-profile',
      ORACLE_BEDROCK_REGION: 'us-east-2',
      ORACLE_AGENT_POLICY_HASH: policy.hash,
      ORACLE_AGENT_TEST_FALLBACK: 'true',
    };
    await expect(
      createProductionOracleAgent(
        {
          ...base,
          environment: { ...environment, ORACLE_AGENT_POLICY_HASH: `sha256:${'f'.repeat(64)}` },
        },
        {
          createGateway: (config) => ({ ...config, model }),
        },
      ),
    ).rejects.toThrow('drift');
    await expect(
      createProductionOracleAgent(
        { ...base, environment },
        {
          createGateway: () => {
            throw new Error('construction');
          },
        },
      ),
    ).rejects.toThrow('construction');
    await expect(
      createProductionOracleAgent(
        { ...base, environment },
        {
          createGateway: (config) => ({ ...config, model }),
          probeGateway: () => {
            throw new Error('probe');
          },
        },
      ),
    ).rejects.toThrow('probe');
  });
});
