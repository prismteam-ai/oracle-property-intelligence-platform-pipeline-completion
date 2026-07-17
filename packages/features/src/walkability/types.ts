import type { SupportState } from '@oracle/contracts/pipeline';
import type { Visibility } from '@oracle/contracts/visibility';

export type Coordinate = readonly [longitude: number, latitude: number];

export type PedestrianAccess = 'allowed' | 'forbidden' | 'unknown';
export type PedestrianDirection = 'both' | 'forward' | 'reverse' | 'unknown';

export interface RoutingNode {
  readonly id: string;
  readonly longitude: number;
  readonly latitude: number;
  readonly levels: readonly string[];
  readonly crossing: string | null;
  readonly barrier: string | null;
  readonly barrierAccess: PedestrianAccess;
}

export interface RoutingEdge {
  readonly id: string;
  readonly osmWayId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly geometry: readonly Coordinate[];
  readonly direction: 'forward' | 'reverse';
  readonly pedestrianDirection: PedestrianDirection;
  readonly pedestrianAccess: PedestrianAccess;
  readonly routable: boolean;
  readonly exclusionReasons: readonly string[];
  readonly levels: readonly string[];
}

export interface RoutingTurnRestriction {
  readonly id: string;
  readonly restriction: string;
  readonly fromWayIds: readonly string[];
  readonly viaNodeIds: readonly string[];
  readonly toWayIds: readonly string[];
  readonly pedestrianAccess: PedestrianAccess;
}

export interface RoutingGraph {
  readonly routingProfileVersion: string;
  readonly nodes: readonly RoutingNode[];
  readonly edges: readonly RoutingEdge[];
  readonly turnRestrictions: readonly RoutingTurnRestriction[];
  readonly provenance: Readonly<{
    sourceId: string;
    snapshotId: string;
    artifactId: string;
    extractTimestamp: string;
    attribution: string;
    license: string;
  }>;
  readonly limitations: readonly string[];
}

export type RouteFailureReason =
  | 'invalid_request'
  | 'invalid_graph'
  | 'origin_snap_failed'
  | 'destination_snap_failed'
  | 'disconnected_components'
  | 'no_route';

export interface SnapResult {
  readonly nodeId: string;
  readonly distanceMeters: number;
  readonly level: string | null;
}

export interface RouteSuccess {
  readonly status: 'routed';
  readonly originSnap: SnapResult;
  readonly destinationSnap: SnapResult;
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly networkDistanceMeters: number;
  readonly estimatedWalkSeconds: number;
  readonly graphVersion: string;
  readonly graphArtifactId: string;
  readonly rejectedEdgeReasons: Readonly<Record<string, number>>;
  readonly limitations: readonly string[];
}

export interface RouteFailure {
  readonly status: 'unroutable';
  readonly reason: RouteFailureReason;
  readonly originSnap: SnapResult | null;
  readonly destinationSnap: SnapResult | null;
  readonly graphVersion: string;
  readonly graphArtifactId: string;
  readonly rejectedEdgeReasons: Readonly<Record<string, number>>;
  readonly limitations: readonly string[];
}

export type RouteResult = RouteSuccess | RouteFailure;

export interface RouteRequest {
  readonly origin: Coordinate;
  readonly destination: Coordinate;
  readonly maximumSnapDistanceMeters: number;
  readonly walkingSpeedMetersPerSecond?: number;
  readonly originLevel?: string | null;
  readonly destinationLevel?: string | null;
}

export interface SourceObservation {
  readonly sourceId: string;
  readonly snapshotId: string;
  readonly artifactId: string;
  readonly recordIds: readonly string[];
  readonly observedAt: string;
  readonly license: string;
  readonly attribution: string;
  readonly visibility: Visibility;
}

export interface WalkabilityCoverage {
  readonly observedDestinations: number;
  readonly eligibleDestinations: number;
  readonly routedDestinations: number;
  readonly excludedDestinations: number;
  readonly exclusionReasons: Readonly<Record<string, number>>;
}

export interface CalculationReference {
  readonly name: string;
  readonly version: string;
  readonly parameters: Readonly<Record<string, string | number | boolean | null>>;
}

export interface WalkabilityEvidence<TValue> {
  readonly propertyId: string;
  readonly feature: 'transit_walkability' | 'starbucks_walkability';
  readonly supportState: SupportState;
  readonly value: TValue | null;
  readonly sourceObservations: readonly SourceObservation[];
  readonly calculation: CalculationReference;
  readonly asOf: string;
  readonly coverage: WalkabilityCoverage;
  readonly limitations: readonly string[];
  readonly visibility: Visibility;
  readonly evidenceLinks: readonly string[];
}

export type { SupportState, Visibility };
