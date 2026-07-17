import {
  AlertTriangle,
  ArrowRight,
  Bot,
  Check,
  Clipboard,
  Code2,
  Database,
  ExternalLink,
  FileJson,
  Filter,
  Layers3,
  Network,
  Play,
  Search,
  ServerCog,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import { useMemo, useState, type SyntheticEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import {
  displayValue,
  isRecord,
  rowsFromData,
  truthStateFrom,
  useApiQuery,
  valueFor,
} from './api.js';
import { useOracle } from './app-context.js';
import {
  EnvelopeNotes,
  EvidenceTable,
  PageHeader,
  ReleaseBar,
  ResultViews,
  StatePanel,
  TruthBadge,
  type TableColumn,
} from './components.js';
import type { ApiEnvelope, ApplicationOperation, DataRow } from './types.js';

type FormSubmitEvent = SyntheticEvent<HTMLFormElement, SubmitEvent>;

function formString(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}

const inquiries = [
  {
    slug: 'roof-age',
    operation: 'inquiry.roofAge',
    title: 'Roofs older than 15 years',
    shortTitle: 'Roof age',
    description:
      'Strict matches require conclusive completed or finaled roof replacement evidence. Building age and missing recent permits remain visible proxies, never roof facts.',
    modeLabel: 'Direct evidence required',
    fields: [
      { key: 'minimumAgeYears', label: 'Minimum roof age (years)', type: 'number', value: '15' },
      { key: 'includeProxy', label: 'Include clearly labeled proxy candidates', type: 'checkbox' },
    ],
  },
  {
    slug: 'water-candidates',
    operation: 'inquiry.waterCandidates',
    title: 'Potential water-view candidates',
    shortTitle: 'Water candidates',
    description:
      'Mapped water proximity and terrain signals identify review candidates. This does not verify an actual view from a building.',
    modeLabel: 'Derived candidate semantics',
    fields: [
      {
        key: 'maximumDistanceMeters',
        label: 'Maximum water distance (m)',
        type: 'number',
        value: '5000',
      },
      {
        key: 'minimumTerrainConfidence',
        label: 'Minimum terrain confidence',
        type: 'number',
        value: '0.5',
        step: '0.1',
      },
      { key: 'includeProxy', label: 'Include proximity-only proxies', type: 'checkbox' },
    ],
  },
  {
    slug: 'ownership-age',
    operation: 'inquiry.ownershipAge',
    title: 'No ownership exchange in more than 10 years',
    shortTitle: 'Ownership age',
    description:
      'A positive result requires supported current ownership, a verified transfer date, and sufficient source coverage through the release as-of date.',
    modeLabel: 'Complete coverage required',
    fields: [
      { key: 'minimumTenureYears', label: 'Minimum tenure (years)', type: 'number', value: '10' },
      {
        key: 'requireCompleteCoverage',
        label: 'Require complete ownership-source coverage',
        type: 'checkbox',
        checked: true,
      },
    ],
  },
  {
    slug: 'regional-owner',
    operation: 'inquiry.regionalOwner',
    title: 'Properties with regional owners',
    shortTitle: 'Regional owner',
    description:
      'The versioned Bay Area nine-county policy applies only to a verified current owner mailing region. Public results never expose raw owner identity.',
    modeLabel: 'Verified ownership required',
    fields: [],
  },
  {
    slug: 'transit-walkability',
    operation: 'inquiry.transitWalkability',
    title: 'Walking distance to public transportation',
    shortTitle: 'Transit walkability',
    description:
      'Supported results require a pedestrian-network route to an active passenger-boardable stop. Straight-line distance is a proxy.',
    modeLabel: 'Pedestrian route required',
    fields: [
      {
        key: 'maximumNetworkDistanceMeters',
        label: 'Maximum network distance (m)',
        type: 'number',
        value: '800',
      },
      {
        key: 'maximumSnapDistanceMeters',
        label: 'Maximum snap distance (m)',
        type: 'number',
        value: '150',
      },
      { key: 'includeProxy', label: 'Include straight-line proxies', type: 'checkbox' },
    ],
  },
  {
    slug: 'starbucks-walkability',
    operation: 'inquiry.starbucksWalkability',
    title: 'Walking distance to Starbucks',
    shortTitle: 'Starbucks walkability',
    description:
      'Supported results bind a qualified Overture place to a pinned pedestrian route, including place identity, attribution, distance, and graph version.',
    modeLabel: 'Qualified place + route required',
    fields: [
      {
        key: 'maximumNetworkDistanceMeters',
        label: 'Maximum network distance (m)',
        type: 'number',
        value: '800',
      },
      {
        key: 'minimumValidationConfidence',
        label: 'Minimum place confidence',
        type: 'number',
        value: '0.8',
        step: '0.1',
      },
      { key: 'includeProxy', label: 'Include straight-line proxies', type: 'checkbox' },
    ],
  },
] as const;

type Inquiry = (typeof inquiries)[number];

function useReleaseQuery(
  operation: ApplicationOperation,
  parameters: Readonly<Record<string, unknown>>,
  enabled = true,
) {
  const { client, releaseId } = useOracle();
  return useApiQuery(
    client,
    operation,
    releaseId === null ? parameters : { releaseId, ...parameters },
    enabled && releaseId !== null,
  );
}

function ReleaseGate({
  children,
}: Readonly<{ children: (release: ApiEnvelope) => React.ReactNode }>) {
  const { release } = useOracle();
  return (
    <StatePanel
      state={release}
      onRetry={release.retry}
      emptyTitle="Release metadata is empty"
      emptyDetail="The API returned no immutable release metadata."
    >
      {children}
    </StatePanel>
  );
}

function metricsFrom(value: unknown): readonly DataRow[] {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter(([, metric]) => ['string', 'number', 'boolean'].includes(typeof metric))
    .map(([name, metric]) => ({ name, metric }));
}

export function OverviewPage() {
  const coverage = useReleaseQuery('dataset.getCoverage', {});
  return (
    <>
      <PageHeader
        eyebrow="Santa Clara County evaluator"
        title="Property intelligence with evidence in the foreground."
        description="Explore the immutable county release, inspect support and coverage before acting, and reproduce every inquiry from its URL parameters."
        actions={
          <Link className="button primary" to="/properties">
            Explore properties <ArrowRight aria-hidden="true" />
          </Link>
        }
      />
      <ReleaseGate>
        {(release) => (
          <>
            <ReleaseBar envelope={release} />
            <section className="overview-layout" aria-label="County release overview">
              <div className="overview-main">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Inquiry presets</p>
                    <h2>Six assignment questions, one evidence contract</h2>
                  </div>
                </div>
                <div className="inquiry-grid">
                  {inquiries.map((inquiry, index) => (
                    <Link
                      className="inquiry-card"
                      to={`/inquiries/${inquiry.slug}`}
                      key={inquiry.slug}
                    >
                      <span className="card-number">0{index + 1}</span>
                      <span className="semantic-label">
                        <ShieldCheck aria-hidden="true" /> {inquiry.modeLabel}
                      </span>
                      <h3>{inquiry.shortTitle}</h3>
                      <p>{inquiry.description}</p>
                      <span className="card-link">
                        Open preset <ArrowRight aria-hidden="true" />
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
              <aside className="overview-aside">
                <p className="eyebrow">Verified county metrics</p>
                <StatePanel state={coverage} onRetry={coverage.retry}>
                  {(data) => {
                    const metrics = metricsFrom(data.coverage);
                    return metrics.length === 0 ? (
                      <div className="inline-empty">
                        No scalar coverage metrics were returned. No totals have been invented.
                      </div>
                    ) : (
                      <dl className="metric-list">
                        {metrics.map((row) => (
                          <div key={String(row.name)}>
                            <dt>{displayValue(row.name)}</dt>
                            <dd>{displayValue(row.metric)}</dd>
                          </div>
                        ))}
                      </dl>
                    );
                  }}
                </StatePanel>
                <div className="architecture-note">
                  <ShieldCheck aria-hidden="true" />
                  <div>
                    <strong>Portable by design</strong>
                    <p>Immutable artifacts + DuckDB + scale-to-zero API/MCP composition.</p>
                    <Link to="/about/architecture">Review architecture</Link>
                  </div>
                </div>
              </aside>
            </section>
          </>
        )}
      </ReleaseGate>
    </>
  );
}

const pipelineColumns: readonly TableColumn[] = [
  { label: 'Run / source', keys: ['runId', 'sourceId', 'id', 'name'] },
  { label: 'Status', keys: ['status', 'state'], kind: 'truth' },
  { label: 'Observed', keys: ['observed', 'observedCount', 'recordCount'] },
  { label: 'Rejected', keys: ['rejected', 'rejectedCount'] },
  { label: 'Timestamp', keys: ['completedAt', 'collectedAt', 'timestamp', 'asOf'] },
];

export function PipelinePage() {
  const query = useReleaseQuery('pipeline.listRuns', { limit: 25 });
  return (
    <>
      <PageHeader
        eyebrow="Pipeline operations"
        title="Run history and source constraints"
        description="Every count and stage comes from the immutable release. Blocked or constrained sources stay visible instead of disappearing from coverage."
      />
      <ReleaseGate>
        {(release) => (
          <>
            <ReleaseBar envelope={release} />
            <StatePanel state={query} onRetry={query.retry}>
              {(data) => (
                <>
                  <EvidenceTable
                    caption="Release-bound pipeline runs and stages"
                    rows={rowsFromData(data.data)}
                    columns={pipelineColumns}
                  />
                  <EnvelopeNotes envelope={data} />
                </>
              )}
            </StatePanel>
          </>
        )}
      </ReleaseGate>
    </>
  );
}

export function CoveragePage() {
  const query = useReleaseQuery('dataset.getCoverage', {});
  return (
    <>
      <PageHeader
        eyebrow="Coverage"
        title="What the release can—and cannot—support"
        description="Denominators, source freshness, linked records, and blocked capabilities belong beside every claim. Unknown never becomes a positive result."
      />
      <ReleaseGate>
        {(release) => (
          <>
            <ReleaseBar envelope={release} />
            <StatePanel state={query} onRetry={query.retry}>
              {(data) => {
                const rows = rowsFromData(data.data);
                return (
                  <>
                    <EvidenceTable
                      caption="Dataset and source coverage"
                      rows={rows}
                      columns={[
                        { label: 'Dataset / source', keys: ['dataset', 'source', 'name', 'id'] },
                        {
                          label: 'Support',
                          keys: ['supportState', 'state', 'status'],
                          kind: 'truth',
                        },
                        { label: 'Expected', keys: ['expected', 'expectedCount', 'denominator'] },
                        { label: 'Observed', keys: ['observed', 'observedCount', 'numerator'] },
                        { label: 'Linked', keys: ['linked', 'linkedCount'] },
                        { label: 'As of', keys: ['asOf', 'collectedAt', 'freshness'] },
                      ]}
                    />
                    <EnvelopeNotes envelope={data} />
                  </>
                );
              }}
            </StatePanel>
          </>
        )}
      </ReleaseGate>
    </>
  );
}

function parsePositive(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    throw new Error(`${label} must be greater than zero.`);
  return number;
}

export function PropertiesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryText = searchParams.get('q') ?? '';
  const city = searchParams.get('city') ?? '';
  const postalCode = searchParams.get('postalCode') ?? '';
  const query = useReleaseQuery('property.search', {
    limit: 25,
    sort: 'address',
    ...(queryText === '' ? {} : { query: queryText }),
    ...(city === '' ? {} : { city }),
    ...(postalCode === '' ? {} : { postalCode }),
  });

  function submit(event: FormSubmitEvent) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next = new URLSearchParams();
    for (const key of ['q', 'city', 'postalCode']) {
      const value = formString(data, key).trim();
      if (value !== '') next.set(key, value);
    }
    setSearchParams(next);
  }

  return (
    <>
      <PageHeader
        eyebrow="Property explorer"
        title="Search canonical property identities"
        description="Search safe public identifiers and addresses, then open field-level source evidence without losing the reproducible query URL."
      />
      <form className="filter-panel" aria-label="Property search filters" onSubmit={submit}>
        <label className="field field-grow">
          <span>Search properties</span>
          <span className="input-wrap">
            <Search aria-hidden="true" />
            <input
              name="q"
              type="search"
              defaultValue={queryText}
              placeholder="Address, APN, or property ID"
            />
          </span>
        </label>
        <label className="field">
          <span>City</span>
          <input name="city" defaultValue={city} placeholder="Palo Alto" />
        </label>
        <label className="field field-small">
          <span>ZIP code</span>
          <input
            name="postalCode"
            inputMode="numeric"
            defaultValue={postalCode}
            placeholder="94301"
          />
        </label>
        <button className="button primary" type="submit">
          <Filter aria-hidden="true" /> Apply filters
        </button>
      </form>
      <ReleaseGate>
        {(release) => (
          <>
            <ReleaseBar envelope={release} />
            <StatePanel state={query} onRetry={query.retry}>
              {(data) => (
                <>
                  <ResultViews rows={rowsFromData(data.data)} caption="Property search results" />
                  <EnvelopeNotes envelope={data} />
                </>
              )}
            </StatePanel>
          </>
        )}
      </ReleaseGate>
    </>
  );
}

function FactGrid({ record }: Readonly<{ record: DataRow }>) {
  return (
    <dl className="fact-grid">
      {Object.entries(record).map(([key, value]) => (
        <div key={key}>
          <dt>{key.replace(/([a-z])([A-Z])/gu, '$1 $2').replaceAll('_', ' ')}</dt>
          <dd>{displayValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PropertyDetailPage() {
  const parameters = useParams();
  const propertyId = parameters.propertyId ?? '';
  const property = useReleaseQuery('property.get', { propertyId }, propertyId !== '');
  const evidence = useReleaseQuery('property.getEvidence', { propertyId }, propertyId !== '');
  return (
    <>
      <PageHeader
        eyebrow="Property evidence"
        title={propertyId === '' ? 'Property identifier missing' : propertyId}
        description="Canonical values, source assertions, conflicts, derived features, and limitations remain separate so preferred fields never erase provenance."
        actions={
          <Link className="button secondary" to="/properties">
            Back to explorer
          </Link>
        }
      />
      {propertyId === '' ? (
        <section className="state-panel error-state" role="alert">
          <AlertTriangle aria-hidden="true" />
          <div>
            <h2>Invalid property route</h2>
            <p>Open a property from the search results.</p>
          </div>
        </section>
      ) : (
        <ReleaseGate>
          {(release) => (
            <>
              <ReleaseBar envelope={release} />
              <div className="detail-columns">
                <section>
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">Canonical record</p>
                      <h2>Property facts</h2>
                    </div>
                  </div>
                  <StatePanel state={property} onRetry={property.retry}>
                    {(data) => <FactGrid record={rowsFromData(data.data)[0] ?? {}} />}
                  </StatePanel>
                </section>
                <section>
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">Evidence timeline</p>
                      <h2>Sources and assertions</h2>
                    </div>
                  </div>
                  <StatePanel state={evidence} onRetry={evidence.retry}>
                    {(data) => (
                      <>
                        <ol className="evidence-timeline">
                          {rowsFromData(data.data).map((row, index) => (
                            <li key={displayValue(valueFor(row, ['evidenceId', 'id']) ?? index)}>
                              <span className="timeline-marker" aria-hidden="true" />
                              <TruthBadge
                                state={truthStateFrom(valueFor(row, ['supportState', 'state']))}
                              />
                              <h3>{displayValue(valueFor(row, ['feature', 'claim', 'type']))}</h3>
                              <p>
                                {displayValue(valueFor(row, ['value', 'description', 'summary']))}
                              </p>
                              <dl>
                                <div>
                                  <dt>Evidence ID</dt>
                                  <dd>{displayValue(valueFor(row, ['evidenceId', 'id']))}</dd>
                                </div>
                                <div>
                                  <dt>Source identifiers</dt>
                                  <dd>{displayValue(valueFor(row, ['sourceIds', 'sourceId']))}</dd>
                                </div>
                              </dl>
                            </li>
                          ))}
                        </ol>
                        <EnvelopeNotes envelope={data} />
                      </>
                    )}
                  </StatePanel>
                </section>
              </div>
            </>
          )}
        </ReleaseGate>
      )}
    </>
  );
}

function inquiryInput(
  inquiry: Inquiry,
  parameters: URLSearchParams,
): Readonly<Record<string, unknown>> {
  const input: Record<string, unknown> = { limit: 25 };
  for (const field of inquiry.fields) {
    if (field.type === 'checkbox') {
      const defaultChecked = 'checked' in field && field.checked;
      input[field.key] = parameters.has(field.key)
        ? parameters.get(field.key) === 'true'
        : defaultChecked;
    } else {
      const value = parameters.get(field.key) ?? field.value;
      input[field.key] = Number(value);
    }
  }
  if (inquiry.slug === 'regional-owner') input.policyId = 'bay-area-nine-counties-v1';
  const city = parameters.get('city');
  if (city !== null && city !== '') input.city = city;
  return input;
}

export function InquiryPage({ inquiry }: Readonly<{ inquiry: Inquiry }>) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [formError, setFormError] = useState<string | null>(null);
  const input = useMemo(() => inquiryInput(inquiry, searchParams), [inquiry, searchParams]);
  const query = useReleaseQuery(inquiry.operation, input);

  function submit(event: FormSubmitEvent) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = new URLSearchParams();
    try {
      for (const field of inquiry.fields) {
        if (field.type === 'checkbox') {
          next.set(field.key, form.get(field.key) === 'on' ? 'true' : 'false');
        } else {
          const raw = formString(form, field.key);
          parsePositive(raw, field.label);
          next.set(field.key, raw);
        }
      }
      const city = formString(form, 'city').trim();
      if (city !== '') next.set('city', city);
      setFormError(null);
      setSearchParams(next);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Invalid inquiry parameters.');
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Dedicated inquiry preset"
        title={inquiry.title}
        description={inquiry.description}
        actions={
          <span className="semantic-label">
            <ShieldCheck aria-hidden="true" /> {inquiry.modeLabel}
          </span>
        }
      />
      <div className="semantic-warning">
        <ShieldCheck aria-hidden="true" />
        <p>
          <strong>Truth contract:</strong> support, proxy, unknown, and limitations come from the
          immutable query response. This interface never upgrades evidence.
        </p>
      </div>
      <form
        className="filter-panel"
        aria-label={`${inquiry.shortTitle} parameters`}
        onSubmit={submit}
      >
        <label className="field">
          <span>City</span>
          <input
            name="city"
            defaultValue={searchParams.get('city') ?? ''}
            placeholder="All cities"
          />
        </label>
        {inquiry.fields.map((field) =>
          field.type === 'checkbox' ? (
            <label className="check-field" key={field.key}>
              <input
                name={field.key}
                type="checkbox"
                defaultChecked={
                  searchParams.has(field.key)
                    ? searchParams.get(field.key) === 'true'
                    : 'checked' in field && field.checked
                }
              />
              <span>
                <Check aria-hidden="true" />
              </span>
              {field.label}
            </label>
          ) : (
            <label className="field" key={field.key}>
              <span>{field.label}</span>
              <input
                name={field.key}
                type="number"
                min="0.1"
                step={'step' in field ? field.step : '1'}
                defaultValue={searchParams.get(field.key) ?? field.value}
              />
            </label>
          ),
        )}
        <button className="button primary" type="submit">
          <Play aria-hidden="true" /> Run inquiry
        </button>
      </form>
      {formError === null ? null : (
        <div className="form-alert" role="alert">
          <AlertTriangle aria-hidden="true" /> {formError}
        </div>
      )}
      <ReleaseGate>
        {(release) => (
          <>
            <ReleaseBar envelope={release} />
            <StatePanel state={query} onRetry={query.retry}>
              {(data) => (
                <>
                  <ResultViews
                    rows={rowsFromData(data.data)}
                    caption={`${inquiry.title} results`}
                  />
                  <EnvelopeNotes envelope={data} />
                </>
              )}
            </StatePanel>
          </>
        )}
      </ReleaseGate>
    </>
  );
}

export function RankingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const includeProxy = searchParams.get('includeProxy') === 'true';
  const minimumEvidenceCoverage = Number(searchParams.get('minimumEvidenceCoverage') ?? '0.5');
  const roofWeight = Number(searchParams.get('roofWeight') ?? '1');
  const ownershipWeight = Number(searchParams.get('ownershipWeight') ?? '1');
  const transitWeight = Number(searchParams.get('transitWeight') ?? '1');
  const query = useReleaseQuery('inquiry.rankCandidates', {
    limit: 25,
    signals: ['roof_age', 'ownership_age', 'transit_walkability'],
    weights: {
      roof_age: roofWeight,
      ownership_age: ownershipWeight,
      transit_walkability: transitWeight,
    },
    includeProxy,
    minimumEvidenceCoverage,
  });
  function submit(event: FormSubmitEvent) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const coverage = formString(form, 'minimumEvidenceCoverage');
    const next = new URLSearchParams({
      includeProxy: form.get('includeProxy') === 'on' ? 'true' : 'false',
      minimumEvidenceCoverage: coverage,
      roofWeight: formString(form, 'roofWeight'),
      ownershipWeight: formString(form, 'ownershipWeight'),
      transitWeight: formString(form, 'transitWeight'),
    });
    setSearchParams(next);
  }
  return (
    <>
      <PageHeader
        eyebrow="Deterministic ranking"
        title="Combined review candidates"
        description="The query service owns the score. Every component weight, evidence state, coverage value, and tie-break remains inspectable; the model cannot change ranking logic."
      />
      <form className="filter-panel" aria-label="Combined ranking parameters" onSubmit={submit}>
        <label className="field">
          <span>Minimum evidence coverage</span>
          <input
            name="minimumEvidenceCoverage"
            type="number"
            min="0"
            max="1"
            step="0.1"
            defaultValue={minimumEvidenceCoverage}
          />
        </label>
        <label className="field field-small">
          <span>Roof weight</span>
          <input
            name="roofWeight"
            type="number"
            min="0"
            max="100"
            step="0.1"
            defaultValue={roofWeight}
          />
        </label>
        <label className="field field-small">
          <span>Ownership weight</span>
          <input
            name="ownershipWeight"
            type="number"
            min="0"
            max="100"
            step="0.1"
            defaultValue={ownershipWeight}
          />
        </label>
        <label className="field field-small">
          <span>Transit weight</span>
          <input
            name="transitWeight"
            type="number"
            min="0"
            max="100"
            step="0.1"
            defaultValue={transitWeight}
          />
        </label>
        <label className="check-field">
          <input name="includeProxy" type="checkbox" defaultChecked={includeProxy} />
          <span>
            <Check aria-hidden="true" />
          </span>
          Include proxies with explicit multiplier
        </label>
        <button className="button primary" type="submit">
          <Layers3 aria-hidden="true" /> Rank candidates
        </button>
      </form>
      <ReleaseGate>
        {(release) => (
          <>
            <ReleaseBar envelope={release} />
            <StatePanel state={query} onRetry={query.retry}>
              {(data) => (
                <>
                  <ResultViews rows={rowsFromData(data.data)} caption="Combined ranking results" />
                  <EnvelopeNotes envelope={data} />
                </>
              )}
            </StatePanel>
          </>
        )}
      </ReleaseGate>
    </>
  );
}

const agentPrompts = [
  'Which properties have roofs older than 15 years and have not exchanged ownership in more than 10 years?',
  'Which properties are near public transportation and also have regional owners?',
  'Which properties appear to be strong candidates for further review based on ownership age, roof age, and location signals?',
] as const;

export function AgentPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const prompt = searchParams.get('q') ?? '';
  const status = useReleaseQuery('agent.status', {});
  const answer = useReleaseQuery('agent.ask', { prompt }, prompt !== '');
  const [draft, setDraft] = useState(prompt);
  function submit(event: FormSubmitEvent) {
    event.preventDefault();
    const trimmed = draft.trim();
    if (trimmed !== '') setSearchParams({ q: trimmed });
  }
  return (
    <>
      <PageHeader
        eyebrow="Bounded named-tool agent"
        title="Ask the release, then inspect every tool call"
        description="Model synthesis stays separate from deterministic evidence. The agent has no silent fallback, no caller SQL, and no access to private chain-of-thought."
      />
      <ReleaseGate>
        {(release) => (
          <>
            <ReleaseBar envelope={release} />
            <section className="agent-layout">
              <div className="agent-compose">
                <StatePanel state={status} onRetry={status.retry}>
                  {(data) => {
                    const record = rowsFromData(data.data)[0] ?? {};
                    const agentState = displayValue(valueFor(record, ['status']));
                    return (
                      <div
                        className={
                          agentState === 'available' ? 'agent-status' : 'agent-status degraded'
                        }
                        role={agentState === 'available' ? 'status' : 'alert'}
                      >
                        <Bot aria-hidden="true" />
                        <div>
                          <strong>Agent {agentState}</strong>
                          <span>
                            Profile{' '}
                            {displayValue(valueFor(record, ['modelProfile', 'modelProfileId']))} ·
                            policy {displayValue(valueFor(record, ['policyHash']))}
                          </span>
                        </div>
                      </div>
                    );
                  }}
                </StatePanel>
                <form onSubmit={submit}>
                  <label className="field">
                    <span>Property intelligence question</span>
                    <textarea
                      value={draft}
                      onChange={(event) => setDraft(event.currentTarget.value)}
                      maxLength={2000}
                      rows={6}
                      placeholder="Ask a bounded, evidence-backed question"
                    />
                  </label>
                  <button className="button primary" type="submit" disabled={draft.trim() === ''}>
                    <Bot aria-hidden="true" /> Ask agent
                  </button>
                </form>
                <div className="prompt-presets" aria-label="Assignment prompt presets">
                  {agentPrompts.map((preset) => (
                    <button
                      className="prompt-card"
                      type="button"
                      key={preset}
                      onClick={() => setDraft(preset)}
                    >
                      {preset}
                      <ArrowRight aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </div>
              <div className="agent-result" aria-live="polite">
                {prompt === '' ? (
                  <div className="state-panel empty-state">
                    <Bot aria-hidden="true" />
                    <div>
                      <h2>No agent request yet</h2>
                      <p>
                        Choose a preset or ask a question. The URL preserves the submitted prompt.
                      </p>
                    </div>
                  </div>
                ) : (
                  <StatePanel state={answer} onRetry={answer.retry}>
                    {(data) => {
                      const record = rowsFromData(data.data)[0] ?? {};
                      const answerValue = valueFor(record, ['answer', 'response', 'text']);
                      const trace = valueFor(record, ['toolCalls', 'toolTrace', 'trace']);
                      return (
                        <>
                          <article className="answer-card">
                            <p className="eyebrow">Model-authored synthesis</p>
                            <h2>Answer</h2>
                            <p>{displayValue(answerValue)}</p>
                            <p className="citation-line">
                              Citations:{' '}
                              {displayValue(valueFor(record, ['citations', 'evidenceIds']))}
                            </p>
                          </article>
                          <section className="trace-panel" aria-labelledby="trace-heading">
                            <p className="eyebrow">Deterministic execution</p>
                            <h2 id="trace-heading">Tool trace</h2>
                            <pre>{displayValue(trace)}</pre>
                          </section>
                          <EnvelopeNotes envelope={data} />
                        </>
                      );
                    }}
                  </StatePanel>
                )}
              </div>
            </section>
          </>
        )}
      </ReleaseGate>
    </>
  );
}

export function ArtifactsPage() {
  const query = useReleaseQuery('artifacts.list', { limit: 50 });
  return (
    <>
      <PageHeader
        eyebrow="Immutable storage"
        title="Release artifacts and content identifiers"
        description="Public artifacts expose immutable CIDs, checksums, sizes, row counts, and publication class. Restricted overlays are not expanded here."
      />
      <ReleaseGate>
        {(release) => (
          <>
            <ReleaseBar envelope={release} />
            <StatePanel state={query} onRetry={query.retry}>
              {(data) => (
                <>
                  <EvidenceTable
                    caption="Immutable public release artifacts"
                    rows={rowsFromData(data.data)}
                    columns={[
                      { label: 'Artifact', keys: ['artifactId', 'name', 'type'] },
                      { label: 'CID', keys: ['cid', 'manifestCid'] },
                      { label: 'SHA-256', keys: ['sha256', 'checksum'] },
                      { label: 'Bytes', keys: ['bytes', 'sizeBytes'] },
                      { label: 'Rows', keys: ['rowCount', 'rows'] },
                      { label: 'Publication', keys: ['publicationClass', 'visibility'] },
                    ]}
                  />
                  <EnvelopeNotes envelope={data} />
                </>
              )}
            </StatePanel>
          </>
        )}
      </ReleaseGate>
    </>
  );
}

export function DictionaryPage() {
  const query = useReleaseQuery('artifacts.getDataDictionary', {});
  return (
    <>
      <PageHeader
        eyebrow="Data dictionary"
        title="Fields, definitions, and publication boundaries"
        description="Inspect canonical field meaning, source lineage expectations, units, null behavior, and public/restricted classification for this exact release."
      />
      <ReleaseGate>
        {(release) => (
          <>
            <ReleaseBar envelope={release} />
            <StatePanel state={query} onRetry={query.retry}>
              {(data) => (
                <>
                  <EvidenceTable
                    caption="Release-bound data dictionary"
                    rows={rowsFromData(data.data)}
                    columns={[
                      { label: 'Entity', keys: ['entity', 'table'] },
                      { label: 'Field', keys: ['field', 'name'] },
                      { label: 'Type', keys: ['type', 'dataType'] },
                      { label: 'Definition', keys: ['description', 'definition'] },
                      { label: 'Publication', keys: ['publicationClass', 'visibility'] },
                    ]}
                  />
                  <EnvelopeNotes envelope={data} />
                </>
              )}
            </StatePanel>
          </>
        )}
      </ReleaseGate>
    </>
  );
}

const mcpTools = [
  'get_dataset_info',
  'get_dataset_coverage',
  'list_pipeline_runs',
  'get_pipeline_run',
  'search_properties',
  'get_property',
  'get_property_evidence',
  'find_roof_age_candidates',
  'find_water_view_candidates',
  'find_ownership_age_candidates',
  'find_regional_owner_properties',
  'find_transit_walkable_properties',
  'find_starbucks_walkable_properties',
  'rank_review_candidates',
  'list_artifacts',
  'get_data_dictionary',
] as const;

export function McpPage() {
  const endpoint = `${window.location.origin}/mcp`;
  return (
    <>
      <PageHeader
        eyebrow="Model Context Protocol"
        title="Connect to the SQL-free named evidence surface"
        description="The public Streamable HTTP MCP exposes sixteen read-only tools over the same release contract as this UI. Elephant caller-SQL compatibility remains separate and blocked until certified."
      />
      <ReleaseGate>
        {(release) => (
          <>
            <ReleaseBar envelope={release} />
            <div className="mcp-grid">
              <section className="setup-card">
                <ServerCog aria-hidden="true" />
                <p className="eyebrow">Endpoint</p>
                <h2>Streamable HTTP</h2>
                <div className="copy-value">
                  <code>{endpoint}</code>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label="Copy MCP endpoint"
                    onClick={() => void navigator.clipboard.writeText(endpoint)}
                  >
                    <Clipboard aria-hidden="true" />
                  </button>
                </div>
                <pre>{`{
  "mcpServers": {
    "oracle-santa-clara": {
      "url": "${endpoint}"
    }
  }
}`}</pre>
              </section>
              <section className="setup-card">
                <Network aria-hidden="true" />
                <p className="eyebrow">Capability boundary</p>
                <h2>Named evidence only</h2>
                <TruthBadge state="blocked" />
                <p>
                  Production tool execution requires the verified immutable-release service
                  composer. Strict schemas and protocol discovery are present; no fixture fallback
                  is permitted.
                </p>
                <TruthBadge state="unsupported" />
                <p>
                  Elephant caller <code>queryProperties</code> remains unexposed and uncertified.
                </p>
              </section>
            </div>
            <section className="tool-inventory" aria-labelledby="tool-heading">
              <p className="eyebrow">Frozen inventory</p>
              <h2 id="tool-heading">16 read-only tools</h2>
              <ul>
                {mcpTools.map((tool) => (
                  <li key={tool}>
                    <Wrench aria-hidden="true" /> <code>{tool}</code>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </ReleaseGate>
    </>
  );
}

export function CapabilitiesPage() {
  const coverage = useReleaseQuery('dataset.getCoverage', {});
  return (
    <>
      <PageHeader
        eyebrow="Capability and limitations"
        title="A claim vocabulary designed to resist overstatement"
        description="The same labels appear across UI, API, MCP, and agent traces. Color is supplementary; every state includes text and an icon."
      />
      <ReleaseGate>
        {(release) => (
          <>
            <ReleaseBar envelope={release} />
            <section className="truth-legend" aria-label="Evidence truth vocabulary">
              {(['direct', 'derived', 'proxy', 'partial', 'blocked', 'unsupported'] as const).map(
                (state) => (
                  <article key={state}>
                    <TruthBadge state={state} />
                    <p>
                      {state === 'direct' &&
                        'A source record directly establishes the displayed claim.'}
                      {state === 'derived' &&
                        'A deterministic, versioned calculation over cited facts.'}
                      {state === 'proxy' &&
                        'A useful signal that cannot establish the requested fact.'}
                      {state === 'partial' &&
                        'Some evidence exists; the denominator or interval is incomplete.'}
                      {state === 'blocked' &&
                        'Access, authorization, legality, or source availability prevents proof.'}
                      {state === 'unsupported' &&
                        'The release does not implement or substantiate this capability.'}
                    </p>
                  </article>
                ),
              )}
            </section>
            <StatePanel state={coverage} onRetry={coverage.retry}>
              {(data) => <EnvelopeNotes envelope={data} />}
            </StatePanel>
          </>
        )}
      </ReleaseGate>
    </>
  );
}

export function EvidencePage() {
  const { release } = useOracle();
  return (
    <>
      <PageHeader
        eyebrow="Read-only release evidence"
        title="One immutable receipt, without self-scoring"
        description="This surface reports release identifiers and public limitations. It does not execute tests, expose held-out cases, reveal credentials, or claim an evaluator score."
      />
      <StatePanel state={release} onRetry={release.retry}>
        {(data) => (
          <>
            <ReleaseBar envelope={data} />
            <div className="evidence-summary">
              <article>
                <FileJson aria-hidden="true" />
                <p className="eyebrow">Schema</p>
                <h2>{data.schemaVersion}</h2>
                <p>Application evidence envelope</p>
              </article>
              <article>
                <Database aria-hidden="true" />
                <p className="eyebrow">Manifest CID</p>
                <h2>{data.manifestCid}</h2>
                <p>Immutable release content identifier</p>
              </article>
              <article>
                <ShieldCheck aria-hidden="true" />
                <p className="eyebrow">Publication</p>
                <h2>Public-safe only</h2>
                <p>Restricted records and private cases are withheld.</p>
              </article>
            </div>
            <EnvelopeNotes envelope={data} />
          </>
        )}
      </StatePanel>
    </>
  );
}

export function ArchitecturePage() {
  const architectureItems = [
    {
      title: 'Immutable release',
      detail: 'Public-safe Parquet, manifests, and evidence identified by CID.',
      icon: FileJson,
    },
    {
      title: 'DuckDB query core',
      detail: 'Portable local analytics with the same named inquiry semantics.',
      icon: Database,
    },
    {
      title: 'API + MCP adapters',
      detail: 'Strict bounded envelopes, no caller-selected SQL or physical authority.',
      icon: Network,
    },
    {
      title: 'Evaluator + agent',
      detail: 'Static UI and one no-fallback named-tool Bedrock profile.',
      icon: Bot,
    },
  ] as const;
  return (
    <>
      <PageHeader
        eyebrow="Portable architecture"
        title="Immutable data, replaceable compute"
        description="The product serves content-addressed artifacts through bounded, scale-to-zero query surfaces. Oracle does not need to operate an always-on database."
      />
      <ReleaseGate>
        {(release) => (
          <>
            <ReleaseBar envelope={release} />
            <div className="architecture-flow" aria-label="Oracle deployment architecture">
              {architectureItems.map(({ title, detail, icon: FlowIcon }, index) => (
                <article key={title}>
                  <span className="flow-number">0{index + 1}</span>
                  <FlowIcon aria-hidden="true" />
                  <h2>{title}</h2>
                  <p>{detail}</p>
                </article>
              ))}
            </div>
            <section className="portability-card">
              <Code2 aria-hidden="true" />
              <div>
                <p className="eyebrow">Cost posture</p>
                <h2>Scale to zero, keep evidence durable</h2>
                <p>
                  S3 + CloudFront host the static evaluator; request-based Lambda and API Gateway
                  serve verified queries; Bedrock runs only for explicit agent requests. Immutable
                  artifacts remain independently portable if the candidate demo stack is removed.
                </p>
              </div>
              <Link className="button secondary" to="/artifacts">
                Inspect artifacts <ExternalLink aria-hidden="true" />
              </Link>
            </section>
          </>
        )}
      </ReleaseGate>
    </>
  );
}

export function NotFoundPage() {
  return (
    <>
      <PageHeader
        eyebrow="Route not found"
        title="This evaluator path does not exist"
        description="Use the primary navigation to return to a stable, release-bound route."
      />
      <Link className="button primary" to="/">
        Return to overview
      </Link>
    </>
  );
}

export { inquiries };
