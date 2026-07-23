import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const fixtureUrl = new URL('./pilot-release-input.json', import.meta.url);

describe('portable serving pilot fixture', () => {
  it('is tiny, source-linked, shared-APN aware, and free of owner-bearing fields', async () => {
    const bytes = await readFile(fixtureUrl);
    const fixture = JSON.parse(bytes.toString('utf8')) as {
      properties: readonly Readonly<{ propertyId: string; parcelIdentifier: string }>[];
      provenance: Readonly<{ fixtureSource: string }>;
    };
    expect(bytes.byteLength).toBeLessThan(8_192);
    expect(fixture.properties).toHaveLength(2);
    expect(new Set(fixture.properties.map(({ propertyId }) => propertyId)).size).toBe(2);
    expect(new Set(fixture.properties.map(({ parcelIdentifier }) => parcelIdentifier)).size).toBe(
      1,
    );
    expect(fixture.provenance.fixtureSource).toContain('official-socrata-duplicate-apn.json');
    expect(bytes.toString('utf8')).not.toMatch(
      /"(?:owner_name|owners_text|mailing_address|grantor|grantee|email|phone|contact)"/iu,
    );
  });
});
