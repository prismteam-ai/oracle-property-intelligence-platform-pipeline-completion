import type { ArtifactId, SnapshotId, SourceId } from '@oracle/contracts/ids';
import type { Visibility } from '@oracle/contracts/visibility';

import type { PbfDecodedRecord } from '../../spi/decode.js';
import type { StreamingArtifactContentV2 } from '../../spi/acquired-artifact.js';

export type OsmElementType = 'node' | 'way' | 'relation';

export interface OsmDecodedNode {
  readonly type: 'node';
  readonly id: unknown;
  readonly version: unknown;
  readonly timestamp: unknown;
  readonly latitude: unknown;
  readonly longitude: unknown;
  readonly tags?: unknown;
}

export interface OsmDecodedWay {
  readonly type: 'way';
  readonly id: unknown;
  readonly version: unknown;
  readonly timestamp: unknown;
  readonly nodeRefs: unknown;
  readonly tags?: unknown;
}

export interface OsmDecodedRelationMember {
  readonly type: unknown;
  readonly ref: unknown;
  readonly role: unknown;
}

export interface OsmDecodedRelation {
  readonly type: 'relation';
  readonly id: unknown;
  readonly version: unknown;
  readonly timestamp: unknown;
  readonly members: unknown;
  readonly tags?: unknown;
}

export type OsmDecodedElement = OsmDecodedNode | OsmDecodedWay | OsmDecodedRelation;

export interface OsmPbfDecodeLimits {
  readonly maximumBlobBytes: number;
  readonly maximumTagsPerElement: number;
  readonly maximumWayNodeRefs: number;
  readonly maximumRelationMembers: number;
}

/** Exact export required from a production decoder module before composition imports its decoder. */
export const oracleBoundedOsmDecoderContract = Object.freeze({
  formatVersion: '1.0.0' as const,
  inputContract: 'StreamingArtifactContentV2' as const,
  noNetwork: true as const,
  noWholeCopy: true as const,
  deterministicOrdering: 'nodes_then_ways_then_relations_positive_id_version' as const,
  enforcedLimits: Object.freeze([
    'maximumBlobBytes',
    'maximumTagsPerElement',
    'maximumWayNodeRefs',
    'maximumRelationMembers',
  ] as const),
});

export type BoundedOsmDecoderContract = typeof oracleBoundedOsmDecoderContract;

export interface OsmPbfDecoderModule {
  readonly oracleBoundedOsmDecoderContract: BoundedOsmDecoderContract;
  readonly decoder?: OsmPbfDecoder;
  readonly createDecoder?: () => OsmPbfDecoder;
}

/**
 * The repository intentionally freezes PBF parsing behind this injected port.
 * Implementations may stream a county-scale PBF, but they cannot acquire bytes
 * or call public Overpass from inside the decoder. Implementations must emit
 * nodes, then ways, then relations, with positive IDs in ascending order and
 * duplicate versions adjacent; this permits bounded duplicate verification.
 */
export interface OsmPbfDecoder {
  /** Consume the repeatable bounded source directly; whole-copy decoder ports are not production-safe. */
  decode(
    content: StreamingArtifactContentV2,
    signal: AbortSignal,
    limits: OsmPbfDecodeLimits,
  ): AsyncIterable<OsmDecodedElement>;
}

export interface OsmPedestrianDecodedRecord extends PbfDecodedRecord {
  readonly element: OsmDecodedElement;
  readonly snapshotId: SnapshotId;
  readonly sourceId: SourceId;
  readonly retrievedAt: string;
  readonly sourceAsOf: string;
  readonly recordSha256: string;
}

export interface ValidatedOsmNode {
  readonly type: 'node';
  readonly id: string;
  readonly version: number;
  readonly timestamp: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly tags: Readonly<Record<string, string>>;
}

export interface ValidatedOsmWay {
  readonly type: 'way';
  readonly id: string;
  readonly version: number;
  readonly timestamp: string;
  readonly nodeRefs: readonly string[];
  readonly tags: Readonly<Record<string, string>>;
}

export interface ValidatedOsmRelationMember {
  readonly type: OsmElementType;
  readonly ref: string;
  readonly role: string;
}

export interface ValidatedOsmRelation {
  readonly type: 'relation';
  readonly id: string;
  readonly version: number;
  readonly timestamp: string;
  readonly members: readonly ValidatedOsmRelationMember[];
  readonly tags: Readonly<Record<string, string>>;
}

export type ValidatedOsmElement = ValidatedOsmNode | ValidatedOsmWay | ValidatedOsmRelation;

export interface ValidatedOsmPedestrianRecord {
  readonly artifactId: ArtifactId;
  readonly snapshotId: SnapshotId;
  readonly sourceId: SourceId;
  readonly retrievedAt: string;
  readonly sourceAsOf: string;
  readonly ordinal: number;
  readonly recordSha256: string;
  readonly visibility: Visibility;
  readonly element: ValidatedOsmElement;
}

export type PedestrianAccess = 'allowed' | 'forbidden' | 'unknown';
export type PedestrianDirection = 'both' | 'forward' | 'reverse' | 'unknown';

export interface PedestrianGraphNode {
  readonly id: string;
  readonly osmNodeId: string;
  readonly longitude: number;
  readonly latitude: number;
  readonly levels: readonly string[];
  readonly entrance: string | null;
  readonly crossing: string | null;
  readonly barrier: string | null;
  readonly barrierAccess: PedestrianAccess;
  readonly tags: Readonly<Record<string, string>>;
  readonly sourceElementKey: string;
}

export interface PedestrianGraphEdge {
  readonly id: string;
  readonly osmWayId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly geometry: readonly [readonly [number, number], readonly [number, number]];
  readonly direction: 'forward' | 'reverse';
  readonly pedestrianDirection: PedestrianDirection;
  readonly pedestrianAccess: PedestrianAccess;
  readonly routable: boolean;
  readonly exclusionReasons: readonly string[];
  readonly highway: string | null;
  readonly footway: string | null;
  readonly levels: readonly string[];
  readonly tags: Readonly<Record<string, string>>;
  readonly sourceElementKey: string;
}

export interface PedestrianTurnRestriction {
  readonly id: string;
  readonly osmRelationId: string;
  readonly restriction: string;
  readonly fromWayIds: readonly string[];
  readonly viaNodeIds: readonly string[];
  readonly toWayIds: readonly string[];
  readonly pedestrianAccess: PedestrianAccess;
  readonly sourceElementKey: string;
}

export interface PedestrianGraphComponent {
  readonly id: string;
  readonly nodeIds: readonly string[];
}

export interface PedestrianGraphExclusion {
  readonly sourceElementKey: string;
  readonly reason: string;
}

export interface PedestrianGraphProvenance {
  readonly sourceId: SourceId;
  readonly snapshotId: SnapshotId;
  readonly artifactId: ArtifactId;
  readonly extractId: string;
  readonly extractTimestamp: string;
  readonly distributor: string;
  readonly sourceUrl: string;
  readonly sourceSha256: string;
  readonly bounds: readonly [number, number, number, number];
  readonly license: 'ODbL-1.0';
  readonly attribution: string;
  readonly notice: string;
  readonly shareAlike: true;
}

export interface PedestrianGraphSnapshot {
  readonly schemaVersion: '1.0.0';
  readonly routingProfileVersion: '1.0.0';
  readonly provenance: PedestrianGraphProvenance;
  readonly nodes: readonly PedestrianGraphNode[];
  readonly edges: readonly PedestrianGraphEdge[];
  readonly turnRestrictions: readonly PedestrianTurnRestriction[];
  readonly components: readonly PedestrianGraphComponent[];
  readonly exclusions: readonly PedestrianGraphExclusion[];
  readonly limitations: readonly string[];
}

export interface PinnedOsmExtract {
  readonly extractId: string;
  readonly url: string;
  readonly distributor: string;
  readonly extractTimestamp: string;
  readonly expectedByteSize: number;
  readonly expectedSha256: string;
  readonly expectedEtag: string | null;
  readonly expectedLastModified: string | null;
  readonly bounds: readonly [number, number, number, number];
  readonly distributorChecksum: Readonly<{
    algorithm: 'md5' | 'sha256';
    value: string;
  }>;
}
