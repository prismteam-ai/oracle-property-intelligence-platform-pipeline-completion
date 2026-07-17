export {
  canonicalEntityMetadataSchema,
  conflictResolutionSchema,
  fieldConflictSchema,
  fieldLineageSchema,
  fieldObservationSchema,
  sourceRecordReferenceSchema,
  transformationStepSchema,
} from './lineage.js';
export type {
  CanonicalEntityMetadata,
  ConflictResolution,
  FieldConflict,
  FieldLineage,
  FieldObservation,
  SourceRecordReference,
  TransformationStep,
} from './lineage.js';

export { addressSchema, propertySchema, propertyUnitSchema } from './property.js';
export type { Address, Property, PropertyUnit } from './property.js';

export { permitPropertyLinkSchema, permitSchema } from './permit.js';
export type { Permit, PermitPropertyLink } from './permit.js';

export {
  businessSchema,
  contractorSchema,
  ownershipEventSchema,
  ownershipInterestSchema,
  partyIdentifierSchema,
  partySchema,
} from './organization.js';
export type {
  Business,
  Contractor,
  OwnershipEvent,
  OwnershipInterest,
  Party,
  PartyIdentifier,
} from './organization.js';

export {
  coordinateSchema,
  elevationRasterRefSchema,
  geoBoundingBoxSchema,
  geoGeometrySchema,
  geoLineStringSchema,
  geoMultiPolygonSchema,
  geoPointSchema,
  geoPolygonSchema,
  hydroFeatureSchema,
  latitudeSchema,
  linearRingSchema,
  longitudeSchema,
  pedestrianGraphRefSchema,
  placeSchema,
  transitServiceSchema,
  transitStopSchema,
} from './geospatial.js';
export type {
  Coordinate,
  ElevationRasterRef,
  GeoBoundingBox,
  GeoGeometry,
  GeoLineString,
  GeoMultiPolygon,
  GeoPoint,
  GeoPolygon,
  HydroFeature,
  LinearRing,
  PedestrianGraphRef,
  Place,
  TransitService,
  TransitStop,
} from './geospatial.js';

export {
  canonicalArtifactReferenceSchema,
  canonicalEntitySchema,
  canonicalMutationSchema,
  entityLinkCandidateSchema,
} from './mutation.js';
export type {
  CanonicalArtifactReference,
  CanonicalEntity,
  CanonicalMutation,
  EntityLinkCandidate,
} from './mutation.js';
