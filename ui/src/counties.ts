/**
 * Multi-county configuration — the single source of truth for every
 * county-specific fact the UI needs.
 *
 * Santa Clara County, CA is the DEFAULT (the deliverable county — it contains
 * Palo Alto, and its open parcel+geo data makes the distance questions REAL).
 * Lee County, FL is the reference implementation kept selectable because its
 * full assessor field set (owner, value, year-built, sales) keeps the
 * underwriting questions demonstrable while the paid Santa Clara Assessor bulk
 * order is outstanding.
 *
 * The active county drives: the Parquet URL DuckDB-WASM reads, the labels, the
 * demo-question honesty text, the dimension availability, and the agent/MCP
 * county key. Switching counties is pure config.
 */
import { LEE_PARQUET_URL, SANTA_CLARA_PARQUET_URL } from './config';
import { DemoQuestion, Poi, poiProximitySql } from './demoQuestions';
import type { DimKey } from './searchQuery';

export type CountyKey = 'santa-clara' | 'lee';

/** Availability of one intelligence dimension for a given county. */
export interface DimAvailability {
  enabled: boolean;
  /** Honest reason shown when the dimension is disabled for this county. */
  note?: string;
}

export interface CountyConfig {
  key: CountyKey;
  /** Full display label, e.g. "Santa Clara County, CA". */
  label: string;
  /** Short chip label for the selector. */
  selectorLabel: string;
  parquetUrl: string;
  /** SQL fragment referencing the county's remote query table. */
  table: string;
  /** County key understood by the MCP/agent (PROPERTY_QUERY_TABLE_MAP). */
  agentCounty: string;
  /**
   * True when assessor-derived columns (property_type, built_year, owner_name,
   * market_value, last_sale_date) are populated. Lee: true. Santa Clara: false
   * (those are a paid offline Assessor bulk order — 100% NULL in v1).
   */
  hasAssessorFields: boolean;
  transitPois: Poi[];
  transitLabel: string;
  starbucksPois: Poi[];
  starbucksLabel: string;
  /** Per-dimension availability (drives Search controls + presets). */
  dims: Record<DimKey, DimAvailability>;
  /** The six assignment questions, honesty-graded for this county. */
  demoQuestions: DemoQuestion[];
  /** The water-view question (always a deferred, no-data note). */
  water: DemoQuestion;
}

function tableFor(url: string): string {
  return `read_parquet('${url}')`;
}

// ---------------------------------------------------------------------------
// Lee County, FL — reference implementation (full field set).
// ---------------------------------------------------------------------------

const LEE_TRANSIT_POIS: Poi[] = [
  { name: 'Rosa Parks Transportation Center, Fort Myers', lat: 26.6444, lon: -81.871 },
  { name: 'Edison Mall transfer point, Fort Myers', lat: 26.5983, lon: -81.8709 },
  { name: 'Cape Coral Transfer Center (SE 47th Terr)', lat: 26.5624, lon: -81.9497 },
  { name: 'Beach Park & Ride, Summerlin Square', lat: 26.4547, lon: -81.9494 },
  { name: 'Lehigh Acres transfer point (Homestead Rd)', lat: 26.6079, lon: -81.6448 },
];

const LEE_STARBUCKS_POIS: Poi[] = [
  { name: 'Starbucks - First St, Downtown Fort Myers', lat: 26.6414, lon: -81.8687 },
  { name: 'Starbucks - Cleveland Ave (US-41), Fort Myers', lat: 26.5987, lon: -81.872 },
  { name: 'Starbucks - Santa Barbara Blvd, Cape Coral', lat: 26.6249, lon: -81.974 },
  { name: 'Starbucks - Coconut Point, Estero', lat: 26.4022, lon: -81.8065 },
  { name: 'Starbucks - Gulf Coast Town Center', lat: 26.4859, lon: -81.7859 },
  { name: 'Starbucks - Bonita Beach Rd, Bonita Springs', lat: 26.3312, lon: -81.8069 },
];

function leeQuestions(table: string): DemoQuestion[] {
  const transit = poiProximitySql(table, LEE_TRANSIT_POIS, 800);
  const starbucks = poiProximitySql(table, LEE_STARBUCKS_POIS, 800);
  return [
    {
      id: 'roof-age',
      title: 'A. Roofs older than 15 years',
      question: 'Which properties have roofs older than 15 years?',
      status: 'partial',
      dataBasis:
        'The schema has a roof_covering_material column but it is 100% NULL in ' +
        'this extract, and there is no roof-install date. Proxy used: structure ' +
        'built 15+ years ago with no permit on record (has_permits = FALSE), so ' +
        'the roof is presumed original. Direct roof-age answers land with the ' +
        'permit/enrichment phase.',
      summaryLabel:
        'properties (distinct parcels) with a presumed-original roof aged 15+ years',
      summarySql: `SELECT COUNT(DISTINCT parcel_identifier)
FROM ${table}
WHERE built_year IS NOT NULL AND built_year > 0
  AND built_year <= year(current_date) - 15
  AND has_permits = FALSE
  AND property_type IN ('Building', 'ManufacturedHome')`,
      rowsSql: `SELECT parcel_identifier, address_street, address_city, built_year,
       year(current_date) - built_year AS structure_age_years,
       property_type, has_permits, source_system
FROM ${table}
WHERE built_year IS NOT NULL AND built_year > 0
  AND built_year <= year(current_date) - 15
  AND has_permits = FALSE
  AND property_type IN ('Building', 'ManufacturedHome')
QUALIFY row_number() OVER (PARTITION BY parcel_identifier ORDER BY property_id) = 1
ORDER BY built_year
LIMIT 25`,
    },
    leeWater(),
    {
      id: 'ownership-tenure',
      title: 'C. No ownership change in 10+ years',
      question:
        'Which properties have not changed ownership in more than 10 years?',
      status: 'supported',
      dataBasis:
        'Computed from last_sale_date, taking the most recent recorded sale per ' +
        'parcel. Placeholder dates (1900-01-01 and earlier) are source-record ' +
        'sentinels, not real sales, so those parcels are treated as "no recorded ' +
        'sale" and excluded rather than counted as ~126-year tenure. Rows with no ' +
        'parseable sale are likewise excluded — tenure cannot be verified for them. ' +
        'Counted by distinct parcel (duplicate rows collapsed).',
      summaryLabel:
        'parcels whose most recent recorded sale is over 10 years ago',
      summarySql: `SELECT COUNT(*) FROM (
  SELECT parcel_identifier,
         MAX(try_strptime(substr(last_sale_date, 1, 15), '%a %b %d %Y')) AS latest_sale
  FROM ${table}
  WHERE parcel_identifier IS NOT NULL
  GROUP BY parcel_identifier
  HAVING latest_sale IS NOT NULL
     AND latest_sale >= DATE '1902-01-01'
     AND latest_sale < current_date - INTERVAL 10 YEAR
)`,
      rowsSql: `SELECT t.parcel_identifier, any_value(t.address_street) AS address_street,
       any_value(t.address_city) AS address_city,
       strftime(MAX(try_strptime(substr(t.last_sale_date, 1, 15), '%a %b %d %Y')),
                '%Y-%m-%d') AS latest_sale,
       any_value(t.owner_name) AS owner_name,
       any_value(t.source_system) AS source_system
FROM ${table} t
WHERE t.parcel_identifier IS NOT NULL
GROUP BY t.parcel_identifier
HAVING MAX(try_strptime(substr(t.last_sale_date, 1, 15), '%a %b %d %Y')) >= DATE '1902-01-01'
   AND MAX(try_strptime(substr(t.last_sale_date, 1, 15), '%a %b %d %Y'))
       < current_date - INTERVAL 10 YEAR
ORDER BY latest_sale
LIMIT 25`,
    },
    {
      id: 'regional-owners',
      title: 'D. Regional owners',
      question: 'Which properties are held by regional owners?',
      status: 'partial',
      dataBasis:
        'This extract has owner_name / owners_text / owner_occupied but no owner ' +
        'mailing address, so in-region vs out-of-region cannot be determined ' +
        'directly. Proxy used: portfolio owners holding 5+ parcels in the county ' +
        '(3,820 such owners exist). True regional classification lands with ' +
        'owner-address enrichment.',
      summaryLabel: 'owners holding 5+ parcels in the county',
      summarySql: `SELECT COUNT(*) FROM (
  SELECT owner_name
  FROM ${table}
  WHERE owner_name IS NOT NULL AND owner_name <> ''
  GROUP BY owner_name
  HAVING COUNT(*) >= 5
)`,
      rowsSql: `SELECT owner_name,
       COUNT(*) AS parcels_held,
       COUNT(DISTINCT address_city) AS cities,
       COUNT(*) FILTER (owner_occupied) AS owner_occupied_parcels,
       any_value(source_system) AS source_system
FROM ${table}
WHERE owner_name IS NOT NULL AND owner_name <> ''
GROUP BY owner_name
HAVING COUNT(*) >= 5
ORDER BY parcels_held DESC
LIMIT 25`,
    },
    {
      id: 'transit',
      title: 'E. Walking distance to public transportation',
      question:
        'Which properties are within walking distance (~800 m) of public transportation?',
      status: 'partial',
      dataBasis:
        'Latitude/longitude are populated for all rows, so the distance math ' +
        '(haversine) is real. The transit locations are a SAMPLE POI SET: 5 ' +
        'approximate LeeTran hub/transfer coordinates hardcoded for v1. The full ' +
        'GTFS stop network lands with a richer ingest, at which point this query ' +
        'only swaps its POI table.',
      summaryLabel: 'properties within 800 m of a sample transit hub',
      summarySql: transit.summary,
      rowsSql: transit.rows,
    },
    {
      id: 'starbucks',
      title: 'F. Walking distance to Starbucks',
      question:
        'Which properties are within walking distance (~800 m) of a Starbucks?',
      status: 'partial',
      dataBasis:
        'Same basis as the transit question: real per-property coordinates, ' +
        'haversine distance, but against a SAMPLE POI SET of 6 approximate ' +
        'Starbucks locations in the county. Full place data lands with a richer ' +
        'ingest.',
      summaryLabel: 'properties within 800 m of a sample Starbucks location',
      summarySql: starbucks.summary,
      rowsSql: starbucks.rows,
    },
  ];
}

function leeWater(): DemoQuestion {
  return {
    id: 'water-view',
    title: 'B. View of water',
    question: 'Which properties have a view of water?',
    status: 'deferred',
    dataBasis:
      'Requires geo enrichment. None of the columns encode view, waterfront, or ' +
      'water frontage. Latitude/longitude are fully populated, so once water-body ' +
      'geometry (NHD / county GIS shoreline) is ingested this becomes a ' +
      'straightforward spatial join. No results are shown because none can ' +
      'honestly be computed yet.',
  };
}

// ---------------------------------------------------------------------------
// Santa Clara County, CA — deliverable county (real parcels + geo; paid
// assessor fields left NULL).
// ---------------------------------------------------------------------------

const SC_TRANSIT_POIS: Poi[] = [
  { name: 'Palo Alto Caltrain', lat: 37.4439, lon: -122.1653 },
  { name: 'Mountain View Transit Center', lat: 37.3946, lon: -122.076 },
  { name: 'Sunnyvale Caltrain', lat: 37.3785, lon: -122.0316 },
  { name: 'San Jose Diridon Station', lat: 37.3297, lon: -121.9028 },
  { name: 'Santa Clara Caltrain', lat: 37.353, lon: -121.936 },
  { name: 'Milpitas Transit Center (BART/VTA)', lat: 37.4102, lon: -121.8913 },
  { name: 'Gilroy Caltrain', lat: 37.0037, lon: -121.5665 },
];

const SC_STARBUCKS_POIS: Poi[] = [
  { name: 'Starbucks - University Ave, Palo Alto', lat: 37.4459, lon: -122.1608 },
  { name: 'Starbucks - Castro St, Mountain View', lat: 37.3945, lon: -122.0797 },
  { name: 'Starbucks - Murphy Ave, Sunnyvale', lat: 37.3776, lon: -122.0308 },
  { name: 'Starbucks - Santana Row, San Jose', lat: 37.321, lon: -121.9476 },
  { name: 'Starbucks - Stevens Creek Blvd, San Jose', lat: 37.323, lon: -121.95 },
  { name: 'Starbucks - Downtown San Jose', lat: 37.3352, lon: -121.8895 },
];


function scQuestions(table: string): DemoQuestion[] {
  const t = table;
  return [
    {
      id: 'roof-age',
      title: 'A. Roofs older than 15 years',
      question: 'Which properties have roofs older than 15 years?',
      status: 'supported',
      dataBasis:
        'REAL: built_year from the Santa Clara County Assessor property ' +
        'characteristics (Palo Alto core, harvested + MTC open data). Roof age ' +
        'is proxied by structure age — built 15+ years ago; a separate roof-' +
        'install date is not published, so age is the honest, labeled proxy.',
      summaryLabel:
        'distinct parcels built 15+ years ago (roof presumed 15+ years old)',
      summarySql: `SELECT COUNT(DISTINCT parcel_identifier)
FROM ${t}
WHERE built_year IS NOT NULL AND built_year > 0
  AND built_year <= year(current_date) - 15`,
      rowsSql: `SELECT parcel_identifier, any_value(address_street) AS address_street,
       any_value(address_city) AS address_city, any_value(built_year) AS built_year,
       any_value(source_system) AS source_system
FROM ${t}
WHERE built_year IS NOT NULL AND built_year > 0
  AND built_year <= year(current_date) - 15
GROUP BY parcel_identifier
ORDER BY built_year
LIMIT 25`,
    },
    {
      id: 'water-view',
      title: 'B. View of water',
      question: 'Which properties have a view of water?',
      status: 'partial',
      dataBasis:
        'PROXIMITY PROXY (labeled): dist_water_m is the haversine distance in ' +
        'metres from the parcel centroid to the nearest named water body from ' +
        'OpenStreetMap (San Francisco Bay baylands/salt ponds, creeks, ' +
        'reservoirs). Within 1500 m is a defensible stand-in for a water view — ' +
        'it is proximity, NOT a verified line-of-sight, and is labeled as such.',
      summaryLabel:
        'distinct parcels within 1500 m of a named water body (proximity proxy)',
      summarySql: `SELECT COUNT(DISTINCT parcel_identifier)
FROM ${t}
WHERE dist_water_m IS NOT NULL AND dist_water_m < 1500`,
      rowsSql: `SELECT parcel_identifier, any_value(address_street) AS address_street,
       any_value(address_city) AS address_city,
       round(any_value(dist_water_m)) AS metres_to_water,
       any_value(source_system) AS source_system
FROM ${t}
WHERE dist_water_m IS NOT NULL AND dist_water_m < 1500
GROUP BY parcel_identifier
ORDER BY metres_to_water
LIMIT 25`,
    },
    {
      id: 'ownership-tenure',
      title: 'C. No ownership change in 10+ years',
      question:
        'Which properties have not changed ownership in more than 10 years?',
      status: 'supported',
      dataBasis:
        'REAL: last_sale_date is the recorded deed/transfer date harvested from ' +
        'the Santa Clara County Assessor public records (Palo Alto core), stored ' +
        'as ISO YYYY-MM-DD. Parcels whose most recent transfer is >10 years ago.',
      summaryLabel:
        'distinct parcels with no recorded transfer in the last 10 years',
      summarySql: `SELECT COUNT(DISTINCT parcel_identifier)
FROM ${t}
WHERE last_sale_date IS NOT NULL
  AND last_sale_date < strftime(current_date - INTERVAL 10 YEAR, '%Y-%m-%d')`,
      rowsSql: `SELECT parcel_identifier, any_value(address_street) AS address_street,
       any_value(address_city) AS address_city, max(last_sale_date) AS last_sale_date,
       any_value(source_system) AS source_system
FROM ${t}
WHERE last_sale_date IS NOT NULL
  AND last_sale_date < strftime(current_date - INTERVAL 10 YEAR, '%Y-%m-%d')
GROUP BY parcel_identifier
ORDER BY last_sale_date
LIMIT 25`,
    },
    {
      id: 'regional-owners',
      title: 'D. Regional owners',
      question: 'Which properties are held by regional (out-of-area) owners?',
      status: 'supported',
      dataBasis:
        'REAL: regional_owner is TRUE when the owner MAILING address (Santa ' +
        'Clara County Assessor) is outside Santa Clara County — an out-of-area / ' +
        'absentee owner, evidenced by owner_mailing_city/state. owner_name is also ' +
        'present but sparse (~1.6%, 7,735 parcels, from San Jose permits); the ' +
        'Assessor public lookup omits owner name, so most rows carry owner ' +
        'LOCATION rather than a name. Never a fabricated name.',
      summaryLabel:
        'distinct parcels whose owner mailing address is outside Santa Clara County',
      summarySql: `SELECT COUNT(DISTINCT parcel_identifier)
FROM ${t}
WHERE regional_owner = TRUE`,
      rowsSql: `SELECT parcel_identifier, any_value(address_street) AS address_street,
       any_value(address_city) AS address_city,
       any_value(owner_mailing_city) AS owner_mailing_city,
       any_value(owner_mailing_state) AS owner_mailing_state,
       any_value(source_system) AS source_system
FROM ${t}
WHERE regional_owner = TRUE
GROUP BY parcel_identifier
ORDER BY owner_mailing_state, owner_mailing_city
LIMIT 25`,
    },
    {
      id: 'transit',
      title: 'E. Walking distance to public transportation',
      question:
        'Which properties are within walking distance (~800 m) of public transportation?',
      status: 'supported',
      dataBasis:
        'REAL: dist_transit_m is the haversine distance from the parcel centroid ' +
        '(100% populated) to the nearest of 97 real Caltrain / VTA / rail ' +
        'stations from OpenStreetMap, precomputed for all 495k parcels.',
      summaryLabel:
        'distinct parcels within 800 m of a real Caltrain/VTA station',
      summarySql: `SELECT COUNT(DISTINCT parcel_identifier)
FROM ${t}
WHERE dist_transit_m IS NOT NULL AND dist_transit_m < 800`,
      rowsSql: `SELECT parcel_identifier, any_value(address_street) AS address_street,
       any_value(address_city) AS address_city,
       round(any_value(dist_transit_m)) AS metres_to_transit,
       any_value(source_system) AS source_system
FROM ${t}
WHERE dist_transit_m IS NOT NULL AND dist_transit_m < 800
GROUP BY parcel_identifier
ORDER BY metres_to_transit
LIMIT 25`,
    },
    {
      id: 'starbucks',
      title: 'F. Walking distance to Starbucks',
      question:
        'Which properties are within walking distance (~800 m) of a Starbucks?',
      status: 'supported',
      dataBasis:
        'REAL: dist_starbucks_m is the haversine distance to the nearest of 119 ' +
        'real Starbucks locations in Santa Clara County from OpenStreetMap, ' +
        'precomputed for all 495k parcels.',
      summaryLabel: 'distinct parcels within 800 m of a real Starbucks',
      summarySql: `SELECT COUNT(DISTINCT parcel_identifier)
FROM ${t}
WHERE dist_starbucks_m IS NOT NULL AND dist_starbucks_m < 800`,
      rowsSql: `SELECT parcel_identifier, any_value(address_street) AS address_street,
       any_value(address_city) AS address_city,
       round(any_value(dist_starbucks_m)) AS metres_to_starbucks,
       any_value(source_system) AS source_system
FROM ${t}
WHERE dist_starbucks_m IS NOT NULL AND dist_starbucks_m < 800
GROUP BY parcel_identifier
ORDER BY metres_to_starbucks
LIMIT 25`,
    },
  ];
}

// ---------------------------------------------------------------------------
// County registry.
// ---------------------------------------------------------------------------

const SANTA_CLARA: CountyConfig = {
  key: 'santa-clara',
  label: 'Santa Clara County, CA',
  selectorLabel: 'Santa Clara County, CA',
  parquetUrl: SANTA_CLARA_PARQUET_URL,
  table: tableFor(SANTA_CLARA_PARQUET_URL),
  agentCounty: 'santa-clara',
  hasAssessorFields: true,
  transitPois: SC_TRANSIT_POIS,
  transitLabel: 'real transit stations (Caltrain/VTA)',
  starbucksPois: SC_STARBUCKS_POIS,
  starbucksLabel: 'real Starbucks locations (OpenStreetMap)',
  dims: {
    roof: { enabled: true },
    tenure: { enabled: true },
    portfolio: { enabled: true },
    transit: { enabled: true },
    starbucks: { enabled: true },
    water: { enabled: true },
  },
  demoQuestions: scQuestions(tableFor(SANTA_CLARA_PARQUET_URL)),
  water: scQuestions(tableFor(SANTA_CLARA_PARQUET_URL)).find(
    (q) => q.id === 'water-view',
  )!,
};

const LEE: CountyConfig = {
  key: 'lee',
  label: 'Lee County, FL',
  selectorLabel: 'Lee County, FL — reference',
  parquetUrl: LEE_PARQUET_URL,
  table: tableFor(LEE_PARQUET_URL),
  agentCounty: 'lee',
  hasAssessorFields: true,
  transitPois: LEE_TRANSIT_POIS,
  transitLabel: 'sample LeeTran transit hubs',
  starbucksPois: LEE_STARBUCKS_POIS,
  starbucksLabel: 'sample Starbucks locations',
  dims: {
    roof: { enabled: true },
    tenure: { enabled: true },
    portfolio: { enabled: true },
    transit: { enabled: true },
    starbucks: { enabled: true },
    water: { enabled: false, note: 'no water-body geometry ingested for the reference county' },
  },
  demoQuestions: leeQuestions(tableFor(LEE_PARQUET_URL)),
  water: leeWater(),
};

export const COUNTIES: Record<CountyKey, CountyConfig> = {
  'santa-clara': SANTA_CLARA,
  lee: LEE,
};

export const COUNTY_KEYS: CountyKey[] = ['santa-clara', 'lee'];

export const DEFAULT_COUNTY_KEY: CountyKey = 'santa-clara';

export function isCountyKey(v: string | null): v is CountyKey {
  return v === 'santa-clara' || v === 'lee';
}

/** Resolve the active county key from a URL search string (?county=…). */
export function countyFromSearch(search: string): CountyKey {
  const v = new URLSearchParams(search).get('county');
  return isCountyKey(v) ? v : DEFAULT_COUNTY_KEY;
}

export function getCounty(key: CountyKey): CountyConfig {
  return COUNTIES[key];
}
