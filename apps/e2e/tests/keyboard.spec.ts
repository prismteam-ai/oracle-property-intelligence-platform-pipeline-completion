import { expect, test, type Page, type Response } from '@playwright/test';

import { expectReleaseIdentity } from '../support/assertions.js';
import { openEvaluatorRoute, prepareEvaluatorPage } from '../support/page.js';
import { isHostedTarget } from '../support/target.js';

type JsonRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function waitForPropertySearch(page: Page): Promise<Response> {
  return page.waitForResponse((response) => {
    const pathname = decodeURIComponent(new URL(response.url()).pathname).replace(/\/+$/u, '');
    return response.request().method() === 'POST' && pathname.endsWith('/property.search');
  });
}

function responseRows(body: unknown): readonly unknown[] {
  const data = asRecord(body)?.data;
  if (Array.isArray(data)) return data;
  const record = asRecord(data);
  if (record === null) return [];
  for (const key of ['results', 'items', 'properties']) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

test.beforeEach(async ({ page }) => {
  await prepareEvaluatorPage(page);
});

test('skip link, navigation, and property search are keyboard complete with visible focus', async ({
  page,
}) => {
  await openEvaluatorRoute(page, '/');
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  const skipLink = page.getByRole('link', { name: /skip to (?:main )?content/i });
  await skipLink.focus();
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeVisible();
  const focusStyle = await skipLink.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outline: style.outlineStyle, width: style.outlineWidth, shadow: style.boxShadow };
  });
  expect(
    focusStyle.outline !== 'none' || focusStyle.width !== '0px' || focusStyle.shadow !== 'none',
  ).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();

  const properties = page.getByRole('link', { name: /^Properties$/i }).first();
  await properties.focus();
  const initialSearchResponse = waitForPropertySearch(page);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/properties(?:[?#]|$)/u);
  await initialSearchResponse;

  const search = page.getByRole('searchbox', { name: /search propert/i });
  await search.focus();
  await search.fill('Hamilton');
  const responsePromise = waitForPropertySearch(page);
  await search.press('Enter');
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const body: unknown = await response.json();
  const result = page.locator('a[href^="/properties/"]').first();
  if (isHostedTarget() && responseRows(body).length === 0) {
    const envelope = asRecord(body);
    const directCapability = asRecord(asRecord(envelope?.data)?.capability);
    const coverage = asRecord(envelope?.coverage);
    const capability =
      directCapability ??
      Object.values(coverage ?? {})
        .map((value) => asRecord(value))
        .find((value) => value !== null && typeof value.state === 'string');
    expect(capability, 'An empty keyboard search must return capability context.').toBeDefined();
    const limitations = Array.isArray(envelope?.limitations)
      ? envelope.limitations.filter((value): value is string => typeof value === 'string')
      : [];
    expect(limitations.length).toBeGreaterThan(0);
    await expect(page.getByRole('region', { name: 'Returned capability' })).toBeVisible();
    await expect(
      page.getByRole('complementary', { name: 'Query metadata and limitations' }),
    ).toContainText(limitations[0] ?? '');
    await expect(result).toHaveCount(0);
    await expectReleaseIdentity(page);
    return;
  }
  await expect(result).toBeVisible();
  await result.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/properties\/[^/?#]+/u);
});

test('primary navigation identifies the active route without color alone', async ({ page }) => {
  await openEvaluatorRoute(page, '/coverage');
  const active = page
    .getByRole('link', { name: /coverage/i })
    .filter({ has: page.locator('[aria-current="page"]') });
  if ((await active.count()) === 0) {
    await expect(page.getByRole('link', { name: /coverage/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
  } else {
    await expect(active).toBeVisible();
  }
});
