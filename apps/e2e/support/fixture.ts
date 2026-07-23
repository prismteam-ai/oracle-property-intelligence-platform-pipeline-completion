import type { Page, Request, Route } from '@playwright/test';

export const FIXTURE_RELEASE_ID = 'test-santa-clara-release-5399fc2';
export const FIXTURE_RUN_ID = 'test-pipeline-run-20260717';
export const FIXTURE_MANIFEST_CID = 'bafytestoraclewave3brelease';
export const FIXTURE_PROPERTY_ID = 'property-sc-0001';
export const FIXTURE_EVIDENCE_ID = 'evidence-sc-0001';

type FixtureMode = 'ready' | 'agent-degraded' | 'api-degraded';

export type FixtureController = Readonly<{
  setMode(mode: FixtureMode): void;
}>;

const operations = new Set([
  'dataset.getInfo',
  'dataset.getCoverage',
  'pipeline.listRuns',
  'pipeline.getRun',
  'property.search',
  'property.get',
  'property.getEvidence',
  'inquiry.roofAge',
  'inquiry.waterCandidates',
  'inquiry.ownershipAge',
  'inquiry.regionalOwner',
  'inquiry.transitWalkability',
  'inquiry.starbucksWalkability',
  'inquiry.rankCandidates',
  'artifacts.list',
  'artifacts.getDataDictionary',
  'agent.ask',
  'agent.status',
]);

const property = Object.freeze({
  propertyId: FIXTURE_PROPERTY_ID,
  parcelIdentifier: '120-34-056',
  apn: '120-34-056',
  address: '250 Hamilton Avenue, Palo Alto, CA 94301',
  city: 'Palo Alto',
  postalCode: '94301',
  supportState: 'supported',
  truthLabel: 'Supported — direct evidence',
  evidenceIds: [FIXTURE_EVIDENCE_ID],
  sourceIds: ['source-santa-clara-parcel'],
});

const inquiryRows = Object.freeze({
  'inquiry.roofAge': {
    ...property,
    matchedValue: 'Roof evidence age: 19 years',
    feature: 'roof_age',
    algorithmVersion: 'roof-age-v1',
  },
  'inquiry.waterCandidates': {
    ...property,
    supportState: 'proxy',
    truthLabel: 'Proxy — review required',
    matchedValue: 'Potential water-view candidate; actual view is not verified',
    feature: 'water_view_candidate',
  },
  'inquiry.ownershipAge': {
    ...property,
    supportState: 'unknown',
    truthLabel: 'Partial coverage',
    matchedValue: 'Ownership exchange history is incomplete',
    feature: 'ownership_age',
  },
  'inquiry.regionalOwner': {
    ...property,
    supportState: 'unknown',
    truthLabel: 'Blocked — source/access',
    matchedValue: 'Regional-owner classification unavailable',
    feature: 'regional_owner',
  },
  'inquiry.transitWalkability': {
    ...property,
    supportState: 'supported',
    truthLabel: 'Supported — derived evidence',
    matchedValue: '620 m pedestrian-network distance to active transit',
    feature: 'transit_walkability',
  },
  'inquiry.starbucksWalkability': {
    ...property,
    supportState: 'supported',
    truthLabel: 'Supported — derived evidence',
    matchedValue: '540 m pedestrian-network distance to qualified Starbucks place',
    feature: 'starbucks_walkability',
  },
} satisfies Readonly<Record<string, Readonly<Record<string, unknown>>>>);

function rows(operation: string): readonly Readonly<Record<string, unknown>>[] {
  const inquiry = (inquiryRows as Readonly<Record<string, Readonly<Record<string, unknown>>>>)[
    operation
  ];
  if (inquiry !== undefined) return [inquiry];
  switch (operation) {
    case 'pipeline.listRuns':
    case 'pipeline.getRun':
      return [
        {
          runId: FIXTURE_RUN_ID,
          status: 'complete',
          completedAt: '2026-07-17T00:00:00.000Z',
          truthLabel: 'Supported — direct evidence',
          limitation: 'Deterministic browser fixture; never production county data.',
        },
      ];
    case 'property.search':
      return [property];
    case 'property.get':
      return [
        {
          ...property,
          county: 'Santa Clara County',
          latitude: 37.4443,
          longitude: -122.159,
        },
      ];
    case 'property.getEvidence':
      return [
        {
          evidenceId: FIXTURE_EVIDENCE_ID,
          propertyId: FIXTURE_PROPERTY_ID,
          supportState: 'supported',
          truthLabel: 'Supported — direct evidence',
          sourceId: 'source-santa-clara-parcel',
          observedAt: '2026-07-17T00:00:00.000Z',
          limitation: 'Deterministic browser fixture.',
        },
      ];
    case 'inquiry.rankCandidates':
      return [
        {
          ...property,
          rank: 1,
          score: 0.82,
          componentScores: { roof_age: 0.4, transit_walkability: 0.42 },
          tieBreak: FIXTURE_PROPERTY_ID,
        },
      ];
    case 'artifacts.list':
      return [
        {
          artifactId: 'artifact-public-query-mart',
          artifactType: 'query_mart',
          publicationClass: 'public',
          cid: 'bafytestquerymart',
          checksum: 'sha256:test-only-query-mart',
          truthLabel: 'Supported — direct evidence',
        },
      ];
    case 'artifacts.getDataDictionary':
      return [
        {
          entity: 'property',
          field: 'propertyId',
          type: 'string',
          description: 'Opaque canonical property identifier',
        },
      ];
    default:
      return [];
  }
}

function data(operation: string): Readonly<Record<string, unknown>> {
  if (operation === 'dataset.getInfo') {
    return {
      county: 'Santa Clara County',
      countyFips: '06085',
      releaseId: FIXTURE_RELEASE_ID,
      runId: FIXTURE_RUN_ID,
      propertyCount: 487_319,
      paloAltoIncluded: true,
      truthLabel: 'Supported — direct evidence',
      fixtureMode: true,
    };
  }
  if (operation === 'dataset.getCoverage') {
    return {
      items: [
        { source: 'Property', count: 487_319, truthLabel: 'Supported — direct evidence' },
        { source: 'Permit', count: 98_592, truthLabel: 'Partial coverage' },
        { source: 'Ownership', count: 0, truthLabel: 'Blocked — source/access' },
        { source: 'Coordinates', count: 0, truthLabel: 'Unsupported' },
      ],
    };
  }
  if (operation === 'agent.status') {
    return {
      status: 'available',
      modelProfileId: 'test-bedrock-profile',
      policyHash: 'sha256:test-policy',
      truthLabel: 'Supported — direct evidence',
    };
  }
  if (operation === 'agent.ask') {
    return {
      status: 'complete',
      answer: `The deterministic tool returned one review candidate [evidence:${FIXTURE_EVIDENCE_ID}].`,
      citations: [FIXTURE_EVIDENCE_ID],
      toolCalls: [
        {
          callIndex: 1,
          toolName: 'rank_review_candidates',
          releaseId: FIXTURE_RELEASE_ID,
          evidenceIds: [FIXTURE_EVIDENCE_ID],
        },
      ],
      truthLabel: 'Supported — direct evidence',
    };
  }
  const operationRows = rows(operation);
  return { items: operationRows, results: operationRows };
}

function envelope(operation: string): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: '1.0.0',
    releaseId: FIXTURE_RELEASE_ID,
    runId: FIXTURE_RUN_ID,
    manifestCid: FIXTURE_MANIFEST_CID,
    asOf: '2026-07-17T00:00:00.000Z',
    coverage: {
      county: 'Santa Clara County',
      truthLabels: [
        'Supported — direct evidence',
        'Supported — derived evidence',
        'Proxy — review required',
        'Partial coverage',
        'Blocked — source/access',
        'Unsupported',
      ],
    },
    limitations: ['Deterministic browser fixture; never production county data.'],
    data: data(operation),
    nextCursor: null,
    truncated: false,
    timing: { elapsedMs: 3, bytesScanned: 1024 },
  };
}

function operationFrom(request: Request): string | null {
  const pathname = new URL(request.url()).pathname.replace(/\/+$/u, '');
  const candidate = decodeURIComponent(pathname.split('/').at(-1) ?? '');
  return operations.has(candidate) ? candidate : null;
}

function invalidInput(request: Request): boolean {
  let input: unknown;
  try {
    input = request.postDataJSON();
  } catch {
    return true;
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return true;
  const parameters = input as Readonly<Record<string, unknown>>;
  return [
    'minimumAgeYears',
    'maximumDistanceMeters',
    'minimumTenureYears',
    'maximumNetworkDistanceMeters',
  ].some((key) => typeof parameters[key] === 'number' && parameters[key] <= 0);
}

async function fulfill(
  route: Route,
  request: Request,
  operation: string,
  mode: FixtureMode,
): Promise<void> {
  const fixtureHeaders = {
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-oracle-fixture': 'TEST_ONLY_DETERMINISTIC_FIXTURE',
  };
  if (invalidInput(request)) {
    await route.fulfill({
      status: 400,
      headers: fixtureHeaders,
      body: JSON.stringify({
        error: {
          code: 'INVALID_REQUEST',
          message: 'The request does not match the operation contract.',
          operation,
          requestId: 'test-request',
          retryable: false,
        },
      }),
    });
    return;
  }
  if (mode === 'api-degraded' || (mode === 'agent-degraded' && operation.startsWith('agent.'))) {
    await route.fulfill({
      status: 503,
      headers: fixtureHeaders,
      body: JSON.stringify({
        error: {
          code: mode === 'agent-degraded' ? 'AGENT_UNAVAILABLE' : 'SERVICE_UNAVAILABLE',
          message:
            mode === 'agent-degraded'
              ? 'The selected model profile is unavailable; no fallback answer was generated.'
              : 'The verified immutable release adapter is unavailable.',
          operation,
          requestId: 'test-request',
          retryable: true,
        },
      }),
    });
    return;
  }
  await route.fulfill({
    status: 200,
    headers: fixtureHeaders,
    body: JSON.stringify(envelope(operation)),
  });
}

export async function installDeterministicApiFixture(page: Page): Promise<FixtureController> {
  const state: { mode: FixtureMode } = { mode: 'ready' };
  await page.route('**/*', async (route) => {
    const request = route.request();
    const operation = request.method() === 'POST' ? operationFrom(request) : null;
    if (operation === null) {
      await route.continue();
      return;
    }
    await fulfill(route, request, operation, state.mode);
  });
  return Object.freeze({ setMode: (mode: FixtureMode) => (state.mode = mode) });
}
