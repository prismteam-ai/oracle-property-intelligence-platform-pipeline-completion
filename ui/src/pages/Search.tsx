import { Fragment } from 'react';
import { IPFS_GATEWAY } from '../config';
import type { QueryResult } from '../lib/duckdb';
import Provenance, { ErrorBox, Spinner } from '../components/Provenance';
import {
  activeNotes,
  buildSearchQuery,
  DimFilter,
  DimKey,
  HIDDEN_COLUMNS,
  PRESETS,
  question,
  SearchFilters,
  WATER_QUESTION_ID,
} from '../searchQuery';

export const PAGE_SIZE = 50;

export interface SearchResultsState {
  status: 'idle' | 'loading' | 'done' | 'error';
  error?: string;
  result?: QueryResult;
  total?: number;
}

export interface ExpandedState {
  /** parcel_identifier of the expanded row. */
  propertyId: string;
  status: 'loading' | 'done' | 'error';
  error?: string;
  detail?: QueryResult;
}

// ---------- small controls ----------

function TextField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-slate-600">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="border border-slate-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 focus:border-slate-400"
      />
    </label>
  );
}

function NumField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-slate-600">{label}</span>
      <input
        type="number"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="border border-slate-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 focus:border-slate-400"
      />
    </label>
  );
}

/** A toggleable dimension filter with an inline numeric parameter. */
function DimControl({
  label,
  unit,
  value,
  onChange,
  proxy,
  represents,
}: {
  label: string;
  unit: string;
  value: DimFilter;
  onChange: (v: DimFilter) => void;
  proxy?: boolean;
  /** Plain-text of what this dimension actually computes (esp. for proxies). */
  represents?: string;
}) {
  return (
    <div
      className={`flex items-start justify-between gap-3 rounded border px-3 py-2 text-sm ${
        value.on ? 'border-slate-400 bg-slate-50' : 'border-slate-200 bg-white'
      }`}
    >
      <label className="flex items-start gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={value.on}
          onChange={(e) => onChange({ ...value, on: e.target.checked })}
          className="mt-0.5 h-4 w-4 rounded border-slate-300"
        />
        <span>
          <span className="text-slate-700">
            {label}
            {proxy && (
              <span className="ml-1.5 text-[10px] uppercase tracking-wide text-amber-600 border border-amber-200 bg-amber-50 rounded px-1 py-0.5">
                proxy
              </span>
            )}
          </span>
          {represents && (
            <span className="block text-[11px] leading-snug text-slate-400 mt-0.5">
              {represents}
            </span>
          )}
        </span>
      </label>
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          value={Number.isFinite(value.n) ? value.n : ''}
          onChange={(e) => onChange({ ...value, n: Number(e.target.value) })}
          className="w-20 border border-slate-300 rounded px-2 py-1 text-sm text-right focus:outline-none focus:ring-2 focus:ring-slate-400"
        />
        <span className="text-xs text-slate-500 w-14">{unit}</span>
      </div>
    </div>
  );
}

function cellStr(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function DetailGrid({ detail }: { detail: QueryResult }) {
  if (detail.rows.length === 0) {
    return (
      <p className="text-sm text-slate-500 py-2">
        Property detail lookup returned no row.
      </p>
    );
  }
  const row = detail.rows[0];
  const cidIdx = detail.columns.indexOf('property_cid');
  const cid = cidIdx >= 0 ? cellStr(row[cidIdx]) : '';
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1">
        {detail.columns.map((c, i) => (
          <div
            key={c}
            className="flex justify-between gap-3 text-xs py-0.5 border-b border-slate-100"
          >
            <span className="font-mono text-slate-500">{c}</span>
            <span className="text-slate-800 text-right break-all">
              {cellStr(row[i]) || '—'}
            </span>
          </div>
        ))}
      </div>
      {cid ? (
        <a
          href={`${IPFS_GATEWAY}${cid}`}
          target="_blank"
          rel="noreferrer"
          className="inline-block text-xs font-medium text-slate-700 border border-slate-300 rounded px-2.5 py-1 hover:bg-slate-100"
        >
          View source documents on IPFS ↗
        </a>
      ) : (
        <p className="text-xs text-slate-500">No property_cid on this row.</p>
      )}
    </div>
  );
}

// ---------- page ----------

export default function Search({
  filters,
  onFiltersChange,
  onSelectWater,
  waterSelected,
  propertyTypes,
  page,
  onPageChange,
  results,
  expanded,
  onToggleExpand,
}: {
  filters: SearchFilters;
  onFiltersChange: (f: SearchFilters) => void;
  onSelectWater: () => void;
  waterSelected: boolean;
  propertyTypes: string[];
  page: number;
  onPageChange: (p: number) => void;
  results: SearchResultsState;
  expanded: ExpandedState | null;
  onToggleExpand: (parcelId: string) => void;
}) {
  const res = results.result;
  const total = results.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const notes = activeNotes(filters);
  const waterQ = question(WATER_QUESTION_ID);

  const setDim = (key: DimKey, v: DimFilter) =>
    onFiltersChange({ ...filters, [key]: v });

  // Generated SQL reflects the CURRENT filters + page, live.
  const { pageSql } = buildSearchQuery(filters, page, PAGE_SIZE);

  const cidIdx = res ? res.columns.indexOf('property_cid') : -1;
  const pidIdx = res ? res.columns.indexOf('parcel_identifier') : -1;
  const visibleCols = res
    ? res.columns.filter((c) => !HIDDEN_COLUMNS.includes(c))
    : [];

  return (
    <div className="space-y-6">
      <p className="text-xs text-slate-500">
        DuckDB-WASM in your browser — no hosted database. Every filter below
        composes into one client-side SQL query over the content-addressed
        Parquet table.
      </p>

      {/* Presets: one per assignment question. */}
      <section className="space-y-2">
        <h2 className="text-base font-semibold text-slate-900">
          Property search
        </h2>
        <p className="text-sm text-slate-600 max-w-3xl">
          Start from an assignment question, then adjust any parameter — every
          control AND-composes into a single distinct-parcel query.
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() =>
                p.water ? onSelectWater() : onFiltersChange(p.filters!)
              }
              className="text-sm border border-slate-300 rounded-full px-3 py-1 hover:bg-slate-100 text-slate-700"
            >
              {p.label}
            </button>
          ))}
        </div>
      </section>

      {/* Filter panel. */}
      <section className="border border-slate-200 rounded bg-white p-4 space-y-4">
        {/* Real columns. */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <TextField
            label="City"
            value={filters.city}
            placeholder="e.g. Cape Coral"
            onChange={(v) => onFiltersChange({ ...filters, city: v })}
          />
          <TextField
            label="Street"
            value={filters.street}
            placeholder="e.g. Palm Ave"
            onChange={(v) => onFiltersChange({ ...filters, street: v })}
          />
          <TextField
            label="ZIP"
            value={filters.zip}
            placeholder="e.g. 33904"
            onChange={(v) => onFiltersChange({ ...filters, zip: v })}
          />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-slate-600">Property type</span>
            <select
              value={filters.propertyType}
              onChange={(e) =>
                onFiltersChange({ ...filters, propertyType: e.target.value })
              }
              className="border border-slate-300 rounded px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
            >
              <option value="">Any type</option>
              {propertyTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <NumField
              label="Built after"
              value={filters.builtMin}
              placeholder="1950"
              onChange={(v) => onFiltersChange({ ...filters, builtMin: v })}
            />
            <NumField
              label="Built before"
              value={filters.builtMax}
              placeholder="2010"
              onChange={(v) => onFiltersChange({ ...filters, builtMax: v })}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <NumField
              label="Value ≥ ($)"
              value={filters.valueMin}
              placeholder="100000"
              onChange={(v) => onFiltersChange({ ...filters, valueMin: v })}
            />
            <NumField
              label="Value ≤ ($)"
              value={filters.valueMax}
              placeholder="500000"
              onChange={(v) => onFiltersChange({ ...filters, valueMax: v })}
            />
          </div>
        </div>

        {/* Dimension filters. */}
        <div>
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">
            Intelligence dimensions
          </p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
            <DimControl
              label="Roof age ≥"
              unit="years"
              value={filters.roof}
              onChange={(v) => setDim('roof', v)}
              proxy
              represents="No roof data exists → stands in with building age ≥ N and no permit on record (roof presumed original)."
            />
            <DimControl
              label="Not sold in ≥"
              unit="years"
              value={filters.tenure}
              onChange={(v) => setDim('tenure', v)}
              represents="Parcel's most recent recorded sale is older than N years (sentinel/placeholder dates excluded)."
            />
            <DimControl
              label="Owner holds ≥"
              unit="parcels"
              value={filters.portfolio}
              onChange={(v) => setDim('portfolio', v)}
              proxy
              represents="No owner mailing address exists → 'regional owner' stands in with owners holding ≥ N parcels countywide."
            />
            <DimControl
              label="Within transit"
              unit="metres"
              value={filters.transit}
              onChange={(v) => setDim('transit', v)}
              proxy
              represents="Real haversine distance from each parcel to a small SAMPLE set of transit hubs (full GTFS lands with county ingest)."
            />
            <DimControl
              label="Within Starbucks"
              unit="metres"
              value={filters.starbucks}
              onChange={(v) => setDim('starbucks', v)}
              proxy
              represents="Real haversine distance to a small SAMPLE set of Starbucks locations (full places data lands with county ingest)."
            />
            {/* Water view: never a query input — no data exists. */}
            <div
              className={`flex items-center justify-between gap-3 rounded border px-3 py-2 text-sm ${
                waterSelected
                  ? 'border-slate-400 bg-slate-100'
                  : 'border-slate-200 bg-slate-50'
              }`}
            >
              <span className="flex items-center gap-2 text-slate-400">
                <input
                  type="checkbox"
                  disabled
                  aria-disabled="true"
                  className="h-4 w-4 rounded border-slate-200"
                />
                View of water
              </span>
              <span className="text-xs text-slate-400">
                Not available — requires geo enrichment
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Active honesty labels for any proxy / sample dimension in play. */}
      {(notes.length > 0 || waterSelected) && (
        <section className="space-y-2">
          {notes.map((q) => (
            <div
              key={q.id}
              className="text-xs text-slate-600 bg-amber-50 border border-amber-200 rounded px-3 py-2"
            >
              <span className="font-medium text-slate-700">
                {q.title.replace(/^[A-F]\.\s*/, '')} —{' '}
              </span>
              {q.dataBasis}
            </div>
          ))}
          {waterSelected && waterQ && (
            <div className="text-xs text-slate-600 bg-slate-100 border border-slate-200 rounded px-3 py-2">
              <span className="font-medium text-slate-700">
                View of water — deferred:{' '}
              </span>
              {waterQ.dataBasis}
            </div>
          )}
        </section>
      )}

      {/* Generated SQL — the DuckDB query-layer evidence, live. */}
      <details className="text-xs">
        <summary className="cursor-pointer text-slate-500 hover:text-slate-700 select-none">
          Generated SQL (runs in your browser)
        </summary>
        <pre className="mt-2 overflow-x-auto bg-slate-900 text-slate-100 rounded p-3 leading-relaxed">
          {pageSql}
        </pre>
      </details>

      {/* Results. */}
      {waterSelected ? (
        <div className="border border-dashed border-slate-300 rounded px-4 py-8 text-center text-sm text-slate-500 space-y-1">
          <p className="font-medium text-slate-600">No results computed</p>
          <p className="max-w-xl mx-auto">
            The water-view question is deferred — none of the 37 columns encode
            view or waterfront, so this app does not fabricate a result. It
            becomes a spatial join once shoreline geometry is ingested.
          </p>
        </div>
      ) : (
        <>
          {results.status === 'error' && (
            <ErrorBox message={results.error ?? 'Unknown error'} />
          )}
          {(results.status === 'loading' || results.status === 'idle') && (
            <Spinner label="Composing SQL over 511k rows via HTTP range reads…" />
          )}

          {results.status === 'done' && res && (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm text-slate-600">
                <span>
                  <span className="text-lg font-semibold tabular-nums text-slate-900">
                    {total.toLocaleString('en-US')}
                  </span>{' '}
                  distinct parcels
                  {total > 0 &&
                    ` · page ${page + 1} of ${pageCount.toLocaleString('en-US')}`}
                </span>
                <span className="flex gap-2">
                  <button
                    disabled={page === 0}
                    onClick={() => onPageChange(page - 1)}
                    className="px-2.5 py-1 border border-slate-300 rounded disabled:opacity-40 hover:bg-slate-50"
                  >
                    ← Prev
                  </button>
                  <button
                    disabled={page + 1 >= pageCount}
                    onClick={() => onPageChange(page + 1)}
                    className="px-2.5 py-1 border border-slate-300 rounded disabled:opacity-40 hover:bg-slate-50"
                  >
                    Next →
                  </button>
                </span>
              </div>

              {res.rows.length === 0 ? (
                <div className="border border-dashed border-slate-300 rounded px-4 py-6 text-center text-sm text-slate-500">
                  No parcels match these filters. Loosen a range or turn off a
                  dimension.
                </div>
              ) : (
                <div className="overflow-x-auto border border-slate-200 rounded">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200">
                        {visibleCols.map((c) => (
                          <th
                            key={c}
                            className="px-3 py-2 text-left font-medium text-slate-600 whitespace-nowrap"
                          >
                            {c}
                          </th>
                        ))}
                        <th className="px-3 py-2 text-left font-medium text-slate-600">
                          source
                        </th>
                        <th className="px-3 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {res.rows.map((row, i) => {
                        const pid =
                          pidIdx >= 0 ? cellStr(row[pidIdx]) : String(i);
                        const cid = cidIdx >= 0 ? cellStr(row[cidIdx]) : '';
                        const isOpen = expanded?.propertyId === pid;
                        return (
                          <Fragment key={pid || i}>
                            <tr
                              onClick={() => onToggleExpand(pid)}
                              className={`border-b border-slate-100 cursor-pointer hover:bg-slate-50 ${
                                isOpen ? 'bg-slate-50' : ''
                              }`}
                            >
                              {row
                                .filter(
                                  (_v, j) =>
                                    !HIDDEN_COLUMNS.includes(res.columns[j]),
                                )
                                .map((v, j) => (
                                  <td
                                    key={j}
                                    className={`px-3 py-1.5 whitespace-nowrap ${
                                      cellStr(v) === ''
                                        ? 'text-slate-300'
                                        : 'text-slate-800'
                                    }`}
                                  >
                                    {cellStr(v) || '—'}
                                  </td>
                                ))}
                              <td className="px-3 py-1.5 whitespace-nowrap">
                                {cid ? (
                                  <a
                                    href={`${IPFS_GATEWAY}${cid}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="text-xs text-slate-600 underline decoration-slate-300 hover:decoration-slate-600"
                                  >
                                    IPFS ↗
                                  </a>
                                ) : (
                                  <span className="text-xs text-slate-300">—</span>
                                )}
                              </td>
                              <td className="px-3 py-1.5 text-slate-400 text-xs whitespace-nowrap">
                                {isOpen ? '▲ close' : '▼ details'}
                              </td>
                            </tr>
                            {isOpen && (
                              <tr className="border-b border-slate-200">
                                <td
                                  colSpan={visibleCols.length + 2}
                                  className="px-4 py-3 bg-slate-50/60"
                                >
                                  {expanded.status === 'loading' && (
                                    <Spinner label="Loading all columns for this parcel…" />
                                  )}
                                  {expanded.status === 'error' && (
                                    <ErrorBox
                                      message={expanded.error ?? 'Unknown error'}
                                    />
                                  )}
                                  {expanded.status === 'done' &&
                                    expanded.detail && (
                                      <DetailGrid detail={expanded.detail} />
                                    )}
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <Provenance />
            </div>
          )}
        </>
      )}
    </div>
  );
}
