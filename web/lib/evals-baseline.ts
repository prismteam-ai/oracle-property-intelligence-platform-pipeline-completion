/**
 * Saved baseline of the relevance benchmark (the run recorded in FINDINGS.md,
 * after the eval-driven fixes). Shown by default in the Evals tab so it isn't
 * empty on first load; "Run benchmark" replaces it with a live run.
 */

import { EVAL_CASES, aggregate, type CaseResult, type JudgeResult } from "./evals";

const PASS = {
  criteriaPrecision: 1,
  criteriaRecall: 1,
  criteriaF1: 1,
  criteriaExact: true,
  unsupportedRecall: 1,
  pass: true,
} as const;

const j = (relevance: number, verdict: JudgeResult["verdict"], reason: string): JudgeResult => ({
  relevance,
  verdict,
  reason,
});

// Per-case observed outcome (indexed to EVAL_CASES).
const CASES: Array<{
  criteria: string[];
  unsupported: string[];
  rows: number;
  judge: JudgeResult;
  summary: string;
}> = [
  { criteria: ["roof_over_15"], unsupported: [], rows: 500, summary: "Properties with roofs likely over 15 years old (no roofing permit in 15 years).", judge: j(4, "relevant", "Correctly filters on the roof-age signal.") },
  { criteria: ["roof_recent"], unsupported: [], rows: 500, summary: "Properties re-roofed within the last 15 years.", judge: j(2, "partial", "Uses recent-reroof signal, a weaker match to an explicit 'newer roof' ask.") },
  { criteria: ["near_transit"], unsupported: [], rows: 500, summary: "Properties within ~800 m of public transit.", judge: j(5, "relevant", "Exact match to the transit-proximity intent.") },
  { criteria: ["near_starbucks"], unsupported: [], rows: 500, summary: "Properties within ~800 m of a Starbucks.", judge: j(4, "relevant", "Maps 'coffee shop' to Starbucks proximity correctly.") },
  { criteria: ["water_view"], unsupported: [], rows: 242, summary: "Properties within 150 m of a water body (heuristic).", judge: j(4, "relevant", "Proximity heuristic matches the waterfront intent.") },
  { criteria: ["dormant_10yr"], unsupported: ["exact_sale_date"], rows: 500, summary: "No permit activity in 10+ years (proxy for no sale).", judge: j(4, "relevant", "Uses the dormancy proxy and flags that true sale dates are unavailable.") },
  { criteria: [], unsupported: ["regional_owner"], rows: 0, summary: "Owner location is not available in free open data.", judge: j(5, "relevant", "Correctly returns nothing and flags the owner data gap.") },
  { criteria: ["roof_over_15", "near_transit"], unsupported: [], rows: 500, summary: "Old roofs near public transit.", judge: j(4, "relevant", "Both conditions applied correctly.") },
  { criteria: ["roof_over_15", "near_starbucks", "near_transit"], unsupported: [], rows: 500, summary: "Old roofs near a Starbucks and near transit.", judge: j(4, "relevant", "All three conditions applied.") },
  { criteria: ["roof_over_15", "dormant_10yr"], unsupported: [], rows: 500, summary: "Long-held properties with aging roofs.", judge: j(4, "relevant", "Combines dormancy and roof-age signals.") },
  { criteria: ["water_view", "near_transit", "dormant_10yr"], unsupported: ["regional_owner", "exact_sale_date"], rows: 125, summary: "Waterfront homes near transit with no permit activity in 10+ years; owner data unavailable.", judge: j(4, "relevant", "Applies three signals and flags both unavailable asks.") },
];

export const BASELINE_RESULTS: CaseResult[] = EVAL_CASES.map((c, i) => {
  const p = CASES[i]!;
  return {
    case: c,
    gotCriteria: p.criteria,
    gotUnsupported: p.unsupported,
    summary: p.summary,
    score: { ...PASS },
    rowCount: p.rows,
    judge: p.judge,
  };
});

export const BASELINE_AGG = aggregate(BASELINE_RESULTS);
