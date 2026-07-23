import type { SourceId } from '@oracle/contracts/ids';
import type {
  LicenseSnapshot,
  RatePolicy,
  SourceAsOf,
  ValidationIssue,
} from '@oracle/contracts/source';
import type { Visibility } from '@oracle/contracts/visibility';
import type { ZipDecodedRecord } from '../../spi/decode.js';

export const GTFS_REQUIRED_MEMBERS = Object.freeze([
  'agency.txt',
  'stops.txt',
  'routes.txt',
  'trips.txt',
  'stop_times.txt',
] as const);

export type TransitOperator = 'vta' | 'caltrain';
export type TransitFeedRole = 'operator_primary' | '511_fallback';

export interface TransitFeedSnapshotConfig {
  readonly operator: TransitOperator;
  readonly role: TransitFeedRole;
  readonly sourceId: SourceId;
  readonly sourceName: string;
  readonly agencyId: string;
  readonly agencyName: string;
  readonly url: string;
  readonly expectedZipSha256: string;
  readonly expectedZipBytes: number | null;
  readonly retrievedAt: string;
  readonly sourceAsOf: SourceAsOf;
  readonly feedStartDate: string;
  readonly feedEndDate: string;
  readonly selectedServiceDate: string;
  readonly visibility: Visibility;
  readonly license: LicenseSnapshot;
  readonly ratePolicy: RatePolicy;
  /** 511 authentication is added by the injected transport; it never enters persisted metadata. */
  readonly requiresInjectedAuthorization: boolean;
}

export type GtfsRow = Readonly<Record<string, string>>;

export interface StreamingGtfsMember {
  readonly name: string;
  readonly uri: string;
  readonly byteSize: number;
  readonly sha256: string;
}

export interface StreamingGtfsManifest {
  readonly formatVersion: '1.0.0';
  readonly uri: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly totalMemberBytes: number;
  readonly members: Readonly<Record<string, StreamingGtfsMember>>;
}

export interface GtfsDecodedFeed extends ZipDecodedRecord {
  readonly entryPath: '/';
  readonly mediaType: 'application/zip';
  readonly members: Readonly<Record<string, readonly GtfsRow[]>>;
  readonly memberNames: readonly string[];
  /** Present only for v2 production streams; legacy fixture feeds retain in-memory members. */
  readonly streamingManifest?: StreamingGtfsManifest;
  readonly streamingValidationIssues?: readonly ValidationIssue[];
}

export interface ValidatedGtfsFeed extends GtfsDecodedFeed {
  readonly agency: readonly GtfsRow[];
  readonly stops: readonly GtfsRow[];
  readonly routes: readonly GtfsRow[];
  readonly trips: readonly GtfsRow[];
  readonly calendars: readonly GtfsRow[];
  readonly calendarDates: readonly GtfsRow[];
  readonly stopTimes: readonly GtfsRow[];
  readonly transfers: readonly GtfsRow[];
}

export interface NormalizedTransitStop {
  readonly stopId: string;
  readonly stopCode: string;
  readonly name: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly locationType: number;
  readonly parentStation: string | null;
  readonly platformCode: string | null;
  readonly boardable: boolean;
  readonly pickupAllowedOnSelectedDate: boolean;
  readonly dropOffAllowedOnSelectedDate: boolean;
  readonly activeOnSelectedDate: boolean;
  readonly routeIds: readonly string[];
  readonly serviceIds: readonly string[];
  readonly exclusionReasons: readonly string[];
}

export interface NormalizedTransitSnapshot {
  readonly operator: TransitOperator;
  readonly role: TransitFeedRole;
  readonly sourceId: SourceId;
  readonly artifactId: string;
  readonly agencyId: string;
  readonly agencyName: string;
  readonly selectedServiceDate: string;
  readonly activeServiceIds: readonly string[];
  readonly stops: readonly NormalizedTransitStop[];
  readonly eligibleDestinations: readonly NormalizedTransitStop[];
  readonly excludedDestinations: readonly NormalizedTransitStop[];
  readonly routes: readonly GtfsRow[];
  readonly trips: readonly GtfsRow[];
  readonly calendars: readonly GtfsRow[];
  readonly calendarDates: readonly GtfsRow[];
  readonly transfers: readonly GtfsRow[];
}

export interface TransitSnapshotDiscrepancy {
  readonly entityKind: 'agency' | 'stop' | 'route' | 'trip' | 'calendar' | 'transfer';
  readonly entityId: string;
  readonly field: string;
  readonly operatorValue: string | number | boolean | null;
  readonly fallbackValue: string | number | boolean | null;
}

export interface TransitFeedSelection {
  readonly selected: NormalizedTransitSnapshot;
  readonly selectedRole: TransitFeedRole;
  readonly operatorSnapshot: NormalizedTransitSnapshot | null;
  readonly fallbackSnapshot: NormalizedTransitSnapshot | null;
  readonly discrepancies: readonly TransitSnapshotDiscrepancy[];
  readonly limitations: readonly string[];
}

export interface TransitFeedFamilyConfig {
  readonly vta: TransitFeedSnapshotConfig;
  readonly caltrain: TransitFeedSnapshotConfig;
  readonly fallback511?: Readonly<Partial<Record<TransitOperator, TransitFeedSnapshotConfig>>>;
}
