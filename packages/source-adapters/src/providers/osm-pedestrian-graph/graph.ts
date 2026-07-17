import { createHash } from 'node:crypto';

import {
  canonicalMutationSchema,
  type CanonicalMutation,
} from '@oracle/contracts/canonical/mutation';
import { fieldLineageSchema } from '@oracle/contracts/canonical/lineage';
import type { RunId } from '@oracle/contracts/ids';

import { OSM_PEDESTRIAN_GRAPH_PROFILE_VERSION } from './constants.js';
import type {
  PedestrianAccess,
  PedestrianDirection,
  PedestrianGraphComponent,
  PedestrianGraphEdge,
  PedestrianGraphExclusion,
  PedestrianGraphNode,
  PedestrianGraphSnapshot,
  PedestrianTurnRestriction,
  PinnedOsmExtract,
  ValidatedOsmElement,
  ValidatedOsmPedestrianRecord,
  ValidatedOsmRelation,
  ValidatedOsmWay,
} from './types.js';

const IMPLICIT_PEDESTRIAN_HIGHWAYS = new Set([
  'footway',
  'living_street',
  'path',
  'pedestrian',
  'steps',
]);
const SUPPORTED_PEDESTRIAN_HIGHWAYS = new Set([
  ...IMPLICIT_PEDESTRIAN_HIGHWAYS,
  'cycleway',
  'residential',
  'service',
  'track',
  'unclassified',
]);
const ALLOWED_ACCESS = new Set(['yes', 'designated', 'permissive', 'destination']);
const FORBIDDEN_ACCESS = new Set(['no', 'private']);
const PASSABLE_BARRIERS = new Set([
  'bollard',
  'cycle_barrier',
  'entrance',
  'gate',
  'kissing_gate',
  'lift_gate',
]);
const IMPASSABLE_BARRIERS = new Set(['block', 'fence', 'hedge', 'retaining_wall', 'wall']);

function compareId(left: string, right: string): number {
  const leftId = BigInt(left);
  const rightId = BigInt(right);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
    .join(',')}}`;
}

function sha256(...values: readonly string[]): string {
  const hash = createHash('sha256');
  for (const value of values) hash.update(value).update('\0');
  return hash.digest('hex');
}

function levels(tags: Readonly<Record<string, string>>): readonly string[] {
  const value = tags.level ?? tags.layer;
  if (value === undefined) return Object.freeze([]);
  return Object.freeze(
    [
      ...new Set(
        value
          .split(';')
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ].sort(),
  );
}

function pedestrianAccess(tags: Readonly<Record<string, string>>): PedestrianAccess {
  const foot = tags.foot;
  if (foot !== undefined) {
    if (ALLOWED_ACCESS.has(foot)) return 'allowed';
    if (FORBIDDEN_ACCESS.has(foot)) return 'forbidden';
    return 'unknown';
  }
  const access = tags.access;
  if (access !== undefined) {
    if (FORBIDDEN_ACCESS.has(access)) return 'forbidden';
    if (ALLOWED_ACCESS.has(access)) return 'allowed';
    return 'unknown';
  }
  const highway = tags.highway;
  return highway !== undefined && IMPLICIT_PEDESTRIAN_HIGHWAYS.has(highway) ? 'allowed' : 'unknown';
}

function pedestrianDirection(tags: Readonly<Record<string, string>>): PedestrianDirection {
  const direction = tags['oneway:foot'];
  if (direction === undefined || direction === 'no' || direction === '0' || direction === 'false') {
    return 'both';
  }
  if (direction === 'yes' || direction === '1' || direction === 'true') return 'forward';
  if (direction === '-1' || direction === 'reverse') return 'reverse';
  return 'unknown';
}

function barrierAccess(tags: Readonly<Record<string, string>>): PedestrianAccess {
  const barrier = tags.barrier;
  if (barrier === undefined) return 'allowed';
  const footAccess = pedestrianAccess(tags);
  if (footAccess !== 'unknown') return footAccess;
  if (IMPASSABLE_BARRIERS.has(barrier)) return 'forbidden';
  if (PASSABLE_BARRIERS.has(barrier)) return 'unknown';
  return 'unknown';
}

function sourceElementKey(element: ValidatedOsmElement): string {
  return `${element.type}/${element.id}@${element.version}`;
}

function asGraphNode(record: ValidatedOsmPedestrianRecord): PedestrianGraphNode | undefined {
  if (record.element.type !== 'node') return undefined;
  const element = record.element;
  return Object.freeze({
    id: `osm-node:${element.id}`,
    osmNodeId: element.id,
    longitude: element.longitude,
    latitude: element.latitude,
    levels: levels(element.tags),
    entrance: element.tags.entrance ?? null,
    crossing: element.tags.crossing ?? (element.tags.highway === 'crossing' ? 'unspecified' : null),
    barrier: element.tags.barrier ?? null,
    barrierAccess: barrierAccess(element.tags),
    tags: element.tags,
    sourceElementKey: sourceElementKey(element),
  });
}

function edgeReasons(
  access: PedestrianAccess,
  direction: PedestrianDirection,
  from: PedestrianGraphNode,
  to: PedestrianGraphNode,
  highway: string | undefined,
): readonly string[] {
  const reasons: string[] = [];
  if (highway === undefined || !SUPPORTED_PEDESTRIAN_HIGHWAYS.has(highway)) {
    reasons.push('missing_or_unsupported_highway');
  }
  if (access === 'forbidden') reasons.push('pedestrian_access_forbidden');
  if (access === 'unknown') reasons.push('pedestrian_access_unknown');
  if (direction === 'unknown') reasons.push('pedestrian_direction_unknown');
  if (from.barrierAccess === 'forbidden' || to.barrierAccess === 'forbidden') {
    reasons.push('impassable_barrier');
  }
  if (from.barrierAccess === 'unknown' || to.barrierAccess === 'unknown') {
    reasons.push('barrier_access_unknown');
  }
  return Object.freeze([...new Set(reasons)].sort());
}

function makeEdge(input: {
  way: ValidatedOsmWay;
  segment: number;
  from: PedestrianGraphNode;
  to: PedestrianGraphNode;
  direction: 'forward' | 'reverse';
  pedestrianDirection: PedestrianDirection;
  access: PedestrianAccess;
}): PedestrianGraphEdge {
  const reasons = edgeReasons(
    input.access,
    input.pedestrianDirection,
    input.from,
    input.to,
    input.way.tags.highway,
  );
  const geometry: PedestrianGraphEdge['geometry'] = Object.freeze([
    Object.freeze([input.from.longitude, input.from.latitude] as const),
    Object.freeze([input.to.longitude, input.to.latitude] as const),
  ]);
  return Object.freeze({
    id: `osm-edge:${input.way.id}:${input.segment}:${input.direction}`,
    osmWayId: input.way.id,
    fromNodeId: input.from.id,
    toNodeId: input.to.id,
    geometry,
    direction: input.direction,
    pedestrianDirection: input.pedestrianDirection,
    pedestrianAccess: input.access,
    routable: reasons.length === 0,
    exclusionReasons: reasons,
    highway: input.way.tags.highway ?? null,
    footway: input.way.tags.footway ?? null,
    levels: levels(input.way.tags),
    tags: input.way.tags,
    sourceElementKey: sourceElementKey(input.way),
  });
}

function relationRestriction(
  relation: ValidatedOsmRelation,
): PedestrianTurnRestriction | undefined {
  if (relation.tags.type !== 'restriction') return undefined;
  const restriction = relation.tags['restriction:foot'] ?? relation.tags.restriction;
  if (restriction === undefined) return undefined;
  const except = new Set((relation.tags.except ?? '').split(';').map((item) => item.trim()));
  const pedestrian = relation.tags['restriction:foot'] !== undefined || !except.has('foot');
  return Object.freeze({
    id: `osm-restriction:${relation.id}`,
    osmRelationId: relation.id,
    restriction,
    fromWayIds: Object.freeze(
      relation.members
        .filter((member) => member.type === 'way' && member.role === 'from')
        .map((member) => member.ref)
        .sort(compareId),
    ),
    viaNodeIds: Object.freeze(
      relation.members
        .filter((member) => member.type === 'node' && member.role === 'via')
        .map((member) => member.ref)
        .sort(compareId),
    ),
    toWayIds: Object.freeze(
      relation.members
        .filter((member) => member.type === 'way' && member.role === 'to')
        .map((member) => member.ref)
        .sort(compareId),
    ),
    pedestrianAccess: pedestrian ? 'forbidden' : 'allowed',
    sourceElementKey: sourceElementKey(relation),
  });
}

function components(
  nodes: readonly PedestrianGraphNode[],
  edges: readonly PedestrianGraphEdge[],
): readonly PedestrianGraphComponent[] {
  const adjacency = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of edges) {
    if (!edge.routable) continue;
    adjacency.get(edge.fromNodeId)?.add(edge.toNodeId);
    adjacency.get(edge.toNodeId)?.add(edge.fromNodeId);
  }
  const unvisited = new Set(nodes.map((node) => node.id));
  const result: PedestrianGraphComponent[] = [];
  while (unvisited.size > 0) {
    const start = [...unvisited].sort()[0];
    if (start === undefined) break;
    const queue = [start];
    const nodeIds: string[] = [];
    unvisited.delete(start);
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) continue;
      nodeIds.push(current);
      for (const neighbor of [...(adjacency.get(current) ?? [])].sort()) {
        if (unvisited.delete(neighbor)) queue.push(neighbor);
      }
    }
    nodeIds.sort();
    result.push(
      Object.freeze({ id: `osm-component:${nodeIds[0]}`, nodeIds: Object.freeze(nodeIds) }),
    );
  }
  return Object.freeze(result.sort((left, right) => left.id.localeCompare(right.id)));
}

function deduplicateRecords(
  records: readonly ValidatedOsmPedestrianRecord[],
  exclusions: PedestrianGraphExclusion[],
): readonly ValidatedOsmPedestrianRecord[] {
  const recordsByElement = new Map<string, ValidatedOsmPedestrianRecord>();
  for (const record of records) {
    const key = `${record.element.type}/${record.element.id}`;
    const previous = recordsByElement.get(key);
    if (previous === undefined) {
      recordsByElement.set(key, record);
      continue;
    }
    if (canonicalize(previous.element) !== canonicalize(record.element)) {
      throw new Error(`Conflicting duplicate OSM element: ${key}`);
    }
    exclusions.push(
      Object.freeze({
        sourceElementKey: sourceElementKey(record.element),
        reason: 'duplicate_identical_element',
      }),
    );
  }
  return Object.freeze([...recordsByElement.values()]);
}

export function normalizeOsmPedestrianGraph(input: {
  readonly records: readonly ValidatedOsmPedestrianRecord[];
  readonly extract: PinnedOsmExtract;
  readonly attribution: string;
  readonly notice: string;
}): PedestrianGraphSnapshot {
  if (input.records.length === 0)
    throw new Error('Cannot build a pedestrian graph from no records');
  const first = input.records[0];
  if (first === undefined) throw new Error('Missing first graph record');
  if (
    input.records.some(
      (record) =>
        record.sourceId !== first.sourceId ||
        record.snapshotId !== first.snapshotId ||
        record.artifactId !== first.artifactId,
    )
  ) {
    throw new Error('Pedestrian graph records must share one immutable source artifact');
  }

  const exclusions: PedestrianGraphExclusion[] = [];
  const records = deduplicateRecords(input.records, exclusions);
  const nodes = records
    .map(asGraphNode)
    .filter((node): node is PedestrianGraphNode => node !== undefined)
    .sort((left, right) => compareId(left.osmNodeId, right.osmNodeId));
  const nodeByOsmId = new Map(nodes.map((node) => [node.osmNodeId, node]));
  const edges: PedestrianGraphEdge[] = [];

  for (const record of records) {
    if (record.element.type !== 'way') continue;
    const way = record.element;
    const access = pedestrianAccess(way.tags);
    const direction = pedestrianDirection(way.tags);
    for (let segment = 0; segment < way.nodeRefs.length - 1; segment += 1) {
      const leftRef = way.nodeRefs[segment];
      const rightRef = way.nodeRefs[segment + 1];
      const left = leftRef === undefined ? undefined : nodeByOsmId.get(leftRef);
      const right = rightRef === undefined ? undefined : nodeByOsmId.get(rightRef);
      if (left === undefined || right === undefined) {
        exclusions.push(
          Object.freeze({
            sourceElementKey: sourceElementKey(way),
            reason: `missing_segment_node:${leftRef ?? 'unknown'}:${rightRef ?? 'unknown'}`,
          }),
        );
        continue;
      }
      if (direction !== 'reverse') {
        edges.push(
          makeEdge({
            way,
            segment,
            from: left,
            to: right,
            direction: 'forward',
            pedestrianDirection: direction,
            access,
          }),
        );
      }
      if (direction !== 'forward') {
        edges.push(
          makeEdge({
            way,
            segment,
            from: right,
            to: left,
            direction: 'reverse',
            pedestrianDirection: direction,
            access,
          }),
        );
      }
    }
  }

  const turnRestrictions = records
    .map((record) =>
      record.element.type === 'relation' ? relationRestriction(record.element) : undefined,
    )
    .filter((restriction): restriction is PedestrianTurnRestriction => restriction !== undefined)
    .sort((left, right) => compareId(left.osmRelationId, right.osmRelationId));
  edges.sort((left, right) => left.id.localeCompare(right.id));
  exclusions.sort(
    (left, right) =>
      left.sourceElementKey.localeCompare(right.sourceElementKey) ||
      left.reason.localeCompare(right.reason),
  );

  return Object.freeze({
    schemaVersion: '1.0.0',
    routingProfileVersion: OSM_PEDESTRIAN_GRAPH_PROFILE_VERSION,
    provenance: Object.freeze({
      sourceId: first.sourceId,
      snapshotId: first.snapshotId,
      artifactId: first.artifactId,
      extractId: input.extract.extractId,
      extractTimestamp: input.extract.extractTimestamp,
      distributor: input.extract.distributor,
      sourceUrl: input.extract.url,
      sourceSha256: input.extract.expectedSha256,
      bounds: input.extract.bounds,
      license: 'ODbL-1.0',
      attribution: input.attribution,
      notice: input.notice,
      shareAlike: true,
    }),
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    turnRestrictions: Object.freeze(turnRestrictions),
    components: components(nodes, edges),
    exclusions: Object.freeze(exclusions),
    limitations: Object.freeze([
      'Only edges with allowed pedestrian access and resolved barrier/direction semantics are routable.',
      'Explicit pedestrian permission does not establish traversable topology: an edge also requires a highway class supported by this routing-profile version.',
      'Unknown or forbidden access remains non-routable; absence of a tag is never upgraded beyond the profile defaults.',
      'No edge distance is emitted here: straight-line geometry is not a walking-route distance.',
      'Routing quality is limited by the completeness and accuracy of the pinned OpenStreetMap snapshot.',
    ]),
  });
}

export function createPedestrianGraphReferenceMutation(input: {
  readonly graph: PedestrianGraphSnapshot;
  readonly runId: RunId;
  readonly emittedAt: string;
  readonly sequence: number;
}): CanonicalMutation {
  const graphSha256 = sha256(canonicalize(input.graph));
  const provenance = input.graph.provenance;
  const transformation = Object.freeze({
    name: 'osm-pedestrian-graph-normalization',
    version: input.graph.routingProfileVersion,
    appliedAt: input.emittedAt,
    inputSha256: provenance.sourceSha256,
    outputSha256: graphSha256,
  });
  const lineage = fieldLineageSchema.parse({
    sourceRecord: {
      sourceId: provenance.sourceId,
      snapshotId: provenance.snapshotId,
      artifactId: provenance.artifactId,
      recordKey: provenance.extractId,
      recordSha256: provenance.sourceSha256,
      rawPointer: null,
    },
    transformations: [transformation],
    lineageSha256: sha256(provenance.sourceSha256, canonicalize(transformation)),
  });
  const entityId = `sc:entity:pedestrian-graph-ref:${provenance.extractId}`;
  return canonicalMutationSchema.parse({
    kind: 'entity_upsert',
    mutationId: `sc:mutation:${sha256(input.runId, entityId, graphSha256)}`,
    runId: input.runId,
    sourceId: provenance.sourceId,
    snapshotId: provenance.snapshotId,
    sequence: input.sequence,
    emittedAt: input.emittedAt,
    visibility: 'public',
    entity: {
      id: entityId,
      entityKind: 'pedestrian-graph-ref',
      version: 1,
      validFrom: provenance.extractTimestamp,
      validTo: null,
      recordedAt: input.emittedAt,
      visibility: 'public',
      sourceIds: [provenance.sourceId],
      lineage: [lineage],
      artifactId: provenance.artifactId,
      bounds: provenance.bounds,
      nodeCount: input.graph.nodes.length,
      edgeCount: input.graph.edges.length,
      routingProfileVersion: input.graph.routingProfileVersion,
    },
  });
}

export const osmPedestrianSemantics = Object.freeze({
  pedestrianAccess,
  pedestrianDirection,
  barrierAccess,
});
