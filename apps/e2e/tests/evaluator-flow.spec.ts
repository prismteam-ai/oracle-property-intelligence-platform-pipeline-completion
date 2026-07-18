import { expect, test, type Page, type Response } from '@playwright/test';

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
import { isHostedTarget } from '../support/target.js';

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
        limitations: ['Deterministic browser fixture; never production county data.'],
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

test('agent shows named-tool trace and exact citations when available', async ({ page }) => {
  await openEvaluatorRoute(page, '/agent');
  const prompt = page.getByRole('textbox', { name: /ask|prompt|question/i });
  await prompt.fill(
    'Which properties have roofs older than 15 years and have not exchanged ownership in more than 10 years?',
  );
  const responsePromise = operationResponse(
    page,
    'agent.ask',
    isHostedTarget() ? HOSTED_AGENT_RESPONSE_TIMEOUT_MS : undefined,
  );
  await page.getByRole('button', { name: /ask|run/i }).click();
  const response = await responsePromise;
  const body: unknown = await response.json();
  expect(response.status()).toBe(200);
  const data = asRecord(asRecord(body)?.data);
  const citations = stringItems(data?.citations);
  const toolNames = Array.isArray(data?.toolCalls)
    ? data.toolCalls.flatMap((value) => {
        const call = asRecord(value);
        const name = call?.toolName ?? call?.name;
        return typeof name === 'string' ? [name] : [];
      })
    : [];
  expect(citations.length).toBeGreaterThan(0);
  expect(toolNames.length).toBeGreaterThan(0);
  await expect(page.getByRole('heading', { name: /tool.*trace|trace/i })).toBeVisible();
  await expect(page.getByText(toolNames[0] ?? '', { exact: false }).first()).toBeVisible();
  await expect(page.getByText(citations[0] ?? '', { exact: false }).first()).toBeVisible();
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
