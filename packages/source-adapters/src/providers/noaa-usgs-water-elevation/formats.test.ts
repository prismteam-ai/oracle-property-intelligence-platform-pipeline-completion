import { readFile } from 'node:fs/promises';

import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  NOAA_CUSP_SHORELINE,
  USGS_3DEP_ELEVATION,
  USGS_3DHP_HYDROGRAPHY,
  WATER_ELEVATION_PRODUCTS,
  assertCurrentProduct,
} from './catalog.js';
import {
  SANTA_CLARA_WATER_TERRAIN_BOUNDS,
  WATER_VIEW_LIMITATIONS,
  assertWaterViewClaim,
} from './adapter.js';
import {
  coordinateToWgs84,
  degreesToApproximateMeters,
  geometryBounds,
  parseSupportedGeometry,
} from './geometry.js';
import {
  decodeElevationGeoTiff,
  decodeHydroFeatureCollection,
  decodeNoaaShorelineArchive,
  summarizeNoDataWindow,
} from './formats.js';

const FIXTURE_ROOT = new URL(
  '../../../../testkit/src/sources/noaa-usgs-water-elevation/',
  import.meta.url,
);

async function fixture(name: string): Promise<Buffer> {
  return readFile(new URL(name, FIXTURE_ROOT));
}

interface OfficialNoaaFeature {
  readonly id: string;
  readonly geometry: Readonly<{
    type: 'LineString';
    coordinates: readonly (readonly [number, number])[];
  }>;
  readonly properties: Readonly<Record<string, string>>;
}

function writeDouble(buffer: Buffer, offset: number, value: number): void {
  buffer.writeDoubleLE(value, offset);
}

function createShapefile(feature: OfficialNoaaFeature): Buffer {
  const points = feature.geometry.coordinates;
  const west = Math.min(...points.map(([longitude]) => longitude));
  const south = Math.min(...points.map(([, latitude]) => latitude));
  const east = Math.max(...points.map(([longitude]) => longitude));
  const north = Math.max(...points.map(([, latitude]) => latitude));
  const contentBytes = 48 + points.length * 16;
  const shp = Buffer.alloc(108 + contentBytes);
  shp.writeInt32BE(9994, 0);
  shp.writeInt32BE(shp.byteLength / 2, 24);
  shp.writeInt32LE(1000, 28);
  shp.writeInt32LE(3, 32);
  [west, south, east, north].forEach((value, index) => writeDouble(shp, 36 + index * 8, value));
  shp.writeInt32BE(8, 100);
  shp.writeInt32BE(contentBytes / 2, 104);
  shp.writeInt32LE(3, 108);
  [west, south, east, north].forEach((value, index) => writeDouble(shp, 112 + index * 8, value));
  shp.writeInt32LE(1, 144);
  shp.writeInt32LE(points.length, 148);
  shp.writeInt32LE(0, 152);
  points.forEach(([longitude, latitude], index) => {
    writeDouble(shp, 156 + index * 16, longitude);
    writeDouble(shp, 164 + index * 16, latitude);
  });
  return shp;
}

function createDbf(properties: Readonly<Record<string, string>>): Buffer {
  const fields = Object.entries(properties).map(([name, value]) => ({
    name,
    value,
    length: Math.max(1, Buffer.byteLength(value, 'utf8')),
  }));
  const headerLength = 32 + fields.length * 32 + 1;
  const recordLength = 1 + fields.reduce((total, field) => total + field.length, 0);
  const dbf = Buffer.alloc(headerLength + recordLength + 1, 0x20);
  dbf[0] = 0x03;
  dbf.writeUInt32LE(1, 4);
  dbf.writeUInt16LE(headerLength, 8);
  dbf.writeUInt16LE(recordLength, 10);
  fields.forEach((field, index) => {
    const offset = 32 + index * 32;
    dbf.write(field.name, offset, Math.min(10, field.name.length), 'ascii');
    dbf[offset + 11] = 0x43;
    dbf[offset + 16] = field.length;
  });
  dbf[headerLength - 1] = 0x0d;
  let recordOffset = headerLength + 1;
  fields.forEach((field) => {
    dbf.write(field.value, recordOffset, field.length, 'utf8');
    recordOffset += field.length;
  });
  dbf[headerLength + recordLength] = 0x1a;
  return dbf;
}

const WGS84_ESRI_WKT =
  'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]]';
const NAD83_ESRI_WKT =
  'GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]]';

async function noaaExcerptArchive(projection = WGS84_ESRI_WKT): Promise<Uint8Array> {
  const collection = JSON.parse(
    (await fixture('noaa-cusp-west-record-8.geojson')).toString('utf8'),
  );
  const feature = collection.features[0] as OfficialNoaaFeature;
  return zipSync(
    {
      'West.shp': createShapefile(feature),
      'West.dbf': createDbf(feature.properties),
      'West.prj': new TextEncoder().encode(projection),
    },
    { level: 9 },
  );
}

describe('NOAA/USGS water and elevation formats', () => {
  it('decodes a deterministic SHP/DBF ZIP excerpt derived from the pinned NOAA archive record', async () => {
    const bytes = await noaaExcerptArchive();
    const first = decodeNoaaShorelineArchive(bytes, SANTA_CLARA_WATER_TERRAIN_BOUNDS);
    const second = decodeNoaaShorelineArchive(bytes, SANTA_CLARA_WATER_TERRAIN_BOUNDS);

    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      recordKey: 'record-8-part-0',
      geometry: { type: 'LineString' },
      properties: {
        SRC_DATE: '20130423',
        HOR_ACC: '2.9',
        DAT_SET_CR: 'NOAA',
        NOAA_Regio: 'West',
      },
    });
  });

  it('normalizes the frozen archive NAD83 CRS through the EPSG:1188 null operation', async () => {
    const wgs84 = decodeNoaaShorelineArchive(
      await noaaExcerptArchive(WGS84_ESRI_WKT),
      SANTA_CLARA_WATER_TERRAIN_BOUNDS,
    );
    const nad83 = decodeNoaaShorelineArchive(
      await noaaExcerptArchive(NAD83_ESRI_WKT),
      SANTA_CLARA_WATER_TERRAIN_BOUNDS,
    );

    expect(nad83).toEqual(wgs84);
    expect(nad83).toHaveLength(1);
  });

  it('rejects malformed ZIP bytes, missing members, and NOAA schema drift', async () => {
    expect(() =>
      decodeNoaaShorelineArchive(new Uint8Array([1, 2, 3]), SANTA_CLARA_WATER_TERRAIN_BOUNDS),
    ).toThrow(/valid ZIP/u);
    expect(() =>
      decodeNoaaShorelineArchive(
        zipSync({ 'West.shp': new Uint8Array(100), 'West.dbf': new Uint8Array(100) }),
        SANTA_CLARA_WATER_TERRAIN_BOUNDS,
      ),
    ).toThrow(/missing \.prj/u);

    const valid = await noaaExcerptArchive();
    const corrupted = valid.subarray(0, Math.floor(valid.byteLength / 2));
    expect(() => decodeNoaaShorelineArchive(corrupted, SANTA_CLARA_WATER_TERRAIN_BOUNDS)).toThrow();

    const mismatchedEntries = unzipSync(valid);
    const dbfEntry = Object.entries(mismatchedEntries).find(([name]) => name.endsWith('.dbf'));
    if (dbfEntry === undefined) throw new Error('Expected NOAA DBF fixture member');
    const dbf = Buffer.from(dbfEntry[1]);
    dbf.writeUInt32LE(2, 4);
    const mismatched = zipSync({ ...mismatchedEntries, [dbfEntry[0]]: dbf });
    expect(() => decodeNoaaShorelineArchive(mismatched, SANTA_CLARA_WATER_TERRAIN_BOUNDS)).toThrow(
      /SHP\/DBF record count mismatch/u,
    );

    const unsupportedProjection = zipSync({
      ...mismatchedEntries,
      'West.prj': new TextEncoder().encode(
        'GEOGCS["GCS_North_American_1927",DATUM["D_North_American_1927",SPHEROID["Clarke_1866",6378206.4,294.9786982]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]]',
      ),
    });
    expect(() =>
      decodeNoaaShorelineArchive(unsupportedProjection, SANTA_CLARA_WATER_TERRAIN_BOUNDS),
    ).toThrow(expect.objectContaining({ code: 'SCHEMA_DRIFT', retryable: false, phase: 'decode' }));
  });

  it('decodes the pinned current 3DHP GeoJSON and rejects duplicate IDs/schema drift', async () => {
    const bytes = await fixture('usgs-3dhp-flowline-11jsf.geojson');
    const records = decodeHydroFeatureCollection(bytes, SANTA_CLARA_WATER_TERRAIN_BOUNDS);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      recordKey: '11JSF',
      geometry: { type: 'LineString' },
      properties: { featuretypelabel: 'Waterbody Connector', workunitid: 'NHD' },
    });

    const duplicate = JSON.parse(bytes.toString('utf8')) as { features: unknown[] };
    duplicate.features.push(duplicate.features[0]);
    expect(() =>
      decodeHydroFeatureCollection(
        new TextEncoder().encode(JSON.stringify(duplicate)),
        SANTA_CLARA_WATER_TERRAIN_BOUNDS,
      ),
    ).toThrow(/Duplicate.*11JSF/u);
    expect(() =>
      decodeHydroFeatureCollection(
        new TextEncoder().encode('{"type":"FeatureCollection","features":[{"properties":{}}]}'),
        SANTA_CLARA_WATER_TERRAIN_BOUNDS,
      ),
    ).toThrow(/missing id3dhp/u);
  });

  it('decodes real official GeoTIFF bytes with CRS, bounds, raster metadata, and samples', async () => {
    const encoded = (await fixture('usgs-3dep-alviso-8x8.tiff.base64.txt')).toString('utf8').trim();
    const bytes = Buffer.from(encoded, 'base64');
    const raster = await decodeElevationGeoTiff(bytes);

    expect(raster).toMatchObject({
      width: 8,
      height: 8,
      bands: [1],
      horizontalEpsg: 4326,
      noDataValue: null,
    });
    expect(raster.bounds).toEqual([-121.95000000000002, 37.42, -121.94960000000002, 37.4204]);
    expect(raster.samples).toHaveLength(64);
    expect(Math.min(...raster.samples)).toBeCloseTo(1.86, 2);
    expect(Math.max(...raster.samples)).toBeCloseTo(2.224, 2);

    const corrupted = Uint8Array.from(bytes);
    corrupted[0] = 0;
    await expect(decodeElevationGeoTiff(corrupted)).rejects.toThrow(/GeoTIFF/u);
  });

  it('accounts for nodata windows without treating nodata as terrain', () => {
    expect(summarizeNoDataWindow([1, -9999, 3, -9999], -9999)).toEqual({
      validSamples: 2,
      noDataSamples: 2,
      minimum: 1,
      maximum: 3,
    });
    expect(summarizeNoDataWindow([-9999, -9999], -9999)).toEqual({
      validSamples: 0,
      noDataSamples: 2,
      minimum: null,
      maximum: null,
    });
  });
});

describe('water/elevation geometry, product, and claim invariants', () => {
  it('converts EPSG:3857 and degree resolutions without confusing units', () => {
    const [longitude, latitude] = coordinateToWgs84([-13_575_200, 4_505_000], 3857);
    expect(longitude).toBeCloseTo(-121.95, 1);
    expect(latitude).toBeCloseTo(37.47, 1);
    const [xMeters, yMeters] = degreesToApproximateMeters(0.00005, 0.00005, 37.42);
    expect(xMeters).toBeGreaterThan(4);
    expect(yMeters).toBeGreaterThan(5);
  });

  it('validates Point, LineString, Polygon, and MultiPolygon geometry boundaries', () => {
    const point = parseSupportedGeometry({ type: 'Point', coordinates: [-121.9, 37.4] }, 4326);
    const line = parseSupportedGeometry(
      {
        type: 'LineString',
        coordinates: [
          [-121.9, 37.4],
          [-121.8, 37.5],
        ],
      },
      4326,
    );
    const polygon = parseSupportedGeometry(
      {
        type: 'Polygon',
        coordinates: [
          [
            [-121.9, 37.4],
            [-121.8, 37.4],
            [-121.8, 37.5],
            [-121.9, 37.4],
          ],
        ],
      },
      4326,
    );
    const multiPolygon = parseSupportedGeometry(
      {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [-121.9, 37.4],
              [-121.8, 37.4],
              [-121.8, 37.5],
              [-121.9, 37.4],
            ],
          ],
        ],
      },
      4326,
    );

    expect(geometryBounds(point)).toEqual([-121.9, 37.4, -121.9, 37.4]);
    expect(geometryBounds(line)).toEqual([-121.9, 37.4, -121.8, 37.5]);
    expect(geometryBounds(polygon)).toEqual([-121.9, 37.4, -121.8, 37.5]);
    expect(geometryBounds(multiPolygon)).toEqual([-121.9, 37.4, -121.8, 37.5]);
    expect(() =>
      parseSupportedGeometry({ type: 'LineString', coordinates: [[NaN, 1]] }, 4326),
    ).toThrow();
    expect(() =>
      parseSupportedGeometry(
        {
          type: 'Polygon',
          coordinates: [
            [
              [-1, 1],
              [-1, 2],
              [-2, 2],
              [-2, 1],
            ],
          ],
        },
        4326,
      ),
    ).toThrow(/closed/u);
  });

  it('pins three separately identified current products and rejects retired products', () => {
    expect(WATER_ELEVATION_PRODUCTS.map((product) => product.descriptor.sourceId)).toEqual([
      NOAA_CUSP_SHORELINE.descriptor.sourceId,
      USGS_3DHP_HYDROGRAPHY.descriptor.sourceId,
      USGS_3DEP_ELEVATION.descriptor.sourceId,
    ]);
    expect(
      new Set(WATER_ELEVATION_PRODUCTS.map((product) => product.descriptor.sourceId)).size,
    ).toBe(3);
    WATER_ELEVATION_PRODUCTS.forEach(assertCurrentProduct);
    expect(() => assertCurrentProduct({ ...USGS_3DHP_HYDROGRAPHY, lifecycle: 'retired' })).toThrow(
      /Refusing retired/u,
    );
  });

  it('fails closed on verified-view claims and always retains limitations', () => {
    expect(() => assertWaterViewClaim('candidate')).not.toThrow();
    expect(() => assertWaterViewClaim('verified_view')).toThrow(/never verified views/u);
    expect(WATER_VIEW_LIMITATIONS.join(' ')).toMatch(/buildings.*vegetation/u);
    expect(NOAA_CUSP_SHORELINE.limitations.join(' ')).toMatch(/not a parcel or legal boundary/u);
    expect(USGS_3DHP_HYDROGRAPHY.limitations.join(' ')).toMatch(
      /does not establish a property view/u,
    );
  });
});
