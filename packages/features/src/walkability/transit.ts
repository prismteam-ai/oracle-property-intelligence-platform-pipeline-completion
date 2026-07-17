import {
  countReasons,
  mostRestrictiveVisibility,
  sortedUnique,
  sortObservations,
} from './evidence.js';
import { routePedestrian } from './routing.js';
import type {
  Coordinate,
  RouteSuccess,
  RoutingGraph,
  Visibility,
  WalkabilityEvidence,
} from './types.js';

export interface TransitStopInput {
  readonly stopId: string;
  readonly stopCode: string;
  readonly name: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly locationType: number;
  readonly parentStation: string | null;
  readonly platformCode: string | null;
  readonly boardable: boolean;
  readonly pickupAllowedOnSelectedDate: boolean;
  readonly dropOffAllowedOnSelectedDate: boolean;
  readonly activeOnSelectedDate: boolean;
  readonly routeIds: readonly string[];
  readonly serviceIds: readonly string[];
  readonly exclusionReasons: readonly string[];
}

export interface TransitTransferInput {
  readonly fromStopId: string;
  readonly toStopId: string;
  /** GTFS transfer_type 3 means transfers are forbidden. */
  readonly transferType: number | null;
}

export interface TransitSnapshotInput {
  readonly operator: string;
  readonly role: 'operator_primary' | '511_fallback';
  readonly sourceId: string;
  readonly snapshotId: string;
  readonly artifactId: string;
  readonly agencyId: string;
  readonly agencyName: string;
  readonly selectedServiceDate: string;
  readonly stops: readonly TransitStopInput[];
  readonly transfers: readonly TransitTransferInput[];
  readonly observedAt: string;
  readonly license: string;
  readonly attribution: string;
  readonly visibility: Visibility;
  readonly limitations: readonly string[];
}

export interface TransitWalkabilityRequest {
  readonly propertyId: string;
  readonly propertyLocation: Coordinate;
  readonly serviceDate: string;
  readonly maximumNetworkDistanceMeters: number;
  readonly maximumSnapDistanceMeters: number;
  readonly asOf: string;
  readonly graphVisibility?: Visibility;
}

export interface TransitWalkabilityValue {
  readonly withinThreshold: boolean;
  readonly serviceDate: string;
  readonly operator: string;
  readonly agencyId: string;
  readonly agencyName: string;
  readonly feedRole: 'operator_primary' | '511_fallback';
  readonly boardingStop: Readonly<{
    stopId: string;
    stopCode: string;
    name: string;
    locationType: number;
    parentStation: string | null;
    platformCode: string | null;
    routeIds: readonly string[];
    serviceIds: readonly string[];
  }>;
  readonly accessStop: Readonly<{
    stopId: string;
    name: string;
    locationType: number;
    relation: 'self' | 'parent' | 'entrance' | 'transfer';
  }>;
  readonly networkDistanceMeters: number;
  readonly estimatedWalkSeconds: number;
  readonly originSnapDistanceMeters: number;
  readonly destinationSnapDistanceMeters: number;
  readonly graphVersion: string;
  readonly graphArtifactId: string;
  readonly routeNodeIds: readonly string[];
  readonly routeEdgeIds: readonly string[];
}

interface SelectedStop {
  readonly snapshot: TransitSnapshotInput;
  readonly stop: TransitStopInput;
}

interface RouteTarget {
  readonly boarding: SelectedStop;
  readonly access: SelectedStop;
  readonly relation: TransitWalkabilityValue['accessStop']['relation'];
}

interface RoutedTarget extends RouteTarget {
  readonly route: RouteSuccess;
}

const MAXIMUM_TRANSIT_TOPOLOGY_HOPS = 4;

function stopKey(snapshot: TransitSnapshotInput, stopId: string): string {
  return `${snapshot.operator}\0${stopId}`;
}

function coordinate(stop: TransitStopInput): Coordinate | null {
  return stop.longitude === null || stop.latitude === null ? null : [stop.longitude, stop.latitude];
}

function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function assertRequest(request: TransitWalkabilityRequest): void {
  if (request.propertyId.trim().length === 0) throw new TypeError('Property ID is required');
  if (!isDateOnly(request.serviceDate)) {
    throw new TypeError('Transit service date must be a valid YYYY-MM-DD date');
  }
  if (Number.isNaN(Date.parse(request.asOf))) throw new TypeError('Transit as-of must be ISO-8601');
  if (
    !Number.isFinite(request.propertyLocation[0]) ||
    request.propertyLocation[0] < -180 ||
    request.propertyLocation[0] > 180 ||
    !Number.isFinite(request.propertyLocation[1]) ||
    request.propertyLocation[1] < -90 ||
    request.propertyLocation[1] > 90
  ) {
    throw new TypeError('Transit property location must be a valid WGS84 coordinate');
  }
  if (
    !Number.isFinite(request.maximumNetworkDistanceMeters) ||
    request.maximumNetworkDistanceMeters < 0 ||
    !Number.isFinite(request.maximumSnapDistanceMeters) ||
    request.maximumSnapDistanceMeters < 0
  ) {
    throw new TypeError('Transit distance thresholds must be finite and non-negative');
  }
}

function stopSignature(stop: TransitStopInput): string {
  return JSON.stringify([
    stop.stopCode,
    stop.name,
    stop.latitude,
    stop.longitude,
    stop.locationType,
    stop.parentStation,
    stop.platformCode,
    stop.boardable,
    stop.pickupAllowedOnSelectedDate,
    stop.dropOffAllowedOnSelectedDate,
    stop.activeOnSelectedDate,
    [...stop.routeIds].sort(),
    [...stop.serviceIds].sort(),
    [...stop.exclusionReasons].sort(),
  ]);
}

function boardingExclusions(selected: SelectedStop, serviceDate: string): readonly string[] {
  const reasons = [...selected.stop.exclusionReasons];
  if (!isDateOnly(selected.snapshot.selectedServiceDate))
    reasons.push('invalid_snapshot_service_date');
  if (selected.snapshot.selectedServiceDate !== serviceDate) reasons.push('service_date_mismatch');
  if (!selected.stop.activeOnSelectedDate) reasons.push('inactive_on_service_date');
  if (!selected.stop.boardable) reasons.push('not_passenger_boardable');
  if (!selected.stop.pickupAllowedOnSelectedDate) reasons.push('pickup_not_allowed');
  if (![0, 4].includes(selected.stop.locationType)) reasons.push('non_boarding_location_type');
  if (selected.stop.serviceIds.length === 0) reasons.push('no_active_service');
  return sortedUnique(reasons);
}

function deduplicateStops(snapshots: readonly TransitSnapshotInput[]): Readonly<{
  selected: readonly SelectedStop[];
  reasons: readonly string[];
}> {
  const grouped = new Map<string, SelectedStop[]>();
  for (const snapshot of snapshots) {
    for (const stop of snapshot.stops) {
      const key = stopKey(snapshot, stop.stopId);
      const values = grouped.get(key) ?? [];
      values.push({ snapshot, stop });
      grouped.set(key, values);
    }
  }
  const selected: SelectedStop[] = [];
  const reasons: string[] = [];
  for (const [key, values] of [...grouped.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const signatures = new Set(values.map(({ stop }) => stopSignature(stop)));
    if (signatures.size > 1) {
      reasons.push(...values.map(() => `duplicate_stop_conflict:${key.replace('\0', ':')}`));
      continue;
    }
    values.sort(
      (left, right) =>
        (left.snapshot.role === right.snapshot.role
          ? 0
          : left.snapshot.role === 'operator_primary'
            ? -1
            : 1) || left.snapshot.artifactId.localeCompare(right.snapshot.artifactId),
    );
    const first = values[0];
    if (first !== undefined) selected.push(first);
    if (values.length > 1) reasons.push(...values.slice(1).map(() => 'duplicate_stop_collapsed'));
  }
  return Object.freeze({
    selected: Object.freeze(selected),
    reasons: Object.freeze(reasons),
  });
}

function transferAdjacency(
  snapshots: readonly TransitSnapshotInput[],
  stops: readonly SelectedStop[],
): ReadonlyMap<string, readonly string[]> {
  const adjacency = new Map(
    stops.map(({ snapshot, stop }) => [stopKey(snapshot, stop.stopId), new Set<string>()]),
  );
  const byKey = new Map(
    stops.map((selected) => [stopKey(selected.snapshot, selected.stop.stopId), selected]),
  );
  for (const selected of stops) {
    if (selected.stop.parentStation === null) continue;
    const child = stopKey(selected.snapshot, selected.stop.stopId);
    const parent = stopKey(selected.snapshot, selected.stop.parentStation);
    if (!byKey.has(parent)) continue;
    adjacency.get(child)?.add(parent);
    adjacency.get(parent)?.add(child);
  }
  for (const snapshot of snapshots) {
    for (const transfer of snapshot.transfers) {
      if (transfer.transferType === 3) continue;
      const from = stopKey(snapshot, transfer.fromStopId);
      const to = stopKey(snapshot, transfer.toStopId);
      if (!byKey.has(from) || !byKey.has(to)) continue;
      // GTFS transfers are directional. Traversal starts at the qualifying
      // boarding identity and searches backwards for geometry that can lead
      // into it, so only the reverse (to -> from) belongs in this adjacency.
      adjacency.get(to)?.add(from);
    }
  }
  return new Map(
    [...adjacency.entries()].map(([key, values]) => [key, Object.freeze([...values].sort())]),
  );
}

function relationFor(boarding: SelectedStop, access: SelectedStop): RouteTarget['relation'] {
  if (boarding.stop.stopId === access.stop.stopId) return 'self';
  if (boarding.stop.parentStation === access.stop.stopId) return 'parent';
  if (access.stop.locationType === 2) return 'entrance';
  return 'transfer';
}

function routeTargets(
  snapshots: readonly TransitSnapshotInput[],
  stops: readonly SelectedStop[],
  serviceDate: string,
): readonly RouteTarget[] {
  const byKey = new Map(
    stops.map((selected) => [stopKey(selected.snapshot, selected.stop.stopId), selected]),
  );
  const adjacency = transferAdjacency(snapshots, stops);
  const targets: RouteTarget[] = [];
  for (const boarding of stops) {
    if (boardingExclusions(boarding, serviceDate).length > 0) continue;
    const start = stopKey(boarding.snapshot, boarding.stop.stopId);
    const queue: Readonly<{ key: string; depth: number }>[] = [{ key: start, depth: 0 }];
    const visited = new Set([start]);
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) continue;
      const access = byKey.get(current.key);
      if (access !== undefined && coordinate(access.stop) !== null) {
        targets.push(Object.freeze({ boarding, access, relation: relationFor(boarding, access) }));
      }
      if (current.depth >= MAXIMUM_TRANSIT_TOPOLOGY_HOPS) continue;
      for (const neighbor of adjacency.get(current.key) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push({ key: neighbor, depth: current.depth + 1 });
      }
    }
  }
  const unique = new Map<string, RouteTarget>();
  for (const target of targets) {
    const key = [
      target.boarding.snapshot.operator,
      target.boarding.stop.stopId,
      target.access.stop.stopId,
    ].join('\0');
    unique.set(key, target);
  }
  return Object.freeze(
    [...unique.values()].sort((left, right) => {
      const leftKey = `${left.boarding.snapshot.operator}\0${left.boarding.stop.stopId}\0${left.access.stop.stopId}`;
      const rightKey = `${right.boarding.snapshot.operator}\0${right.boarding.stop.stopId}\0${right.access.stop.stopId}`;
      return leftKey.localeCompare(rightKey);
    }),
  );
}

function graphObservation(graph: RoutingGraph, edgeIds: readonly string[], visibility: Visibility) {
  return Object.freeze({
    sourceId: graph.provenance.sourceId,
    snapshotId: graph.provenance.snapshotId,
    artifactId: graph.provenance.artifactId,
    recordIds: edgeIds,
    observedAt: graph.provenance.extractTimestamp,
    license: graph.provenance.license,
    attribution: graph.provenance.attribution,
    visibility,
  });
}

function unknownResult(
  graph: RoutingGraph,
  request: TransitWalkabilityRequest,
  snapshots: readonly TransitSnapshotInput[],
  observedDestinations: number,
  eligibleDestinations: number,
  exclusionReasons: readonly string[],
  limitations: readonly string[],
): WalkabilityEvidence<TransitWalkabilityValue> {
  return Object.freeze({
    propertyId: request.propertyId,
    feature: 'transit_walkability',
    supportState: 'unknown',
    value: null,
    sourceObservations: sortObservations([
      graphObservation(graph, [], request.graphVisibility ?? 'public'),
      ...snapshots.map((snapshot) => ({
        sourceId: snapshot.sourceId,
        snapshotId: snapshot.snapshotId,
        artifactId: snapshot.artifactId,
        recordIds: [],
        observedAt: snapshot.observedAt,
        license: snapshot.license,
        attribution: snapshot.attribution,
        visibility: snapshot.visibility,
      })),
    ]),
    calculation: Object.freeze({
      name: 'offline-gtfs-pedestrian-walkability',
      version: '1.0.0',
      parameters: Object.freeze({
        serviceDate: request.serviceDate,
        maximumNetworkDistanceMeters: request.maximumNetworkDistanceMeters,
        maximumSnapDistanceMeters: request.maximumSnapDistanceMeters,
        maximumTransitTopologyHops: MAXIMUM_TRANSIT_TOPOLOGY_HOPS,
        routingProfileVersion: graph.routingProfileVersion,
      }),
    }),
    asOf: request.asOf,
    coverage: Object.freeze({
      observedDestinations,
      eligibleDestinations,
      routedDestinations: 0,
      excludedDestinations: observedDestinations - eligibleDestinations,
      exclusionReasons: countReasons(exclusionReasons),
    }),
    limitations: sortedUnique([
      ...limitations,
      `Transit access topology follows at most ${MAXIMUM_TRANSIT_TOPOLOGY_HOPS} explicit parent/transfer links from a qualifying boarding identity.`,
    ]),
    visibility: mostRestrictiveVisibility([
      request.graphVisibility ?? 'public',
      ...snapshots.map((snapshot) => snapshot.visibility),
    ]),
    evidenceLinks: sortedUnique(snapshots.map((snapshot) => `artifact:${snapshot.artifactId}`)),
  });
}

export function evaluateTransitWalkability(
  graph: RoutingGraph,
  snapshots: readonly TransitSnapshotInput[],
  request: TransitWalkabilityRequest,
): WalkabilityEvidence<TransitWalkabilityValue> {
  assertRequest(request);
  const deduplicated = deduplicateStops(snapshots);
  const allExclusions = [...deduplicated.reasons];
  for (const snapshot of snapshots) {
    allExclusions.push(
      ...snapshot.transfers
        .filter(({ transferType }) => transferType === 3)
        .map(() => 'forbidden_transfer_topology'),
    );
  }
  for (const selected of deduplicated.selected) {
    allExclusions.push(...boardingExclusions(selected, request.serviceDate));
  }
  const targets = routeTargets(snapshots, deduplicated.selected, request.serviceDate);
  const eligibleBoardingKeys = new Set(
    targets.map((target) => stopKey(target.boarding.snapshot, target.boarding.stop.stopId)),
  );
  if (targets.length === 0) {
    return unknownResult(
      graph,
      request,
      snapshots,
      snapshots.reduce((total, snapshot) => total + snapshot.stops.length, 0),
      0,
      allExclusions,
      [
        ...graph.limitations,
        ...snapshots.flatMap((snapshot) => snapshot.limitations),
        'No active passenger-boardable destination or linked access point was eligible on the selected service date.',
      ],
    );
  }

  const routed: RoutedTarget[] = [];
  for (const target of targets) {
    const destination = coordinate(target.access.stop);
    if (destination === null) continue;
    const route = routePedestrian(graph, {
      origin: request.propertyLocation,
      destination,
      maximumSnapDistanceMeters: request.maximumSnapDistanceMeters,
    });
    if (route.status === 'routed') routed.push(Object.freeze({ ...target, route }));
    else allExclusions.push(`routing_${route.reason}`);
  }
  routed.sort(
    (left, right) =>
      left.route.networkDistanceMeters - right.route.networkDistanceMeters ||
      left.route.destinationSnap.distanceMeters - right.route.destinationSnap.distanceMeters ||
      left.boarding.snapshot.operator.localeCompare(right.boarding.snapshot.operator) ||
      left.boarding.stop.stopId.localeCompare(right.boarding.stop.stopId) ||
      left.access.stop.stopId.localeCompare(right.access.stop.stopId),
  );
  const nearest = routed[0];
  if (nearest === undefined) {
    return unknownResult(
      graph,
      request,
      snapshots,
      snapshots.reduce((total, snapshot) => total + snapshot.stops.length, 0),
      eligibleBoardingKeys.size,
      allExclusions,
      [
        ...graph.limitations,
        ...snapshots.flatMap((snapshot) => snapshot.limitations),
        'Eligible transit destinations exist, but none has a routed pedestrian path from the property.',
      ],
    );
  }

  const { boarding, access, route } = nearest;
  const snapshot = boarding.snapshot;
  const observedDestinations = snapshots.reduce((total, item) => total + item.stops.length, 0);
  const visibility = mostRestrictiveVisibility([
    request.graphVisibility ?? 'public',
    snapshot.visibility,
  ]);
  const value: TransitWalkabilityValue = Object.freeze({
    withinThreshold: route.networkDistanceMeters <= request.maximumNetworkDistanceMeters,
    serviceDate: request.serviceDate,
    operator: snapshot.operator,
    agencyId: snapshot.agencyId,
    agencyName: snapshot.agencyName,
    feedRole: snapshot.role,
    boardingStop: Object.freeze({
      stopId: boarding.stop.stopId,
      stopCode: boarding.stop.stopCode,
      name: boarding.stop.name,
      locationType: boarding.stop.locationType,
      parentStation: boarding.stop.parentStation,
      platformCode: boarding.stop.platformCode,
      routeIds: sortedUnique(boarding.stop.routeIds),
      serviceIds: sortedUnique(boarding.stop.serviceIds),
    }),
    accessStop: Object.freeze({
      stopId: access.stop.stopId,
      name: access.stop.name,
      locationType: access.stop.locationType,
      relation: nearest.relation,
    }),
    networkDistanceMeters: route.networkDistanceMeters,
    estimatedWalkSeconds: route.estimatedWalkSeconds,
    originSnapDistanceMeters: route.originSnap.distanceMeters,
    destinationSnapDistanceMeters: route.destinationSnap.distanceMeters,
    graphVersion: route.graphVersion,
    graphArtifactId: route.graphArtifactId,
    routeNodeIds: route.nodeIds,
    routeEdgeIds: route.edgeIds,
  });

  return Object.freeze({
    propertyId: request.propertyId,
    feature: 'transit_walkability',
    supportState: 'supported',
    value,
    sourceObservations: sortObservations([
      graphObservation(graph, route.edgeIds, request.graphVisibility ?? 'public'),
      {
        sourceId: snapshot.sourceId,
        snapshotId: snapshot.snapshotId,
        artifactId: snapshot.artifactId,
        recordIds: [boarding.stop.stopId, access.stop.stopId],
        observedAt: snapshot.observedAt,
        license: snapshot.license,
        attribution: snapshot.attribution,
        visibility: snapshot.visibility,
      },
    ]),
    calculation: Object.freeze({
      name: 'offline-gtfs-pedestrian-walkability',
      version: '1.0.0',
      parameters: Object.freeze({
        serviceDate: request.serviceDate,
        maximumNetworkDistanceMeters: request.maximumNetworkDistanceMeters,
        maximumSnapDistanceMeters: request.maximumSnapDistanceMeters,
        maximumTransitTopologyHops: MAXIMUM_TRANSIT_TOPOLOGY_HOPS,
        routingProfileVersion: graph.routingProfileVersion,
      }),
    }),
    asOf: request.asOf,
    coverage: Object.freeze({
      observedDestinations,
      eligibleDestinations: eligibleBoardingKeys.size,
      routedDestinations: routed.length,
      excludedDestinations: observedDestinations - eligibleBoardingKeys.size,
      exclusionReasons: countReasons(allExclusions),
    }),
    limitations: sortedUnique([
      ...graph.limitations,
      ...snapshot.limitations,
      ...route.limitations,
      'Transit eligibility is bound to the selected GTFS service date and passenger-boardable topology.',
      `Transit access topology follows at most ${MAXIMUM_TRANSIT_TOPOLOGY_HOPS} explicit parent/transfer links from a qualifying boarding identity.`,
      'Walking distance is routed network distance; property and destination snap offsets are shown separately.',
    ]),
    visibility,
    evidenceLinks: sortedUnique([
      `artifact:${graph.provenance.artifactId}`,
      `artifact:${snapshot.artifactId}`,
      `transit-stop:${snapshot.operator}:${boarding.stop.stopId}`,
      `transit-access:${snapshot.operator}:${access.stop.stopId}`,
    ]),
  });
}
