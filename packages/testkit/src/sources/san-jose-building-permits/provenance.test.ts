import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { SAN_JOSE_BUILDING_PERMIT_FIXTURE_PROVENANCE } from './provenance.js';

describe('San Jose building-permit official excerpts', () => {
  it('binds every small excerpt to immutable provenance and source semantics', async () => {
    for (const feed of Object.values(SAN_JOSE_BUILDING_PERMIT_FIXTURE_PROVENANCE.feeds)) {
      const bytes = await readFile(new URL(feed.excerptFile, import.meta.url));
      expect(bytes.byteLength).toBe(feed.excerptByteSize);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(feed.excerptSha256);
      expect(feed.originalByteSize).toBeGreaterThan(feed.excerptByteSize);
      expect(feed.originalRecordCount).toBeGreaterThan(10_000);
      expect(feed.exactUrl).toMatch(/^https:\/\/data\.sanjoseca\.gov\//u);
      expect(feed.originalArtifactSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(bytes.toString('utf8')).toContain(`"${feed.selectedSourceRowId}"`);
    }
  });

  it('contains one official row per feed without fixture owner names', async () => {
    for (const feed of Object.values(SAN_JOSE_BUILDING_PERMIT_FIXTURE_PROVENANCE.feeds)) {
      const text = await readFile(new URL(feed.excerptFile, import.meta.url), 'utf8');
      expect(text.trimEnd().split('\n')).toHaveLength(2);
      expect(text).toContain('"OWNERNAME"');
      expect(text).toContain('"NONE"');
    }
  });
});
