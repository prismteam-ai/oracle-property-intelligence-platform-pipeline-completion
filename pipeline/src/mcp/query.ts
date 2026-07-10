/**
 * Shared read-only query core over the `properties` Parquet.
 *
 * Backs both the MCP server (src/mcp/server.ts) and the UI's agent route. Opens
 * an in-memory DuckDB, exposes a view named `properties` sourced from either the
 * published IPFS Parquet (PROPERTY_QUERY_TABLE_MAP) or the local export, and runs
 * a single validated read-only SELECT with a hard row cap.
 *
 * Mirrors the elephant-mcp contract: view is always `properties`, SELECT/CTE
 * only, default cap 100 / max 1000.
 */

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { fileURLToPath } from "node:url";

export const COUNTY = "santa-clara";
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;

const LOCAL_PARQUET = fileURLToPath(
  new URL("../../data/export/properties.parquet", import.meta.url),
);

/** One-line descriptions for getPropertyQuerySchema. */
export const COLUMN_DOCS: Record<string, string> = {
  request_identifier: "Normalized 8-digit APN; one row per property (dedup key).",
  parcel_identifier: "Raw parcel APN as published by the county.",
  county: "County slug (santa-clara).",
  address_house_number: "Situs street number.",
  address_street: "Situs street name + type.",
  address_city: "Situs city (e.g. PALO ALTO).",
  address_zip: "Situs ZIP.",
  latitude: "Parcel centroid latitude (WGS84).",
  longitude: "Parcel centroid longitude (WGS84).",
  last_roof_permit_date: "Most recent roofing-permit date, or NULL if none on record.",
  roof_permit_count: "Number of roofing permits on record (2013-present).",
  years_since_roof_permit: "Years since last roofing permit (NULL if none).",
  roof_over_15: "TRUE = no roofing permit in the last 15 years (roof likely >15yr).",
  roof_basis: "How roof_over_15 was decided (reroofed_within_15yr | reroofed_over_15yr_ago | no_roofing_permit_on_record).",
  permit_count: "Total permits on record for the parcel (2013-present).",
  last_permit_date: "Most recent permit date of any type, or NULL.",
  permit_dormant_10yr: "Q4 PROXY (not sale data): TRUE = no permit activity in 10 years.",
  owners_text: "Owner name(s) — NULL: not in free open data for CA (see owner_data_available).",
  owner_data_available: "FALSE for all rows: owner/mailing data requires paid assessor data.",
  nearest_transit_m: "Meters from centroid to nearest OSM transit stop.",
  near_transit: "TRUE if within 800 m (~10-min walk) of transit.",
  nearest_starbucks_m: "Meters to nearest Starbucks (OSM).",
  near_starbucks: "TRUE if within 800 m of a Starbucks.",
  nearest_water_m: "Meters to nearest OSM water body.",
  water_view: "Heuristic: TRUE if within 150 m of water (proximity, not verified sightline).",
  sources: "JSON array of contributing sources + source URLs (provenance).",
};

/** Resolve the Parquet source: published IPFS URL if configured, else local file. */
export function resolveSource(): { source: string; remote: boolean } {
  const map = process.env.PROPERTY_QUERY_TABLE_MAP;
  if (map) {
    try {
      const url = (JSON.parse(map) as Record<string, string>)[COUNTY];
      if (url) return { source: url, remote: /^https?:\/\//.test(url) };
    } catch {
      /* fall through to local */
    }
  }
  return { source: LOCAL_PARQUET, remote: false };
}

export interface PropertiesDb {
  conn: DuckDBConnection;
  source: string;
  getSchema(): Promise<Array<{ column: string; type: string; description: string }>>;
  query(sql: string, limit?: number): Promise<Record<string, unknown>[]>;
  info(): Promise<{ county: string; propertyCount: number; source: string }>;
  close(): Promise<void>;
}

export async function openPropertiesDb(): Promise<PropertiesDb> {
  const { source, remote } = resolveSource();
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  if (remote) {
    await conn.run("INSTALL httpfs;");
    await conn.run("LOAD httpfs;");
  }
  const escaped = source.replace(/'/g, "''");
  await conn.run(
    `CREATE VIEW properties AS SELECT * FROM read_parquet('${escaped}');`,
  );

  return {
    conn,
    source,
    async getSchema() {
      const r = await conn.runAndReadAll("DESCRIBE properties");
      return r.getRowObjects().map((o) => ({
        column: String(o.column_name),
        type: String(o.column_type),
        description: COLUMN_DOCS[String(o.column_name)] ?? "",
      }));
    },
    async query(sql, limit = DEFAULT_LIMIT) {
      const clean = validateSelect(sql);
      const cap = Math.min(Math.max(1, limit || DEFAULT_LIMIT), MAX_LIMIT);
      const wrapped = `SELECT * FROM (${clean}) AS _q LIMIT ${cap}`;
      const r = await conn.runAndReadAll(wrapped);
      return r.getRowObjects().map(normalizeRow);
    },
    async info() {
      const r = await conn.runAndReadAll("SELECT count(*) n FROM properties");
      return {
        county: COUNTY,
        propertyCount: Number(r.getRowObjects()[0]!.n),
        source,
      };
    },
    async close() {
      await conn.disconnectSync?.();
    },
  };
}

/** BigInt -> number for JSON transport. */
function normalizeRow(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = typeof v === "bigint" ? Number(v) : v;
  return out;
}

const FORBIDDEN = /\b(insert|update|delete|drop|create|alter|attach|copy|pragma|call|export|install|load|set|grant|revoke|truncate|replace)\b/i;

/** Enforce a single read-only SELECT/CTE statement. Throws on anything else. */
export function validateSelect(sql: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!trimmed) throw new Error("Empty query.");
  if (trimmed.includes(";")) {
    throw new Error("Only a single statement is allowed (no ';').");
  }
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new Error("Only SELECT / WITH queries are allowed.");
  }
  if (FORBIDDEN.test(trimmed)) {
    throw new Error("Query contains a disallowed keyword; read-only SELECT only.");
  }
  return trimmed;
}
