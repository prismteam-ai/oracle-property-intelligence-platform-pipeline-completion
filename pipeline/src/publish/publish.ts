/**
 * Publish the Parquet artifacts to IPFS via Filebase, so Oracle carries no
 * ongoing hosted-DB cost — the data lives on public IPFS and is range-read by
 * the MCP server and (as a static copy) the UI.
 *
 * Filebase is S3-compatible and pins to IPFS on upload; the PutObject response
 * carries the content's IPFS CID in `x-amz-meta-cid`. We upload each Parquet,
 * capture its CID, and write manifest.json (CIDs + gateway URLs + counts +
 * PROPERTY_QUERY_TABLE_MAP) into the repo and the export dir.
 *
 * Usage:
 *   npm run publish -- --dry-run     # compute CIDs locally (ipfs-only-hash), no upload, no keys
 *   npm run publish                  # upload to Filebase (needs env below)
 *
 * Env for a real publish (see .env.example):
 *   S3_ENDPOINT=https://s3.filebase.io  S3_BUCKET=...  S3_ACCESS_KEY_ID=...  S3_SECRET_ACCESS_KEY=...
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
// @ts-expect-error - ipfs-only-hash ships no types
import Hash from "ipfs-only-hash";
import { exportParquet, EXPORT_DIR } from "./export.js";
import { COUNTY } from "../mcp/query.js";
import { nowIso } from "../lib/http.js";

const GATEWAY = "https://ipfs.filebase.io/ipfs";
const KEY_PREFIX = `query-tables/${COUNTY}`;
const REPO_MANIFEST = fileURLToPath(new URL("../../../manifest.json", import.meta.url));
const EXPORT_MANIFEST = `${EXPORT_DIR}manifest.json`;

interface ArtifactEntry {
  file: string;
  key: string;
  rows: number;
  bytes: number;
  cid: string;
  gateway: string;
}

async function computeCid(path: string): Promise<string> {
  const buf = await readFile(path);
  return Hash.of(buf) as Promise<string>;
}

async function uploadToFilebase(
  s3: S3Client,
  bucket: string,
  key: string,
  path: string,
): Promise<string> {
  const body = await readFile(path);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "application/vnd.apache.parquet",
    }),
  );
  // Filebase pins to IPFS and stores the resulting CID as object metadata.
  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  const cid = head.Metadata?.cid;
  if (!cid) throw new Error(`Filebase did not return a CID for ${key}`);
  return cid;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  console.log("Exporting Parquet...");
  const files = await exportParquet();

  let s3: S3Client | undefined;
  let bucket = "";
  if (!dryRun) {
    const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = process.env;
    if (!S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
      throw new Error(
        "Missing Filebase env: set S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY (and optional S3_ENDPOINT). Or run with --dry-run.",
      );
    }
    bucket = S3_BUCKET;
    s3 = new S3Client({
      endpoint: S3_ENDPOINT ?? "https://s3.filebase.io",
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
    });
  }

  const artifacts: ArtifactEntry[] = [];
  for (const f of files) {
    const key = `${KEY_PREFIX}/${f.file}`;
    const bytes = (await readFile(f.path)).length;
    const cid =
      dryRun || !s3
        ? await computeCid(f.path)
        : await uploadToFilebase(s3, bucket, key, f.path);
    artifacts.push({ file: f.file, key, rows: f.rows, bytes, cid, gateway: `${GATEWAY}/${cid}` });
    console.log(`  ${dryRun ? "hashed" : "uploaded"} ${f.file} -> ${cid}`);
  }

  const properties = artifacts.find((a) => a.file === "properties.parquet");
  const manifest = {
    generatedAt: nowIso(),
    county: COUNTY,
    focus: "Palo Alto",
    provider: dryRun ? "local-hash (dry-run)" : "Filebase (IPFS)",
    artifacts,
    propertyQueryTableMap: properties
      ? { [COUNTY]: properties.gateway }
      : {},
    note: "Parquet artifacts pinned to public IPFS; no Oracle-hosted database. The MCP server range-reads properties.parquet directly from the gateway URL above.",
  };

  const json = JSON.stringify(manifest, null, 2);
  await writeFile(REPO_MANIFEST, json, "utf8");
  await writeFile(EXPORT_MANIFEST, json, "utf8");
  console.log(`\nWrote manifest.json (repo + export). PROPERTY_QUERY_TABLE_MAP:`);
  console.log(JSON.stringify(manifest.propertyQueryTableMap));
  if (dryRun) console.log("\n(dry-run: CIDs computed locally; nothing uploaded)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
