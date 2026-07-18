/* GTFS column names are source data keys; bracket access keeps that boundary explicit. */
/* eslint-disable @typescript-eslint/dot-notation */
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, openSync, writeSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { parse } from 'csv-parse/sync';
import { parse as parseStream } from 'csv-parse';
import { Unzip, UnzipInflate, unzipSync } from 'fflate';

import type { RecoverableArtifactStore } from '@oracle/artifacts/artifact-store';
import type { ValidationIssue } from '@oracle/contracts/source';
import { createImmutableBytes } from '../../spi/bytes.js';
import type { AcquiredByteArtifact } from '../../spi/acquired-artifact.js';
import type { AcquiredArtifactSource } from '../../spi/acquired-artifact.js';
import type { ImmutableBytes } from '../../spi/bytes.js';
import { persistAcquiredBody } from '../../spi/acquisition.js';
import {
  ANALYTICAL_SNAPSHOT_MANIFEST_MEDIA_TYPE,
  encodeAnalyticalSnapshotManifest,
} from '../../spi/acquired-artifact.js';
import type { GtfsDecodedFeed, GtfsRow, ValidatedGtfsFeed } from './types.js';
import { GTFS_REQUIRED_MEMBERS } from './types.js';

const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_GTFS_MEMBER_BYTES = 64 * 1024 * 1024;
const MAX_GTFS_TOTAL_MEMBER_BYTES = 160 * 1024 * 1024;
const MAX_GTFS_ROWS = 1_000_000;
const MAX_GTFS_RECORD_BYTES = 1024 * 1024;
const MAX_STREAMING_VALIDATION_ISSUES = 1024;
const MAX_GTFS_ZIP_ENTRIES = 4096;
const MAX_GTFS_ZIP_ENTRY_NAME_BYTES = 1024;
const MAX_GTFS_ZIP_TOTAL_NAME_BYTES = 256 * 1024;

export class GtfsValidationIssueLimitError extends Error {
  public readonly code = 'GTFS_VALIDATION_ISSUE_LIMIT';

  public constructor(public readonly maximumIssues: number) {
    super(`GTFS validation issues exceed bounded limit ${maximumIssues}`);
    this.name = 'GtfsValidationIssueLimitError';
  }
}

export function gtfsDerivedManifestLogicalKey(sourceId: string, snapshotId: string): string {
  return `derived/gtfs/${sourceId}/${snapshotId}/manifest.json`;
}

function normalizeEntryPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`Unsafe GTFS ZIP member path: ${path}`);
  }
  return normalized;
}

export function parseGtfsCsv(bytes: Uint8Array, memberName: string): readonly GtfsRow[] {
  const text = decoder.decode(bytes).replace(/^\uFEFF/u, '');
  const records = parse<
    Record<string, unknown>,
    Readonly<{ raw: string; record: Record<string, unknown> }>
  >(text, {
    bom: true,
    columns: true,
    raw: true,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: false,
    on_record(parsed, context) {
      const parseError = context.error as Error | undefined;
      if (parseError === undefined) return parsed.record;
      if (/^\s*$/u.test(parsed.raw)) {
        return null;
      }
      throw parseError;
    },
  });

  return Object.freeze(
    records.map((record, index) => {
      const entries = Object.entries(record).map(([key, value]) => {
        if (typeof value !== 'string') {
          throw new TypeError(`${memberName} row ${index + 2} contains a non-string field`);
        }
        return [key.trim(), value] as const;
      });
      return Object.freeze(Object.fromEntries(entries));
    }),
  );
}

export function decodeGtfsZip(artifact: AcquiredByteArtifact): GtfsDecodedFeed {
  if (artifact.bytes.byteLength > 1024 * 1024) {
    throw new Error('Legacy GTFS whole-byte decode is limited to 1 MiB fixtures');
  }
  const entries = unzipSync(artifact.bytes.copy());
  const members: Record<string, readonly GtfsRow[]> = {};
  const seen = new Set<string>();

  for (const [rawPath, entryBytes] of Object.entries(entries)) {
    const path = normalizeEntryPath(rawPath);
    if (path.endsWith('/') || path.startsWith('__MACOSX/')) {
      continue;
    }
    const basename = path.split('/').at(-1)?.toLowerCase();
    if (!basename?.endsWith('.txt')) {
      continue;
    }
    if (seen.has(basename)) {
      throw new Error(`Duplicate GTFS ZIP member: ${basename}`);
    }
    seen.add(basename);
    members[basename] = parseGtfsCsv(entryBytes, basename);
  }

  return Object.freeze({
    artifactId: artifact.metadata.artifactId,
    ordinal: 0,
    visibility: artifact.metadata.visibility,
    format: 'zip',
    entryPath: '/',
    mediaType: 'application/zip',
    bytes: createImmutableBytes(artifact.bytes.copy()),
    members: Object.freeze(members),
    memberNames: Object.freeze([...seen].sort()),
  });
}

async function* fileBody(path: string, signal: AbortSignal): AsyncIterable<Uint8Array> {
  const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of stream) {
      signal.throwIfAborted();
      yield chunk;
    }
  } finally {
    stream.destroy();
  }
}

async function* parseGtfsCsvFile(
  path: string,
  memberName: string,
  signal: AbortSignal,
): AsyncIterable<GtfsRow> {
  const input = createReadStream(path, { highWaterMark: 64 * 1024 });
  const parser = input.pipe(
    parseStream({
      bom: true,
      columns: true,
      raw: true,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: false,
      max_record_size: MAX_GTFS_RECORD_BYTES,
      on_record(parsed: Readonly<{ raw: string; record: Record<string, unknown> }>, context) {
        const parseError = context.error as Error | undefined;
        if (parseError === undefined) return parsed.record;
        if (/^\s*$/u.test(parsed.raw)) return null;
        throw parseError;
      },
    }),
  );
  try {
    let rowNumber = 2;
    for await (const untyped of parser) {
      signal.throwIfAborted();
      const record = untyped as Record<string, unknown>;
      const entries = Object.entries(record).map(([key, value]) => {
        if (typeof value !== 'string') {
          throw new TypeError(`${memberName} row ${rowNumber} contains a non-string field`);
        }
        return [key.trim(), value] as const;
      });
      rowNumber += 1;
      yield Object.freeze(Object.fromEntries(entries));
    }
  } finally {
    input.destroy();
    parser.destroy();
  }
}

async function writeUniqueKey(directory: string, key: string): Promise<'written' | 'duplicate'> {
  const hash = createHash('sha256').update(key).digest('hex');
  const path = join(directory, hash.slice(0, 2), hash.slice(2));
  await mkdir(join(directory, hash.slice(0, 2)), { recursive: true });
  try {
    const marker = await open(path, 'wx');
    try {
      await marker.writeFile(key, 'utf8');
    } finally {
      await marker.close();
    }
    return 'written';
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      const existing = await readFile(path, 'utf8');
      if (existing === key) return 'duplicate';
      throw new Error('GTFS duplicate-key SHA-256 collision', { cause: error });
    }
    throw error;
  }
}

async function keyExists(directory: string, key: string): Promise<boolean> {
  const hash = createHash('sha256').update(key).digest('hex');
  try {
    return (await readFile(join(directory, hash.slice(0, 2), hash.slice(2)), 'utf8')) === key;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function validateStreamingMembers(
  paths: ReadonlyMap<string, string>,
  workspace: string,
  expectedAgencyId: string,
  signal: AbortSignal,
): Promise<readonly ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const addIssue = (issue: ValidationIssue): void => {
    if (issues.length >= MAX_STREAMING_VALIDATION_ISSUES) {
      throw new GtfsValidationIssueLimitError(MAX_STREAMING_VALIDATION_ISSUES);
    }
    issues.push(issue);
  };
  for (const member of GTFS_REQUIRED_MEMBERS) {
    if (!paths.has(member)) {
      addIssue({
        code: 'gtfs.missing_member',
        severity: 'fatal',
        message: `GTFS archive is missing ${member}`,
        recordKey: null,
        fieldPath: member,
      });
    }
  }
  if (!paths.has('calendar.txt') && !paths.has('calendar_dates.txt')) {
    addIssue({
      code: 'gtfs.missing_service_calendar',
      severity: 'fatal',
      message: 'GTFS archive must include calendar.txt, calendar_dates.txt, or both',
      recordKey: null,
      fieldPath: 'calendar.txt|calendar_dates.txt',
    });
  }
  if (issues.some((issue) => issue.severity !== 'warning')) return Object.freeze(issues);

  const keySpecifications: Readonly<Record<string, readonly string[]>> = Object.freeze({
    'agency.txt': ['agency_id'],
    'stops.txt': ['stop_id'],
    'routes.txt': ['route_id'],
    'trips.txt': ['trip_id'],
    'calendar.txt': ['service_id'],
    'calendar_dates.txt': ['service_id', 'date'],
    'stop_times.txt': ['trip_id', 'stop_sequence'],
    'transfers.txt': [
      'from_stop_id',
      'to_stop_id',
      'from_route_id',
      'to_route_id',
      'from_trip_id',
      'to_trip_id',
    ],
  });
  let totalRows = 0;
  let agencyFound = false;
  for (const memberName of [...paths.keys()].sort()) {
    const path = paths.get(memberName);
    const keys = keySpecifications[memberName];
    if (path === undefined || keys === undefined) continue;
    const keyDirectory = join(workspace, 'keys', memberName);
    for await (const row of parseGtfsCsvFile(path, memberName, signal)) {
      totalRows += 1;
      if (totalRows > MAX_GTFS_ROWS) throw new Error(`GTFS row count exceeds ${MAX_GTFS_ROWS}`);
      if (memberName === 'agency.txt' && (row['agency_id'] ?? '') === expectedAgencyId) {
        agencyFound = true;
      }
      const key = keys.map((field) => row[field] ?? '').join('\u0000');
      const printable = key.replaceAll('\u0000', '|');
      if (key.replaceAll('\u0000', '').length === 0) {
        addIssue({
          code: 'gtfs.missing_primary_key',
          severity: 'error',
          message: `${memberName} contains a row without ${keys.join(', ')}`,
          recordKey: null,
          fieldPath: keys.join(','),
        });
      } else if ((await writeUniqueKey(keyDirectory, key)) === 'duplicate') {
        addIssue({
          code: 'gtfs.duplicate_id',
          severity: 'error',
          message: `${memberName} contains duplicate key ${printable}`,
          recordKey: printable,
          fieldPath: keys.join(','),
        });
      }
    }
  }
  if (!agencyFound) {
    addIssue({
      code: 'gtfs.agency_identity_mismatch',
      severity: 'fatal',
      message: `Expected agency ${expectedAgencyId} is absent`,
      recordKey: expectedAgencyId,
      fieldPath: 'agency_id',
    });
  }
  const stopsPath = paths.get('stops.txt');
  if (stopsPath !== undefined) {
    const stopKeys = join(workspace, 'keys', 'stops.txt');
    for await (const stop of parseGtfsCsvFile(stopsPath, 'stops.txt', signal)) {
      const parent = stop['parent_station'];
      if (parent !== undefined && parent !== '' && !(await keyExists(stopKeys, parent))) {
        addIssue({
          code: 'gtfs.orphan_parent_station',
          severity: 'warning',
          message: `Stop ${stop['stop_id'] ?? '<unknown>'} references missing parent ${parent}`,
          recordKey: stop['stop_id'] ?? null,
          fieldPath: 'parent_station',
        });
      }
    }
  }
  return Object.freeze(issues);
}

/** Streams ZIP bytes to a confined workspace, validates rows, then persists immutable members. */
export async function decodeGtfsZipStream(
  artifact: AcquiredArtifactSource,
  chunks: AsyncIterable<Uint8Array>,
  artifactStore: RecoverableArtifactStore,
  expectedAgencyId: string,
  signal: AbortSignal,
): Promise<GtfsDecodedFeed> {
  const workspace = await mkdtemp(join(tmpdir(), 'oracle-gtfs-'));
  const retained = new Map<string, string>();
  const retainedHashes = new Map<string, string>();
  const seen = new Set<string>();
  let retainedBytes = 0;
  let entryCount = 0;
  let entryNameBytes = 0;
  let streamError: Error | undefined;
  const openDescriptors = new Set<number>();
  try {
    const unzip = new Unzip((file) => {
      entryCount += 1;
      const nameBytes = new TextEncoder().encode(file.name).byteLength;
      entryNameBytes += nameBytes;
      if (
        entryCount > MAX_GTFS_ZIP_ENTRIES ||
        nameBytes > MAX_GTFS_ZIP_ENTRY_NAME_BYTES ||
        entryNameBytes > MAX_GTFS_ZIP_TOTAL_NAME_BYTES
      ) {
        streamError = new Error('GTFS ZIP metadata exceeds its reviewed entry/name bounds');
        file.terminate();
        return;
      }
      const path = normalizeEntryPath(file.name);
      const basename = path.split('/').at(-1)?.toLowerCase();
      if (basename === undefined || !basename.endsWith('.txt') || path.startsWith('__MACOSX/'))
        return;
      if (seen.has(basename)) {
        streamError = new Error(`Duplicate GTFS ZIP member: ${basename}`);
        file.terminate();
        return;
      }
      seen.add(basename);
      if (file.originalSize !== undefined && file.originalSize > MAX_GTFS_MEMBER_BYTES) {
        streamError = new Error(
          `GTFS ZIP member ${basename} exceeds ${MAX_GTFS_MEMBER_BYTES} bytes`,
        );
        file.terminate();
        return;
      }
      const outputPath = resolve(workspace, basename);
      if (
        !outputPath.startsWith(`${resolve(workspace)}\\`) &&
        !outputPath.startsWith(`${resolve(workspace)}/`)
      ) {
        streamError = new Error(`GTFS spool path escaped workspace: ${basename}`);
        file.terminate();
        return;
      }
      const descriptor = openSync(outputPath, 'wx');
      openDescriptors.add(descriptor);
      const memberHash = createHash('sha256');
      let length = 0;
      file.ondata = (error, chunk, final) => {
        if (error !== null) {
          streamError = error;
          return;
        }
        if (length + chunk.byteLength > MAX_GTFS_MEMBER_BYTES) {
          streamError = new Error(
            `GTFS ZIP member ${basename} exceeds ${MAX_GTFS_MEMBER_BYTES} bytes`,
          );
          file.terminate();
          return;
        }
        writeSync(descriptor, chunk);
        memberHash.update(chunk);
        length += chunk.byteLength;
        if (final) {
          retainedBytes += length;
          if (retainedBytes > MAX_GTFS_TOTAL_MEMBER_BYTES) {
            streamError = new Error(
              `GTFS ZIP retained members exceed ${MAX_GTFS_TOTAL_MEMBER_BYTES} bytes`,
            );
            return;
          }
          closeSync(descriptor);
          openDescriptors.delete(descriptor);
          retained.set(basename, outputPath);
          retainedHashes.set(basename, memberHash.digest('hex'));
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    let previous: Uint8Array | undefined;
    for await (const chunk of chunks) {
      signal.throwIfAborted();
      if (streamError !== undefined) throw streamError;
      if (previous !== undefined) unzip.push(previous, false);
      previous = chunk;
    }
    unzip.push(previous ?? new Uint8Array(), true);
    if (streamError !== undefined) {
      throw streamError;
    }
    const validationIssues = await validateStreamingMembers(
      retained,
      workspace,
      expectedAgencyId,
      signal,
    );
    const persistedMembers: Record<
      string,
      {
        name: string;
        uri: string;
        byteSize: number;
        sha256: string;
      }
    > = {};
    for (const name of [...retained.keys()].sort()) {
      const path = retained.get(name);
      if (path === undefined) throw new Error(`GTFS retained member disappeared: ${name}`);
      const size = (await stat(path)).size;
      const expectedSha256 = retainedHashes.get(name);
      if (expectedSha256 === undefined) throw new Error(`GTFS retained hash disappeared: ${name}`);
      const logicalKey = `derived/gtfs/${artifact.metadata.sourceId}/${artifact.metadata.snapshotId}/${name}`;
      const orphan = await artifactStore.headByLogicalKey(logicalKey);
      const stored =
        orphan ??
        (await persistAcquiredBody({
          store: artifactStore,
          logicalKey,
          mediaType: 'text/csv',
          body: fileBody(path, signal),
          maximumBytes: Math.max(1, size),
          expectedSha256,
          metadata: Object.freeze({
            sourceId: artifact.metadata.sourceId,
            snapshotId: artifact.metadata.snapshotId,
            parentArtifactId: artifact.metadata.artifactId,
            memberName: name,
          }),
          signal,
        }));
      if (
        stored.mediaType !== 'text/csv' ||
        stored.byteSize !== size ||
        stored.sha256 !== expectedSha256 ||
        stored.metadata.parentArtifactId !== artifact.metadata.artifactId ||
        stored.metadata.memberName !== name
      ) {
        throw new Error(`GTFS derived member orphan mismatch: ${logicalKey}`);
      }
      persistedMembers[name] = Object.freeze({
        name,
        uri: stored.uri,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
      });
    }
    const memberNames = Object.freeze(Object.keys(persistedMembers).sort());
    const manifestValue = Object.freeze({
      formatVersion: '1.0.0' as const,
      dataArtifacts: Object.freeze(
        memberNames.map((name) => {
          const member = persistedMembers[name];
          if (member === undefined) throw new Error(`Missing persisted GTFS member ${name}`);
          return Object.freeze({
            uri: member.uri,
            byteLength: member.byteSize,
            sha256: member.sha256,
          });
        }),
      ),
      scanBytesByOperation: Object.freeze({
        decode_gtfs_bounded_finalize: Object.values(persistedMembers).reduce(
          (total, member) => total + member.byteSize,
          0,
        ),
      }),
    });
    const manifestBytes = encodeAnalyticalSnapshotManifest(manifestValue);
    const manifestLogicalKey = gtfsDerivedManifestLogicalKey(
      artifact.metadata.sourceId,
      artifact.metadata.snapshotId,
    );
    const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
    const manifestOrphan = await artifactStore.headByLogicalKey(manifestLogicalKey);
    const manifestStored =
      manifestOrphan ??
      (await persistAcquiredBody({
        store: artifactStore,
        logicalKey: manifestLogicalKey,
        mediaType: ANALYTICAL_SNAPSHOT_MANIFEST_MEDIA_TYPE,
        body: (async function* () {
          await Promise.resolve();
          yield manifestBytes;
        })(),
        maximumBytes: 1024 * 1024,
        expectedSha256: manifestSha256,
        metadata: Object.freeze({
          sourceId: artifact.metadata.sourceId,
          snapshotId: artifact.metadata.snapshotId,
          parentArtifactId: artifact.metadata.artifactId,
          formatVersion: '1.0.0',
        }),
        signal,
      }));
    if (
      manifestStored.mediaType !== ANALYTICAL_SNAPSHOT_MANIFEST_MEDIA_TYPE ||
      manifestStored.byteSize !== manifestBytes.byteLength ||
      manifestStored.sha256 !== manifestSha256 ||
      manifestStored.metadata.parentArtifactId !== artifact.metadata.artifactId ||
      manifestStored.metadata.formatVersion !== '1.0.0'
    ) {
      throw new Error(`GTFS derived manifest orphan mismatch: ${manifestLogicalKey}`);
    }
    const unavailableBytes: ImmutableBytes = Object.freeze({
      byteLength: artifact.metadata.byteSize,
      sha256: artifact.metadata.sha256,
      copy: () => {
        throw new Error('Streaming GTFS artifacts do not expose whole-byte copy()');
      },
    });
    return Object.freeze({
      artifactId: artifact.metadata.artifactId,
      ordinal: 0,
      visibility: artifact.metadata.visibility,
      format: 'zip',
      entryPath: '/',
      mediaType: 'application/zip',
      bytes: unavailableBytes,
      members: Object.freeze({}),
      memberNames,
      streamingManifest: Object.freeze({
        formatVersion: '1.0.0',
        uri: manifestStored.uri,
        sha256: manifestStored.sha256,
        byteSize: manifestStored.byteSize,
        totalMemberBytes: Object.values(persistedMembers).reduce(
          (total, member) => total + member.byteSize,
          0,
        ),
        members: Object.freeze(persistedMembers),
      }),
      streamingValidationIssues: validationIssues,
    });
  } finally {
    for (const descriptor of openDescriptors) closeSync(descriptor);
    await rm(workspace, { recursive: true, force: true });
  }
}

function duplicateIssues(rows: readonly GtfsRow[], keys: readonly string[], table: string) {
  const seen = new Set<string>();
  const issues: ValidationIssue[] = [];
  for (const row of rows) {
    const key = keys.map((field) => row[field] ?? '').join('\u0000');
    if (key.replaceAll('\u0000', '').length === 0) {
      issues.push({
        code: 'gtfs.missing_primary_key',
        severity: 'error',
        message: `${table} contains a row without ${keys.join(', ')}`,
        recordKey: null,
        fieldPath: keys.join(','),
      });
    } else if (seen.has(key)) {
      issues.push({
        code: 'gtfs.duplicate_id',
        severity: 'error',
        message: `${table} contains duplicate key ${key.replaceAll('\u0000', '|')}`,
        recordKey: key.replaceAll('\u0000', '|'),
        fieldPath: keys.join(','),
      });
    }
    seen.add(key);
  }
  return issues;
}

export function validateGtfsFeed(feed: GtfsDecodedFeed): Readonly<{
  validated?: ValidatedGtfsFeed;
  issues: readonly ValidationIssue[];
}> {
  const issues: ValidationIssue[] = [];
  for (const member of GTFS_REQUIRED_MEMBERS) {
    if (feed.members[member] === undefined) {
      issues.push({
        code: 'gtfs.missing_member',
        severity: 'fatal',
        message: `GTFS archive is missing ${member}`,
        recordKey: null,
        fieldPath: member,
      });
    }
  }
  if (
    feed.members['calendar.txt'] === undefined &&
    feed.members['calendar_dates.txt'] === undefined
  ) {
    issues.push({
      code: 'gtfs.missing_service_calendar',
      severity: 'fatal',
      message: 'GTFS archive must include calendar.txt, calendar_dates.txt, or both',
      recordKey: null,
      fieldPath: 'calendar.txt|calendar_dates.txt',
    });
  }
  if (issues.length > 0) {
    return Object.freeze({ issues: Object.freeze(issues) });
  }

  const agency = feed.members['agency.txt'] ?? [];
  const stops = feed.members['stops.txt'] ?? [];
  const routes = feed.members['routes.txt'] ?? [];
  const trips = feed.members['trips.txt'] ?? [];
  const calendars = feed.members['calendar.txt'] ?? [];
  const calendarDates = feed.members['calendar_dates.txt'] ?? [];
  const stopTimes = feed.members['stop_times.txt'] ?? [];
  const transfers = feed.members['transfers.txt'] ?? [];

  issues.push(
    ...duplicateIssues(agency, ['agency_id'], 'agency.txt'),
    ...duplicateIssues(stops, ['stop_id'], 'stops.txt'),
    ...duplicateIssues(routes, ['route_id'], 'routes.txt'),
    ...duplicateIssues(trips, ['trip_id'], 'trips.txt'),
    ...duplicateIssues(calendars, ['service_id'], 'calendar.txt'),
    ...duplicateIssues(calendarDates, ['service_id', 'date'], 'calendar_dates.txt'),
    ...duplicateIssues(stopTimes, ['trip_id', 'stop_sequence'], 'stop_times.txt'),
    ...duplicateIssues(
      transfers,
      ['from_stop_id', 'to_stop_id', 'from_route_id', 'to_route_id', 'from_trip_id', 'to_trip_id'],
      'transfers.txt',
    ),
  );

  const stopIds = new Set(stops.map((row) => row['stop_id'] ?? ''));
  for (const stop of stops) {
    const parent = stop['parent_station'];
    if (parent !== undefined && parent !== '' && !stopIds.has(parent)) {
      issues.push({
        code: 'gtfs.orphan_parent_station',
        severity: 'warning',
        message: `Stop ${stop['stop_id'] ?? '<unknown>'} references missing parent ${parent}`,
        recordKey: stop['stop_id'] ?? null,
        fieldPath: 'parent_station',
      });
    }
  }

  if (issues.some((issue) => issue.severity !== 'warning')) {
    return Object.freeze({ issues: Object.freeze(issues) });
  }

  return Object.freeze({
    issues: Object.freeze(issues),
    validated: Object.freeze({
      ...feed,
      agency,
      stops,
      routes,
      trips,
      calendars,
      calendarDates,
      stopTimes,
      transfers,
    }),
  });
}
