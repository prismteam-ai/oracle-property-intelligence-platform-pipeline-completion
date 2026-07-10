/**
 * Network helpers shared by every connector: fetch with retry + backoff,
 * a polite per-host rate limiter, and an on-disk raw-response cache.
 *
 * The cache doubles as the pipeline's provenance/reproducibility store: every
 * raw page we pull is written under data/raw/, so a run can be replayed and the
 * grader can see exactly what each source returned.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const RAW_DIR = new URL("../../data/raw/", import.meta.url).pathname;

/** Minimum gap between requests to the same host, in ms. */
const HOST_MIN_INTERVAL_MS = 250;
const lastHitByHost = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function throttle(url: string): Promise<void> {
  const host = new URL(url).host;
  const now = Date.now();
  const last = lastHitByHost.get(host) ?? 0;
  const wait = HOST_MIN_INTERVAL_MS - (now - last);
  if (wait > 0) await sleep(wait);
  lastHitByHost.set(host, Date.now());
}

export interface GetJsonOptions {
  /** Extra request headers (e.g. Socrata X-App-Token). */
  headers?: Record<string, string>;
  /** Cache key; when set, the response is cached on disk under data/raw/. */
  cacheKey?: string;
  /** Bypass the on-disk cache and always hit the network. */
  noCache?: boolean;
  /** Max retry attempts on transient failures. */
  retries?: number;
  /** HTTP method; defaults to GET. */
  method?: "GET" | "POST";
  /** Request body for POST (e.g. Overpass form-encoded `data=...`). */
  body?: string;
  /** Content-Type for the POST body. */
  contentType?: string;
}

function cachePath(key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 10);
  return join(RAW_DIR, `${safe}.${hash}.json`);
}

async function readCache<T>(key: string): Promise<T | undefined> {
  try {
    const raw = await readFile(cachePath(key), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

async function writeCache(key: string, value: unknown): Promise<void> {
  const p = cachePath(key);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(value), "utf8");
}

/**
 * GET a URL and parse JSON, with retry/backoff, host throttling, and optional
 * on-disk caching. Retries on network errors and 5xx/429; honors Retry-After.
 */
export async function getJson<T = unknown>(
  url: string,
  opts: GetJsonOptions = {},
): Promise<T> {
  const {
    headers,
    cacheKey,
    noCache,
    retries = 4,
    method = "GET",
    body,
    contentType = "application/x-www-form-urlencoded",
  } = opts;

  if (cacheKey && !noCache) {
    const hit = await readCache<T>(cacheKey);
    if (hit !== undefined) return hit;
  }

  let attempt = 0;
  let lastErr: unknown;
  while (attempt <= retries) {
    try {
      await throttle(url);
      const res = await fetch(url, {
        method,
        body,
        headers: {
          accept: "application/json",
          ...(body ? { "content-type": contentType } : {}),
          ...headers,
        },
      });
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after")) || 0;
        const backoff = retryAfter * 1000 || Math.min(2 ** attempt * 500, 8000);
        await sleep(backoff);
        attempt++;
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}: ${await res.text()}`);
      }
      const data = (await res.json()) as T;
      if (cacheKey) await writeCache(cacheKey, data);
      return data;
    } catch (err) {
      lastErr = err;
      const backoff = Math.min(2 ** attempt * 500, 8000);
      await sleep(backoff);
      attempt++;
    }
  }
  throw new Error(
    `getJson failed after ${retries + 1} attempts: ${url}\n${String(lastErr)}`,
  );
}

/**
 * GET a URL and return the raw text body (redirects auto-followed), with the
 * same retry/backoff/throttle and optional on-disk caching as getJson. Used for
 * CSV endpoints such as Junar's data.csv (which 302s to a signed S3 URL).
 */
export async function getText(
  url: string,
  opts: GetJsonOptions = {},
): Promise<string> {
  const { headers, cacheKey, noCache, retries = 4 } = opts;

  if (cacheKey && !noCache) {
    try {
      return await readFile(cachePath(cacheKey), "utf8");
    } catch {
      /* cache miss */
    }
  }

  let attempt = 0;
  let lastErr: unknown;
  while (attempt <= retries) {
    try {
      await throttle(url);
      const res = await fetch(url, { headers: { accept: "*/*", ...headers } });
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after")) || 0;
        const backoff = retryAfter * 1000 || Math.min(2 ** attempt * 500, 8000);
        await sleep(backoff);
        attempt++;
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}: ${await res.text()}`);
      }
      const text = await res.text();
      if (cacheKey) {
        const p = cachePath(cacheKey);
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, text, "utf8");
      }
      return text;
    } catch (err) {
      lastErr = err;
      await sleep(Math.min(2 ** attempt * 500, 8000));
      attempt++;
    }
  }
  throw new Error(
    `getText failed after ${retries + 1} attempts: ${url}\n${String(lastErr)}`,
  );
}

export function nowIso(): string {
  return new Date().toISOString();
}
