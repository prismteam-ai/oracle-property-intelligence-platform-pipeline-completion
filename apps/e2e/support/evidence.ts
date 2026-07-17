import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { expect, type Page, type TestInfo } from '@playwright/test';

type AxeViolation = Readonly<{
  id: string;
  impact: string | null;
  nodes: readonly unknown[];
}>;

type AxeResult = Readonly<{ violations: readonly AxeViolation[] }>;

export async function captureOptionalScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  if (process.env.ORACLE_E2E_SCREENSHOTS !== '1') return;
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
}

export async function runOptionalAxe(page: Page): Promise<boolean> {
  const scriptPath = process.env.ORACLE_E2E_AXE_SCRIPT_PATH;
  if (scriptPath === undefined) return false;
  if (!isAbsolute(scriptPath) || !existsSync(scriptPath)) {
    throw new Error('ORACLE_E2E_AXE_SCRIPT_PATH must be an existing absolute local file.');
  }
  await page.addScriptTag({ path: scriptPath });
  const result = await page.evaluate(async (): Promise<AxeResult> => {
    const axe = (globalThis as unknown as { axe?: { run(): Promise<AxeResult> } }).axe;
    if (axe === undefined)
      throw new Error('The supplied axe script did not expose globalThis.axe.');
    return await axe.run();
  });
  const serious = result.violations.filter(
    ({ impact }) => impact === 'serious' || impact === 'critical',
  );
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
  return true;
}
