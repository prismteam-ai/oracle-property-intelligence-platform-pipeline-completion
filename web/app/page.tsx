"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Nav from "@/components/Nav";
import PipelineFlow from "@/components/PipelineFlow";
import { QUESTIONS, type QuestionKind } from "@/lib/questions";
import type { RunReport, Manifest } from "@/lib/types";

const KIND_CHIP: Record<QuestionKind, { cls: string; label: string }> = {
  real: { cls: "chip-good", label: "real data" },
  proxy: { cls: "chip-proxy", label: "proxy" },
  gap: { cls: "chip-gap", label: "data gap" },
};

export default function HomePage() {
  const [report, setReport] = useState<RunReport | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/data/run-report.json").then((r) => r.json()).then(setReport).catch((e) => setErr(String(e)));
    fetch("/data/manifest.json").then((r) => r.json()).then(setManifest).catch(() => {});
  }, []);

  return (
    <>
      <Nav />
      <main className="max-w-6xl mx-auto px-5 py-8 space-y-8">
        {/* Hero */}
        <section className="space-y-2">
          <div className="chip">Santa Clara County · Palo Alto</div>
          <h1 className="text-4xl font-bold tracking-tight gradient-text leading-[1.1]">
            Property intelligence with<br />no hosted database
          </h1>
          <p className="text-sm text-[var(--color-muted)] max-w-2xl">
            Real public data → DuckDB → IPFS → MCP. The dataset lives on public
            IPFS; the UI and agent query it on demand, so there is no ongoing
            Oracle infrastructure cost.
          </p>
          <div className="flex gap-2 pt-1">
            <Link href="/explore" className="btn btn-primary">Explore the 6 questions</Link>
            <Link href="/artifacts" className="btn btn-ghost">IPFS artifacts</Link>
          </div>
        </section>

        {err && <div className="card p-4 text-[var(--color-bad)] text-sm">{err}</div>}

        {/* Pipeline flow */}
        <section className="space-y-2">
          <h2 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">Pipeline</h2>
          <PipelineFlow report={report} manifest={manifest} />
        </section>

        {/* Stats */}
        {report && (
          <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Total records" value={report.grandTotalRecords.toLocaleString()} />
            {report.dbTotals.map((t) => (
              <Stat key={t.entity} label={`${t.entity} records`} value={t.records.toLocaleString()} />
            ))}
          </section>
        )}

        {/* Question coverage */}
        <section className="space-y-2">
          <h2 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
            Question coverage
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {QUESTIONS.map((q) => {
              const chip = KIND_CHIP[q.kind];
              const rail = q.kind === "real" ? "rail-good" : q.kind === "proxy" ? "rail-proxy" : "rail-gap";
              return (
                <Link key={q.id} href="/explore" className={`card qcard ${rail} p-4 pl-5`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold">{q.title}</span>
                    <span className={`chip ${chip.cls}`}>{chip.label}</span>
                  </div>
                  <p className="text-xs text-[var(--color-muted)] mt-1">{q.subtitle}</p>
                </Link>
              );
            })}
          </div>
        </section>

        {/* Sources */}
        {report && (
          <section className="card p-5">
            <h2 className="font-semibold mb-3">Sources loaded</h2>
            <div className="overflow-x-auto">
              <table className="data">
                <thead>
                  <tr><th>Connector</th><th>Entity</th><th>Records</th><th>Source</th><th>Fetched</th></tr>
                </thead>
                <tbody>
                  {report.runs.map((r) => (
                    <tr key={r.connector}>
                      <td className="font-mono text-xs">{r.connector}</td>
                      <td>{r.entity}</td>
                      <td>{r.count.toLocaleString()}</td>
                      <td className="text-[var(--color-muted)]">{r.source}</td>
                      <td className="text-[var(--color-muted)] text-xs">{new Date(r.finishedAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Constraints */}
        {report && (
          <section className="card p-5">
            <h2 className="font-semibold mb-3">Documented source constraints</h2>
            <div className="space-y-3">
              {report.constraints.map((c, i) => (
                <div key={i} className="border-l-2 border-[var(--color-proxy)] pl-3">
                  <div className="flex items-center gap-2">
                    <span className="chip chip-proxy">{c.status}</span>
                    <span className="text-sm font-medium">{c.source}</span>
                  </div>
                  <p className="text-xs text-[var(--color-muted)] mt-1">{c.detail}</p>
                  <p className="text-xs mt-1">Affects: <span className="text-[var(--color-muted)]">{c.affects.join(", ")}</span></p>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-5">
      <div className="text-3xl font-bold stat-value">{value}</div>
      <div className="text-xs text-[var(--color-muted)] mt-1.5 capitalize tracking-wide">{label}</div>
    </div>
  );
}
