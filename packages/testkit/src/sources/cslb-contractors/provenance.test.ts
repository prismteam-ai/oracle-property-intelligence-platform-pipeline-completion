import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { CSLB_SAFE_FIXTURE_PROVENANCE } from './provenance.js';

describe('CSLB safe fixture provenance', () => {
  it('pins exact bytes and documents the bounded, non-PII derivation', async () => {
    const fixture = await readFile(new URL('./official-master-safe-excerpt.json', import.meta.url));
    expect(createHash('sha256').update(fixture).digest('hex')).toBe(
      CSLB_SAFE_FIXTURE_PROVENANCE.fixtureSha256,
    );
    const parsed = JSON.parse(fixture.toString('utf8')) as {
      source: {
        fullSnapshotDownloadedForFixture: boolean;
        boundedPrefixBytes: number;
        boundedPrefixSha256: string;
        boundedPrefixRetrievalStartedAt: string;
        lastVerifiedAt: string;
      };
      derivation: { removedFields: string[]; safeProjectionHashFieldsInOrder: string[] };
      records: Record<string, unknown>[];
    };
    expect(parsed.source.fullSnapshotDownloadedForFixture).toBe(false);
    expect(parsed.source.boundedPrefixBytes).toBe(1_048_576);
    expect(parsed.source.boundedPrefixSha256).toBe(
      '85aee63a6f2de0d9be3a37316fb94d90f84f26192e4beb5399e1d5bbfad8da3e',
    );
    expect(parsed.source.boundedPrefixSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(Date.parse(parsed.source.lastVerifiedAt)).toBeGreaterThan(
      Date.parse(parsed.source.boundedPrefixRetrievalStartedAt),
    );
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records.every((record) => record.BusinessType === 'Corporation')).toBe(true);
    expect(parsed.derivation.removedFields).toEqual(
      expect.arrayContaining(['MailingAddress', 'BusinessPhone', 'WCPolicyNumber', 'CBNumber']),
    );
    for (const record of parsed.records) {
      expect(record).not.toHaveProperty('MailingAddress');
      expect(record).not.toHaveProperty('BusinessPhone');
      expect(record).not.toHaveProperty('WCPolicyNumber');
      expect(record).not.toHaveProperty('CBNumber');
      const projection = Object.fromEntries(
        parsed.derivation.safeProjectionHashFieldsInOrder.map((field) => [
          field,
          record[field] ?? '',
        ]),
      );
      expect(createHash('sha256').update(JSON.stringify(projection)).digest('hex')).toBe(
        record.safeProjectionSha256,
      );
    }
  });
});
