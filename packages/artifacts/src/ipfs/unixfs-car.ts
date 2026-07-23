import { createHash } from 'node:crypto';

import type { CanonicalPropertyJson } from './canonical-property-json.js';

const DAG_PB_CODEC = 0x70;
const SHA2_256_CODE = 0x12;

export type CarRange = Readonly<{
  offset: number;
  length: number;
}>;

export type PropertyCarEntry = Readonly<{
  propertyId: string;
  path: string;
  sha256: string;
  byteLength: number;
  fileCid: string;
  blockRange: CarRange;
}>;

export type UnixFsCarShard = Readonly<{
  shard: string;
  rootCid: string;
  sha256: string;
  byteLength: number;
  propertyCount: number;
  bytes: Uint8Array;
  entries: readonly PropertyCarEntry[];
}>;

export type PropertyRootIndex = Readonly<{
  schemaVersion: '1.0.0';
  unixFsProfile: Readonly<{
    cidVersion: 1;
    codec: 'dag-pb';
    multihash: 'sha2-256';
    fileLayout: 'unixfs-inline-file-v1';
    carVersion: 1;
  }>;
  eligiblePropertyCount: number;
  shardCount: number;
  maximumPropertiesPerShard: number;
  maximumShardBytes: number;
  shards: readonly Readonly<{
    shard: string;
    rootCid: string;
    sha256: string;
    byteLength: number;
    propertyCount: number;
  }>[];
  properties: readonly Readonly<{
    propertyId: string;
    path: string;
    sha256: string;
    byteLength: number;
    shard: string;
    shardRootCid: string;
    fileCid: string;
  }>[];
}>;

export type PropertyCarRelease = Readonly<{
  shards: readonly UnixFsCarShard[];
  rootIndex: PropertyRootIndex;
  rootIndexBytes: Uint8Array;
  rootIndexSha256: string;
}>;

function concat(parts: readonly Uint8Array[]): Uint8Array {
  return Buffer.concat(parts);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function sha256Bytes(bytes: Uint8Array): Uint8Array {
  return createHash('sha256').update(bytes).digest();
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function varint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Invalid unsigned varint');
  const output: number[] = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    output.push(byte);
  } while (remaining > 0);
  return Uint8Array.from(output);
}

function protobufField(field: number, wire: 0 | 2, payload: Uint8Array): Uint8Array {
  const tag = varint(field * 8 + wire);
  return wire === 0 ? concat([tag, payload]) : concat([tag, varint(payload.byteLength), payload]);
}

function unixFsFile(bytes: Uint8Array): Uint8Array {
  return concat([
    protobufField(1, 0, varint(2)),
    protobufField(2, 2, bytes),
    protobufField(3, 0, varint(bytes.byteLength)),
  ]);
}

function unixFsDirectory(): Uint8Array {
  return protobufField(1, 0, varint(1));
}

function dagPbFile(bytes: Uint8Array): Uint8Array {
  return protobufField(1, 2, unixFsFile(bytes));
}

function dagPbLink(name: string, cidBytes: Uint8Array, totalSize: number): Uint8Array {
  return concat([
    protobufField(1, 2, cidBytes),
    protobufField(2, 2, Buffer.from(name, 'utf8')),
    protobufField(3, 0, varint(totalSize)),
  ]);
}

function dagPbDirectory(
  links: readonly Readonly<{ name: string; cidBytes: Uint8Array; totalSize: number }>[],
): Uint8Array {
  const sorted = [...links].sort((left, right) =>
    Buffer.from(left.name).compare(Buffer.from(right.name)),
  );
  return concat([
    protobufField(1, 2, unixFsDirectory()),
    ...sorted.map((link) =>
      protobufField(2, 2, dagPbLink(link.name, link.cidBytes, link.totalSize)),
    ),
  ]);
}

function cidBytes(block: Uint8Array): Uint8Array {
  return concat([
    varint(1),
    varint(DAG_PB_CODEC),
    varint(SHA2_256_CODE),
    varint(32),
    sha256Bytes(block),
  ]);
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

function cidString(bytes: Uint8Array): string {
  return base32(bytes);
}

function dagCborHeader(rootCid: Uint8Array): Uint8Array {
  const taggedCid = concat([Uint8Array.of(0), rootCid]);
  if (taggedCid.byteLength >= 256) throw new RangeError('Unexpected CID size');
  const byteString =
    taggedCid.byteLength < 24
      ? concat([Uint8Array.of(0x40 + taggedCid.byteLength), taggedCid])
      : concat([Uint8Array.of(0x58, taggedCid.byteLength), taggedCid]);
  return concat([
    Uint8Array.of(0xa2),
    Uint8Array.of(0x65),
    Buffer.from('roots'),
    Uint8Array.of(0x81, 0xd8, 0x2a),
    byteString,
    Uint8Array.of(0x67),
    Buffer.from('version'),
    Uint8Array.of(0x01),
  ]);
}

function carRecord(cid: Uint8Array, block: Uint8Array): Uint8Array {
  const payload = concat([cid, block]);
  return concat([varint(payload.byteLength), payload]);
}

function basename(path: string): string {
  const name = path.split('/').at(-1);
  if (name === undefined || name.length === 0)
    throw new TypeError(`Invalid property path: ${path}`);
  return name;
}

type BuiltFile = Readonly<{
  property: CanonicalPropertyJson;
  block: Uint8Array;
  cid: Uint8Array;
  name: string;
}>;

type BuiltDirectory = Readonly<{
  block: Uint8Array;
  cid: Uint8Array;
  totalSize: number;
  descendants: readonly Readonly<{ cid: Uint8Array; block: Uint8Array }>[];
}>;

interface DirectoryTree {
  directories: Map<string, DirectoryTree>;
  files: BuiltFile[];
}

function directoryTree(): DirectoryTree {
  return { directories: new Map(), files: [] };
}

function addToTree(root: DirectoryTree, file: BuiltFile): void {
  const segments = file.property.path.split('/');
  if (segments.length < 2 || segments.some((segment) => segment.length === 0)) {
    throw new TypeError(`Property path must contain directories: ${file.property.path}`);
  }
  let selected = root;
  for (const segment of segments.slice(0, -1)) {
    const child = selected.directories.get(segment) ?? directoryTree();
    selected.directories.set(segment, child);
    selected = child;
  }
  selected.files.push(file);
}

function buildDirectory(tree: DirectoryTree): BuiltDirectory {
  const directories = [...tree.directories.entries()]
    .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
    .map(([name, child]) => Object.freeze({ name, directory: buildDirectory(child) }));
  const files = [...tree.files].sort((left, right) =>
    Buffer.from(left.name).compare(Buffer.from(right.name)),
  );
  const links = [
    ...directories.map(({ name, directory }) => ({
      name,
      cidBytes: directory.cid,
      totalSize: directory.totalSize,
    })),
    ...files.map((file) => ({
      name: file.name,
      cidBytes: file.cid,
      totalSize: file.block.byteLength,
    })),
  ];
  const block = dagPbDirectory(links);
  const cid = cidBytes(block);
  const totalSize =
    block.byteLength +
    directories.reduce((total, { directory }) => total + directory.totalSize, 0) +
    files.reduce((total, file) => total + file.block.byteLength, 0);
  return Object.freeze({
    block,
    cid,
    totalSize,
    descendants: Object.freeze([
      ...directories.flatMap(({ directory }) => [
        Object.freeze({ cid: directory.cid, block: directory.block }),
        ...directory.descendants,
      ]),
    ]),
  });
}

function buildShard(shard: string, properties: readonly CanonicalPropertyJson[]): UnixFsCarShard {
  const files: BuiltFile[] = properties.map((property) => {
    const block = dagPbFile(property.bytes);
    const cid = cidBytes(block);
    return Object.freeze({ property, block, cid, name: basename(property.path) });
  });
  const tree = directoryTree();
  for (const file of files) addToTree(tree, file);
  const root = buildDirectory(tree);
  const rootBlock = root.block;
  const rootCidBytes = root.cid;
  const header = dagCborHeader(rootCidBytes);
  const headerRecord = concat([varint(header.byteLength), header]);
  const rootRecord = carRecord(rootCidBytes, rootBlock);
  const directoryRecords = root.descendants.map(({ cid, block }) => carRecord(cid, block));
  const records: Uint8Array[] = [headerRecord, rootRecord, ...directoryRecords];
  let offset =
    headerRecord.byteLength +
    rootRecord.byteLength +
    directoryRecords.reduce((total, record) => total + record.byteLength, 0);
  const entries: PropertyCarEntry[] = [];
  for (const file of files.sort((left, right) =>
    Buffer.from(left.name).compare(Buffer.from(right.name)),
  )) {
    const record = carRecord(file.cid, file.block);
    entries.push(
      Object.freeze({
        propertyId: file.property.propertyId,
        path: file.property.path,
        sha256: file.property.sha256,
        byteLength: file.property.byteLength,
        fileCid: cidString(file.cid),
        blockRange: Object.freeze({ offset, length: record.byteLength }),
      }),
    );
    records.push(record);
    offset += record.byteLength;
  }
  const bytes = concat(records);
  entries.sort((left, right) => compareUtf8(left.propertyId, right.propertyId));
  return Object.freeze({
    shard,
    rootCid: cidString(rootCidBytes),
    sha256: sha256Hex(bytes),
    byteLength: bytes.byteLength,
    propertyCount: properties.length,
    bytes,
    entries: Object.freeze(entries),
  });
}

function propertyDigest(propertyId: string): string {
  return createHash('sha256').update(propertyId).digest('hex');
}

function assignShards(
  properties: readonly CanonicalPropertyJson[],
  initialPrefixLength: number,
  maximumPropertiesPerShard: number,
): ReadonlyMap<string, readonly CanonicalPropertyJson[]> {
  const output = new Map<string, readonly CanonicalPropertyJson[]>();
  const split = (prefix: string, values: readonly CanonicalPropertyJson[]): void => {
    if (values.length <= maximumPropertiesPerShard) {
      output.set(
        prefix,
        Object.freeze([...values].sort((a, b) => compareUtf8(a.propertyId, b.propertyId))),
      );
      return;
    }
    if (prefix.length >= 64) throw new RangeError('Unable to bound a property shard');
    const groups = new Map<string, CanonicalPropertyJson[]>();
    for (const value of values) {
      const next = propertyDigest(value.propertyId).slice(0, prefix.length + 1);
      const group = groups.get(next) ?? [];
      group.push(value);
      groups.set(next, group);
    }
    for (const [next, group] of [...groups.entries()].sort(([left], [right]) =>
      compareUtf8(left, right),
    )) {
      split(next, group);
    }
  };
  const initial = new Map<string, CanonicalPropertyJson[]>();
  for (const property of properties) {
    const prefix = propertyDigest(property.propertyId).slice(0, initialPrefixLength);
    const group = initial.get(prefix) ?? [];
    group.push(property);
    initial.set(prefix, group);
  }
  for (const [prefix, group] of [...initial.entries()].sort(([left], [right]) =>
    compareUtf8(left, right),
  )) {
    split(prefix, group);
  }
  return output;
}

function canonicalIndexBytes(index: PropertyRootIndex): Uint8Array {
  return Buffer.from(`${JSON.stringify(index)}\n`, 'utf8');
}

export function buildPropertyCarRelease(
  properties: readonly CanonicalPropertyJson[],
  options: Readonly<{
    initialPrefixLength?: number;
    maximumPropertiesPerShard: number;
    maximumShardBytes?: number;
  }>,
): PropertyCarRelease {
  const initialPrefixLength = options.initialPrefixLength ?? 2;
  if (
    !Number.isInteger(initialPrefixLength) ||
    initialPrefixLength < 1 ||
    initialPrefixLength > 16
  ) {
    throw new RangeError('initialPrefixLength must be an integer between 1 and 16');
  }
  if (
    !Number.isInteger(options.maximumPropertiesPerShard) ||
    options.maximumPropertiesPerShard < 1
  ) {
    throw new RangeError('maximumPropertiesPerShard must be a positive integer');
  }
  const maximumShardBytes = options.maximumShardBytes ?? 4 * 1024 * 1024 * 1024;
  if (!Number.isSafeInteger(maximumShardBytes) || maximumShardBytes < 1) {
    throw new RangeError('maximumShardBytes must be a positive safe integer');
  }
  const identifiers = properties.map(({ propertyId }) => propertyId);
  if (new Set(identifiers).size !== identifiers.length) {
    throw new TypeError('Property identifiers must be unique before CAR construction');
  }
  const assignments = assignShards(
    properties,
    initialPrefixLength,
    options.maximumPropertiesPerShard,
  );
  const shards = Object.freeze(
    [...assignments.entries()].map(([shard, values]) => buildShard(shard, values)),
  );
  const oversized = shards.find(({ byteLength }) => byteLength > maximumShardBytes);
  if (oversized !== undefined) {
    throw new RangeError(
      `CAR shard ${oversized.shard} exceeds maximumShardBytes: ${oversized.byteLength} > ${maximumShardBytes}`,
    );
  }
  const rootIndex: PropertyRootIndex = Object.freeze({
    schemaVersion: '1.0.0',
    unixFsProfile: Object.freeze({
      cidVersion: 1,
      codec: 'dag-pb',
      multihash: 'sha2-256',
      fileLayout: 'unixfs-inline-file-v1',
      carVersion: 1,
    }),
    eligiblePropertyCount: properties.length,
    shardCount: shards.length,
    maximumPropertiesPerShard: options.maximumPropertiesPerShard,
    maximumShardBytes,
    shards: Object.freeze(
      shards.map(({ shard, rootCid, sha256, byteLength, propertyCount }) =>
        Object.freeze({ shard, rootCid, sha256, byteLength, propertyCount }),
      ),
    ),
    properties: Object.freeze(
      shards
        .flatMap((car) =>
          car.entries.map((entry) =>
            Object.freeze({
              propertyId: entry.propertyId,
              path: entry.path,
              sha256: entry.sha256,
              byteLength: entry.byteLength,
              shard: car.shard,
              shardRootCid: car.rootCid,
              fileCid: entry.fileCid,
            }),
          ),
        )
        .sort((left, right) => compareUtf8(left.propertyId, right.propertyId)),
    ),
  });
  const rootIndexBytes = canonicalIndexBytes(rootIndex);
  return Object.freeze({
    shards,
    rootIndex,
    rootIndexBytes,
    rootIndexSha256: sha256Hex(rootIndexBytes),
  });
}

export function readCarRange(car: UnixFsCarShard, range: CarRange): Uint8Array {
  if (
    !Number.isSafeInteger(range.offset) ||
    !Number.isSafeInteger(range.length) ||
    range.offset < 0 ||
    range.length < 1 ||
    range.offset + range.length > car.bytes.byteLength
  ) {
    throw new RangeError('CAR byte range is outside the immutable shard');
  }
  return car.bytes.slice(range.offset, range.offset + range.length);
}
