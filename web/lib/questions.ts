/**
 * The six property-intelligence questions the assignment requires, each mapped
 * to a read-only SQL query over the `properties` view plus the rule and source
 * basis. `kind` drives how the UI labels the answer:
 *   real  — answered directly from source records
 *   proxy — a labeled stand-in (Q4: permit dormancy, not sale data)
 *   gap   — no free open data (Q3: owner mailing address)
 */

export type QuestionKind = "real" | "proxy" | "gap";

export interface Question {
  id: string;
  title: string;
  subtitle: string;
  kind: QuestionKind;
  /** SQL over `properties` returning the matching rows (no LIMIT — UI caps). */
  sql: string;
  /** Human explanation of the rule + which source backs it. */
  basis: string;
  /** Columns to surface in the results table. */
  columns: string[];
}

const BASE_COLS = [
  "request_identifier",
  "address_house_number",
  "address_street",
  "address_city",
];

export const QUESTIONS: Question[] = [
  {
    id: "roof-over-15",
    title: "Roofs older than 15 years",
    subtitle: "Properties with no roofing permit in the last 15 years",
    kind: "real",
    sql: `SELECT ${BASE_COLS.join(", ")}, roof_basis, last_roof_permit_date, roof_permit_count, latitude, longitude
          FROM properties WHERE roof_over_15 ORDER BY roof_permit_count, request_identifier`,
    basis:
      "Source: City of Palo Alto building permits (2013–present). A roofing permit in the last 15 years indicates a newer roof; absence of one indicates the roof is likely older than 15 years. roof_basis shows which case each property is.",
    columns: [...BASE_COLS, "roof_basis", "last_roof_permit_date", "roof_permit_count"],
  },
  {
    id: "water-view",
    title: "View of water",
    subtitle: "Parcels within 150 m of a water body",
    kind: "real",
    sql: `SELECT ${BASE_COLS.join(", ")}, round(nearest_water_m) AS nearest_water_m, latitude, longitude
          FROM properties WHERE water_view ORDER BY nearest_water_m`,
    basis:
      "Source: parcel centroid (SCC) + OpenStreetMap water bodies. Heuristic — proximity to water within 150 m, not a verified sightline. Treat as 'possible water view'.",
    columns: [...BASE_COLS, "nearest_water_m"],
  },
  {
    id: "no-sale-10yr",
    title: "No sale in 10+ years",
    subtitle: "PROXY: no permit activity in the last 10 years",
    kind: "proxy",
    sql: `SELECT ${BASE_COLS.join(", ")}, permit_count, last_permit_date, latitude, longitude
          FROM properties WHERE permit_dormant_10yr ORDER BY last_permit_date NULLS FIRST, request_identifier`,
    basis:
      "PROXY, not sale data. Last-sale dates are not free open data in California (assessor restriction). This uses permit-activity dormancy — no development permit in 10+ years — as a stand-in signal from real permit history. Not a substitute for a recorded sale date.",
    columns: [...BASE_COLS, "permit_count", "last_permit_date"],
  },
  {
    id: "regional-owner",
    title: "Regional (out-of-area) owners",
    subtitle: "Requires owner mailing address — not in free open data",
    kind: "gap",
    sql: `SELECT ${BASE_COLS.join(", ")}, owners_text, owner_data_available, latitude, longitude
          FROM properties WHERE owner_data_available ORDER BY request_identifier`,
    basis:
      "Owner name and mailing address are not published as free open data for Santa Clara County (California R&T Code §408). Determining a regional/out-of-area owner requires comparing owner mailing address to the property address — data available only via paid assessor bulk or a commercial aggregator. Returns 0 rows by design; supply an owner CSV to enable.",
    columns: [...BASE_COLS, "owners_text"],
  },
  {
    id: "near-transit",
    title: "Near public transit",
    subtitle: "Within ~800 m (10-min walk) of a transit stop",
    kind: "real",
    sql: `SELECT ${BASE_COLS.join(", ")}, round(nearest_transit_m) AS nearest_transit_m, latitude, longitude
          FROM properties WHERE near_transit ORDER BY nearest_transit_m`,
    basis:
      "Source: parcel centroid (SCC) + OpenStreetMap transit stops (bus/rail/platform). Distance is straight-line via ST_Distance_Sphere; 'near' = within 800 m.",
    columns: [...BASE_COLS, "nearest_transit_m"],
  },
  {
    id: "near-starbucks",
    title: "Near a Starbucks",
    subtitle: "Within ~800 m (10-min walk) of a Starbucks",
    kind: "real",
    sql: `SELECT ${BASE_COLS.join(", ")}, round(nearest_starbucks_m) AS nearest_starbucks_m, latitude, longitude
          FROM properties WHERE near_starbucks ORDER BY nearest_starbucks_m`,
    basis:
      "Source: parcel centroid (SCC) + OpenStreetMap Starbucks locations. Distance via ST_Distance_Sphere; 'near' = within 800 m.",
    columns: [...BASE_COLS, "nearest_starbucks_m"],
  },
];

export function questionById(id: string): Question | undefined {
  return QUESTIONS.find((q) => q.id === id);
}
