import type { Page } from '@playwright/test';

import { installDeterministicApiFixture, type FixtureController } from './fixture.js';
import { isHostedTarget } from './target.js';

export async function prepareEvaluatorPage(page: Page): Promise<FixtureController | null> {
  const fixture = isHostedTarget() ? null : await installDeterministicApiFixture(page);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  return fixture;
}

export async function openEvaluatorRoute(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.locator('main').waitFor({ state: 'visible' });
  await page.evaluate(async () => await document.fonts.ready);
}
