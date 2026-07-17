export const OVERTURE_STARBUCKS_FIXTURE_PROVENANCE = Object.freeze({
  release: '2026-06-17.0',
  schemaVersion: '1.17.0',
  releaseUri: 's3://overturemaps-us-west-2/release/2026-06-17.0/theme=places/type=place/*',
  sourceFragmentUrl:
    'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/2026-06-17.0/theme=places/type=place/part-00002-85d36905-50d8-5942-afcd-d2023ce6f0f4-c000.zstd.parquet',
  sourceFragmentBytes: 775_230_908,
  sourceFragmentEtag: '"e20962729cacc7f146943e0a566d5d91-12"',
  sourceFragmentCompositeSha256: 'mBV5FIPCcDuz30R/7xdzfjUgmlZm0FKMtfqoVkebBGw=-12',
  sourceFragmentSha256: '565c44c3900d7700998d38962d70c2d53acece8446e0dd23aa54878a80d0c659',
  sourceFragmentLastModified: '2026-06-17T17:24:40.000Z',
  fixtureFile: 'official-overture-2026-06-17-excerpt.geojson',
  fixtureBytes: 4_878,
  fixtureSha256: '6b91c2c2aaf6f407b3aa9e965794a7cfef4ad4889286b917e174b4bd6a2092d1',
  gersIds: Object.freeze([
    '08a87f75-fe95-455d-ab8f-42f37424a70a',
    '346ea5cb-3d37-4661-9001-7d0b0ea36a5a',
    '8fce41a2-c2b5-40f4-b90d-c39f2fa2ec7d',
  ]),
  extraction: Object.freeze({
    tool: '@duckdb/node-api 1.4.5-r.1 on Node 22.18.0',
    selection:
      'Run the documented fixed-column Santa Clara Starbucks query against the pinned fragment, select the three listed GERS IDs, order by id, convert bbox xmin/ymin to Point coordinates, normalize nullable Overture collections to empty JSON collections, and serialize UTF-8 JSON with Prettier 3.9.5 and LF.',
    queryPredicate:
      "id IN ('08a87f75-fe95-455d-ab8f-42f37424a70a','346ea5cb-3d37-4661-9001-7d0b0ea36a5a','8fce41a2-c2b5-40f4-b90d-c39f2fa2ec7d') ORDER BY id",
  }),
  notices: Object.freeze([
    'Overture Maps Foundation, overturemaps.org',
    'AllThePlaces data is available under CC0-1.0.',
    'Foursquare data © 2024 Foursquare Labs, Inc.; available under Apache-2.0; transformed to the Overture schema; see Overture NOTICE.',
    'Overture-derived confidence evidence is available under CDLA-Permissive-2.0.',
  ]),
});
