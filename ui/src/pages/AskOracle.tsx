import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AGENT_A2A_URL } from '../config';
import { ErrorBox } from '../components/Provenance';

export interface ChatTurn {
  id: number;
  question: string;
  status: 'loading' | 'error' | 'done';
  /** Markdown answer text (absent when parsing found no text part). */
  answer?: string;
  /** Raw JSON-RPC response, kept only when no answer text was parsed. */
  raw?: unknown;
  error?: string;
  startedAt: number;
  elapsedMs?: number;
}

/** The assignment's demo prompts, verbatim. */
const PRESETS = [
  'Which properties have roofs older than 15 years and have not exchanged ownership in more than 10 years?',
  'Which properties are near public transportation and also have regional owners?',
  'Which properties appear to be strong candidates for further review based on ownership age, roof age, and location signals?',
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

function TurnCard({
  turn,
  onRetry,
}: {
  turn: ChatTurn;
  onRetry: () => void;
}) {
  const done = fmtElapsed(turn.elapsedMs);
  return (
    <div className="border border-slate-200 rounded bg-white">
      <div className="px-4 py-3 border-b border-slate-100 flex items-start justify-between gap-3">
        <p className="text-sm text-slate-900">
          <span className="text-xs uppercase tracking-wide text-slate-400 mr-2">
            You
          </span>
          {turn.question}
        </p>
        {done && (
          <span className="text-xs text-slate-400 whitespace-nowrap tabular-nums">
            {done}
          </span>
        )}
      </div>
      <div className="px-4 py-3">
        {turn.status === 'loading' && (
          <div className="flex items-start gap-3 py-1">
            <span className="mt-0.5 inline-block h-4 w-4 shrink-0 rounded-full border-2 border-slate-300 border-t-slate-600 animate-spin" />
            <div className="text-sm text-slate-600">
              <p>
                Thinking… <ElapsedTimer startedAt={turn.startedAt} /> elapsed
              </p>
              <p className="text-xs text-slate-500 mt-1">
                Agent turns take 20s–3min: it is running live SQL over the
                IPFS-hosted Parquet.
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
            <AnswerMarkdown text={turn.answer} />
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-amber-700">
                The agent replied, but no answer text could be parsed from the
                response — raw payload below.
              </p>
              <RawJson raw={turn.raw} />
            </div>
          ))}
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
  useEffect(() => {
    if (turns.length) endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [turns.length, lastStatus]);

  const submit = () => {
    if (!busy && input.trim()) onAsk(input);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600 max-w-3xl">
        Ask the Oracle agent a question in plain English. It writes and runs
        read-only SQL against the live IPFS-hosted query table, then answers
        with source-backed evidence and CID provenance.
      </p>

      <div className="border border-slate-200 rounded bg-white p-4 space-y-3">
        <textarea
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          rows={3}
          placeholder="e.g. How many properties in Cape Coral were built before 1980?"
          className="w-full border border-slate-300 rounded px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-slate-400"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-slate-400">Cmd/Ctrl+Enter to submit</p>
          <button
            onClick={submit}
            disabled={busy || !input.trim()}
            className="px-4 py-1.5 text-sm font-medium rounded bg-slate-900 text-white hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? 'Waiting for the agent…' : 'Ask'}
          </button>
        </div>
        <div className="border-t border-slate-100 pt-3 space-y-1.5">
          <p className="text-xs text-slate-500">Demo questions (one click):</p>
          <div className="flex flex-col gap-1.5">
            {PRESETS.map((q) => (
              <button
                key={q}
                onClick={() => !busy && onAsk(q)}
                disabled={busy}
                className="text-left text-xs text-slate-600 border border-slate-200 rounded px-3 py-1.5 hover:bg-slate-50 hover:border-slate-300 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      </div>

      {turns.length === 0 ? (
        <p className="text-sm text-slate-400 italic">
          No questions asked yet this session.
        </p>
      ) : (
        <div className="space-y-3">
          {turns.map((t) => (
            <TurnCard
              key={t.id}
              turn={t}
              onRetry={() => onRetry(t.id, t.question)}
            />
          ))}
          <div ref={endRef} />
        </div>
      )}

      <p className="text-xs text-slate-400 border-t border-slate-200 pt-3">
        This page talks to the agent over the A2A protocol (agent card:{' '}
        <a
          href={`${AGENT_A2A_URL}/.well-known/agent-card.json`}
          target="_blank"
          rel="noreferrer"
          className="underline decoration-slate-300 hover:text-slate-600"
        >
          /.well-known/agent-card.json
        </a>
        ) — the same interface external agents use.
      </p>
    </div>
  );
}
