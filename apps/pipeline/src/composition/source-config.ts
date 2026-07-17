import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { CaSosBusinessAdapterOptions } from '@oracle/source-adapters/providers/ca-sos-businesses/index';
import type { CslbContractorAdapterOptions } from '@oracle/source-adapters/providers/cslb-contractors/index';
import type { WaterElevationAdapterOptions } from '@oracle/source-adapters/providers/noaa-usgs-water-elevation/index';
import type { OvertureAdapterOptions } from '@oracle/source-adapters/providers/overture-starbucks/types';
import type { PinnedOsmExtract } from '@oracle/source-adapters/providers/osm-pedestrian-graph/index';
import type { SanJoseBuildingPermitAdapterOptions } from '@oracle/source-adapters/providers/san-jose-building-permits/index';
import type { TransitFeedSnapshotConfig } from '@oracle/source-adapters/providers/vta-caltrain-511-gtfs/index';

import { sha256 } from '../orchestration/canonical-json.js';

type CaSosConfig = Omit<CaSosBusinessAdapterOptions, 'runId' | 'normalizationTimestamp'>;
type CslbConfig = Omit<CslbContractorAdapterOptions, 'runId' | 'normalizationTimestamp'>;
type SanJoseConfig = Omit<SanJoseBuildingPermitAdapterOptions, 'runId' | 'normalizationTimestamp'>;

export type AuthorizationRule = Readonly<{
  urlPrefix: string;
  headerName: string;
  environmentVariable: string;
}>;

export type PipelineSourceConfig = Readonly<{
  schemaVersion: 1;
  runtime: Readonly<{
    maxConcurrentSources: number;
    maxBufferedRecords: number;
    maximumPhaseAttempts: number;
    requestTimeoutMs: number;
  }>;
  pilot: Readonly<{
    recordCap: number;
    includeLargeSources: readonly string[];
  }>;
  parcels: Readonly<{ pageSize: number }>;
  paloAltoYearBuilt: Readonly<{ pageSize: number }>;
  sanJosePermits: SanJoseConfig;
  waterElevation: WaterElevationAdapterOptions;
  overture: OvertureAdapterOptions;
  cslb: CslbConfig;
  caSos: CaSosConfig | null;
  osm: Readonly<{ extract: PinnedOsmExtract; decoderModule: string }> | null;
  fallback511: Readonly<{
    feeds: Readonly<Partial<Record<'vta' | 'caltrain', TransitFeedSnapshotConfig>>>;
    authorization: readonly AuthorizationRule[];
  }> | null;
}>;

const DEFAULT_CONFIG: PipelineSourceConfig = Object.freeze({
  schemaVersion: 1,
  runtime: Object.freeze({
    maxConcurrentSources: 2,
    maxBufferedRecords: 50,
    maximumPhaseAttempts: 2,
    requestTimeoutMs: 30_000,
  }),
  pilot: Object.freeze({
    recordCap: 50,
    includeLargeSources: Object.freeze([]),
  }),
  parcels: Object.freeze({ pageSize: 5_000 }),
  paloAltoYearBuilt: Object.freeze({ pageSize: 5_000 }),
  sanJosePermits: Object.freeze({}),
  waterElevation: Object.freeze({}),
  overture: Object.freeze({}),
  cslb: Object.freeze({}),
  caSos: null,
  osm: null,
  fallback511: null,
});

function object(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function integer(value: unknown, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || Number(selected) < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return Number(selected);
}

function strings(value: unknown, label: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array of non-empty strings`);
  }
  const entries: readonly unknown[] = value;
  const selected: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry === '') {
      throw new TypeError(`${label} must be an array of non-empty strings`);
    }
    selected.push(entry);
  }
  return Object.freeze([...new Set(selected)].sort());
}

function rejectSecretMaterial(value: unknown, path = 'sourceConfig'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecretMaterial(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'string' && /^https?:\/\//iu.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new TypeError(`${path} may not contain an invalid URL`);
    }
    if (url.username !== '' || url.password !== '') {
      throw new TypeError(`${path} may not embed URL credentials`);
    }
    for (const key of url.searchParams.keys()) {
      if (/(?:api.?key|secret|password|credential|token|authorization|signature|sig)/iu.test(key)) {
        throw new TypeError(`${path} may not embed credential-bearing URL query parameters`);
      }
    }
    return;
  }
  if (typeof value === 'string' && /^(?:bearer|basic)\s+\S+/iu.test(value.trim())) {
    throw new TypeError(`${path} may not contain a literal authorization credential`);
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Readonly<Record<string, unknown>>)) {
    const childPath = `${path}.${key}`;
    const credentialKey =
      /(?:api.?key|secret|password|credential|token|authorization|cookie)/iu.test(key) ||
      /^headers?$/iu.test(key);
    if (credentialKey) {
      if (childPath !== 'sourceConfig.fallback511.authorization') {
        throw new TypeError(
          `${childPath} may not contain credential material; reference an environment variable instead`,
        );
      }
    }
    rejectSecretMaterial(child, childPath);
  }
}

function validateAuthorization(
  value: unknown,
  feeds: Readonly<Record<string, unknown>>,
): readonly AuthorizationRule[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError('fallback511.authorization must be an array');
  const feedUrls = Object.values(feeds).flatMap((feed, index) => {
    const item = object(feed, `fallback511.feeds[${index}]`);
    if (typeof item.url !== 'string') {
      throw new TypeError(`fallback511.feeds[${index}].url is required for authorization scoping`);
    }
    return [new URL(item.url)];
  });
  return Object.freeze(
    value.map((entry, index) => {
      const item = object(entry, `fallback511.authorization[${index}]`);
      const urlPrefix = item.urlPrefix;
      const headerName = item.headerName;
      const environmentVariable = item.environmentVariable;
      if (typeof urlPrefix !== 'string' || typeof headerName !== 'string') {
        throw new TypeError(`fallback511.authorization[${index}] is invalid`);
      }
      let scope: URL;
      try {
        scope = new URL(urlPrefix);
      } catch {
        throw new TypeError(`fallback511.authorization[${index}].urlPrefix is invalid`);
      }
      const supportedHeader = /^(?:authorization|x-api-key|api-key)$/iu.test(headerName);
      const scopedToFeed = feedUrls.some(
        (feed) =>
          feed.origin === scope.origin &&
          (feed.pathname === scope.pathname ||
            feed.pathname.startsWith(
              scope.pathname.endsWith('/') ? scope.pathname : `${scope.pathname}/`,
            )) &&
          scope.pathname !== '/' &&
          scope.search === '' &&
          scope.hash === '',
      );
      if (
        scope.protocol !== 'https:' ||
        !supportedHeader ||
        typeof environmentVariable !== 'string' ||
        !/^[A-Z][A-Z0-9_]*$/u.test(environmentVariable) ||
        !scopedToFeed
      ) {
        throw new TypeError(
          `fallback511.authorization[${index}] must be a non-root HTTPS scope within a configured feed URL and use an approved credential header`,
        );
      }
      return Object.freeze({ urlPrefix, headerName, environmentVariable });
    }),
  );
}

function parseConfig(value: unknown): PipelineSourceConfig {
  const root = object(value, 'sourceConfig');
  if (root.schemaVersion !== 1) throw new TypeError('sourceConfig.schemaVersion must equal 1');
  rejectSecretMaterial(root);
  const runtime = object(root.runtime ?? {}, 'sourceConfig.runtime');
  const pilot = object(root.pilot ?? {}, 'sourceConfig.pilot');
  const parcels = object(root.parcels ?? {}, 'sourceConfig.parcels');
  const paloAlto = object(root.paloAltoYearBuilt ?? {}, 'sourceConfig.paloAltoYearBuilt');
  const sanJose = object(root.sanJosePermits ?? {}, 'sourceConfig.sanJosePermits');
  const water = object(root.waterElevation ?? {}, 'sourceConfig.waterElevation');
  const overture = object(root.overture ?? {}, 'sourceConfig.overture');
  const cslb = object(root.cslb ?? {}, 'sourceConfig.cslb');
  const caSos =
    root.caSos === undefined || root.caSos === null
      ? null
      : object(root.caSos, 'sourceConfig.caSos');
  const osm =
    root.osm === undefined || root.osm === null ? null : object(root.osm, 'sourceConfig.osm');
  const fallback =
    root.fallback511 === undefined || root.fallback511 === null
      ? null
      : object(root.fallback511, 'sourceConfig.fallback511');
  const fallbackFeeds =
    fallback === null ? null : object(fallback.feeds ?? {}, 'sourceConfig.fallback511.feeds');

  if (osm !== null && (typeof osm.decoderModule !== 'string' || osm.decoderModule.length === 0)) {
    throw new TypeError('sourceConfig.osm.decoderModule is required');
  }
  if (osm !== null) object(osm.extract, 'sourceConfig.osm.extract');
  if (caSos !== null) {
    for (const field of [
      'bulkArtifactUrl',
      'sourceAsOf',
      'expectedSha256',
      'expectedRecordCount',
      'sourceVersion',
      'encoding',
      'sourceLock',
    ]) {
      if (caSos[field] === undefined)
        throw new TypeError(`sourceConfig.caSos.${field} is required`);
    }
    integer(caSos.expectedRecordCount, 0, 'sourceConfig.caSos.expectedRecordCount');
  }

  return Object.freeze({
    schemaVersion: 1,
    runtime: Object.freeze({
      maxConcurrentSources: integer(
        runtime.maxConcurrentSources,
        DEFAULT_CONFIG.runtime.maxConcurrentSources,
        'sourceConfig.runtime.maxConcurrentSources',
      ),
      maxBufferedRecords: integer(
        runtime.maxBufferedRecords,
        DEFAULT_CONFIG.runtime.maxBufferedRecords,
        'sourceConfig.runtime.maxBufferedRecords',
      ),
      maximumPhaseAttempts: integer(
        runtime.maximumPhaseAttempts,
        DEFAULT_CONFIG.runtime.maximumPhaseAttempts,
        'sourceConfig.runtime.maximumPhaseAttempts',
      ),
      requestTimeoutMs: integer(
        runtime.requestTimeoutMs,
        DEFAULT_CONFIG.runtime.requestTimeoutMs,
        'sourceConfig.runtime.requestTimeoutMs',
      ),
    }),
    pilot: Object.freeze({
      recordCap: integer(
        pilot.recordCap,
        DEFAULT_CONFIG.pilot.recordCap,
        'sourceConfig.pilot.recordCap',
      ),
      includeLargeSources: strings(
        pilot.includeLargeSources,
        'sourceConfig.pilot.includeLargeSources',
      ),
    }),
    parcels: Object.freeze({
      pageSize: integer(
        parcels.pageSize,
        DEFAULT_CONFIG.parcels.pageSize,
        'sourceConfig.parcels.pageSize',
      ),
    }),
    paloAltoYearBuilt: Object.freeze({
      pageSize: integer(
        paloAlto.pageSize,
        DEFAULT_CONFIG.paloAltoYearBuilt.pageSize,
        'sourceConfig.paloAltoYearBuilt.pageSize',
      ),
    }),
    sanJosePermits: Object.freeze({ ...sanJose }),
    waterElevation: Object.freeze({ ...water }),
    overture: Object.freeze({ ...overture }),
    cslb: Object.freeze({ ...cslb }),
    caSos: caSos === null ? null : (Object.freeze({ ...caSos }) as CaSosConfig),
    osm:
      osm === null
        ? null
        : Object.freeze({
            extract: Object.freeze({
              ...object(osm.extract, 'sourceConfig.osm.extract'),
            }) as unknown as PinnedOsmExtract,
            decoderModule: String(osm.decoderModule),
          }),
    fallback511:
      fallback === null
        ? null
        : Object.freeze({
            feeds: Object.freeze({
              ...fallbackFeeds,
            }),
            authorization: validateAuthorization(
              fallback.authorization,
              fallbackFeeds ?? Object.freeze({}),
            ),
          }),
  });
}

export async function readPipelineSourceConfig(
  path: string | undefined,
): Promise<PipelineSourceConfig> {
  if (path === undefined) return DEFAULT_CONFIG;
  const absolutePath = resolve(path);
  const parsed = JSON.parse(await readFile(absolutePath, 'utf8')) as unknown;
  return parseConfig(parsed);
}

export function sourceConfigFingerprint(config: PipelineSourceConfig): string {
  return sha256(config);
}
