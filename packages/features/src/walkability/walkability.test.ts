import { describe, expect, it } from 'vitest';

import { rankReviewCandidates, type RankingPolicy } from './ranking.js';
import { routePedestrian } from './routing.js';
import { evaluateStarbucksWalkability, type StarbucksCandidateInput } from './starbucks.js';
import {
  evaluateTransitWalkability,
  type TransitSnapshotInput,
  type TransitStopInput,
} from './transit.js';
import type { Coordinate, RoutingEdge, RoutingGraph, RoutingNode } from './types.js';

const point = (longitude: number, latitude: number): Coordinate => [longitude, latitude];

function node(
  id: string,
  coordinates: Coordinate,
  overrides: Partial<RoutingNode> = {},
): RoutingNode {
  return {
    id,
    longitude: coordinates[0],
    latitude: coordinates[1],
    levels: [],
    crossing: null,
    barrier: null,
    barrierAccess: 'allowed',
    ...overrides,
  };
}

function edge(
  id: string,
  from: RoutingNode,
  to: RoutingNode,
  overrides: Partial<RoutingEdge> = {},
): RoutingEdge {
  return {
    id,
    osmWayId: id.replace(/[^0-9]/gu, '') || id,
    fromNodeId: from.id,
    toNodeId: to.id,
    geometry: [
      [from.longitude, from.latitude],
      [to.longitude, to.latitude],
    ],
    direction: 'forward',
    pedestrianDirection: 'both',
    pedestrianAccess: 'allowed',
    routable: true,
    exclusionReasons: [],
    levels: [],
    ...overrides,
  };
}

function graph(
  nodes: readonly RoutingNode[],
  edges: readonly RoutingEdge[],
  turnRestrictions: RoutingGraph['turnRestrictions'] = [],
): RoutingGraph {
  return {
    routingProfileVersion: '1.0.0',
    nodes,
    edges,
    turnRestrictions,
    provenance: {
      sourceId: 'sc:source:osm-pedestrian-graph',
      snapshotId: 'sc:snapshot:osm-pedestrian-graph:fixture',
      artifactId: 'sc:artifact:sha256:osm-fixture',
      extractTimestamp: '2026-06-01T00:00:00.000Z',
      attribution: 'OpenStreetMap contributors',
      license: 'ODbL-1.0',
    },
    limitations: ['Pinned OSM snapshot may omit recent pedestrian changes.'],
  };
}

const a = node('osm-node:1', point(0, 0));
const b = node('osm-node:2', point(0.001, 0.001));
const c = node('osm-node:3', point(0.002, 0));
const reverse = (value: RoutingEdge): RoutingEdge => ({
  ...value,
  id: `${value.id}-reverse`,
  fromNodeId: value.toNodeId,
  toNodeId: value.fromNodeId,
  geometry: [...value.geometry].reverse(),
  direction: 'reverse',
});
const ab = edge('way-12', a, b);
const bc = edge('way-23', b, c);
const connectedGraph = graph([a, b, c], [ab, reverse(ab), bc, reverse(bc)]);

describe('deterministic offline pedestrian routing', () => {
  it('returns directed graph distance and is independent of input order', () => {
    const request = {
      origin: point(0, 0),
      destination: point(0.002, 0),
      maximumSnapDistanceMeters: 25,
    } as const;
    const first = routePedestrian(connectedGraph, request);
    const replay = routePedestrian(
      graph([...connectedGraph.nodes].reverse(), [...connectedGraph.edges].reverse()),
      request,
    );

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      status: 'routed',
      edgeIds: ['way-12', 'way-23'],
      nodeIds: ['osm-node:1', 'osm-node:2', 'osm-node:3'],
    });
    if (first.status !== 'routed') throw new Error('route missing');
    expect(first.networkDistanceMeters).toBeGreaterThan(300);
    expect(first.networkDistanceMeters).not.toBeCloseTo(222.39, 0);
    expect(first.originSnap.distanceMeters).toBe(0);
  });

  it('does not traverse one-way edges backwards', () => {
    const result = routePedestrian(graph([a, b], [ab]), {
      origin: point(b.longitude, b.latitude),
      destination: point(a.longitude, a.latitude),
      maximumSnapDistanceMeters: 10,
    });
    expect(result).toMatchObject({ status: 'unroutable', reason: 'no_route' });
  });

  it('fails explicitly for barriers, prohibited crossings, and level discontinuity', () => {
    const barred = node('osm-node:4', point(0.001, 0), {
      barrier: 'wall',
      barrierAccess: 'forbidden',
    });
    const blocked = routePedestrian(graph([a, barred], [edge('way-14', a, barred)]), {
      origin: point(0, 0),
      destination: point(0.001, 0),
      maximumSnapDistanceMeters: 10,
    });
    expect(blocked).toMatchObject({ status: 'unroutable', reason: 'origin_snap_failed' });
    expect(blocked.rejectedEdgeReasons).toMatchObject({ barrier_access_not_allowed: 1 });

    const noCrossing = node('osm-node:5', point(0.001, 0), { crossing: 'no' });
    const crossing = routePedestrian(graph([a, noCrossing], [edge('way-15', a, noCrossing)]), {
      origin: point(0, 0),
      destination: point(0.001, 0),
      maximumSnapDistanceMeters: 10,
    });
    expect(crossing.rejectedEdgeReasons).toMatchObject({ crossing_prohibited: 1 });

    const levelZero = node('osm-node:6', point(0, 0), { levels: ['0'] });
    const levelOne = node('osm-node:7', point(0.001, 0), { levels: ['1'] });
    const levels = routePedestrian(
      graph([levelZero, levelOne], [edge('way-67', levelZero, levelOne)]),
      {
        origin: point(0, 0),
        destination: point(0.001, 0),
        maximumSnapDistanceMeters: 10,
      },
    );
    expect(levels.rejectedEdgeReasons).toMatchObject({ level_discontinuity: 1 });
  });

  it('distinguishes disconnected, snap, and turn-restriction failures', () => {
    const d = node('osm-node:4', point(0.01, 0));
    const e = node('osm-node:5', point(0.011, 0));
    const disconnected = routePedestrian(
      graph([a, b, d, e], [ab, reverse(ab), edge('way-45', d, e), reverse(edge('way-45', d, e))]),
      {
        origin: point(a.longitude, a.latitude),
        destination: point(e.longitude, e.latitude),
        maximumSnapDistanceMeters: 10,
      },
    );
    expect(disconnected).toMatchObject({
      status: 'unroutable',
      reason: 'disconnected_components',
    });

    const snapFailure = routePedestrian(connectedGraph, {
      origin: point(1, 1),
      destination: point(c.longitude, c.latitude),
      maximumSnapDistanceMeters: 10,
    });
    expect(snapFailure).toMatchObject({ status: 'unroutable', reason: 'origin_snap_failed' });

    const turnRestricted = routePedestrian(
      graph(
        [a, b, c],
        [ab, bc],
        [
          {
            id: 'restriction-1',
            restriction: 'no_right_turn',
            fromWayIds: [ab.osmWayId],
            viaNodeIds: ['2'],
            toWayIds: [bc.osmWayId],
            pedestrianAccess: 'forbidden',
          },
        ],
      ),
      {
        origin: point(a.longitude, a.latitude),
        destination: point(c.longitude, c.latitude),
        maximumSnapDistanceMeters: 10,
      },
    );
    expect(turnRestricted).toMatchObject({ status: 'unroutable', reason: 'no_route' });
  });
});

function transitStop(
  stopId: string,
  location: Coordinate | null,
  overrides: Partial<TransitStopInput> = {},
): TransitStopInput {
  return {
    stopId,
    stopCode: stopId,
    name: stopId,
    latitude: location?.[1] ?? null,
    longitude: location?.[0] ?? null,
    locationType: 0,
    parentStation: null,
    platformCode: null,
    boardable: true,
    pickupAllowedOnSelectedDate: true,
    dropOffAllowedOnSelectedDate: true,
    activeOnSelectedDate: true,
    routeIds: ['route-22'],
    serviceIds: ['weekday'],
    exclusionReasons: [],
    ...overrides,
  };
}

function transitSnapshot(
  stops: readonly TransitStopInput[],
  overrides: Partial<TransitSnapshotInput> = {},
): TransitSnapshotInput {
  return {
    operator: 'vta',
    role: 'operator_primary',
    sourceId: 'sc:source:vta-gtfs',
    snapshotId: 'sc:snapshot:vta-gtfs:fixture',
    artifactId: 'sc:artifact:sha256:vta-fixture',
    agencyId: 'VTA',
    agencyName: 'Santa Clara Valley Transportation Authority',
    selectedServiceDate: '2026-07-17',
    stops,
    transfers: [],
    observedAt: '2026-07-16T00:00:00.000Z',
    license: 'GTFS publisher terms',
    attribution: 'VTA',
    visibility: 'public',
    limitations: [],
    ...overrides,
  };
}

const transitRequest = {
  propertyId: 'sc:entity:property:transit-fixture',
  propertyLocation: point(a.longitude, a.latitude),
  serviceDate: '2026-07-17',
  maximumNetworkDistanceMeters: 800,
  maximumSnapDistanceMeters: 20,
  asOf: '2026-07-17T00:00:00.000Z',
} as const;

describe('transit walkability evidence', () => {
  it('routes to a linked entrance while preserving the active boardable platform identity', () => {
    const platform = transitStop('platform', point(c.longitude, c.latitude), {
      locationType: 0,
      parentStation: 'station',
      platformCode: '1',
    });
    const station = transitStop('station', null, {
      locationType: 1,
      boardable: false,
      pickupAllowedOnSelectedDate: false,
      activeOnSelectedDate: false,
      serviceIds: [],
    });
    const entrance = transitStop('entrance', point(b.longitude, b.latitude), {
      locationType: 2,
      parentStation: 'station',
      boardable: false,
      pickupAllowedOnSelectedDate: false,
      activeOnSelectedDate: false,
      serviceIds: [],
    });
    const inactiveException = transitStop('inactive-exception', point(a.longitude, a.latitude), {
      activeOnSelectedDate: false,
      pickupAllowedOnSelectedDate: false,
      exclusionReasons: ['calendar_date_removed_service'],
    });
    const snapshot = transitSnapshot([inactiveException, entrance, station, platform], {
      transfers: [{ fromStopId: 'entrance', toStopId: 'platform', transferType: 0 }],
    });
    const result = evaluateTransitWalkability(connectedGraph, [snapshot], transitRequest);

    expect(result).toMatchObject({
      supportState: 'supported',
      value: {
        boardingStop: { stopId: 'platform', platformCode: '1' },
        accessStop: { stopId: 'entrance', relation: 'entrance' },
      },
    });
    expect(result.value?.networkDistanceMeters).toBeGreaterThan(0);
    expect(result.coverage.exclusionReasons).toMatchObject({
      calendar_date_removed_service: 1,
      inactive_on_service_date: expect.any(Number),
    });
    expect(result.limitations.join(' ')).toMatch(/selected GTFS service date/u);
  });

  it('denies inactive, non-boardable, service-date-mismatched, and conflicting duplicate stops', () => {
    const inactive = transitStop('stop', point(b.longitude, b.latitude), {
      activeOnSelectedDate: false,
      exclusionReasons: ['calendar_date_removed_service'],
    });
    const mismatch = transitSnapshot([inactive], { selectedServiceDate: '2026-07-18' });
    const denied = evaluateTransitWalkability(connectedGraph, [mismatch], transitRequest);
    expect(denied).toMatchObject({ supportState: 'unknown', value: null });
    expect(denied.coverage.exclusionReasons).toMatchObject({
      inactive_on_service_date: 1,
      service_date_mismatch: 1,
    });

    const original = transitSnapshot([transitStop('duplicate', point(b.longitude, b.latitude))]);
    const conflict = transitSnapshot(
      [transitStop('duplicate', point(c.longitude, c.latitude), { name: 'Conflicting stop' })],
      { artifactId: 'sc:artifact:sha256:vta-conflict' },
    );
    const duplicateResult = evaluateTransitWalkability(
      connectedGraph,
      [original, conflict],
      transitRequest,
    );
    expect(duplicateResult.supportState).toBe('unknown');
    expect(Object.keys(duplicateResult.coverage.exclusionReasons)).toContain(
      'duplicate_stop_conflict:vta:duplicate',
    );
  });

  it('propagates restricted visibility and never disguises route failures as distance', () => {
    const restricted = transitSnapshot([transitStop('stop', point(c.longitude, c.latitude))], {
      visibility: 'restricted',
    });
    const routed = evaluateTransitWalkability(connectedGraph, [restricted], transitRequest);
    expect(routed.visibility).toBe('restricted');

    const oneWay = graph([a, b], [edge('way-21', b, a)]);
    const unknown = evaluateTransitWalkability(
      oneWay,
      [transitSnapshot([transitStop('stop', point(b.longitude, b.latitude))])],
      transitRequest,
    );
    expect(unknown).toMatchObject({ supportState: 'unknown', value: null });
    expect(unknown.coverage.exclusionReasons).toMatchObject({ routing_no_route: 1 });
  });

  it('obeys forbidden transfers, inclusive distance boundaries, and date validation', () => {
    const platformWithoutGeometry = transitStop('platform', null);
    const entrance = transitStop('entrance', point(b.longitude, b.latitude), {
      locationType: 2,
      boardable: false,
      pickupAllowedOnSelectedDate: false,
      activeOnSelectedDate: false,
      serviceIds: [],
    });
    const forbidden = evaluateTransitWalkability(
      connectedGraph,
      [
        transitSnapshot([entrance, platformWithoutGeometry], {
          transfers: [{ fromStopId: 'entrance', toStopId: 'platform', transferType: 3 }],
        }),
      ],
      transitRequest,
    );
    expect(forbidden).toMatchObject({ supportState: 'unknown', value: null });
    expect(forbidden.coverage.exclusionReasons).toMatchObject({
      forbidden_transfer_topology: 1,
    });

    const initial = evaluateTransitWalkability(
      connectedGraph,
      [transitSnapshot([transitStop('stop', point(c.longitude, c.latitude))])],
      transitRequest,
    );
    if (initial.value === null) throw new Error('transit boundary fixture did not route');
    const boundary = evaluateTransitWalkability(
      connectedGraph,
      [transitSnapshot([transitStop('stop', point(c.longitude, c.latitude))])],
      { ...transitRequest, maximumNetworkDistanceMeters: initial.value.networkDistanceMeters },
    );
    expect(boundary.value?.withinThreshold).toBe(true);
    expect(() =>
      evaluateTransitWalkability(connectedGraph, [transitSnapshot([])], {
        ...transitRequest,
        serviceDate: '2026-02-30',
      }),
    ).toThrow(/valid YYYY-MM-DD/u);
  });

  it('traverses GTFS transfers only backwards from boarding identity to access geometry', () => {
    const platformWithoutGeometry = transitStop('directional-platform', null);
    const entrance = transitStop('directional-entrance', point(b.longitude, b.latitude), {
      locationType: 2,
      boardable: false,
      pickupAllowedOnSelectedDate: false,
      activeOnSelectedDate: false,
      serviceIds: [],
    });
    const intoPlatform = evaluateTransitWalkability(
      connectedGraph,
      [
        transitSnapshot([entrance, platformWithoutGeometry], {
          transfers: [
            {
              fromStopId: 'directional-entrance',
              toStopId: 'directional-platform',
              transferType: 0,
            },
          ],
        }),
      ],
      transitRequest,
    );
    expect(intoPlatform).toMatchObject({
      supportState: 'supported',
      value: {
        boardingStop: { stopId: 'directional-platform' },
        accessStop: { stopId: 'directional-entrance', relation: 'entrance' },
      },
    });

    const outOfPlatform = evaluateTransitWalkability(
      connectedGraph,
      [
        transitSnapshot([entrance, platformWithoutGeometry], {
          transfers: [
            {
              fromStopId: 'directional-platform',
              toStopId: 'directional-entrance',
              transferType: 0,
            },
          ],
        }),
      ],
      transitRequest,
    );
    expect(outOfPlatform).toMatchObject({ supportState: 'unknown', value: null });
  });
});

function starbucksCandidate(
  overrides: Partial<StarbucksCandidateInput> = {},
): StarbucksCandidateInput {
  return {
    gersId: '11111111-1111-4111-8111-111111111111',
    version: 1,
    name: 'Starbucks',
    address: '1 Fixture Way',
    coordinates: point(c.longitude, c.latitude),
    confidence: 0.95,
    release: '2026-06-17.0',
    candidateState: 'candidate',
    overtureOperatingStatus: 'open',
    validation: {
      state: 'sampled_open',
      checkedAt: '2026-07-16T12:00:00.000Z',
      note: 'Name and address matched in a manual sample.',
    },
    matchMode: 'wikidata_exact',
    sourceId: 'sc:source:overture-starbucks',
    snapshotId: 'sc:snapshot:overture-starbucks:fixture',
    artifactId: 'sc:artifact:sha256:overture-fixture',
    updateTime: '2026-06-15T00:00:00.000Z',
    sourceLicenses: ['CDLA-Permissive-2.0'],
    sourceNotices: ['Overture NOTICE'],
    contributors: ['Overture Maps Foundation'],
    visibility: 'public',
    ...overrides,
  };
}

const starbucksRequest = {
  propertyId: 'sc:entity:property:starbucks-fixture',
  propertyLocation: point(a.longitude, a.latitude),
  maximumNetworkDistanceMeters: 800,
  maximumSnapDistanceMeters: 20,
  includeUnconfirmed: false,
  minimumCandidateConfidence: 0.7,
  asOf: '2026-07-17T00:00:00.000Z',
} as const;

describe('Overture Starbucks walkability evidence', () => {
  it('returns supported routed evidence only for a sampled-open candidate', () => {
    const result = evaluateStarbucksWalkability(
      connectedGraph,
      [starbucksCandidate()],
      starbucksRequest,
    );
    expect(result).toMatchObject({
      supportState: 'supported',
      value: {
        validationState: 'sampled_open',
        candidateState: 'candidate',
        matchMode: 'wikidata_exact',
      },
    });
    expect(result.value?.networkDistanceMeters).toBeGreaterThan(300);
    expect(result.sourceObservations).toHaveLength(2);
  });

  it('keeps unconfirmed candidates as opt-in proxies and never promotes closed candidates', () => {
    const unconfirmed = starbucksCandidate({
      validation: {
        state: 'not_sampled',
        checkedAt: null,
        note: 'No official validation was performed.',
      },
    });
    const strict = evaluateStarbucksWalkability(connectedGraph, [unconfirmed], starbucksRequest);
    expect(strict).toMatchObject({ supportState: 'unknown', value: null });
    expect(strict.coverage.exclusionReasons).toMatchObject({ unconfirmed_candidate: 1 });

    const proxy = evaluateStarbucksWalkability(connectedGraph, [unconfirmed], {
      ...starbucksRequest,
      includeUnconfirmed: true,
    });
    expect(proxy).toMatchObject({
      supportState: 'proxy',
      value: { validationState: 'not_sampled' },
    });
    expect(proxy.limitations.join(' ')).toMatch(/unconfirmed/u);

    const closed = evaluateStarbucksWalkability(
      connectedGraph,
      [
        starbucksCandidate({
          candidateState: 'closed_candidate',
          overtureOperatingStatus: 'closed',
          validation: {
            state: 'sampled_closed',
            checkedAt: '2026-07-16T12:00:00.000Z',
            note: 'Closed during manual sample.',
          },
        }),
      ],
      { ...starbucksRequest, includeUnconfirmed: true },
    );
    expect(closed).toMatchObject({ supportState: 'unknown', value: null });
    expect(closed.coverage.exclusionReasons).toMatchObject({ closed_candidate: 1 });
  });

  it('preserves duplicate conflicts and prohibited-public visibility as exclusions', () => {
    const conflict = starbucksCandidate({ coordinates: point(b.longitude, b.latitude) });
    const conflicting = evaluateStarbucksWalkability(
      connectedGraph,
      [starbucksCandidate(), conflict],
      starbucksRequest,
    );
    expect(conflicting.supportState).toBe('unknown');
    expect(Object.keys(conflicting.coverage.exclusionReasons)).toContain(
      `conflicting_same_gers_id:${conflict.gersId}`,
    );

    const prohibited = evaluateStarbucksWalkability(
      connectedGraph,
      [starbucksCandidate({ visibility: 'prohibited_public' })],
      starbucksRequest,
    );
    expect(prohibited).toMatchObject({ supportState: 'unknown', value: null });
    expect(prohibited.coverage.exclusionReasons).toMatchObject({
      prohibited_public_evidence: 1,
    });
    expect(prohibited.visibility).toBe('prohibited_public');
  });

  it('deduplicates materially identical destinations deterministically', () => {
    const duplicate = starbucksCandidate({
      gersId: '22222222-2222-4222-8222-222222222222',
      version: 2,
    });
    const first = evaluateStarbucksWalkability(
      connectedGraph,
      [starbucksCandidate(), duplicate],
      starbucksRequest,
    );
    const replay = evaluateStarbucksWalkability(
      connectedGraph,
      [duplicate, starbucksCandidate()],
      starbucksRequest,
    );
    expect(first).toEqual(replay);
    expect(first.value?.gersId).toBe(duplicate.gersId);
    expect(first.coverage.exclusionReasons).toMatchObject({
      duplicate_material_place_collapsed: 1,
    });

    const addressless = evaluateStarbucksWalkability(
      connectedGraph,
      [
        starbucksCandidate({ address: null }),
        starbucksCandidate({ address: null, gersId: duplicate.gersId }),
      ],
      starbucksRequest,
    );
    expect(addressless.coverage.eligibleDestinations).toBe(2);
    expect(addressless.coverage.exclusionReasons).not.toHaveProperty(
      'duplicate_material_place_collapsed',
    );
  });

  it('validates threshold and WGS84 boundary inputs before evaluating evidence', () => {
    expect(() =>
      evaluateStarbucksWalkability(connectedGraph, [], {
        ...starbucksRequest,
        minimumCandidateConfidence: 1.01,
      }),
    ).toThrow(/thresholds/u);
    expect(() =>
      evaluateStarbucksWalkability(connectedGraph, [], {
        ...starbucksRequest,
        propertyLocation: point(-181, 0),
      }),
    ).toThrow(/WGS84/u);
  });
});

const rankingPolicy: RankingPolicy = {
  policyId: 'oracle-review-ranking-v1',
  version: '1.0.0',
  includeProxy: true,
  minimumEvidenceCoverage: 0.5,
  unknownHandling: 'zero_contribution_and_reduce_coverage',
  components: [
    { criterion: 'transit_walkability', weight: 2, proxyMultiplier: 0.5 },
    { criterion: 'starbucks_walkability', weight: 1, proxyMultiplier: 0.5 },
    { criterion: 'roof_age', weight: 1, proxyMultiplier: 0.25 },
  ],
};

describe('transparent combined ranking', () => {
  const supportedTransit = {
    criterion: 'transit_walkability',
    supportState: 'supported',
    value: 1,
    evidenceLinks: ['evidence:transit'],
    limitations: [],
    visibility: 'public',
  } as const;
  const proxyStarbucks = {
    criterion: 'starbucks_walkability',
    supportState: 'proxy',
    value: 1,
    evidenceLinks: ['evidence:starbucks'],
    limitations: ['Candidate remains unconfirmed.'],
    visibility: 'public',
  } as const;

  it('uses the full configured denominator so missing evidence cannot improve score', () => {
    const result = rankReviewCandidates(
      rankingPolicy,
      [
        { propertyId: 'property-b', signals: [supportedTransit] },
        { propertyId: 'property-a', signals: [supportedTransit, proxyStarbucks] },
      ],
      '2026-07-17T00:00:00.000Z',
    );
    expect(result.candidates.map(({ propertyId }) => propertyId)).toEqual([
      'property-a',
      'property-b',
    ]);
    expect(result.candidates[0]).toMatchObject({
      score: 0.625,
      evidenceCoverage: 0.75,
      components: expect.arrayContaining([
        expect.objectContaining({
          criterion: 'starbucks_walkability',
          appliedMultiplier: 0.5,
          contribution: 0.5,
        }),
      ]),
    });
    expect(result.candidates[1]).toMatchObject({
      score: 0.5,
      evidenceCoverage: 0.5,
    });
    expect(result.calculation.denominator).toBe('all_configured_component_weights');
  });

  it('is order independent, exposes unknowns/exclusions, and propagates visibility', () => {
    const candidates = [
      {
        propertyId: 'property-a',
        signals: [
          proxyStarbucks,
          { ...supportedTransit, visibility: 'restricted' as const },
          {
            criterion: 'roof_age',
            supportState: 'unknown',
            value: null,
            evidenceLinks: [],
            limitations: ['Roof evidence unavailable.'],
            visibility: 'public',
          } as const,
        ],
      },
      { propertyId: 'property-b', signals: [] },
    ] as const;
    const first = rankReviewCandidates(rankingPolicy, candidates, '2026-07-17T00:00:00.000Z');
    const replay = rankReviewCandidates(
      rankingPolicy,
      [...candidates].reverse(),
      '2026-07-17T00:00:00.000Z',
    );
    expect(first.candidates).toEqual(replay.candidates);
    expect(first.candidates[0]).toMatchObject({
      propertyId: 'property-a',
      visibility: 'restricted',
      components: expect.arrayContaining([
        expect.objectContaining({ criterion: 'roof_age', exclusionReason: 'unknown' }),
      ]),
    });
    expect(first.candidates[1]).toMatchObject({
      propertyId: 'property-b',
      rank: null,
      excluded: true,
      score: 0,
      evidenceCoverage: 0,
    });
  });

  it('rejects unconfigured signals and invalid calculation timestamps', () => {
    expect(() =>
      rankReviewCandidates(
        rankingPolicy,
        [
          {
            propertyId: 'property-unconfigured',
            signals: [
              {
                criterion: 'ownership_age',
                supportState: 'supported',
                value: 1,
                evidenceLinks: ['evidence:ownership'],
                limitations: [],
                visibility: 'restricted',
              },
            ],
          },
        ],
        '2026-07-17T00:00:00.000Z',
      ),
    ).toThrow(/not configured by policy/u);
    expect(() => rankReviewCandidates(rankingPolicy, [], '2026-07-17')).toThrow();
    expect(() => rankReviewCandidates(rankingPolicy, [], 'not-a-timestamp')).toThrow();
  });
});
