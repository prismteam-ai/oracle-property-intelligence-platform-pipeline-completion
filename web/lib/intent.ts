/**
 * Intent vocabulary + deterministic query builder.
 *
 * The intent agent (/api/intent) parses a natural-language question into a
 * structured `ParsedIntent` referencing these known signals. The UI renders the
 * parsed intent, and the SAME structure builds the SQL — so what the user sees
 * as "understood as" is exactly what runs. Anything the data can't answer lands
 * in `unsupported` instead of being silently dropped or faked.
 */

export type SignalKind = "real" | "proxy";

export interface Signal {
  id: string;
  label: string;
  kind: SignalKind;
  /** Boolean SQL predicate over the `properties` view. */
  predicate: string;
  /** Extra columns worth surfacing when this signal is active. */
  columns?: string[];
  /** Honesty note shown as a caveat when the signal is used. */
  note?: string;
}

/** The signals the parser may choose from (ids are the tool enum). */
export const SIGNALS: Record<string, Signal> = {
  roof_over_15: {
    id: "roof_over_15",
    label: "Roof likely >15 years old",
    kind: "real",
    predicate: "roof_over_15 = TRUE",
    columns: ["roof_basis", "last_roof_permit_date", "roof_permit_count"],
  },
  roof_recent: {
    id: "roof_recent",
    label: "Roof replaced within 15 years",
    kind: "real",
    predicate: "roof_over_15 = FALSE",
    columns: ["last_roof_permit_date", "roof_permit_count"],
  },
  dormant_10yr: {
    id: "dormant_10yr",
    label: "No permit activity in 10+ years",
    kind: "proxy",
    predicate: "permit_dormant_10yr = TRUE",
    columns: ["permit_count", "last_permit_date"],
    note: "Proxy for 'no sale in 10 years' — last-sale dates are not free open data in California, so permit dormancy stands in.",
  },
  near_transit: {
    id: "near_transit",
    label: "Near public transit (≤800 m)",
    kind: "real",
    predicate: "near_transit = TRUE",
    columns: ["nearest_transit_m"],
  },
  near_starbucks: {
    id: "near_starbucks",
    label: "Near a Starbucks (≤800 m)",
    kind: "real",
    predicate: "near_starbucks = TRUE",
    columns: ["nearest_starbucks_m"],
  },
  water_view: {
    id: "water_view",
    label: "Possible water view (≤150 m)",
    kind: "real",
    predicate: "water_view = TRUE",
    columns: ["nearest_water_m"],
    note: "Proximity heuristic (within 150 m of water), not a verified sightline.",
  },
};

/** Things the dataset genuinely cannot answer, with the reason. */
export const UNSUPPORTED: Record<string, string> = {
  regional_owner:
    "Owner name and mailing address are not free open data for Santa Clara County (California R&T Code §408), so out-of-area / regional ownership can't be determined.",
  exact_sale_date:
    "Recorded sale/transfer dates are not free open data in California; only the permit-dormancy proxy is available.",
  year_built:
    "Assessor year-built is not free open data here; roof age is inferred from permit history instead.",
};

export const SIGNAL_IDS = Object.keys(SIGNALS);
export const UNSUPPORTED_IDS = Object.keys(UNSUPPORTED);

export interface ParsedIntent {
  /** Signal ids the question maps to (ANDed together). */
  criteria: string[];
  /** Requested-but-unavailable aspects (ids from UNSUPPORTED) with context. */
  unsupported: Array<{ id: string; requested: string }>;
  /** One-line restatement of what will be searched. */
  summary: string;
}

const BASE_COLUMNS = [
  "request_identifier",
  "address_house_number",
  "address_street",
  "address_city",
  "address_zip",
];

/** Build the SELECT from a parsed intent — this is what actually runs. */
export function buildSql(intent: ParsedIntent, limit = 500): string {
  const signals = intent.criteria
    .map((id) => SIGNALS[id])
    .filter((s): s is Signal => Boolean(s));

  const extraCols = Array.from(new Set(signals.flatMap((s) => s.columns ?? [])));
  const cols = [...BASE_COLUMNS, ...extraCols, "latitude", "longitude"];
  // No usable criteria: if the question asked ONLY for something unavailable
  // (e.g. owner), return nothing rather than every property. Only a truly
  // filter-less request ("show properties") returns all.
  const where = signals.length
    ? signals.map((s) => s.predicate).join(" AND ")
    : intent.unsupported.length > 0
      ? "FALSE"
      : "TRUE";

  return `SELECT ${cols.join(", ")} FROM properties WHERE ${where} ORDER BY request_identifier LIMIT ${limit}`;
}

/** Collect the honesty caveats implied by the chosen signals. */
export function intentCaveats(intent: ParsedIntent): string[] {
  const out: string[] = [];
  for (const id of intent.criteria) {
    const n = SIGNALS[id]?.note;
    if (n) out.push(n);
  }
  for (const u of intent.unsupported) {
    const reason = UNSUPPORTED[u.id];
    if (reason) out.push(reason);
  }
  return out;
}
