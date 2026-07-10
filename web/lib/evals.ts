/**
 * Relevance benchmark for the search stack.
 *
 * Each case is a natural-language question with GOLD structured intent (which
 * signals should fire, and which unavailable asks should be flagged). We run the
 * intent agent on each, score it against gold (precision/recall/F1 + exact
 * match), then run the deterministic query and have an LLM judge rate whether the
 * returned results are relevant to the question. Surfaced in the Evals tab.
 */

export interface EvalCase {
  id: string;
  question: string;
  /** Signal ids that SHOULD be selected. */
  expectCriteria: string[];
  /** UNSUPPORTED ids that SHOULD be flagged (owner/sale/year-built gaps). */
  expectUnsupported: string[];
}

export const EVAL_CASES: EvalCase[] = [
  { id: "roof-basic", question: "Which properties have roofs older than 15 years?", expectCriteria: ["roof_over_15"], expectUnsupported: [] },
  { id: "roof-new", question: "Homes that were recently re-roofed", expectCriteria: ["roof_recent"], expectUnsupported: [] },
  { id: "transit", question: "Properties within walking distance of public transit", expectCriteria: ["near_transit"], expectUnsupported: [] },
  { id: "coffee", question: "Homes near a coffee shop", expectCriteria: ["near_starbucks"], expectUnsupported: [] },
  { id: "water", question: "Waterfront properties with a view of water", expectCriteria: ["water_view"], expectUnsupported: [] },
  { id: "nosale", question: "Properties that have not sold in more than 10 years", expectCriteria: ["dormant_10yr"], expectUnsupported: ["exact_sale_date"] },
  { id: "owner", question: "Which properties have out-of-area or regional owners?", expectCriteria: [], expectUnsupported: ["regional_owner"] },
  { id: "roof-transit", question: "Old roofs near public transit", expectCriteria: ["roof_over_15", "near_transit"], expectUnsupported: [] },
  { id: "triple", question: "Old roofs that are near a Starbucks and near transit", expectCriteria: ["roof_over_15", "near_starbucks", "near_transit"], expectUnsupported: [] },
  { id: "dormant-roof", question: "Long-held properties with aging roofs", expectCriteria: ["dormant_10yr", "roof_over_15"], expectUnsupported: [] },
  { id: "mixed", question: "Waterfront homes near transit that haven't sold in a decade and have out-of-area owners", expectCriteria: ["water_view", "near_transit", "dormant_10yr"], expectUnsupported: ["regional_owner", "exact_sale_date"] },
];

export interface IntentScore {
  criteriaPrecision: number;
  criteriaRecall: number;
  criteriaF1: number;
  criteriaExact: boolean;
  unsupportedRecall: number;
  /** Overall pass: right criteria AND all expected gaps flagged. */
  pass: boolean;
}

function f1(precision: number, recall: number): number {
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

export function scoreIntent(
  gotCriteria: string[],
  gotUnsupported: string[],
  c: EvalCase,
): IntentScore {
  const g = new Set(gotCriteria);
  const e = new Set(c.expectCriteria);
  const inter = [...g].filter((x) => e.has(x)).length;
  const criteriaPrecision = g.size === 0 ? (e.size === 0 ? 1 : 0) : inter / g.size;
  const criteriaRecall = e.size === 0 ? 1 : inter / e.size;
  const criteriaF1 = e.size === 0 && g.size === 0 ? 1 : f1(criteriaPrecision, criteriaRecall);
  const criteriaExact = g.size === e.size && inter === e.size;

  const gu = new Set(gotUnsupported);
  const expU = c.expectUnsupported;
  const uInter = expU.filter((x) => gu.has(x)).length;
  const unsupportedRecall = expU.length === 0 ? 1 : uInter / expU.length;

  return {
    criteriaPrecision,
    criteriaRecall,
    criteriaF1,
    criteriaExact,
    unsupportedRecall,
    pass: criteriaExact && unsupportedRecall === 1,
  };
}

export interface JudgeResult {
  relevance: number; // 0..5
  verdict: "relevant" | "partial" | "irrelevant";
  reason: string;
}

export interface CaseResult {
  case: EvalCase;
  gotCriteria: string[];
  gotUnsupported: string[];
  summary: string;
  score: IntentScore;
  rowCount: number;
  judge?: JudgeResult;
  error?: string;
}

export interface Aggregate {
  n: number;
  intentExactRate: number;
  avgCriteriaF1: number;
  avgUnsupportedRecall: number;
  passRate: number;
  avgRelevance: number | null;
}

export function aggregate(results: CaseResult[]): Aggregate {
  const ok = results.filter((r) => !r.error);
  const n = ok.length || 1;
  const judged = ok.filter((r) => r.judge);
  return {
    n: ok.length,
    intentExactRate: ok.filter((r) => r.score.criteriaExact).length / n,
    avgCriteriaF1: ok.reduce((a, r) => a + r.score.criteriaF1, 0) / n,
    avgUnsupportedRecall: ok.reduce((a, r) => a + r.score.unsupportedRecall, 0) / n,
    passRate: ok.filter((r) => r.score.pass).length / n,
    avgRelevance: judged.length
      ? judged.reduce((a, r) => a + (r.judge?.relevance ?? 0), 0) / judged.length
      : null,
  };
}
