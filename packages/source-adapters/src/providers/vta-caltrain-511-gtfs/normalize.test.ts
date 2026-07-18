import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

import type { CanonicalMutation } from '@oracle/contracts/canonical/mutation';
import { artifactIdSchema } from '@oracle/contracts/ids';
import type {
  AnalyticalQuery,
  AnalyticalResult,
  AnalyticalRow,
  AnalyticalRuntime,
  AnalyticalSession,
  AnalyticalSnapshot,
} from '@oracle/data-runtime/analytical-runtime';
import { DuckDBAnalyticalRuntime } from '@oracle/data-runtime/duckdb/duckdb-analytical-runtime';
import { describe, expect, it } from 'vitest';

import { createImmutableBytes } from '../../spi/bytes.js';
import {
  createCanonicalTransitMutations,
  createStreamingCanonicalTransitMutations,
  normalizeTransitSnapshot,
} from './normalize.js';
import { CALTRAIN_2026_06_10_SNAPSHOT } from './snapshots.js';
import type { GtfsRow, StreamingGtfsMember, ValidatedGtfsFeed } from './types.js';

const GTFS_OPERATION = 'decode_gtfs_bounded_finalize';
const MAX_GTFS_CSV_LINE_BYTES = 1024 * 1024;
const REVIEWED_TRIP_PAGE_ROWS = 256;
const REVIEWED_STOP_PAGE_ROWS = 128;
const REVIEWED_STOP_TIME_PAGE_ROWS = 1024;
const MAX_SERVICE_PAIRS_PER_STOP = 4096;

interface QueryEvidence {
  statement: string;
  csvReferences: number;
  maximumRows: number;
  maximumScanBytes: number;
  scannedBytes: number | null;
}

interface ExecutionStats {
  executions: number;
  scannedBytes: number;
  maximumRows: number[];
  queries: QueryEvidence[];
}

class CountingAnalyticalSession implements AnalyticalSession {
  constructor(
    private readonly delegate: AnalyticalSession,
    private readonly stats: ExecutionStats,
  ) {}

  async execute<TRow extends AnalyticalRow = AnalyticalRow>(
    query: AnalyticalQuery,
  ): Promise<AnalyticalResult<TRow>> {
    this.stats.executions += 1;
    this.stats.maximumRows.push(query.maximumRows);
    const evidence: QueryEvidence = {
      statement: query.statement,
      csvReferences: query.statement.match(/read_csv_auto/gu)?.length ?? 0,
      maximumRows: query.maximumRows,
      maximumScanBytes: query.maximumScanBytes,
      scannedBytes: null,
    };
    this.stats.queries.push(evidence);
    const result = await this.delegate.execute<TRow>(query);
    this.stats.scannedBytes += result.scannedBytes ?? 0;
    evidence.scannedBytes = result.scannedBytes;
    return result;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.delegate[Symbol.asyncDispose]();
  }
}

class CountingAnalyticalRuntime implements AnalyticalRuntime {
  constructor(
    private readonly delegate: AnalyticalRuntime,
    private readonly stats: ExecutionStats,
  ) {}

  async open(snapshot: AnalyticalSnapshot, signal?: AbortSignal): Promise<AnalyticalSession> {
    return new CountingAnalyticalSession(await this.delegate.open(snapshot, signal), this.stats);
  }
}

const caltrainMembers = Object.freeze({
  'agency.txt': 'agency_id,agency_name\r\n1000,Caltrain\r\n',
  'routes.txt':
    'route_id,agency_id,route_short_name,route_long_name,route_type\r\n' +
    'RED,1000,L1,Local,2\r\n',
  'trips.txt':
    'route_id,service_id,trip_id,trip_headsign\r\n' + 'RED,WKDY,T1,"San Francisco, Northbound"\r\n',
  'stops.txt':
    'stop_id,stop_code,stop_name,stop_lat,stop_lon,location_type,parent_station,platform_code\r\n' +
    'PA,PA,Palo Alto,37.443,-122.165,0,,1\r\n',
  'stop_times.txt':
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\r\n' +
    'T1,08:00:00,08:00:00,PA,1,0,0\r\n',
  'calendar.txt':
    'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\r\n' +
    'WKDY,1,1,1,1,1,0,0,20260131,20270131\r\n',
});

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function createExtensionlessFixture(
  overrides: Readonly<Record<string, string>> = {},
): Promise<
  Readonly<{
    root: string;
    feed: ValidatedGtfsFeed;
    runtime: AnalyticalRuntime;
    stats: ExecutionStats;
    totalMemberBytes: number;
  }>
> {
  const root = await mkdtemp(join(tmpdir(), 'oracle-caltrain-extensionless-'));
  const encoder = new TextEncoder();
  const members: Record<string, StreamingGtfsMember> = {};
  let totalMemberBytes = 0;
  let index = 0;

  for (const [name, content] of Object.entries({ ...caltrainMembers, ...overrides })) {
    const bytes = encoder.encode(content);
    const uri = join(root, `member-${index}`);
    index += 1;
    await writeFile(uri, bytes);
    totalMemberBytes += bytes.byteLength;
    members[name] = Object.freeze({
      name,
      uri,
      byteSize: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }

  const manifestBytes = encoder.encode('extensionless-caltrain-fixture\n');
  const manifestUri = join(root, 'manifest');
  await writeFile(manifestUri, manifestBytes);
  const rawBytes = createImmutableBytes(encoder.encode('caltrain-zip-fixture'));
  const feed: ValidatedGtfsFeed = Object.freeze({
    artifactId: artifactIdSchema.parse(`sc:artifact:sha256:${rawBytes.sha256}`),
    ordinal: 0,
    visibility: 'public',
    format: 'zip',
    entryPath: '/',
    mediaType: 'application/zip',
    bytes: rawBytes,
    members: Object.freeze({}),
    memberNames: Object.freeze(Object.keys(members).sort()),
    streamingManifest: Object.freeze({
      formatVersion: '1.0.0',
      uri: manifestUri,
      sha256: sha256(manifestBytes),
      byteSize: manifestBytes.byteLength,
      totalMemberBytes,
      members: Object.freeze(members),
    }),
    agency: Object.freeze([]),
    stops: Object.freeze([]),
    routes: Object.freeze([]),
    trips: Object.freeze([]),
    calendars: Object.freeze([]),
    calendarDates: Object.freeze([]),
    stopTimes: Object.freeze([]),
    transfers: Object.freeze([]),
  });
  const delegate = new DuckDBAnalyticalRuntime({
    loadSnapshot: () =>
      Promise.resolve({
        manifestBytes,
        scanBytesByOperation: Object.freeze({ [GTFS_OPERATION]: totalMemberBytes }),
      }),
    nowMilliseconds: () => Date.now(),
  });
  const stats: ExecutionStats = {
    executions: 0,
    scannedBytes: 0,
    maximumRows: [],
    queries: [],
  };
  const runtime = new CountingAnalyticalRuntime(delegate, stats);
  return Object.freeze({ root, feed, runtime, stats, totalMemberBytes });
}

async function collectMutations(
  fixture: Readonly<{ feed: ValidatedGtfsFeed; runtime: AnalyticalRuntime }>,
): Promise<readonly CanonicalMutation[]> {
  const mutations: CanonicalMutation[] = [];
  for await (const mutation of createStreamingCanonicalTransitMutations(
    fixture.feed,
    CALTRAIN_2026_06_10_SNAPSHOT,
    {
      clock: { now: () => CALTRAIN_2026_06_10_SNAPSHOT.retrievedAt },
      signal: new AbortController().signal,
      analyticalRuntime: fixture.runtime,
    },
  )) {
    mutations.push(mutation);
  }
  return Object.freeze(mutations);
}

function generatedScaleMembers(
  serviceCount: number,
  stopCount: number,
  allServicesAtOneStop = false,
): Readonly<Record<string, string>> {
  const id = (prefix: string, index: number): string =>
    `${prefix}${index.toString().padStart(5, '0')}`;
  const routes = ['route_id,agency_id,route_short_name,route_long_name,route_type'];
  const trips = ['route_id,service_id,trip_id,trip_headsign'];
  const stops = [
    'stop_id,stop_code,stop_name,stop_lat,stop_lon,location_type,parent_station,platform_code',
  ];
  const stopTimes = [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type',
  ];
  const calendars = [
    'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
  ];
  for (let index = 0; index < stopCount; index += 1) {
    const stopId = id('P', index);
    stops.push(`${stopId},${stopId},Stop ${index},37.4,-122.1,0,,`);
  }
  for (let index = 0; index < serviceCount; index += 1) {
    const routeId = id('R', index);
    const serviceId = id('S', index);
    const tripId = id('T', index);
    const stopId = id('P', allServicesAtOneStop ? 0 : index % stopCount);
    routes.push(`${routeId},1000,${index},Route ${index},2`);
    trips.push(`${routeId},${serviceId},${tripId},Trip ${index}`);
    stopTimes.push(`${tripId},08:00:00,08:00:00,${stopId},1,0,0`);
    calendars.push(`${serviceId},1,1,1,1,1,0,0,20260131,20270131`);
  }
  return Object.freeze({
    'routes.txt': `${routes.join('\r\n')}\r\n`,
    'trips.txt': `${trips.join('\r\n')}\r\n`,
    'stops.txt': `${stops.join('\r\n')}\r\n`,
    'stop_times.txt': `${stopTimes.join('\r\n')}\r\n`,
    'calendar.txt': `${calendars.join('\r\n')}\r\n`,
  });
}

describe('streaming Caltrain GTFS CSV normalization', () => {
  it('finalizes valid UTF-8 comma-delimited members from extensionless paths', async () => {
    const fixture = await createExtensionlessFixture();
    try {
      expect(
        Object.values(fixture.feed.streamingManifest?.members ?? {}).every(
          ({ uri }) => extname(uri) === '',
        ),
      ).toBe(true);

      const mutations = await collectMutations(fixture);
      expect(mutations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'entity_upsert',
            entity: expect.objectContaining({ entityKind: 'transit-service', routeId: 'RED' }),
          }),
          expect.objectContaining({
            kind: 'entity_upsert',
            entity: expect.objectContaining({
              entityKind: 'transit-stop',
              stopCode: 'PA',
              name: 'Palo Alto',
            }),
          }),
        ]),
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  }, 30_000);

  it('preserves legacy mutation parity for selected services, exceptions, parents, and pickup rules', async () => {
    const routes: readonly GtfsRow[] = Object.freeze([
      Object.freeze({
        route_id: 'RED',
        agency_id: '1000',
        route_short_name: 'R',
        route_long_name: 'Rail',
        route_type: '2',
      }),
      Object.freeze({
        route_id: 'BUS',
        agency_id: '1000',
        route_short_name: 'B',
        route_long_name: 'Bus',
        route_type: '3',
      }),
    ]);
    const trips: readonly GtfsRow[] = Object.freeze([
      Object.freeze({ route_id: 'RED', service_id: 'WKDY', trip_id: 'T1', trip_headsign: 'A' }),
      Object.freeze({ route_id: 'RED', service_id: 'WKDY', trip_id: 'T2', trip_headsign: 'B' }),
      Object.freeze({ route_id: 'BUS', service_id: 'SPECIAL', trip_id: 'T3', trip_headsign: 'C' }),
      Object.freeze({ route_id: 'BUS', service_id: 'REMOVED', trip_id: 'T4', trip_headsign: 'D' }),
    ]);
    const stops: readonly GtfsRow[] = Object.freeze([
      Object.freeze({
        stop_id: 'PARENT',
        stop_code: 'PARENT',
        stop_name: 'Parent',
        stop_lat: '37.4',
        stop_lon: '-122.1',
        location_type: '1',
        parent_station: '',
        platform_code: '',
      }),
      Object.freeze({
        stop_id: 'CHILD',
        stop_code: 'CHILD',
        stop_name: 'Child',
        stop_lat: '37.41',
        stop_lon: '-122.11',
        location_type: '0',
        parent_station: 'PARENT',
        platform_code: '1',
      }),
      Object.freeze({
        stop_id: 'ORPHAN',
        stop_code: 'ORPHAN',
        stop_name: 'Orphan',
        stop_lat: '37.42',
        stop_lon: '-122.12',
        location_type: '0',
        parent_station: 'MISSING',
        platform_code: '',
      }),
      Object.freeze({
        stop_id: 'INVALID',
        stop_code: 'INVALID',
        stop_name: 'Invalid',
        stop_lat: 'not-a-number',
        stop_lon: '-122.13',
        location_type: '0',
        parent_station: '',
        platform_code: '',
      }),
    ]);
    const calendars: readonly GtfsRow[] = Object.freeze(
      ['WKDY', 'REMOVED'].map((serviceId) =>
        Object.freeze({
          service_id: serviceId,
          monday: '1',
          tuesday: '1',
          wednesday: '1',
          thursday: '1',
          friday: '1',
          saturday: '0',
          sunday: '0',
          start_date: '20260131',
          end_date: '20270131',
        }),
      ),
    );
    const calendarDates: readonly GtfsRow[] = Object.freeze([
      Object.freeze({ service_id: 'SPECIAL', date: '20260610', exception_type: '1' }),
      Object.freeze({ service_id: 'REMOVED', date: '20260610', exception_type: '2' }),
    ]);
    const stopTimes: readonly GtfsRow[] = Object.freeze([
      Object.freeze({
        trip_id: 'T1',
        arrival_time: '08:00:00',
        departure_time: '08:00:00',
        stop_id: 'CHILD',
        stop_sequence: '1',
        pickup_type: '0',
        drop_off_type: '0',
      }),
      Object.freeze({
        trip_id: 'T2',
        arrival_time: '08:01:00',
        departure_time: '08:01:00',
        stop_id: 'ORPHAN',
        stop_sequence: '1',
        pickup_type: '1',
        drop_off_type: '0',
      }),
      Object.freeze({
        trip_id: 'T3',
        arrival_time: '09:00:00',
        departure_time: '09:00:00',
        stop_id: 'CHILD',
        stop_sequence: '1',
        pickup_type: '0',
        drop_off_type: '0',
      }),
      Object.freeze({
        trip_id: 'T4',
        arrival_time: '10:00:00',
        departure_time: '10:00:00',
        stop_id: 'PARENT',
        stop_sequence: '1',
        pickup_type: '0',
        drop_off_type: '0',
      }),
    ]);
    const fixture = await createExtensionlessFixture({
      'routes.txt':
        'route_id,agency_id,route_short_name,route_long_name,route_type\r\n' +
        'RED,1000,R,Rail,2\r\nBUS,1000,B,Bus,3\r\n',
      'trips.txt':
        'route_id,service_id,trip_id,trip_headsign\r\n' +
        'RED,WKDY,T1,A\r\nRED,WKDY,T2,B\r\nBUS,SPECIAL,T3,C\r\nBUS,REMOVED,T4,D\r\n',
      'stops.txt':
        'stop_id,stop_code,stop_name,stop_lat,stop_lon,location_type,parent_station,platform_code\r\n' +
        'PARENT,PARENT,Parent,37.4,-122.1,1,,\r\n' +
        'CHILD,CHILD,Child,37.41,-122.11,0,PARENT,1\r\n' +
        'ORPHAN,ORPHAN,Orphan,37.42,-122.12,0,MISSING,\r\n' +
        'INVALID,INVALID,Invalid,not-a-number,-122.13,0,,\r\n',
      'stop_times.txt':
        'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\r\n' +
        'T1,08:00:00,08:00:00,CHILD,1,0,0\r\n' +
        'T2,08:01:00,08:01:00,ORPHAN,1,1,0\r\n' +
        'T3,09:00:00,09:00:00,CHILD,1,0,0\r\n' +
        'T4,10:00:00,10:00:00,PARENT,1,0,0\r\n',
      'calendar.txt':
        'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\r\n' +
        'WKDY,1,1,1,1,1,0,0,20260131,20270131\r\n' +
        'REMOVED,1,1,1,1,1,0,0,20260131,20270131\r\n',
      'calendar_dates.txt':
        'service_id,date,exception_type\r\n' + 'SPECIAL,20260610,1\r\nREMOVED,20260610,2\r\n',
    });
    try {
      const legacyFeed: ValidatedGtfsFeed = Object.freeze({
        ...fixture.feed,
        routes,
        trips,
        stops,
        calendars,
        calendarDates,
        stopTimes,
      });
      const expected = createCanonicalTransitMutations(
        legacyFeed,
        normalizeTransitSnapshot(legacyFeed, CALTRAIN_2026_06_10_SNAPSHOT),
        CALTRAIN_2026_06_10_SNAPSHOT,
      );

      await expect(collectMutations(fixture)).resolves.toEqual(expected);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  }, 30_000);

  it('preserves only observed route/service pairs instead of a per-stop Cartesian product', async () => {
    const routes: readonly GtfsRow[] = Object.freeze([
      Object.freeze({
        route_id: 'R1',
        agency_id: '1000',
        route_short_name: '1',
        route_long_name: 'Route 1',
        route_type: '2',
      }),
      Object.freeze({
        route_id: 'R2',
        agency_id: '1000',
        route_short_name: '2',
        route_long_name: 'Route 2',
        route_type: '2',
      }),
    ]);
    const trips: readonly GtfsRow[] = Object.freeze([
      Object.freeze({ route_id: 'R1', service_id: 'S1', trip_id: 'T1', trip_headsign: 'A' }),
      Object.freeze({ route_id: 'R2', service_id: 'S2', trip_id: 'T2', trip_headsign: 'A' }),
      Object.freeze({ route_id: 'R1', service_id: 'S2', trip_id: 'T3', trip_headsign: 'B' }),
    ]);
    const stops: readonly GtfsRow[] = Object.freeze([
      Object.freeze({
        stop_id: 'A',
        stop_code: 'A',
        stop_name: 'Stop A',
        stop_lat: '37.4',
        stop_lon: '-122.1',
        location_type: '0',
        parent_station: '',
        platform_code: '',
      }),
      Object.freeze({
        stop_id: 'B',
        stop_code: 'B',
        stop_name: 'Stop B',
        stop_lat: '37.5',
        stop_lon: '-122.2',
        location_type: '0',
        parent_station: '',
        platform_code: '',
      }),
    ]);
    const calendars: readonly GtfsRow[] = Object.freeze(
      ['S1', 'S2'].map((serviceId) =>
        Object.freeze({
          service_id: serviceId,
          monday: '1',
          tuesday: '1',
          wednesday: '1',
          thursday: '1',
          friday: '1',
          saturday: '0',
          sunday: '0',
          start_date: '20260131',
          end_date: '20270131',
        }),
      ),
    );
    const stopTimes: readonly GtfsRow[] = Object.freeze([
      Object.freeze({
        trip_id: 'T1',
        arrival_time: '08:00:00',
        departure_time: '08:00:00',
        stop_id: 'A',
        stop_sequence: '1',
        pickup_type: '0',
        drop_off_type: '0',
      }),
      Object.freeze({
        trip_id: 'T2',
        arrival_time: '09:00:00',
        departure_time: '09:00:00',
        stop_id: 'A',
        stop_sequence: '1',
        pickup_type: '0',
        drop_off_type: '0',
      }),
      Object.freeze({
        trip_id: 'T3',
        arrival_time: '10:00:00',
        departure_time: '10:00:00',
        stop_id: 'B',
        stop_sequence: '1',
        pickup_type: '0',
        drop_off_type: '0',
      }),
    ]);
    const fixture = await createExtensionlessFixture({
      'routes.txt':
        'route_id,agency_id,route_short_name,route_long_name,route_type\r\n' +
        'R1,1000,1,Route 1,2\r\nR2,1000,2,Route 2,2\r\n',
      'trips.txt':
        'route_id,service_id,trip_id,trip_headsign\r\n' +
        'R1,S1,T1,A\r\nR2,S2,T2,A\r\nR1,S2,T3,B\r\n',
      'stops.txt':
        'stop_id,stop_code,stop_name,stop_lat,stop_lon,location_type,parent_station,platform_code\r\n' +
        'A,A,Stop A,37.4,-122.1,0,,\r\nB,B,Stop B,37.5,-122.2,0,,\r\n',
      'stop_times.txt':
        'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\r\n' +
        'T1,08:00:00,08:00:00,A,1,0,0\r\n' +
        'T2,09:00:00,09:00:00,A,1,0,0\r\n' +
        'T3,10:00:00,10:00:00,B,1,0,0\r\n',
      'calendar.txt':
        'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\r\n' +
        'S1,1,1,1,1,1,0,0,20260131,20270131\r\n' +
        'S2,1,1,1,1,1,0,0,20260131,20270131\r\n',
    });
    try {
      const legacyFeed: ValidatedGtfsFeed = Object.freeze({
        ...fixture.feed,
        routes,
        trips,
        stops,
        calendars,
        stopTimes,
      });
      const expected = createCanonicalTransitMutations(
        legacyFeed,
        normalizeTransitSnapshot(legacyFeed, CALTRAIN_2026_06_10_SNAPSHOT),
        CALTRAIN_2026_06_10_SNAPSHOT,
      );
      const actual = await collectMutations(fixture);
      expect(actual).toEqual(expected);

      const stopA = actual.find(
        (mutation) =>
          mutation.kind === 'entity_upsert' &&
          mutation.entity.entityKind === 'transit-stop' &&
          mutation.entity.stopCode === 'A',
      );
      if (stopA?.kind !== 'entity_upsert' || stopA.entity.entityKind !== 'transit-stop') {
        throw new Error('Expected canonical stop A mutation');
      }
      const canonicalServiceId = (routeId: string, serviceId: string): string =>
        `sc:entity:transit-service:${sha256(
          `${CALTRAIN_2026_06_10_SNAPSHOT.agencyId}|${routeId}|${serviceId}`,
        )}`;
      expect(stopA.entity.serviceIds).toEqual(
        [canonicalServiceId('R1', 'S1'), canonicalServiceId('R2', 'S2')].sort(),
      );
      expect(stopA.entity.serviceIds).not.toContain(canonicalServiceId('R1', 'S2'));
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  }, 30_000);

  it('does not skip or duplicate rows across full keyset-page boundaries', async () => {
    const serviceCount = REVIEWED_TRIP_PAGE_ROWS + 1;
    const stopCount = REVIEWED_STOP_PAGE_ROWS + 1;
    const fixture = await createExtensionlessFixture(
      generatedScaleMembers(serviceCount, stopCount),
    );
    try {
      const mutations = await collectMutations(fixture);
      expect(mutations).toHaveLength(serviceCount + stopCount);
      expect(new Set(mutations.map(({ mutationId }) => mutationId)).size).toBe(mutations.length);
      expect(mutations.map(({ sequence }) => sequence)).toEqual(
        Array.from({ length: mutations.length }, (_, index) => index),
      );
      expect(fixture.stats.maximumRows).toEqual([
        REVIEWED_TRIP_PAGE_ROWS,
        REVIEWED_TRIP_PAGE_ROWS,
        REVIEWED_STOP_PAGE_ROWS,
        REVIEWED_STOP_TIME_PAGE_ROWS,
        REVIEWED_STOP_PAGE_ROWS,
        REVIEWED_STOP_TIME_PAGE_ROWS,
      ]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  }, 30_000);

  it('fails duplicate stop IDs that straddle the page/lookahead boundary', async () => {
    const members = generatedScaleMembers(1, REVIEWED_STOP_PAGE_ROWS + 1);
    const stops = members['stops.txt'];
    if (stops === undefined) throw new Error('Expected generated stops member');
    const duplicateId = `P${(REVIEWED_STOP_PAGE_ROWS - 1).toString().padStart(5, '0')}`;
    const fixture = await createExtensionlessFixture({
      ...members,
      'stops.txt': `${stops}${duplicateId},${duplicateId},Duplicate,37.4,-122.1,0,,\r\n`,
    });
    try {
      await expect(collectMutations(fixture)).rejects.toThrow(`duplicate stop_id ${duplicateId}`);
      expect(fixture.stats.maximumRows).toEqual([REVIEWED_TRIP_PAGE_ROWS, REVIEWED_STOP_PAGE_ROWS]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  }, 30_000);

  it.each([
    { serviceCount: REVIEWED_TRIP_PAGE_ROWS, stopCount: REVIEWED_STOP_PAGE_ROWS * 2 },
    { serviceCount: REVIEWED_TRIP_PAGE_ROWS * 4, stopCount: REVIEWED_STOP_PAGE_ROWS * 8 },
  ])(
    'uses the exact page-linear query formula without per-stop N+1 scans ($serviceCount trips, $stopCount stops)',
    async ({ serviceCount, stopCount }) => {
      const fixture = await createExtensionlessFixture(
        generatedScaleMembers(serviceCount, stopCount),
      );
      try {
        const mutations = await collectMutations(fixture);
        const tripPages = Math.ceil(serviceCount / REVIEWED_TRIP_PAGE_ROWS);
        const stopPages = Math.ceil(stopCount / REVIEWED_STOP_PAGE_ROWS);
        const stopTimePages = stopPages;
        const expectedExecutions = tripPages + stopPages + stopTimePages;
        expect(mutations).toHaveLength(serviceCount + stopCount);
        expect(fixture.stats.executions).toBe(expectedExecutions);
        expect(fixture.stats.executions).toBeLessThan(stopCount);
        expect(fixture.stats.scannedBytes).toBe(
          fixture.totalMemberBytes * fixture.stats.executions,
        );
        expect(Math.max(...fixture.stats.maximumRows)).toBe(REVIEWED_STOP_TIME_PAGE_ROWS);
        expect(fixture.stats.queries).toHaveLength(expectedExecutions);
        for (const query of fixture.stats.queries) {
          const expectedWorstCaseScans =
            query.maximumRows === REVIEWED_TRIP_PAGE_ROWS
              ? 8
              : query.maximumRows === REVIEWED_STOP_PAGE_ROWS
                ? 2
                : 5;
          expect(query.maximumScanBytes).toBe(fixture.totalMemberBytes * expectedWorstCaseScans);
          expect(query.maximumScanBytes).toBeGreaterThanOrEqual(
            fixture.totalMemberBytes * query.csvReferences,
          );
          expect(query.scannedBytes).toBe(fixture.totalMemberBytes);
          expect(query.maximumRows).toBeLessThanOrEqual(REVIEWED_STOP_TIME_PAGE_ROWS);
          expect(query.statement).not.toMatch(/row_number|\blist\s*\(|\bdistinct\b/iu);
        }
      } finally {
        await rm(fixture.root, { force: true, recursive: true });
      }
    },
    60_000,
  );

  it('fails closed when one stop exceeds the bounded active service-pair limit', async () => {
    const fixture = await createExtensionlessFixture(
      generatedScaleMembers(MAX_SERVICE_PAIRS_PER_STOP + 1, 1, true),
    );
    try {
      await expect(collectMutations(fixture)).rejects.toThrow(
        `exceeds ${MAX_SERVICE_PAIRS_PER_STOP} active service pairs`,
      );
      expect(fixture.stats.executions).toBe(
        Math.ceil((MAX_SERVICE_PAIRS_PER_STOP + 1) / REVIEWED_TRIP_PAGE_ROWS) +
          1 +
          Math.ceil((MAX_SERVICE_PAIRS_PER_STOP + 1) / REVIEWED_STOP_TIME_PAGE_ROWS),
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  }, 60_000);

  it.each([
    ['an unterminated quoted field', 'RED,WKDY,T1,"unterminated\r\n'],
    [
      'a line above the bounded GTFS record size',
      `RED,WKDY,T1,"${'x'.repeat(MAX_GTFS_CSV_LINE_BYTES)}"\r\n`,
    ],
  ])(
    'rejects %s instead of silently skipping malformed extensionless data',
    async (_label, malformedRow) => {
      const fixture = await createExtensionlessFixture({
        'trips.txt': `route_id,service_id,trip_id,trip_headsign\r\n${malformedRow}`,
      });
      try {
        await expect(collectMutations(fixture)).rejects.toThrow();
      } finally {
        await rm(fixture.root, { force: true, recursive: true });
      }
    },
    30_000,
  );
});
