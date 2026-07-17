/* GTFS column names are source data keys; bracket access keeps that boundary explicit. */
/* eslint-disable @typescript-eslint/dot-notation */
import { parse } from 'csv-parse/sync';
import { unzipSync } from 'fflate';

import type { ValidationIssue } from '@oracle/contracts/source';
import { createImmutableBytes } from '../../spi/bytes.js';
import type { AcquiredByteArtifact } from '../../spi/acquired-artifact.js';
import type { GtfsDecodedFeed, GtfsRow, ValidatedGtfsFeed } from './types.js';
import { GTFS_REQUIRED_MEMBERS } from './types.js';

const decoder = new TextDecoder('utf-8', { fatal: true });

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
