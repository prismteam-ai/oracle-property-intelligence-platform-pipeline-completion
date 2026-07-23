export {
  SANTA_CLARA_WATER_TERRAIN_BOUNDS,
  WATER_VIEW_LIMITATIONS,
  assertWaterViewClaim,
  classifyHttpStatus,
  createNoaaCuspShorelineAdapter,
  createNoaaUsgsWaterElevationAdapters,
  createUsgs3depElevationAdapter,
  createUsgs3dhpHydrographyAdapter,
} from './adapter.js';
export type {
  ElevationDecodedRecord,
  WaterElevationAdapterOptions,
  WaterElevationDecodedRecord,
  WaterElevationValidatedRecord,
  WaterVectorDecodedRecord,
  WaterViewClaim,
} from './adapter.js';
export {
  NOAA_CUSP_SHORELINE,
  USGS_3DEP_ELEVATION,
  USGS_3DHP_HYDROGRAPHY,
  WATER_ELEVATION_PRODUCTS,
  assertCurrentProduct,
} from './catalog.js';
export type {
  ProductLifecycle,
  WaterElevationProduct,
  WaterElevationProductKind,
} from './catalog.js';
export {
  assertWgs84Bounds,
  boundsIntersect,
  coordinateToWgs84,
  degreesToApproximateMeters,
  geometryBounds,
  geometryIntersectsBounds,
  parseSupportedGeometry,
} from './geometry.js';
export type { SupportedGeometry, Wgs84Bounds, Wgs84Coordinate } from './geometry.js';
export {
  decodeElevationGeoTiff,
  decodeHydroFeatureCollection,
  decodeNoaaShorelineArchive,
  summarizeNoDataWindow,
} from './formats.js';
export type { DecodedElevationImage, RawVectorFeature } from './formats.js';
