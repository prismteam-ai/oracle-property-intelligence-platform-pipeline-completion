import { DEMO_QUESTIONS, DemoQuestion, QuestionStatus } from '../demoQuestions';
import type { QueryResult } from '../lib/duckdb';
import Provenance, { ErrorBox, Spinner } from '../components/Provenance';
import DataTable from '../components/DataTable';

export interface QuestionRun {
  status: 'idle' | 'running' | 'done' | 'error';
  error?: string;
  count?: number | string;
  rows?: QueryResult;
}

const STATUS_STYLE: Record<QuestionStatus, { label: string; cls: string }> = {
  supported: {
    label: 'Fully supported by current columns',
    cls: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  partial: {
    label: 'Supported via labeled proxy / sample POIs',
    cls: 'bg-amber-50 text-amber-700 border-amber-200',
  },
  deferred: {
    label: 'Deferred — requires enrichment',
    cls: 'bg-slate-100 text-slate-500 border-slate-200',
  },
};

function QuestionCard({
  q,
  run,
  onRun,
}: {
  q: DemoQuestion;
  run: QuestionRun;
  onRun: () => void;
}) {
  const badge = STATUS_STYLE[q.status];
  return (
    <div className="border border-slate-200 rounded bg-white p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-medium text-slate-900">{q.title}</h3>
          <p className="text-sm text-slate-600">{q.question}</p>
        </div>
        <span className={`text-xs border rounded-full px-2.5 py-0.5 ${badge.cls}`}>
          {badge.label}
        </span>
      </div>

      <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded px-3 py-2">
        <span className="font-medium text-slate-700">Data basis: </span>
        {q.dataBasis}
      </div>

      {q.status === 'deferred' ? (
        <p className="text-sm text-slate-500 italic">
          No query is run for this question — the current schema cannot answer
          it honestly, and this app does not fabricate results.
        </p>
      ) : (
        <>
          <details className="text-xs">
            <summary className="cursor-pointer text-slate-500 hover:text-slate-700 select-none">
              Show SQL
            </summary>
            <pre className="mt-2 overflow-x-auto bg-slate-900 text-slate-100 rounded p-3 leading-relaxed">
              {q.rowsSql}
            </pre>
          </details>

          {run.status === 'idle' && (
            <button
              onClick={onRun}
              className="px-3 py-1.5 text-sm font-medium border border-slate-300 rounded hover:bg-slate-100"
            >
              Run query
            </button>
          )}
          {run.status === 'running' && (
            <Spinner label="Running against the remote Parquet table…" />
          )}
          {run.status === 'error' && (
            <div className="space-y-2">
              <ErrorBox message={run.error ?? 'Unknown error'} />
              <button
                onClick={onRun}
                className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-50"
              >
                Retry
              </button>
            </div>
          )}
          {run.status === 'done' && (
            <div className="space-y-2">
              <p className="text-sm text-slate-800">
                <span className="text-lg font-semibold tabular-nums">
                  {typeof run.count === 'number'
                    ? run.count.toLocaleString('en-US')
                    : (run.count ?? '—')}
                </span>{' '}
                {q.summaryLabel}
              </p>
              {run.rows && (
                <>
                  <p className="text-xs text-slate-500">
                    Sample of up to 25 matching rows:
                  </p>
                  <DataTable result={run.rows} />
                </>
              )}
              <Provenance />
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function DemoQuestionsPage({
  runs,
  onRun,
}: {
  runs: Record<string, QuestionRun>;
  onRun: (id: string) => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600 max-w-3xl">
        The six assignment questions, graded honestly against the 37 columns
        that actually exist in the live query table. Each card shows the SQL,
        the results, and exactly what the data can and cannot say.
      </p>
      {DEMO_QUESTIONS.map((q) => (
        <QuestionCard
          key={q.id}
          q={q}
          run={runs[q.id] ?? { status: 'idle' }}
          onRun={() => onRun(q.id)}
        />
      ))}
    </div>
  );
}
