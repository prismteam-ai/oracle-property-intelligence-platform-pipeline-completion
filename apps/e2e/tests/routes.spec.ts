import { expect, test, type Page, type Response } from '@playwright/test';

import { expectReleaseIdentity, truthLabelPattern } from '../support/assertions.js';
import { captureOptionalScreenshot, runOptionalAxe } from '../support/evidence.js';
import { openEvaluatorRoute, prepareEvaluatorPage } from '../support/page.js';
import { deepLinkRoutes, evaluatorRoutes, inquiryRoutes } from '../support/routes.js';
import { isHostedTarget } from '../support/target.js';

const inquiryOperationByPath: Readonly<Record<string, string>> = Object.freeze({
  '/inquiries/roof-age': 'inquiry.roofAge',
  '/inquiries/water-candidates': 'inquiry.waterCandidates',
  '/inquiries/ownership-age': 'inquiry.ownershipAge',
  '/inquiries/regional-owner': 'inquiry.regionalOwner',
  '/inquiries/transit-walkability': 'inquiry.transitWalkability',
  '/inquiries/starbucks-walkability': 'inquiry.starbucksWalkability',
});

type JsonRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function operationResponse(page: Page, operation: string): Promise<Response> {
  return page.waitForResponse((response) => {
    const pathname = decodeURIComponent(new URL(response.url()).pathname).replace(/\/+$/u, '');
    return response.request().method() === 'POST' && pathname.endsWith(`/${operation}`);
  });
}

function responseRows(body: unknown): readonly unknown[] {
  const data = asRecord(body)?.data;
  if (Array.isArray(data)) return data;
  const record = asRecord(data);
  if (record === null) return [];
  for (const key of ['results', 'items']) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

async function expectReturnedInquiryEnvelope(page: Page, body: unknown): Promise<void> {
  const envelope = asRecord(body);
  const capability = asRecord(asRecord(envelope?.data)?.capability);
  expect(capability, 'An empty inquiry must return its capability.').not.toBeNull();
  const state = capability?.state;
  expect(typeof state === 'string' && state.length > 0).toBe(true);
  const limitations = [envelope?.limitations, capability?.limitations].flatMap((value) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [],
  );
  expect(limitations.length, 'An empty inquiry must return a concrete limitation.').toBeGreaterThan(
    0,
  );
  const capabilityRegion = page.getByRole('region', { name: 'Returned capability' });
  await expect(capabilityRegion).toBeVisible();
  await expect(capabilityRegion).toContainText(new RegExp(String(state), 'i'));
  await expect(
    page.getByRole('complementary', { name: 'Query metadata and limitations' }),
  ).toContainText(limitations[0] ?? '');
}

test.beforeEach(async ({ page }) => {
  await prepareEvaluatorPage(page);
});

for (const route of evaluatorRoutes) {
  test(`${route.key} route exposes its release-bound evaluator surface`, async ({
    page,
  }, testInfo) => {
    const operation = inquiryOperationByPath[route.path];
    const responsePromise = operation === undefined ? null : operationResponse(page, operation);
    await openEvaluatorRoute(page, route.path);
    await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible();
    await expect(page.locator('main')).toBeVisible();
    await expectReleaseIdentity(page);
    if (route.path.startsWith('/inquiries/')) {
      if (responsePromise === null) throw new Error(`No operation is mapped for ${route.path}.`);
      const response = await responsePromise;
      expect(response.status()).toBe(200);
      const body: unknown = await response.json();
      if (isHostedTarget() && responseRows(body).length === 0) {
        await expectReturnedInquiryEnvelope(page, body);
      } else {
        await expect(page.getByText(truthLabelPattern).first()).toBeVisible();
      }
    }
    if (isHostedTarget()) {
      await expect(page.locator('body')).not.toContainText('TEST_ONLY_DETERMINISTIC_FIXTURE');
    }
    if (route.path === '/') {
      await captureOptionalScreenshot(page, testInfo, 'overview');
      await runOptionalAxe(page);
    }
  });
}

for (const route of deepLinkRoutes) {
  test(`${route.key} survives a direct deep-link refresh`, async ({ page }) => {
    await openEvaluatorRoute(page, route.path);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(new RegExp(`${route.path.replaceAll('/', '\\/')}(?:[?#]|$)`, 'u'));
    await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible();
    await expectReleaseIdentity(page);
  });
}

test('all six inquiry routes preserve their exact immutable release and truth semantics', async ({
  page,
}) => {
  const releaseIds = new Set<string>();
  for (const route of inquiryRoutes) {
    const operation = inquiryOperationByPath[route.path];
    if (operation === undefined) throw new Error(`No operation is mapped for ${route.path}.`);
    const responsePromise = operationResponse(page, operation);
    await openEvaluatorRoute(page, route.path);
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    const body: unknown = await response.json();
    const release = await expectReleaseIdentity(page);
    releaseIds.add(((await release.textContent()) ?? '').trim());
    if (isHostedTarget() && responseRows(body).length === 0) {
      await expectReturnedInquiryEnvelope(page, body);
    } else {
      await expect(page.getByText(truthLabelPattern).first()).toBeVisible();
    }
  }
  expect(releaseIds.size).toBe(1);
});
