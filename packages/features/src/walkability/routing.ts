import type {
  Coordinate,
  RouteFailureReason,
  RouteRequest,
  RouteResult,
  RoutingEdge,
  RoutingGraph,
  RoutingNode,
  RoutingTurnRestriction,
  SnapResult,
} from './types.js';

const EARTH_RADIUS_METERS = 6_371_008.8;
const DEFAULT_WALKING_SPEED_METERS_PER_SECOND = 1.4;
const DISTANCE_EPSILON = 1e-9;

interface PreparedEdge {
  readonly edge: RoutingEdge;
  readonly distanceMeters: number;
}

interface PreparedGraph {
  readonly nodes: ReadonlyMap<string, RoutingNode>;
  readonly adjacency: ReadonlyMap<string, readonly PreparedEdge[]>;
  readonly incidentNodeIds: ReadonlySet<string>;
  readonly componentByNode: ReadonlyMap<string, string>;
  readonly rejectedReasons: Readonly<Record<string, number>>;
  readonly restrictions: readonly RoutingTurnRestriction[];
}

interface QueueItem {
  readonly stateKey: string;
  readonly nodeId: string;
  readonly previousWayId: string;
  readonly distance: number;
  readonly signature: string;
}

interface BestPath {
  readonly distance: number;
  readonly signature: string;
  readonly parentStateKey: string | null;
  readonly edgeId: string | null;
}

class MinHeap {
  readonly #items: QueueItem[] = [];

  public push(item: QueueItem): void {
    this.#items.push(item);
    let index = this.#items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentItem = this.#items[parent];
      if (parentItem === undefined || compareQueue(parentItem, item) <= 0) break;
      this.#items[index] = parentItem;
      index = parent;
    }
    this.#items[index] = item;
  }

  public pop(): QueueItem | undefined {
    const first = this.#items[0];
    const last = this.#items.pop();
    if (first === undefined || last === undefined || this.#items.length === 0) return first;
    let index = 0;
    this.#items[0] = last;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      const leftItem = this.#items[left];
      const rightItem = this.#items[right];
      const smallestItem = this.#items[smallest];
      if (
        leftItem !== undefined &&
        smallestItem !== undefined &&
        compareQueue(leftItem, smallestItem) < 0
      ) {
        smallest = left;
      }
      const candidate = this.#items[smallest];
      if (
        rightItem !== undefined &&
        candidate !== undefined &&
        compareQueue(rightItem, candidate) < 0
      ) {
        smallest = right;
      }
      if (smallest === index) break;
      const current = this.#items[index];
      const next = this.#items[smallest];
      if (current === undefined || next === undefined) break;
      this.#items[index] = next;
      this.#items[smallest] = current;
      index = smallest;
    }
    return first;
  }
}

function compareQueue(left: QueueItem, right: QueueItem): number {
  if (Math.abs(left.distance - right.distance) > DISTANCE_EPSILON) {
    return left.distance < right.distance ? -1 : 1;
  }
  const signature = left.signature.localeCompare(right.signature);
  return signature !== 0 ? signature : left.stateKey.localeCompare(right.stateKey);
}

function radians(value: number): number {
  return (value * Math.PI) / 180;
}

export function coordinateDistanceMeters(left: Coordinate, right: Coordinate): number {
  const latitudeDelta = radians(right[1] - left[1]);
  const longitudeDelta = radians(right[0] - left[0]);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(left[1])) * Math.cos(radians(right[1])) * Math.sin(longitudeDelta / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isCoordinate(value: Coordinate): boolean {
  return (
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    value[0] >= -180 &&
    value[0] <= 180 &&
    value[1] >= -90 &&
    value[1] <= 90
  );
}

function increment(reasons: Map<string, number>, reason: string): void {
  reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function edgeRejectionReasons(
  edge: RoutingEdge,
  from: RoutingNode,
  to: RoutingNode,
): readonly string[] {
  const reasons = [...edge.exclusionReasons];
  if (!edge.routable) reasons.push('edge_marked_non_routable');
  if (edge.pedestrianAccess !== 'allowed') {
    reasons.push(`pedestrian_access_${edge.pedestrianAccess}`);
  }
  const directionAllowed =
    edge.pedestrianDirection === 'both' ||
    (edge.pedestrianDirection === 'forward' && edge.direction === 'forward') ||
    (edge.pedestrianDirection === 'reverse' && edge.direction === 'reverse');
  if (!directionAllowed) reasons.push('pedestrian_direction_disallowed');
  if (from.barrierAccess !== 'allowed' || to.barrierAccess !== 'allowed') {
    reasons.push('barrier_access_not_allowed');
  }
  if (from.crossing?.toLowerCase() === 'no' || to.crossing?.toLowerCase() === 'no') {
    reasons.push('crossing_prohibited');
  }
  if (edge.levels.length > 0) {
    if (from.levels.length > 0 && !intersects(edge.levels, from.levels)) {
      reasons.push('from_level_mismatch');
    }
    if (to.levels.length > 0 && !intersects(edge.levels, to.levels)) {
      reasons.push('to_level_mismatch');
    }
  } else if (
    from.levels.length > 0 &&
    to.levels.length > 0 &&
    !intersects(from.levels, to.levels)
  ) {
    reasons.push('level_discontinuity');
  }
  return [...new Set(reasons)].sort();
}

function edgeDistance(edge: RoutingEdge): number {
  let distance = 0;
  for (let index = 1; index < edge.geometry.length; index += 1) {
    const previous = edge.geometry[index - 1];
    const current = edge.geometry[index];
    if (previous === undefined || current === undefined) throw new Error('invalid edge geometry');
    if (!isCoordinate(previous) || !isCoordinate(current)) throw new Error('invalid coordinate');
    distance += coordinateDistanceMeters(previous, current);
  }
  return distance;
}

function buildComponents(
  nodeIds: readonly string[],
  adjacency: ReadonlyMap<string, readonly PreparedEdge[]>,
): ReadonlyMap<string, string> {
  const undirected = new Map(nodeIds.map((nodeId) => [nodeId, new Set<string>()]));
  for (const [fromNodeId, edges] of adjacency) {
    for (const { edge } of edges) {
      undirected.get(fromNodeId)?.add(edge.toNodeId);
      undirected.get(edge.toNodeId)?.add(fromNodeId);
    }
  }
  const componentByNode = new Map<string, string>();
  const unvisited = new Set(nodeIds);
  while (unvisited.size > 0) {
    const start = [...unvisited].sort()[0];
    if (start === undefined) break;
    const queue = [start];
    const members: string[] = [];
    unvisited.delete(start);
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) continue;
      members.push(current);
      for (const neighbor of [...(undirected.get(current) ?? [])].sort()) {
        if (unvisited.delete(neighbor)) queue.push(neighbor);
      }
    }
    members.sort();
    const componentId = members[0] ?? start;
    for (const member of members) componentByNode.set(member, componentId);
  }
  return componentByNode;
}

function prepareGraph(graph: RoutingGraph): PreparedGraph | null {
  const nodes = new Map<string, RoutingNode>();
  for (const node of graph.nodes) {
    if (
      nodes.has(node.id) ||
      node.id.length === 0 ||
      !isCoordinate([node.longitude, node.latitude])
    ) {
      return null;
    }
    nodes.set(node.id, node);
  }
  if (nodes.size === 0) return null;

  const seenEdges = new Set<string>();
  const adjacency = new Map<string, PreparedEdge[]>();
  const incidentNodeIds = new Set<string>();
  const rejectedReasons = new Map<string, number>();
  for (const edge of [...graph.edges].sort((left, right) => left.id.localeCompare(right.id))) {
    const from = nodes.get(edge.fromNodeId);
    const to = nodes.get(edge.toNodeId);
    if (
      seenEdges.has(edge.id) ||
      edge.id.length === 0 ||
      from === undefined ||
      to === undefined ||
      edge.geometry.length < 2
    ) {
      return null;
    }
    seenEdges.add(edge.id);
    const reasons = edgeRejectionReasons(edge, from, to);
    if (reasons.length > 0) {
      for (const reason of reasons) increment(rejectedReasons, reason);
      continue;
    }
    let distance: number;
    try {
      distance = edgeDistance(edge);
    } catch {
      return null;
    }
    const list = adjacency.get(edge.fromNodeId) ?? [];
    list.push({ edge, distanceMeters: distance });
    adjacency.set(edge.fromNodeId, list);
    incidentNodeIds.add(edge.fromNodeId);
    incidentNodeIds.add(edge.toNodeId);
  }
  const frozenAdjacency = new Map<string, readonly PreparedEdge[]>();
  for (const nodeId of [...nodes.keys()].sort()) {
    frozenAdjacency.set(
      nodeId,
      Object.freeze(
        [...(adjacency.get(nodeId) ?? [])].sort((left, right) =>
          left.edge.id.localeCompare(right.edge.id),
        ),
      ),
    );
  }
  return {
    nodes,
    adjacency: frozenAdjacency,
    incidentNodeIds,
    componentByNode: buildComponents([...nodes.keys()].sort(), frozenAdjacency),
    rejectedReasons: Object.freeze(
      Object.fromEntries(
        [...rejectedReasons.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
    ),
    restrictions: Object.freeze(
      [...graph.turnRestrictions].sort((left, right) => left.id.localeCompare(right.id)),
    ),
  };
}

function nodeCanSnap(
  node: RoutingNode,
  graph: PreparedGraph,
  requestedLevel: string | null,
): boolean {
  if (node.barrierAccess !== 'allowed' || node.crossing?.toLowerCase() === 'no') return false;
  if (requestedLevel !== null && !node.levels.includes(requestedLevel)) return false;
  return graph.incidentNodeIds.has(node.id);
}

function snap(
  coordinate: Coordinate,
  maximumDistance: number,
  level: string | null,
  graph: PreparedGraph,
): SnapResult | null {
  const candidates = [...graph.nodes.values()]
    .filter((node) => nodeCanSnap(node, graph, level))
    .map((node) => ({
      node,
      distance: coordinateDistanceMeters(coordinate, [node.longitude, node.latitude]),
    }))
    .filter(({ distance }) => distance <= maximumDistance)
    .sort(
      (left, right) => left.distance - right.distance || left.node.id.localeCompare(right.node.id),
    );
  const selected = candidates[0];
  return selected === undefined
    ? null
    : Object.freeze({
        nodeId: selected.node.id,
        distanceMeters: roundMeters(selected.distance),
        level,
      });
}

function viaMatches(viaNodeIds: readonly string[], nodeId: string): boolean {
  const osmNodeId = nodeId.startsWith('osm-node:') ? nodeId.slice('osm-node:'.length) : nodeId;
  return viaNodeIds.includes(nodeId) || viaNodeIds.includes(osmNodeId);
}

function transitionAllowed(
  previousWayId: string,
  viaNodeId: string,
  nextWayId: string,
  restrictions: readonly RoutingTurnRestriction[],
): boolean {
  if (previousWayId.length === 0) return true;
  for (const restriction of restrictions) {
    if (
      restriction.pedestrianAccess !== 'forbidden' ||
      !restriction.fromWayIds.includes(previousWayId) ||
      !viaMatches(restriction.viaNodeIds, viaNodeId)
    ) {
      continue;
    }
    const nextIsListed = restriction.toWayIds.includes(nextWayId);
    if (restriction.restriction.startsWith('only_') && !nextIsListed) return false;
    if (!restriction.restriction.startsWith('only_') && nextIsListed) return false;
  }
  return true;
}

function stateKey(nodeId: string, previousWayId: string): string {
  return `${nodeId}\0${previousWayId}`;
}

function reconstruct(
  terminalStateKey: string,
  best: ReadonlyMap<string, BestPath>,
): Readonly<{ nodeIds: readonly string[]; edgeIds: readonly string[] }> {
  const nodeIds: string[] = [];
  const edgeIds: string[] = [];
  let current: string | null = terminalStateKey;
  while (current !== null) {
    const separator = current.indexOf('\0');
    nodeIds.push(current.slice(0, separator));
    const path = best.get(current);
    if (path === undefined) throw new Error('route reconstruction invariant');
    if (path.edgeId !== null) edgeIds.push(path.edgeId);
    current = path.parentStateKey;
  }
  return Object.freeze({
    nodeIds: Object.freeze(nodeIds.reverse()),
    edgeIds: Object.freeze(edgeIds.reverse()),
  });
}

function shortestPath(
  originNodeId: string,
  destinationNodeId: string,
  graph: PreparedGraph,
): Readonly<{ distance: number; nodeIds: readonly string[]; edgeIds: readonly string[] }> | null {
  const startKey = stateKey(originNodeId, '');
  const best = new Map<string, BestPath>([
    [startKey, { distance: 0, signature: '', parentStateKey: null, edgeId: null }],
  ]);
  const queue = new MinHeap();
  queue.push({
    stateKey: startKey,
    nodeId: originNodeId,
    previousWayId: '',
    distance: 0,
    signature: '',
  });

  for (;;) {
    const current = queue.pop();
    if (current === undefined) return null;
    const currentBest = best.get(current.stateKey);
    if (
      currentBest === undefined ||
      Math.abs(currentBest.distance - current.distance) > DISTANCE_EPSILON ||
      currentBest.signature !== current.signature
    ) {
      continue;
    }
    if (current.nodeId === destinationNodeId) {
      return Object.freeze({
        distance: current.distance,
        ...reconstruct(current.stateKey, best),
      });
    }
    for (const prepared of graph.adjacency.get(current.nodeId) ?? []) {
      const edge = prepared.edge;
      if (
        !transitionAllowed(current.previousWayId, current.nodeId, edge.osmWayId, graph.restrictions)
      ) {
        continue;
      }
      const nextKey = stateKey(edge.toNodeId, edge.osmWayId);
      const nextDistance = current.distance + prepared.distanceMeters;
      const nextSignature = `${current.signature}\0${edge.id}`;
      const previous = best.get(nextKey);
      const improves =
        previous === undefined ||
        nextDistance < previous.distance - DISTANCE_EPSILON ||
        (Math.abs(nextDistance - previous.distance) <= DISTANCE_EPSILON &&
          nextSignature.localeCompare(previous.signature) < 0);
      if (!improves) continue;
      best.set(nextKey, {
        distance: nextDistance,
        signature: nextSignature,
        parentStateKey: current.stateKey,
        edgeId: edge.id,
      });
      queue.push({
        stateKey: nextKey,
        nodeId: edge.toNodeId,
        previousWayId: edge.osmWayId,
        distance: nextDistance,
        signature: nextSignature,
      });
    }
  }
}

function roundMeters(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function failure(
  graph: RoutingGraph,
  reason: RouteFailureReason,
  prepared: PreparedGraph | null,
  originSnap: SnapResult | null,
  destinationSnap: SnapResult | null,
  additionalLimitations: readonly string[] = [],
): RouteResult {
  return Object.freeze({
    status: 'unroutable',
    reason,
    originSnap,
    destinationSnap,
    graphVersion: graph.routingProfileVersion,
    graphArtifactId: graph.provenance.artifactId,
    rejectedEdgeReasons: prepared?.rejectedReasons ?? Object.freeze({}),
    limitations: Object.freeze(
      [...new Set([...graph.limitations, ...additionalLimitations])].sort(),
    ),
  });
}

/**
 * Routes entirely over the pinned directed pedestrian graph. Geodesic distance
 * is used only to measure snap offsets and individual graph-edge geometry; it
 * is never substituted for a missing network path.
 */
export function routePedestrian(graph: RoutingGraph, request: RouteRequest): RouteResult {
  const walkingSpeed =
    request.walkingSpeedMetersPerSecond ?? DEFAULT_WALKING_SPEED_METERS_PER_SECOND;
  if (
    !isCoordinate(request.origin) ||
    !isCoordinate(request.destination) ||
    !Number.isFinite(request.maximumSnapDistanceMeters) ||
    request.maximumSnapDistanceMeters < 0 ||
    !Number.isFinite(walkingSpeed) ||
    walkingSpeed <= 0
  ) {
    return failure(graph, 'invalid_request', null, null, null, [
      'Coordinates, snap distance, and walking speed must be finite and within bounds.',
    ]);
  }
  const prepared = prepareGraph(graph);
  if (prepared === null) {
    return failure(graph, 'invalid_graph', null, null, null, [
      'The pinned graph failed structural validation; no route was attempted.',
    ]);
  }
  const originSnap = snap(
    request.origin,
    request.maximumSnapDistanceMeters,
    request.originLevel ?? null,
    prepared,
  );
  if (originSnap === null) {
    return failure(graph, 'origin_snap_failed', prepared, null, null, [
      'No route-eligible pedestrian node was within the bounded origin snap distance.',
    ]);
  }
  const destinationSnap = snap(
    request.destination,
    request.maximumSnapDistanceMeters,
    request.destinationLevel ?? null,
    prepared,
  );
  if (destinationSnap === null) {
    return failure(graph, 'destination_snap_failed', prepared, originSnap, null, [
      'No route-eligible pedestrian node was within the bounded destination snap distance.',
    ]);
  }
  if (
    prepared.componentByNode.get(originSnap.nodeId) !==
    prepared.componentByNode.get(destinationSnap.nodeId)
  ) {
    return failure(graph, 'disconnected_components', prepared, originSnap, destinationSnap, [
      'Origin and destination snapped to disconnected pedestrian components.',
    ]);
  }
  const path = shortestPath(originSnap.nodeId, destinationSnap.nodeId, prepared);
  if (path === null) {
    return failure(graph, 'no_route', prepared, originSnap, destinationSnap, [
      'No directed route obeying pedestrian access, turn, crossing, barrier, and level semantics exists.',
    ]);
  }
  const networkDistanceMeters = roundMeters(path.distance);
  return Object.freeze({
    status: 'routed',
    originSnap,
    destinationSnap,
    nodeIds: path.nodeIds,
    edgeIds: path.edgeIds,
    networkDistanceMeters,
    estimatedWalkSeconds: Math.ceil(networkDistanceMeters / walkingSpeed),
    graphVersion: graph.routingProfileVersion,
    graphArtifactId: graph.provenance.artifactId,
    rejectedEdgeReasons: prepared.rejectedReasons,
    limitations: Object.freeze(
      [
        ...new Set([
          ...graph.limitations,
          'Snap offsets are reported separately from routed network distance.',
        ]),
      ].sort(),
    ),
  });
}
