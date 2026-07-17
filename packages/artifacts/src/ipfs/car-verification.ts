import { createHash, timingSafeEqual } from 'node:crypto';

import type { CanonicalPropertyJson } from './canonical-property-json.js';
import { readCarRange, type PropertyCarRelease, type UnixFsCarShard } from './unixfs-car.js';

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
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

function fileBytesFromRange(shard: UnixFsCarShard, offset: number, length: number): Uint8Array {
  const record = readCarRange(shard, { offset, length });
  const recordLength = decodeVarint(record);
  const cidLength = 36;
  if (recordLength.value !== record.byteLength - recordLength.bytes) {
    throw new TypeError('CAR record length mismatch');
  }
  const blockStart = recordLength.bytes + cidLength;
  return parseFilePayload(record.slice(blockStart));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
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
  if (digest(release.rootIndexBytes) !== release.rootIndexSha256) {
    throw new TypeError('Root-index hash mismatch');
  }
  const byProperty = new Map(source.map((property) => [property.propertyId, property]));
  const observed = new Set<string>();
  for (const shard of release.shards) {
    if (digest(shard.bytes) !== shard.sha256)
      throw new TypeError(`CAR hash mismatch: ${shard.shard}`);
    if (shard.propertyCount > release.rootIndex.maximumPropertiesPerShard) {
      throw new TypeError(`CAR shard exceeds its property bound: ${shard.shard}`);
    }
    for (const entry of shard.entries) {
      if (observed.has(entry.propertyId))
        throw new TypeError(`Duplicate CAR property: ${entry.propertyId}`);
      observed.add(entry.propertyId);
      const expected = byProperty.get(entry.propertyId);
      if (expected === undefined)
        throw new TypeError(`Unexpected CAR property: ${entry.propertyId}`);
      const actual = fileBytesFromRange(shard, entry.blockRange.offset, entry.blockRange.length);
      if (!equalBytes(actual, expected.bytes) || digest(actual) !== expected.sha256) {
        throw new TypeError(`CAR range payload mismatch: ${entry.propertyId}`);
      }
    }
  }
  if (observed.size !== source.length) throw new TypeError('CAR property count mismatch');
  for (const property of source) {
    if (!observed.has(property.propertyId))
      throw new TypeError(`Missing CAR property: ${property.propertyId}`);
  }
}
