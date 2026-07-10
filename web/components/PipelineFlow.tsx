"use client";

import type { RunReport, Manifest } from "@/lib/types";

/**
 * Visual pipeline: Sources -> Ingest -> Transform -> IPFS -> Query.
 * Makes the "real data -> cheap storage -> queryable" architecture legible at a
 * glance, with live counts from the run report and IPFS manifest.
 */

interface Stage {
  key: string;
  label: string;
  detail: string;
  metric: string;
  icon: React.ReactNode;
}

const I = {
  sources: (
    <path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 5c0 1.7 3.6 3 8 3s8-1.3 8-3M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7" />
  ),
  ingest: <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" />,
  transform: (
    <path d="M4 7h11m-4-3 3 3-3 3M20 17H9m4 3-3-3 3-3" />
  ),
  ipfs: (
    <>
      <path d="M12 2 3 7v10l9 5 9-5V7l-9-5Z" />
      <path d="M12 2v20M3 7l9 5 9-5M3 17l9-5 9 5" />
    </>
  ),
  query: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
};

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-[18px] h-[18px]"
    >
      {children}
    </svg>
  );
}

export default function PipelineFlow({
  report,
  manifest,
}: {
  report: RunReport | null;
  manifest: Manifest | null;
}) {
  const connectors = report?.runs.length ?? 0;
  const total = report?.grandTotalRecords ?? 0;
  const properties = report?.dbTotals.find((t) => t.entity === "property")?.records ?? 0;
  const cids = manifest?.artifacts.length ?? 0;

  const stages: Stage[] = [
    { key: "sources", label: "Sources", detail: "SCC parcels · PA permits · OSM", metric: `${connectors} connectors`, icon: I.sources },
    { key: "ingest", label: "Ingest", detail: "DuckDB · raw + provenance", metric: `${total.toLocaleString()} records`, icon: I.ingest },
    { key: "transform", label: "Transform", detail: "APN reconcile · spatial signals", metric: `${properties.toLocaleString()} properties`, icon: I.transform },
    { key: "ipfs", label: "IPFS", detail: "Filebase · Parquet, no hosted DB", metric: cids ? `${cids} CIDs` : "pending", icon: I.ipfs },
    { key: "query", label: "Query", detail: "UI · Agent · MCP", metric: "6 questions", icon: I.query },
  ];

  return (
    <div className="flex flex-col md:flex-row items-stretch gap-2">
      {stages.map((s, i) => (
        <div key={s.key} className="flex items-center gap-2 flex-1">
          <div className="pipeline-card p-4 flex-1 h-full">
            <div className="flex items-center gap-2.5">
              <span className="pipeline-badge w-8 h-8 rounded-lg flex items-center justify-center">
                <Icon>{s.icon}</Icon>
              </span>
              <div className="leading-tight">
                <div className="text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
                  Step {i + 1}
                </div>
                <div className="text-sm font-semibold">{s.label}</div>
              </div>
            </div>
            <div className="text-xs text-[var(--color-muted)] mt-2.5">{s.detail}</div>
            <div className="pipeline-metric inline-block text-xs font-mono mt-2 px-2 py-0.5 rounded-md">
              {s.metric}
            </div>
          </div>
          {i < stages.length - 1 && (
            <span className="pipeline-arrow hidden md:block shrink-0" aria-hidden />
          )}
        </div>
      ))}
    </div>
  );
}
