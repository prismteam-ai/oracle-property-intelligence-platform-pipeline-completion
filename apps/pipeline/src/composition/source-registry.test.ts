import { resolve } from 'node:path';

import { licenseSnapshotIdSchema, runIdSchema, sourceIdSchema } from '@oracle/contracts/ids';
import { VTA_2026_07_15_SNAPSHOT } from '@oracle/source-adapters/providers/vta-caltrain-511-gtfs/index';
import { describe, expect, it } from 'vitest';

import { readPipelineSourceConfig, sourceConfigFingerprint } from './source-config.js';
import {
  assertBoundedOsmDecoderContract,
  BOUNDED_OSM_DECODER_CONTRACT,
  composeProductionSources,
  resolveWorkspaceModulePath,
  UnsupportedOsmDecoderContractError,
} from './source-registry.js';

async function composition(requestedAt: string) {
  const config = await readPipelineSourceConfig(undefined);
  return composeProductionSources({
    runId: runIdSchema.parse(`sc:run:${'a'.repeat(64)}`),
    requestedAt,
    profile: 'pilot',
    workspaceDirectory: process.cwd(),
    config,
    configFingerprint: sourceConfigFingerprint(config),
  });
}

describe('production source registry', () => {
  it('composes every default usable or explicit blocked capability without inventing 511', async () => {
    const sources = await composition('2026-07-17T00:00:00.000Z');
    const capabilities = sources.map(({ capability }) => capability);

    expect(sources).toHaveLength(14);
    expect(new Set(capabilities).size).toBe(14);
    expect(capabilities).toEqual(
      expect.arrayContaining([
        'santa_clara_parcels',
        'san_jose_permits',
        'palo_alto_year_built',
        'vta_gtfs',
        'caltrain_gtfs',
        'osm_pedestrian_graph',
        'noaa_shoreline',
        'usgs_hydrography',
        'usgs_elevation',
        'overture_starbucks',
        'cslb_contractors',
        'ca_sos_businesses',
        'ownership_transfers',
        'santa_clara_fbn',
      ]),
    );
    expect(capabilities).not.toContain('transit_511_fallback');
    expect(
      sources
        .filter(({ supportState }) => supportState === 'blocked')
        .map(({ capability }) => capability),
    ).toEqual(
      expect.arrayContaining([
        'osm_pedestrian_graph',
        'ca_sos_businesses',
        'ownership_transfers',
        'santa_clara_fbn',
      ]),
    );
  });

  it('bounds every pageable pilot lane before acquisition, including 3DHP', async () => {
    const sources = await composition('2026-07-17T00:00:00.000Z');
    for (const capability of [
      'santa_clara_parcels',
      'san_jose_permits',
      'palo_alto_year_built',
      'noaa_shoreline',
      'usgs_hydrography',
      'usgs_elevation',
    ]) {
      expect(sources.find((source) => source.capability === capability)?.acquisitionItemCap).toBe(
        1,
      );
    }
    expect(
      sources.find(({ capability }) => capability === 'usgs_hydrography')
        ?.discoveryDenominatorStrategy,
    ).toBe('sum_non_null');
    expect(
      sources.find(({ capability }) => capability === 'santa_clara_parcels')
        ?.discoveryDenominatorStrategy,
    ).toBe('first_non_null');
  });

  it('keeps snapshot intent stable when only the explicit request time changes', async () => {
    const first = await composition('2026-07-17T00:00:00.000Z');
    const second = await composition('2026-07-18T00:00:00.000Z');
    expect(second.map(({ snapshotId }) => snapshotId)).toEqual(
      first.map(({ snapshotId }) => snapshotId),
    );
  });

  it('composes a configured frozen 511 fallback as optional county coverage', async () => {
    const base = await readPipelineSourceConfig(undefined);
    const config = Object.freeze({
      ...base,
      fallback511: Object.freeze({
        feeds: Object.freeze({
          vta: Object.freeze({
            ...VTA_2026_07_15_SNAPSHOT,
            role: '511_fallback' as const,
            sourceId: sourceIdSchema.parse('sc:source:511-vta-static-gtfs'),
            sourceName: '511 VTA frozen fallback test contract',
            url: 'https://api.511.org/transit/datafeeds',
            license: Object.freeze({
              ...VTA_2026_07_15_SNAPSHOT.license,
              licenseSnapshotId: licenseSnapshotIdSchema.parse(
                `sc:license:511-vta-static-gtfs:${VTA_2026_07_15_SNAPSHOT.license.termsSha256}`,
              ),
            }),
            requiresInjectedAuthorization: true,
          }),
        }),
        authorization: Object.freeze([]),
      }),
    });
    const sources = await composeProductionSources({
      runId: runIdSchema.parse(`sc:run:${'b'.repeat(64)}`),
      requestedAt: '2026-07-17T00:00:00.000Z',
      profile: 'discovery',
      workspaceDirectory: process.cwd(),
      config,
      configFingerprint: sourceConfigFingerprint(config),
    });
    const fallback = sources.find(({ capability }) => capability === 'transit_511_fallback');
    expect(fallback).toMatchObject({
      requiredForCountyCompletion: false,
      executionMode: 'execute',
      supportState: 'available',
    });
    expect(fallback?.adapter.describe().sourceId).toBe('sc:source:511-vta-static-gtfs');
  });

  it('keeps configured OSM decoder modules inside the workspace', () => {
    const workspace = process.cwd();
    expect(resolveWorkspaceModulePath(workspace, 'tools/osm-decoder.js')).toBe(
      resolve(workspace, 'tools/osm-decoder.js'),
    );
    expect(() => resolveWorkspaceModulePath(workspace, resolve(workspace, 'absolute.js'))).toThrow(
      'workspace-relative',
    );
    expect(() => resolveWorkspaceModulePath(workspace, '../outside.js')).toThrow(
      'stay inside the workspace',
    );
  });

  it('rejects OSM decoder modules without the exact bounded streaming attestation', () => {
    expect(() => assertBoundedOsmDecoderContract(BOUNDED_OSM_DECODER_CONTRACT)).not.toThrow();
    expect(() =>
      assertBoundedOsmDecoderContract({
        ...BOUNDED_OSM_DECODER_CONTRACT,
        noWholeCopy: false,
      }),
    ).toThrow(UnsupportedOsmDecoderContractError);
    expect(() => assertBoundedOsmDecoderContract(undefined)).toThrow(
      UnsupportedOsmDecoderContractError,
    );
  });
});
