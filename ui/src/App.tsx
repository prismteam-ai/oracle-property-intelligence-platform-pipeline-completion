import { useCallback, useEffect, useRef, useState } from 'react';
import { COUNTY_LABEL, TABLE } from './config';
import {
  errorMessage,
  initDb,
  InitPhase,
  onPhaseChange,
  query,
  sqlString,
} from './lib/duckdb';
import Dashboard, {
  DashboardState,
  NameCount,
} from './pages/Dashboard';
import Search, {
  ExpandedState,
  PAGE_SIZE,
  SearchResultsState,
} from './pages/Search';
import {
  baseFilters,
  buildSearchQuery,
  SearchFilters,
} from './searchQuery';
import AskOracle, { ChatTurn } from './pages/AskOracle';
import About from './pages/About';
import { askOracle } from './lib/a2a';

// ---------- routing (path-based, no router dependency) ----------

const ROUTES = [
  { path: '/', label: 'Dashboard' },
  { path: '/search', label: 'Search' },
  { path: '/ask', label: 'Ask the Oracle' },
  { path: '/about', label: 'About' },
] as const;

function normalizeRoute(pathname: string): string {
  return ROUTES.some((r) => r.path === pathname) ? pathname : '/';
}

// ---------- defensive result parsing ----------

function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toNameCounts(rows: unknown[][]): NameCount[] {
  return rows.map((r) => ({
    name:
      r[0] === null || r[0] === undefined || String(r[0]).trim() === ''
        ? '(unknown)'
        : String(r[0]),
    count: toNum(r[1]),
  }));
}

// ---------- app ----------

export default function App() {
  const [route, setRoute] = useState(() => normalizeRoute(location.pathname));
  const [phase, setPhase] = useState<InitPhase>('idle');
  const [phaseDetail, setPhaseDetail] = useState<string>('');

  const [dashboard, setDashboard] = useState<DashboardState>({ status: 'idle' });

  const [filters, setFilters] = useState<SearchFilters>(() => baseFilters());
  const [waterSelected, setWaterSelected] = useState(false);
  const [propertyTypes, setPropertyTypes] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [searchResults, setSearchResults] = useState<SearchResultsState>({
    status: 'idle',
  });
  const [expanded, setExpanded] = useState<ExpandedState | null>(null);

  const [askTurns, setAskTurns] = useState<ChatTurn[]>([]);
  const [askInput, setAskInput] = useState('');
  const askContextId = useRef<string | null>(null);
  const askSeq = useRef(0);

  // -- engine init (once) --
  useEffect(() => {
    const off = onPhaseChange((p, detail) => {
      setPhase(p);
      setPhaseDetail(detail ?? '');
    });
    initDb().catch(() => {
      /* phase listener already captured the error message */
    });
    return off;
  }, []);

  // -- routing --
  useEffect(() => {
    const onPop = () => setRoute(normalizeRoute(location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((path: string) => {
    history.pushState(null, '', path);
    setRoute(normalizeRoute(path));
  }, []);

  // -- dashboard data --
  const loadDashboard = useCallback(async () => {
    setDashboard({ status: 'loading' });
    try {
      // All dashboard stats count DISTINCT PARCELS (duplicate rows collapsed),
      // matching the unit used by Demo Questions and the agent.
      const deduped = `(SELECT * FROM ${TABLE}
        QUALIFY row_number() OVER (PARTITION BY parcel_identifier ORDER BY property_id) = 1)`;
      const stats = await query(`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (latitude IS NOT NULL AND longitude IS NOT NULL) AS with_coords,
               COUNT(*) FILTER (property_cid IS NOT NULL AND property_cid <> '') AS with_cid,
               COUNT(*) FILTER (built_year IS NOT NULL AND built_year > 0) AS with_built_year,
               COUNT(*) FILTER (last_sale_date IS NOT NULL) AS with_sale_date,
               min(property_cid) AS sample_cid
        FROM ${deduped} t`);
      const cities = await query(`
        SELECT COALESCE(NULLIF(trim(address_city), ''), '(unknown)') AS city, COUNT(*) AS n
        FROM ${deduped} t GROUP BY 1 ORDER BY n DESC LIMIT 15`);
      const sources = await query(`
        SELECT COALESCE(NULLIF(trim(source_system), ''), '(unknown)') AS source, COUNT(*) AS n
        FROM ${deduped} t GROUP BY 1 ORDER BY n DESC`);
      const ptypes = await query(`
        SELECT COALESCE(NULLIF(trim(property_type), ''), '(unknown)') AS ptype, COUNT(*) AS n
        FROM ${deduped} t GROUP BY 1 ORDER BY n DESC LIMIT 10`);

      const s = stats.rows[0] ?? [];
      setDashboard({
        status: 'done',
        stats: {
          total: toNum(s[0]),
          withCoords: toNum(s[1]),
          withCid: toNum(s[2]),
          withBuiltYear: toNum(s[3]),
          withSaleDate: toNum(s[4]),
          sampleCid: s[5] ? String(s[5]) : null,
        },
        cities: toNameCounts(cities.rows),
        sources: toNameCounts(sources.rows),
        ptypes: toNameCounts(ptypes.rows),
      });
    } catch (err) {
      setDashboard({ status: 'error', error: errorMessage(err) });
    }
  }, []);

  useEffect(() => {
    if (phase === 'ready' && route === '/' && dashboard.status === 'idle') {
      void loadDashboard();
    }
  }, [phase, route, dashboard.status, loadDashboard]);

  // -- property-type options for the Search dropdown (loaded once) --
  const loadedPropertyTypes = useRef(false);
  useEffect(() => {
    if (phase !== 'ready' || loadedPropertyTypes.current) return;
    loadedPropertyTypes.current = true;
    void (async () => {
      try {
        const r = await query(`
          SELECT DISTINCT property_type FROM ${TABLE}
          WHERE property_type IS NOT NULL AND property_type <> ''
          ORDER BY property_type`);
        setPropertyTypes(r.rows.map((row) => String(row[0])));
      } catch {
        loadedPropertyTypes.current = false; // allow a retry
      }
    })();
  }, [phase]);

  // -- search (one composable query over the per-parcel base) --
  // Count is cached per full filter-set (not per page); paging only re-reads rows.
  const queryKey = JSON.stringify(filters);
  const lastCountKey = useRef<string | null>(null);
  const lastTotal = useRef<number>(0);
  const searchSeq = useRef(0);

  const runSearch = useCallback(
    async (f: SearchFilters, p: number, key: string) => {
      const seq = ++searchSeq.current;
      setSearchResults((prev) => ({ ...prev, status: 'loading' }));
      setExpanded(null);
      try {
        const { countSql, pageSql } = buildSearchQuery(f, p, PAGE_SIZE);

        let total = lastTotal.current;
        if (lastCountKey.current !== key) {
          const countRes = await query(countSql);
          if (seq !== searchSeq.current) return; // stale
          total = toNum(countRes.rows[0]?.[0]);
          lastCountKey.current = key;
          lastTotal.current = total;
        }

        const pageRes = await query(pageSql);
        if (seq !== searchSeq.current) return; // stale
        setSearchResults({ status: 'done', result: pageRes, total });
      } catch (err) {
        if (seq !== searchSeq.current) return;
        setSearchResults({ status: 'error', error: errorMessage(err) });
      }
    },
    [],
  );

  // Debounced: refires on filter edits (reset to page 0) and on page changes.
  // The water-view selection runs no query -- Search renders its deferred note.
  useEffect(() => {
    if (phase !== 'ready' || route !== '/search' || waterSelected) return;
    const t = setTimeout(
      () => void runSearch(filters, page, queryKey),
      searchResults.status === 'idle' ? 0 : 400,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, route, queryKey, page, waterSelected]);

  const handleFiltersChange = useCallback((f: SearchFilters) => {
    setFilters(f);
    setPage(0);
    setWaterSelected(false);
  }, []);

  const handleSelectWater = useCallback(() => {
    setFilters(baseFilters());
    setPage(0);
    setWaterSelected(true);
  }, []);

  const handleToggleExpand = useCallback(
    async (parcelId: string) => {
      if (expanded?.propertyId === parcelId) {
        setExpanded(null);
        return;
      }
      setExpanded({ propertyId: parcelId, status: 'loading' });
      try {
        const detail = await query(
          `SELECT * FROM ${TABLE} WHERE parcel_identifier = ${sqlString(parcelId)}
           ORDER BY property_id LIMIT 1`,
        );
        setExpanded((prev) =>
          prev?.propertyId === parcelId
            ? { propertyId: parcelId, status: 'done', detail }
            : prev,
        );
      } catch (err) {
        setExpanded((prev) =>
          prev?.propertyId === parcelId
            ? { propertyId: parcelId, status: 'error', error: errorMessage(err) }
            : prev,
        );
      }
    },
    [expanded],
  );

  // -- ask the oracle (A2A agent chat, session-only) --
  const runAsk = useCallback(async (id: number, question: string) => {
    try {
      const res = await askOracle(question, askContextId.current);
      if (res.contextId) askContextId.current = res.contextId;
      setAskTurns((prev) =>
        prev.map((t) =>
          t.id === id
            ? {
                ...t,
                status: 'done',
                answer: res.text ?? undefined,
                raw: res.text === null ? res.raw : undefined,
                sql: res.sql ?? undefined,
                elapsedMs: Date.now() - t.startedAt,
              }
            : t,
        ),
      );
    } catch (err) {
      setAskTurns((prev) =>
        prev.map((t) =>
          t.id === id
            ? {
                ...t,
                status: 'error',
                error: errorMessage(err),
                elapsedMs: Date.now() - t.startedAt,
              }
            : t,
        ),
      );
    }
  }, []);

  const handleAsk = useCallback(
    (q: string) => {
      const question = q.trim();
      if (!question) return;
      const id = ++askSeq.current;
      setAskTurns((prev) => [
        ...prev,
        { id, question, status: 'loading', startedAt: Date.now() },
      ]);
      setAskInput('');
      void runAsk(id, question);
    },
    [runAsk],
  );

  const handleAskRetry = useCallback(
    (id: number, question: string) => {
      setAskTurns((prev) =>
        prev.map((t) =>
          t.id === id
            ? { ...t, status: 'loading', error: undefined, startedAt: Date.now() }
            : t,
        ),
      );
      void runAsk(id, question);
    },
    [runAsk],
  );

  const askBusy = askTurns.some((t) => t.status === 'loading');

  // -- render --
  // /ask (A2A agent) and /about (static) don't touch DuckDB, so they never
  // wait on the engine.
  const engineNotReady =
    phase !== 'ready' && route !== '/ask' && route !== '/about';

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <a
              href="/"
              onClick={(e) => {
                e.preventDefault();
                navigate('/');
              }}
              className="inline-block"
            >
              <h1 className="text-lg font-semibold tracking-tight hover:text-slate-700">
                Oracle Property Intelligence
              </h1>
            </a>
            <p className="text-xs text-slate-500">
              {COUNTY_LABEL} ·{' '}
              <a
                href="/about"
                onClick={(e) => {
                  e.preventDefault();
                  navigate('/about');
                }}
                className="underline decoration-slate-300 hover:decoration-slate-600"
              >
                architecture &amp; provenance
              </a>
            </p>
          </div>
          <nav className="flex gap-1">
            {ROUTES.map((r) => (
              <a
                key={r.path}
                href={r.path}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(r.path);
                }}
                className={`px-3 py-1.5 text-sm rounded ${
                  route === r.path
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {r.label}
              </a>
            ))}
          </nav>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        {engineNotReady ? (
          <div className="border border-slate-200 rounded bg-white px-5 py-8 text-center space-y-2">
            {phase === 'error' ? (
              <>
                <p className="text-sm font-medium text-red-700">
                  DuckDB engine failed to start
                </p>
                <p className="text-xs font-mono text-red-600 break-all">
                  {phaseDetail}
                </p>
                <button
                  onClick={() => {
                    setPhase('idle');
                    initDb().catch(() => {});
                  }}
                  className="mt-2 px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-50"
                >
                  Retry
                </button>
              </>
            ) : (
              <>
                <div className="mx-auto h-6 w-6 rounded-full border-2 border-slate-300 border-t-slate-700 animate-spin" />
                <p className="text-sm text-slate-700">Starting the in-browser SQL engine</p>
                <p className="text-xs text-slate-500">
                  {phaseDetail || 'Preparing…'} — first load takes a few seconds.
                </p>
              </>
            )}
          </div>
        ) : (
          <>
            {route === '/' && (
              <Dashboard state={dashboard} onRetry={() => void loadDashboard()} />
            )}
            {route === '/search' && (
              <Search
                filters={filters}
                onFiltersChange={handleFiltersChange}
                onSelectWater={handleSelectWater}
                waterSelected={waterSelected}
                propertyTypes={propertyTypes}
                page={page}
                onPageChange={setPage}
                results={searchResults}
                expanded={expanded}
                onToggleExpand={(pid) => void handleToggleExpand(pid)}
              />
            )}
            {route === '/about' && <About />}
            {route === '/ask' && (
              <AskOracle
                turns={askTurns}
                input={askInput}
                onInputChange={setAskInput}
                busy={askBusy}
                onAsk={handleAsk}
                onRetry={handleAskRetry}
              />
            )}
          </>
        )}
      </main>

      <footer className="max-w-6xl mx-auto px-4 pb-8 text-xs text-slate-400">
        {COUNTY_LABEL} · zero standing infrastructure ·{' '}
        <a
          href="/about"
          onClick={(e) => {
            e.preventDefault();
            navigate('/about');
          }}
          className="underline decoration-slate-300 hover:decoration-slate-600"
        >
          architecture, IPFS artifacts &amp; MCP docs
        </a>
      </footer>
    </div>
  );
}
