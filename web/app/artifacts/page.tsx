"use client";

import { useEffect, useState } from "react";
import Nav from "@/components/Nav";
import McpConnect from "@/components/McpConnect";
import type { Manifest } from "@/lib/types";

export default function ArtifactsPage() {
  const [m, setM] = useState<Manifest | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/data/manifest.json")
      .then((r) => r.json())
      .then(setM)
      .catch((e) => setErr(String(e)));
  }, []);

  return (
    <>
      <Nav />
      <main className="max-w-6xl mx-auto px-5 py-8 space-y-5">
        <div>
          <h1 className="text-xl font-bold">IPFS artifacts</h1>
          <p className="text-sm text-[var(--color-muted)] mt-1">
            The query dataset is pinned to public IPFS via Filebase. Oracle runs
            no hosted database — the MCP server and this UI read these Parquet
            files directly.
          </p>
        </div>

        {err && <div className="card p-4 text-[var(--color-bad)] text-sm">{err}</div>}
        {!m && !err && <div className="text-sm text-[var(--color-muted)]">Loading…</div>}

        {m && (
          <>
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="chip">provider: {m.provider}</span>
              <span className="chip">county: {m.county}</span>
              <span className="chip">generated: {new Date(m.generatedAt).toLocaleString()}</span>
            </div>

            <section className="space-y-3">
              {m.artifacts.map((a) => (
                <div key={a.file} className="card p-4">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="font-mono text-sm">{a.file}</div>
                    <div className="text-xs text-[var(--color-muted)]">
                      {a.rows.toLocaleString()} rows · {(a.bytes / 1024).toFixed(0)} KB
                    </div>
                  </div>
                  <div className="mt-2 text-xs">
                    <span className="text-[var(--color-muted)]">CID: </span>
                    <span className="font-mono break-all">{a.cid}</span>
                  </div>
                  <a
                    href={a.gateway}
                    target="_blank"
                    rel="noreferrer"
                    className="link text-xs break-all"
                  >
                    {a.gateway}
                  </a>
                </div>
              ))}
            </section>

            <McpConnect queryUrl={m.propertyQueryTableMap["santa-clara"]} />

            <p className="text-xs text-[var(--color-muted)]">{m.note}</p>
          </>
        )}
      </main>
    </>
  );
}
