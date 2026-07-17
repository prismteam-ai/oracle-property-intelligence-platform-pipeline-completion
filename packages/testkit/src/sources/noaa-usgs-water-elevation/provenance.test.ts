import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  NOAA_CUSP_FIXTURE_PROVENANCE,
  USGS_3DEP_FIXTURE_PROVENANCE,
  USGS_3DHP_FIXTURE_PROVENANCE,
} from './provenance.js';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('water/elevation official fixture provenance', () => {
  it('pins tiny NOAA and USGS vector excerpts', async () => {
    const noaa = await readFile(new URL('./noaa-cusp-west-record-8.geojson', import.meta.url));
    const hydro = await readFile(new URL('./usgs-3dhp-flowline-11jsf.geojson', import.meta.url));

    expect(noaa.byteLength).toBeLessThan(4_096);
    expect(hydro.byteLength).toBe(USGS_3DHP_FIXTURE_PROVENANCE.excerptBytes);
    expect(sha256(noaa)).toBe(NOAA_CUSP_FIXTURE_PROVENANCE.excerptSha256);
    expect(sha256(hydro)).toBe(USGS_3DHP_FIXTURE_PROVENANCE.excerptSha256);
    expect(JSON.parse(noaa.toString('utf8'))).toHaveProperty(
      'features.0.properties.DAT_SET_CR',
      'NOAA',
    );
    expect(JSON.parse(hydro.toString('utf8'))).toHaveProperty(
      'features.0.properties.id3dhp',
      '11JSF',
    );
  });

  it('pins a tiny decoded official 3DEP GeoTIFF excerpt without committing a TIFF binary', async () => {
    const encoded = (
      await readFile(new URL('./usgs-3dep-alviso-8x8.tiff.base64.txt', import.meta.url), 'utf8')
    ).trim();
    const decoded = Buffer.from(encoded, 'base64');

    expect(decoded.byteLength).toBe(USGS_3DEP_FIXTURE_PROVENANCE.decodedBytes);
    expect(sha256(decoded)).toBe(USGS_3DEP_FIXTURE_PROVENANCE.decodedSha256);
    expect(decoded.subarray(0, 4).toString('hex')).toBe('49492a00');
  });
});
