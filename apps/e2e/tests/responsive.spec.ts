import { expect, test } from '@playwright/test';

import {
  expectNoHorizontalOverflow,
  expectReducedMotion,
  expectTouchTargets,
} from '../support/assertions.js';
import { openEvaluatorRoute, prepareEvaluatorPage } from '../support/page.js';
import { evaluatorRoutes } from '../support/routes.js';

test.beforeEach(async ({ page }) => {
  await prepareEvaluatorPage(page);
});

test('every evaluator route remains usable without horizontal overflow', async ({
  page,
}, testInfo) => {
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  for (const route of evaluatorRoutes) {
    await openEvaluatorRoute(page, route.path);
    await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    if ((viewport?.width ?? 0) <= 812) await expectTouchTargets(page);
  }
  testInfo.annotations.push({
    type: 'viewport',
    description: `${viewport?.width ?? 0}x${viewport?.height ?? 0}`,
  });
});

test('reduced-motion preference bounds transitions and animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openEvaluatorRoute(page, '/');
  await expectReducedMotion(page);
  await openEvaluatorRoute(page, '/inquiries/water-candidates');
  await expectReducedMotion(page);
});
