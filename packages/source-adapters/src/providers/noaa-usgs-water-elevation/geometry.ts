import type { JsonValue } from '../../spi/decode.js';

export type Wgs84Coordinate = readonly [number, number];
export type Wgs84Bounds = readonly [number, number, number, number];

export type SupportedGeometry =
  | Readonly<{ type: 'Point'; coordinates: Wgs84Coordinate }>
  | Readonly<{ type: 'LineString'; coordinates: readonly Wgs84Coordinate[] }>
  | Readonly<{
      type: 'Polygon';
      coordinates: readonly (readonly Wgs84Coordinate[])[];
    }>
  | Readonly<{
      type: 'MultiPolygon';
      coordinates: readonly (readonly (readonly Wgs84Coordinate[])[])[];
    }>;

const WEB_MERCATOR_LIMIT = 20_037_508.342789244;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function assertWgs84Bounds(bounds: readonly number[]): asserts bounds is Wgs84Bounds {
  if (
    bounds.length !== 4 ||
    !bounds.every(finite) ||
    bounds[0] === undefined ||
    bounds[1] === undefined ||
    bounds[2] === undefined ||
    bounds[3] === undefined ||
    bounds[0] < -180 ||
    bounds[2] > 180 ||
    bounds[1] < -90 ||
    bounds[3] > 90 ||
    bounds[0] > bounds[2] ||
    bounds[1] > bounds[3]
  ) {
    throw new RangeError('Expected ordered WGS84 bounds');
  }
}

export function coordinateToWgs84(
  coordinate: readonly number[],
  sourceEpsg: 3857 | 4326,
): Wgs84Coordinate {
  const x = coordinate[0];
  const y = coordinate[1];
  if (!finite(x) || !finite(y)) {
    throw new TypeError('Coordinate values must be finite');
  }

  if (sourceEpsg === 4326) {
    if (x < -180 || x > 180 || y < -90 || y > 90) {
      throw new RangeError('Coordinate is outside WGS84 bounds');
    }
    return Object.freeze([x, y]);
  }

  if (Math.abs(x) > WEB_MERCATOR_LIMIT || Math.abs(y) > WEB_MERCATOR_LIMIT) {
    throw new RangeError('Coordinate is outside EPSG:3857 bounds');
  }
  const longitude = (x / WEB_MERCATOR_LIMIT) * 180;
  const latitudeRadians = 2 * Math.atan(Math.exp((y / WEB_MERCATOR_LIMIT) * Math.PI)) - Math.PI / 2;
  const latitude = (latitudeRadians * 180) / Math.PI;
  return Object.freeze([longitude, latitude]);
}

function coordinate(value: JsonValue, sourceEpsg: 3857 | 4326): Wgs84Coordinate {
  if (!Array.isArray(value)) {
    throw new TypeError('Expected coordinate array');
  }
  return coordinateToWgs84(
    value.map((item) => {
      if (!finite(item)) {
        throw new TypeError('Expected numeric coordinate');
      }
      return item;
    }),
    sourceEpsg,
  );
}

function line(value: JsonValue, sourceEpsg: 3857 | 4326): readonly Wgs84Coordinate[] {
  if (!Array.isArray(value)) {
    throw new TypeError('Expected coordinate sequence');
  }
  const values: readonly JsonValue[] = value;
  const result = values.map((item) => coordinate(item, sourceEpsg));
  if (result.length < 2) {
    throw new TypeError('LineString requires at least two coordinates');
  }
  return Object.freeze(result);
}

function ring(value: JsonValue, sourceEpsg: 3857 | 4326): readonly Wgs84Coordinate[] {
  const result = line(value, sourceEpsg);
  if (result.length < 4) {
    throw new TypeError('Polygon ring requires at least four coordinates');
  }
  const first = result[0];
  const last = result.at(-1);
  if (first?.[0] !== last?.[0] || first?.[1] !== last?.[1]) {
    throw new TypeError('Polygon ring must be closed');
  }
  return result;
}

export function parseSupportedGeometry(
  geometry: Readonly<{ type: string; coordinates: JsonValue }>,
  sourceEpsg: 3857 | 4326,
): SupportedGeometry {
  switch (geometry.type) {
    case 'Point':
      return Object.freeze({
        type: 'Point',
        coordinates: coordinate(geometry.coordinates, sourceEpsg),
      });
    case 'LineString':
      return Object.freeze({
        type: 'LineString',
        coordinates: line(geometry.coordinates, sourceEpsg),
      });
    case 'Polygon': {
      if (!Array.isArray(geometry.coordinates)) {
        throw new TypeError('Expected Polygon coordinate array');
      }
      const values: readonly JsonValue[] = geometry.coordinates;
      const coordinates = values.map((value) => ring(value, sourceEpsg));
      if (coordinates.length === 0) {
        throw new TypeError('Polygon requires at least one ring');
      }
      return Object.freeze({ type: 'Polygon', coordinates: Object.freeze(coordinates) });
    }
    case 'MultiPolygon': {
      if (!Array.isArray(geometry.coordinates)) {
        throw new TypeError('Expected MultiPolygon coordinate array');
      }
      const polygons: readonly JsonValue[] = geometry.coordinates;
      const coordinates = polygons.map((polygon) => {
        if (!Array.isArray(polygon)) {
          throw new TypeError('Expected MultiPolygon polygon array');
        }
        const rings: readonly JsonValue[] = polygon;
        return Object.freeze(rings.map((value) => ring(value, sourceEpsg)));
      });
      if (coordinates.length === 0) {
        throw new TypeError('MultiPolygon requires at least one polygon');
      }
      return Object.freeze({ type: 'MultiPolygon', coordinates: Object.freeze(coordinates) });
    }
    default:
      throw new TypeError(`Unsupported geometry type: ${geometry.type}`);
  }
}

function visitCoordinates(
  geometry: SupportedGeometry,
  visit: (point: Wgs84Coordinate) => void,
): void {
  switch (geometry.type) {
    case 'Point':
      visit(geometry.coordinates);
      break;
    case 'LineString':
      geometry.coordinates.forEach(visit);
      break;
    case 'Polygon':
      geometry.coordinates.forEach((currentRing) => currentRing.forEach(visit));
      break;
    case 'MultiPolygon':
      geometry.coordinates.forEach((polygon) =>
        polygon.forEach((currentRing) => currentRing.forEach(visit)),
      );
      break;
  }
}

export function geometryBounds(geometry: SupportedGeometry): Wgs84Bounds {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  visitCoordinates(geometry, ([longitude, latitude]) => {
    west = Math.min(west, longitude);
    south = Math.min(south, latitude);
    east = Math.max(east, longitude);
    north = Math.max(north, latitude);
  });
  const result = [west, south, east, north];
  assertWgs84Bounds(result);
  return Object.freeze(result);
}

export function boundsIntersect(left: Wgs84Bounds, right: Wgs84Bounds): boolean {
  return left[0] <= right[2] && left[2] >= right[0] && left[1] <= right[3] && left[3] >= right[1];
}

export function geometryIntersectsBounds(
  geometry: SupportedGeometry,
  bounds: Wgs84Bounds,
): boolean {
  return boundsIntersect(geometryBounds(geometry), bounds);
}

export function degreesToApproximateMeters(
  longitudeDegrees: number,
  latitudeDegrees: number,
  atLatitudeDegrees: number,
): readonly [number, number] {
  if (![longitudeDegrees, latitudeDegrees, atLatitudeDegrees].every(finite)) {
    throw new TypeError('Resolution inputs must be finite');
  }
  const latitudeRadians = (atLatitudeDegrees * Math.PI) / 180;
  const metersPerLongitudeDegree = 111_320 * Math.cos(latitudeRadians);
  return Object.freeze([
    Math.abs(longitudeDegrees) * metersPerLongitudeDegree,
    Math.abs(latitudeDegrees) * 110_574,
  ]);
}
