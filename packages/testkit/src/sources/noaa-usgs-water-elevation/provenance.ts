export const NOAA_CUSP_FIXTURE_PROVENANCE = Object.freeze({
  catalogUrl: 'https://nsde.ngs.noaa.gov/',
  artifactUrl: 'https://geodesy.noaa.gov/dist_shoreline/West.zip',
  retrievedAt: '2026-07-17T13:00:41.000Z',
  lastModified: '2026-03-24T17:25:55.000Z',
  etag: '"28897d9-64dc8719a4ec0"',
  originalBytes: 42_506_201,
  originalSha256: 'd07277208ab4399b2e62ed6e86d86bbb5cbc7d92cc0bfa499cf156712693b1d6',
  excerptFile: 'noaa-cusp-west-record-8.geojson',
  excerptSha256: '6a478ce433972351d56bf0e39beb96087e56dd6e1ff6f07c64f3623b4baf4e83',
  sourceRecord: 'West.shp record 8 / West.dbf row 8 (zero-based index 7), part 0',
  extraction:
    'Unzip exact archive bytes; pair SHP record 8 with DBF row 8; decode PolyLine little-endian coordinates and DBF fields; serialize one Prettier 3.9.5-formatted GeoJSON feature with fixed property order and LF ending.',
  rights:
    'Selected DBF record identifies DAT_SET_CR=NOAA; NOAA attribution retained. The complete CUSP archive may contain non-NOAA sources and therefore remains redistribution-unknown pending record-level rights review.',
});

export const USGS_3DHP_FIXTURE_PROVENANCE = Object.freeze({
  catalogUrl: 'https://www.usgs.gov/3d-hydrography-program/access-3dhp-data-products',
  serviceUrl: 'https://3dhp.nationalmap.gov/arcgis/rest/services/usgs_3dhp_all/FeatureServer/50',
  retrievedAt: '2026-07-17T13:05:00.000Z',
  serviceVersion: 'ArcGIS 11.3; data refreshed 2026-06-26',
  query:
    'Santa Clara envelope [-122.2,37.15,-121.75,37.55], outSR=4326, OBJECTID order, resultRecordCount=1',
  originalResponseBytes: 672,
  originalResponseSha256: '17686813a1437c7f0e8a30ec0d61609f304b7196af6dcd22274a1e0c3631eb80',
  excerptFile: 'usgs-3dhp-flowline-11jsf.geojson',
  excerptBytes: 917,
  excerptSha256: 'a28f691a9577375406483093259b0947a33dd666cde0d18a71bc651e1038a837',
  extraction:
    'Parse the exact 672-byte response and serialize the unchanged JSON value with Prettier 3.9.5 and an LF ending.',
  rights:
    'USGS service states all data are open and non-proprietary; USGS acknowledgment retained.',
});

export const USGS_3DEP_FIXTURE_PROVENANCE = Object.freeze({
  catalogUrl: 'https://www.usgs.gov/the-national-map-data-delivery/gis-data-download',
  serviceUrl:
    'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage',
  retrievedAt: '2026-07-17T13:10:00.000Z',
  serviceVersion: 'Published 3DEP DEM holdings through 2026-06-23; service credit 2026-06-24',
  request:
    'bbox=-121.9500,37.4200,-121.9496,37.4204; bboxSR=4326; imageSR=4326; size=8,8; F32 GeoTIFF; bilinear; LZW',
  excerptFile: 'usgs-3dep-alviso-8x8.tiff.base64.txt',
  encodedFileSha256: '5947a698e55dfd51bf7a49105afbea68236d0af4483c73bce1c6dfc7a6906302',
  decodedBytes: 1_523,
  decodedSha256: '3883f1e08b8b86bab89f771c9f7c04465e3c94acf1b44aac8bfff9201b951ea7',
  bounds: Object.freeze([-121.95000000000002, 37.42, -121.94960000000002, 37.4204]),
  dimensions: Object.freeze([8, 8]),
  horizontalCrs: 'EPSG:4326 export',
  verticalDatum: 'NAVD88 typical for CONUS; source-project metadata is authoritative',
  verticalUnits: 'meters',
  noDataValue: null,
  rights: 'USGS-authored 3DEP products are public domain; USGS acknowledgment retained.',
});

export const WATER_ELEVATION_FIXTURE_PROVENANCE = Object.freeze([
  NOAA_CUSP_FIXTURE_PROVENANCE,
  USGS_3DHP_FIXTURE_PROVENANCE,
  USGS_3DEP_FIXTURE_PROVENANCE,
]);
