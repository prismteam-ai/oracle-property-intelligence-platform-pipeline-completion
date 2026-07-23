import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { MTC_PALO_ALTO_FIXTURE_PROVENANCE } from './provenance.js';

describe('MTC Palo Alto fixture provenance', () => {
  it('binds each official excerpt to an exact source artifact and non-public legal state', () => {
    expect(MTC_PALO_ALTO_FIXTURE_PROVENANCE.datasetId).toBe('c252-zdg8');
    expect(
      Object.values(MTC_PALO_ALTO_FIXTURE_PROVENANCE.artifacts).every(
        (artifact) =>
          artifact.exactUrl.startsWith('https://') &&
          /^[a-f0-9]{64}$/u.test(artifact.originalArtifactSha256) &&
          artifact.originalByteSize > 0 &&
          artifact.extractionMethod.length > 20,
      ),
    ).toBe(true);
    expect(MTC_PALO_ALTO_FIXTURE_PROVENANCE.legal).toEqual(
      expect.objectContaining({
        redistribution: 'unknown',
        publicVisibility: 'prohibited_public',
      }),
    );
  });

  it('matches the exact committed excerpt bytes recorded in provenance', async () => {
    const files = [
      ['official-socrata-duplicate-apn.json', MTC_PALO_ALTO_FIXTURE_PROVENANCE.artifacts.rows],
      [
        'official-metadata-excerpt.json',
        MTC_PALO_ALTO_FIXTURE_PROVENANCE.artifacts.socrataMetadata,
      ],
      [
        'official-arcgis-metadata-excerpt.json',
        MTC_PALO_ALTO_FIXTURE_PROVENANCE.artifacts.arcgisMetadata,
      ],
    ] as const;

    for (const [name, provenance] of files) {
      const bytes = await readFile(new URL(name, import.meta.url));
      expect(bytes.byteLength).toBe(provenance.excerptByteSize);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(provenance.excerptSha256);
    }
  });
});
