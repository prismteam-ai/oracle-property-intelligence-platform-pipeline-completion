/* GTFS column names are source data keys, and empty strings intentionally fall back. */
/* eslint-disable @typescript-eslint/dot-notation, @typescript-eslint/prefer-nullish-coalescing */
import { createHash } from 'node:crypto';

import {
  canonicalMutationSchema,
  type CanonicalMutation,
} from '@oracle/contracts/canonical/mutation';
import type { TransitService } from '@oracle/contracts/canonical/geospatial';
import type { StreamingNormalizationContext } from '../../spi/adapter.js';

import type {
  GtfsRow,
  NormalizedTransitSnapshot,
  NormalizedTransitStop,
  TransitFeedSnapshotConfig,
  ValidatedGtfsFeed,
} from './types.js';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

function parseGtfsDate(value: string): string {
  if (!/^\d{8}$/u.test(value)) throw new TypeError(`Invalid GTFS date: ${value}`);
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function compactGtfsDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new TypeError(`Expected selectedServiceDate in YYYY-MM-DD form: ${value}`);
  }
  return value.replaceAll('-', '');
}

function activeServicesForDate(
  calendars: readonly GtfsRow[],
  calendarDates: readonly GtfsRow[],
  selectedDate: string,
): ReadonlySet<string> {
  const compact = compactGtfsDate(selectedDate);
  const parsedDate = new Date(`${selectedDate}T00:00:00Z`);
  if (Number.isNaN(parsedDate.valueOf()))
    throw new TypeError(`Invalid service date: ${selectedDate}`);
  const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][
    parsedDate.getUTCDay()
  ];
  if (weekday === undefined) throw new Error('Weekday invariant violated');

  const active = new Set<string>();
  for (const calendar of calendars) {
    const serviceId = calendar['service_id'] ?? '';
    if (
      serviceId !== '' &&
      calendar[weekday] === '1' &&
      (calendar['start_date'] ?? '') <= compact &&
      (calendar['end_date'] ?? '') >= compact
    ) {
      active.add(serviceId);
    }
  }
  for (const exception of calendarDates) {
    if (exception['date'] !== compact) continue;
    const serviceId = exception['service_id'] ?? '';
    if (exception['exception_type'] === '1') active.add(serviceId);
    if (exception['exception_type'] === '2') active.delete(serviceId);
  }
  return active;
}

function numberOrNull(value: string | undefined, minimum: number, maximum: number): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function sortedRows(rows: readonly GtfsRow[], keys: readonly string[]): readonly GtfsRow[] {
  return Object.freeze(
    [...rows].sort(
      (left, right) =>
        keys
          .map((key) => (left[key] ?? '').localeCompare(right[key] ?? ''))
          .find((order) => order !== 0) ?? 0,
    ),
  );
}

export function normalizeTransitSnapshot(
  feed: ValidatedGtfsFeed,
  config: TransitFeedSnapshotConfig,
): NormalizedTransitSnapshot {
  const activeServiceIds = activeServicesForDate(
    feed.calendars,
    feed.calendarDates,
    config.selectedServiceDate,
  );
  const tripById = new Map(feed.trips.map((trip) => [trip['trip_id'] ?? '', trip]));
  const activeTripIds = new Set(
    feed.trips
      .filter((trip) => activeServiceIds.has(trip['service_id'] ?? ''))
      .map((trip) => trip['trip_id'] ?? ''),
  );
  const stopServices = new Map<string, Set<string>>();
  const stopRoutes = new Map<string, Set<string>>();
  const stopsAllowingPickup = new Set<string>();
  const stopsAllowingDropOff = new Set<string>();

  for (const time of feed.stopTimes) {
    const tripId = time['trip_id'] ?? '';
    if (!activeTripIds.has(tripId)) continue;
    const stopId = time['stop_id'] ?? '';
    const trip = tripById.get(tripId);
    if (trip === undefined || stopId === '') continue;
    const services = stopServices.get(stopId) ?? new Set<string>();
    services.add(trip['service_id'] ?? '');
    stopServices.set(stopId, services);
    const routes = stopRoutes.get(stopId) ?? new Set<string>();
    routes.add(trip['route_id'] ?? '');
    stopRoutes.set(stopId, routes);
    if ((time['pickup_type'] ?? '0') !== '1') stopsAllowingPickup.add(stopId);
    if ((time['drop_off_type'] ?? '0') !== '1') stopsAllowingDropOff.add(stopId);
  }

  const stopIds = new Set(feed.stops.map((stop) => stop['stop_id'] ?? ''));
  const stops: NormalizedTransitStop[] = feed.stops.map((stop) => {
    const stopId = stop['stop_id'] ?? '';
    const locationType = Number(
      stop['location_type'] === '' ? '0' : (stop['location_type'] ?? '0'),
    );
    const latitude = numberOrNull(stop['stop_lat'], -90, 90);
    const longitude = numberOrNull(stop['stop_lon'], -180, 180);
    const parent = stop['parent_station']?.trim() || null;
    const locationBoardable = locationType === 0 || locationType === 4;
    const active = (stopServices.get(stopId)?.size ?? 0) > 0;
    const pickupAllowed = active && stopsAllowingPickup.has(stopId);
    const dropOffAllowed = active && stopsAllowingDropOff.has(stopId);
    const exclusions: string[] = [];
    if (latitude === null || longitude === null) exclusions.push('missing_or_invalid_coordinates');
    if (!locationBoardable) exclusions.push('not_boardable_location_type');
    if (!active) exclusions.push('inactive_on_selected_service_date');
    if (active && !pickupAllowed) exclusions.push('pickup_forbidden');
    if (parent !== null && !stopIds.has(parent)) exclusions.push('orphan_parent_station');
    return Object.freeze({
      stopId,
      stopCode: stop['stop_code']?.trim() || stopId,
      name: stop['stop_name']?.trim() || stopId,
      latitude,
      longitude,
      locationType: Number.isInteger(locationType) ? locationType : -1,
      parentStation: parent,
      platformCode: stop['platform_code']?.trim() || null,
      boardable: locationBoardable && pickupAllowed,
      pickupAllowedOnSelectedDate: pickupAllowed,
      dropOffAllowedOnSelectedDate: dropOffAllowed,
      activeOnSelectedDate: active,
      routeIds: Object.freeze([...(stopRoutes.get(stopId) ?? [])].filter(Boolean).sort()),
      serviceIds: Object.freeze([...(stopServices.get(stopId) ?? [])].filter(Boolean).sort()),
      exclusionReasons: Object.freeze(exclusions.sort()),
    });
  });
  stops.sort((left, right) => left.stopId.localeCompare(right.stopId));

  return Object.freeze({
    operator: config.operator,
    role: config.role,
    sourceId: config.sourceId,
    artifactId: feed.artifactId,
    agencyId: config.agencyId,
    agencyName: config.agencyName,
    selectedServiceDate: config.selectedServiceDate,
    activeServiceIds: Object.freeze([...activeServiceIds].sort()),
    stops: Object.freeze(stops),
    eligibleDestinations: Object.freeze(stops.filter((stop) => stop.exclusionReasons.length === 0)),
    excludedDestinations: Object.freeze(stops.filter((stop) => stop.exclusionReasons.length > 0)),
    routes: sortedRows(feed.routes, ['route_id']),
    trips: sortedRows(feed.trips, ['trip_id']),
    calendars: sortedRows(feed.calendars, ['service_id']),
    calendarDates: sortedRows(feed.calendarDates, ['date', 'service_id']),
    transfers: sortedRows(feed.transfers, ['from_stop_id', 'to_stop_id']),
  });
}

function entityLineage(
  feed: ValidatedGtfsFeed,
  config: TransitFeedSnapshotConfig,
  recordKey: string,
  input: unknown,
  output: unknown,
) {
  const inputSha256 = sha256(stableJson(input));
  const outputSha256 = sha256(stableJson(output));
  const base = {
    sourceRecord: {
      sourceId: config.sourceId,
      snapshotId: `sc:snapshot:${config.sourceId.replace('sc:source:', '')}:${feed.bytes.sha256}`,
      artifactId: feed.artifactId,
      recordKey,
      recordSha256: inputSha256,
      rawPointer: recordKey,
    },
    transformations: [
      {
        name: 'normalize-gtfs-transit-v1',
        version: '1.0.0',
        appliedAt: config.retrievedAt,
        inputSha256,
        outputSha256,
      },
    ],
  };
  return { ...base, lineageSha256: sha256(stableJson(base)) };
}

function routeMode(routeType: string | undefined): TransitService['mode'] {
  if (routeType === '0') return 'tram';
  if (routeType === '2') return 'rail';
  if (routeType === '3') return 'bus';
  return 'other';
}

export function createCanonicalTransitMutations(
  feed: ValidatedGtfsFeed,
  snapshot: NormalizedTransitSnapshot,
  config: TransitFeedSnapshotConfig,
): readonly CanonicalMutation[] {
  const serviceIds = new Map<string, string>();
  const routeById = new Map(feed.routes.map((route) => [route['route_id'] ?? '', route]));
  const calendarById = new Map(
    feed.calendars.map((calendar) => [calendar['service_id'] ?? '', calendar]),
  );
  const mutations: CanonicalMutation[] = [];
  let sequence = 0;
  const runId = `sc:run:${sha256(`${config.sourceId}|${feed.bytes.sha256}|${config.selectedServiceDate}`)}`;
  const snapshotId = `sc:snapshot:${config.sourceId.replace('sc:source:', '')}:${feed.bytes.sha256}`;

  for (const trip of snapshot.trips) {
    const routeId = trip['route_id'] ?? '';
    const gtfsServiceId = trip['service_id'] ?? '';
    const key = `${routeId}|${gtfsServiceId}`;
    if (serviceIds.has(key) || !snapshot.activeServiceIds.includes(gtfsServiceId)) continue;
    const calendar = calendarById.get(gtfsServiceId);
    const route = routeById.get(routeId);
    const selectedCompactDate = config.selectedServiceDate.replaceAll('-', '');
    const selectedAddition = feed.calendarDates.find(
      (exception) =>
        exception['service_id'] === gtfsServiceId &&
        exception['date'] === selectedCompactDate &&
        exception['exception_type'] === '1',
    );
    if (route === undefined || (calendar === undefined && selectedAddition === undefined)) continue;
    const entityId = `sc:entity:transit-service:${sha256(`${config.agencyId}|${key}`)}`;
    serviceIds.set(key, entityId);
    const core = {
      agencyId: config.agencyId,
      routeId,
      mode: routeMode(route['route_type']),
      serviceStartDate:
        calendar === undefined
          ? config.selectedServiceDate
          : parseGtfsDate(calendar['start_date'] ?? ''),
      serviceEndDate:
        calendar === undefined
          ? config.selectedServiceDate
          : parseGtfsDate(calendar['end_date'] ?? ''),
    };
    const entity = {
      id: entityId,
      entityKind: 'transit-service' as const,
      version: 1,
      validFrom: config.retrievedAt,
      validTo: null,
      recordedAt: config.retrievedAt,
      visibility: config.visibility,
      sourceIds: [config.sourceId],
      lineage: [
        entityLineage(
          feed,
          config,
          `trips.txt:${trip['trip_id'] ?? ''}`,
          { trip, calendar: calendar ?? null, selectedAddition: selectedAddition ?? null },
          core,
        ),
      ],
      ...core,
    };
    mutations.push(
      canonicalMutationSchema.parse({
        kind: 'entity_upsert',
        mutationId: `sc:mutation:${sha256(`${feed.artifactId}|service|${entityId}`)}`,
        runId,
        sourceId: config.sourceId,
        snapshotId,
        sequence: sequence++,
        emittedAt: config.retrievedAt,
        visibility: config.visibility,
        entity,
      }),
    );
  }

  for (const stop of snapshot.stops) {
    if (stop.latitude === null || stop.longitude === null) continue;
    const parentStopId =
      stop.parentStation === null
        ? null
        : `sc:entity:transit-stop:${sha256(`${config.agencyId}|${stop.parentStation}`)}`;
    const canonicalServiceIds = snapshot.trips
      .filter(
        (trip) =>
          stop.serviceIds.includes(trip['service_id'] ?? '') &&
          stop.routeIds.includes(trip['route_id'] ?? ''),
      )
      .map((trip) => serviceIds.get(`${trip['route_id'] ?? ''}|${trip['service_id'] ?? ''}`))
      .filter((id): id is string => id !== undefined)
      .filter((id, index, all) => all.indexOf(id) === index)
      .sort();
    const core = {
      agencyId: config.agencyId,
      stopCode: stop.stopCode,
      name: stop.name,
      location: { type: 'Point' as const, coordinates: [stop.longitude, stop.latitude] },
      parentStopId,
      boardable: stop.boardable,
      serviceIds: canonicalServiceIds,
    };
    const entityId = `sc:entity:transit-stop:${sha256(`${config.agencyId}|${stop.stopId}`)}`;
    const entity = {
      id: entityId,
      entityKind: 'transit-stop' as const,
      version: 1,
      validFrom: config.retrievedAt,
      validTo: null,
      recordedAt: config.retrievedAt,
      visibility: config.visibility,
      sourceIds: [config.sourceId],
      lineage: [entityLineage(feed, config, `stops.txt:${stop.stopId}`, stop, core)],
      ...core,
    };
    mutations.push(
      canonicalMutationSchema.parse({
        kind: 'entity_upsert',
        mutationId: `sc:mutation:${sha256(`${feed.artifactId}|stop|${entityId}`)}`,
        runId,
        sourceId: config.sourceId,
        snapshotId,
        sequence: sequence++,
        emittedAt: config.retrievedAt,
        visibility: config.visibility,
        entity,
      }),
    );
  }

  return Object.freeze(mutations);
}

const GTFS_ANALYTICAL_OPERATION = 'decode_gtfs_bounded_finalize';
const GTFS_QUERY_TIMEOUT_MS = 120_000;
const MAX_GTFS_CSV_LINE_BYTES = 1024 * 1024;
const MAX_SERVICE_PAIRS_PER_STOP = 4096;
const GTFS_CSV_SOURCE = `read_csv_auto(?,
  delim = ',',
  quote = '"',
  escape = '"',
  header = true,
  all_varchar = true,
  encoding = 'utf-8',
  nullstr = '__ORACLE_GTFS_NULL__',
  allow_quoted_nulls = false,
  null_padding = false,
  strict_mode = true,
  max_line_size = ${MAX_GTFS_CSV_LINE_BYTES}
)`;

function csvSource(
  uri: string | undefined,
  columns: readonly string[],
): Readonly<{
  sql: string;
  parameters: readonly string[];
}> {
  if (uri !== undefined) {
    return Object.freeze({
      sql: GTFS_CSV_SOURCE,
      parameters: Object.freeze([uri]),
    });
  }
  return Object.freeze({
    sql: `(SELECT ${columns.map((column) => `CAST(NULL AS VARCHAR) AS ${column}`).join(', ')} WHERE false)`,
    parameters: Object.freeze([]),
  });
}

function jsonRow(value: unknown, label: string): GtfsRow {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`GTFS analytical ${label} is not an object`);
  }
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (item !== null && item !== undefined) output[key] = String(item);
  }
  return Object.freeze(output);
}

function nullableJsonRow(value: unknown, label: string): GtfsRow | undefined {
  if (value === null || value === undefined) return undefined;
  const row = jsonRow(value, label);
  return Object.keys(row).length === 0 ? undefined : row;
}

function rowString(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new TypeError(`GTFS analytical row is missing ${key}`);
  return value;
}

function rowBoolean(row: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = row[key];
  if (typeof value !== 'boolean') throw new TypeError(`GTFS analytical row is missing ${key}`);
  return value;
}

function streamingFeedBase(feed: ValidatedGtfsFeed): ValidatedGtfsFeed {
  return Object.freeze({
    ...feed,
    agency: Object.freeze([]),
    stops: Object.freeze([]),
    routes: Object.freeze([]),
    trips: Object.freeze([]),
    calendars: Object.freeze([]),
    calendarDates: Object.freeze([]),
    stopTimes: Object.freeze([]),
    transfers: Object.freeze([]),
  });
}

/** Emits legacy-parity GTFS mutations from one-row analytical pages over immutable CSV members. */
export async function* createStreamingCanonicalTransitMutations(
  feed: ValidatedGtfsFeed,
  config: TransitFeedSnapshotConfig,
  context: StreamingNormalizationContext,
): AsyncIterable<CanonicalMutation> {
  const manifest = feed.streamingManifest;
  if (manifest === undefined) throw new TypeError('Streaming GTFS finalize requires a manifest');
  const memberUri = (name: string): string | undefined => manifest.members[name]?.uri;
  const tripsUri = memberUri('trips.txt');
  const routesUri = memberUri('routes.txt');
  const stopsUri = memberUri('stops.txt');
  const stopTimesUri = memberUri('stop_times.txt');
  if (
    tripsUri === undefined ||
    routesUri === undefined ||
    stopsUri === undefined ||
    stopTimesUri === undefined
  ) {
    throw new TypeError('Streaming GTFS manifest is missing a required member');
  }
  const calendars = csvSource(memberUri('calendar.txt'), [
    'service_id',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
    'start_date',
    'end_date',
  ]);
  const calendarDates = csvSource(memberUri('calendar_dates.txt'), [
    'service_id',
    'date',
    'exception_type',
  ]);
  const selectedCompactDate = compactGtfsDate(config.selectedServiceDate);
  const parsedDate = new Date(`${config.selectedServiceDate}T00:00:00Z`);
  const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][
    parsedDate.getUTCDay()
  ];
  if (weekday === undefined) throw new TypeError('GTFS selected service weekday is invalid');
  const session = await context.analyticalRuntime.open(
    {
      releaseId: `${config.sourceId}:gtfs-derived-v1`,
      manifestUri: manifest.uri,
      manifestSha256: manifest.sha256,
    },
    context.signal,
  );
  const baseFeed = streamingFeedBase(feed);
  const runId = `sc:run:${sha256(`${config.sourceId}|${feed.bytes.sha256}|${config.selectedServiceDate}`)}`;
  const snapshotId = `sc:snapshot:${config.sourceId.replace('sc:source:', '')}:${feed.bytes.sha256}`;
  let sequence = 0;
  try {
    const commonCtes = `
      trips AS (SELECT * FROM ${GTFS_CSV_SOURCE}),
      routes AS (SELECT * FROM ${GTFS_CSV_SOURCE}),
      calendars AS (SELECT * FROM ${calendars.sql}),
      calendar_dates AS (SELECT * FROM ${calendarDates.sql}),
      active_services AS (
        SELECT service_id FROM calendars
        WHERE coalesce(${weekday}, '') = '1'
          AND coalesce(start_date, '') <= ? AND coalesce(end_date, '') >= ?
        UNION
        SELECT service_id FROM calendar_dates WHERE date = ? AND exception_type = '1'
        EXCEPT
        SELECT service_id FROM calendar_dates WHERE date = ? AND exception_type = '2'
      )`;
    const commonParameters = Object.freeze([
      tripsUri,
      routesUri,
      ...calendars.parameters,
      ...calendarDates.parameters,
      selectedCompactDate,
      selectedCompactDate,
      selectedCompactDate,
      selectedCompactDate,
    ]);
    let lastTripId = '';
    for (;;) {
      context.signal.throwIfAborted();
      const result = await session.execute({
        operation: GTFS_ANALYTICAL_OPERATION,
        statement: `WITH ${commonCtes},
          ranked AS (
            SELECT trip_id, row_number() OVER (
              PARTITION BY route_id, service_id ORDER BY trip_id
            ) AS occurrence
            FROM trips WHERE service_id IN (SELECT service_id FROM active_services)
          )
          SELECT t.trip_id AS page_key, to_json(t) AS trip_json,
                 to_json(r) AS route_json, to_json(c) AS calendar_json,
                 to_json(d) AS addition_json
          FROM ranked x
          JOIN trips t ON t.trip_id = x.trip_id
          JOIN routes r ON r.route_id = t.route_id
          LEFT JOIN calendars c ON c.service_id = t.service_id
          LEFT JOIN calendar_dates d ON d.service_id = t.service_id
             AND d.date = ? AND d.exception_type = '1'
          WHERE x.occurrence = 1 AND t.trip_id > ?
            AND (c.service_id IS NOT NULL OR d.service_id IS NOT NULL)
          ORDER BY t.trip_id`,
        parameters: [...commonParameters, selectedCompactDate, lastTripId],
        timeoutMs: GTFS_QUERY_TIMEOUT_MS,
        maximumScanBytes: manifest.totalMemberBytes,
        maximumRows: 1,
        signal: context.signal,
      });
      const row = result.rows[0];
      if (row === undefined) break;
      const trip = jsonRow(row['trip_json'], 'trip');
      const route = jsonRow(row['route_json'], 'route');
      const calendar = nullableJsonRow(row['calendar_json'], 'calendar');
      const selectedAddition = nullableJsonRow(row['addition_json'], 'calendar date');
      const routeId = trip['route_id'] ?? '';
      const gtfsServiceId = trip['service_id'] ?? '';
      const key = `${routeId}|${gtfsServiceId}`;
      const entityId = `sc:entity:transit-service:${sha256(`${config.agencyId}|${key}`)}`;
      const core = {
        agencyId: config.agencyId,
        routeId,
        mode: routeMode(route['route_type']),
        serviceStartDate:
          calendar === undefined
            ? config.selectedServiceDate
            : parseGtfsDate(calendar['start_date'] ?? ''),
        serviceEndDate:
          calendar === undefined
            ? config.selectedServiceDate
            : parseGtfsDate(calendar['end_date'] ?? ''),
      };
      const entity = {
        id: entityId,
        entityKind: 'transit-service' as const,
        version: 1,
        validFrom: config.retrievedAt,
        validTo: null,
        recordedAt: config.retrievedAt,
        visibility: config.visibility,
        sourceIds: [config.sourceId],
        lineage: [
          entityLineage(
            baseFeed,
            config,
            `trips.txt:${trip['trip_id'] ?? ''}`,
            { trip, calendar: calendar ?? null, selectedAddition: selectedAddition ?? null },
            core,
          ),
        ],
        ...core,
      };
      yield canonicalMutationSchema.parse({
        kind: 'entity_upsert',
        mutationId: `sc:mutation:${sha256(`${feed.artifactId}|service|${entityId}`)}`,
        runId,
        sourceId: config.sourceId,
        snapshotId,
        sequence: sequence++,
        emittedAt: config.retrievedAt,
        visibility: config.visibility,
        entity,
      });
      lastTripId = rowString(row, 'page_key');
      if (!result.truncated) break;
    }

    let lastStopId = '';
    for (;;) {
      context.signal.throwIfAborted();
      const result = await session.execute({
        operation: GTFS_ANALYTICAL_OPERATION,
        statement: `WITH ${commonCtes},
          active_trips AS (
            SELECT * FROM trips WHERE service_id IN (SELECT service_id FROM active_services)
          ),
          stop_activity AS (
            SELECT st.stop_id,
                   count(*) > 0 AS active,
                   bool_or(coalesce(st.pickup_type, '0') <> '1') AS pickup_allowed,
                   bool_or(coalesce(st.drop_off_type, '0') <> '1') AS dropoff_allowed
            FROM ${GTFS_CSV_SOURCE} st
            JOIN active_trips t ON t.trip_id = st.trip_id
            GROUP BY st.stop_id
          )
          SELECT s.stop_id AS page_key, to_json(s) AS stop_json,
                 coalesce(a.active, false) AS active,
                 coalesce(a.pickup_allowed, false) AS pickup_allowed,
                 coalesce(a.dropoff_allowed, false) AS dropoff_allowed,
                 CASE WHEN coalesce(s.parent_station, '') = '' THEN true
                      ELSE EXISTS (
                        SELECT 1 FROM ${GTFS_CSV_SOURCE} p
                        WHERE p.stop_id = s.parent_station
                      ) END AS parent_exists
          FROM ${GTFS_CSV_SOURCE} s
          LEFT JOIN stop_activity a ON a.stop_id = s.stop_id
          WHERE s.stop_id > ? ORDER BY s.stop_id`,
        parameters: [...commonParameters, stopTimesUri, stopsUri, stopsUri, lastStopId],
        timeoutMs: GTFS_QUERY_TIMEOUT_MS,
        maximumScanBytes: manifest.totalMemberBytes,
        maximumRows: 1,
        signal: context.signal,
      });
      const row = result.rows[0];
      if (row === undefined) break;
      const stopRow = jsonRow(row['stop_json'], 'stop');
      const stopId = stopRow['stop_id'] ?? '';
      const routeIds = new Set<string>();
      const serviceIds = new Set<string>();
      const canonicalServiceIds = new Set<string>();
      let lastRouteId = '';
      let lastServiceId = '';
      let pairCount = 0;
      for (;;) {
        const pairs = await session.execute({
          operation: GTFS_ANALYTICAL_OPERATION,
          statement: `WITH ${commonCtes},
            active_trips AS (
              SELECT * FROM trips WHERE service_id IN (SELECT service_id FROM active_services)
            )
            SELECT DISTINCT t.route_id, t.service_id
            FROM ${GTFS_CSV_SOURCE} st
            JOIN active_trips t ON t.trip_id = st.trip_id
            WHERE st.stop_id = ?
              AND (t.route_id > ? OR (t.route_id = ? AND t.service_id > ?))
            ORDER BY t.route_id, t.service_id`,
          parameters: [
            ...commonParameters,
            stopTimesUri,
            stopId,
            lastRouteId,
            lastRouteId,
            lastServiceId,
          ],
          timeoutMs: GTFS_QUERY_TIMEOUT_MS,
          maximumScanBytes: manifest.totalMemberBytes,
          maximumRows: 1,
          signal: context.signal,
        });
        const pair = pairs.rows[0];
        if (pair === undefined) break;
        lastRouteId = rowString(pair, 'route_id');
        lastServiceId = rowString(pair, 'service_id');
        routeIds.add(lastRouteId);
        serviceIds.add(lastServiceId);
        canonicalServiceIds.add(
          `sc:entity:transit-service:${sha256(`${config.agencyId}|${lastRouteId}|${lastServiceId}`)}`,
        );
        pairCount += 1;
        if (pairCount > MAX_SERVICE_PAIRS_PER_STOP) {
          throw new Error(
            `GTFS stop ${stopId} exceeds ${MAX_SERVICE_PAIRS_PER_STOP} active service pairs`,
          );
        }
        if (!pairs.truncated) break;
      }
      const locationType = Number(
        stopRow['location_type'] === '' ? '0' : (stopRow['location_type'] ?? '0'),
      );
      const latitude = numberOrNull(stopRow['stop_lat'], -90, 90);
      const longitude = numberOrNull(stopRow['stop_lon'], -180, 180);
      const parent = stopRow['parent_station']?.trim() || null;
      const locationBoardable = locationType === 0 || locationType === 4;
      const active = rowBoolean(row, 'active');
      const pickupAllowed = active && rowBoolean(row, 'pickup_allowed');
      const dropOffAllowed = active && rowBoolean(row, 'dropoff_allowed');
      const exclusions: string[] = [];
      if (latitude === null || longitude === null)
        exclusions.push('missing_or_invalid_coordinates');
      if (!locationBoardable) exclusions.push('not_boardable_location_type');
      if (!active) exclusions.push('inactive_on_selected_service_date');
      if (active && !pickupAllowed) exclusions.push('pickup_forbidden');
      if (parent !== null && !rowBoolean(row, 'parent_exists'))
        exclusions.push('orphan_parent_station');
      const normalizedStop: NormalizedTransitStop = Object.freeze({
        stopId,
        stopCode: stopRow['stop_code']?.trim() || stopId,
        name: stopRow['stop_name']?.trim() || stopId,
        latitude,
        longitude,
        locationType: Number.isInteger(locationType) ? locationType : -1,
        parentStation: parent,
        platformCode: stopRow['platform_code']?.trim() || null,
        boardable: locationBoardable && pickupAllowed,
        pickupAllowedOnSelectedDate: pickupAllowed,
        dropOffAllowedOnSelectedDate: dropOffAllowed,
        activeOnSelectedDate: active,
        routeIds: Object.freeze([...routeIds].sort()),
        serviceIds: Object.freeze([...serviceIds].sort()),
        exclusionReasons: Object.freeze(exclusions.sort()),
      });
      if (latitude !== null && longitude !== null) {
        const parentStopId =
          parent === null
            ? null
            : `sc:entity:transit-stop:${sha256(`${config.agencyId}|${parent}`)}`;
        const core = {
          agencyId: config.agencyId,
          stopCode: normalizedStop.stopCode,
          name: normalizedStop.name,
          location: { type: 'Point' as const, coordinates: [longitude, latitude] },
          parentStopId,
          boardable: normalizedStop.boardable,
          serviceIds: Object.freeze([...canonicalServiceIds].sort()),
        };
        const entityId = `sc:entity:transit-stop:${sha256(`${config.agencyId}|${stopId}`)}`;
        const entity = {
          id: entityId,
          entityKind: 'transit-stop' as const,
          version: 1,
          validFrom: config.retrievedAt,
          validTo: null,
          recordedAt: config.retrievedAt,
          visibility: config.visibility,
          sourceIds: [config.sourceId],
          lineage: [entityLineage(baseFeed, config, `stops.txt:${stopId}`, normalizedStop, core)],
          ...core,
        };
        yield canonicalMutationSchema.parse({
          kind: 'entity_upsert',
          mutationId: `sc:mutation:${sha256(`${feed.artifactId}|stop|${entityId}`)}`,
          runId,
          sourceId: config.sourceId,
          snapshotId,
          sequence: sequence++,
          emittedAt: config.retrievedAt,
          visibility: config.visibility,
          entity,
        });
      }
      lastStopId = rowString(row, 'page_key');
      if (!result.truncated) break;
    }
  } finally {
    await session[Symbol.asyncDispose]();
  }
}
