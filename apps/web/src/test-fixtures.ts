import { FIXTURE_LABEL } from './api.js';
import type { ApiClient, ApiEnvelope, ApplicationOperation } from './types.js';

const release = Object.freeze({
  schemaVersion: '1.0.0',
  releaseId: 'release-test-only-2026-07-17',
  runId: 'run-test-only-001',
  manifestCid: 'bafy-test-only-manifest',
  asOf: '2026-07-17T00:00:00.000Z',
  coverage: { properties: 2, sourceState: 'partial' },
  limitations: ['Deterministic fixture for automated UI verification only.'],
  nextCursor: null,
  truncated: false,
  timing: { elapsedMs: 4, bytesScanned: 128 },
});

const propertyRows = [
  {
    propertyId: 'TEST-PROP-001',
    address: '1 Test-only Way, Palo Alto, CA',
    matchedValue: 19,
    supportState: 'supported',
    evidenceIds: ['TEST-EVIDENCE-001'],
    latitude: 37.44,
    longitude: -122.16,
  },
  {
    propertyId: 'TEST-PROP-002',
    address: '2 Fixture Lane, Palo Alto, CA',
    matchedValue: 11,
    supportState: 'proxy',
    evidenceIds: ['TEST-EVIDENCE-002'],
    latitude: 37.43,
    longitude: -122.15,
  },
] as const;

function dataFor(operation: ApplicationOperation): unknown {
  switch (operation) {
    case 'dataset.getInfo':
      return { fixtureLabel: FIXTURE_LABEL, county: 'Santa Clara County' };
    case 'dataset.getCoverage':
      return {
        results: [
          {
            dataset: 'property',
            supportState: 'partial',
            expectedCount: 2,
            observedCount: 2,
            linkedCount: 2,
            asOf: release.asOf,
          },
        ],
      };
    case 'pipeline.listRuns':
      return { results: [{ runId: release.runId, status: 'supported', observedCount: 2 }] };
    case 'property.get':
      return propertyRows[0];
    case 'property.getEvidence':
      return {
        evidence: [
          {
            evidenceId: 'TEST-EVIDENCE-001',
            sourceIds: ['TEST-SOURCE-001'],
            feature: 'roof_age',
            value: 'Test-only completed roof work',
            supportState: 'supported',
          },
        ],
      };
    case 'agent.status':
      return {
        status: 'unavailable',
        modelProfile: null,
        policyHash: 'sha256:test-only-policy',
      };
    case 'agent.ask':
      return {
        status: 'available',
        answer: 'Test-only cited synthesis. [evidence:TEST-EVIDENCE-001]',
        citations: ['TEST-EVIDENCE-001'],
        toolCalls: [{ name: 'find_roof_age_candidates', resultCount: 1 }],
      };
    case 'artifacts.list':
      return {
        artifacts: [
          {
            artifactId: 'TEST-ARTIFACT-001',
            cid: 'bafy-test-only-artifact',
            sha256: 'test-only-sha256',
            bytes: 128,
            rowCount: 2,
            publicationClass: 'public',
          },
        ],
      };
    case 'artifacts.getDataDictionary':
      return {
        fields: [
          {
            entity: 'property',
            field: 'property_id',
            type: 'string',
            description: 'Test-only canonical identifier.',
            publicationClass: 'public',
          },
        ],
      };
    default:
      return { results: propertyRows };
  }
}

export function createTestOnlyFixtureClient(): ApiClient {
  return Object.freeze({
    execute(operation: ApplicationOperation): Promise<ApiEnvelope> {
      return Promise.resolve(Object.freeze({ ...release, data: dataFor(operation) }));
    },
  });
}

export const TEST_ONLY_RELEASE_ID = release.releaseId;
export const TEST_ONLY_FIXTURE_LABEL = FIXTURE_LABEL;
