import { entityIdSchema } from '@oracle/contracts/ids';
import { describe, expect, it } from 'vitest';

import type { HydroObservation, TerrainObservation, WaterViewInput } from './water-view.js';
import { coordinateToWgs84, deriveWaterViewCandidate } from './water-view.js';
import {
  HYDRO_ID,
  PROPERTY_ID,
  completeCoverage,
  sourceObservation,
} from './test-helpers.test-support.js';

const SECOND_HYDRO_ID = entityIdSchema.parse('sc:entity:hydro-feature:second-water');

function hydro(overrides: Partial<HydroObservation> = {}): HydroObservation {
  return Object.freeze({
    ...sourceObservation('hydro-feature', 'hydro-1', { featureType: 'shoreline' }),
    hydroFeatureId: HYDRO_ID,
    name: 'San Francisco Bay',
    featureType: 'shoreline',
    geometry: Object.freeze({
      type: 'Point',
      coordinates: Object.freeze([-121.99, 37] as const),
    }),
    crs: 'EPSG:4326',
    ...overrides,
  });
}

function terrain(overrides: Partial<TerrainObservation> = {}): TerrainObservation {
  const samples = Object.freeze(
    Array.from({ length: 90 }, (_, index) => {
      const distanceMeters = index * 10;
      const sightElevation = 101.7 - (distanceMeters / 890) * 101.7;
      return Object.freeze({
        distanceMeters,
        elevationMeters: index === 0 ? 100 : Math.max(0, sightElevation - 5),
      });
    }),
  );
  return Object.freeze({
    ...sourceObservation('terrain-profile', 'terrain-1', {
      resolutionMeters: 1,
      verticalDatum: 'NAVD88',
    }),
    hydroFeatureId: HYDRO_ID,
    horizontalResolutionMeters: 10,
    verticalDatum: 'NAVD88',
    propertyElevationMeters: 100,
    waterElevationMeters: 0,
    samples,
    ...overrides,
  });
}

function input(overrides: Partial<WaterViewInput> = {}): WaterViewInput {
  return Object.freeze({
    propertyId: PROPERTY_ID,
    asOf: '2026-07-17T00:00:00.000Z',
    propertyLocation: Object.freeze({
      coordinates: Object.freeze([-122, 37] as const),
      crs: 'EPSG:4326',
    }),
    hydroFeatures: Object.freeze([hydro()]),
    terrainProfiles: Object.freeze([terrain()]),
    coverage: completeCoverage(),
    maximumDistanceMeters: 2_000,
    ...overrides,
  });
}

describe('water-view candidate evidence', () => {
  it('emits a supported candidate only for mapped proximity plus clear bare-earth terrain', () => {
    const result = deriveWaterViewCandidate(input());

    expect(result.supportClass).toBe('supported');
    expect(result.value).toMatchObject({
      mode: 'terrain_and_proximity',
      isWaterViewCandidate: true,
      actualViewProven: false,
      terrainState: 'clear',
      selectedHydroFeatureId: HYDRO_ID,
    });
    expect(result.limitations.join(' ')).toMatch(/Buildings, trees, window placement/u);
  });

  it('reports terrain obstruction as a supported negative candidate result', () => {
    const blockedSamples = terrain().samples.map((sample, index) =>
      index === 45 ? Object.freeze({ ...sample, elevationMeters: 90 }) : sample,
    );
    const blockedTerrain = terrain({
      samples: Object.freeze(blockedSamples),
    });
    const result = deriveWaterViewCandidate(input({ terrainProfiles: [blockedTerrain] }));

    expect(result.supportClass).toBe('supported');
    expect(result.value).toMatchObject({
      isWaterViewCandidate: false,
      actualViewProven: false,
      terrainState: 'blocked',
    });
  });

  it('does not promote proximity without valid terrain into a positive candidate', () => {
    const result = deriveWaterViewCandidate(input({ terrainProfiles: [] }));

    expect(result.supportClass).toBe('proxy');
    expect(result.value).toMatchObject({
      mode: 'proximity_only_proxy',
      isWaterViewCandidate: false,
      terrainState: 'unavailable',
    });
    expect(result.limitations.join(' ')).toMatch(/proximity alone is not a positive/u);
  });

  it.each([
    {
      label: 'truncated profile',
      samples: [
        { distanceMeters: 0, elevationMeters: 100 },
        { distanceMeters: 100, elevationMeters: 80 },
        { distanceMeters: 200, elevationMeters: 60 },
      ],
    },
    {
      label: 'two-point bad-span profile',
      samples: [
        { distanceMeters: 100, elevationMeters: 80 },
        { distanceMeters: 200, elevationMeters: 60 },
      ],
    },
  ])('keeps a $label as a non-positive proximity-only proxy', ({ samples }) => {
    const result = deriveWaterViewCandidate(
      input({ terrainProfiles: [terrain({ samples: Object.freeze(samples) })] }),
    );

    expect(result.supportClass).toBe('proxy');
    expect(result.value).toMatchObject({
      mode: 'proximity_only_proxy',
      isWaterViewCandidate: false,
      terrainState: 'unavailable',
    });
  });

  it('returns unknown instead of a no-view claim when mapped water is absent', () => {
    const result = deriveWaterViewCandidate(input({ hydroFeatures: [], terrainProfiles: [] }));

    expect(result.supportClass).toBe('unknown');
    expect(result.value).toBeNull();
    expect(result.limitations.join(' ')).toMatch(/must not be interpreted/u);
  });

  it('keeps a clear signal proxy-labeled when source coverage is partial', () => {
    const result = deriveWaterViewCandidate(
      input({ coverage: completeCoverage({ state: 'partial', limitations: ['DEM gap.'] }) }),
    );

    expect(result.supportClass).toBe('proxy');
    expect(result.value?.isWaterViewCandidate).toBe(true);
    expect(result.limitations.join(' ')).toMatch(/review-required proxy/u);
  });

  it('supports the frozen WGS84 and Web Mercator CRS conversions', () => {
    const webMercator = Object.freeze([-13_580_977.88, 4_439_106.79] as const);
    const converted = coordinateToWgs84(webMercator, 'EPSG:3857');

    expect(converted[0]).toBeCloseTo(-122, 3);
    expect(converted[1]).toBeCloseTo(37, 3);
    const result = deriveWaterViewCandidate(
      input({ propertyLocation: { coordinates: webMercator, crs: 'EPSG:3857' } }),
    );
    expect(result.value?.distanceMeters).toBeGreaterThan(0);
  });

  it('fails closed for invalid coordinates or an unsupported CRS', () => {
    const invalid = {
      coordinates: Object.freeze([Number.NaN, 37] as const),
      crs: 'EPSG:9999',
    } as unknown as WaterViewInput['propertyLocation'];
    const result = deriveWaterViewCandidate(input({ propertyLocation: invalid }));

    expect(result.supportClass).toBe('unknown');
    expect(result.value).toBeNull();
    expect(result.limitations.join(' ')).toMatch(/invalid or use an unsupported CRS/u);
  });

  it('selects equidistant hydro evidence deterministically and is order independent', () => {
    const second = hydro({
      ...sourceObservation('hydro-feature', 'hydro-2', { featureType: 'lake' }),
      hydroFeatureId: SECOND_HYDRO_ID,
      name: 'Second feature',
      featureType: 'lake',
    });
    const secondTerrain = terrain({
      ...sourceObservation('terrain-profile', 'terrain-2', { resolutionMeters: 1 }),
      hydroFeatureId: SECOND_HYDRO_ID,
    });
    const forward = deriveWaterViewCandidate(
      input({ hydroFeatures: [hydro(), second], terrainProfiles: [terrain(), secondTerrain] }),
    );
    const reverse = deriveWaterViewCandidate(
      input({ hydroFeatures: [second, hydro()], terrainProfiles: [secondTerrain, terrain()] }),
    );

    expect(reverse.value?.selectedHydroFeatureId).toBe(forward.value?.selectedHydroFeatureId);
    expect(reverse.evidence.evidenceId).toBe(forward.evidence.evidenceId);
  });

  it('does not choose the first contradictory hydro or terrain row', () => {
    const conflictingHydro = hydro({
      ...sourceObservation('hydro-feature', 'hydro-conflict', { featureType: 'stream' }),
      featureType: 'stream',
    });
    const hydroConflict = deriveWaterViewCandidate(
      input({ hydroFeatures: [hydro(), conflictingHydro] }),
    );
    const conflictingTerrain = terrain({
      ...sourceObservation('terrain-profile', 'terrain-conflict', { resolutionMeters: 30 }),
      horizontalResolutionMeters: 30,
    });
    const terrainConflict = deriveWaterViewCandidate(
      input({ terrainProfiles: [terrain(), conflictingTerrain] }),
    );

    expect(hydroConflict.supportClass).toBe('unknown');
    expect(terrainConflict.supportClass).toBe('unknown');
    expect(hydroConflict.limitations.join(' ')).toMatch(/row order/u);
    expect(terrainConflict.limitations.join(' ')).toMatch(/row order/u);
  });

  it('propagates the strictest source visibility and never asserts an actual view', () => {
    const restrictedHydro = hydro({ visibility: 'restricted' });
    const result = deriveWaterViewCandidate(input({ hydroFeatures: [restrictedHydro] }));

    expect(result.visibility).toBe('restricted');
    expect(result.value?.actualViewProven).toBe(false);
    expect(result.evidence.value).not.toHaveProperty('hasWaterView');
  });
});
