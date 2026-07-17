import { createHash, timingSafeEqual } from 'node:crypto';

import type { CanonicalPropertyJson } from './canonical-property-json.js';
import {
  readCarRange,
  type PropertyCarEntry,
  type PropertyCarRelease,
  type PropertyRootIndex,
  type UnixFsCarShard,
} from './unixfs-car.js';

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  return Buffer.concat(parts);
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32.charAt((value << (5 - bits)) & 31);
  return `b${output}`;
}

function blockCid(block: Uint8Array): string {
  return base32(
    concat([Uint8Array.of(1, 0x70, 0x12, 0x20), createHash('sha256').update(block).digest()]),
  );
}

function carHeader(rootCid: Uint8Array): Uint8Array {
  const taggedCid = concat([Uint8Array.of(0), rootCid]);
  return concat([
    Uint8Array.of(0xa2, 0x65),
    Buffer.from('roots'),
    Uint8Array.of(0x81, 0xd8, 0x2a, 0x58, taggedCid.byteLength),
    taggedCid,
    Uint8Array.of(0x67),
    Buffer.from('version'),
    Uint8Array.of(0x01),
  ]);
}

function decodeVarint(bytes: Uint8Array, start = 0): Readonly<{ value: number; bytes: number }> {
  let value = 0;
  let multiplier = 1;
  for (let index = start; index < bytes.byteLength && index < start + 10; index += 1) {
    const byte = bytes[index];
    if (byte === undefined) break;
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return Object.freeze({ value, bytes: index - start + 1 });
    multiplier *= 128;
  }
  throw new TypeError('Malformed varint');
}

type ProtobufField = Readonly<{
  number: number;
  wire: 0 | 2;
  value: number | Uint8Array;
}>;

function protobufFields(bytes: Uint8Array, label: string): readonly ProtobufField[] {
  const fields: ProtobufField[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const tag = decodeVarint(bytes, offset);
    offset += tag.bytes;
    const number = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    if (number < 1 || (wire !== 0 && wire !== 2)) {
      throw new TypeError(`${label} uses an unsupported protobuf field`);
    }
    if (wire === 0) {
      const value = decodeVarint(bytes, offset);
      offset += value.bytes;
      fields.push(Object.freeze({ number, wire, value: value.value }));
      continue;
    }
    const length = decodeVarint(bytes, offset);
    offset += length.bytes;
    const end = offset + length.value;
    if (!Number.isSafeInteger(end) || end > bytes.byteLength) {
      throw new TypeError(`${label} contains a truncated protobuf field`);
    }
    fields.push(Object.freeze({ number, wire, value: bytes.slice(offset, end) }));
    offset = end;
  }
  return Object.freeze(fields);
}

function byteField(field: ProtobufField | undefined, label: string): Uint8Array {
  if (field?.wire !== 2 || !(field.value instanceof Uint8Array)) {
    throw new TypeError(`${label} is invalid`);
  }
  return field.value;
}

function uintField(field: ProtobufField | undefined, label: string): number {
  if (field?.wire !== 0 || typeof field.value !== 'number') {
    throw new TypeError(`${label} is invalid`);
  }
  return field.value;
}

type DirectoryLink = Readonly<{ name: string; cid: string }>;

function directoryLinks(block: Uint8Array): readonly DirectoryLink[] {
  const nodeFields = protobufFields(block, 'DAG-PB directory');
  const dataFields = nodeFields.filter(({ number }) => number === 1);
  if (dataFields.length !== 1 || nodeFields.some(({ number }) => number !== 1 && number !== 2)) {
    throw new TypeError('DAG-PB directory node fields are invalid');
  }
  const unixFsFields = protobufFields(byteField(dataFields[0], 'UnixFS directory data'), 'UnixFS');
  if (
    unixFsFields.length !== 1 ||
    unixFsFields[0]?.number !== 1 ||
    uintField(unixFsFields[0], 'UnixFS directory type') !== 1
  ) {
    throw new TypeError('Expected a pinned UnixFS directory');
  }
  const names = new Set<string>();
  return Object.freeze(
    nodeFields
      .filter(({ number }) => number === 2)
      .map((field) => {
        const linkFields = protobufFields(byteField(field, 'DAG-PB link'), 'DAG-PB link');
        if (
          linkFields.length !== 3 ||
          linkFields.some(({ number }) => number !== 1 && number !== 2 && number !== 3)
        ) {
          throw new TypeError('DAG-PB link fields are invalid');
        }
        const cidBytes = byteField(
          linkFields.find(({ number }) => number === 1),
          'DAG-PB link CID',
        );
        const nameBytes = byteField(
          linkFields.find(({ number }) => number === 2),
          'DAG-PB link name',
        );
        uintField(
          linkFields.find(({ number }) => number === 3),
          'DAG-PB link size',
        );
        if (
          cidBytes.byteLength !== 36 ||
          cidBytes[0] !== 1 ||
          cidBytes[1] !== 0x70 ||
          cidBytes[2] !== 0x12 ||
          cidBytes[3] !== 0x20
        ) {
          throw new TypeError('DAG-PB link CID profile is invalid');
        }
        const name = Buffer.from(nameBytes).toString('utf8');
        if (
          name.length === 0 ||
          name.includes('/') ||
          !equalBytes(nameBytes, Buffer.from(name, 'utf8')) ||
          names.has(name)
        ) {
          throw new TypeError('DAG-PB link name is invalid or repeated');
        }
        names.add(name);
        return Object.freeze({ name, cid: base32(cidBytes) });
      }),
  );
}

function carBlockMap(shard: UnixFsCarShard): ReadonlyMap<string, Uint8Array> {
  const headerLength = decodeVarint(shard.bytes);
  let offset = headerLength.bytes + headerLength.value;
  if (offset > shard.bytes.byteLength)
    throw new TypeError(`CAR header is truncated: ${shard.shard}`);
  const blocks = new Map<string, Uint8Array>();
  while (offset < shard.bytes.byteLength) {
    const recordLength = decodeVarint(shard.bytes, offset);
    offset += recordLength.bytes;
    const end = offset + recordLength.value;
    if (recordLength.value <= 36 || end > shard.bytes.byteLength) {
      throw new TypeError(`CAR record is corrupt: ${shard.shard}`);
    }
    const cidBytes = shard.bytes.slice(offset, offset + 36);
    const block = shard.bytes.slice(offset + 36, end);
    const cid = base32(cidBytes);
    if (blockCid(block) !== cid) throw new TypeError(`CAR block CID mismatch: ${shard.shard}`);
    if (blocks.has(cid)) throw new TypeError(`CAR block CID repeats: ${shard.shard}`);
    blocks.set(cid, block);
    offset = end;
  }
  return blocks;
}

function verifyPathReachability(
  shard: UnixFsCarShard,
  entry: PropertyCarEntry,
  blocks: ReadonlyMap<string, Uint8Array>,
  directoryCache: Map<string, readonly DirectoryLink[]>,
): void {
  const segments = entry.path.split('/');
  if (segments.length < 2 || segments.some((segment) => segment.length === 0)) {
    throw new TypeError(`Indexed property path is invalid: ${entry.propertyId}`);
  }
  let directoryCid = shard.rootCid;
  for (const [index, segment] of segments.entries()) {
    const block = blocks.get(directoryCid);
    if (block === undefined) {
      throw new TypeError(`Property path directory is absent from CAR: ${entry.propertyId}`);
    }
    const links = directoryCache.get(directoryCid) ?? directoryLinks(block);
    directoryCache.set(directoryCid, links);
    const link = links.find(({ name }) => name === segment);
    if (link === undefined) {
      throw new TypeError(`Property path is not reachable from shard root: ${entry.propertyId}`);
    }
    const final = index === segments.length - 1;
    if (final) {
      if (link.cid !== entry.fileCid || !blocks.has(link.cid)) {
        throw new TypeError(`Property path resolves to the wrong file CID: ${entry.propertyId}`);
      }
    } else {
      directoryCid = link.cid;
    }
  }
}

function parseFilePayload(block: Uint8Array): Uint8Array {
  let offset = 0;
  const nodeTag = decodeVarint(block, offset);
  offset += nodeTag.bytes;
  if (nodeTag.value !== 10) throw new TypeError('Expected DAG-PB Data field');
  const dataLength = decodeVarint(block, offset);
  offset += dataLength.bytes;
  const data = block.slice(offset, offset + dataLength.value);
  let unixOffset = 0;
  const typeTag = decodeVarint(data, unixOffset);
  unixOffset += typeTag.bytes;
  const typeValue = decodeVarint(data, unixOffset);
  unixOffset += typeValue.bytes;
  if (typeTag.value !== 8 || typeValue.value !== 2) throw new TypeError('Expected UnixFS file');
  const payloadTag = decodeVarint(data, unixOffset);
  unixOffset += payloadTag.bytes;
  if (payloadTag.value !== 18) throw new TypeError('Expected UnixFS file payload');
  const payloadLength = decodeVarint(data, unixOffset);
  unixOffset += payloadLength.bytes;
  return data.slice(unixOffset, unixOffset + payloadLength.value);
}

function fileBytesFromRange(
  shard: UnixFsCarShard,
  offset: number,
  length: number,
  expectedFileCid: string,
): Uint8Array {
  const record = readCarRange(shard, { offset, length });
  const recordLength = decodeVarint(record);
  const cidLength = 36;
  if (recordLength.value !== record.byteLength - recordLength.bytes) {
    throw new TypeError('CAR record length mismatch');
  }
  const actualCid = record.slice(recordLength.bytes, recordLength.bytes + cidLength);
  if (base32(actualCid) !== expectedFileCid) throw new TypeError('CAR record CID mismatch');
  const blockStart = recordLength.bytes + cidLength;
  const block = record.slice(blockStart);
  if (blockCid(block) !== expectedFileCid) throw new TypeError('CAR file CID mismatch');
  return parseFilePayload(block);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function verifyRootCid(shard: UnixFsCarShard): void {
  const headerLength = decodeVarint(shard.bytes);
  const header = shard.bytes.slice(headerLength.bytes, headerLength.bytes + headerLength.value);
  const rootOffset = headerLength.bytes + headerLength.value;
  const rootRecordLength = decodeVarint(shard.bytes, rootOffset);
  const cidOffset = rootOffset + rootRecordLength.bytes;
  const actualRootCid = shard.bytes.slice(cidOffset, cidOffset + 36);
  const blockOffset = cidOffset + 36;
  const blockLength = rootRecordLength.value - 36;
  if (blockLength < 1 || blockOffset + blockLength > shard.bytes.byteLength) {
    throw new TypeError(`CAR root record is corrupt: ${shard.shard}`);
  }
  if (base32(actualRootCid) !== shard.rootCid) {
    throw new TypeError(`CAR root record CID mismatch: ${shard.shard}`);
  }
  if (!equalBytes(header, carHeader(actualRootCid))) {
    throw new TypeError(`CAR header root mismatch: ${shard.shard}`);
  }
  if (blockCid(shard.bytes.slice(blockOffset, blockOffset + blockLength)) !== shard.rootCid) {
    throw new TypeError(`CAR root CID mismatch: ${shard.shard}`);
  }
}

function shardMetadataMatches(
  indexed: PropertyRootIndex['shards'][number] | undefined,
  shard: UnixFsCarShard,
): boolean {
  if (indexed === undefined) return false;
  return (
    indexed.rootCid === shard.rootCid &&
    indexed.sha256 === shard.sha256 &&
    indexed.byteLength === shard.byteLength &&
    indexed.propertyCount === shard.propertyCount
  );
}

function propertyMetadataMatches(
  indexed: PropertyRootIndex['properties'][number] | undefined,
  entry: PropertyCarEntry,
  shard: UnixFsCarShard,
  expected: CanonicalPropertyJson,
): boolean {
  if (indexed === undefined) return false;
  return (
    indexed.path === entry.path &&
    indexed.sha256 === entry.sha256 &&
    indexed.byteLength === entry.byteLength &&
    indexed.shard === shard.shard &&
    indexed.shardRootCid === shard.rootCid &&
    indexed.fileCid === entry.fileCid &&
    entry.path === expected.path &&
    entry.sha256 === expected.sha256 &&
    entry.byteLength === expected.byteLength
  );
}

export function verifyPropertyCarRelease(
  release: PropertyCarRelease,
  source: readonly CanonicalPropertyJson[],
): void {
  if (release.rootIndex.eligiblePropertyCount !== source.length) {
    throw new TypeError('Root-index eligible-property denominator mismatch');
  }
  if (release.rootIndex.shardCount !== release.shards.length) {
    throw new TypeError('Root-index shard denominator mismatch');
  }
  if (release.rootIndex.shards.length !== release.rootIndex.shardCount) {
    throw new TypeError('Root-index shard metadata denominator mismatch');
  }
  if (digest(release.rootIndexBytes) !== release.rootIndexSha256) {
    throw new TypeError('Root-index hash mismatch');
  }
  const canonicalRootIndexBytes = Buffer.from(`${JSON.stringify(release.rootIndex)}\n`, 'utf8');
  if (!equalBytes(release.rootIndexBytes, canonicalRootIndexBytes)) {
    throw new TypeError('Root-index bytes are not canonical');
  }
  const schemaVersion: unknown = release.rootIndex.schemaVersion;
  const unixFsProfile = release.rootIndex.unixFsProfile as Readonly<Record<string, unknown>>;
  if (
    schemaVersion !== '1.0.0' ||
    unixFsProfile.cidVersion !== 1 ||
    unixFsProfile.codec !== 'dag-pb' ||
    unixFsProfile.multihash !== 'sha2-256' ||
    unixFsProfile.fileLayout !== 'unixfs-inline-file-v1' ||
    unixFsProfile.carVersion !== 1 ||
    !Number.isSafeInteger(release.rootIndex.maximumPropertiesPerShard) ||
    release.rootIndex.maximumPropertiesPerShard < 1 ||
    !Number.isSafeInteger(release.rootIndex.maximumShardBytes) ||
    release.rootIndex.maximumShardBytes < 1
  ) {
    throw new TypeError('Root-index UnixFS profile or bounds are invalid');
  }
  let parsedRootIndex: unknown;
  try {
    parsedRootIndex = JSON.parse(Buffer.from(release.rootIndexBytes).toString('utf8')) as unknown;
  } catch (error) {
    throw new TypeError('Root-index bytes are corrupt', { cause: error });
  }
  if (JSON.stringify(parsedRootIndex) !== JSON.stringify(release.rootIndex)) {
    throw new TypeError('Root-index bytes do not match the supplied root index');
  }
  const byProperty = new Map(source.map((property) => [property.propertyId, property]));
  if (byProperty.size !== source.length) throw new TypeError('Source property identifiers repeat');
  const indexed = new Map(
    release.rootIndex.properties.map((property) => [property.propertyId, property]),
  );
  if (
    indexed.size !== source.length ||
    release.rootIndex.properties.length !== release.rootIndex.eligiblePropertyCount
  ) {
    throw new TypeError('Root-index property denominator mismatch');
  }
  if (
    new Set(release.rootIndex.shards.map(({ shard }) => shard)).size !==
    release.rootIndex.shards.length
  ) {
    throw new TypeError('Root-index shard identifiers repeat');
  }
  const observed = new Set<string>();
  for (const shard of release.shards) {
    if (digest(shard.bytes) !== shard.sha256)
      throw new TypeError(`CAR hash mismatch: ${shard.shard}`);
    if (shard.propertyCount > release.rootIndex.maximumPropertiesPerShard) {
      throw new TypeError(`CAR shard exceeds its property bound: ${shard.shard}`);
    }
    if (shard.byteLength > release.rootIndex.maximumShardBytes) {
      throw new TypeError(`CAR shard exceeds its byte bound: ${shard.shard}`);
    }
    if (
      shard.byteLength !== shard.bytes.byteLength ||
      shard.propertyCount !== shard.entries.length
    ) {
      throw new TypeError(`CAR shard metadata mismatch: ${shard.shard}`);
    }
    verifyRootCid(shard);
    const blocks = carBlockMap(shard);
    const directoryCache = new Map<string, readonly DirectoryLink[]>();
    const indexedShard = release.rootIndex.shards.find(({ shard: name }) => name === shard.shard);
    if (!shardMetadataMatches(indexedShard, shard)) {
      throw new TypeError(`Root-index shard metadata mismatch: ${shard.shard}`);
    }
    for (const entry of shard.entries) {
      if (observed.has(entry.propertyId))
        throw new TypeError(`Duplicate CAR property: ${entry.propertyId}`);
      observed.add(entry.propertyId);
      const expected = byProperty.get(entry.propertyId);
      if (expected === undefined)
        throw new TypeError(`Unexpected CAR property: ${entry.propertyId}`);
      const indexedProperty = indexed.get(entry.propertyId);
      if (!propertyMetadataMatches(indexedProperty, entry, shard, expected)) {
        throw new TypeError(`Root-index property metadata mismatch: ${entry.propertyId}`);
      }
      const actual = fileBytesFromRange(
        shard,
        entry.blockRange.offset,
        entry.blockRange.length,
        entry.fileCid,
      );
      if (!equalBytes(actual, expected.bytes) || digest(actual) !== expected.sha256) {
        throw new TypeError(`CAR range payload mismatch: ${entry.propertyId}`);
      }
      verifyPathReachability(shard, entry, blocks, directoryCache);
    }
  }
  if (observed.size !== source.length) throw new TypeError('CAR property count mismatch');
  for (const property of source) {
    if (!observed.has(property.propertyId))
      throw new TypeError(`Missing CAR property: ${property.propertyId}`);
  }
}
