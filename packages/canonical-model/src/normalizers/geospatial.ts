import {
  geoBoundingBoxSchema,
  geoGeometrySchema,
  geoPointSchema,
} from '@oracle/contracts/canonical/geospatial';
import type { GeoBoundingBox, GeoGeometry } from '@oracle/contracts/canonical/geospatial';
import type { CanonicalMutation } from '@oracle/contracts/canonical/mutation';
import { artifactIdSchema, entityIdSchema } from '@oracle/contracts/ids';
import type { ArtifactId, EntityId } from '@oracle/contracts/ids';
import { semverSchema } from '@oracle/contracts/foundation';

import type { CanonicalValue } from '../precedence.js';
import {
  assertExactKeys,
  deterministicEntityId,
  emitCanonicalEntity,
  normalizeNullableDateTime,
  normalizeNullableText,
  normalizeText,
} from './core.js';
import type { AdditionalObservation, CanonicalNormalizationContext } from './core.js';

type SourcePoint = Readonly<{ longitude: number; latitude: number }>;

function point(input: SourcePoint): CanonicalValue {
  return geoPointSchema.parse({ type: 'Point', coordinates: [input.longitude, input.latitude] });
}

export type TransitStopSourceRecord = Readonly<{
  sourceStopId: string;
  agencyId: string;
  stopCode: string;
  name: string;
  location: SourcePoint;
  parentSourceStopId?: string | null;
  boardable: boolean;
  serviceIds?: readonly EntityId[];
}>;

function transitStopId(
  record: Pick<TransitStopSourceRecord, 'sourceStopId' | 'agencyId'>,
  sourceId: string,
) {
  return deterministicEntityId('transit-stop', [
    sourceId,
    normalizeText(record.agencyId, 'agencyId'),
    normalizeText(record.sourceStopId, 'sourceStopId'),
  ]);
}

export function normalizeTransitStopRecord(
  record: TransitStopSourceRecord,
  context: CanonicalNormalizationContext,
): readonly CanonicalMutation[] {
  assertExactKeys(
    record,
    [
      'sourceStopId',
      'agencyId',
      'stopCode',
      'name',
      'location',
      'parentSourceStopId',
      'boardable',
      'serviceIds',
    ],
    'Transit-stop source record',
  );
  assertExactKeys(record.location, ['longitude', 'latitude'], 'Transit-stop location');
  const agencyId = normalizeText(record.agencyId, 'agencyId');
  const parentStopId =
    record.parentSourceStopId === null || record.parentSourceStopId === undefined
      ? null
      : transitStopId({ agencyId, sourceStopId: record.parentSourceStopId }, context.sourceId);
  const serviceIds = [...(record.serviceIds ?? [])]
    .map((id) => entityIdSchema.parse(id))
    .sort((left, right) => left.localeCompare(right));
  return emitCanonicalEntity(
    'transit-stop',
    transitStopId(record, context.sourceId),
    {
      agencyId,
      stopCode: normalizeText(record.stopCode, 'stopCode'),
      name: normalizeText(record.name, 'name'),
      location: point(record.location),
      parentStopId,
      boardable: record.boardable,
      serviceIds,
    },
    context,
  );
}

export type PlaceSourceRecord = Readonly<{
  sourcePlaceId: string;
  name: string;
  categories: readonly string[];
  brandIdentifiers?: readonly string[];
  location: SourcePoint;
  confidence: number;
  validationState?: 'verified_open' | 'candidate' | 'unknown' | 'closed';
}>;

export function normalizePlaceRecord(
  record: PlaceSourceRecord,
  context: CanonicalNormalizationContext,
): readonly CanonicalMutation[] {
  assertExactKeys(
    record,
    [
      'sourcePlaceId',
      'name',
      'categories',
      'brandIdentifiers',
      'location',
      'confidence',
      'validationState',
    ],
    'Place source record',
  );
  assertExactKeys(record.location, ['longitude', 'latitude'], 'Place location');
  const categories = [
    ...new Set(record.categories.map((item) => normalizeText(item, 'category'))),
  ].sort();
  if (categories.length === 0) {
    throw new TypeError('Place categories must not be empty');
  }
  const brandIdentifiers = [
    ...new Set(
      (record.brandIdentifiers ?? []).map((item) => normalizeText(item, 'brandIdentifier')),
    ),
  ].sort();
  if (!Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) {
    throw new RangeError('Place confidence must be between zero and one');
  }
  const sourceState = record.validationState ?? 'unknown';
  const operatingState = sourceState === 'closed' ? 'unknown' : sourceState;
  const additional: readonly AdditionalObservation[] = [
    { fieldPath: '/sourceOperatingState', value: sourceState },
  ];
  return emitCanonicalEntity(
    'place',
    deterministicEntityId('place', [
      context.sourceId,
      normalizeText(record.sourcePlaceId, 'sourcePlaceId'),
    ]),
    {
      name: normalizeText(record.name, 'name'),
      categories,
      brandIdentifiers,
      location: point(record.location),
      confidence: record.confidence,
      // The frozen contract cannot encode `closed`; retaining it as an
      // observation and projecting `unknown` prevents a false open claim.
      operatingState,
    },
    context,
    additional,
  );
}

export type HydroFeatureSourceRecord = Readonly<{
  sourceFeatureId: string;
  name?: string | null;
  featureType: 'shoreline' | 'river' | 'stream' | 'lake' | 'reservoir' | 'wetland' | 'other';
  geometry: GeoGeometry;
}>;

export function normalizeHydroFeatureRecord(
  record: HydroFeatureSourceRecord,
  context: CanonicalNormalizationContext,
): readonly CanonicalMutation[] {
  assertExactKeys(
    record,
    ['sourceFeatureId', 'name', 'featureType', 'geometry'],
    'Hydro-feature source record',
  );
  return emitCanonicalEntity(
    'hydro-feature',
    deterministicEntityId('hydro-feature', [
      context.sourceId,
      normalizeText(record.sourceFeatureId, 'sourceFeatureId'),
    ]),
    {
      name: normalizeNullableText(record.name, 'name'),
      featureType: record.featureType,
      geometry: geoGeometrySchema.parse(record.geometry),
    },
    context,
  );
}

export type PedestrianGraphRefSourceRecord = Readonly<{
  artifactId: ArtifactId;
  bounds: GeoBoundingBox;
  nodeCount: number;
  edgeCount: number;
  routingProfileVersion: string;
}>;

export function normalizePedestrianGraphRefRecord(
  record: PedestrianGraphRefSourceRecord,
  context: CanonicalNormalizationContext,
): readonly CanonicalMutation[] {
  assertExactKeys(
    record,
    ['artifactId', 'bounds', 'nodeCount', 'edgeCount', 'routingProfileVersion'],
    'Pedestrian-graph source record',
  );
  const artifactId = artifactIdSchema.parse(record.artifactId);
  const routingProfileVersion = semverSchema.parse(record.routingProfileVersion);
  return emitCanonicalEntity(
    'pedestrian-graph-ref',
    deterministicEntityId('pedestrian-graph-ref', [artifactId, routingProfileVersion]),
    {
      artifactId,
      bounds: geoBoundingBoxSchema.parse(record.bounds),
      nodeCount: record.nodeCount,
      edgeCount: record.edgeCount,
      routingProfileVersion,
    },
    context,
  );
}

export type ElevationRasterRefSourceRecord = Readonly<{
  artifactId: ArtifactId;
  bounds: GeoBoundingBox;
  horizontalResolutionMeters: number;
  verticalDatum: string;
  sourceAsOf: string;
}>;

export function normalizeElevationRasterRefRecord(
  record: ElevationRasterRefSourceRecord,
  context: CanonicalNormalizationContext,
): readonly CanonicalMutation[] {
  assertExactKeys(
    record,
    ['artifactId', 'bounds', 'horizontalResolutionMeters', 'verticalDatum', 'sourceAsOf'],
    'Elevation-raster source record',
  );
  const artifactId = artifactIdSchema.parse(record.artifactId);
  const sourceAsOf = normalizeNullableDateTime(record.sourceAsOf, 'sourceAsOf');
  if (sourceAsOf === null) {
    throw new TypeError('sourceAsOf is required');
  }
  return emitCanonicalEntity(
    'elevation-raster-ref',
    deterministicEntityId('elevation-raster-ref', [artifactId, sourceAsOf]),
    {
      artifactId,
      bounds: geoBoundingBoxSchema.parse(record.bounds),
      horizontalResolutionMeters: record.horizontalResolutionMeters,
      verticalDatum: normalizeText(record.verticalDatum, 'verticalDatum'),
      sourceAsOf,
    },
    context,
  );
}
