import { expect, test } from '@playwright/test';

import { openEvaluatorRoute, prepareEvaluatorPage } from '../support/page.js';

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
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/properties(?:[?#]|$)/u);

  const search = page.getByRole('searchbox', { name: /search propert/i });
  await search.focus();
  await search.fill('Hamilton');
  await search.press('Enter');
  const result = page.locator('a[href^="/properties/"]').first();
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
