export const OSM_PEDESTRIAN_FIXTURE_PROVENANCE = Object.freeze({
  fixture: 'official-osm-api-excerpt.json',
  sourceUrl:
    'https://api.openstreetmap.org/api/0.6/map.json?bbox=-122.0775,37.3935,-122.0755,37.3950',
  retrievedAt: '2026-07-17T13:01:50.000Z',
  responseDateHeader: 'Fri, 17 Jul 2026 13:01:50 GMT',
  originalResponseBytes: 827_449,
  originalResponseSha256: '189d07439c1becfd99729c94eff937fbda2360dd94834c8e768a44d274bd9ab8',
  canonicalExcerptBytes: 3_097,
  canonicalExcerptSha256: '249ce822d0e91bdd2ed81d4432c9ecc7fee1a9c7cd935889f0e7b91ac5b6425d',
  selection: Object.freeze({
    wayIds: Object.freeze([133_164_448, 152_943_929, 152_945_039]),
    method:
      'Parse the official API response; retain the three listed ways and every referenced node; retain only type/id/version/timestamp, node lat/lon, way node refs, and tags; remove contributor uid/user/changeset; sort elements by type then numeric ID; recursively sort object keys; serialize compact UTF-8 JSON.',
  }),
  bounds: Object.freeze([-122.0775, 37.3935, -122.0755, 37.395] as const),
  attribution: '© OpenStreetMap contributors',
  copyrightUrl: 'https://www.openstreetmap.org/copyright',
  license: 'ODbL-1.0',
  licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
  notice:
    'This is a tiny test-only excerpt, not a production or county-scale dataset. It preserves real footway, crossing, and pedestrian-passable barrier records while removing contributor identifiers.',
  shareAlikeRequiredForDerivativeDatabases: true,
});
