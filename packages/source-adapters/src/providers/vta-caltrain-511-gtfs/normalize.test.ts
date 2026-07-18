import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

import type { CanonicalMutation } from '@oracle/contracts/canonical/mutation';
import { artifactIdSchema } from '@oracle/contracts/ids';
import { DuckDBAnalyticalRuntime } from '@oracle/data-runtime/duckdb/duckdb-analytical-runtime';
import { describe, expect, it } from 'vitest';

import { createImmutableBytes } from '../../spi/bytes.js';
import { createStreamingCanonicalTransitMutations } from './normalize.js';
import { CALTRAIN_2026_06_10_SNAPSHOT } from './snapshots.js';
import type { StreamingGtfsMember, ValidatedGtfsFeed } from './types.js';

const GTFS_OPERATION = 'decode_gtfs_bounded_finalize';
const MAX_GTFS_CSV_LINE_BYTES = 1024 * 1024;

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

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function createExtensionlessFixture(
  overrides: Readonly<Record<string, string>> = {},
): Promise<Readonly<{ root: string; feed: ValidatedGtfsFeed; runtime: DuckDBAnalyticalRuntime }>> {
  const root = await mkdtemp(join(tmpdir(), 'oracle-caltrain-extensionless-'));
  const encoder = new TextEncoder();
  const members: Record<string, StreamingGtfsMember> = {};
  let totalMemberBytes = 0;
  let index = 0;

  for (const [name, defaultContent] of Object.entries(caltrainMembers)) {
    const bytes = encoder.encode(overrides[name] ?? defaultContent);
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
  const runtime = new DuckDBAnalyticalRuntime({
    loadSnapshot: () =>
      Promise.resolve({
        manifestBytes,
        scanBytesByOperation: Object.freeze({ [GTFS_OPERATION]: totalMemberBytes }),
      }),
    nowMilliseconds: () => Date.now(),
  });
  return Object.freeze({ root, feed, runtime });
}

async function collectMutations(
  fixture: Readonly<{ feed: ValidatedGtfsFeed; runtime: DuckDBAnalyticalRuntime }>,
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
