#!/usr/bin/env node
/**
 * Record Indeedee UI demo video (WebM) with Playwright.
 * Usage: node scripts/record-ui-demo.mjs
 * Requires: API running on PORT (default 8787) with INDEEDEE_SECRETS_KEY set for demo seed.
 */
import { mkdirSync, renameSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const demoDir = join(root, "demo");
const port = process.env.PORT ?? "8787";
const baseUrl = process.env.API_BASE_URL ?? `http://127.0.0.1:${port}`;
const outFile = join(demoDir, "indeedee-chief-of-staff-demo.webm");

mkdirSync(demoDir, { recursive: true });

async function pause(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function closeModal(page) {
  const overlay = page.locator("#dt-overlay");
  if (await overlay.isVisible()) {
    await page.locator("#dt-card button.x").click({ timeout: 3000 }).catch(async () => {
      await page.evaluate(() => {
        if (typeof closeDetail === "function") closeDetail();
      });
    });
    await overlay.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  }
  await pause(400);
}

async function clickTab(page, name) {
  await page.locator(`#nav button[data-tab="${name}"]`).click();
  await pause(900);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: demoDir, size: { width: 1280, height: 800 } },
    colorScheme: "light",
  });
  const page = await context.newPage();

  console.log(`Recording Indeedee UI at ${baseUrl}`);

  await page.addInitScript(() => localStorage.setItem("indeedee_role", "owner"));
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("#app-main").waitFor({ state: "visible", timeout: 15_000 });
  await pause(1200);

  // One-click demo: connect channels + sync + run agents
  await page.locator("button:has-text('Demo channels')").click();
  await page.waitForFunction(
    () => {
      const b = document.getElementById("banner");
      return b && b.style.display !== "none" && /Synced|connected/i.test(b.textContent || "");
    },
    { timeout: 120_000 },
  );
  await pause(1800);

  await page.locator("#tiles .tile").first().waitFor({ state: "visible", timeout: 30_000 });
  await pause(2000);

  await clickTab(page, "incoming");
  await page.locator(".kcard").first().waitFor({ state: "visible", timeout: 20_000 });
  await page.locator(".kcard").first().click();
  await pause(1800);
  await closeModal(page);

  await clickTab(page, "people");
  await page.locator(".prow").first().waitFor({ state: "visible", timeout: 20_000 });
  await page.locator(".prow").first().click();
  await pause(2200);

  await clickTab(page, "approvals");
  await page.locator(".approval-card").first().waitFor({ state: "visible", timeout: 20_000 });
  await pause(2500);

  await clickTab(page, "connections");
  await pause(2200);

  await clickTab(page, "mcp");
  await pause(1800);

  await clickTab(page, "dashboard");
  await pause(2000);

  const video = page.video();
  await context.close();
  await browser.close();

  if (!video) {
    console.error("No video recorded");
    process.exit(1);
  }

  const rawPath = await video.path();
  try {
    unlinkSync(outFile);
  } catch {
    /* fresh */
  }
  renameSync(rawPath, outFile);
  for (const f of readdirSync(demoDir)) {
    if (f.endsWith(".webm") && f !== "indeedee-chief-of-staff-demo.webm" && !f.includes("voiced")) {
      try {
        unlinkSync(join(demoDir, f));
      } catch {
        /* ignore */
      }
    }
  }
  console.log(`Saved ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
