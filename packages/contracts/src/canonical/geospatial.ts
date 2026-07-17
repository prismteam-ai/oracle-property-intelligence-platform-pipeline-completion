import { z } from 'zod';

import { isoDateTimeSchema, nonEmptyStringSchema, semverSchema } from '../foundation.js';
import { artifactIdSchema, entityIdSchemaFor } from '../ids.js';
import { canonicalEntityMetadataSchema } from './lineage.js';

export const longitudeSchema = z.number().min(-180).max(180);
export const latitudeSchema = z.number().min(-90).max(90);
export const coordinateSchema = z.tuple([longitudeSchema, latitudeSchema]);
export const linearRingSchema = z.array(coordinateSchema).min(4);

export type Coordinate = z.infer<typeof coordinateSchema>;
export type LinearRing = z.infer<typeof linearRingSchema>;

export const geoPointSchema = z.strictObject({
  type: z.literal('Point'),
  coordinates: coordinateSchema,
});

export type GeoPoint = z.infer<typeof geoPointSchema>;

export const geoPolygonSchema = z.strictObject({
  type: z.literal('Polygon'),
  coordinates: z.array(linearRingSchema).min(1),
});

export type GeoPolygon = z.infer<typeof geoPolygonSchema>;

export const geoMultiPolygonSchema = z.strictObject({
  type: z.literal('MultiPolygon'),
  coordinates: z.array(z.array(linearRingSchema).min(1)).min(1),
});

export type GeoMultiPolygon = z.infer<typeof geoMultiPolygonSchema>;

export const geoLineStringSchema = z.strictObject({
  type: z.literal('LineString'),
  coordinates: z.array(coordinateSchema).min(2),
});

export type GeoLineString = z.infer<typeof geoLineStringSchema>;

export const geoGeometrySchema = z.discriminatedUnion('type', [
  geoPointSchema,
  geoPolygonSchema,
  geoMultiPolygonSchema,
  geoLineStringSchema,
]);

export type GeoGeometry = z.infer<typeof geoGeometrySchema>;

export const geoBoundingBoxSchema = z
  .tuple([longitudeSchema, latitudeSchema, longitudeSchema, latitudeSchema])
  .refine(([west, south, east, north]) => west <= east && south <= north, {
    message: 'Invalid bounding-box coordinate order',
  });

export type GeoBoundingBox = z.infer<typeof geoBoundingBoxSchema>;

const transitStopIdSchema = entityIdSchemaFor('transit-stop');
const transitServiceIdSchema = entityIdSchemaFor('transit-service');
const placeIdSchema = entityIdSchemaFor('place');
const hydroFeatureIdSchema = entityIdSchemaFor('hydro-feature');
const pedestrianGraphRefIdSchema = entityIdSchemaFor('pedestrian-graph-ref');
const elevationRasterRefIdSchema = entityIdSchemaFor('elevation-raster-ref');

export const transitStopSchema = z.strictObject({
  ...canonicalEntityMetadataSchema.shape,
  id: transitStopIdSchema,
  entityKind: z.literal('transit-stop'),
  agencyId: nonEmptyStringSchema,
  stopCode: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  location: geoPointSchema,
  parentStopId: transitStopIdSchema.nullable(),
  boardable: z.boolean(),
  serviceIds: z.array(transitServiceIdSchema),
});

export type TransitStop = z.infer<typeof transitStopSchema>;

export const transitServiceSchema = z.strictObject({
  ...canonicalEntityMetadataSchema.shape,
  id: transitServiceIdSchema,
  entityKind: z.literal('transit-service'),
  agencyId: nonEmptyStringSchema,
  routeId: nonEmptyStringSchema,
  mode: z.enum(['bus', 'light_rail', 'rail', 'tram', 'other']),
  serviceStartDate: z.iso.date(),
  serviceEndDate: z.iso.date(),
});

export type TransitService = z.infer<typeof transitServiceSchema>;

export const placeSchema = z.strictObject({
  ...canonicalEntityMetadataSchema.shape,
  id: placeIdSchema,
  entityKind: z.literal('place'),
  name: nonEmptyStringSchema,
  categories: z.array(nonEmptyStringSchema).min(1),
  brandIdentifiers: z.array(nonEmptyStringSchema),
  location: geoPointSchema,
  confidence: z.number().min(0).max(1),
  operatingState: z.enum(['verified_open', 'candidate', 'unknown']),
});

export type Place = z.infer<typeof placeSchema>;

export const hydroFeatureSchema = z.strictObject({
  ...canonicalEntityMetadataSchema.shape,
  id: hydroFeatureIdSchema,
  entityKind: z.literal('hydro-feature'),
  name: nonEmptyStringSchema.nullable(),
  featureType: z.enum(['shoreline', 'river', 'stream', 'lake', 'reservoir', 'wetland', 'other']),
  geometry: geoGeometrySchema,
});

export type HydroFeature = z.infer<typeof hydroFeatureSchema>;

export const pedestrianGraphRefSchema = z.strictObject({
  ...canonicalEntityMetadataSchema.shape,
  id: pedestrianGraphRefIdSchema,
  entityKind: z.literal('pedestrian-graph-ref'),
  artifactId: artifactIdSchema,
  bounds: geoBoundingBoxSchema,
  nodeCount: z.number().int().nonnegative(),
  edgeCount: z.number().int().nonnegative(),
  routingProfileVersion: semverSchema,
});

export type PedestrianGraphRef = z.infer<typeof pedestrianGraphRefSchema>;

export const elevationRasterRefSchema = z.strictObject({
  ...canonicalEntityMetadataSchema.shape,
  id: elevationRasterRefIdSchema,
  entityKind: z.literal('elevation-raster-ref'),
  artifactId: artifactIdSchema,
  bounds: geoBoundingBoxSchema,
  horizontalResolutionMeters: z.number().positive(),
  verticalDatum: nonEmptyStringSchema,
  sourceAsOf: isoDateTimeSchema,
});

export type ElevationRasterRef = z.infer<typeof elevationRasterRefSchema>;
