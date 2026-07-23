import { expect, test, type APIRequestContext, type Page, type Response } from '@playwright/test';

import { expectReleaseIdentity, truthLabelPattern } from '../support/assertions.js';
import {
  FIXTURE_EVIDENCE_ID,
  FIXTURE_MANIFEST_CID,
  FIXTURE_PROPERTY_ID,
  FIXTURE_RELEASE_ID,
  FIXTURE_RUN_ID,
  type FixtureController,
} from '../support/fixture.js';
import { openEvaluatorRoute, prepareEvaluatorPage } from '../support/page.js';
import { inquiryRoutes } from '../support/routes.js';
import { evaluatorTargetConfiguration, isHostedTarget } from '../support/target.js';

let fixture: FixtureController | null;

const inquiryOperationByPath: Readonly<Record<string, string>> = Object.freeze({
  '/inquiries/roof-age': 'inquiry.roofAge',
  '/inquiries/water-candidates': 'inquiry.waterCandidates',
  '/inquiries/ownership-age': 'inquiry.ownershipAge',
  '/inquiries/regional-owner': 'inquiry.regionalOwner',
  '/inquiries/transit-walkability': 'inquiry.transitWalkability',
  '/inquiries/starbucks-walkability': 'inquiry.starbucksWalkability',
});

type JsonRecord = Readonly<Record<string, unknown>>;
const HOSTED_AGENT_RESPONSE_TIMEOUT_MS = 27_000;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function operationResponse(page: Page, operation: string, timeoutMs?: number): Promise<Response> {
  return page.waitForResponse(
    (response) => {
      const pathname = decodeURIComponent(new URL(response.url()).pathname).replace(/\/+$/u, '');
      return response.request().method() === 'POST' && pathname.endsWith(`/${operation}`);
    },
    timeoutMs === undefined ? {} : { timeout: timeoutMs },
  );
}

function responseRows(body: unknown): readonly unknown[] {
  const data = asRecord(body)?.data;
  if (Array.isArray(data)) return data;
  const record = asRecord(data);
  if (record === null) return [];
  for (const key of ['results', 'items', 'properties', 'runs', 'artifacts', 'fields', 'evidence']) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function capabilityFrom(body: unknown): JsonRecord | null {
  const envelope = asRecord(body);
  const direct = asRecord(asRecord(envelope?.data)?.capability);
  if (direct !== null) return direct;
  const coverage = asRecord(envelope?.coverage);
  if (coverage === null) return null;
  return (
    Object.values(coverage)
      .map((value) => asRecord(value))
      .find((value) => value !== null && typeof value.state === 'string') ?? null
  );
}

function stringItems(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

/**
 * One prompt per public serving criterion. Each phrasing routes to exactly that
 * single criterion in packages/agent/src/routing.ts, and the two threshold
 * criteria carry the year the deterministic inquiry route requires.
 */
const criterionPrompts: Readonly<Record<string, string>> = Object.freeze({
  roof_age: 'Which properties have roofs older than 15 years?',
  water_view_candidate: 'Which properties are water-view candidates in this release?',
  ownership_age: 'Which properties have not exchanged ownership in more than 10 years?',
  regional_owner: 'Which properties have a regional owner in this release?',
  transit_walkability: 'Which properties are within walking distance of transit?',
  starbucks_walkability: 'Which properties are within walking distance of a Starbucks?',
});

/** Owner-free by design: no public release can report this criterion as supported. */
const ownerFreeBlockedCriterion = 'ownership_age';
const localBlockedLimitation =
  'The accepted public snapshot contains no redistributable ownership-transfer evidence.';

type ReleaseCapability = Readonly<{
  criterion: string;
  state: string;
  limitations: readonly string[];
}>;

/**
 * Reads the deployed serving config so criterion expectations follow the release
 * under test instead of a hardcoded capability matrix.
 */
async function releaseCapabilities(
  request: APIRequestContext,
): Promise<readonly ReleaseCapability[]> {
  const { publicArtifactBaseURL } = evaluatorTargetConfiguration();
  const response = await request.get(`${publicArtifactBaseURL}/serving-config.json`);
  expect(response.status(), 'The deployed serving config must be publicly readable.').toBe(200);
  const capabilities = asRecord(asRecord((await response.json()) as unknown)?.capabilities);
  expect(
    capabilities,
    'The deployed serving config must publish per-criterion capabilities.',
  ).not.toBeNull();
  return Object.freeze(
    Object.entries(capabilities ?? {}).flatMap(([criterion, value]) => {
      const capability = asRecord(value);
      const state = capability?.state;
      return typeof state === 'string' && state.length > 0
        ? [
            Object.freeze({
              criterion,
              state,
              limitations: stringItems(capability?.limitations),
            }),
          ]
        : [];
    }),
  );
}

async function askAgent(
  page: Page,
  prompt: string,
): Promise<Readonly<{ response: Response; body: unknown }>> {
  await openEvaluatorRoute(page, '/agent');
  await page.getByRole('textbox', { name: /ask|prompt|question/i }).fill(prompt);
  const responsePromise = operationResponse(
    page,
    'agent.ask',
    isHostedTarget() ? HOSTED_AGENT_RESPONSE_TIMEOUT_MS : undefined,
  );
  await page.getByRole('button', { name: /ask|run/i }).click();
  const response = await responsePromise;
  return { response, body: (await response.json()) as unknown };
}

async function expectReturnedCapabilityEnvelope(page: Page, body: unknown): Promise<void> {
  const envelope = asRecord(body);
  const capability = capabilityFrom(body);
  expect(capability, 'An empty response must return an explicit capability.').not.toBeNull();
  const state = capability?.state;
  expect(typeof state === 'string' && state.length > 0).toBe(true);
  const limitations = [
    ...stringItems(envelope?.limitations),
    ...stringItems(capability?.limitations),
  ];
  expect(
    limitations.length,
    'An empty response must return a concrete limitation.',
  ).toBeGreaterThan(0);

  const capabilityRegion = page.getByRole('region', { name: 'Returned capability' });
  await expect(capabilityRegion).toBeVisible();
  await expect(capabilityRegion).toContainText(new RegExp(String(state), 'i'));
  const limitationRegion = page.getByRole('complementary', {
    name: 'Query metadata and limitations',
  });
  await expect(limitationRegion).toContainText(limitations[0] ?? '');
}

async function installLocalOperationFixture(
  page: Page,
  operation: string,
  data: JsonRecord,
  limitations: readonly string[] = ['Deterministic browser fixture; never production county data.'],
): Promise<void> {
  if (isHostedTarget()) return;
  await page.route('**/*', async (route) => {
    const request = route.request();
    const pathname = decodeURIComponent(new URL(request.url()).pathname).replace(/\/+$/u, '');
    if (request.method() !== 'POST' || !pathname.endsWith(`/${operation}`)) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        'x-oracle-fixture': 'TEST_ONLY_DETERMINISTIC_FIXTURE',
      },
      body: JSON.stringify({
        schemaVersion: '1.0.0',
        releaseId: FIXTURE_RELEASE_ID,
        runId: FIXTURE_RUN_ID,
        manifestCid: FIXTURE_MANIFEST_CID,
        asOf: '2026-07-17T00:00:00.000Z',
        coverage: {},
        limitations: [...limitations],
        data,
        nextCursor: null,
        truncated: false,
        timing: { elapsedMs: 3, bytesScanned: 1024 },
      }),
    });
  });
}

test.beforeEach(async ({ page }) => {
  fixture = await prepareEvaluatorPage(page);
});

test('property search opens release-bound detail and source evidence', async ({ page }) => {
  const initialResponsePromise = operationResponse(page, 'property.search');
  await openEvaluatorRoute(page, '/properties');
  await initialResponsePromise;
  const search = page.getByRole('searchbox', { name: /search propert/i });
  await search.fill('Hamilton');
  const responsePromise = operationResponse(page, 'property.search');
  await page.getByRole('button', { name: /apply filters/i }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const body: unknown = await response.json();

  const result = page.locator('a[href^="/properties/"]').first();
  if (isHostedTarget() && responseRows(body).length === 0) {
    await expectReturnedCapabilityEnvelope(page, body);
    await expect(result).toHaveCount(0);
    await expectReleaseIdentity(page);
    return;
  }
  await expect(result).toBeVisible();
  if (!isHostedTarget()) {
    await expect(page.getByRole('row').filter({ has: result })).toContainText(
      /Hamilton|120-34-056/i,
    );
  }
  await result.click();
  await expect(page).toHaveURL(/\/properties\/[^/?#]+/u);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expectReleaseIdentity(page);
  await expect(page.getByRole('heading', { name: /sources and assertions/i })).toBeVisible();
  await expect(page.getByText(truthLabelPattern).first()).toBeVisible();
  if (!isHostedTarget()) {
    await expect(page.locator('main')).toContainText(FIXTURE_PROPERTY_ID);
    await expect(page.locator('main')).toContainText(FIXTURE_EVIDENCE_ID);
  }
});

test('every inquiry can execute with URL-addressable parameters', async ({ page }) => {
  for (const route of inquiryRoutes) {
    const operation = inquiryOperationByPath[route.path];
    if (operation === undefined) throw new Error(`No operation is mapped for ${route.path}.`);
    const initialResponsePromise = operationResponse(page, operation);
    await openEvaluatorRoute(page, route.path);
    const response = await initialResponsePromise;
    const run = page.getByRole('button', { name: /run|apply|search/i });
    await expect(run).toBeVisible();
    await run.click();
    expect(response.status()).toBe(200);
    const body: unknown = await response.json();
    await expectReleaseIdentity(page);
    if (isHostedTarget() && responseRows(body).length === 0) {
      await expectReturnedCapabilityEnvelope(page, body);
      await expect(page.locator('a[href^="/properties/"]')).toHaveCount(0);
    } else {
      await expect(page.getByText(truthLabelPattern).first()).toBeVisible();
      await expect(page.locator('a[href^="/properties/"]').first()).toBeVisible();
    }
  }
});

test('combined ranking exposes deterministic components rather than an opaque AI score', async ({
  page,
}) => {
  await installLocalOperationFixture(page, 'inquiry.rankCandidates', {
    capability: {
      state: 'supported',
      supportClasses: ['supported'],
      numerator: 1,
      denominator: 1,
      limitations: ['Deterministic component fixture.'],
    },
    results: [
      {
        propertyId: FIXTURE_PROPERTY_ID,
        parcelIdentifier: '120-34-056',
        addressStreet: '250 Hamilton Avenue',
        addressCity: 'Palo Alto',
        addressZip: '94301',
        supportClass: 'supported',
        value: {
          rank: 1,
          score: 0.82,
          evidenceCoverage: 1,
          components: [
            {
              criterion: 'roof_age',
              supportClass: 'supported',
              normalizedValue: 0.8,
              weight: 0.5,
              proxyMultiplier: 0.5,
              contribution: 0.4,
            },
          ],
        },
        evidence: [],
        limitations: [],
      },
    ],
    resultCount: 1,
  });
  const initialResponsePromise = operationResponse(page, 'inquiry.rankCandidates');
  await openEvaluatorRoute(page, '/rankings');
  const response = await initialResponsePromise;
  const run = page.getByRole('button', { name: /rank|run/i });
  await run.click();
  await expect(page).toHaveURL(/\?[^#]+$/u);
  expect(response.status()).toBe(200);
  const body: unknown = await response.json();
  if (isHostedTarget() && responseRows(body).length === 0) {
    await expectReturnedCapabilityEnvelope(page, body);
    await expect(page.getByRole('region', { name: 'Returned ranking components' })).toHaveCount(0);
    await expectReleaseIdentity(page);
    return;
  }
  const firstRow = asRecord(responseRows(body)[0]);
  const components = asRecord(firstRow?.value)?.components;
  expect(Array.isArray(components) && components.length > 0).toBe(true);
  const firstComponent = asRecord(Array.isArray(components) ? components[0] : null);
  const criterion = firstComponent?.criterion;
  const contribution = firstComponent?.contribution;
  expect(typeof criterion).toBe('string');
  expect(typeof contribution).toBe('number');

  const componentRegion = page.getByRole('region', { name: 'Returned ranking components' });
  await expect(componentRegion).toBeVisible();
  const componentTable = componentRegion.getByRole('table', {
    name: `Ranking components for ${String(firstRow?.propertyId)}`,
  });
  await expect(componentTable).toBeVisible();
  await expect(componentTable.getByRole('columnheader', { name: 'Contribution' })).toBeVisible();
  await expect(componentTable).toContainText(String(criterion));
  await expect(componentTable).toContainText(String(contribution));
  await expect(page.getByText(truthLabelPattern).first()).toBeVisible();
  await expectReleaseIdentity(page);
});

test('invalid inquiry parameters are rejected without a query claim', async ({ page }) => {
  await openEvaluatorRoute(page, '/inquiries/roof-age?minimumAgeYears=-1');
  const invalidInput = page.getByRole('spinbutton', { name: /minimum.*age|roof.*age/i });
  await expect(invalidInput).toBeVisible();
  expect(
    await invalidInput.evaluate(
      (element) => element instanceof HTMLInputElement && !element.checkValidity(),
    ),
  ).toBe(true);
  await expect(page.getByRole('alert')).toContainText(/request|valid|between|minimum|greater/i);
  await expect(page.locator('a[href^="/properties/"]')).toHaveCount(0);
});

function traceToolNames(data: JsonRecord | null): readonly string[] {
  return Array.isArray(data?.toolCalls)
    ? data.toolCalls.flatMap((value) => {
        const call = asRecord(value);
        const name = call?.toolName ?? call?.name;
        return typeof name === 'string' ? [name] : [];
      })
    : [];
}

test('agent shows named-tool trace and exact citations for a release-supported criterion', async ({
  page,
  request,
}) => {
  let criterion = 'roof_age';
  if (isHostedTarget()) {
    // A criterion reaches 'supported' only at 100% field coverage; any real
    // bounded release lands on 'partial'. Filtering to 'supported' alone meant
    // this test skipped itself on every release it was written to certify, so
    // the suite reported green having proven nothing - while the README lists a
    // cited agent answer as a mandatory acceptance proof.
    //
    // 'partial' still carries genuine evidence: the criterion is answerable for
    // the rows that have it, which is exactly what a cited answer demonstrates.
    const answerable = (await releaseCapabilities(request)).filter(
      (capability) =>
        (capability.state === 'supported' || capability.state === 'partial') &&
        criterionPrompts[capability.criterion] !== undefined,
    );
    // Deliberately FAIL rather than skip. A release that can answer no criterion
    // at all cannot satisfy the acceptance requirement, and silently skipping
    // turns that into a false green.
    expect(
      answerable.length,
      'The deployed serving config reports no supported or partial criterion, so no cited agent answer is possible on this release. This is an acceptance failure, not a skip.',
    ).toBeGreaterThan(0);
    criterion = answerable[0]?.criterion ?? criterion;
  }
  const prompt = criterionPrompts[criterion];
  if (prompt === undefined) throw new Error(`No agent prompt is mapped for ${criterion}.`);

  const { response, body } = await askAgent(page, prompt);
  expect(response.status()).toBe(200);
  const data = asRecord(asRecord(body)?.data);
  const citations = stringItems(data?.citations);
  const toolNames = traceToolNames(data);
  expect(
    citations.length,
    `${criterion} is supported, so it must return evidence citations.`,
  ).toBeGreaterThan(0);
  expect(toolNames.length).toBeGreaterThan(0);
  await expect(page.getByRole('heading', { name: /tool.*trace|trace/i })).toBeVisible();
  await expect(page.getByText(toolNames[0] ?? '', { exact: false }).first()).toBeVisible();
  await expect(page.getByText(citations[0] ?? '', { exact: false }).first()).toBeVisible();
  await expectReleaseIdentity(page);
});

test('agent tells the truth about a blocked criterion instead of failing the request', async ({
  page,
  request,
}) => {
  let blockedLimitation = localBlockedLimitation;
  if (isHostedTarget()) {
    const blocked = (await releaseCapabilities(request)).find(
      (capability) => capability.criterion === ownerFreeBlockedCriterion,
    );
    expect(
      blocked,
      `${ownerFreeBlockedCriterion} must appear in the deployed serving config.`,
    ).toBeDefined();
    expect(
      blocked?.state,
      `${ownerFreeBlockedCriterion} is owner-free blocked by design in every public release.`,
    ).toBe('blocked');
    blockedLimitation = blocked?.limitations[0] ?? '';
    expect(
      blockedLimitation.length,
      'A blocked criterion must publish a concrete limitation.',
    ).toBeGreaterThan(0);
  } else {
    await installLocalOperationFixture(
      page,
      'agent.ask',
      {
        status: 'complete',
        answer:
          'No proven matching properties were found in the bounded primary candidate page. This result is not county-exhaustive.',
        citations: [],
        toolCalls: [
          {
            callIndex: 1,
            toolName: 'find_roof_age_candidates',
            releaseId: FIXTURE_RELEASE_ID,
            evidenceIds: [],
          },
          {
            callIndex: 2,
            toolName: 'find_ownership_age_candidates',
            releaseId: FIXTURE_RELEASE_ID,
            evidenceIds: [],
          },
        ],
      },
      [blockedLimitation],
    );
  }

  const { response, body } = await askAgent(
    page,
    'Which properties have roofs older than 15 years and have not exchanged ownership in more than 10 years?',
  );
  expect(response.status(), 'A blocked criterion must answer honestly, not fail.').toBe(200);
  const envelope = asRecord(body);
  const data = asRecord(envelope?.data);
  expect(
    stringItems(data?.citations),
    'A blocked criterion cannot produce evidence citations.',
  ).toHaveLength(0);
  expect(Array.isArray(data?.citations)).toBe(true);
  expect(String(data?.answer)).toMatch(/no proven matching properties/iu);
  expect(traceToolNames(data).length).toBeGreaterThan(0);
  expect(
    stringItems(envelope?.limitations),
    'The blocked criterion must be named in the returned limitations.',
  ).toContain(blockedLimitation);

  await expect(page.getByText(/no proven matching properties/i).first()).toBeVisible();
  await expect(page.getByText('No evidence citation was returned.')).toBeVisible();
  await expect(
    page.getByRole('complementary', { name: 'Query metadata and limitations' }),
  ).toContainText(blockedLimitation);
  await expectReleaseIdentity(page);
});

test('agent degradation is explicit and never replaced with a canned answer', async ({ page }) => {
  if (isHostedTarget()) {
    const statusResponsePromise = operationResponse(page, 'agent.status');
    await openEvaluatorRoute(page, '/agent');
    const statusResponse = await statusResponsePromise;
    expect(statusResponse.status()).toBe(200);
    const body: unknown = await statusResponse.json();
    const status = asRecord(asRecord(body)?.data);
    expect(status?.status).toBe('available');
    const modelProfile = status?.modelProfileId ?? status?.modelProfile ?? status?.model;
    expect(typeof modelProfile === 'string' && modelProfile.length > 0).toBe(true);
    await expect(page.getByText(String(modelProfile), { exact: false }).first()).toBeVisible();
    await expect(page.locator('main')).toContainText(/no silent fallback|no fallback/i);
    await expect(
      page.getByRole('alert').filter({ hasText: /agent.*unavailable|degraded/i }),
    ).toHaveCount(0);
    return;
  }
  if (fixture === null) throw new Error('The deterministic local fixture controller is missing.');
  fixture.setMode('agent-degraded');
  await openEvaluatorRoute(page, '/agent');
  const prompt = page.getByRole('textbox', { name: /ask|prompt|question/i });
  await expect(prompt).toBeDisabled();
  await expect(page.getByRole('button', { name: /ask|run/i })).toBeDisabled();
  const degradedAlert = page
    .getByRole('alert')
    .filter({ hasText: /selected model profile is unavailable|no fallback answer was generated/i });
  await expect(degradedAlert).toHaveCount(1);
  await expect(degradedAlert).toContainText(/unavailable|no fallback/i);
  await expect(page.getByRole('heading', { name: /answer|tool trace/i })).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('The deterministic tool returned');
});

test('artifacts, data dictionary, capabilities, and MCP setup remain read-only and release-bound', async ({
  page,
}) => {
  await openEvaluatorRoute(page, '/artifacts');
  await expect(page.getByText(/CID|content identifier|checksum/i).first()).toBeVisible();
  await expectReleaseIdentity(page);

  await installLocalOperationFixture(page, 'artifacts.getDataDictionary', {
    items: [
      {
        relation_name: 'property_query',
        column_name: 'property_id',
        duckdb_type: 'VARCHAR',
      },
    ],
  });
  const dictionaryResponsePromise = operationResponse(page, 'artifacts.getDataDictionary');
  await openEvaluatorRoute(page, '/dictionary');
  const dictionaryResponse = await dictionaryResponsePromise;
  expect(dictionaryResponse.status()).toBe(200);
  const dictionaryBody: unknown = await dictionaryResponse.json();
  const dictionaryRow = asRecord(responseRows(dictionaryBody)[0]);
  const relationName = dictionaryRow?.relation_name;
  const columnName = dictionaryRow?.column_name;
  const duckdbType = dictionaryRow?.duckdb_type;
  expect(typeof relationName).toBe('string');
  expect(typeof columnName).toBe('string');
  expect(typeof duckdbType).toBe('string');
  const dictionaryTable = page.getByRole('table', { name: 'Release-bound data dictionary' });
  await expect(dictionaryTable).toBeVisible();
  await expect(dictionaryTable).toContainText(String(relationName));
  await expect(dictionaryTable).toContainText(String(columnName));
  await expect(dictionaryTable).toContainText(String(duckdbType));
  await expectReleaseIdentity(page);

  await openEvaluatorRoute(page, '/capabilities');
  await expect(page.getByText(truthLabelPattern).first()).toBeVisible();
  await expectReleaseIdentity(page);

  await openEvaluatorRoute(page, '/mcp');
  await expect(page.locator('main')).toContainText(/read-only|SQL-free/i);
  await expect(page.locator('main')).toContainText(/get_dataset_info|search_properties/i);
  await expectReleaseIdentity(page);
});
