import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const FIXTURE_URL = new URL('./duplicate-apn.geojson', import.meta.url);
const PROVENANCE_URL = new URL('./fixture-provenance.json', import.meta.url);

describe('Santa Clara Socrata parcel official fixture', () => {
  it('binds the committed bytes to exact official provenance', async () => {
    const [fixture, provenanceBytes] = await Promise.all([
      readFile(FIXTURE_URL),
      readFile(PROVENANCE_URL),
    ]);
    const provenance = JSON.parse(provenanceBytes.toString('utf8')) as {
      authority: { datasetId: string; provenance: string };
      request: { exactUrl: string; anonymous: boolean };
      originalArtifact: { sha256: string; byteSize: number; mediaType: string };
      committedFixture: { sha256: string; byteSize: number };
      extractionMethod: string;
    };

    expect(provenance.authority).toMatchObject({ datasetId: 'ubcd-cewv', provenance: 'official' });
    expect(provenance.request).toEqual(
      expect.objectContaining({
        anonymous: true,
        exactUrl: expect.stringContaining('apn%3D%2712769001%27'),
      }),
    );
    expect(provenance.originalArtifact).toEqual(
      expect.objectContaining({
        sha256: '83a182ad224c9ac67b034cec242f22aca8d4ff73f9d3d103f34a102c910444b8',
        byteSize: 2536,
        mediaType: 'application/vnd.geo+json; charset=UTF-8',
      }),
    );
    expect(createHash('sha256').update(fixture).digest('hex')).toBe(
      provenance.committedFixture.sha256,
    );
    expect(fixture.byteLength).toBe(provenance.committedFixture.byteSize);
    expect(provenance.extractionMethod).toContain('deterministically pretty-printed');
  });

  it('preserves the real duplicate APN rows and their distinct geometries', async () => {
    const payload = JSON.parse((await readFile(FIXTURE_URL)).toString('utf8')) as {
      features: {
        geometry: { coordinates: unknown };
        properties: { objectid: string; apn: string; jurisdiction: string };
      }[];
      crs: { properties: { name: string } };
    };
    expect(payload.crs.properties.name).toBe('urn:ogc:def:crs:OGC:1.3:CRS84');
    expect(payload.features.map((feature) => feature.properties.objectid)).toEqual([
      '10649',
      '10650',
    ]);
    expect(new Set(payload.features.map((feature) => feature.properties.apn))).toEqual(
      new Set(['12769001']),
    );
    expect(
      payload.features.every((feature) => feature.properties.jurisdiction === 'PALO ALTO'),
    ).toBe(true);
    expect(payload.features[0]?.geometry.coordinates).not.toEqual(
      payload.features[1]?.geometry.coordinates,
    );
  });
});
