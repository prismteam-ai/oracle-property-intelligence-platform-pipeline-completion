import type { EntityId } from '@oracle/contracts/ids';

import {
  buildInquiryResult,
  parseInstant,
  stableJson,
  type InquiryCoverage,
  type InquiryResult,
  type SourceObservation,
} from './common.js';

export const WATER_VIEW_ALGORITHM = Object.freeze({
  name: 'oracle-mapped-water-terrain-candidate',
  version: '1.0.0',
});

export type CoordinateReferenceSystem = 'EPSG:4326' | 'EPSG:3857';
export type Coordinate = readonly [number, number];

export type WaterGeometry =
  | Readonly<{ type: 'Point'; coordinates: Coordinate }>
  | Readonly<{ type: 'LineString'; coordinates: readonly Coordinate[] }>
  | Readonly<{ type: 'Polygon'; coordinates: readonly (readonly Coordinate[])[] }>;

export interface LocatedPoint {
  readonly coordinates: Coordinate;
  readonly crs: CoordinateReferenceSystem;
}

export interface HydroObservation extends SourceObservation {
  readonly hydroFeatureId: EntityId;
  readonly name: string | null;
  readonly featureType:
    'shoreline' | 'river' | 'stream' | 'lake' | 'reservoir' | 'wetland' | 'other';
  readonly geometry: WaterGeometry;
  readonly crs: CoordinateReferenceSystem;
}

export interface TerrainSample {
  readonly distanceMeters: number;
  readonly elevationMeters: number;
}

export interface TerrainObservation extends SourceObservation {
  readonly hydroFeatureId: EntityId;
  readonly horizontalResolutionMeters: number;
  readonly verticalDatum: string;
  readonly propertyElevationMeters: number;
  readonly waterElevationMeters: number;
  readonly samples: readonly TerrainSample[];
}

export interface WaterViewInput {
  readonly propertyId: EntityId;
  readonly asOf: string;
  readonly propertyLocation: LocatedPoint | null;
  readonly hydroFeatures: readonly HydroObservation[];
  readonly terrainProfiles: readonly TerrainObservation[];
  readonly coverage: InquiryCoverage;
  readonly maximumDistanceMeters?: number;
  readonly observerHeightMeters?: number;
  readonly terrainClearanceMeters?: number;
}

export interface WaterViewValue {
  readonly mode: 'terrain_and_proximity' | 'proximity_only_proxy';
  readonly isWaterViewCandidate: boolean;
  readonly actualViewProven: false;
  readonly selectedHydroFeatureId: EntityId;
  readonly selectedHydroFeatureType: HydroObservation['featureType'];
  readonly distanceMeters: number;
  readonly maximumDistanceMeters: number;
  readonly terrainState: 'clear' | 'blocked' | 'unavailable';
  readonly minimumTerrainClearanceMeters: number | null;
  readonly horizontalResolutionMeters: number | null;
  readonly verticalDatum: string | null;
  readonly distanceMethod: 'local_projection_nearest_geometry_v1';
}

export type WaterViewResult = InquiryResult<WaterViewValue>;

const EARTH_RADIUS_METERS = 6_371_008.8;
const WEB_MERCATOR_LIMIT = 20_037_508.342789244;

function finiteCoordinate(coordinate: readonly number[]): asserts coordinate is Coordinate {
  if (coordinate.length !== 2 || !coordinate.every(Number.isFinite)) {
    throw new TypeError('Coordinates must contain two finite numbers');
  }
}

export function coordinateToWgs84(coordinate: readonly number[], crs: string): Coordinate {
  finiteCoordinate(coordinate);
  const [x, y] = coordinate;
  if (crs === 'EPSG:4326') {
    if (x < -180 || x > 180 || y < -90 || y > 90) {
      throw new RangeError('Coordinate is outside EPSG:4326 bounds');
    }
    return Object.freeze([x, y]);
  }
  if (crs !== 'EPSG:3857') {
    throw new TypeError(`Unsupported coordinate reference system: ${crs}`);
  }
  if (Math.abs(x) > WEB_MERCATOR_LIMIT || Math.abs(y) > WEB_MERCATOR_LIMIT) {
    throw new RangeError('Coordinate is outside EPSG:3857 bounds');
  }
  const longitude = (x / WEB_MERCATOR_LIMIT) * 180;
  const latitudeRadians = 2 * Math.atan(Math.exp((y / WEB_MERCATOR_LIMIT) * Math.PI)) - Math.PI / 2;
  return Object.freeze([longitude, (latitudeRadians * 180) / Math.PI]);
}

function projectMeters(point: Coordinate, origin: Coordinate): Coordinate {
  const longitudeRadians = ((point[0] - origin[0]) * Math.PI) / 180;
  const latitudeRadians = ((point[1] - origin[1]) * Math.PI) / 180;
  const originLatitude = (origin[1] * Math.PI) / 180;
  return Object.freeze([
    EARTH_RADIUS_METERS * longitudeRadians * Math.cos(originLatitude),
    EARTH_RADIUS_METERS * latitudeRadians,
  ]);
}

function segmentDistance(point: Coordinate, start: Coordinate, end: Coordinate): number {
  const deltaX = end[0] - start[0];
  const deltaY = end[1] - start[1];
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared === 0) {
    return Math.hypot(point[0] - start[0], point[1] - start[1]);
  }
  const projection = Math.max(
    0,
    Math.min(1, ((point[0] - start[0]) * deltaX + (point[1] - start[1]) * deltaY) / lengthSquared),
  );
  return Math.hypot(
    point[0] - (start[0] + projection * deltaX),
    point[1] - (start[1] + projection * deltaY),
  );
}

function pointInsideRing(point: Coordinate, ring: readonly Coordinate[]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index) {
    const currentPoint = ring[index];
    const previousPoint = ring[previous];
    if (currentPoint === undefined || previousPoint === undefined) {
      continue;
    }
    const intersects =
      currentPoint[1] > point[1] !== previousPoint[1] > point[1] &&
      point[0] <
        ((previousPoint[0] - currentPoint[0]) * (point[1] - currentPoint[1])) /
          (previousPoint[1] - currentPoint[1]) +
          currentPoint[0];
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function lineDistance(point: Coordinate, coordinates: readonly Coordinate[]): number {
  if (coordinates.length === 0) {
    throw new TypeError('Water geometry must contain coordinates');
  }
  if (coordinates.length === 1) {
    const only = coordinates[0];
    return only === undefined
      ? Number.POSITIVE_INFINITY
      : Math.hypot(point[0] - only[0], point[1] - only[1]);
  }
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < coordinates.length; index += 1) {
    const start = coordinates[index - 1];
    const end = coordinates[index];
    if (start !== undefined && end !== undefined) {
      minimum = Math.min(minimum, segmentDistance(point, start, end));
    }
  }
  return minimum;
}

function geometryDistanceMeters(
  property: Coordinate,
  geometry: WaterGeometry,
  crs: CoordinateReferenceSystem,
): number {
  const project = (coordinate: Coordinate): Coordinate =>
    projectMeters(coordinateToWgs84(coordinate, crs), property);
  const origin: Coordinate = Object.freeze([0, 0]);
  switch (geometry.type) {
    case 'Point':
      return Math.hypot(...project(geometry.coordinates));
    case 'LineString':
      return lineDistance(origin, geometry.coordinates.map(project));
    case 'Polygon': {
      const rings = geometry.coordinates.map((ring) => ring.map(project));
      const outer = rings[0];
      if (outer === undefined || outer.length < 4) {
        throw new TypeError('Water polygon requires a closed outer ring');
      }
      const insideOuter = pointInsideRing(origin, outer);
      const insideHole = rings.slice(1).some((ring) => pointInsideRing(origin, ring));
      if (insideOuter && !insideHole) {
        return 0;
      }
      return Math.min(...rings.map((ring) => lineDistance(origin, ring)));
    }
  }
}

function analyzeTerrain(
  profile: TerrainObservation,
  routeDistanceMeters: number,
  observerHeightMeters: number,
  requiredClearanceMeters: number,
): Readonly<{ state: 'clear' | 'blocked' | 'invalid'; minimumClearanceMeters: number | null }> {
  if (
    !Number.isFinite(profile.horizontalResolutionMeters) ||
    profile.horizontalResolutionMeters <= 0 ||
    !Number.isFinite(profile.propertyElevationMeters) ||
    !Number.isFinite(profile.waterElevationMeters) ||
    profile.samples.length < 3 ||
    routeDistanceMeters <= 0
  ) {
    return Object.freeze({ state: 'invalid', minimumClearanceMeters: null });
  }
  const samples = [...profile.samples].sort(
    (left, right) => left.distanceMeters - right.distanceMeters,
  );
  const endpointToleranceMeters = Math.max(
    profile.horizontalResolutionMeters * 1.5,
    routeDistanceMeters * 0.002,
  );
  const maximumSampleGapMeters = profile.horizontalResolutionMeters * 2;
  if (
    samples.some(
      (sample, index) =>
        !Number.isFinite(sample.distanceMeters) ||
        !Number.isFinite(sample.elevationMeters) ||
        sample.distanceMeters < 0 ||
        sample.distanceMeters > routeDistanceMeters + endpointToleranceMeters ||
        (index > 0 &&
          (sample.distanceMeters <= (samples[index - 1]?.distanceMeters ?? -1) ||
            sample.distanceMeters - (samples[index - 1]?.distanceMeters ?? 0) >
              maximumSampleGapMeters)),
    ) ||
    (samples[0]?.distanceMeters ?? Number.POSITIVE_INFINITY) > endpointToleranceMeters ||
    Math.abs((samples.at(-1)?.distanceMeters ?? Number.NEGATIVE_INFINITY) - routeDistanceMeters) >
      endpointToleranceMeters
  ) {
    return Object.freeze({ state: 'invalid', minimumClearanceMeters: null });
  }
  let minimumClearance = Number.POSITIVE_INFINITY;
  for (const sample of samples.slice(1, -1)) {
    const fraction = Math.min(1, sample.distanceMeters / routeDistanceMeters);
    const sightElevation =
      profile.propertyElevationMeters +
      observerHeightMeters +
      fraction *
        (profile.waterElevationMeters - (profile.propertyElevationMeters + observerHeightMeters));
    minimumClearance = Math.min(minimumClearance, sightElevation - sample.elevationMeters);
  }
  if (minimumClearance === Number.POSITIVE_INFINITY) {
    minimumClearance = 0;
  }
  return Object.freeze({
    state: minimumClearance >= requiredClearanceMeters ? 'clear' : 'blocked',
    minimumClearanceMeters: Math.round(minimumClearance * 100) / 100,
  });
}

export function deriveWaterViewCandidate(input: WaterViewInput): WaterViewResult {
  const maximumDistanceMeters = input.maximumDistanceMeters ?? 3_000;
  const observerHeightMeters = input.observerHeightMeters ?? 1.7;
  const terrainClearanceMeters = input.terrainClearanceMeters ?? 0;
  if (!Number.isFinite(maximumDistanceMeters) || maximumDistanceMeters <= 0) {
    throw new RangeError('maximumDistanceMeters must be positive');
  }
  if (!Number.isFinite(observerHeightMeters) || observerHeightMeters < 0) {
    throw new RangeError('observerHeightMeters must be non-negative');
  }
  parseInstant(input.asOf, 'asOf');
  const observations = [...input.hydroFeatures, ...input.terrainProfiles];
  const calculation = Object.freeze({
    ...WATER_VIEW_ALGORITHM,
    parameters: Object.freeze({
      maximumDistanceMeters,
      observerHeightMeters,
      terrainClearanceMeters,
      actualViewClaimAllowed: false,
    }),
  });

  if (input.propertyLocation === null || input.hydroFeatures.length === 0) {
    return buildInquiryResult({
      propertyId: input.propertyId,
      feature: 'water_view_candidate',
      value: null,
      supportClass: 'unknown',
      confidence: 0,
      observations,
      calculation,
      asOf: input.asOf,
      coverage: input.coverage,
      limitations: [
        'A property coordinate and mapped water observation are both required for a candidate signal.',
        'Missing mapped features must not be interpreted as proof of no water view.',
      ],
    });
  }

  const hydroSignatures = new Map<EntityId, Set<string>>();
  for (const feature of input.hydroFeatures) {
    const signatures = hydroSignatures.get(feature.hydroFeatureId) ?? new Set<string>();
    signatures.add(
      stableJson({
        name: feature.name,
        featureType: feature.featureType,
        geometry: feature.geometry,
        crs: feature.crs,
      }),
    );
    hydroSignatures.set(feature.hydroFeatureId, signatures);
  }
  if ([...hydroSignatures.values()].some((signatures) => signatures.size > 1)) {
    return buildInquiryResult({
      propertyId: input.propertyId,
      feature: 'water_view_candidate',
      value: null,
      supportClass: 'unknown',
      confidence: 0,
      observations,
      calculation,
      asOf: input.asOf,
      coverage: input.coverage,
      limitations: [
        'Contradictory hydrography observations share a feature identifier; row order is not used to select geometry.',
        'No water-view candidate is produced until the source conflict is resolved.',
      ],
    });
  }

  let propertyLocation: Coordinate;
  let distances: readonly Readonly<{ feature: HydroObservation; distanceMeters: number }>[];
  try {
    propertyLocation = coordinateToWgs84(
      input.propertyLocation.coordinates,
      input.propertyLocation.crs,
    );
    distances = input.hydroFeatures
      .map((feature) => ({
        feature,
        distanceMeters: geometryDistanceMeters(propertyLocation, feature.geometry, feature.crs),
      }))
      .sort(
        (left, right) =>
          left.distanceMeters - right.distanceMeters ||
          left.feature.hydroFeatureId.localeCompare(right.feature.hydroFeatureId),
      );
  } catch {
    return buildInquiryResult({
      propertyId: input.propertyId,
      feature: 'water_view_candidate',
      value: null,
      supportClass: 'unknown',
      confidence: 0,
      observations,
      calculation,
      asOf: input.asOf,
      coverage: input.coverage,
      limitations: [
        'Property or hydrography coordinates are invalid or use an unsupported CRS.',
        'No proximity or visibility claim is produced from invalid geometry.',
      ],
    });
  }

  const nearest = distances[0];
  if (nearest === undefined || !Number.isFinite(nearest.distanceMeters)) {
    return buildInquiryResult({
      propertyId: input.propertyId,
      feature: 'water_view_candidate',
      value: null,
      supportClass: 'unknown',
      confidence: 0,
      observations,
      calculation,
      asOf: input.asOf,
      coverage: input.coverage,
      limitations: ['No valid distance could be calculated from the mapped water observations.'],
    });
  }
  const roundedDistance = Math.round(nearest.distanceMeters * 100) / 100;
  const matchingProfiles = input.terrainProfiles
    .filter(({ hydroFeatureId }) => hydroFeatureId === nearest.feature.hydroFeatureId)
    .sort((left, right) => left.observationId.localeCompare(right.observationId));
  const terrainSignatures = new Set(
    matchingProfiles.map((candidate) =>
      stableJson({
        horizontalResolutionMeters: candidate.horizontalResolutionMeters,
        verticalDatum: candidate.verticalDatum,
        propertyElevationMeters: candidate.propertyElevationMeters,
        waterElevationMeters: candidate.waterElevationMeters,
        samples: candidate.samples,
      }),
    ),
  );
  if (terrainSignatures.size > 1) {
    return buildInquiryResult({
      propertyId: input.propertyId,
      feature: 'water_view_candidate',
      value: null,
      supportClass: 'unknown',
      confidence: 0,
      observations,
      calculation,
      asOf: input.asOf,
      coverage: input.coverage,
      limitations: [
        'Contradictory terrain profiles apply to the selected mapped-water feature; row order is not used to select a profile.',
        'No water-view candidate is produced until the source conflict is resolved.',
      ],
    });
  }
  const profile = matchingProfiles[0] ?? null;
  const terrain =
    profile === null
      ? Object.freeze({ state: 'invalid' as const, minimumClearanceMeters: null })
      : analyzeTerrain(
          profile,
          nearest.distanceMeters,
          observerHeightMeters,
          terrainClearanceMeters,
        );
  const withinDistance = nearest.distanceMeters <= maximumDistanceMeters;

  if (profile !== null && terrain.state !== 'invalid') {
    const isCandidate = withinDistance && terrain.state === 'clear';
    const complete = input.coverage.state === 'complete';
    return buildInquiryResult({
      propertyId: input.propertyId,
      feature: 'water_view_candidate',
      value: {
        mode: 'terrain_and_proximity',
        isWaterViewCandidate: isCandidate,
        actualViewProven: false,
        selectedHydroFeatureId: nearest.feature.hydroFeatureId,
        selectedHydroFeatureType: nearest.feature.featureType,
        distanceMeters: roundedDistance,
        maximumDistanceMeters,
        terrainState: terrain.state,
        minimumTerrainClearanceMeters: terrain.minimumClearanceMeters,
        horizontalResolutionMeters: profile.horizontalResolutionMeters,
        verticalDatum: profile.verticalDatum,
        distanceMethod: 'local_projection_nearest_geometry_v1',
      },
      supportClass: complete ? 'supported' : 'proxy',
      confidence: complete ? 0.85 : 0.6,
      observations,
      calculation,
      asOf: input.asOf,
      coverage: input.coverage,
      limitations: [
        'This is a potential water-view candidate based only on mapped water proximity and bare-earth terrain.',
        'Buildings, trees, window placement, observer floor, and orientation are not modeled.',
        'An actual view requires site or imagery observation and is never proven by this feature.',
        ...(complete
          ? []
          : ['Partial hydrography or terrain coverage makes this a review-required proxy.']),
      ],
    });
  }

  return buildInquiryResult({
    propertyId: input.propertyId,
    feature: 'water_view_candidate',
    value: {
      mode: 'proximity_only_proxy',
      isWaterViewCandidate: false,
      actualViewProven: false,
      selectedHydroFeatureId: nearest.feature.hydroFeatureId,
      selectedHydroFeatureType: nearest.feature.featureType,
      distanceMeters: roundedDistance,
      maximumDistanceMeters,
      terrainState: 'unavailable',
      minimumTerrainClearanceMeters: null,
      horizontalResolutionMeters: profile?.horizontalResolutionMeters ?? null,
      verticalDatum: profile?.verticalDatum ?? null,
      distanceMethod: 'local_projection_nearest_geometry_v1',
    },
    supportClass: 'proxy',
    confidence: withinDistance ? 0.35 : 0.2,
    observations,
    calculation,
    asOf: input.asOf,
    coverage: input.coverage,
    limitations: [
      'Mapped-water proximity alone is not a positive water-view candidate; terrain evidence is unavailable or invalid.',
      'Buildings, trees, window placement, observer floor, and orientation are not modeled.',
      'An actual view requires site or imagery observation and is never proven by this feature.',
    ],
  });
}
