import { sourceDescriptorSchema } from '@oracle/contracts/source';

export const SANTA_CLARA_PARCELS_DATASET_ID = 'ubcd-cewv';
export const SANTA_CLARA_PARCELS_SOURCE_ID = 'sc:source:santa-clara-socrata-parcels' as const;
export const SANTA_CLARA_PARCELS_API_ROOT = 'https://data.sccgov.org/resource/ubcd-cewv.geojson';
export const SANTA_CLARA_PARCELS_METADATA_URL = 'https://data.sccgov.org/api/views/ubcd-cewv';

const METADATA_SNAPSHOT_SHA256 = '915e28bb58f30406f0e85f0a38dc390d651eac2f3ca1523a603d17531bba5368';

export const SANTA_CLARA_PARCELS_SCHEMA_COLUMNS = Object.freeze([
  { position: 1, fieldName: 'the_geom', dataTypeName: 'multipolygon' },
  { position: 2, fieldName: 'objectid', dataTypeName: 'number' },
  { position: 3, fieldName: 'apn', dataTypeName: 'text' },
  { position: 4, fieldName: 'tax_rate_area', dataTypeName: 'number' },
  { position: 5, fieldName: 'situs_house_number', dataTypeName: 'text' },
  { position: 6, fieldName: 'situs_house_number_suffix', dataTypeName: 'text' },
  { position: 7, fieldName: 'situs_street_direction', dataTypeName: 'text' },
  { position: 8, fieldName: 'situs_street_name', dataTypeName: 'text' },
  { position: 9, fieldName: 'situs_street_type', dataTypeName: 'text' },
  { position: 10, fieldName: 'situs_unit_number', dataTypeName: 'text' },
  { position: 11, fieldName: 'situs_city_name', dataTypeName: 'text' },
  { position: 12, fieldName: 'situs_state_code', dataTypeName: 'text' },
  { position: 13, fieldName: 'situs_zip_code', dataTypeName: 'text' },
  { position: 14, fieldName: 'number_of_situs_address', dataTypeName: 'number' },
  { position: 15, fieldName: 'shape_length_stateplane', dataTypeName: 'number' },
  { position: 16, fieldName: 'shape_area_stateplane', dataTypeName: 'number' },
  { position: 17, fieldName: 'ap_lp', dataTypeName: 'text' },
  { position: 18, fieldName: 'reserved1', dataTypeName: 'number' },
  { position: 19, fieldName: 'reserved2', dataTypeName: 'text' },
  { position: 20, fieldName: 'reserved3', dataTypeName: 'text' },
  { position: 21, fieldName: 'jurisdiction', dataTypeName: 'text' },
  { position: 22, fieldName: 'shape_length', dataTypeName: 'number' },
  { position: 23, fieldName: 'shape_area', dataTypeName: 'number' },
] as const);

export const SANTA_CLARA_PARCELS_SCHEMA_FINGERPRINT =
  '6d571cb415e68fa7e323faac9fd9202505f9b3b14be019c85a0d8684142206a1';

export const SANTA_CLARA_PARCELS_CRS = 'urn:ogc:def:crs:OGC:1.3:CRS84';

export const SANTA_CLARA_PARCELS_DESCRIPTOR = sourceDescriptorSchema.parse({
  sourceId: SANTA_CLARA_PARCELS_SOURCE_ID,
  contractVersion: '1.0.0',
  name: 'Santa Clara County Parcels (Socrata ubcd-cewv)',
  authority: {
    authorityType: 'official_government',
    organization: 'County of Santa Clara',
    jurisdiction: 'Santa Clara County, California',
    canonicalUrl: 'https://data.sccgov.org/Government/Parcels/ubcd-cewv/about_data',
    authorityRank: 100,
  },
  acquisitionMethod: 'api',
  encodings: ['geojson', 'json'],
  entityKinds: ['property', 'field-observation'],
  defaultVisibility: 'public',
  license: {
    licenseSnapshotId: `sc:license:santa-clara-socrata-parcels:${METADATA_SNAPSHOT_SHA256}`,
    capturedAt: '2026-07-17T12:56:00.000Z',
    title: 'County of Santa Clara Parcels dataset metadata and GIS disclaimer',
    canonicalUrl: SANTA_CLARA_PARCELS_METADATA_URL,
    termsSha256: METADATA_SNAPSHOT_SHA256,
    redistribution: 'unknown',
    containsPersonalData: false,
    attribution: ['County of Santa Clara, Parcels dataset ubcd-cewv'],
    limitations: [
      'The official metadata does not declare an explicit redistribution license.',
      'The County describes the FY 2025 GIS data as dynamic and requires verification against current public primary information sources.',
      'Public source visibility does not by itself make a later aggregate artifact publication-eligible.',
    ],
  },
  ratePolicy: {
    maxRequestsPerWindow: 1_000,
    windowMs: 3_600_000,
    maxConcurrency: 2,
    maxAttempts: 4,
    initialBackoffMs: 250,
    maxBackoffMs: 4_000,
    jitter: 'none',
    respectRetryAfter: true,
  },
  freshnessSemantics:
    'Snapshot freshness is the Socrata rowsUpdatedAt/Last-Modified instant; source description states FY 2025.',
});

export const SANTA_CLARA_PARCELS_COUNT_URLS = Object.freeze({
  countyRows:
    'https://data.sccgov.org/resource/ubcd-cewv.json?%24select=count%28%2A%29%20as%20count',
  countyDistinctApns:
    'https://data.sccgov.org/resource/ubcd-cewv.json?%24select=count%28distinct%20apn%29%20as%20count',
  paloAltoRows:
    'https://data.sccgov.org/resource/ubcd-cewv.json?%24select=count%28%2A%29%20as%20count&%24where=upper%28jurisdiction%29%3D%27PALO%20ALTO%27',
  paloAltoDistinctApns:
    'https://data.sccgov.org/resource/ubcd-cewv.json?%24select=count%28distinct%20apn%29%20as%20count&%24where=upper%28jurisdiction%29%3D%27PALO%20ALTO%27',
});
