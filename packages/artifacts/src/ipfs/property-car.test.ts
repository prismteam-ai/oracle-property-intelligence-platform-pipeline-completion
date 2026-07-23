import { createHash } from 'node:crypto';

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

function rootBytes(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function decodeVarint(
  bytes: Uint8Array,
  start: number,
): Readonly<{ value: number; length: number }> {
  let value = 0;
  let multiplier = 1;
  for (let offset = start; offset < start + 10 && offset < bytes.byteLength; offset += 1) {
    const byte = bytes[offset];
    if (byte === undefined) break;
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return { value, length: offset - start + 1 };
    multiplier *= 128;
  }
  throw new TypeError('Malformed test CAR varint');
}

type TestCarRecord = Readonly<{
  cidOffset: number;
  blockOffset: number;
  blockLength: number;
}>;

function carRecords(bytes: Uint8Array): readonly TestCarRecord[] {
  const header = decodeVarint(bytes, 0);
  let offset = header.length + header.value;
  const records: TestCarRecord[] = [];
  while (offset < bytes.byteLength) {
    const length = decodeVarint(bytes, offset);
    const cidOffset = offset + length.length;
    records.push({
      cidOffset,
      blockOffset: cidOffset + 36,
      blockLength: length.value - 36,
    });
    offset = cidOffset + length.value;
  }
  return records;
}

function findBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let index = 0; index <= haystack.byteLength - needle.byteLength; index += 1) {
    for (let inner = 0; inner < needle.byteLength; inner += 1) {
      if (haystack[index + inner] !== needle[inner]) continue outer;
    }
    return index;
  }
  return -1;
}

function cidBytes(block: Uint8Array): Uint8Array {
  return Buffer.concat([
    Uint8Array.of(1, 0x70, 0x12, 0x20),
    createHash('sha256').update(block).digest(),
  ]);
}

const base32Alphabet = 'abcdefghijklmnopqrstuvwxyz234567';

function cidString(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += base32Alphabet.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) output += base32Alphabet.charAt((value << (5 - bits)) & 31);
  return `b${output}`;
}

function cidAtEntry(
  shard: ReturnType<typeof buildPropertyCarRelease>['shards'][number],
  index: number,
): Uint8Array {
  const entry = shard.entries[index];
  if (entry === undefined) throw new Error('Expected CAR entry');
  const length = decodeVarint(shard.bytes, entry.blockRange.offset);
  return shard.bytes.slice(
    entry.blockRange.offset + length.length,
    entry.blockRange.offset + length.length + 36,
  );
}

function unlinkFirstProperty(
  release: ReturnType<typeof buildPropertyCarRelease>,
): ReturnType<typeof buildPropertyCarRelease> {
  const shard = release.shards[0];
  if (shard === undefined || shard.entries.length < 2) {
    throw new Error('Expected one CAR shard with at least two entries');
  }
  const bytes = new Uint8Array(shard.bytes);
  const records = carRecords(bytes);
  const rootRecord = records[0];
  if (rootRecord === undefined) throw new Error('Expected CAR root record');
  const originalRootCid = bytes.slice(rootRecord.cidOffset, rootRecord.cidOffset + 36);
  let oldChildCid = cidAtEntry(shard, 0);
  let newChildCid = cidAtEntry(shard, 1);
  let rewrittenRootCid: Uint8Array | null = null;
  const rewrittenDirectories = new Set<string>();

  for (const recordBudget of records) {
    if (recordBudget.blockLength < 1) throw new Error('Expected a non-empty CAR block');
    const parent = records.find((record) => {
      const block = bytes.slice(record.blockOffset, record.blockOffset + record.blockLength);
      return findBytes(block, oldChildCid) >= 0;
    });
    if (parent === undefined) throw new Error('Expected a parent DAG-PB link');
    const block = bytes.slice(parent.blockOffset, parent.blockOffset + parent.blockLength);
    const linkOffset = findBytes(block, oldChildCid);
    block.set(newChildCid, linkOffset);
    bytes.set(block, parent.blockOffset);
    const oldParentCid = bytes.slice(parent.cidOffset, parent.cidOffset + 36);
    const oldParentCidString = cidString(oldParentCid);
    if (rewrittenDirectories.has(oldParentCidString)) {
      throw new Error('Path rewrite encountered a DAG cycle');
    }
    rewrittenDirectories.add(oldParentCidString);
    const newParentCid = cidBytes(block);
    bytes.set(newParentCid, parent.cidOffset);
    if (Buffer.from(oldParentCid).equals(originalRootCid)) {
      const header = decodeVarint(bytes, 0);
      const headerBytes = bytes.slice(header.length, header.length + header.value);
      const rootOffset = findBytes(headerBytes, originalRootCid);
      if (rootOffset < 0) throw new Error('Expected root CID in CAR header');
      headerBytes.set(newParentCid, rootOffset);
      bytes.set(headerBytes, header.length);
      rewrittenRootCid = newParentCid;
      break;
    }
    oldChildCid = oldParentCid;
    newChildCid = newParentCid;
  }
  if (rewrittenRootCid === null) throw new Error('Expected path rewrite to reach the CAR root');

  const newRootCid = cidString(rewrittenRootCid);
  const newShardSha = hash(bytes);
  const updatedShard = { ...shard, rootCid: newRootCid, sha256: newShardSha, bytes };
  const index = {
    ...release.rootIndex,
    shards: release.rootIndex.shards.map((item) =>
      item.shard === shard.shard ? { ...item, rootCid: newRootCid, sha256: newShardSha } : item,
    ),
    properties: release.rootIndex.properties.map((item) =>
      item.shard === shard.shard ? { ...item, shardRootCid: newRootCid } : item,
    ),
  };
  const indexBytes = rootBytes(index);
  return {
    ...release,
    shards: [updatedShard, ...release.shards.slice(1)],
    rootIndex: index,
    rootIndexBytes: indexBytes,
    rootIndexSha256: hash(indexBytes),
  };
}

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
    expect(
      first.shards.every(({ byteLength }) => byteLength <= first.rootIndex.maximumShardBytes),
    ).toBe(true);
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

  it('rejects nested and normalized prohibited field variants in an approved projection', () => {
    const firstRecord = records[0];
    if (firstRecord === undefined) throw new Error('Expected a source record');
    for (const nested of [
      { owner_name: 'private' },
      { OwnerMailingAddress: 'private' },
      { profile: { CONTACT_EMAIL: 'private@example.invalid' } },
      [{ granteeAddress: 'private' }],
      { permitApplicant: 'private' },
      { 'FBN Registrant.Name': 'private' },
      { fbn_party_identifier: 'private' },
      { registrantResidence: 'private' },
      { SOS: { Officer_Residential_Address: 'private' } },
      { sosAgentAddress: 'private' },
      { 'Social-Security_Number': '000-00-0000' },
      { DATE_OF_BIRTH: '1900-01-01' },
    ]) {
      expect(() =>
        buildCanonicalPropertyJson([{ ...firstRecord, public_evidence: nested }], {
          ...policy,
          approvedFields: [...policy.approvedFields, 'public_evidence'],
        }),
      ).toThrow(/prohibited public field/iu);
    }
    expect(() =>
      buildCanonicalPropertyJson(records, {
        ...policy,
        approvedFields: [...policy.approvedFields, 'OWNER-NAME'],
      }),
    ).toThrow(/Prohibited fields/iu);
  });

  it('rejects an independently valid file block that is not linked by its indexed root path', () => {
    const reachabilityRecords = [
      { ...records[0], property_id: 'sc:entity:property:reach-2' },
      { ...records[1], property_id: 'sc:entity:property:reach-5' },
    ];
    const canonical = buildCanonicalPropertyJson(reachabilityRecords, policy);
    const release = buildPropertyCarRelease(canonical, {
      initialPrefixLength: 1,
      maximumPropertiesPerShard: 10,
    });
    const unlinked = unlinkFirstProperty(release);
    expect(() => verifyPropertyCarRelease(unlinked, canonical)).toThrow(
      /Property path resolves to the wrong file CID/u,
    );
  });

  it('enforces byte bounds and verifies root-index, file-CID, and range metadata', () => {
    const canonical = buildCanonicalPropertyJson(records, policy);
    expect(() =>
      buildPropertyCarRelease(canonical, {
        maximumPropertiesPerShard: 10,
        maximumShardBytes: 1,
      }),
    ).toThrow(/maximumShardBytes/u);

    const release = buildPropertyCarRelease(canonical, {
      maximumPropertiesPerShard: 10,
      maximumShardBytes: 1_000_000,
    });
    const shard = release.shards[0];
    const entry = shard?.entries[0];
    const indexedProperty = release.rootIndex.properties[0];
    if (shard === undefined || entry === undefined || indexedProperty === undefined) {
      throw new Error('Expected populated CAR metadata');
    }

    const badIndex = {
      ...release.rootIndex,
      properties: [
        { ...indexedProperty, sha256: '0'.repeat(64) },
        ...release.rootIndex.properties.slice(1),
      ],
    };
    const badIndexBytes = rootBytes(badIndex);
    expect(() =>
      verifyPropertyCarRelease(
        {
          ...release,
          rootIndex: badIndex,
          rootIndexBytes: badIndexBytes,
          rootIndexSha256: hash(badIndexBytes),
        },
        canonical,
      ),
    ).toThrow(/property metadata mismatch/u);

    const badFileCid = `${entry.fileCid.slice(0, -1)}${entry.fileCid.endsWith('a') ? 'b' : 'a'}`;
    const badEntry = { ...entry, fileCid: badFileCid };
    const badCidShard = { ...shard, entries: [badEntry, ...shard.entries.slice(1)] };
    const badCidIndex = {
      ...release.rootIndex,
      properties: [
        { ...indexedProperty, fileCid: badFileCid },
        ...release.rootIndex.properties.slice(1),
      ],
    };
    const badCidIndexBytes = rootBytes(badCidIndex);
    expect(() =>
      verifyPropertyCarRelease(
        {
          ...release,
          shards: [badCidShard, ...release.shards.slice(1)],
          rootIndex: badCidIndex,
          rootIndexBytes: badCidIndexBytes,
          rootIndexSha256: hash(badCidIndexBytes),
        },
        canonical,
      ),
    ).toThrow(/CID mismatch/u);

    const corruptedHeaderBytes = new Uint8Array(shard.bytes);
    corruptedHeaderBytes[2] = (corruptedHeaderBytes[2] ?? 0) ^ 1;
    const corruptedHeaderSha = hash(corruptedHeaderBytes);
    const indexedShard = release.rootIndex.shards[0];
    if (indexedShard === undefined) throw new Error('Expected indexed shard');
    const corruptedHeaderIndex = {
      ...release.rootIndex,
      shards: [
        { ...indexedShard, sha256: corruptedHeaderSha },
        ...release.rootIndex.shards.slice(1),
      ],
    };
    const corruptedHeaderIndexBytes = rootBytes(corruptedHeaderIndex);
    expect(() =>
      verifyPropertyCarRelease(
        {
          ...release,
          shards: [
            { ...shard, bytes: corruptedHeaderBytes, sha256: corruptedHeaderSha },
            ...release.shards.slice(1),
          ],
          rootIndex: corruptedHeaderIndex,
          rootIndexBytes: corruptedHeaderIndexBytes,
          rootIndexSha256: hash(corruptedHeaderIndexBytes),
        },
        canonical,
      ),
    ).toThrow(/header root mismatch/u);

    const badRangeShard = {
      ...shard,
      entries: [
        { ...entry, blockRange: { ...entry.blockRange, offset: entry.blockRange.offset + 1 } },
        ...shard.entries.slice(1),
      ],
    };
    expect(() =>
      verifyPropertyCarRelease(
        { ...release, shards: [badRangeShard, ...release.shards.slice(1)] },
        canonical,
      ),
    ).toThrow(/record length|file CID|outside/iu);
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
    const firstRecord = records[0];
    if (firstRecord === undefined) throw new Error('Expected a source record');
    expect(() =>
      buildCanonicalPropertyJson([{ ...firstRecord, public_evidence: new Date(0) }], {
        ...policy,
        approvedFields: [...policy.approvedFields, 'public_evidence'],
      }),
    ).toThrow(/plain JSON objects/u);
  });
});
