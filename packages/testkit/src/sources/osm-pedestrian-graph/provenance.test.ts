import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { OSM_PEDESTRIAN_FIXTURE_PROVENANCE } from './provenance.js';

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
    .join(',')}}`;
}

describe('OSM pedestrian fixture provenance', () => {
  it('matches the frozen canonical excerpt and ODbL notice', async () => {
    const url = new URL('./official-osm-api-excerpt.json', import.meta.url);
    const parsed = JSON.parse(await readFile(url, 'utf8')) as Readonly<Record<string, unknown>>;
    const canonical = new TextEncoder().encode(canonicalize(parsed));

    expect(canonical.byteLength).toBe(OSM_PEDESTRIAN_FIXTURE_PROVENANCE.canonicalExcerptBytes);
    expect(createHash('sha256').update(canonical).digest('hex')).toBe(
      OSM_PEDESTRIAN_FIXTURE_PROVENANCE.canonicalExcerptSha256,
    );
    expect(parsed.attribution).toContain('openstreetmap.org/copyright');
    expect(parsed.license).toContain('odbl/1-0');
    expect(JSON.stringify(parsed)).not.toMatch(/"user"|"uid"|"changeset"/u);
    expect(OSM_PEDESTRIAN_FIXTURE_PROVENANCE.shareAlikeRequiredForDerivativeDatabases).toBe(true);
  });
});
