import type {
  NormalizedTransitSnapshot,
  TransitFeedFamilyConfig,
  TransitFeedSelection,
  TransitFeedSnapshotConfig,
  TransitSnapshotDiscrepancy,
} from './types.js';

function assertPrimary(config: TransitFeedSnapshotConfig, operator: 'vta' | 'caltrain'): void {
  if (config.operator !== operator || config.role !== 'operator_primary') {
    throw new TypeError(`${operator} must be configured as an operator-authoritative primary feed`);
  }
  if (config.requiresInjectedAuthorization) {
    throw new TypeError(`${operator} direct feed must not require 511 authorization`);
  }
}

function assertFallback(config: TransitFeedSnapshotConfig, operator: 'vta' | 'caltrain'): void {
  if (
    config.operator !== operator ||
    config.role !== '511_fallback' ||
    !config.requiresInjectedAuthorization
  ) {
    throw new TypeError(`511 ${operator} fallback must use injected authorization`);
  }
  if (
    config.ratePolicy.maxRequestsPerWindow > 60 ||
    config.ratePolicy.windowMs < 3_600_000 ||
    !config.ratePolicy.respectRetryAfter
  ) {
    throw new TypeError('511 fallback must honor the published 60 requests per 3600 seconds limit');
  }
}

export function validateTransitFeedFamilyConfig(config: TransitFeedFamilyConfig): void {
  assertPrimary(config.vta, 'vta');
  assertPrimary(config.caltrain, 'caltrain');
  const fallback = config.fallback511;
  if (fallback?.vta !== undefined) assertFallback(fallback.vta, 'vta');
  if (fallback?.caltrain !== undefined) assertFallback(fallback.caltrain, 'caltrain');
}

function compareScalar(
  discrepancies: TransitSnapshotDiscrepancy[],
  entityKind: TransitSnapshotDiscrepancy['entityKind'],
  entityId: string,
  field: string,
  operatorValue: string | number | boolean | null,
  fallbackValue: string | number | boolean | null,
): void {
  if (operatorValue !== fallbackValue) {
    discrepancies.push({ entityKind, entityId, field, operatorValue, fallbackValue });
  }
}

export function compareTransitSnapshots(
  operatorSnapshot: NormalizedTransitSnapshot,
  fallbackSnapshot: NormalizedTransitSnapshot,
): readonly TransitSnapshotDiscrepancy[] {
  if (operatorSnapshot.operator !== fallbackSnapshot.operator) {
    throw new TypeError('Transit snapshots must represent the same operator');
  }
  const discrepancies: TransitSnapshotDiscrepancy[] = [];
  compareScalar(
    discrepancies,
    'agency',
    operatorSnapshot.agencyId,
    'agencyName',
    operatorSnapshot.agencyName,
    fallbackSnapshot.agencyName,
  );
  const fallbackStops = new Map(fallbackSnapshot.stops.map((stop) => [stop.stopId, stop]));
  for (const stop of operatorSnapshot.stops) {
    const fallback = fallbackStops.get(stop.stopId);
    if (fallback === undefined) {
      discrepancies.push({
        entityKind: 'stop',
        entityId: stop.stopId,
        field: 'presence',
        operatorValue: true,
        fallbackValue: false,
      });
      continue;
    }
    compareScalar(discrepancies, 'stop', stop.stopId, 'name', stop.name, fallback.name);
    compareScalar(discrepancies, 'stop', stop.stopId, 'latitude', stop.latitude, fallback.latitude);
    compareScalar(
      discrepancies,
      'stop',
      stop.stopId,
      'longitude',
      stop.longitude,
      fallback.longitude,
    );
    compareScalar(
      discrepancies,
      'stop',
      stop.stopId,
      'parentStation',
      stop.parentStation,
      fallback.parentStation,
    );
    fallbackStops.delete(stop.stopId);
  }
  for (const stopId of [...fallbackStops.keys()].sort()) {
    discrepancies.push({
      entityKind: 'stop',
      entityId: stopId,
      field: 'presence',
      operatorValue: false,
      fallbackValue: true,
    });
  }

  const compareRows = (
    kind: TransitSnapshotDiscrepancy['entityKind'],
    primary: readonly Readonly<Record<string, string>>[],
    secondary: readonly Readonly<Record<string, string>>[],
    keyFields: readonly string[],
  ) => {
    const key = (row: Readonly<Record<string, string>>) =>
      keyFields.map((field) => row[field] ?? '').join('|');
    const secondaryMap = new Map(secondary.map((row) => [key(row), row]));
    for (const row of primary) {
      const id = key(row);
      const other = secondaryMap.get(id);
      compareScalar(
        discrepancies,
        kind,
        id,
        'record',
        JSON.stringify(row),
        other === undefined ? null : JSON.stringify(other),
      );
      secondaryMap.delete(id);
    }
    for (const [id, row] of [...secondaryMap.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      discrepancies.push({
        entityKind: kind,
        entityId: id,
        field: 'record',
        operatorValue: null,
        fallbackValue: JSON.stringify(row),
      });
    }
  };
  compareRows('route', operatorSnapshot.routes, fallbackSnapshot.routes, ['route_id']);
  compareRows('trip', operatorSnapshot.trips, fallbackSnapshot.trips, ['trip_id']);
  compareRows('calendar', operatorSnapshot.calendars, fallbackSnapshot.calendars, ['service_id']);
  compareRows('calendar', operatorSnapshot.calendarDates, fallbackSnapshot.calendarDates, [
    'service_id',
    'date',
  ]);
  compareRows('transfer', operatorSnapshot.transfers, fallbackSnapshot.transfers, [
    'from_stop_id',
    'to_stop_id',
  ]);

  return Object.freeze(
    discrepancies.sort((left, right) =>
      `${left.entityKind}|${left.entityId}|${left.field}`.localeCompare(
        `${right.entityKind}|${right.entityId}|${right.field}`,
      ),
    ),
  );
}

export function selectTransitSnapshot(
  operatorSnapshot: NormalizedTransitSnapshot | null,
  fallbackSnapshot: NormalizedTransitSnapshot | null,
): TransitFeedSelection {
  if (operatorSnapshot === null && fallbackSnapshot === null) {
    throw new Error('No direct operator or 511 fallback snapshot is available');
  }
  if (operatorSnapshot !== null && operatorSnapshot.role !== 'operator_primary') {
    throw new TypeError('The primary snapshot is not operator authoritative');
  }
  if (fallbackSnapshot !== null && fallbackSnapshot.role !== '511_fallback') {
    throw new TypeError('The fallback snapshot is not a 511 fallback');
  }
  if (
    operatorSnapshot !== null &&
    fallbackSnapshot !== null &&
    operatorSnapshot.operator !== fallbackSnapshot.operator
  ) {
    throw new TypeError('Direct and fallback snapshots represent different operators');
  }
  const selected = operatorSnapshot ?? fallbackSnapshot;
  if (selected === null) throw new Error('Transit selection invariant violated');
  const discrepancies =
    operatorSnapshot !== null && fallbackSnapshot !== null
      ? compareTransitSnapshots(operatorSnapshot, fallbackSnapshot)
      : [];
  return Object.freeze({
    selected,
    selectedRole: selected.role,
    operatorSnapshot,
    fallbackSnapshot,
    discrepancies: Object.freeze(discrepancies),
    limitations: Object.freeze(
      operatorSnapshot === null
        ? ['Direct operator feed unavailable; selected the injected, rate-limited 511 fallback.']
        : discrepancies.length > 0
          ? ['Direct operator feed selected; 511 discrepancies are retained for review.']
          : [],
    ),
  });
}
