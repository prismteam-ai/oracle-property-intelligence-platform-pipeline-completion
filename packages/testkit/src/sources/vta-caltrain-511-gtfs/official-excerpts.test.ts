import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

interface FixtureFile {
  readonly capturedAt: string;
  readonly extraction: string;
  readonly vta: Readonly<{
    originalBytes: number;
    originalSha256: string;
    excerptSha256: string;
    members: Readonly<Record<string, string>>;
  }>;
  readonly caltrain: Readonly<{
    originalBytes: number;
    originalSha256: string;
    excerptSha256: string;
    members: Readonly<Record<string, string>>;
  }>;
}

const OFFICIAL_GTFS_EXCERPTS: FixtureFile = JSON.parse(
  readFileSync(new URL('./official-excerpts.json', import.meta.url), 'utf8'),
);

function excerptHash(members: Readonly<Record<string, string>>): string {
  const hash = createHash('sha256');
  for (const [name, content] of Object.entries(members).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    hash.update(name).update('\0').update(content).update('\0');
  }
  return hash.digest('hex');
}

describe('official VTA and Caltrain GTFS excerpts', () => {
  it.each(['vta', 'caltrain'] as const)(
    'pins %s provenance and exact excerpt bytes',
    (operator) => {
      const fixture = OFFICIAL_GTFS_EXCERPTS[operator];
      expect(fixture.originalBytes).toBeGreaterThan(100_000);
      expect(fixture.originalSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(excerptHash(fixture.members)).toBe(fixture.excerptSha256);
      expect(Object.keys(fixture.members)).toEqual(
        expect.arrayContaining([
          'agency.txt',
          'calendar.txt',
          'calendar_dates.txt',
          'routes.txt',
          'stop_times.txt',
          'stops.txt',
          'trips.txt',
        ]),
      );
    },
  );

  it('contains no fabricated 511 source snapshot', () => {
    expect(Object.keys(OFFICIAL_GTFS_EXCERPTS)).not.toContain('511');
  });
});
