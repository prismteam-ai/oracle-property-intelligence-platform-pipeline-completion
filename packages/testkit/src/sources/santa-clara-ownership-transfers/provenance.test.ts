import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { SANTA_CLARA_OWNERSHIP_FIXTURE_PROVENANCE } from './provenance.js';

describe('Santa Clara ownership capability fixture provenance', () => {
  it('pins every minimal official excerpt by exact SHA-256 and excludes owner-bearing rows', async () => {
    expect(SANTA_CLARA_OWNERSHIP_FIXTURE_PROVENANCE).toMatchObject({
      authority: 'County of Santa Clara Office of the Clerk-Recorder',
      containsOwnerBearingRows: false,
      containsPersonalData: false,
    });

    for (const fixture of SANTA_CLARA_OWNERSHIP_FIXTURE_PROVENANCE.fixtures) {
      const bytes = await readFile(new URL(fixture.file, import.meta.url));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(fixture.sha256);
      const text = bytes.toString('utf8').toLowerCase();
      expect(text).not.toContain('social security');
      expect(text).not.toContain('tax id');
    }
  });
});
