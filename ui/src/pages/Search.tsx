import { Fragment } from 'react';
import { IPFS_GATEWAY } from '../config';
import type { QueryResult } from '../lib/duckdb';
import Provenance, { ErrorBox, Spinner } from '../components/Provenance';

export const PAGE_SIZE = 50;

export interface SearchFilters {
  city: string;
  street: string;
  zip: string;
}

export interface SearchResultsState {
  status: 'idle' | 'loading' | 'done' | 'error';
  error?: string;
  result?: QueryResult;
  total?: number;
}

export interface ExpandedState {
  propertyId: string;
  status: 'loading' | 'done' | 'error';
  error?: string;
  detail?: QueryResult;
}

function Field({
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
          <div key={c} className="flex justify-between gap-3 text-xs py-0.5 border-b border-slate-100">
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

export default function Search({
  filters,
  onFiltersChange,
  page,
  onPageChange,
  results,
  expanded,
  onToggleExpand,
}: {
  filters: SearchFilters;
  onFiltersChange: (f: SearchFilters) => void;
  page: number;
  onPageChange: (p: number) => void;
  results: SearchResultsState;
  expanded: ExpandedState | null;
  onToggleExpand: (propertyId: string) => void;
}) {
  const res = results.result;
  const total = results.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pidIdx = res ? res.columns.indexOf('property_id') : -1;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-3xl">
        <Field
          label="City"
          value={filters.city}
          placeholder="e.g. Cape Coral"
          onChange={(v) => onFiltersChange({ ...filters, city: v })}
        />
        <Field
          label="Street"
          value={filters.street}
          placeholder="e.g. Palm Ave"
          onChange={(v) => onFiltersChange({ ...filters, street: v })}
        />
        <Field
          label="ZIP"
          value={filters.zip}
          placeholder="e.g. 33904"
          onChange={(v) => onFiltersChange({ ...filters, zip: v })}
        />
      </div>

      {results.status === 'error' && (
        <ErrorBox message={results.error ?? 'Unknown error'} />
      )}
      {(results.status === 'loading' || results.status === 'idle') && (
        <Spinner label="Searching 511k rows over HTTP range reads…" />
      )}

      {results.status === 'done' && res && (
        <>
          <div className="flex items-center justify-between text-sm text-slate-600">
            <span>
              {total.toLocaleString('en-US')} matching properties
              {total > 0 && ` · page ${page + 1} of ${pageCount.toLocaleString('en-US')}`}
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
              No properties match these filters. Try a broader city, street, or ZIP.
            </div>
          ) : (
            <div className="overflow-x-auto border border-slate-200 rounded">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    {res.columns
                      .filter((c) => c !== 'property_id' && c !== 'property_cid')
                      .map((c) => (
                        <th
                          key={c}
                          className="px-3 py-2 text-left font-medium text-slate-600 whitespace-nowrap"
                        >
                          {c}
                        </th>
                      ))}
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {res.rows.map((row, i) => {
                    const pid = pidIdx >= 0 ? cellStr(row[pidIdx]) : String(i);
                    const isOpen = expanded?.propertyId === pid;
                    return (
                      <Fragment key={pid}>
                        <tr
                          onClick={() => onToggleExpand(pid)}
                          className={`border-b border-slate-100 cursor-pointer hover:bg-slate-50 ${
                            isOpen ? 'bg-slate-50' : ''
                          }`}
                        >
                          {row
                            .filter(
                              (_v, j) =>
                                res.columns[j] !== 'property_id' &&
                                res.columns[j] !== 'property_cid',
                            )
                            .map((v, j) => (
                              <td
                                key={j}
                                className={`px-3 py-1.5 whitespace-nowrap ${
                                  cellStr(v) === '' ? 'text-slate-300' : 'text-slate-800'
                                }`}
                              >
                                {cellStr(v) || '—'}
                              </td>
                            ))}
                          <td className="px-3 py-1.5 text-slate-400 text-xs">
                            {isOpen ? '▲ close' : '▼ details'}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="border-b border-slate-200">
                            <td
                              colSpan={res.columns.length - 1}
                              className="px-4 py-3 bg-slate-50/60"
                            >
                              {expanded.status === 'loading' && (
                                <Spinner label="Loading all columns for this property…" />
                              )}
                              {expanded.status === 'error' && (
                                <ErrorBox message={expanded.error ?? 'Unknown error'} />
                              )}
                              {expanded.status === 'done' && expanded.detail && (
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
        </>
      )}
    </div>
  );
}
