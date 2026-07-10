#!/usr/bin/env node
/**
 * Fetch the query dataset from cloud object storage into web/public/data/.
 *
 * The parquet is NOT committed to the repo — it lives in a bucket (Filebase /
 * IPFS by default, published by the pipeline). This script downloads it so the
 * app can serve it statically. Runs in the Docker build and can be run locally
 * before `npm run dev`.
 *
 * Override the source with DATA_URL (e.g. a Google Cloud Storage public URL):
 *   DATA_URL="https://storage.googleapis.com/<bucket>/properties.parquet" node scripts/fetch-data.mjs
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dataDir = fileURLToPath(new URL("../public/data/", import.meta.url));
const out = `${dataDir}properties.parquet`;

// Primary source: Google Cloud Storage (public bucket). Falls back to the
// IPFS/Filebase gateway from manifest.json. Override with DATA_URL.
const GCS_URL =
  "https://storage.googleapis.com/dmitriy-konyrev-oracle-property/properties.parquet";

async function resolveUrl() {
  if (process.env.DATA_URL) return process.env.DATA_URL;
  return GCS_URL;
}

async function ipfsFallback() {
  try {
    const manifest = JSON.parse(await readFile(`${dataDir}manifest.json`, "utf8"));
    const art = (manifest.artifacts ?? []).find((a) => a.file === "properties.parquet");
    return art?.gateway ?? null;
  } catch {
    return null;
  }
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.subarray(0, 4).toString("ascii") !== "PAR1") {
    throw new Error("not a valid Parquet (missing PAR1 magic)");
  }
  return buf;
}

async function main() {
  await mkdir(dataDir, { recursive: true });
  const primary = await resolveUrl();
  let buf;
  try {
    process.stdout.write(`Fetching properties.parquet from ${primary} ... `);
    buf = await download(primary);
  } catch (e) {
    console.log(`failed (${e.message})`);
    const fb = await ipfsFallback();
    if (!fb) throw new Error("primary failed and no IPFS fallback available");
    process.stdout.write(`Falling back to IPFS ${fb} ... `);
    buf = await download(fb);
  }
  await writeFile(out, buf);
  console.log(`ok (${(buf.length / 1024).toFixed(0)} KB)`);
}

main().catch((e) => {
  console.error(`\nfetch-data failed: ${e.message}`);
  process.exit(1);
});
