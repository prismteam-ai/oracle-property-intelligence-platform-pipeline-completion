import { artifactIdSchema, entityIdSchema } from '@oracle/contracts/ids';
import { describe, expect, it } from 'vitest';

import { reduceCanonicalMutations } from '../entities/reducer.js';
import {
  normalizeElevationRasterRefRecord,
  normalizeHydroFeatureRecord,
  normalizePedestrianGraphRefRecord,
  normalizePlaceRecord,
  normalizeTransitStopRecord,
} from './geospatial.js';
import { testContext } from './test-context.test-support.js';

const artifactId = artifactIdSchema.parse(`sc:artifact:sha256:${'9'.repeat(64)}`);

describe('geospatial canonical normalizers', () => {
  it('normalizes transit stop identity, parent identity, and sorted services', () => {
    const serviceA = entityIdSchema.parse(`sc:entity:transit-service:${'a'.repeat(64)}`);
    const serviceB = entityIdSchema.parse(`sc:entity:transit-service:${'b'.repeat(64)}`);
    const mutations = normalizeTransitStopRecord(
      {
        sourceStopId: 'stop-100',
        agencyId: 'VTA',
        stopCode: '100',
        name: 'Hamilton Station',
        location: { longitude: -121.9, latitude: 37.3 },
        parentSourceStopId: 'station-10',
        boardable: true,
        serviceIds: [serviceB, serviceA],
      },
      testContext(),
    );
    const entity = reduceCanonicalMutations(mutations).entities[0]?.entity;
    expect(entity).toMatchObject({
      entityKind: 'transit-stop',
      agencyId: 'VTA',
      boardable: true,
      serviceIds: [serviceA, serviceB],
    });
    expect(entity).toHaveProperty('parentStopId');
  });

  it('does not convert closed or unvalidated places into verified-open places', () => {
    const aggregate = reduceCanonicalMutations(
      normalizePlaceRecord(
        {
          sourcePlaceId: 'gers-example',
          name: 'Candidate cafe',
          categories: ['coffee_shop', 'coffee_shop'],
          brandIdentifiers: ['Q37158'],
          location: { longitude: -121.91, latitude: 37.31 },
          confidence: 0.72,
          validationState: 'closed',
        },
        testContext(),
      ),
    ).entities[0];
    expect(aggregate?.entity).toMatchObject({
      entityKind: 'place',
      operatingState: 'unknown',
      categories: ['coffee_shop'],
    });
    expect(
      aggregate?.observations.find(({ fieldPath }) => fieldPath === '/sourceOperatingState')?.value,
    ).toBe('closed');
  });

  it('normalizes hydro, pedestrian graph, and elevation references with stable IDs', () => {
    const hydro = normalizeHydroFeatureRecord(
      {
        sourceFeatureId: 'nhd-1',
        name: 'Test Creek',
        featureType: 'stream',
        geometry: {
          type: 'LineString',
          coordinates: [
            [-121.9, 37.3],
            [-121.8, 37.4],
          ],
        },
      },
      testContext(),
    );
    const graph = normalizePedestrianGraphRefRecord(
      {
        artifactId,
        bounds: [-122.3, 36.8, -121.2, 37.6],
        nodeCount: 100,
        edgeCount: 210,
        routingProfileVersion: '1.0.0',
      },
      testContext({ sequenceStart: 100 }),
    );
    const raster = normalizeElevationRasterRefRecord(
      {
        artifactId,
        bounds: [-122.3, 36.8, -121.2, 37.6],
        horizontalResolutionMeters: 10,
        verticalDatum: 'NAVD88',
        sourceAsOf: '2025-01-01T00:00:00.000Z',
      },
      testContext({ sequenceStart: 200 }),
    );
    const reduction = reduceCanonicalMutations([...raster, ...hydro, ...graph]);
    expect(reduction.entities.map(({ entity }) => entity.id)).toEqual(
      [...reduction.entities.map(({ entity }) => entity.id)].sort(),
    );
    expect(reduction.entities.map(({ entity }) => entity.entityKind).sort()).toEqual([
      'elevation-raster-ref',
      'hydro-feature',
      'pedestrian-graph-ref',
    ]);
    const hydroEntity = reduction.entities.find(
      ({ entity }) => entity.entityKind === 'hydro-feature',
    )?.entity;
    expect(hydroEntity).not.toHaveProperty('hasWaterView');
    expect(hydroEntity).not.toHaveProperty('waterView');
    expect(
      normalizeHydroFeatureRecord(
        {
          sourceFeatureId: 'nhd-1',
          name: 'Test Creek',
          featureType: 'stream',
          geometry: {
            type: 'LineString',
            coordinates: [
              [-121.9, 37.3],
              [-121.8, 37.4],
            ],
          },
        },
        testContext(),
      ),
    ).toEqual(hydro);
  });

  it('rejects malformed coordinates, bounds, counts, and dates', () => {
    expect(() =>
      normalizePlaceRecord(
        {
          sourcePlaceId: 'bad',
          name: 'Bad point',
          categories: ['cafe'],
          location: { longitude: -221, latitude: 37 },
          confidence: 1,
        },
        testContext(),
      ),
    ).toThrow();
    expect(() =>
      normalizePedestrianGraphRefRecord(
        {
          artifactId,
          bounds: [-121, 37, -122, 36],
          nodeCount: 1,
          edgeCount: 1,
          routingProfileVersion: '1.0.0',
        },
        testContext(),
      ),
    ).toThrow();
    expect(() =>
      normalizePedestrianGraphRefRecord(
        {
          artifactId,
          bounds: [-122, 36, -121, 37],
          nodeCount: -1,
          edgeCount: 1,
          routingProfileVersion: '1.0.0',
        },
        testContext(),
      ),
    ).toThrow();
    expect(() =>
      normalizeElevationRasterRefRecord(
        {
          artifactId,
          bounds: [-122, 36, -121, 37],
          horizontalResolutionMeters: 10,
          verticalDatum: 'NAVD88',
          sourceAsOf: '2025-01-01',
        },
        testContext(),
      ),
    ).toThrow(/ISO-8601/u);
  });
});
