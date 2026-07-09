import type { QueryResult } from '../lib/duckdb';

function formatCell(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') {
    // Comma-group only large integers; years/ages/distances stay plain.
    return Number.isInteger(v) && Math.abs(v) >= 10000
      ? v.toLocaleString('en-US')
      : String(v);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

function isEmptyish(v: unknown): boolean {
  return v === null || v === undefined || v === '';
}

export default function DataTable({
  result,
  emptyMessage = 'No rows matched this query.',
}: {
  result: QueryResult;
  emptyMessage?: string;
}) {
  if (result.rows.length === 0) {
    return (
      <div className="border border-dashed border-slate-300 rounded px-4 py-6 text-center text-sm text-slate-500">
        {emptyMessage}
      </div>
    );
  }
  return (
    <div className="overflow-x-auto border border-slate-200 rounded">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="bg-slate-50 border-b border-slate-200">
            {result.columns.map((c) => (
              <th
                key={c}
                className="px-3 py-2 text-left font-medium text-slate-600 whitespace-nowrap"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr
              key={i}
              className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50"
            >
              {row.map((v, j) => (
                <td
                  key={j}
                  className={`px-3 py-1.5 whitespace-nowrap tabular-nums ${
                    isEmptyish(v) ? 'text-slate-300' : 'text-slate-800'
                  }`}
                >
                  {formatCell(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
