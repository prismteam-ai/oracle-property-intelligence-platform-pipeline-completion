import { expect, type Locator, type Page } from '@playwright/test';

import { FIXTURE_RELEASE_ID } from './fixture.js';
import { isHostedTarget } from './target.js';

export const truthLabelPattern =
  /Supported — direct evidence|Supported — derived evidence|Proxy — review required|Partial coverage|Blocked — source\/access|Unsupported|Evidence unknown/i;

export async function expectReleaseIdentity(page: Page): Promise<Locator> {
  const release = page.locator('[data-release-id], [data-testid="release-id"]').first();
  await expect(release).toBeVisible();
  const text = (await release.textContent()) ?? '';
  expect(text.trim().length).toBeGreaterThan(0);
  if (!isHostedTarget()) await expect(release).toContainText(FIXTURE_RELEASE_ID);
  return release;
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    return Math.max(root.scrollWidth - root.clientWidth, body.scrollWidth - body.clientWidth);
  });
  expect(overflow).toBeLessThanOrEqual(1);
}

export async function expectTouchTargets(page: Page): Promise<void> {
  const undersized = await page
    .locator('button, input, select, textarea, [role="button"]')
    .evaluateAll((elements) =>
      elements.flatMap((element) => {
        const effectiveTarget =
          element instanceof HTMLInputElement && element.closest('label') !== null
            ? element.closest('label')
            : element;
        if (effectiveTarget === null) return [];
        const rectangle = effectiveTarget.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          rectangle.width === 0 ||
          rectangle.height === 0 ||
          (element instanceof HTMLInputElement && element.type === 'hidden')
        ) {
          return [];
        }
        return rectangle.width + 0.5 < 44 || rectangle.height + 0.5 < 44
          ? [
              {
                tag: element.tagName.toLowerCase(),
                name: element.getAttribute('aria-label') ?? element.textContent.trim(),
                width: Math.round(rectangle.width),
                height: Math.round(rectangle.height),
              },
            ]
          : [];
      }),
    );
  expect(undersized, JSON.stringify(undersized, null, 2)).toEqual([]);
}

function durationInSeconds(value: string): number {
  return Math.max(
    ...value.split(',').map((entry) => {
      const trimmed = entry.trim();
      return trimmed.endsWith('ms')
        ? Number.parseFloat(trimmed) / 1000
        : Number.parseFloat(trimmed);
    }),
  );
}

export async function expectReducedMotion(page: Page): Promise<void> {
  const state = await page.evaluate(() => ({
    preferred: matchMedia('(prefers-reduced-motion: reduce)').matches,
    styles: [...document.querySelectorAll('*')].flatMap((element) => {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return [];
      return [
        {
          tag: element.tagName.toLowerCase(),
          animationDuration: style.animationDuration,
          transitionDuration: style.transitionDuration,
        },
      ];
    }),
  }));
  expect(state.preferred).toBe(true);
  const offenders = state.styles.filter(
    ({ animationDuration, transitionDuration }) =>
      durationInSeconds(animationDuration) > 0.2 || durationInSeconds(transitionDuration) > 0.2,
  );
  expect(offenders, JSON.stringify(offenders.slice(0, 20), null, 2)).toEqual([]);
}
