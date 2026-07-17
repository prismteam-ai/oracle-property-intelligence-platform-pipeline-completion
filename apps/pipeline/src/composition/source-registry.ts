import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { RunId, SnapshotId, SourceId } from '@oracle/contracts/ids';
import { licenseSnapshotIdSchema, snapshotIdSchema, sourceIdSchema } from '@oracle/contracts/ids';
import { SourceAdapterRegistry } from '@oracle/source-adapters/registry';
import type { SourceAdapter } from '@oracle/source-adapters/spi/adapter';
import {
  CA_SOS_BUSINESS_DESCRIPTOR,
  createCaSosBusinessAdapter,
} from '@oracle/source-adapters/providers/ca-sos-businesses/index';
import { createCslbContractorAdapter } from '@oracle/source-adapters/providers/cslb-contractors/index';
import { createMtcPaloAltoYearBuiltAdapter } from '@oracle/source-adapters/providers/mtc-palo-alto-year-built/index';
import { createNoaaUsgsWaterElevationAdapters } from '@oracle/source-adapters/providers/noaa-usgs-water-elevation/index';
import { createOvertureStarbucksAdapter } from '@oracle/source-adapters/providers/overture-starbucks/adapter';
import { OVERTURE_PLACES_FRAGMENT_SHA256 } from '@oracle/source-adapters/providers/overture-starbucks/constants';
import {
  createOsmPedestrianGraphAdapter,
  type OsmPbfDecoder,
} from '@oracle/source-adapters/providers/osm-pedestrian-graph/index';
import { createSanJoseBuildingPermitAdapter } from '@oracle/source-adapters/providers/san-jose-building-permits/index';
import { SANTA_CLARA_FBN_BLOCKED_CAPABILITY } from '@oracle/source-adapters/providers/santa-clara-fbn-capability/index';
import { createSantaClaraOwnershipTransferCapabilityAdapter } from '@oracle/source-adapters/providers/santa-clara-ownership-transfers/index';
import { createSantaClaraSocrataParcelsAdapter } from '@oracle/source-adapters/providers/santa-clara-socrata-parcels/index';
import {
  CALTRAIN_2026_06_10_SNAPSHOT,
  createVtaCurrentGtfsAdapter,
  createCaltrainCurrentGtfsAdapter,
  VTA_2026_07_15_SNAPSHOT,
  type TransitFeedSnapshotConfig,
} from '@oracle/source-adapters/providers/vta-caltrain-511-gtfs/index';
import { createStaticGtfsAdapter } from '@oracle/source-adapters/providers/vta-caltrain-511-gtfs/adapter';

import { sha256 } from '../orchestration/canonical-json.js';
import type { RunProfileName, SourceConfiguration } from '../orchestration/types.js';
import {
  BlockedCapabilityAdapter,
  createBlockedCapabilityDescriptor,
} from './capability-adapter.js';
import type { PipelineSourceConfig } from './source-config.js';

const OSM_PEDESTRIAN_GRAPH_SOURCE_ID = sourceIdSchema.parse('sc:source:osm-pedestrian-graph');
const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';
const OSM_ODBL_URL = 'https://opendatacommons.org/licenses/odbl/1-0/';
const OSM_NOTICE =
  'Contains information from OpenStreetMap, available under the Open Database License (ODbL) 1.0. Redistributed derivative databases must retain attribution and satisfy ODbL share-alike obligations.';
const OSM_LICENSE_SNAPSHOT_ID = licenseSnapshotIdSchema.parse(
  `sc:license:osm-pedestrian-graph:${sha256(OSM_NOTICE)}`,
);

export type ProductionCompositionInput = Readonly<{
  runId: RunId;
  requestedAt: string;
  profile: RunProfileName;
  workspaceDirectory: string;
  config: PipelineSourceConfig;
  configFingerprint: string;
}>;

function snapshotId(sourceId: SourceId, seed: string): SnapshotId {
  const suffix = sourceId.replace('sc:source:', '');
  const digest = /^[a-f0-9]{64}$/u.test(seed) ? seed : sha256(seed);
  return snapshotIdSchema.parse(`sc:snapshot:${suffix}:${digest}`);
}

function mutableSnapshot(input: ProductionCompositionInput, sourceId: SourceId): SnapshotId {
  return snapshotId(
    sourceId,
    sha256({
      sourceId,
      configFingerprint: input.configFingerprint,
      identityContract: 'oracle-source-snapshot-intent-v1',
    }),
  );
}

function lane(
  input: ProductionCompositionInput,
  adapterInput: unknown,
  options: Readonly<{
    scope: string;
    capability: string;
    fixedHash?: string;
    executionMode?: SourceConfiguration['executionMode'];
    supportState?: SourceConfiguration['supportState'];
    acquisitionItemCap?: number | null;
    discoveryDenominatorStrategy?: SourceConfiguration['discoveryDenominatorStrategy'];
    limitations?: readonly string[];
    requiredForCountyCompletion?: boolean;
  }>,
): SourceConfiguration {
  const adapter = adapterInput as SourceConfiguration['adapter'];
  const sourceId = adapter.describe().sourceId;
  return Object.freeze({
    adapter,
    snapshotId:
      options.fixedHash === undefined
        ? mutableSnapshot(input, sourceId)
        : snapshotId(sourceId, options.fixedHash),
    scope: options.scope,
    capability: options.capability,
    executionMode: options.executionMode ?? 'execute',
    supportState: options.supportState ?? 'available',
    acquisitionItemCap: options.acquisitionItemCap ?? null,
    discoveryDenominatorStrategy: options.discoveryDenominatorStrategy ?? 'first_non_null',
    requiredForCountyCompletion: options.requiredForCountyCompletion ?? true,
    limitations: Object.freeze(options.limitations ?? []),
  });
}

function pilotExec(
  input: ProductionCompositionInput,
  sourceId: string,
): SourceConfiguration['executionMode'] {
  if (input.profile !== 'pilot') return 'execute';
  return input.config.pilot.includeLargeSources.includes(sourceId) ? 'execute' : 'discover_only';
}

function blockedCaSos(): BlockedCapabilityAdapter {
  return new BlockedCapabilityAdapter({
    descriptor: CA_SOS_BUSINESS_DESCRIPTOR,
    officialUrls: Object.freeze([
      'https://www.sos.ca.gov/administration/public-records-act-requests/business-entity-records',
      'https://bizfileonline.sos.ca.gov/',
    ]),
    reason:
      'CA SOS production acquisition requires an operator-frozen bizfile bulk export source lock; none was configured.',
    limitations: Object.freeze([
      'Public search is CAPTCHA/anti-bot protected and is not scraped.',
      'SOS business entities do not provide beneficial ownership.',
    ]),
  });
}

function blockedOsm(): BlockedCapabilityAdapter {
  const termsHash = sha256(OSM_NOTICE);
  return new BlockedCapabilityAdapter({
    descriptor: createBlockedCapabilityDescriptor({
      sourceId: OSM_PEDESTRIAN_GRAPH_SOURCE_ID,
      name: 'OpenStreetMap pedestrian graph capability',
      authority: {
        authorityType: 'recognized_distributor',
        organization: 'OpenStreetMap contributors / Geofabrik GmbH',
        jurisdiction: 'Northern California',
        canonicalUrl: 'https://download.geofabrik.de/north-america/us/california/norcal.html',
        authorityRank: 10,
      },
      acquisitionMethod: 'static_artifact',
      encodings: ['pbf'],
      entityKinds: ['pedestrian-graph-ref'],
      defaultVisibility: 'public',
      license: {
        licenseSnapshotId: OSM_LICENSE_SNAPSHOT_ID,
        capturedAt: '2026-07-17T13:01:50.000Z',
        title: 'Open Database License 1.0',
        canonicalUrl: OSM_ODBL_URL,
        termsSha256: termsHash,
        redistribution: 'approved',
        containsPersonalData: false,
        attribution: [OSM_ATTRIBUTION],
        limitations: [
          `Retain attribution at ${OSM_COPYRIGHT_URL}.`,
          'A public derivative database must satisfy applicable ODbL share-alike obligations.',
        ],
      },
      ratePolicy: {
        maxRequestsPerWindow: 1,
        windowMs: 60_000,
        maxConcurrency: 1,
        maxAttempts: 3,
        initialBackoffMs: 1_000,
        maxBackoffMs: 30_000,
        jitter: 'full',
        respectRetryAfter: true,
      },
      freshnessSemantics: 'A dated Geofabrik artifact must be pinned by exact SHA-256.',
    }),
    officialUrls: Object.freeze([
      'https://download.geofabrik.de/north-america/us/california/norcal.html',
    ]),
    reason:
      'OSM production execution requires a pinned dated extract SHA-256 and an injected streaming PBF decoder; neither was configured.',
    limitations: Object.freeze([
      'The repository intentionally does not fabricate a PBF hash or decode the full regional archive without an injected decoder.',
    ]),
  });
}

function blockedFbn(): BlockedCapabilityAdapter {
  const capability = SANTA_CLARA_FBN_BLOCKED_CAPABILITY;
  return new BlockedCapabilityAdapter({
    descriptor: createBlockedCapabilityDescriptor({
      sourceId: sourceIdSchema.parse('sc:source:santa-clara-fbn-capability'),
      name: 'Santa Clara County fictitious business name capability',
      authority: {
        authorityType: 'official_government',
        organization: capability.authority,
        jurisdiction: capability.jurisdiction,
        canonicalUrl: capability.sourceUrls[0] ?? 'https://clerkrecorder.santaclaracounty.gov/',
        authorityRank: 1,
      },
      acquisitionMethod: 'manual_snapshot',
      encodings: ['other'],
      entityKinds: ['business', 'fbn-capability'],
      defaultVisibility: 'prohibited_public',
      license: {
        licenseSnapshotId: licenseSnapshotIdSchema.parse(
          `sc:license:santa-clara-fbn-capability:${capability.evidenceSha256}`,
        ),
        capturedAt: capability.asOf,
        title: 'Santa Clara County FBN data-sales capability decision',
        canonicalUrl: capability.sourceUrls[0] ?? null,
        termsSha256: capability.evidenceSha256,
        redistribution: 'unknown',
        containsPersonalData: true,
        attribution: [capability.authority],
        limitations: [...capability.limitations],
      },
      ratePolicy: {
        maxRequestsPerWindow: 2,
        windowMs: 60_000,
        maxConcurrency: 1,
        maxAttempts: 2,
        initialBackoffMs: 500,
        maxBackoffMs: 5_000,
        jitter: 'full',
        respectRetryAfter: true,
      },
      freshnessSemantics: `Capability decision frozen at ${capability.asOf}.`,
    }),
    officialUrls: capability.sourceUrls,
    reason: capability.reason,
    limitations: capability.limitations,
  });
}

async function loadOsmDecoder(
  workspaceDirectory: string,
  modulePath: string,
): Promise<OsmPbfDecoder> {
  const absolute = resolveWorkspaceModulePath(workspaceDirectory, modulePath);
  const loaded = (await import(pathToFileURL(absolute).href)) as Readonly<{
    decoder?: OsmPbfDecoder;
    createDecoder?: () => OsmPbfDecoder;
  }>;
  const decoder = loaded.decoder ?? loaded.createDecoder?.();
  if (decoder === undefined || typeof decoder.decode !== 'function') {
    throw new TypeError('Configured OSM decoder module must export decoder or createDecoder()');
  }
  return decoder;
}

export function resolveWorkspaceModulePath(workspaceDirectory: string, modulePath: string): string {
  if (isAbsolute(modulePath)) {
    throw new TypeError('Configured OSM decoder module must be workspace-relative');
  }
  const workspace = resolve(workspaceDirectory);
  const absolute = resolve(workspace, modulePath);
  const fromWorkspace = relative(workspace, absolute);
  if (
    fromWorkspace === '..' ||
    fromWorkspace.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(fromWorkspace)
  ) {
    throw new TypeError('Configured OSM decoder module must stay inside the workspace');
  }
  return absolute;
}

export async function composeProductionSources(
  input: ProductionCompositionInput,
): Promise<readonly SourceConfiguration[]> {
  const pilot = input.profile === 'pilot';
  const pageSize = pilot ? input.config.pilot.recordCap : input.config.parcels.pageSize;
  const paloAltoPageSize = pilot
    ? input.config.pilot.recordCap
    : input.config.paloAltoYearBuilt.pageSize;
  const sources: SourceConfiguration[] = [];

  sources.push(
    lane(input, createSantaClaraSocrataParcelsAdapter({ pageSize }), {
      scope: 'Santa Clara County parcel rows',
      capability: 'santa_clara_parcels',
      acquisitionItemCap: pilot ? 1 : null,
    }),
    lane(
      input,
      createSanJoseBuildingPermitAdapter({
        runId: input.runId,
        normalizationTimestamp: input.requestedAt,
        ...input.config.sanJosePermits,
      }),
      {
        scope: 'City of San Jose permit feeds only',
        capability: 'san_jose_permits',
        acquisitionItemCap: pilot ? 1 : null,
        limitations: ['San Jose permit completion is not countywide permit completion.'],
      },
    ),
    lane(input, createMtcPaloAltoYearBuiltAdapter({ pageSize: paloAltoPageSize }), {
      scope: 'Palo Alto subset assessor enrichment',
      capability: 'palo_alto_year_built',
      acquisitionItemCap: pilot ? 1 : null,
      limitations: ['Palo Alto is a named county subset and never the county denominator.'],
    }),
    lane(input, createVtaCurrentGtfsAdapter(), {
      scope: 'VTA operator static GTFS',
      capability: 'vta_gtfs',
      fixedHash: VTA_2026_07_15_SNAPSHOT.expectedZipSha256,
    }),
    lane(input, createCaltrainCurrentGtfsAdapter(), {
      scope: 'Caltrain operator static GTFS',
      capability: 'caltrain_gtfs',
      fixedHash: CALTRAIN_2026_06_10_SNAPSHOT.expectedZipSha256,
    }),
  );

  for (const adapter of createNoaaUsgsWaterElevationAdapters(input.config.waterElevation)) {
    const capability = adapter.describe().sourceId.includes('noaa')
      ? 'noaa_shoreline'
      : adapter.describe().sourceId.includes('elevation')
        ? 'usgs_elevation'
        : 'usgs_hydrography';
    sources.push(
      lane(input, adapter, {
        scope: 'Santa Clara water/terrain reference inputs',
        capability,
        acquisitionItemCap: pilot ? 1 : null,
        discoveryDenominatorStrategy:
          capability === 'usgs_hydrography' ? 'sum_non_null' : 'first_non_null',
      }),
    );
  }

  sources.push(
    lane(input, createOvertureStarbucksAdapter(input.config.overture), {
      scope: 'Santa Clara County Starbucks candidates',
      capability: 'overture_starbucks',
      fixedHash: input.config.overture.artifact?.expectedSha256 ?? OVERTURE_PLACES_FRAGMENT_SHA256,
      executionMode: pilotExec(input, 'sc:source:overture-starbucks'),
      limitations: ['Overture matches remain candidates, not proof of a currently open Starbucks.'],
    }),
    lane(
      input,
      createCslbContractorAdapter({
        runId: input.runId,
        normalizationTimestamp: input.requestedAt,
        ...input.config.cslb,
      }),
      {
        scope: 'California current/renewable contractor license master',
        capability: 'cslb_contractors',
        executionMode: pilotExec(input, 'sc:source:cslb-contractors'),
        limitations: ['CSLB license presence is not contractor quality evidence.'],
      },
    ),
  );

  const caSos = input.config.caSos;
  sources.push(
    lane(
      input,
      caSos === null
        ? blockedCaSos()
        : createCaSosBusinessAdapter({
            ...caSos,
            runId: input.runId,
            normalizationTimestamp: input.requestedAt,
          }),
      {
        scope: 'California Secretary of State business entities',
        capability: 'ca_sos_businesses',
        ...(caSos === null ? {} : { fixedHash: caSos.expectedSha256 }),
        executionMode: caSos === null ? 'execute' : pilotExec(input, 'sc:source:ca-sos-businesses'),
        supportState: caSos === null ? 'blocked' : 'available',
        limitations: ['CA SOS entities do not establish beneficial ownership.'],
      },
    ),
  );

  const osm = input.config.osm;
  const osmAdapter =
    osm === null
      ? blockedOsm()
      : createOsmPedestrianGraphAdapter({
          extract: osm.extract,
          decoder: await loadOsmDecoder(input.workspaceDirectory, osm.decoderModule),
        });
  sources.push(
    lane(input, osmAdapter, {
      scope: 'Northern California OSM pedestrian graph clipped for Santa Clara use',
      capability: 'osm_pedestrian_graph',
      ...(osm === null ? {} : { fixedHash: osm.extract.expectedSha256 }),
      executionMode: osm === null ? 'execute' : pilotExec(input, OSM_PEDESTRIAN_GRAPH_SOURCE_ID),
      supportState: osm === null ? 'blocked' : 'available',
    }),
    lane(input, createSantaClaraOwnershipTransferCapabilityAdapter(), {
      scope: 'Santa Clara County ownership/recorded-transfer capability',
      capability: 'ownership_transfers',
      fixedHash: sha256('santa-clara-ownership-transfer-capability-2026-07-17'),
      supportState: 'blocked',
      limitations: [
        'Blocked capability cannot support no-exchange-over-ten-years or regional-owner facts.',
      ],
    }),
    lane(input, blockedFbn(), {
      scope: 'Santa Clara County fictitious business name capability',
      capability: 'santa_clara_fbn',
      fixedHash: SANTA_CLARA_FBN_BLOCKED_CAPABILITY.evidenceSha256,
      supportState: 'blocked',
    }),
  );

  if (input.config.fallback511 !== null) {
    for (const operator of ['vta', 'caltrain'] as const) {
      const config: TransitFeedSnapshotConfig | undefined =
        input.config.fallback511.feeds[operator];
      if (config === undefined) continue;
      sources.push(
        lane(input, createStaticGtfsAdapter(config), {
          scope: `511 ${operator} GTFS fallback/cross-check`,
          capability: 'transit_511_fallback',
          fixedHash: config.expectedZipSha256,
          requiredForCountyCompletion: false,
          limitations: [
            '511 is a fallback/cross-check and never supersedes an available direct feed.',
          ],
        }),
      );
    }
  }

  const registry = new SourceAdapterRegistry<SourceAdapter>();
  registry.registerAll(sources.map(({ adapter }) => adapter));
  const registered = new Set(registry.descriptors().map(({ sourceId }) => sourceId));
  if (registered.size !== sources.length)
    throw new Error('Production source registry is incomplete');
  return Object.freeze(sources);
}
