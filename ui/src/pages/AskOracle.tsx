import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AGENT_A2A_URL } from '../config';
import { ErrorBox } from '../components/Provenance';
import { errorMessage, query, QueryResult } from '../lib/duckdb';

export interface ChatTurn {
  id: number;
  question: string;
  status: 'loading' | 'error' | 'done';
  /** Markdown answer text (absent when parsing found no text part). */
  answer?: string;
  /** Raw JSON-RPC response, kept only when no answer text was parsed. */
  raw?: unknown;
  /**
   * The exact SQL the agent ran via queryProperties (structured, from history).
   * Absent when the turn ran no query (clarification / refusal / chat).
   */
  sql?: string;
  error?: string;
  startedAt: number;
  elapsedMs?: number;
}

// ---------- CSV export (RFC-4180) ----------

/** Quote one CSV field per RFC-4180 (quote if it holds , " CR or LF). */
function csvField(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(result: QueryResult): string {
  const header = result.columns.map(csvField).join(',');
  const body = result.rows.map((r) => r.map(csvField).join(',')).join('\r\n');
  return body ? `${header}\r\n${body}` : header;
}

function downloadCsv(result: QueryResult): void {
  const blob = new Blob([toCsv(result)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `oracle-query-${ts}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * The assignment's demo prompts. `q` is the VERBATIM question sent to the
 * agent; `label` is a short chip caption so the input tray stays compact.
 */
const PRESETS = [
  {
    label: 'Roof age + ownership tenure',
    q: 'Which properties have roofs older than 15 years and have not exchanged ownership in more than 10 years?',
  },
  {
    label: 'Near transit + regional owners',
    q: 'Which properties are near public transportation and also have regional owners?',
  },
  {
    label: 'Strong review candidates',
    q: 'Which properties appear to be strong candidates for further review based on ownership age, roof age, and location signals?',
  },
] as const;

function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000));
  return <span className="tabular-nums font-medium">{secs}s</span>;
}

function fmtElapsed(ms?: number): string | null {
  if (ms === undefined) return null;
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/**
 * Strip fenced SQL from the agent's markdown summary.
 *
 * The agent sometimes echoes its query as a ```sql (or bare ```) fence inside
 * the prose. Since the dedicated "View SQL" block is now the single home for
 * the query, we remove those fences UI-side (the raw A2A response is left
 * untouched, so external A2A peers still get the self-contained answer).
 * We drop a fence when it is tagged `sql` OR its body starts with SELECT/WITH,
 * plus any orphaned "SQL used:"-style label line left immediately before it.
 */
function stripSqlFences(md: string): string {
  const fence = /(^|\n)[ \t]*```[^\n`]*\n([\s\S]*?)```[ \t]*(?=\n|$)/g;
  let out = md.replace(fence, (full, pre: string, body: string) => {
    const isSql = /^\s*(select|with)\b/i.test(body) || /```sql/i.test(full);
    return isSql ? pre : full;
  });
  // Remove now-orphaned label lines (whole line is just "SQL used:" / "Query:" …).
  out = out.replace(
    /(^|\n)[ \t]*(?:\*\*)?\s*(?:sql used|sql|query used|query)\s*(?:\*\*)?[ \t]*:?[ \t]*(?=\n|$)/gi,
    '$1',
  );
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** Markdown renderer tuned for the agent's answers (tables, SQL blocks). */
function AnswerMarkdown({ text }: { text: string }) {
  return (
    <div className="text-sm text-slate-800 leading-relaxed space-y-3 [&_p]:my-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (p) => <h3 className="text-base font-semibold mt-2" {...p} />,
          h2: (p) => <h3 className="text-base font-semibold mt-2" {...p} />,
          h3: (p) => <h4 className="text-sm font-semibold mt-2" {...p} />,
          ul: (p) => <ul className="list-disc pl-5 space-y-1" {...p} />,
          ol: (p) => <ol className="list-decimal pl-5 space-y-1" {...p} />,
          a: (p) => (
            <a
              className="text-slate-700 underline decoration-slate-300 hover:decoration-slate-600 break-all"
              target="_blank"
              rel="noreferrer"
              {...p}
            />
          ),
          pre: (p) => (
            <pre
              className="overflow-x-auto bg-slate-900 text-slate-100 rounded p-3 text-xs leading-relaxed"
              {...p}
            />
          ),
          code: ({ className, children, ...rest }) => {
            const block = /language-/.test(className ?? '');
            return block ? (
              <code className={className} {...rest}>
                {children}
              </code>
            ) : (
              <code
                className="bg-slate-100 border border-slate-200 rounded px-1 py-0.5 text-[0.85em] font-mono break-all"
                {...rest}
              >
                {children}
              </code>
            );
          },
          table: (p) => (
            <div className="overflow-x-auto border border-slate-200 rounded">
              <table className="min-w-full text-xs" {...p} />
            </div>
          ),
          thead: (p) => <thead className="bg-slate-50" {...p} />,
          th: (p) => (
            <th
              className="text-left font-medium text-slate-600 px-3 py-2 border-b border-slate-200 whitespace-nowrap"
              {...p}
            />
          ),
          td: (p) => (
            <td
              className="px-3 py-1.5 border-b border-slate-100 align-top font-mono text-[11px] text-slate-700"
              {...p}
            />
          ),
          blockquote: (p) => (
            <blockquote
              className="border-l-2 border-slate-300 pl-3 text-slate-600"
              {...p}
            />
          ),
          hr: () => <hr className="border-slate-200" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function RawJson({ raw }: { raw: unknown }) {
  let pretty: string;
  try {
    pretty = JSON.stringify(raw, null, 2);
  } catch {
    pretty = String(raw);
  }
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-slate-500 hover:text-slate-700 select-none">
        Show raw A2A response
      </summary>
      <pre className="mt-2 overflow-x-auto max-h-96 bg-slate-900 text-slate-100 rounded p-3 leading-relaxed">
        {pretty}
      </pre>
    </details>
  );
}

/** Strip a trailing semicolon so the SQL can be wrapped in a subquery. */
function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;\s*$/, '');
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'done'; result: QueryResult };

/**
 * Re-runs the agent's SQL in the browser's DuckDB-WASM to produce a raw-data
 * preview (capped at 100 rows) and a full-export CSV download (unlimited).
 * The agent's SQL says `FROM properties`, which resolves to the view created
 * over the remote Parquet at DuckDB init — so it runs verbatim here.
 */
function QueryResultBlock({ sql }: { sql: string }) {
  const clean = stripTrailingSemicolon(sql);
  const [preview, setPreview] = useState<PreviewState>({ status: 'loading' });
  const [downloading, setDownloading] = useState(false);
  const [exported, setExported] = useState<number | null>(null);
  const [downloadErr, setDownloadErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setPreview({ status: 'loading' });
    setExported(null);
    setDownloadErr(null);
    query(`SELECT * FROM (${clean}) LIMIT 100`)
      .then((result) => {
        if (alive) setPreview({ status: 'done', result });
      })
      .catch((err) => {
        if (alive) setPreview({ status: 'error', error: errorMessage(err) });
      });
    return () => {
      alive = false;
    };
  }, [clean]);

  const handleDownload = async () => {
    setDownloading(true);
    setDownloadErr(null);
    try {
      const full = await query(clean); // verbatim, no LIMIT — unlimited rows
      downloadCsv(full);
      setExported(full.rows.length);
    } catch (err) {
      setDownloadErr(errorMessage(err));
    } finally {
      setDownloading(false);
    }
  };

  // When the preview came back under the cap, its length is the true total.
  const previewResult = preview.status === 'done' ? preview.result : null;
  const capped = previewResult ? previewResult.rows.length >= 100 : false;
  const knownCount =
    previewResult && !capped ? previewResult.rows.length : null;

  return (
    <div className="mt-3 border-t border-slate-100 pt-3 space-y-2">
      <details className="text-xs group">
        <summary className="cursor-pointer text-slate-500 hover:text-slate-700 select-none font-medium">
          <span className="inline-block group-open:rotate-90 transition-transform mr-1">
            ▸
          </span>
          View SQL
        </summary>
        <pre className="mt-2 overflow-x-auto bg-slate-900 text-slate-100 rounded p-3 text-[11px] leading-relaxed">
          {clean}
        </pre>
      </details>

      {preview.status === 'loading' && (
        <div className="flex items-center gap-2 text-xs text-slate-500 py-1">
          <span className="inline-block h-3.5 w-3.5 shrink-0 rounded-full border-2 border-slate-300 border-t-slate-600 animate-spin" />
          Running the agent&rsquo;s SQL in your browser&hellip;
        </div>
      )}

      {preview.status === 'error' && (
        <p className="text-xs text-amber-700">
          Raw-data export unavailable for this query.
          <span className="block mt-0.5 font-mono text-[11px] text-amber-600 break-all">
            {preview.error}
          </span>
        </p>
      )}

      {previewResult && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium text-slate-600">
              Raw data
              <span className="ml-1.5 font-normal text-slate-400">
                {knownCount !== null
                  ? `${knownCount} row${knownCount === 1 ? '' : 's'}`
                  : 'preview — first 100 rows'}
              </span>
            </p>
            <div className="flex items-center gap-2">
              {exported !== null && (
                <span className="text-xs text-slate-400 tabular-nums">
                  exported {exported} row{exported === 1 ? '' : 's'}
                </span>
              )}
              <button
                onClick={() => void handleDownload()}
                disabled={downloading}
                className="px-3 py-1 text-xs font-medium rounded border border-slate-300 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {downloading ? 'Exporting…' : 'Download CSV'}
              </button>
            </div>
          </div>
          {downloadErr && (
            <p className="text-xs text-amber-700 font-mono break-all">
              {downloadErr}
            </p>
          )}
          <RawDataTable result={previewResult} />
        </div>
      )}
    </div>
  );
}

/** Compact scrollable preview table for a browser query result. */
function RawDataTable({ result }: { result: QueryResult }) {
  if (result.rows.length === 0) {
    return (
      <p className="text-xs text-slate-400 italic">
        Query returned no rows.
      </p>
    );
  }
  return (
    <div className="overflow-auto border border-slate-200 rounded max-h-80">
      <table className="min-w-full text-[11px]">
        <thead className="bg-slate-50 sticky top-0">
          <tr>
            {result.columns.map((c) => (
              <th
                key={c}
                className="text-left font-medium text-slate-600 px-3 py-1.5 border-b border-slate-200 whitespace-nowrap"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i} className="odd:bg-white even:bg-slate-50/50">
              {row.map((cell, j) => (
                <td
                  key={j}
                  className="px-3 py-1 border-b border-slate-100 align-top font-mono text-slate-700 whitespace-nowrap max-w-xs truncate"
                  title={cell === null ? '' : String(cell)}
                >
                  {cell === null ? (
                    <span className="text-slate-300">null</span>
                  ) : (
                    String(cell)
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A single conversation turn rendered as chat bubbles (user + agent). */
function TurnBubbles({
  turn,
  onRetry,
}: {
  turn: ChatTurn;
  onRetry: () => void;
}) {
  const done = fmtElapsed(turn.elapsedMs);
  return (
    <div className="space-y-2">
      {/* user message — right aligned */}
      <div className="flex justify-end">
        <div className="max-w-[80%] bg-slate-900 text-white rounded-2xl rounded-br-sm px-4 py-2 text-sm whitespace-pre-wrap break-words">
          {turn.question}
        </div>
      </div>

      {/* agent message — left aligned */}
      <div className="flex justify-start">
        <div className="max-w-[95%] min-w-0 bg-white border border-slate-200 rounded-2xl rounded-bl-sm px-4 py-3 shadow-sm">
          {turn.status === 'loading' && (
            <div className="flex items-start gap-3 py-0.5">
              <span className="mt-0.5 inline-block h-4 w-4 shrink-0 rounded-full border-2 border-slate-300 border-t-slate-600 animate-spin" />
              <div className="text-sm text-slate-600">
                <p>
                  Thinking… <ElapsedTimer startedAt={turn.startedAt} /> elapsed
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  The agent writes SQL and runs it over the IPFS-hosted Parquet
                  via the MCP tool — usually 5–15s.
                </p>
              </div>
            </div>
          )}
          {turn.status === 'error' && (
            <div className="space-y-2">
              <ErrorBox message={turn.error ?? 'Unknown error'} />
              <button
                onClick={onRetry}
                className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-50"
              >
                Retry
              </button>
            </div>
          )}
          {turn.status === 'done' &&
            (turn.answer !== undefined ? (
              <>
                <AnswerMarkdown
                  text={turn.sql ? stripSqlFences(turn.answer) : turn.answer}
                />
                {turn.sql && <QueryResultBlock sql={turn.sql} />}
              </>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-amber-700">
                  The agent replied, but no answer text could be parsed from the
                  response — raw payload below.
                </p>
                <RawJson raw={turn.raw} />
              </div>
            ))}
          {done && (
            <p className="mt-2 text-[10px] text-slate-400 tabular-nums">
              answered in {done}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AskOracle({
  turns,
  input,
  onInputChange,
  busy,
  onAsk,
  onRetry,
}: {
  turns: ChatTurn[];
  input: string;
  onInputChange: (v: string) => void;
  busy: boolean;
  onAsk: (question: string) => void;
  onRetry: (id: number, question: string) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const lastStatus = turns.length ? turns[turns.length - 1].status : 'none';
  // Auto-scroll to the newest turn whenever one is added or its status changes
  // (new question appears, answer arrives) — keeps the latest exchange in view.
  useEffect(() => {
    if (turns.length) endRef.current?.scrollIntoView({ block: 'end' });
  }, [turns.length, lastStatus]);

  const submit = () => {
    if (!busy && input.trim()) onAsk(input);
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600 max-w-3xl">
        A live conversation with the Oracle agent over the A2A protocol. It
        writes read-only SQL, runs it over the IPFS-hosted query table, and
        answers with source-backed evidence — follow-ups refine the previous
        turn, so the thread below is the shared context.
      </p>

      {/* chat window: scrolling thread above, input pinned at the bottom */}
      <div className="flex flex-col h-[calc(100vh-13rem)] min-h-[30rem] border border-slate-200 rounded-lg bg-slate-50 overflow-hidden">
        {/* thread */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {turns.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center gap-2 px-6">
              <p className="text-sm text-slate-500">
                Ask a property-intelligence question to start the conversation.
              </p>
              <p className="text-xs text-slate-400 max-w-md">
                Each answer shows the agent&rsquo;s prose summary, the exact SQL
                it ran (▸ View SQL), a raw-data preview, and a full CSV export
                your browser produces by re-running that SQL in-process.
              </p>
            </div>
          ) : (
            turns.map((t) => (
              <TurnBubbles
                key={t.id}
                turn={t}
                onRetry={() => onRetry(t.id, t.question)}
              />
            ))
          )}
          <div ref={endRef} />
        </div>

        {/* composer, pinned */}
        <div className="border-t border-slate-200 bg-white px-3 py-3 space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => !busy && onAsk(p.q)}
                disabled={busy}
                title={p.q}
                className="text-xs text-slate-600 border border-slate-200 rounded-full px-3 py-1 hover:bg-slate-50 hover:border-slate-300 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={2}
              placeholder="e.g. How many properties in Cape Coral were built before 1980?"
              className="flex-1 border border-slate-300 rounded px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
            <button
              onClick={submit}
              disabled={busy || !input.trim()}
              className="shrink-0 px-4 py-2 text-sm font-medium rounded bg-slate-900 text-white hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? 'Waiting…' : 'Ask'}
            </button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-slate-400">
            <span>Cmd/Ctrl+Enter to submit · one turn at a time</span>
            <span>
              A2A protocol · agent card:{' '}
              <a
                href={`${AGENT_A2A_URL}/.well-known/agent-card.json`}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-slate-300 hover:text-slate-600"
              >
                /.well-known/agent-card.json
              </a>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
