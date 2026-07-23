import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CA_SOS_BUSINESS_FIXTURE_PROVENANCE } from './provenance.js';

describe('CA SOS safe fixture provenance', () => {
  it('binds the exact minimized official excerpt and preserves its restrictions', async () => {
    const path = fileURLToPath(new URL('./official-bizfile-safe-excerpt.csv', import.meta.url));
    const bytes = await readFile(path);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      CA_SOS_BUSINESS_FIXTURE_PROVENANCE.fixtureSha256,
    );
    expect(CA_SOS_BUSINESS_FIXTURE_PROVENANCE.sourceUrl).toMatch(
      /^https:\/\/bizfileonline\.sos\.ca\.gov\//u,
    );
    expect(CA_SOS_BUSINESS_FIXTURE_PROVENANCE.legal.visibility).toBe('prohibited_public');
    expect(CA_SOS_BUSINESS_FIXTURE_PROVENANCE.sourceSemantics).toContain(
      'not a beneficial-ownership record',
    );
  });
});
