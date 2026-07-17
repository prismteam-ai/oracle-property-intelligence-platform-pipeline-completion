import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { OVERTURE_STARBUCKS_FIXTURE_PROVENANCE } from './provenance.js';

describe('official Overture Starbucks excerpt provenance', () => {
  it('pins the exact tiny fixture bytes and original source identity', async () => {
    const bytes = await readFile(
      new URL('./official-overture-2026-06-17-excerpt.geojson', import.meta.url),
    );
    expect(bytes.byteLength).toBe(OVERTURE_STARBUCKS_FIXTURE_PROVENANCE.fixtureBytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      OVERTURE_STARBUCKS_FIXTURE_PROVENANCE.fixtureSha256,
    );
    expect(OVERTURE_STARBUCKS_FIXTURE_PROVENANCE.releaseUri).toContain('/2026-06-17.0/');
    expect(OVERTURE_STARBUCKS_FIXTURE_PROVENANCE.sourceFragmentBytes).toBeGreaterThan(700_000_000);
  });

  it('contains only the three declared GERS records and preserves source licenses', async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL('./official-overture-2026-06-17-excerpt.geojson', import.meta.url),
        'utf8',
      ),
    ) as { features: { id: string; properties: { sources: { license: string }[] } }[] };
    expect(fixture.features.map((feature) => feature.id)).toEqual(
      OVERTURE_STARBUCKS_FIXTURE_PROVENANCE.gersIds,
    );
    expect(
      new Set(
        fixture.features.flatMap((feature) =>
          feature.properties.sources.map((source) => source.license),
        ),
      ),
    ).toEqual(new Set(['Apache-2.0', 'CC0-1.0', 'CDLA-Permissive-2.0']));
  });
});
