import { createHash } from 'node:crypto';

import {
  licenseSnapshotIdSchema,
  sourceIdSchema,
  type LicenseSnapshotId,
  type SourceId,
} from '@oracle/contracts/ids';

export const MTC_PALO_ALTO_DATASET_ID = 'c252-zdg8';
export const MTC_PALO_ALTO_METADATA_URL = 'https://data.bayareametro.gov/api/views/c252-zdg8';
export const MTC_PALO_ALTO_RESOURCE_URL = 'https://data.bayareametro.gov/resource/c252-zdg8.json';
export const MTC_PALO_ALTO_ARCGIS_URL =
  'https://services6.arcgis.com/evmyRZRrsopdeog7/ArcGIS/rest/services/AssessorsParcels/FeatureServer/0';

export const MTC_PALO_ALTO_SOURCE_ID: SourceId = sourceIdSchema.parse(
  'sc:source:mtc-palo-alto-year-built',
);

export const MTC_PALO_ALTO_METADATA_ARTIFACT_SHA256 =
  '0e157ee43ad02b02d7fef03d286ada8a8b33df85faa855d5b3c1651e812c5f8a';

export const MTC_PALO_ALTO_LICENSE_SNAPSHOT_ID: LicenseSnapshotId = licenseSnapshotIdSchema.parse(
  `sc:license:mtc-palo-alto-year-built:${MTC_PALO_ALTO_METADATA_ARTIFACT_SHA256}`,
);

export const MTC_PALO_ALTO_VISIBILITY = 'prohibited_public' as const;
export const MTC_PALO_ALTO_CONTRACT_VERSION = '2.0.0';
export const MTC_PALO_ALTO_TRANSFORM_VERSION = '1.0.0';

export const MTC_PALO_ALTO_FIELDS = Object.freeze([
  'objectid',
  'gid',
  'apn',
  'yearbuilt',
  'effectiveyearbuilt',
  'zonegis',
  'floodzone',
  'nearcreekfeature',
  'x',
  'y',
  'the_geom',
  'addressdescription',
  'modifieddate',
] as const);

export type MtcPaloAltoField = (typeof MTC_PALO_ALTO_FIELDS)[number];

export const MTC_PALO_ALTO_SCHEMA = Object.freeze({
  objectid: 'number',
  gid: 'number',
  apn: 'text',
  yearbuilt: 'number',
  effectiveyearbuilt: 'number',
  zonegis: 'text',
  floodzone: 'text',
  nearcreekfeature: 'text',
  x: 'number',
  y: 'number',
  the_geom: 'multipolygon',
  addressdescription: 'text',
  modifieddate: 'date',
} satisfies Readonly<Record<MtcPaloAltoField, string>>);

const schemaCanonical = MTC_PALO_ALTO_FIELDS.map(
  (field) => `${field}:${MTC_PALO_ALTO_SCHEMA[field]}`,
).join('\n');

export const MTC_PALO_ALTO_SCHEMA_FINGERPRINT = createHash('sha256')
  .update(schemaCanonical)
  .digest('hex');

export const PALO_ALTO_WGS84_BOUNDS = Object.freeze({
  west: -122.25,
  south: 37.25,
  east: -121.9,
  north: 37.55,
});

/** ArcGIS layer extent in EPSG:2227 (US survey feet), retained as source coordinates. */
export const PALO_ALTO_EPSG_2227_BOUNDS = Object.freeze({
  west: 6_066_811.730318725,
  south: 1_931_968.662792924,
  east: 6_106_104.076622115,
  north: 2_000_585.7288684745,
});
