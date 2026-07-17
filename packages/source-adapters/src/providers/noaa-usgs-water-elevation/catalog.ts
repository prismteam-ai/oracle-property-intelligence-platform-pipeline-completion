import { createHash } from 'node:crypto';

import {
  sourceDescriptorSchema,
  type SourceDescriptor,
  type SourceEncoding,
} from '@oracle/contracts/source';

export type WaterElevationProductKind = 'shoreline' | 'hydrography' | 'elevation';
export type ProductLifecycle = 'current' | 'legacy' | 'retired';

export interface WaterElevationProduct {
  readonly kind: WaterElevationProductKind;
  readonly lifecycle: ProductLifecycle;
  readonly descriptor: SourceDescriptor;
  readonly productName: string;
  readonly productVersion: string;
  readonly resolvedArtifactUrl: string;
  readonly catalogUrl: string;
  readonly serviceAsOf: string;
  readonly encoding: SourceEncoding;
  readonly horizontalCrs: string;
  readonly horizontalUnits: string;
  readonly verticalCrs: string | null;
  readonly verticalUnits: string | null;
  readonly nominalResolutionMeters: number | null;
  readonly accuracy: string;
  readonly noDataValue: number | null;
  readonly attribution: readonly string[];
  readonly limitations: readonly string[];
  readonly frozenArtifact: Readonly<{
    byteSize: number;
    sha256: string;
    etag: string;
    lastModified: string;
  }> | null;
}

const CAPTURED_AT = '2026-07-17T00:00:00.000Z';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function descriptor(input: {
  sourceSlug: string;
  name: string;
  canonicalUrl: string;
  acquisitionMethod: 'api' | 'bulk_download';
  encoding: SourceEncoding;
  entityKinds: readonly string[];
  licenseTitle: string;
  licenseUrl: string;
  redistribution: 'approved' | 'unknown';
  attribution: readonly string[];
  limitations: readonly string[];
  freshnessSemantics: string;
}): SourceDescriptor {
  const sourceId = `sc:source:${input.sourceSlug}`;
  const termsSha256 = sha256(
    JSON.stringify({
      title: input.licenseTitle,
      canonicalUrl: input.licenseUrl,
      redistribution: input.redistribution,
      attribution: input.attribution,
      limitations: input.limitations,
    }),
  );
  return sourceDescriptorSchema.parse({
    sourceId,
    contractVersion: '1.0.0',
    name: input.name,
    authority: {
      authorityType: 'official_government',
      organization: input.sourceSlug.startsWith('noaa')
        ? 'NOAA National Geodetic Survey'
        : 'U.S. Geological Survey',
      jurisdiction: 'United States',
      canonicalUrl: input.canonicalUrl,
      authorityRank: 100,
    },
    acquisitionMethod: input.acquisitionMethod,
    encodings: [input.encoding],
    entityKinds: [...input.entityKinds],
    defaultVisibility: input.redistribution === 'approved' ? 'public' : 'authenticated',
    license: {
      licenseSnapshotId: `sc:license:${input.sourceSlug}:${termsSha256}`,
      capturedAt: CAPTURED_AT,
      title: input.licenseTitle,
      canonicalUrl: input.licenseUrl,
      termsSha256,
      redistribution: input.redistribution,
      containsPersonalData: false,
      attribution: [...input.attribution],
      limitations: [...input.limitations],
    },
    ratePolicy: {
      maxRequestsPerWindow: 30,
      windowMs: 60_000,
      maxConcurrency: 2,
      maxAttempts: 4,
      initialBackoffMs: 500,
      maxBackoffMs: 8_000,
      jitter: 'none',
      respectRetryAfter: true,
    },
    freshnessSemantics: input.freshnessSemantics,
  });
}

const NOAA_CATALOG_URL = 'https://nsde.ngs.noaa.gov/';
const NOAA_WEST_URL = 'https://geodesy.noaa.gov/dist_shoreline/West.zip';
const USGS_3DHP_SERVICE =
  'https://3dhp.nationalmap.gov/arcgis/rest/services/usgs_3dhp_all/FeatureServer';
const USGS_3DEP_SERVICE =
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer';

const NOAA_LIMITATIONS = Object.freeze([
  'Shoreline is a surveyed or interpreted land-water interface, not a parcel or legal boundary.',
  'The CUSP archive incorporates NOAA and non-NOAA sources; downstream redistribution must retain record-level source credit and rights review.',
  'Shoreline proximity alone does not establish visibility from a property.',
]);

const USGS_HYDRO_LIMITATIONS = Object.freeze([
  '3DHP is not intended for site-specific regulatory determinations.',
  'A mapped hydrographic feature or proximity to it does not establish a property view.',
]);

const USGS_ELEVATION_LIMITATIONS = Object.freeze([
  'The service is a dynamic mosaic of multi-resolution bare-earth DEM sources.',
  'Bare-earth terrain line-of-sight excludes buildings, trees, windows, observer height, and orientation.',
  'Source-project accuracy and vintage can vary; the source-tile metadata remains authoritative.',
]);

export const NOAA_CUSP_SHORELINE: WaterElevationProduct = Object.freeze({
  kind: 'shoreline',
  lifecycle: 'current',
  descriptor: descriptor({
    sourceSlug: 'noaa-cusp-shoreline',
    name: 'NOAA CUSP / National Shoreline West archive',
    canonicalUrl: NOAA_CATALOG_URL,
    acquisitionMethod: 'bulk_download',
    encoding: 'zip',
    entityKinds: ['hydro-feature'],
    licenseTitle: 'NOAA NSDE CUSP source and rights snapshot',
    licenseUrl: NOAA_CATALOG_URL,
    redistribution: 'unknown',
    attribution: ['NOAA National Geodetic Survey'],
    limitations: NOAA_LIMITATIONS,
    freshnessSemantics:
      'The resolved regional archive is mutable; every run pins its exact bytes, ETag, Last-Modified, archive hash, and source survey dates.',
  }),
  productName: 'Continually Updated Shoreline Product — West regional archive',
  productVersion: 'West.zip last-modified 2026-03-24T17:25:55.000Z',
  resolvedArtifactUrl: NOAA_WEST_URL,
  catalogUrl: NOAA_CATALOG_URL,
  serviceAsOf: '2026-03-24T17:25:55.000Z',
  encoding: 'zip',
  horizontalCrs: 'EPSG:4326 (WGS 84 archive .prj)',
  horizontalUnits: 'decimal_degrees',
  verticalCrs: null,
  verticalUnits: null,
  nominalResolutionMeters: null,
  accuracy: 'Per-feature HOR_ACC and source-survey metadata; no archive-wide accuracy claim.',
  noDataValue: null,
  attribution: Object.freeze(['NOAA National Geodetic Survey']),
  limitations: NOAA_LIMITATIONS,
  frozenArtifact: Object.freeze({
    byteSize: 42_506_201,
    sha256: 'd07277208ab4399b2e62ed6e86d86bbb5cbc7d92cc0bfa499cf156712693b1d6',
    etag: '"28897d9-64dc8719a4ec0"',
    lastModified: '2026-03-24T17:25:55.000Z',
  }),
});

export const USGS_3DHP_HYDROGRAPHY: WaterElevationProduct = Object.freeze({
  kind: 'hydrography',
  lifecycle: 'current',
  descriptor: descriptor({
    sourceSlug: 'usgs-3dhp-hydrography',
    name: 'USGS 3D Hydrography Program flowlines and waterbodies',
    canonicalUrl: USGS_3DHP_SERVICE,
    acquisitionMethod: 'api',
    encoding: 'geojson',
    entityKinds: ['hydro-feature'],
    licenseTitle: 'USGS 3DHP public-domain/open-data service statement',
    licenseUrl: 'https://www.usgs.gov/3d-hydrography-program/access-3dhp-data-products',
    redistribution: 'approved',
    attribution: ['U.S. Geological Survey 3D Hydrography Program'],
    limitations: USGS_HYDRO_LIMITATIONS,
    freshnessSemantics:
      'The current 3DHP service is refreshed periodically; every query URL and response hash are pinned per snapshot.',
  }),
  productName: 'USGS 3DHP all — Flowline layer 50 and Waterbody layer 60',
  productVersion: 'ArcGIS 11.3; data refreshed 2026-06-26',
  resolvedArtifactUrl: `${USGS_3DHP_SERVICE}/50`,
  catalogUrl: 'https://www.usgs.gov/3d-hydrography-program/access-3dhp-data-products',
  serviceAsOf: '2026-06-26T00:00:00.000Z',
  encoding: 'geojson',
  horizontalCrs: 'EPSG:4326 requested output (service native EPSG:3857)',
  horizontalUnits: 'decimal_degrees',
  verticalCrs: null,
  verticalUnits: null,
  nominalResolutionMeters: null,
  accuracy: 'Source work-unit dependent; no site-specific or regulatory accuracy claim.',
  noDataValue: null,
  attribution: Object.freeze(['U.S. Geological Survey 3D Hydrography Program']),
  limitations: USGS_HYDRO_LIMITATIONS,
  frozenArtifact: null,
});

export const USGS_3DEP_ELEVATION: WaterElevationProduct = Object.freeze({
  kind: 'elevation',
  lifecycle: 'current',
  descriptor: descriptor({
    sourceSlug: 'usgs-3dep-elevation',
    name: 'USGS 3DEP bare-earth elevation dynamic service',
    canonicalUrl: USGS_3DEP_SERVICE,
    acquisitionMethod: 'api',
    encoding: 'geotiff',
    entityKinds: ['elevation-raster-ref'],
    licenseTitle: 'USGS 3DEP public-domain data statement',
    licenseUrl: 'https://www.usgs.gov/the-national-map-data-delivery/gis-data-download',
    redistribution: 'approved',
    attribution: ['U.S. Geological Survey 3D Elevation Program'],
    limitations: USGS_ELEVATION_LIMITATIONS,
    freshnessSemantics:
      'The dynamic service reflects published 3DEP DEM holdings as of the declared service date; exact export bytes and parameters are pinned.',
  }),
  productName: 'USGS 3DEP Bare Earth DEM Dynamic service',
  productVersion: 'published holdings through 2026-06-23; service credit 2026-06-24',
  resolvedArtifactUrl: `${USGS_3DEP_SERVICE}/exportImage`,
  catalogUrl: 'https://www.usgs.gov/the-national-map-data-delivery/gis-data-download',
  serviceAsOf: '2026-06-23T00:00:00.000Z',
  encoding: 'geotiff',
  horizontalCrs: 'EPSG:4326 requested output (service native EPSG:3857)',
  horizontalUnits: 'decimal_degrees',
  verticalCrs: 'NAVD88 for CONUS unless source-project metadata states otherwise',
  verticalUnits: 'meters',
  nominalResolutionMeters: 1,
  accuracy:
    'Mixed-source dynamic mosaic; no single accuracy value is asserted without source-project metadata.',
  noDataValue: null,
  attribution: Object.freeze(['U.S. Geological Survey 3D Elevation Program']),
  limitations: USGS_ELEVATION_LIMITATIONS,
  frozenArtifact: null,
});

export const WATER_ELEVATION_PRODUCTS = Object.freeze([
  NOAA_CUSP_SHORELINE,
  USGS_3DHP_HYDROGRAPHY,
  USGS_3DEP_ELEVATION,
]);

export function assertCurrentProduct(product: WaterElevationProduct): void {
  if (product.lifecycle !== 'current') {
    throw new TypeError(
      `Refusing ${product.lifecycle} water/elevation product: ${product.productName}`,
    );
  }
}
