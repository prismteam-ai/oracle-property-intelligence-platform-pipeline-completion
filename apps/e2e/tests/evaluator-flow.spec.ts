import { expect, test } from '@playwright/test';

import { expectReleaseIdentity, truthLabelPattern } from '../support/assertions.js';
import {
  FIXTURE_EVIDENCE_ID,
  FIXTURE_PROPERTY_ID,
  type FixtureController,
} from '../support/fixture.js';
import { openEvaluatorRoute, prepareEvaluatorPage } from '../support/page.js';
import { inquiryRoutes } from '../support/routes.js';
import { isHostedTarget } from '../support/target.js';

let fixture: FixtureController | null;

test.beforeEach(async ({ page }) => {
  fixture = await prepareEvaluatorPage(page);
});

test('property search opens release-bound detail and source evidence', async ({ page }) => {
  await openEvaluatorRoute(page, '/properties');
  const search = page.getByRole('searchbox', { name: /search propert/i });
  await search.fill('Hamilton');
  await page.getByRole('button', { name: /apply filters/i }).click();

  const result = page.locator('a[href^="/properties/"]').first();
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
    await openEvaluatorRoute(page, route.path);
    const run = page.getByRole('button', { name: /run|apply|search/i });
    await expect(run).toBeVisible();
    await run.click();
    await expectReleaseIdentity(page);
    await expect(page.getByText(truthLabelPattern).first()).toBeVisible();
    await expect(page.locator('a[href^="/properties/"]').first()).toBeVisible();
  }
});

test('combined ranking exposes deterministic components rather than an opaque AI score', async ({
  page,
}) => {
  await openEvaluatorRoute(page, '/rankings');
  const run = page.getByRole('button', { name: /rank|run/i });
  await run.click();
  await expect(page.getByText(/component|contribution/i).first()).toBeVisible();
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
  await page.getByRole('button', { name: /ask|run/i }).click();

  const degraded = page.getByRole('alert').filter({ hasText: /unavailable|degraded/i });
  if (isHostedTarget() && (await degraded.isVisible())) {
    await expect(degraded).toContainText(/no fallback|unavailable|degraded/i);
    return;
  }
  await expect(page.getByRole('heading', { name: /tool.*trace|trace/i })).toBeVisible();
  await expect(page.getByText(/rank_review_candidates|find_/i).first()).toBeVisible();
  await expect(page.getByText(/evidence:/i).first()).toBeVisible();
  await expectReleaseIdentity(page);
});

test('agent degradation is explicit and never replaced with a canned answer', async ({ page }) => {
  if (isHostedTarget()) {
    await openEvaluatorRoute(page, '/agent');
    await expect(page.locator('main')).toContainText(/no silent fallback|no fallback/i);
    const degraded = page.getByRole('alert').filter({ hasText: /agent.*unavailable|degraded/i });
    if (await degraded.isVisible()) await expect(degraded).toContainText(/unavailable|degraded/i);
    return;
  }
  if (fixture === null) throw new Error('The deterministic local fixture controller is missing.');
  fixture.setMode('agent-degraded');
  await openEvaluatorRoute(page, '/agent');
  const prompt = page.getByRole('textbox', { name: /ask|prompt|question/i });
  await prompt.fill('Rank review candidates.');
  await page.getByRole('button', { name: /ask|run/i }).click();
  const degradedAlerts = page
    .getByRole('alert')
    .filter({ hasText: /selected model profile is unavailable|no fallback answer was generated/i });
  await expect(degradedAlerts).toHaveCount(2);
  await expect(degradedAlerts.first()).toContainText(/unavailable|no fallback/i);
  await expect(degradedAlerts.last()).toContainText(/unavailable|no fallback/i);
  await expect(page.locator('main')).not.toContainText('The deterministic tool returned');
});

test('artifacts, data dictionary, capabilities, and MCP setup remain read-only and release-bound', async ({
  page,
}) => {
  await openEvaluatorRoute(page, '/artifacts');
  await expect(page.getByText(/CID|content identifier|checksum/i).first()).toBeVisible();
  await expectReleaseIdentity(page);

  await openEvaluatorRoute(page, '/dictionary');
  await expect(page.getByText(/propertyId|canonical property/i).first()).toBeVisible();
  await expectReleaseIdentity(page);

  await openEvaluatorRoute(page, '/capabilities');
  await expect(page.getByText(truthLabelPattern).first()).toBeVisible();
  await expectReleaseIdentity(page);

  await openEvaluatorRoute(page, '/mcp');
  await expect(page.locator('main')).toContainText(/read-only|SQL-free/i);
  await expect(page.locator('main')).toContainText(/get_dataset_info|search_properties/i);
  await expectReleaseIdentity(page);
});
