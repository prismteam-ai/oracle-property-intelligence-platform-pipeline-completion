/**
 * Composable Search query layer.
 *
 * Search is one filter panel that AND-composes any number of optional filters
 * into a SINGLE DuckDB query. Every filter operates on a per-parcel base
 * (one row per parcel_identifier) so counts are always distinct-parcel and
 * filters never fight each other's row multiplicity.
 *
 * Correctness contract (verified against data/raw/lee-query-table.parquet):
 * with exactly one dimension filter active, the COUNT produced here equals the
 * standalone demo-question SQL in demoQuestions.ts for the same question:
 *   roof (N=15) = 198,582 · tenure (N=10) = 138,206 ·
 *   transit (N=800) = 4,095 · starbucks (N=800) = 3,696.
 * The parity relies on aggregating the MATCH itself (bool_or / min-distance),
 * not on a representative row — an any_value() representative loses parcels
 * whose duplicate rows disagree.
 *
 * Portfolio ("regional owners") is the one dimension whose headline is
 * intentionally a property count, not the demo card's owner count: a property
 * search returns properties, so it counts distinct parcels held by owners with
 * >= N parcels. See NOTE on the portfolio clause below.
 */
import { TABLE } from './config';
import { sqlString } from './lib/duckdb';
import {
  DEMO_QUESTIONS,
  DemoQuestion,
  Poi,
  STARBUCKS_POIS,
  TRANSIT_POIS,
} from './demoQuestions';

// ---------- filter state (lifted in App.tsx, controlled by Search) ----------

/** One adjustable dimension filter: an on/off toggle plus its parameter N. */
export interface DimFilter {
  on: boolean;
  n: number;
}

export interface SearchFilters {
  // Plain real-column filters.
  city: string;
  street: string;
  zip: string;
  propertyType: string;
  builtMin: string;
  builtMax: string;
  valueMin: string;
  valueMax: string;
  // The six assignment dimensions as adjustable controls.
  roof: DimFilter; // roof age >= N years (proxy)
  tenure: DimFilter; // not sold in >= N years
  portfolio: DimFilter; // owner holds >= N parcels (regional-owner proxy)
  transit: DimFilter; // within N metres of a sample transit POI
  starbucks: DimFilter; // within N metres of a sample Starbucks POI
  // Water view is a disabled control (no data) — never a query input.
}

/** Fresh default filter state (new nested objects each call — never share). */
export function baseFilters(): SearchFilters {
  return {
    city: '',
    street: '',
    zip: '',
    propertyType: '',
    builtMin: '',
    builtMax: '',
    valueMin: '',
    valueMax: '',
    roof: { on: false, n: 15 },
    tenure: { on: false, n: 10 },
    portfolio: { on: false, n: 5 },
    transit: { on: false, n: 800 },
    starbucks: { on: false, n: 800 },
  };
}

export const DEFAULT_FILTERS: SearchFilters = baseFilters();

/** True when no filter constrains the query (→ show the full parcel table). */
export function isEmptyFilters(f: SearchFilters): boolean {
  return (
    !f.city.trim() &&
    !f.street.trim() &&
    !f.zip.trim() &&
    !f.propertyType.trim() &&
    !isNum(f.builtMin) &&
    !isNum(f.builtMax) &&
    !isNum(f.valueMin) &&
    !isNum(f.valueMax) &&
    !f.roof.on &&
    !f.tenure.on &&
    !f.portfolio.on &&
    !f.transit.on &&
    !f.starbucks.on
  );
}

// ---------- dimension metadata (honesty labels come from demoQuestions) ------

export type DimKey = 'roof' | 'tenure' | 'portfolio' | 'transit' | 'starbucks';

/** Map each adjustable dimension to its demo question (the honesty source). */
export const DIM_QUESTION: Record<DimKey, string> = {
  roof: 'roof-age',
  tenure: 'ownership-tenure',
  portfolio: 'regional-owners',
  transit: 'transit',
  starbucks: 'starbucks',
};

export const WATER_QUESTION_ID = 'water-view';

export function question(id: string): DemoQuestion | undefined {
  return DEMO_QUESTIONS.find((q) => q.id === id);
}

/** Honesty notes for every proxy/sample dimension currently active. */
export function activeNotes(f: SearchFilters): DemoQuestion[] {
  const out: DemoQuestion[] = [];
  (Object.keys(DIM_QUESTION) as DimKey[]).forEach((k) => {
    if (f[k].on) {
      const q = question(DIM_QUESTION[k]);
      if (q) out.push(q);
    }
  });
  return out;
}

// ---------- presets (reproducible demo, then tweakable) ----------------------

export interface Preset {
  id: string;
  label: string;
  /** Filter state this preset applies. Absent for the water-view preset. */
  filters?: SearchFilters;
  /** The water-view preset surfaces the deferred no-data note instead. */
  water?: boolean;
}

export const PRESETS: Preset[] = [
  { id: 'roof-age', label: 'Roofs > 15y', filters: withDim('roof', 15) },
  { id: 'water-view', label: 'View of water', water: true },
  {
    id: 'ownership-tenure',
    label: 'No ownership change > 10y',
    filters: withDim('tenure', 10),
  },
  { id: 'regional-owners', label: 'Regional owners', filters: withDim('portfolio', 5) },
  {
    id: 'transit',
    label: 'Near public transportation',
    filters: withDim('transit', 800),
  },
  { id: 'starbucks', label: 'Near Starbucks', filters: withDim('starbucks', 800) },
];

function withDim(key: DimKey, n: number): SearchFilters {
  const f = baseFilters();
  f[key] = { on: true, n };
  return f;
}

// ---------- SQL builder -------------------------------------------------------

/** Display columns of the results table (in order). */
export const DISPLAY_COLUMNS = [
  'parcel_identifier',
  'address_street',
  'address_city',
  'address_zip',
  'property_type',
  'built_year',
  'owner_name',
  'market_value',
  'last_sale',
  'source_system',
  'property_cid',
  'latitude',
  'longitude',
] as const;

/** Columns carried for wiring (CID link, expansion) but hidden from cells. */
export const HIDDEN_COLUMNS = ['property_cid', 'latitude', 'longitude'];

function isNum(v: string): boolean {
  return /^\d+$/.test(v.trim());
}

function clampInt(n: number, fallback: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : fallback;
}

/** Per-row haversine (metres) from the row's lat/lon to a fixed point. */
function haversine(lat: number, lon: number): string {
  return (
    `2*6371000*asin(sqrt(pow(sin(radians(latitude-(${lat}))/2),2)` +
    `+cos(radians(${lat}))*cos(radians(latitude))*pow(sin(radians(longitude-(${lon}))/2),2)))`
  );
}

/** Distance to the nearest POI in the set (metres). */
function nearestPoi(pois: Poi[]): string {
  return `least(${pois.map((p) => haversine(p.lat, p.lon)).join(', ')})`;
}

interface Core {
  cte: string;
  where: string;
}

function buildCore(f: SearchFilters): Core {
  // Per-parcel base. Display columns use any_value (a representative row);
  // owner_name uses max() so the portfolio filter is deterministic /
  // reproducible; filter-driving values (roof match, sale date, POI distance)
  // are aggregated as the MATCH itself so counts are distinct-parcel exact.
  const aggs = [
    'any_value(address_street) AS address_street',
    'any_value(address_city) AS address_city',
    'any_value(address_zip) AS address_zip',
    'any_value(property_type) AS property_type',
    'any_value(built_year) AS built_year',
    'any_value(has_permits) AS has_permits',
    'max(owner_name) AS owner_name',
    'any_value(market_value) AS market_value',
    'any_value(latitude) AS latitude',
    'any_value(longitude) AS longitude',
    'any_value(property_cid) AS property_cid',
    'any_value(source_system) AS source_system',
    'max(parsed_sale) AS latest_sale',
  ];
  const where: string[] = [];

  if (f.roof.on) {
    const n = clampInt(f.roof.n, 15);
    aggs.push(
      `bool_or(built_year>0 AND built_year<=year(current_date)-${n} ` +
        `AND has_permits=FALSE ` +
        `AND property_type IN ('Building','ManufacturedHome')) AS roof_match`,
    );
    where.push('roof_match');
  }
  if (f.transit.on) {
    const n = clampInt(f.transit.n, 800);
    aggs.push(`min(${nearestPoi(TRANSIT_POIS)}) AS transit_min_m`);
    where.push(`round(transit_min_m) <= ${n}`);
  }
  if (f.starbucks.on) {
    const n = clampInt(f.starbucks.n, 800);
    aggs.push(`min(${nearestPoi(STARBUCKS_POIS)}) AS starbucks_min_m`);
    where.push(`round(starbucks_min_m) <= ${n}`);
  }
  if (f.tenure.on) {
    const n = clampInt(f.tenure.n, 10);
    // Sentinel dates (< 1902-01-01) are source placeholders, not real sales.
    where.push(
      `latest_sale >= DATE '1902-01-01' ` +
        `AND latest_sale < current_date - INTERVAL ${n} YEAR`,
    );
  }
  if (f.portfolio.on) {
    const n = clampInt(f.portfolio.n, 5);
    // NOTE: property count, not owner count — properties whose owner holds
    // >= N distinct parcels countywide (the regional-owner proxy).
    where.push(
      `owner_name IN (SELECT owner_name FROM per_parcel ` +
        `WHERE owner_name IS NOT NULL AND owner_name <> '' ` +
        `GROUP BY owner_name HAVING count(*) >= ${n})`,
    );
  }

  // Plain real-column filters.
  if (f.city.trim())
    where.push(`lower(address_city) LIKE lower(${sqlString(`%${f.city.trim()}%`)})`);
  if (f.street.trim())
    where.push(
      `lower(address_street) LIKE lower(${sqlString(`%${f.street.trim()}%`)})`,
    );
  if (f.zip.trim()) where.push(`address_zip LIKE ${sqlString(`%${f.zip.trim()}%`)}`);
  if (f.propertyType.trim())
    where.push(`property_type = ${sqlString(f.propertyType.trim())}`);
  if (isNum(f.builtMin)) where.push(`built_year >= ${Number(f.builtMin)}`);
  if (isNum(f.builtMax)) where.push(`built_year <= ${Number(f.builtMax)}`);
  if (isNum(f.valueMin)) where.push(`market_value >= ${Number(f.valueMin)}`);
  if (isNum(f.valueMax)) where.push(`market_value <= ${Number(f.valueMax)}`);

  const cte = `WITH rows AS (
  SELECT *, try_strptime(substr(last_sale_date,1,15),'%a %b %d %Y') AS parsed_sale
  FROM ${TABLE} WHERE parcel_identifier IS NOT NULL
),
per_parcel AS (
  SELECT parcel_identifier,
         ${aggs.join(',\n         ')}
  FROM rows GROUP BY parcel_identifier
)`;

  const whereSql = where.length
    ? `WHERE ${where.map((c) => `(${c})`).join('\n  AND ')}`
    : '';

  return { cte, where: whereSql };
}

export interface QueryPlan {
  /** Distinct-parcel headline count. */
  countSql: string;
  /** One page of display rows. */
  pageSql: string;
}

export function buildSearchQuery(
  f: SearchFilters,
  page: number,
  pageSize: number,
): QueryPlan {
  const { cte, where } = buildCore(f);
  const countSql = `${cte}\nSELECT count(*) FROM per_parcel\n${where}`.trimEnd();
  const pageSql = `${cte}
SELECT parcel_identifier, address_street, address_city, address_zip,
       property_type, built_year, owner_name, market_value,
       strftime(latest_sale, '%Y-%m-%d') AS last_sale,
       source_system, property_cid, latitude, longitude
FROM per_parcel
${where}
ORDER BY address_city NULLS LAST, address_street NULLS LAST, parcel_identifier
LIMIT ${pageSize} OFFSET ${page * pageSize}`;
  return { countSql, pageSql };
}
