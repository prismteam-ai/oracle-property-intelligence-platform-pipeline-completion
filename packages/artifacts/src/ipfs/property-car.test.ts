import { describe, expect, it } from 'vitest';

import { buildCanonicalPropertyJson } from './canonical-property-json.js';
import { verifyPropertyCarRelease } from './car-verification.js';
import { buildPropertyCarRelease, readCarRange } from './unixfs-car.js';

const records = Object.freeze([
  Object.freeze({
    property_id: 'sc:entity:property:001',
    parcel_identifier: '001',
    city: 'Palo Alto',
    ownerName: 'must never leave the source record',
    regional_owner: true,
  }),
  Object.freeze({
    property_id: 'sc:entity:property:002',
    parcel_identifier: '002',
    city: 'San Jose',
    ownerName: 'must never leave the source record',
    regional_owner: false,
  }),
  Object.freeze({
    property_id: 'sc:entity:property:003',
    parcel_identifier: '003',
    city: 'Santa Clara',
    ownerName: 'must never leave the source record',
    regional_owner: null,
  }),
]);

const policy = Object.freeze({
  propertyIdField: 'property_id',
  approvedFields: Object.freeze(['property_id', 'parcel_identifier', 'city', 'regional_owner']),
  pathHashPrefixLength: 2,
});

describe('canonical per-property JSON and UnixFS CAR release', () => {
  it('is byte- and CID-deterministic, bounded, independently addressable, and range-verifiable', () => {
    const canonical = buildCanonicalPropertyJson(records, policy);
    const first = buildPropertyCarRelease(canonical, {
      initialPrefixLength: 1,
      maximumPropertiesPerShard: 1,
    });
    const second = buildPropertyCarRelease(
      buildCanonicalPropertyJson([...records].reverse(), policy),
      { initialPrefixLength: 1, maximumPropertiesPerShard: 1 },
    );

    expect(first.rootIndexBytes).toEqual(second.rootIndexBytes);
    expect(first.rootIndexSha256).toBe(second.rootIndexSha256);
    expect(first.shards.map(({ rootCid }) => rootCid)).toEqual(
      second.shards.map(({ rootCid }) => rootCid),
    );
    expect(first.shards.every(({ propertyCount }) => propertyCount <= 1)).toBe(true);
    expect(first.rootIndex.properties).toHaveLength(records.length);
    expect(
      first.rootIndex.properties.every(({ path }) => /^properties\/[a-f0-9]{2}\//u.test(path)),
    ).toBe(true);
    verifyPropertyCarRelease(first, canonical);

    const shard = first.shards[0];
    const entry = shard?.entries[0];
    expect(shard).toBeDefined();
    expect(entry).toBeDefined();
    if (shard === undefined || entry === undefined) throw new Error('Expected a populated shard');
    expect(readCarRange(shard, entry.blockRange)).toHaveLength(entry.blockRange.length);
    expect(() => readCarRange(shard, { offset: shard.byteLength, length: 1 })).toThrow(/outside/u);
  });

  it('fails closed for prohibited allowlist fields, duplicate IDs, and corrupted CAR bytes', () => {
    const firstRecord = records[0];
    if (firstRecord === undefined) throw new Error('Expected a source record');
    expect(() =>
      buildCanonicalPropertyJson(records, {
        ...policy,
        approvedFields: [...policy.approvedFields, 'ownerName'],
      }),
    ).toThrow(/Prohibited fields/u);
    expect(() => buildCanonicalPropertyJson([firstRecord, firstRecord], policy)).toThrow(
      /Duplicate property/u,
    );

    const canonical = buildCanonicalPropertyJson(records, policy);
    const release = buildPropertyCarRelease(canonical, { maximumPropertiesPerShard: 10 });
    const shard = release.shards[0];
    if (shard === undefined) throw new Error('Expected a populated shard');
    const corrupted = new Uint8Array(shard.bytes);
    const last = corrupted.byteLength - 1;
    corrupted[last] = (corrupted[last] ?? 0) ^ 1;
    expect(() =>
      verifyPropertyCarRelease(
        {
          ...release,
          shards: [{ ...shard, bytes: corrupted }, ...release.shards.slice(1)],
        },
        canonical,
      ),
    ).toThrow(/CAR hash mismatch/u);
  });

  it('preserves canonical key order, UTF-8, and one trailing LF without timestamps', () => {
    const canonical = buildCanonicalPropertyJson(records.slice(0, 1), policy);
    const bytes = canonical[0]?.bytes;
    expect(bytes).toBeDefined();
    if (bytes === undefined) throw new Error('Expected canonical JSON');
    const text = Buffer.from(bytes).toString('utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(text).toBe(
      '{"city":"Palo Alto","parcel_identifier":"001","property_id":"sc:entity:property:001","regional_owner":true}\n',
    );
    expect(text).not.toContain('ownerName');
    expect(text).not.toContain('generatedAt');
  });
});
