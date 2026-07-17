import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SANTA_CLARA_FBN_LIMITATION_PROVENANCE } from './provenance.js';

describe('Santa Clara FBN limitation provenance', () => {
  it('binds a non-PII official limitation excerpt', async () => {
    const path = fileURLToPath(
      new URL('./official-access-limitation-excerpt.json', import.meta.url),
    );
    const bytes = await readFile(path);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      SANTA_CLARA_FBN_LIMITATION_PROVENANCE.fixtureSha256,
    );
    expect(bytes.toString('utf8')).not.toMatch(/registrant|agent|street address/iu);
    expect(SANTA_CLARA_FBN_LIMITATION_PROVENANCE.decision).toContain('Blocked');
  });
});
