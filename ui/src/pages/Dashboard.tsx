import { COUNTY_LABEL, IPFS_GATEWAY, QUERY_TABLE_URL } from '../config';
import Provenance, { ErrorBox, Spinner } from '../components/Provenance';

export interface NameCount {
  name: string;
  count: number;
}

export interface DashboardStats {
  total: number;
  withCoords: number;
  withCid: number;
  withBuiltYear: number;
  withSaleDate: number;
  sampleCid: string | null;
}

export interface DashboardState {
  status: 'idle' | 'loading' | 'done' | 'error';
  error?: string;
  stats?: DashboardStats;
  cities?: NameCount[];
  sources?: NameCount[];
  ptypes?: NameCount[];
}

function pct(part: number, whole: number): string {
  if (!whole) return '0%';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="border border-slate-200 rounded p-4 bg-white">
      <div className="text-xs uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold text-slate-900 tabular-nums">
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

function BarList({ title, items }: { title: string; items: NameCount[] }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <div className="border border-slate-200 rounded p-4 bg-white">
      <h3 className="text-sm font-medium text-slate-700 mb-3">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-slate-400">No data.</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((i) => (
            <li key={i.name} className="flex items-center gap-2 text-sm">
              <span className="w-40 shrink-0 truncate text-slate-600" title={i.name}>
                {i.name}
              </span>
              <span className="flex-1 h-3.5 bg-slate-100 rounded-sm overflow-hidden">
                <span
                  className="block h-full bg-slate-500 rounded-sm"
                  style={{ width: `${(i.count / max) * 100}%` }}
                />
              </span>
              <span className="w-20 shrink-0 text-right tabular-nums text-slate-700">
                {i.count.toLocaleString('en-US')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Dashboard({
  state,
  onRetry,
}: {
  state: DashboardState;
  onRetry: () => void;
}) {
  if (state.status === 'loading' || state.status === 'idle') {
    return <Spinner label="Running dashboard queries against the remote Parquet table…" />;
  }
  if (state.status === 'error') {
    return (
      <div className="space-y-3">
        <ErrorBox message={state.error ?? 'Unknown error'} />
        <button
          onClick={onRetry}
          className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-50"
        >
          Retry
        </button>
      </div>
    );
  }

  const s = state.stats;
  if (!s) {
    return (
      <div className="border border-dashed border-slate-300 rounded px-4 py-6 text-center text-sm text-slate-500">
        Dashboard queries returned no data.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label={`Properties · ${COUNTY_LABEL}`}
          value={s.total.toLocaleString('en-US')}
        />
        <StatCard
          label="Coordinate coverage"
          value={pct(s.withCoords, s.total)}
          sub={`${s.withCoords.toLocaleString('en-US')} rows with lat/lon`}
        />
        <StatCard
          label="Known build year"
          value={pct(s.withBuiltYear, s.total)}
          sub={`${s.withBuiltYear.toLocaleString('en-US')} rows`}
        />
        <StatCard
          label="Recorded last sale"
          value={pct(s.withSaleDate, s.total)}
          sub={`${s.withSaleDate.toLocaleString('en-US')} rows`}
        />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <BarList title="Properties by city (top 15)" items={state.cities ?? []} />
        <div className="space-y-4">
          <BarList title="Records by data source" items={state.sources ?? []} />
          <BarList title="Records by property type" items={state.ptypes ?? []} />
        </div>
      </div>

      <div className="border border-slate-200 rounded p-4 bg-white space-y-2">
        <h3 className="text-sm font-medium text-slate-700">Provenance</h3>
        <p className="text-sm text-slate-600">
          {s.withCid.toLocaleString('en-US')} of {s.total.toLocaleString('en-US')}{' '}
          rows ({pct(s.withCid, s.total)}) carry a{' '}
          <code className="font-mono text-xs bg-slate-100 px-1 py-0.5 rounded">
            property_cid
          </code>{' '}
          — a content identifier pinning the full source-document set for that
          property on IPFS. Every answer in this app traces back to it.
        </p>
        {s.sampleCid && (
          <p className="text-xs text-slate-500">
            Example:{' '}
            <a
              href={`${IPFS_GATEWAY}${s.sampleCid}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-slate-700 underline decoration-slate-300 hover:decoration-slate-600 break-all"
            >
              {s.sampleCid}
            </a>
          </p>
        )}
        <p className="text-xs text-slate-500 break-all">
          Query table: <span className="font-mono">{QUERY_TABLE_URL}</span>
        </p>
        <Provenance sourceSystems={(state.sources ?? []).map((x) => x.name)} />
      </div>
    </div>
  );
}
