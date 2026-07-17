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
  SupportState,
  Visibility,
  WalkabilityEvidence,
} from './types.js';

export type StarbucksValidationState =
  'not_sampled' | 'sampled_open' | 'sampled_closed' | 'sampled_conflict' | 'sampled_unknown';

export interface StarbucksCandidateInput {
  readonly gersId: string;
  readonly version: number;
  readonly name: string;
  readonly address: string | null;
  readonly coordinates: Coordinate;
  readonly confidence: number;
  readonly release: string;
  readonly candidateState:
    'candidate' | 'low_confidence_candidate' | 'closed_candidate' | 'not_starbucks_candidate';
  readonly overtureOperatingStatus: 'open' | 'closed' | 'unknown';
  readonly validation: Readonly<{
    state: StarbucksValidationState;
    checkedAt: string | null;
    note: string;
  }>;
  readonly matchMode:
    | 'wikidata_exact'
    | 'brand_name_exact'
    | 'primary_name_exact'
    | 'category_name_combination'
    | 'no_match';
  readonly sourceId: string;
  readonly snapshotId: string;
  readonly artifactId: string;
  readonly updateTime: string;
  readonly sourceLicenses: readonly string[];
  readonly sourceNotices: readonly string[];
  readonly contributors: readonly string[];
  readonly visibility: Visibility;
}

export interface StarbucksWalkabilityRequest {
  readonly propertyId: string;
  readonly propertyLocation: Coordinate;
  readonly maximumNetworkDistanceMeters: number;
  readonly maximumSnapDistanceMeters: number;
  readonly includeUnconfirmed: boolean;
  readonly minimumCandidateConfidence: number;
  readonly asOf: string;
  readonly graphVisibility?: Visibility;
}

export interface StarbucksWalkabilityValue {
  readonly withinThreshold: boolean;
  readonly gersId: string;
  readonly name: string;
  readonly address: string | null;
  readonly overtureRelease: string;
  readonly candidateState: StarbucksCandidateInput['candidateState'];
  readonly validationState: StarbucksValidationState;
  readonly validationCheckedAt: string | null;
  readonly overtureOperatingStatus: StarbucksCandidateInput['overtureOperatingStatus'];
  readonly matchMode: StarbucksCandidateInput['matchMode'];
  readonly confidence: number;
  readonly contributors: readonly string[];
  readonly sourceLicenses: readonly string[];
  readonly sourceNotices: readonly string[];
  readonly networkDistanceMeters: number;
  readonly estimatedWalkSeconds: number;
  readonly originSnapDistanceMeters: number;
  readonly destinationSnapDistanceMeters: number;
  readonly graphVersion: string;
  readonly graphArtifactId: string;
  readonly routeNodeIds: readonly string[];
  readonly routeEdgeIds: readonly string[];
}

interface EligibleCandidate {
  readonly candidate: StarbucksCandidateInput;
  readonly supportState: Extract<SupportState, 'supported' | 'proxy'>;
}

interface RoutedCandidate extends EligibleCandidate {
  readonly route: RouteSuccess;
}

function normalizeAddress(value: string | null): string {
  return (value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function assertRequest(request: StarbucksWalkabilityRequest): void {
  if (request.propertyId.trim().length === 0) throw new TypeError('Property ID is required');
  if (Number.isNaN(Date.parse(request.asOf)))
    throw new TypeError('Starbucks as-of must be ISO-8601');
  if (
    !Number.isFinite(request.propertyLocation[0]) ||
    request.propertyLocation[0] < -180 ||
    request.propertyLocation[0] > 180 ||
    !Number.isFinite(request.propertyLocation[1]) ||
    request.propertyLocation[1] < -90 ||
    request.propertyLocation[1] > 90
  ) {
    throw new TypeError('Starbucks property location must be a valid WGS84 coordinate');
  }
  if (
    !Number.isFinite(request.maximumNetworkDistanceMeters) ||
    request.maximumNetworkDistanceMeters < 0 ||
    !Number.isFinite(request.maximumSnapDistanceMeters) ||
    request.maximumSnapDistanceMeters < 0 ||
    !Number.isFinite(request.minimumCandidateConfidence) ||
    request.minimumCandidateConfidence < 0 ||
    request.minimumCandidateConfidence > 1
  ) {
    throw new TypeError('Starbucks distance and confidence thresholds are invalid');
  }
}

function materialSignature(candidate: StarbucksCandidateInput): string {
  return JSON.stringify([
    candidate.coordinates[0],
    candidate.coordinates[1],
    normalizeAddress(candidate.address),
    candidate.name.normalize('NFKC').toLowerCase(),
    candidate.candidateState,
    candidate.overtureOperatingStatus,
    candidate.validation.state,
    candidate.matchMode,
  ]);
}

function materialPlaceKey(candidate: StarbucksCandidateInput): string {
  const address = normalizeAddress(candidate.address);
  if (address.length === 0) return `gers:${candidate.gersId}`;
  return [candidate.coordinates[0].toFixed(6), candidate.coordinates[1].toFixed(6), address].join(
    '|',
  );
}

function preference(left: StarbucksCandidateInput, right: StarbucksCandidateInput): number {
  const confirmation = (candidate: StarbucksCandidateInput) =>
    candidate.validation.state === 'sampled_open' ? 1 : 0;
  return (
    confirmation(right) - confirmation(left) ||
    right.version - left.version ||
    right.confidence - left.confidence ||
    left.gersId.localeCompare(right.gersId)
  );
}

function deduplicateCandidates(candidates: readonly StarbucksCandidateInput[]): Readonly<{
  candidates: readonly StarbucksCandidateInput[];
  reasons: readonly string[];
}> {
  const reasons: string[] = [];
  const byGers = new Map<string, StarbucksCandidateInput[]>();
  for (const candidate of candidates) {
    const values = byGers.get(candidate.gersId) ?? [];
    values.push(candidate);
    byGers.set(candidate.gersId, values);
  }
  const stable: StarbucksCandidateInput[] = [];
  for (const [gersId, values] of [...byGers.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const signatures = new Set(values.map(materialSignature));
    if (signatures.size > 1) {
      reasons.push(...values.map(() => `conflicting_same_gers_id:${gersId}`));
      continue;
    }
    values.sort(preference);
    const selected = values[0];
    if (selected !== undefined) stable.push(selected);
    reasons.push(...values.slice(1).map(() => 'duplicate_gers_version_collapsed'));
  }

  const byPlace = new Map<string, StarbucksCandidateInput[]>();
  for (const candidate of stable) {
    const values = byPlace.get(materialPlaceKey(candidate)) ?? [];
    values.push(candidate);
    byPlace.set(materialPlaceKey(candidate), values);
  }
  const selected: StarbucksCandidateInput[] = [];
  for (const values of byPlace.values()) {
    values.sort(preference);
    const first = values[0];
    if (first !== undefined) selected.push(first);
    reasons.push(...values.slice(1).map(() => 'duplicate_material_place_collapsed'));
  }
  selected.sort((left, right) => left.gersId.localeCompare(right.gersId));
  return Object.freeze({ candidates: Object.freeze(selected), reasons: Object.freeze(reasons) });
}

function eligibility(
  candidate: StarbucksCandidateInput,
  request: StarbucksWalkabilityRequest,
): Readonly<{ eligible: EligibleCandidate | null; reasons: readonly string[] }> {
  const reasons: string[] = [];
  if (candidate.visibility === 'prohibited_public') reasons.push('prohibited_public_evidence');
  if (
    candidate.candidateState === 'not_starbucks_candidate' ||
    candidate.matchMode === 'no_match'
  ) {
    reasons.push('not_a_starbucks_candidate');
  }
  if (
    candidate.candidateState === 'closed_candidate' ||
    candidate.overtureOperatingStatus === 'closed' ||
    candidate.validation.state === 'sampled_closed'
  ) {
    reasons.push('closed_candidate');
  }
  if (candidate.confidence < request.minimumCandidateConfidence) {
    reasons.push('below_candidate_confidence_threshold');
  }
  if (reasons.length > 0) return Object.freeze({ eligible: null, reasons: sortedUnique(reasons) });

  const confirmed =
    candidate.validation.state === 'sampled_open' &&
    candidate.overtureOperatingStatus === 'open' &&
    candidate.candidateState === 'candidate';
  if (!confirmed && !request.includeUnconfirmed) {
    return Object.freeze({ eligible: null, reasons: Object.freeze(['unconfirmed_candidate']) });
  }
  return Object.freeze({
    eligible: Object.freeze({
      candidate,
      supportState: confirmed ? 'supported' : 'proxy',
    }),
    reasons: Object.freeze([]),
  });
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

function calculation(graph: RoutingGraph, request: StarbucksWalkabilityRequest) {
  return Object.freeze({
    name: 'overture-starbucks-offline-pedestrian-walkability',
    version: '1.0.0',
    parameters: Object.freeze({
      maximumNetworkDistanceMeters: request.maximumNetworkDistanceMeters,
      maximumSnapDistanceMeters: request.maximumSnapDistanceMeters,
      includeUnconfirmed: request.includeUnconfirmed,
      minimumCandidateConfidence: request.minimumCandidateConfidence,
      routingProfileVersion: graph.routingProfileVersion,
    }),
  });
}

export function evaluateStarbucksWalkability(
  graph: RoutingGraph,
  inputCandidates: readonly StarbucksCandidateInput[],
  request: StarbucksWalkabilityRequest,
): WalkabilityEvidence<StarbucksWalkabilityValue> {
  assertRequest(request);
  const deduplicated = deduplicateCandidates(inputCandidates);
  const reasons = [...deduplicated.reasons];
  const eligible: EligibleCandidate[] = [];
  for (const candidate of deduplicated.candidates) {
    const result = eligibility(candidate, request);
    reasons.push(...result.reasons);
    if (result.eligible !== null) eligible.push(result.eligible);
  }

  const routed: RoutedCandidate[] = [];
  for (const item of eligible) {
    const route = routePedestrian(graph, {
      origin: request.propertyLocation,
      destination: item.candidate.coordinates,
      maximumSnapDistanceMeters: request.maximumSnapDistanceMeters,
    });
    if (route.status === 'routed') routed.push(Object.freeze({ ...item, route }));
    else reasons.push(`routing_${route.reason}`);
  }
  routed.sort(
    (left, right) =>
      left.route.networkDistanceMeters - right.route.networkDistanceMeters ||
      left.route.destinationSnap.distanceMeters - right.route.destinationSnap.distanceMeters ||
      left.candidate.gersId.localeCompare(right.candidate.gersId),
  );
  const nearest = routed[0];
  if (nearest === undefined) {
    const candidateObservations = inputCandidates.map((candidate) => ({
      sourceId: candidate.sourceId,
      snapshotId: candidate.snapshotId,
      artifactId: candidate.artifactId,
      recordIds: [candidate.gersId],
      observedAt: candidate.updateTime,
      license: sortedUnique(candidate.sourceLicenses).join(', ') || 'unknown',
      attribution: 'Overture Maps Foundation and listed contributors',
      visibility: candidate.visibility,
    }));
    return Object.freeze({
      propertyId: request.propertyId,
      feature: 'starbucks_walkability',
      supportState: 'unknown',
      value: null,
      sourceObservations: sortObservations([
        graphObservation(graph, [], request.graphVisibility ?? 'public'),
        ...candidateObservations,
      ]),
      calculation: calculation(graph, request),
      asOf: request.asOf,
      coverage: Object.freeze({
        observedDestinations: inputCandidates.length,
        eligibleDestinations: eligible.length,
        routedDestinations: 0,
        excludedDestinations: inputCandidates.length - eligible.length,
        exclusionReasons: countReasons(reasons),
      }),
      limitations: sortedUnique([
        ...graph.limitations,
        inputCandidates.length === 0
          ? 'No Overture Starbucks observations were available; absence cannot support a positive proximity claim.'
          : 'No eligible Overture Starbucks destination had a routed pedestrian path from the property.',
        'Closed and prohibited-public candidates are never promoted; unconfirmed candidates require explicit proxy opt-in.',
      ]),
      visibility: mostRestrictiveVisibility([
        request.graphVisibility ?? 'public',
        ...inputCandidates.map((candidate) => candidate.visibility),
      ]),
      evidenceLinks: sortedUnique(
        inputCandidates.map((candidate) => `overture-place:${candidate.gersId}`),
      ),
    });
  }

  const candidate = nearest.candidate;
  const route = nearest.route;
  const visibility = mostRestrictiveVisibility([
    request.graphVisibility ?? 'public',
    candidate.visibility,
  ]);
  const value: StarbucksWalkabilityValue = Object.freeze({
    withinThreshold: route.networkDistanceMeters <= request.maximumNetworkDistanceMeters,
    gersId: candidate.gersId,
    name: candidate.name,
    address: candidate.address,
    overtureRelease: candidate.release,
    candidateState: candidate.candidateState,
    validationState: candidate.validation.state,
    validationCheckedAt: candidate.validation.checkedAt,
    overtureOperatingStatus: candidate.overtureOperatingStatus,
    matchMode: candidate.matchMode,
    confidence: candidate.confidence,
    contributors: sortedUnique(candidate.contributors),
    sourceLicenses: sortedUnique(candidate.sourceLicenses),
    sourceNotices: sortedUnique(candidate.sourceNotices),
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
    feature: 'starbucks_walkability',
    supportState: nearest.supportState,
    value,
    sourceObservations: sortObservations([
      graphObservation(graph, route.edgeIds, request.graphVisibility ?? 'public'),
      {
        sourceId: candidate.sourceId,
        snapshotId: candidate.snapshotId,
        artifactId: candidate.artifactId,
        recordIds: [candidate.gersId],
        observedAt: candidate.updateTime,
        license: sortedUnique(candidate.sourceLicenses).join(', ') || 'unknown',
        attribution: 'Overture Maps Foundation and listed contributors',
        visibility: candidate.visibility,
      },
    ]),
    calculation: calculation(graph, request),
    asOf: request.asOf,
    coverage: Object.freeze({
      observedDestinations: inputCandidates.length,
      eligibleDestinations: eligible.length,
      routedDestinations: routed.length,
      excludedDestinations: inputCandidates.length - eligible.length,
      exclusionReasons: countReasons(reasons),
    }),
    limitations: sortedUnique([
      ...graph.limitations,
      ...route.limitations,
      'Overture identifies candidate places; the retained validation state determines supported versus proxy treatment.',
      'Walking distance is routed network distance; property and destination snap offsets are shown separately.',
      nearest.supportState === 'proxy'
        ? 'This destination is unconfirmed and remains a proxy requiring review.'
        : 'The sampled-open validation is point-in-time evidence and does not guarantee current operating status.',
    ]),
    visibility,
    evidenceLinks: sortedUnique([
      `artifact:${graph.provenance.artifactId}`,
      `artifact:${candidate.artifactId}`,
      `overture-place:${candidate.gersId}`,
    ]),
  });
}
