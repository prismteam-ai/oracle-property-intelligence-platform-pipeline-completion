import { createHash } from 'node:crypto';

import { sourceDescriptorSchema } from '@oracle/contracts/source';

export const OVERTURE_STARBUCKS_RELEASE = '2026-06-17.0';
export const OVERTURE_STARBUCKS_SCHEMA_VERSION = '1.17.0';
export const OVERTURE_STARBUCKS_SOURCE_ID = 'sc:source:overture-starbucks';
export const STARBUCKS_WIKIDATA_ID = 'Q37158';

export const SANTA_CLARA_OVERTURE_BOUNDS = Object.freeze({
  west: -122.202,
  south: 36.89,
  east: -121.68,
  north: 37.49,
});

export const OVERTURE_PLACES_RELEASE_URI =
  's3://overturemaps-us-west-2/release/2026-06-17.0/theme=places/type=place/*';

export const OVERTURE_PLACES_FRAGMENT_URI =
  'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/2026-06-17.0/theme=places/type=place/part-00002-85d36905-50d8-5942-afcd-d2023ce6f0f4-c000.zstd.parquet';

export const OVERTURE_PLACES_FRAGMENT_BYTES = 775_230_908;
export const OVERTURE_PLACES_FRAGMENT_ETAG = '"e20962729cacc7f146943e0a566d5d91-12"';
export const OVERTURE_PLACES_FRAGMENT_LAST_MODIFIED = '2026-06-17T17:24:40.000Z';

// Filled from a complete anonymous read of the immutable official fragment.
export const OVERTURE_PLACES_FRAGMENT_SHA256 =
  '565c44c3900d7700998d38962d70c2d53acece8446e0dd23aa54878a80d0c659';

// theme/type are NOT columns inside Overture places parquet files — they are
// Hive partition path segments (theme=places/type=place/) of the official
// distribution URL. The pipeline reads the pinned fragment from its
// content-addressed artifact store, whose physical path carries no key=value
// segments, so DuckDB cannot synthesize them and a bare `theme` reference fails
// with a binder error. The pinned fragment lives under theme=places/type=place,
// so every row is by construction theme='places', type='place' — select the
// literals the downstream row guard expects.
export const OVERTURE_STARBUCKS_QUERY = `SELECT
  id,
  version,
  names,
  categories,
  confidence,
  brand,
  addresses,
  sources,
  operating_status,
  basic_category,
  taxonomy,
  bbox.xmin AS longitude,
  bbox.ymin AS latitude,
  'places' AS theme,
  'place' AS type
FROM read_parquet(?)
WHERE bbox.xmin BETWEEN ? AND ?
  AND bbox.ymin BETWEEN ? AND ?
  AND (
    brand.wikidata = ?
    OR lower(names.primary) LIKE ?
    OR lower(brand.names.primary) LIKE ?
  )
  AND id > ?
ORDER BY id`;

export const OVERTURE_STARBUCKS_QUERY_SHA256 = createHash('sha256')
  .update(OVERTURE_STARBUCKS_QUERY)
  .digest('hex');

export const OVERTURE_STARBUCKS_SCHEMA_FINGERPRINT = createHash('sha256')
  .update(
    [
      'id:varchar',
      'version:integer',
      'names:struct',
      'categories:struct',
      'confidence:double',
      'brand:struct?',
      'addresses:struct[]',
      'sources:struct[]',
      'operating_status:varchar?',
      'basic_category:varchar',
      'taxonomy:struct',
      'geometry:point-epsg4326',
      'theme:places',
      'type:place',
    ].join('|'),
  )
  .digest('hex');

const LICENSE_TERMS_SHA256 = createHash('sha256')
  .update(
    'Overture Places 2026-06-17.0: AllThePlaces CC0-1.0; Meta/Microsoft/PinMeTo/Krick/RenderSEO/DAC/BrightQuery CDLA-Permissive-2.0; Foursquare Apache-2.0 with NOTICE.',
  )
  .digest('hex');

const LICENSE_SNAPSHOT_HASH = createHash('sha256')
  .update(`overture-places|${OVERTURE_STARBUCKS_RELEASE}|${LICENSE_TERMS_SHA256}`)
  .digest('hex');

export const OVERTURE_STARBUCKS_LICENSE_SNAPSHOT_ID =
  `sc:license:overture-starbucks:${LICENSE_SNAPSHOT_HASH}` as const;

export const OVERTURE_STARBUCKS_DESCRIPTOR = sourceDescriptorSchema.parse({
  sourceId: OVERTURE_STARBUCKS_SOURCE_ID,
  contractVersion: '2.0.0',
  name: 'Overture Places — Santa Clara Starbucks candidates',
  authority: {
    authorityType: 'recognized_distributor',
    organization: 'Overture Maps Foundation',
    jurisdiction: 'Santa Clara County, California',
    canonicalUrl: 'https://docs.overturemaps.org/guides/places/',
    authorityRank: 20,
  },
  acquisitionMethod: 'static_artifact',
  encodings: ['parquet', 'geojson'],
  entityKinds: ['place'],
  defaultVisibility: 'public',
  license: {
    licenseSnapshotId: OVERTURE_STARBUCKS_LICENSE_SNAPSHOT_ID,
    capturedAt: '2026-07-17T00:00:00.000Z',
    title: `Overture Places attribution and source licenses for ${OVERTURE_STARBUCKS_RELEASE}`,
    canonicalUrl: 'https://docs.overturemaps.org/attribution/',
    termsSha256: LICENSE_TERMS_SHA256,
    redistribution: 'approved',
    containsPersonalData: false,
    attribution: [
      'Overture Maps Foundation, overturemaps.org',
      'Foursquare data © 2024 Foursquare Labs, Inc.; Apache-2.0; transformed to the Overture schema; see NOTICE.',
    ],
    limitations: [
      'Every contributor license and update time remains attached to each candidate.',
      'Overture operating status is source evidence, not sampled official Starbucks-locator validation.',
      'The Starbucks locator is sampled manually only and its restricted content is never persisted.',
    ],
  },
  ratePolicy: {
    maxRequestsPerWindow: 30,
    windowMs: 60_000,
    maxConcurrency: 1,
    maxAttempts: 4,
    initialBackoffMs: 500,
    maxBackoffMs: 8_000,
    jitter: 'none',
    respectRetryAfter: true,
  },
  freshnessSemantics: `Immutable Overture release ${OVERTURE_STARBUCKS_RELEASE}, schema v${OVERTURE_STARBUCKS_SCHEMA_VERSION}; source update times are retained per contributor.`,
});
