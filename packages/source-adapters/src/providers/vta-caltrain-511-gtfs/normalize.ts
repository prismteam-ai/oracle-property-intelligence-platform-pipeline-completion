/* GTFS column names are source data keys, and empty strings intentionally fall back. */
/* eslint-disable @typescript-eslint/dot-notation, @typescript-eslint/prefer-nullish-coalescing */
import { createHash } from 'node:crypto';

import {
  canonicalMutationSchema,
  type CanonicalMutation,
} from '@oracle/contracts/canonical/mutation';
import type { TransitService } from '@oracle/contracts/canonical/geospatial';

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
