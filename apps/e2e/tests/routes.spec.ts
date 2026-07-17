import { expect, test } from '@playwright/test';

import { expectReleaseIdentity, truthLabelPattern } from '../support/assertions.js';
import { captureOptionalScreenshot, runOptionalAxe } from '../support/evidence.js';
import { openEvaluatorRoute, prepareEvaluatorPage } from '../support/page.js';
import { deepLinkRoutes, evaluatorRoutes, inquiryRoutes } from '../support/routes.js';
import { isHostedTarget } from '../support/target.js';

test.beforeEach(async ({ page }) => {
  await prepareEvaluatorPage(page);
});

for (const route of evaluatorRoutes) {
  test(`${route.key} route exposes its release-bound evaluator surface`, async ({
    page,
  }, testInfo) => {
    await openEvaluatorRoute(page, route.path);
    await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible();
    await expect(page.locator('main')).toBeVisible();
    await expectReleaseIdentity(page);
    if (route.path.startsWith('/inquiries/')) {
      await expect(page.getByText(truthLabelPattern).first()).toBeVisible();
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
    await openEvaluatorRoute(page, route.path);
    const release = await expectReleaseIdentity(page);
    releaseIds.add(((await release.textContent()) ?? '').trim());
    await expect(page.getByText(truthLabelPattern).first()).toBeVisible();
  }
  expect(releaseIds.size).toBe(1);
});
