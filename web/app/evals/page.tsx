"use client";

import { useState } from "react";
import Nav from "@/components/Nav";
import { query } from "@/lib/duck";
import { buildSql, SIGNALS, type ParsedIntent } from "@/lib/intent";
import { evalCache } from "@/lib/store";
import { BASELINE_RESULTS, BASELINE_AGG } from "@/lib/evals-baseline";
import {
  EVAL_CASES,
  scoreIntent,
  aggregate,
  type CaseResult,
  type Aggregate,
} from "@/lib/evals";

export default function EvalsPage() {
  const hasCache = evalCache.results.length > 0;
  const [useJudge, setUseJudge] = useState(evalCache.useJudge);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<CaseResult[]>(hasCache ? evalCache.results : BASELINE_RESULTS);
  const [agg, setAgg] = useState<Aggregate | null>(hasCache ? evalCache.agg : BASELINE_AGG);
  const [isBaseline, setIsBaseline] = useState(!hasCache);
  const [err, setErr] = useState("");

  async function run() {
    setRunning(true);
    setErr("");
    setResults([]);
    setAgg(null);
    setIsBaseline(false);
    const out: CaseResult[] = [];
    try {
      for (let i = 0; i < EVAL_CASES.length; i++) {
        const c = EVAL_CASES[i];
        setProgress(i);
        try {
          const intentRes = await fetch("/api/intent", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question: c.question }),
          });
          if (!intentRes.ok) throw new Error((await intentRes.json()).error ?? "intent failed");
          const intent = (await intentRes.json()) as ParsedIntent;
          const gotCriteria = intent.criteria ?? [];
          const gotUnsupported = (intent.unsupported ?? []).map((u) => u.id);
          const score = scoreIntent(gotCriteria, gotUnsupported, c);

          const rows = await query(buildSql(intent));

          let judge: CaseResult["judge"];
          if (useJudge) {
            const jr = await fetch("/api/eval", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                question: c.question,
                criteria: gotCriteria,
                unsupported: gotUnsupported,
                rowCount: rows.length,
                rows: rows.slice(0, 8),
              }),
            });
            if (jr.ok) judge = await jr.json();
          }

          out.push({
            case: c,
            gotCriteria,
            gotUnsupported,
            summary: intent.summary ?? "",
            score,
            rowCount: rows.length,
            judge,
          });
        } catch (e) {
          out.push({
            case: c,
            gotCriteria: [],
            gotUnsupported: [],
            summary: "",
            score: scoreIntent([], [], c),
            rowCount: 0,
            error: String(e instanceof Error ? e.message : e),
          });
        }
        setResults([...out]);
      }
      const a = aggregate(out);
      setAgg(a);
      evalCache.results = out;
      evalCache.agg = a;
      evalCache.useJudge = useJudge;
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <Nav />
      <main className="max-w-6xl mx-auto px-5 py-8 space-y-5">
        <div>
          <h1 className="text-xl font-bold">Relevance evals</h1>
          <p className="text-sm text-[var(--color-muted)] mt-1">
            A labeled benchmark of {EVAL_CASES.length} questions. Scores the intent
            agent against gold labels (precision / recall / F1 + exact match), then
            an LLM judge rates the relevance of the actual results.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button className="btn btn-primary" onClick={run} disabled={running}>
            {running ? `Running ${progress + 1}/${EVAL_CASES.length}…` : "Run benchmark"}
          </button>
          <label className="text-xs text-[var(--color-muted)] flex items-center gap-2">
            <input type="checkbox" checked={useJudge} onChange={(e) => setUseJudge(e.target.checked)} disabled={running} />
            LLM-as-judge relevance
          </label>
          {isBaseline && !running && (
            <span className="chip chip-proxy">saved baseline · run for a live pass</span>
          )}
        </div>

        {err && <div className="card p-4 text-[var(--color-bad)] text-sm">{err}</div>}

        {/* Headline metrics */}
        {agg && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Metric label="Intent exact-match" value={pct(agg.intentExactRate)} />
            <Metric label="Criteria F1" value={agg.avgCriteriaF1.toFixed(2)} />
            <Metric label="Gap-flag recall" value={pct(agg.avgUnsupportedRecall)} />
            <Metric label="Pass rate" value={pct(agg.passRate)} />
            <Metric label="Avg relevance" value={agg.avgRelevance === null ? "—" : `${agg.avgRelevance.toFixed(1)}/5`} />
          </div>
        )}

        {/* Per-case table */}
        {results.length > 0 && (
          <section className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="data">
                <thead>
                  <tr>
                    <th>Question</th>
                    <th>Expected</th>
                    <th>Got</th>
                    <th>Intent</th>
                    <th>Rows</th>
                    <th>Judge</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r) => (
                    <tr key={r.case.id}>
                      <td className="max-w-[260px]">{r.case.question}</td>
                      <td className="text-xs text-[var(--color-muted)]">
                        {label(r.case.expectCriteria)}
                        {r.case.expectUnsupported.length > 0 && (
                          <span className="text-[var(--color-bad)]"> +{r.case.expectUnsupported.join(",")}</span>
                        )}
                      </td>
                      <td className="text-xs">
                        {label(r.gotCriteria)}
                        {r.gotUnsupported.length > 0 && (
                          <span className="text-[var(--color-bad)]"> +{r.gotUnsupported.join(",")}</span>
                        )}
                      </td>
                      <td>
                        {r.error ? (
                          <span className="chip chip-gap">error</span>
                        ) : r.score.pass ? (
                          <span className="chip chip-good">pass</span>
                        ) : (
                          <span className="chip chip-proxy">F1 {r.score.criteriaF1.toFixed(2)}</span>
                        )}
                      </td>
                      <td>{r.rowCount.toLocaleString()}</td>
                      <td>
                        {r.judge ? (
                          <span
                            className={`chip ${r.judge.verdict === "relevant" ? "chip-good" : r.judge.verdict === "partial" ? "chip-proxy" : "chip-gap"}`}
                            title={r.judge.reason}
                          >
                            {r.judge.relevance}/5
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {results.length === 0 && !running && (
          <div className="card p-5 text-sm text-[var(--color-muted)]">
            Run the benchmark to score intent parsing and result relevance across{" "}
            {EVAL_CASES.length} labeled questions. (The LLM judge needs an Anthropic key;
            uncheck it to score intent only.)
          </div>
        )}
      </main>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4">
      <div className="text-2xl font-bold stat-value">{value}</div>
      <div className="text-xs text-[var(--color-muted)] mt-1">{label}</div>
    </div>
  );
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function label(ids: string[]): string {
  if (ids.length === 0) return "—";
  return ids.map((id) => SIGNALS[id]?.label ?? id).join(", ");
}
