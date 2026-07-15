#!/usr/bin/env node
/**
 * Record a short local demo walkthrough for the PR.
 * Usage: node record.mjs [baseUrl] [outputDir]
 */
import { chromium } from "playwright";
import { mkdir, rename, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..", "..");
const baseUrl = (process.argv[2] || "http://127.0.0.1:3000").replace(/\/$/, "");
const outputDir = process.argv[3] || join(projectRoot, "demo");
const videoDir = join(outputDir, ".capture");

const scenes = [
  {
    title: "Oracle Property Intelligence — Santa Clara County",
    path: "/",
    pauseMs: 3500,
    action: async (page) => {
      await page.waitForSelector(".stat-value", { timeout: 15000 });
    },
  },
  {
    title: "Pipeline run summary — 6 source types loaded",
    path: "/run",
    pauseMs: 4000,
  },
  {
    title: "IPFS artifacts — no Oracle-hosted database",
    path: "/about",
    pauseMs: 3500,
  },
  {
    title: "Interactive sandbox — roofs older than 15 years",
    path: "/sandbox?preset=roofs",
    pauseMs: 2500,
    action: async (page) => {
      await page.waitForSelector("#result-meta", { timeout: 15000 });
      const slider = page.locator("#min_roof_age");
      if (await slider.count()) {
        await slider.evaluate((el) => {
          el.value = "25";
          el.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await page.waitForTimeout(2000);
      }
    },
  },
  {
    title: "Transit distance filter — Palo Alto",
    path: "/sandbox?preset=transit",
    pauseMs: 2000,
    action: async (page) => {
      await page.waitForSelector("#city", { timeout: 10000 });
      await page.fill("#city", "PALO ALTO");
      await page.waitForTimeout(2500);
      const slider = page.locator("#max_transit_m");
      if (await slider.count()) {
        await slider.evaluate((el) => {
          el.value = "400";
          el.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await page.waitForTimeout(2500);
      }
    },
  },
  {
    title: "README demo questions — source-backed answers",
    path: "/explore",
    pauseMs: 3500,
  },
  {
    title: "MCP agent prompts — query via Cursor",
    path: "/ask",
    pauseMs: 3500,
  },
];

async function showTitle(page, text) {
  await page.evaluate((title) => {
    let el = document.getElementById("demo-title-overlay");
    if (!el) {
      el = document.createElement("div");
      el.id = "demo-title-overlay";
      Object.assign(el.style, {
        position: "fixed",
        left: "0",
        right: "0",
        bottom: "24px",
        margin: "0 auto",
        width: "max-content",
        maxWidth: "90vw",
        padding: "12px 20px",
        background: "rgba(15, 20, 25, 0.92)",
        color: "#e8edf4",
        border: "1px solid #3b82f6",
        borderRadius: "10px",
        fontFamily: "system-ui, sans-serif",
        fontSize: "15px",
        fontWeight: "600",
        zIndex: "99999",
        boxShadow: "0 8px 32px rgba(0,0,0,0.45)",
      });
      document.body.appendChild(el);
    }
    el.textContent = title;
  }, text);
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  await mkdir(videoDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    recordVideo: {
      dir: videoDir,
      size: { width: 1366, height: 768 },
    },
  });
  const page = await context.newPage();

  for (const scene of scenes) {
    await page.goto(`${baseUrl}${scene.path}`, { waitUntil: "networkidle" });
    await showTitle(page, scene.title);
    if (scene.action) {
      await scene.action(page);
    }
    await page.waitForTimeout(scene.pauseMs);
  }

  const video = page.video();
  await context.close();
  await browser.close();

  if (!video) {
    throw new Error("No video captured");
  }

  const tempPath = await video.path();
  const finalPath = join(outputDir, "oracle-property-intelligence-demo.webm");
  await rename(tempPath, finalPath);

  const files = await readdir(videoDir);
  console.log(`Wrote ${finalPath}`);
  if (files.length) {
    console.log(`Extra capture files in ${videoDir}: ${files.join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
