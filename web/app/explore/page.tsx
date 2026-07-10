"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Nav from "@/components/Nav";
import type { MapPoint } from "@/components/PropertyMap";
import { QUESTIONS, type Question, type QuestionKind } from "@/lib/questions";
import { query } from "@/lib/duck";
import { exploreCache } from "@/lib/store";
import {
  SIGNALS,
  UNSUPPORTED,
  buildSql,
  intentCaveats,
  type ParsedIntent,
} from "@/lib/intent";

// MapLibre touches browser globals on load; keep it client-only.
const PropertyMap = dynamic(() => import("@/components/PropertyMap"), { ssr: false });

const KIND_CHIP: Record<QuestionKind, { cls: string; label: string }> = {
  real: { cls: "chip-good", label: "real data" },
  proxy: { cls: "chip-proxy", label: "proxy" },
  gap: { cls: "chip-gap", label: "data gap" },
};

const TABLE_CAP = 500;

interface UnifiedResult {
  mode: "preset" | "agent";
  title: string;
  kind?: QuestionKind;
  basis?: string; // preset basis
  intent?: ParsedIntent; // agent
  caveats?: string[];
  sql: string;
  rowCount: number;
  rows: Record<string, unknown>[];
  columns: string[];
  answer?: string; // agent summary
}

export default function ExplorePage() {
  const [question, setQuestion] = useState(exploreCache.question);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [err, setErr] = useState("");
  const [result, setResult] = useState<UnifiedResult | null>(
    (exploreCache.result as UnifiedResult | null) ?? null,
  );

  // Persist the last search across tab navigation.
  useEffect(() => {
    exploreCache.result = result;
  }, [result]);

  // Empty-state preview: a sample map of the county + at-a-glance counts.
  const [preview, setPreview] = useState<{
    points: MapPoint[];
    counts: Record<string, number>;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [pts, agg] = await Promise.all([
          query(
            "SELECT latitude, longitude, request_identifier FROM properties USING SAMPLE 500 ROWS",
          ),
          query(`SELECT
              count(*) FILTER (WHERE roof_over_15) AS roof,
              count(*) FILTER (WHERE water_view) AS water,
              count(*) FILTER (WHERE permit_dormant_10yr) AS dormant,
              count(*) FILTER (WHERE near_transit) AS transit,
              count(*) FILTER (WHERE near_starbucks) AS starbucks
            FROM properties`),
        ]);
        if (cancelled) return;
        const c = agg[0] ?? {};
        setPreview({
          points: pts.map((r) => ({
            latitude: Number(r.latitude),
            longitude: Number(r.longitude),
            label: String(r.request_identifier ?? ""),
          })),
          counts: {
            roof: Number(c.roof ?? 0),
            water: Number(c.water ?? 0),
            dormant: Number(c.dormant ?? 0),
            transit: Number(c.transit ?? 0),
            starbucks: Number(c.starbucks ?? 0),
          },
        });
      } catch {
        /* preview is best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Preset question — deterministic, no LLM. Always works. */
  async function runPreset(q: Question) {
    setBusy(true);
    setErr("");
    setResult(null);
    setQuestion("");
    setStage(`Running “${q.title}”…`);
    try {
      const rows = await query(q.sql);
      setResult({
        mode: "preset",
        title: q.title,
        kind: q.kind,
        basis: q.basis,
        sql: q.sql,
        rowCount: rows.length,
        rows: rows.slice(0, TABLE_CAP),
        columns: q.columns,
      });
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
      setStage("");
    }
  }

  /** Free-text question — intent agent -> deterministic SQL -> answer agent. */
  async function runAgent(q: string) {
    setBusy(true);
    setErr("");
    setResult(null);
    try {
      setStage("Parsing intent…");
      const intentRes = await fetch("/api/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      if (!intentRes.ok) throw new Error((await intentRes.json()).error ?? "intent failed");
      const intent = (await intentRes.json()) as ParsedIntent;
      const sql = buildSql(intent);
      const caveats = intentCaveats(intent);

      setStage("Running query in DuckDB-WASM…");
      const rows = await query(sql);

      setStage("Summarizing…");
      const ansRes = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phase: "answer", question: q, sql, rowCount: rows.length, rows: rows.slice(0, 30) }),
      });
      const answer = ansRes.ok ? (await ansRes.json()).answer : "";

      const columns = rows[0]
        ? Object.keys(rows[0]).filter((c) => c !== "latitude" && c !== "longitude")
        : [];
      setResult({
        mode: "agent",
        title: q,
        intent,
        caveats,
        sql,
        rowCount: rows.length,
        rows: rows.slice(0, TABLE_CAP),
        columns,
        answer,
      });
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
      setStage("");
    }
  }

  const points: MapPoint[] = (result?.rows ?? [])
    .map((r) => ({
      latitude: Number(r.latitude),
      longitude: Number(r.longitude),
      label: String(r.request_identifier ?? ""),
    }))
    .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));

  return (
    <>
      <Nav />
      <main className="max-w-6xl mx-auto px-5 py-8 space-y-5">
        <div>
          <h1 className="text-xl font-bold">Explore</h1>
          <p className="text-sm text-[var(--color-muted)] mt-1">
            Pick one of the six questions, or ask your own. Either way the query
            runs in your browser (DuckDB-WASM) — the same path the MCP server exposes.
          </p>
        </div>

        {/* Free-text ask */}
        <div className="flex gap-2">
          <input
            value={question}
            onChange={(e) => {
              setQuestion(e.target.value);
              exploreCache.question = e.target.value;
            }}
            onKeyDown={(e) => e.key === "Enter" && !busy && question.trim() && runAgent(question)}
            placeholder="Ask your own question, e.g. “waterfront homes near transit that haven’t sold in a decade”"
            className="flex-1 rounded-lg bg-[var(--color-panel-2)] border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          <button className="btn btn-primary" disabled={busy || !question.trim()} onClick={() => runAgent(question)}>
            {busy ? "Working…" : "Ask"}
          </button>
        </div>

        {/* Preset questions */}
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--color-muted)] mb-2">
            The six questions
          </div>
          <div className="flex flex-wrap gap-2">
            {QUESTIONS.map((q) => {
              const chip = KIND_CHIP[q.kind];
              const active = result?.mode === "preset" && result.title === q.title;
              return (
                <button
                  key={q.id}
                  onClick={() => runPreset(q)}
                  disabled={busy}
                  className={`px-3 py-2 rounded-lg text-sm text-left border flex items-center gap-2 ${
                    active
                      ? "border-[var(--color-accent)] bg-[var(--color-panel)]"
                      : "border-[var(--color-border)] bg-[var(--color-panel-2)] text-[var(--color-muted)] hover:text-[var(--color-text)]"
                  }`}
                >
                  {q.title}
                  <span className={`chip ${chip.cls}`}>{chip.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {busy && (
          <div className="text-sm text-[var(--color-muted)]">
            <span className="thinking-dot">●</span> {stage}
          </div>
        )}
        {err && <div className="card p-4 text-[var(--color-bad)] text-sm">{err}</div>}

        {/* Empty state — before any query is run */}
        {!result && !busy && !err && (
          <div className="space-y-5">
            <div>
              <div className="text-xs uppercase tracking-wide text-[var(--color-muted)] mb-2">
                At a glance
              </div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                {[
                  { qid: "roof-over-15", label: "Roofs likely >15 yrs", count: preview?.counts.roof, rail: "rail-good" },
                  { qid: "near-starbucks", label: "Near a Starbucks", count: preview?.counts.starbucks, rail: "rail-good" },
                  { qid: "near-transit", label: "Near public transit", count: preview?.counts.transit, rail: "rail-good" },
                  { qid: "water-view", label: "Possible water view", count: preview?.counts.water, rail: "rail-good" },
                  { qid: "no-sale-10yr", label: "Permit-dormant 10 yr+", count: preview?.counts.dormant, rail: "rail-proxy" },
                ].map((g) => (
                  <button
                    key={g.qid}
                    onClick={() => {
                      const q = QUESTIONS.find((x) => x.id === g.qid);
                      if (q) runPreset(q);
                    }}
                    className={`card qcard ${g.rail} p-4 pl-5 text-left`}
                  >
                    <div className="text-2xl font-bold stat-value">
                      {g.count === undefined ? "…" : g.count.toLocaleString()}
                    </div>
                    <div className="text-xs text-[var(--color-muted)] mt-1">{g.label}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="card p-5">
              <div className="text-xs uppercase tracking-wide text-[var(--color-muted)] mb-3">
                How it works
              </div>
              <div className="grid md:grid-cols-3 gap-5 text-sm">
                <Step n="1" title="Parse intent" body="An agent maps your question to structured criteria over the property signals — and flags anything the data can't answer." />
                <Step n="2" title="Query in-browser" body="DuckDB-WASM runs the SQL on the Parquet locally. No server database — the same file the MCP server reads from IPFS." />
                <Step n="3" title="Explain with sources" body="A second agent summarizes the matches, cites the sources, and labels any proxy or data gap." />
              </div>
            </div>

            {preview && preview.points.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-wide text-[var(--color-muted)] mb-2">
                  Palo Alto · sample of {preview.points.length} parcels
                </div>
                <PropertyMap points={preview.points} />
              </div>
            )}
          </div>
        )}

        {result && (
          <>
            {/* Result header — adapts to preset vs agent */}
            <section className="card p-5 space-y-3">
              {result.mode === "preset" ? (
                <>
                  <div className="flex items-center gap-3">
                    <h2 className="font-semibold">{result.title}</h2>
                    {result.kind && (
                      <span className={`chip ${KIND_CHIP[result.kind].cls}`}>
                        {KIND_CHIP[result.kind].label}
                      </span>
                    )}
                  </div>
                  <div className="rounded-lg bg-[var(--color-panel-2)] border border-[var(--color-border)] p-3 text-xs text-[var(--color-muted)]">
                    <b className="text-[var(--color-text)]">Basis &amp; source: </b>
                    {result.basis}
                  </div>
                </>
              ) : (
                <>
                  <div className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
                    Parsed intent
                  </div>
                  <div className="text-sm">{result.intent?.summary}</div>
                  <div className="flex flex-wrap gap-2">
                    {result.intent?.criteria.map((id) => {
                      const s = SIGNALS[id];
                      if (!s) return null;
                      return (
                        <span key={id} className={`chip ${s.kind === "proxy" ? "chip-proxy" : "chip-good"}`}>
                          {s.kind === "proxy" ? "proxy · " : "✓ "}
                          {s.label}
                        </span>
                      );
                    })}
                    {result.intent?.criteria.length === 0 && (
                      <span className="text-xs text-[var(--color-muted)]">no filters — all properties</span>
                    )}
                    {result.intent?.unsupported.map((u, i) => (
                      <span key={i} className="chip chip-gap" title={UNSUPPORTED[u.id]}>
                        ✕ {u.requested} — not available
                      </span>
                    ))}
                  </div>
                  {result.caveats && result.caveats.length > 0 && (
                    <ul className="text-xs text-[var(--color-muted)] space-y-1 border-t border-[var(--color-border)] pt-3">
                      {result.caveats.map((c, i) => (
                        <li key={i}>• {c}</li>
                      ))}
                    </ul>
                  )}
                </>
              )}

              <div className="text-sm">
                <b>{result.rowCount.toLocaleString()}</b> matching{" "}
                {result.rowCount === 1 ? "property" : "properties"}
                {result.rowCount > TABLE_CAP && (
                  <span className="text-[var(--color-muted)]"> (showing first {TABLE_CAP})</span>
                )}
              </div>

              <details className="text-xs text-[var(--color-muted)]">
                <summary className="cursor-pointer">SQL</summary>
                <pre className="bg-[var(--color-panel-2)] border border-[var(--color-border)] rounded-lg p-2 mt-2 overflow-x-auto">
                  {result.sql}
                </pre>
              </details>
            </section>

            {/* Agent natural-language answer */}
            {result.mode === "agent" && result.answer && (
              <section className="card p-5">
                <div className="text-xs uppercase tracking-wide text-[var(--color-muted)] mb-2">Answer</div>
                <div className="text-sm whitespace-pre-wrap">{result.answer}</div>
              </section>
            )}

            {points.length > 0 && <PropertyMap points={points} />}

            {result.rows.length > 0 && (
              <section className="card overflow-hidden">
                <div className="max-h-[420px] scroll overflow-y-auto">
                  <table className="data">
                    <thead>
                      <tr>{result.columns.map((c) => <th key={c}>{c}</th>)}</tr>
                    </thead>
                    <tbody>
                      {result.rows.map((r, i) => (
                        <tr key={i}>
                          {result.columns.map((c) => (
                            <td key={c}>{fmt(r[c])}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {result.rowCount === 0 && (
              <div className="card p-5 text-sm text-[var(--color-muted)]">
                No matching properties — see the basis above.
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="flex gap-3">
      <span className="pipeline-badge w-7 h-7 rounded-lg flex items-center justify-center text-sm font-bold shrink-0">
        {n}
      </span>
      <div>
        <div className="font-semibold">{title}</div>
        <div className="text-xs text-[var(--color-muted)] mt-1">{body}</div>
      </div>
    </div>
  );
}

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number" && !Number.isInteger(v)) return String(Math.round(v));
  return String(v);
}
