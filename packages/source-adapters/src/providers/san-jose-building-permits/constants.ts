import { createHash } from 'node:crypto';

import {
  licenseSnapshotIdSchema,
  sourceIdSchema,
  type LicenseSnapshotId,
  type SourceId,
} from '@oracle/contracts/ids';

export const SAN_JOSE_BUILDING_PERMIT_SOURCE_ID: SourceId = sourceIdSchema.parse(
  'sc:source:san-jose-building-permits',
);

export const SAN_JOSE_BUILDING_PERMIT_LICENSE_ID: LicenseSnapshotId = licenseSnapshotIdSchema.parse(
  'sc:license:san-jose-building-permits:a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499',
);

export const SAN_JOSE_FEEDS = ['active', 'expired', 'under_inspection'] as const;
export type SanJosePermitFeed = (typeof SAN_JOSE_FEEDS)[number];

export const SAN_JOSE_CSV_HEADER = [
  'Status',
  'gx_location',
  'ASSESSORS_PARCEL_NUMBER',
  'APPLICANT',
  'OWNERNAME',
  'CONTRACTOR',
  'FOLDERNUMBER',
  'FOLDERDESC',
  'FOLDERNAME',
  'SUBTYPEDESCRIPTION',
  'WORKDESCRIPTION',
  'PERMITAPPROVALS',
  'ISSUEDATE',
  'FINALDATE',
  'DWELLINGUNITS',
  'PERMITVALUATION',
  'SQUAREFOOTAGE',
  'FOLDERRSN',
] as const;

export const SAN_JOSE_SCHEMA_FINGERPRINT = createHash('sha256')
  .update(SAN_JOSE_CSV_HEADER.join('\u001f'))
  .digest('hex');

export const SAN_JOSE_FEED_CONFIG = Object.freeze({
  active: Object.freeze({
    feed: 'active' as const,
    status: 'Active',
    datasetId: 'fd9ceb0c-75e0-402e-9fe3-3f6e04f2c23f',
    resourceId: '761b7ae8-3be1-4ad6-923d-c7af6404a904',
    fileName: 'buildingpermitsactive.csv',
  }),
  expired: Object.freeze({
    feed: 'expired' as const,
    status: 'Expired',
    datasetId: '3b40d486-bd19-44c5-b854-5f0638c2afc3',
    resourceId: 'df4b8461-0c7a-4d16-b85d-ff7f71c5fed5',
    fileName: 'buildingpermitsexpired.csv',
  }),
  under_inspection: Object.freeze({
    feed: 'under_inspection' as const,
    status: 'UnderInspection',
    datasetId: 'ca355e55-c651-4e00-9bde-2c014f229486',
    resourceId: '89ccdad9-7309-4826-a5f3-2fcf1fcb20fa',
    fileName: 'buildingpermitsunderinspection.csv',
  }),
});

export function sanJosePackageMetadataUrl(feed: SanJosePermitFeed): string {
  return `https://data.sanjoseca.gov/api/3/action/package_show?id=${SAN_JOSE_FEED_CONFIG[feed].datasetId}`;
}

export function sanJoseCsvUrl(feed: SanJosePermitFeed): string {
  const config = SAN_JOSE_FEED_CONFIG[feed];
  return `https://data.sanjoseca.gov/dataset/${config.datasetId}/resource/${config.resourceId}/download/${config.fileName}`;
}

export function isSanJosePermitFeed(value: string): value is SanJosePermitFeed {
  return SAN_JOSE_FEEDS.some((feed) => feed === value);
}
