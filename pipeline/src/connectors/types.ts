/**
 * Core connector abstraction for the Oracle ingestion pipeline.
 *
 * Every data source (assessor parcels, building permits, ownership, business
 * registrations, contractor reputation, OSM points-of-interest) is ingested
 * through a `Connector`. A connector's job is narrow: page through one source
 * and yield `RawRecord`s that preserve the source's original fields plus
 * provenance. Normalization into typed tables happens later, in SQL transforms,
 * so the raw capture stays faithful to the source (a hard-gate requirement:
 * source-backed answers with provenance).
 *
 * Adding a new source = implementing this interface. That is the "modular
 * connector architecture" the assignment asks us to demonstrate.
 */

/** The entity kinds the pipeline knows how to load. */
export type EntityType =
  | "property" // assessor parcel / property record
  | "permit" // building / roofing permit
  | "ownership" // owner + owner mailing address
  | "business" // business registration
  | "contractor" // contractor / license / reputation
  | "poi"; // point of interest (transit stop, Starbucks, water body)

/** Where a record came from — carried end-to-end for source-backed answers. */
export interface SourceProvenance {
  /** Human-readable source name, e.g. "City of Palo Alto Building Permits". */
  source: string;
  /** The exact endpoint URL this record (or its page) was fetched from. */
  sourceUrl: string;
  /** ISO-8601 timestamp of when the record was fetched. */
  fetchedAt: string;
  /** Optional license / terms note for the dataset. */
  license?: string;
}

/**
 * One record as pulled from a source, before typed normalization.
 * `data` keeps the source's raw fields verbatim so nothing is lost.
 */
export interface RawRecord {
  entity: EntityType;
  /** Natural key from the source (APN, permit number, OSM id, ...). */
  sourceId: string;
  /** Raw source fields, unmodified. */
  data: Record<string, unknown>;
  provenance: SourceProvenance;
}

/** Options a connector may honor to bound a run (pilot vs. full). */
export interface FetchOptions {
  /** Hard cap on records yielded; undefined = all available. */
  limit?: number;
  /** Bounding box [south, west, north, east] for geo sources. */
  bbox?: [number, number, number, number];
  /** Skip the on-disk cache and re-fetch from the network. */
  noCache?: boolean;
}

/** Summary a connector returns after a run, for the pipeline run report. */
export interface FetchStats {
  connector: string;
  source: string;
  entity: EntityType;
  count: number;
  sourceUrl: string;
  startedAt: string;
  finishedAt: string;
  /** Non-fatal notes: rate-limit backoffs, truncation, source constraints. */
  notes: string[];
}

/**
 * A source connector. Implementations page through one API and yield
 * `RawRecord`s. Keep them dumb: no cross-source joins, no dedup — that is the
 * loader/transform layer's job.
 */
export interface Connector {
  /** Stable machine name, e.g. "palo-alto-permits". */
  readonly name: string;
  /** The entity kind this connector produces. */
  readonly entity: EntityType;
  /** Human-readable source name, mirrored into provenance. */
  readonly source: string;

  /** Stream raw records, paging internally. */
  fetch(opts?: FetchOptions): AsyncGenerator<RawRecord, void, unknown>;
}
