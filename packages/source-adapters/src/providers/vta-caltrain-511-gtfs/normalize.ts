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

const GTFS_TRANSFORM_VERSION = '1.1.0';

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
        name: 'normalize-gtfs-transit',
        version: GTFS_TRANSFORM_VERSION,
        appliedAt: config.retrievedAt,
        inputSha256,
        outputSha256,
      },
    ],
  };
  return { ...base, lineageSha256: sha256(stableJson(base)) };
}

function fieldObservationMutations(
  feed: ValidatedGtfsFeed,
  config: TransitFeedSnapshotConfig,
  snapshotId: string,
  runId: string,
  entityId: string,
  entityKind: 'transit-service' | 'transit-stop',
  recordKey: string,
  input: unknown,
  values: Readonly<Record<string, unknown>>,
  firstSequence: number,
): readonly CanonicalMutation[] {
  const sourceAsOf = config.sourceAsOf.state === 'unknown' ? null : config.sourceAsOf.at;
  return Object.freeze(
    Object.entries(values).map(([field, value], index) => {
      const fieldPath = `/${field}`;
      return canonicalMutationSchema.parse({
        kind: 'field_observation',
        mutationId: `sc:mutation:${sha256(
          `${feed.artifactId}|${entityKind}|${entityId}|${fieldPath}|${GTFS_TRANSFORM_VERSION}`,
        )}`,
        runId,
        sourceId: config.sourceId,
        snapshotId,
        sequence: firstSequence + index,
        emittedAt: config.retrievedAt,
        visibility: config.visibility,
        observation: {
          observationId: `sc:observation:${sha256(
            `${snapshotId}|${feed.artifactId}|${recordKey}|${entityId}|${fieldPath}|${GTFS_TRANSFORM_VERSION}`,
          )}`,
          entityId,
          entityKind,
          fieldPath,
          value,
          observedAt: sourceAsOf ?? config.retrievedAt,
          sourceAsOf,
          authorityRank: config.role === 'operator_primary' ? 1 : 20,
          confidence: 1,
          visibility: config.visibility,
          lineage: entityLineage(feed, config, recordKey, input, value),
        },
      });
    }),
  );
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
  const runId = `sc:run:${sha256(
    `${config.sourceId}|${feed.bytes.sha256}|${config.selectedServiceDate}|${GTFS_TRANSFORM_VERSION}`,
  )}`;
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
    const sourceInput = {
      trip,
      calendar: calendar ?? null,
      selectedAddition: selectedAddition ?? null,
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
        entityLineage(feed, config, `trips.txt:${trip['trip_id'] ?? ''}`, sourceInput, core),
      ],
      ...core,
    };
    mutations.push(
      canonicalMutationSchema.parse({
        kind: 'entity_upsert',
        mutationId: `sc:mutation:${sha256(
          `${feed.artifactId}|service|${entityId}|${GTFS_TRANSFORM_VERSION}`,
        )}`,
        runId,
        sourceId: config.sourceId,
        snapshotId,
        sequence: sequence++,
        emittedAt: config.retrievedAt,
        visibility: config.visibility,
        entity,
      }),
    );
    const observations = fieldObservationMutations(
      feed,
      config,
      snapshotId,
      runId,
      entityId,
      'transit-service',
      `trips.txt:${trip['trip_id'] ?? ''}`,
      sourceInput,
      core,
      sequence,
    );
    mutations.push(...observations);
    sequence += observations.length;
  }

  const emittedServicePairByTripId = new Map<string, string>();
  for (const trip of snapshot.trips) {
    const tripId = trip['trip_id'] ?? '';
    const key = `${trip['route_id'] ?? ''}|${trip['service_id'] ?? ''}`;
    if (tripId !== '' && serviceIds.has(key)) emittedServicePairByTripId.set(tripId, key);
  }
  const observedServicePairsByStopId = new Map<string, Set<string>>();
  for (const stopTime of feed.stopTimes) {
    const stopId = stopTime['stop_id'] ?? '';
    const key = emittedServicePairByTripId.get(stopTime['trip_id'] ?? '');
    if (stopId === '' || key === undefined) continue;
    const pairs = observedServicePairsByStopId.get(stopId) ?? new Set<string>();
    pairs.add(key);
    observedServicePairsByStopId.set(stopId, pairs);
  }

  for (const stop of snapshot.stops) {
    if (stop.latitude === null || stop.longitude === null) continue;
    const parentStopId =
      stop.parentStation === null
        ? null
        : `sc:entity:transit-stop:${sha256(`${config.agencyId}|${stop.parentStation}`)}`;
    const canonicalServiceIds = [...(observedServicePairsByStopId.get(stop.stopId) ?? [])]
      .map((key) => serviceIds.get(key))
      .filter((id): id is string => id !== undefined)
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
        mutationId: `sc:mutation:${sha256(
          `${feed.artifactId}|stop|${entityId}|${GTFS_TRANSFORM_VERSION}`,
        )}`,
        runId,
        sourceId: config.sourceId,
        snapshotId,
        sequence: sequence++,
        emittedAt: config.retrievedAt,
        visibility: config.visibility,
        entity,
      }),
    );
    const observations = fieldObservationMutations(
      feed,
      config,
      snapshotId,
      runId,
      entityId,
      'transit-stop',
      `stops.txt:${stop.stopId}`,
      stop,
      core,
      sequence,
    );
    mutations.push(...observations);
    sequence += observations.length;
  }

  return Object.freeze(mutations);
}

const GTFS_ANALYTICAL_OPERATION = 'decode_gtfs_bounded_finalize';
const GTFS_QUERY_TIMEOUT_MS = 120_000;
const MAX_GTFS_CSV_LINE_BYTES = 1024 * 1024;
const GTFS_TRIP_PAGE_ROWS = 256;
const GTFS_STOP_PAGE_ROWS = 128;
const GTFS_STOP_TIME_PAGE_ROWS = 1024;
const MAX_ACTIVE_SERVICE_PAIRS = 65_536;
const MAX_SERVICE_PAIRS_PER_STOP = 4096;
// Conservative physical-read ceilings if DuckDB inlines every reused CSV-backed CTE.
const GTFS_TRIP_QUERY_WORST_CASE_SCANS = 8;
const GTFS_STOP_QUERY_WORST_CASE_SCANS = 2;
const GTFS_STOP_TIME_QUERY_WORST_CASE_SCANS = 5;
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

function rowNullableString(row: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new TypeError(`GTFS analytical row has an invalid ${key}`);
  return value;
}

function rowBoolean(row: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = row[key];
  if (typeof value !== 'boolean') throw new TypeError(`GTFS analytical row is missing ${key}`);
  return value;
}

function conservativeScanBudget(totalMemberBytes: number, csvReferences: number): number {
  const budget = totalMemberBytes * csvReferences;
  if (!Number.isSafeInteger(budget) || budget <= 0) {
    throw new RangeError('GTFS analytical worst-case scan budget is not a positive safe integer');
  }
  return budget;
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

/** Emits legacy-parity GTFS mutations from bounded keyset pages over immutable CSV members. */
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
  const runId = `sc:run:${sha256(
    `${config.sourceId}|${feed.bytes.sha256}|${config.selectedServiceDate}|${GTFS_TRANSFORM_VERSION}`,
  )}`;
  const snapshotId = `sc:snapshot:${config.sourceId.replace('sc:source:', '')}:${feed.bytes.sha256}`;
  let sequence = 0;
  try {
    const activeServicePredicate = (tripAlias: string): string => `(
      (EXISTS (
        SELECT 1 FROM calendars c
        WHERE c.service_id = ${tripAlias}.service_id
          AND coalesce(c.${weekday}, '') = '1'
          AND coalesce(c.start_date, '') <= ? AND coalesce(c.end_date, '') >= ?
      ) OR EXISTS (
        SELECT 1 FROM calendar_dates added
        WHERE added.service_id = ${tripAlias}.service_id
          AND added.date = ? AND added.exception_type = '1'
      )) AND NOT EXISTS (
        SELECT 1 FROM calendar_dates removed
        WHERE removed.service_id = ${tripAlias}.service_id
          AND removed.date = ? AND removed.exception_type = '2'
      )
    )`;
    const activeServiceParameters = Object.freeze([
      selectedCompactDate,
      selectedCompactDate,
      selectedCompactDate,
      selectedCompactDate,
    ]);
    const activeServicePairs = new Set<string>();
    let lastTripId = '';
    let lastTripRouteId = '';
    let lastTripServiceId = '';
    let hasTripCursor = false;
    for (;;) {
      context.signal.throwIfAborted();
      const tripCursorSql = hasTripCursor
        ? `(t.trip_id > ? OR (t.trip_id = ? AND (t.route_id > ?
             OR (t.route_id = ? AND t.service_id > ?))))`
        : 'true';
      const tripCursorParameters = hasTripCursor
        ? [lastTripId, lastTripId, lastTripRouteId, lastTripRouteId, lastTripServiceId]
        : [];
      const result = await session.execute({
        operation: GTFS_ANALYTICAL_OPERATION,
        statement: `WITH
          trips AS (SELECT * FROM ${GTFS_CSV_SOURCE}),
          routes AS (SELECT * FROM ${GTFS_CSV_SOURCE}),
          calendars AS (SELECT * FROM ${calendars.sql}),
          calendar_dates AS (SELECT * FROM ${calendarDates.sql}),
          trip_page AS MATERIALIZED (
            SELECT t.* FROM trips t
            WHERE ${tripCursorSql}
              AND ${activeServicePredicate('t')}
              AND EXISTS (SELECT 1 FROM routes r WHERE r.route_id = t.route_id)
            ORDER BY t.trip_id, t.route_id, t.service_id
            LIMIT ${GTFS_TRIP_PAGE_ROWS + 1}
          )
          SELECT t.trip_id AS page_trip_id, t.route_id AS page_route_id,
                 t.service_id AS page_service_id, to_json(t) AS trip_json,
                 to_json(r) AS route_json, to_json(c) AS calendar_json,
                 to_json(d) AS addition_json
          FROM trip_page t
          JOIN routes r ON r.route_id = t.route_id
          LEFT JOIN calendars c ON c.service_id = t.service_id
          LEFT JOIN calendar_dates d ON d.service_id = t.service_id
             AND d.date = ? AND d.exception_type = '1'
          ORDER BY t.trip_id, t.route_id, t.service_id`,
        parameters: [
          tripsUri,
          routesUri,
          ...calendars.parameters,
          ...calendarDates.parameters,
          ...tripCursorParameters,
          ...activeServiceParameters,
          selectedCompactDate,
        ],
        timeoutMs: GTFS_QUERY_TIMEOUT_MS,
        maximumScanBytes: conservativeScanBudget(
          manifest.totalMemberBytes,
          GTFS_TRIP_QUERY_WORST_CASE_SCANS,
        ),
        maximumRows: GTFS_TRIP_PAGE_ROWS,
        signal: context.signal,
      });
      if (result.rows.length === 0) break;
      for (const row of result.rows) {
        context.signal.throwIfAborted();
        lastTripId = rowString(row, 'page_trip_id');
        lastTripRouteId = rowString(row, 'page_route_id');
        lastTripServiceId = rowString(row, 'page_service_id');
        hasTripCursor = true;
        const trip = jsonRow(row['trip_json'], 'trip');
        const routeId = trip['route_id'] ?? '';
        const gtfsServiceId = trip['service_id'] ?? '';
        const key = `${routeId}|${gtfsServiceId}`;
        if (activeServicePairs.has(key)) continue;
        if (activeServicePairs.size >= MAX_ACTIVE_SERVICE_PAIRS) {
          throw new Error(`GTFS feed exceeds ${MAX_ACTIVE_SERVICE_PAIRS} active service pairs`);
        }
        activeServicePairs.add(key);
        const route = jsonRow(row['route_json'], 'route');
        const calendar = nullableJsonRow(row['calendar_json'], 'calendar');
        const selectedAddition = nullableJsonRow(row['addition_json'], 'calendar date');
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
        const sourceInput = {
          trip,
          calendar: calendar ?? null,
          selectedAddition: selectedAddition ?? null,
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
              sourceInput,
              core,
            ),
          ],
          ...core,
        };
        yield canonicalMutationSchema.parse({
          kind: 'entity_upsert',
          mutationId: `sc:mutation:${sha256(
            `${feed.artifactId}|service|${entityId}|${GTFS_TRANSFORM_VERSION}`,
          )}`,
          runId,
          sourceId: config.sourceId,
          snapshotId,
          sequence: sequence++,
          emittedAt: config.retrievedAt,
          visibility: config.visibility,
          entity,
        });
        const observations = fieldObservationMutations(
          baseFeed,
          config,
          snapshotId,
          runId,
          entityId,
          'transit-service',
          `trips.txt:${trip['trip_id'] ?? ''}`,
          sourceInput,
          core,
          sequence,
        );
        for (const observation of observations) yield observation;
        sequence += observations.length;
      }
      if (!result.truncated) break;
    }

    let lastStopId = '';
    for (;;) {
      context.signal.throwIfAborted();
      const result = await session.execute({
        operation: GTFS_ANALYTICAL_OPERATION,
        statement: `WITH
          page_stops AS MATERIALIZED (
            SELECT * FROM ${GTFS_CSV_SOURCE}
            WHERE stop_id > ?
            ORDER BY stop_id
            LIMIT ${GTFS_STOP_PAGE_ROWS + 1}
          ),
          duplicate_stop_ids AS (
            SELECT stop_id FROM page_stops
            GROUP BY stop_id HAVING count(*) > 1
            ORDER BY stop_id LIMIT 1
          ),
          page_diagnostics AS (
            SELECT (SELECT stop_id FROM duplicate_stop_ids) AS duplicate_stop_id
          )
          SELECT s.stop_id AS page_key, to_json(s) AS stop_json,
                 diagnostics.duplicate_stop_id,
                 CASE WHEN coalesce(s.parent_station, '') = '' THEN true
                      ELSE EXISTS (
                        SELECT 1 FROM ${GTFS_CSV_SOURCE} p
                        WHERE p.stop_id = s.parent_station
                      ) END AS parent_exists
          FROM page_stops s
          CROSS JOIN page_diagnostics diagnostics
          ORDER BY s.stop_id`,
        parameters: [stopsUri, lastStopId, stopsUri],
        timeoutMs: GTFS_QUERY_TIMEOUT_MS,
        maximumScanBytes: conservativeScanBudget(
          manifest.totalMemberBytes,
          GTFS_STOP_QUERY_WORST_CASE_SCANS,
        ),
        maximumRows: GTFS_STOP_PAGE_ROWS,
        signal: context.signal,
      });
      if (result.rows.length === 0) break;
      const duplicateStopId = rowNullableString(result.rows[0] ?? {}, 'duplicate_stop_id');
      if (duplicateStopId !== null) {
        throw new Error(`GTFS stops.txt contains duplicate stop_id ${duplicateStopId}`);
      }
      const pageStopIds = result.rows.map((row) => rowString(row, 'page_key'));
      const stopActivity = new Map(
        pageStopIds.map((stopId) => [
          stopId,
          {
            active: false,
            pickupAllowed: false,
            dropOffAllowed: false,
            routeIds: new Set<string>(),
            serviceIds: new Set<string>(),
            servicePairs: new Set<string>(),
            canonicalServiceIds: new Set<string>(),
          },
        ]),
      );
      let lastStopTimeStopId = '';
      let lastStopTimeTripId = '';
      let lastStopTimeSequence = '';
      let hasStopTimeCursor = false;
      for (;;) {
        context.signal.throwIfAborted();
        const stopIdValues = pageStopIds.map(() => '(?)').join(', ');
        const stopTimeCursorSql = hasStopTimeCursor
          ? `(st.stop_id > ? OR (st.stop_id = ? AND (st.trip_id > ?
               OR (st.trip_id = ? AND coalesce(st.stop_sequence, '') > ?))))`
          : 'true';
        const stopTimeCursorParameters = hasStopTimeCursor
          ? [
              lastStopTimeStopId,
              lastStopTimeStopId,
              lastStopTimeTripId,
              lastStopTimeTripId,
              lastStopTimeSequence,
            ]
          : [];
        const stopTimes = await session.execute({
          operation: GTFS_ANALYTICAL_OPERATION,
          statement: `WITH
            trips AS (SELECT * FROM ${GTFS_CSV_SOURCE}),
            calendars AS (SELECT * FROM ${calendars.sql}),
            calendar_dates AS (SELECT * FROM ${calendarDates.sql}),
            page_stop_ids(stop_id) AS (VALUES ${stopIdValues}),
            stop_time_page AS MATERIALIZED (
              SELECT st.* FROM ${GTFS_CSV_SOURCE} st
              JOIN page_stop_ids page ON page.stop_id = st.stop_id
              WHERE ${stopTimeCursorSql}
              ORDER BY st.stop_id, st.trip_id, coalesce(st.stop_sequence, '')
              LIMIT ${GTFS_STOP_TIME_PAGE_ROWS + 1}
            )
            SELECT st.stop_id AS page_stop_id, st.trip_id AS page_trip_id,
                   coalesce(st.stop_sequence, '') AS page_stop_sequence,
                   t.route_id, t.service_id,
                   coalesce(t.trip_id IS NOT NULL AND ${activeServicePredicate('t')}, false) AS active,
                   coalesce(st.pickup_type, '0') <> '1' AS pickup_allowed,
                   coalesce(st.drop_off_type, '0') <> '1' AS dropoff_allowed
            FROM stop_time_page st
            LEFT JOIN trips t ON t.trip_id = st.trip_id
            ORDER BY st.stop_id, st.trip_id, coalesce(st.stop_sequence, '')`,
          parameters: [
            tripsUri,
            ...calendars.parameters,
            ...calendarDates.parameters,
            ...pageStopIds,
            stopTimesUri,
            ...stopTimeCursorParameters,
            ...activeServiceParameters,
          ],
          timeoutMs: GTFS_QUERY_TIMEOUT_MS,
          maximumScanBytes: conservativeScanBudget(
            manifest.totalMemberBytes,
            GTFS_STOP_TIME_QUERY_WORST_CASE_SCANS,
          ),
          maximumRows: GTFS_STOP_TIME_PAGE_ROWS,
          signal: context.signal,
        });
        if (stopTimes.rows.length === 0) break;
        for (const row of stopTimes.rows) {
          context.signal.throwIfAborted();
          lastStopTimeStopId = rowString(row, 'page_stop_id');
          lastStopTimeTripId = rowString(row, 'page_trip_id');
          lastStopTimeSequence = rowString(row, 'page_stop_sequence');
          hasStopTimeCursor = true;
          if (!rowBoolean(row, 'active')) continue;
          const activity = stopActivity.get(lastStopTimeStopId);
          if (activity === undefined) {
            throw new Error(
              `GTFS analytical stop_times returned unknown stop ${lastStopTimeStopId}`,
            );
          }
          const routeId = rowString(row, 'route_id');
          const serviceId = rowString(row, 'service_id');
          const pairKey = `${routeId}|${serviceId}`;
          if (!activity.servicePairs.has(pairKey)) {
            if (activity.servicePairs.size >= MAX_SERVICE_PAIRS_PER_STOP) {
              throw new Error(
                `GTFS stop ${lastStopTimeStopId} exceeds ${MAX_SERVICE_PAIRS_PER_STOP} active service pairs`,
              );
            }
            activity.servicePairs.add(pairKey);
            activity.routeIds.add(routeId);
            activity.serviceIds.add(serviceId);
            activity.canonicalServiceIds.add(
              `sc:entity:transit-service:${sha256(`${config.agencyId}|${pairKey}`)}`,
            );
          }
          activity.active = true;
          if (rowBoolean(row, 'pickup_allowed')) activity.pickupAllowed = true;
          if (rowBoolean(row, 'dropoff_allowed')) activity.dropOffAllowed = true;
        }
        if (!stopTimes.truncated) break;
      }

      for (const row of result.rows) {
        context.signal.throwIfAborted();
        const stopRow = jsonRow(row['stop_json'], 'stop');
        const stopId = stopRow['stop_id'] ?? '';
        const activity = stopActivity.get(stopId);
        if (activity === undefined) throw new Error(`GTFS stop page lost activity for ${stopId}`);
        const locationType = Number(
          stopRow['location_type'] === '' ? '0' : (stopRow['location_type'] ?? '0'),
        );
        const latitude = numberOrNull(stopRow['stop_lat'], -90, 90);
        const longitude = numberOrNull(stopRow['stop_lon'], -180, 180);
        const parent = stopRow['parent_station']?.trim() || null;
        const locationBoardable = locationType === 0 || locationType === 4;
        const active = activity.active;
        const pickupAllowed = active && activity.pickupAllowed;
        const dropOffAllowed = active && activity.dropOffAllowed;
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
          routeIds: Object.freeze([...activity.routeIds].filter(Boolean).sort()),
          serviceIds: Object.freeze([...activity.serviceIds].filter(Boolean).sort()),
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
            serviceIds: Object.freeze([...activity.canonicalServiceIds].sort()),
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
            mutationId: `sc:mutation:${sha256(
              `${feed.artifactId}|stop|${entityId}|${GTFS_TRANSFORM_VERSION}`,
            )}`,
            runId,
            sourceId: config.sourceId,
            snapshotId,
            sequence: sequence++,
            emittedAt: config.retrievedAt,
            visibility: config.visibility,
            entity,
          });
          const observations = fieldObservationMutations(
            baseFeed,
            config,
            snapshotId,
            runId,
            entityId,
            'transit-stop',
            `stops.txt:${stopId}`,
            normalizedStop,
            core,
            sequence,
          );
          for (const observation of observations) yield observation;
          sequence += observations.length;
        }
        lastStopId = rowString(row, 'page_key');
      }
      if (!result.truncated) break;
    }
  } finally {
    await session[Symbol.asyncDispose]();
  }
}
