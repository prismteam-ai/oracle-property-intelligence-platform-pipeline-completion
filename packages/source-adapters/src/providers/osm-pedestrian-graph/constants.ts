import { createHash } from 'node:crypto';

import {
  licenseSnapshotIdSchema,
  schemaFingerprintValueSchema,
  sourceIdSchema,
} from '@oracle/contracts/ids';

export const OSM_PEDESTRIAN_GRAPH_SOURCE_ID = sourceIdSchema.parse(
  'sc:source:osm-pedestrian-graph',
);
export const OSM_PEDESTRIAN_GRAPH_CONTRACT_VERSION = '2.0.0' as const;
export const OSM_PEDESTRIAN_GRAPH_PROFILE_VERSION = '1.0.0' as const;

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
export const OSM_NOTICE =
  'Contains information from OpenStreetMap, available under the Open Database License (ODbL) 1.0. Redistributed derivative databases must retain attribution and satisfy ODbL share-alike obligations.';
export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';
export const OSM_ODBL_URL = 'https://opendatacommons.org/licenses/odbl/1-0/';

const NOTICE_SHA256 = createHash('sha256').update(OSM_NOTICE).digest('hex');
export const OSM_LICENSE_SNAPSHOT_ID = licenseSnapshotIdSchema.parse(
  `sc:license:osm-pedestrian-graph:${NOTICE_SHA256}`,
);

export const OSM_DECODED_SCHEMA_FINGERPRINT = schemaFingerprintValueSchema.parse(
  createHash('sha256')
    .update(
      'osm-pbf-decoded-element-v1:node(id,version,timestamp,lat,lon,tags)|way(id,version,timestamp,nodeRefs,tags)|relation(id,version,timestamp,members,tags)',
    )
    .digest('hex'),
);

/**
 * Fixed distributor identity captured without downloading the county-scale
 * artifact. SHA-256 remains deliberately absent here: a production source lock
 * must supply it to `PinnedOsmExtract.expectedSha256` after an approved,
 * integrity-checked acquisition.
 */
export const GEOFABRIK_NORCAL_260715_DISTRIBUTOR_IDENTITY = Object.freeze({
  extractId: 'geofabrik-norcal-260715',
  url: 'https://download.geofabrik.de/north-america/us/california/norcal-260715.osm.pbf',
  distributor: 'Geofabrik GmbH',
  extractTimestamp: '2026-07-15T20:00:00.000Z',
  expectedByteSize: 646_753_595,
  expectedEtag: '"268cad3b-656af935b1984"',
  expectedLastModified: '2026-07-16T00:32:31.000Z',
  bounds: [-125.8935, 35.79231, -115.6468, 42.01618] as const,
  distributorChecksum: Object.freeze({
    algorithm: 'md5' as const,
    value: 'e30b21d7c7cfd4c9e6f4f11cae3bfaa0',
  }),
  sha256State: 'runtime_required_unavailable_in_repository' as const,
});
