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
  CapabilityDetails,
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
        value: '200',
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
        value: '0.7',
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
  { label: 'Run', keys: ['run_id', 'runId', 'sourceId', 'id', 'name'] },
  { label: 'Status', keys: ['status', 'state'], kind: 'truth' },
  { label: 'Observed', keys: ['observed_count', 'observed', 'observedCount', 'recordCount'] },
  { label: 'Expected', keys: ['expected_count', 'expected'] },
  { label: 'Quarantined', keys: ['quarantine_count', 'rejected', 'rejectedCount'] },
  { label: 'Pipeline', keys: ['pipeline_version', 'version'] },
  {
    label: 'Timestamp',
    keys: ['completed_at', 'started_at', 'completedAt', 'collectedAt', 'timestamp', 'asOf'],
  },
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
              {(data) => {
                const runs = rowsFromData(data.data);
                return (
                  <>
                    <EvidenceTable
                      caption="Release-bound pipeline runs and stages"
                      rows={runs}
                      columns={pipelineColumns}
                    />
                    {runs.map((run, index) => {
                      const sources = parseJsonStringArray(
                        valueFor(run, ['source_ids_json', 'sourceIds', 'sourceId']),
                      );
                      if (sources.length === 0) return null;
                      const runLabel = displayValue(
                        valueFor(run, ['run_id', 'runId', 'id']) ?? index,
                      );
                      return (
                        <section
                          className="tool-inventory"
                          key={runLabel}
                          aria-label={`Sources ingested by run ${runLabel}`}
                        >
                          <p className="eyebrow">Sources ingested</p>
                          <h2>
                            {sources.length.toLocaleString()} sources in run {runLabel}
                          </h2>
                          <ul>
                            {sources.map((source) => (
                              <li key={source}>
                                <Database aria-hidden="true" /> <code>{source}</code>
                              </li>
                            ))}
                          </ul>
                        </section>
                      );
                    })}
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
                const coverage = isRecord(data.data) ? data.data : {};
                const sources = Array.isArray(coverage.sources)
                  ? coverage.sources.filter(isRecord)
                  : [];
                const fieldRows = rowsFromData(data.data);
                return (
                  <>
                    {sources.length === 0 ? null : (
                      <EvidenceTable
                        caption="Total uploaded records by source, with collection timestamps and provenance"
                        rows={sources}
                        columns={[
                          { label: 'Source', keys: ['source_id', 'source', 'name', 'id'] },
                          { label: 'Scope', keys: ['scope'] },
                          {
                            label: 'Support',
                            keys: ['support_class', 'supportState', 'state', 'status'],
                            kind: 'truth',
                          },
                          {
                            label: 'Observed records',
                            keys: ['observed_count', 'observed', 'observedCount'],
                          },
                          { label: 'Expected', keys: ['expected_count', 'expected'] },
                          { label: 'Quarantined', keys: ['quarantine_count', 'quarantined'] },
                          { label: 'As of', keys: ['as_of', 'asOf', 'collectedAt', 'freshness'] },
                          {
                            label: 'Provenance (source SHA-256)',
                            keys: ['source_sha256', 'sha256', 'checksum'],
                          },
                        ]}
                      />
                    )}
                    <EvidenceTable
                      caption="Field and dataset coverage"
                      rows={fieldRows}
                      columns={[
                        {
                          label: 'Relation / dataset',
                          keys: ['relation_name', 'dataset', 'source', 'name', 'id'],
                        },
                        { label: 'Field', keys: ['field_name', 'field'] },
                        {
                          label: 'Support',
                          keys: ['support_class', 'supportState', 'state', 'status'],
                          kind: 'truth',
                        },
                        {
                          label: 'Supported',
                          keys: ['numerator', 'observed', 'observedCount'],
                        },
                        {
                          label: 'Denominator',
                          keys: ['denominator', 'expected', 'expectedCount'],
                        },
                        { label: 'Ratio / linked', keys: ['ratio', 'linked', 'linkedCount'] },
                        { label: 'As of', keys: ['as_of', 'asOf', 'collectedAt', 'freshness'] },
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

function parseJsonStringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  }
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      : [];
  } catch {
    return [];
  }
}

// Expands a single-key row into individual facts. Handles both the JSON-string
// form (e.g. `{ property: "{...}" }`) and the already-parsed object form the
// query API returns for `get_property` (`data.property` is a nested object).
function expandSingleJsonFact(record: DataRow): DataRow {
  const entries = Object.entries(record);
  if (entries.length !== 1) return record;
  const [, rawValue] = entries[0] ?? [];
  let value: unknown = rawValue;
  if (typeof rawValue === 'string') {
    if (!rawValue.startsWith('{')) return record;
    try {
      value = JSON.parse(rawValue);
    } catch {
      return record;
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return record;
  const expanded: Record<string, unknown> = {};
  for (const [factKey, factValue] of Object.entries(value)) {
    expanded[factKey] =
      factValue === null || typeof factValue !== 'object' ? factValue : JSON.stringify(factValue);
  }
  return expanded;
}

function FactGrid({ record }: Readonly<{ record: DataRow }>) {
  return (
    <dl className="fact-grid">
      {Object.entries(expandSingleJsonFact(record)).map(([key, value]) => (
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
                          {rowsFromData(data.data).map((row, index) => {
                            const sourceIds = parseJsonStringArray(
                              valueFor(row, ['source_ids_json', 'sourceIds', 'sourceId']),
                            );
                            return (
                              <li
                                key={displayValue(
                                  valueFor(row, ['evidence_id', 'evidenceId', 'id']) ?? index,
                                )}
                              >
                                <span className="timeline-marker" aria-hidden="true" />
                                <TruthBadge
                                  state={truthStateFrom(
                                    valueFor(row, ['support_class', 'supportState', 'state']),
                                  )}
                                />
                                <h3>{displayValue(valueFor(row, ['feature', 'claim', 'type']))}</h3>
                                <p>
                                  {displayValue(
                                    valueFor(row, ['value_json', 'value', 'description', 'summary']),
                                  )}
                                </p>
                                <dl>
                                  <div>
                                    <dt>Evidence ID</dt>
                                    <dd>
                                      {displayValue(
                                        valueFor(row, ['evidence_id', 'evidenceId', 'id']),
                                      )}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>Source identifiers</dt>
                                    <dd>
                                      {sourceIds.length === 0
                                        ? displayValue(
                                            valueFor(row, ['source_ids_json', 'sourceIds', 'sourceId']),
                                          )
                                        : sourceIds.join(', ')}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>As of</dt>
                                    <dd>
                                      {displayValue(valueFor(row, ['as_of', 'asOf', 'collectedAt']))}
                                    </dd>
                                  </div>
                                </dl>
                              </li>
                            );
                          })}
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

const namedEvidenceTools = [
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

type NamedEvidenceTool = (typeof namedEvidenceTools)[number];

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

function namedTool(value: unknown): NamedEvidenceTool | null {
  return typeof value === 'string' && namedEvidenceTools.some((tool) => tool === value)
    ? (value as NamedEvidenceTool)
    : null;
}

function isQualifiedAgentStatus(record: Readonly<Record<string, unknown>> | null): boolean {
  return (
    record?.status === 'available' &&
    typeof record.modelProfileId === 'string' &&
    record.modelProfileId.length > 0 &&
    typeof record.policyHash === 'string' &&
    record.policyHash.length > 0
  );
}

function AgentStatusCard({ envelope }: Readonly<{ envelope: ApiEnvelope }>) {
  const record = isRecord(envelope.data) ? envelope.data : {};
  const reportedStatus = typeof record.status === 'string' ? record.status : 'unavailable';
  const available = isQualifiedAgentStatus(record);
  const status = available
    ? 'available'
    : reportedStatus === 'available'
      ? 'configuration error'
      : reportedStatus;
  const limitations = [...new Set([...envelope.limitations, ...stringList(record.limitations)])];
  return (
    <section
      className={available ? 'agent-status-card' : 'agent-status-card degraded'}
      role={available ? 'status' : 'alert'}
      aria-label={`Agent ${status}`}
    >
      <div className="agent-status">
        <Bot aria-hidden="true" />
        <div>
          <strong>Agent {status}</strong>
          <span>
            {available
              ? 'The selected Bedrock profile passed composition and release checks.'
              : 'No answer can be generated while the composed model profile is unavailable.'}
          </span>
        </div>
      </div>
      <dl className="fact-grid agent-runtime-facts">
        <div>
          <dt>Selected model profile</dt>
          <dd>{displayValue(record.modelProfileId)}</dd>
        </div>
        <div>
          <dt>Immutable release</dt>
          <dd>{envelope.releaseId}</dd>
        </div>
        <div>
          <dt>Policy hash</dt>
          <dd>{displayValue(record.policyHash)}</dd>
        </div>
        <div>
          <dt>Readiness</dt>
          <dd>{available ? 'Probe passed' : 'Unavailable — no fallback'}</dd>
        </div>
      </dl>
      {limitations.length === 0 ? (
        <p className="agent-limitations">No agent limitations were returned.</p>
      ) : (
        <div className="agent-limitations">
          <strong>Capability limitations</strong>
          <ul>
            {limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function AgentAnswer({
  envelope,
  modelProfileId,
}: Readonly<{ envelope: ApiEnvelope; modelProfileId: unknown }>) {
  const record = isRecord(envelope.data) ? envelope.data : {};
  const citations = stringList(record.citations);
  const trace = Array.isArray(record.toolCalls) ? record.toolCalls.filter(isRecord) : [];
  const validTerminalAnswer =
    (record.status === 'available' || record.status === 'complete') &&
    typeof record.answer === 'string' &&
    Array.isArray(record.citations) &&
    Array.isArray(record.toolCalls) &&
    trace.length === record.toolCalls.length &&
    trace.every(
      (entry) =>
        typeof entry.callIndex === 'number' &&
        namedTool(entry.toolName) !== null &&
        entry.releaseId === envelope.releaseId &&
        Array.isArray(entry.evidenceIds) &&
        entry.evidenceIds.every((identifier) => typeof identifier === 'string'),
    );
  if (!validTerminalAnswer) {
    return (
      <section className="state-panel error-state" role="alert">
        <AlertTriangle aria-hidden="true" />
        <div>
          <h2>Agent response unavailable</h2>
          <p>
            The terminal answer or named-tool trace did not match the immutable public response
            contract. No partial synthesis is displayed.
          </p>
        </div>
      </section>
    );
  }
  return (
    <>
      <article className="answer-card" aria-labelledby="agent-answer-heading">
        <p className="eyebrow">Terminal model synthesis</p>
        <h2 id="agent-answer-heading">Answer</h2>
        <p>{displayValue(record.answer)}</p>
        <dl className="fact-grid agent-answer-facts">
          <div>
            <dt>Selected model profile</dt>
            <dd>{displayValue(modelProfileId)}</dd>
          </div>
          <div>
            <dt>Immutable release</dt>
            <dd>{envelope.releaseId}</dd>
          </div>
          <div>
            <dt>Terminal state</dt>
            <dd>{displayValue(record.status)}</dd>
          </div>
          <div>
            <dt>Named tool calls</dt>
            <dd>{trace.length.toLocaleString()}</dd>
          </div>
        </dl>
        <section className="citation-section" aria-labelledby="citation-heading">
          <h3 id="citation-heading">Exact citations</h3>
          {citations.length === 0 ? (
            <p>No evidence citation was returned.</p>
          ) : (
            <ol>
              {citations.map((citation) => (
                <li key={citation}>
                  <code>{citation}</code>
                </li>
              ))}
            </ol>
          )}
        </section>
      </article>
      <section className="trace-panel" aria-labelledby="trace-heading">
        <p className="eyebrow">Deterministic execution</p>
        <h2 id="trace-heading">Named-tool trace</h2>
        {trace.length === 0 ? (
          <p>No named tool was called for this response.</p>
        ) : (
          <ol className="tool-trace">
            {trace.map((entry, index) => {
              const name = namedTool(entry.toolName);
              const evidenceIds = stringList(entry.evidenceIds);
              return (
                <li key={`${displayValue(entry.callIndex)}-${name ?? index}`}>
                  <div>
                    <span>Call {displayValue(entry.callIndex)}</span>
                    <strong>{name ?? 'Unrecognized named tool'}</strong>
                  </div>
                  <dl>
                    <div>
                      <dt>Release</dt>
                      <dd>{displayValue(entry.releaseId)}</dd>
                    </div>
                    <div>
                      <dt>Evidence IDs</dt>
                      <dd>{evidenceIds.length === 0 ? 'None returned' : evidenceIds.join(', ')}</dd>
                    </div>
                  </dl>
                </li>
              );
            })}
          </ol>
        )}
        <p className="trace-boundary">
          Only tool names, release binding, and public evidence identifiers are shown. Prompts, tool
          payloads, model reasoning, and chain-of-thought are not exposed.
        </p>
      </section>
      <EnvelopeNotes envelope={envelope} />
    </>
  );
}

export function AgentPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const prompt = searchParams.get('q') ?? '';
  const status = useReleaseQuery('agent.status', {});
  const statusRecord =
    status.status === 'success' && isRecord(status.data.data) ? status.data.data : null;
  const agentAvailable = isQualifiedAgentStatus(statusRecord);
  const statusModelProfileId = statusRecord?.modelProfileId;
  const answer = useReleaseQuery('agent.ask', { prompt }, prompt !== '' && agentAvailable);
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
                  {(data) => <AgentStatusCard envelope={data} />}
                </StatePanel>
                <form onSubmit={submit}>
                  <label className="field">
                    <span>Property intelligence question</span>
                    <textarea
                      value={draft}
                      onChange={(event) => setDraft(event.currentTarget.value)}
                      maxLength={2000}
                      rows={6}
                      disabled={!agentAvailable}
                      placeholder="Ask a bounded, evidence-backed question"
                    />
                  </label>
                  <button
                    className="button primary"
                    type="submit"
                    disabled={draft.trim() === '' || !agentAvailable}
                  >
                    <Bot aria-hidden="true" /> Ask agent
                  </button>
                </form>
                <div className="prompt-presets" aria-label="Assignment prompt presets">
                  {agentPrompts.map((preset) => (
                    <button
                      className="prompt-card"
                      type="button"
                      key={preset}
                      disabled={!agentAvailable}
                      onClick={() => setDraft(preset)}
                    >
                      {preset}
                      <ArrowRight aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </div>
              <div className="agent-result" aria-live="polite" aria-atomic="true">
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
                ) : status.status === 'loading' || status.status === 'idle' ? (
                  <section className="state-panel loading-state" aria-busy="true">
                    <span className="loading-orbit" aria-hidden="true" />
                    <div>
                      <h2>Checking agent availability</h2>
                      <p>No request is sent until the selected profile passes its release probe.</p>
                    </div>
                  </section>
                ) : !agentAvailable ? (
                  <section className="state-panel error-state" role="alert">
                    <AlertTriangle aria-hidden="true" />
                    <div>
                      <h2>Agent answer unavailable</h2>
                      <p>
                        The composed model profile is not available. No canned or deterministic
                        answer has been substituted.
                      </p>
                    </div>
                  </section>
                ) : (
                  <StatePanel state={answer} onRetry={answer.retry}>
                    {(data) => (
                      <AgentAnswer envelope={data} modelProfileId={statusModelProfileId} />
                    )}
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

type QueryConsoleOperation = Readonly<{
  operation: ApplicationOperation;
  toolName: NamedEvidenceTool;
  title: string;
  releaseBound: boolean;
  fields: readonly Readonly<{
    key: string;
    label: string;
    type: 'number' | 'checkbox';
    value?: string;
    checked?: boolean;
    step?: string;
  }>[];
}>;

const inquiryToolNames: Readonly<Record<Inquiry['slug'], NamedEvidenceTool>> = {
  'roof-age': 'find_roof_age_candidates',
  'water-candidates': 'find_water_view_candidates',
  'ownership-age': 'find_ownership_age_candidates',
  'regional-owner': 'find_regional_owner_properties',
  'transit-walkability': 'find_transit_walkable_properties',
  'starbucks-walkability': 'find_starbucks_walkable_properties',
};

const queryConsoleOperations: readonly QueryConsoleOperation[] = [
  {
    operation: 'dataset.getInfo',
    toolName: 'get_dataset_info',
    title: 'Dataset release summary',
    releaseBound: false,
    fields: [],
  },
  ...inquiries.map((inquiry) => ({
    operation: inquiry.operation,
    toolName: inquiryToolNames[inquiry.slug],
    title: inquiry.shortTitle,
    releaseBound: true,
    fields: inquiry.fields,
  })),
];

function consoleOperation(value: string | null): QueryConsoleOperation | null {
  if (value === null) return queryConsoleOperations[0] ?? null;
  return queryConsoleOperations.find(({ toolName }) => toolName === value) ?? null;
}

function consoleFieldMaximum(key: string): number {
  if (key === 'minimumAgeYears' || key === 'minimumTenureYears') return 200;
  if (key === 'maximumDistanceMeters') return 20_000;
  if (key === 'maximumNetworkDistanceMeters') return 10_000;
  if (key === 'maximumSnapDistanceMeters') return 200;
  if (key === 'minimumTerrainConfidence' || key === 'minimumValidationConfidence') return 1;
  return 100;
}

function consoleRequest(
  selected: QueryConsoleOperation | null,
  searchParams: URLSearchParams,
  releaseId: string | null,
): Readonly<{ input: Readonly<Record<string, unknown>>; error: string | null }> {
  if (selected === null) {
    return {
      input: {},
      error: 'Choose one of the fixed named operations. No request was sent.',
    };
  }
  const allowedKeys = new Set(['operation']);
  if (selected.releaseBound) {
    allowedKeys.add('city');
    allowedKeys.add('limit');
    for (const field of selected.fields) allowedKeys.add(field.key);
  }
  if ([...searchParams.keys()].some((key) => !allowedKeys.has(key))) {
    return {
      input: {},
      error:
        'The console URL contains unsupported authority. Only the selected operation and its structured fields are accepted.',
    };
  }
  if (!selected.releaseBound) return { input: {}, error: null };
  if (releaseId === null) return { input: {}, error: null };

  const limit = Number(searchParams.get('limit') ?? '25');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { input: {}, error: 'Maximum rows must be a whole number from 1 to 100.' };
  }
  const input: Record<string, unknown> = { releaseId, limit };
  const city = searchParams.get('city')?.trim() ?? '';
  let hasControlCharacter = false;
  for (let index = 0; index < city.length; index += 1) {
    const codeUnit = city.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127) hasControlCharacter = true;
  }
  if (city.length > 100 || hasControlCharacter) {
    return { input: {}, error: 'City must be a safe public label of at most 100 characters.' };
  }
  if (city !== '') input.city = city;
  for (const field of selected.fields) {
    if (field.type === 'checkbox') {
      input[field.key] = searchParams.has(field.key)
        ? searchParams.get(field.key) === 'true'
        : field.checked === true;
      continue;
    }
    const value = Number(searchParams.get(field.key) ?? field.value ?? '');
    if (!Number.isFinite(value) || value <= 0 || value > consoleFieldMaximum(field.key)) {
      return {
        input: {},
        error: `${field.label} must be within the fixed operation bound.`,
      };
    }
    input[field.key] = value;
  }
  if (selected.operation === 'inquiry.regionalOwner') {
    input.policyId = 'bay-area-nine-counties-v1';
  }
  return { input, error: null };
}

function evidenceCount(rows: readonly DataRow[]): number {
  const identifiers = new Set<string>();
  for (const row of rows) {
    for (const key of ['evidenceIds', 'evidenceId'] as const) {
      const value = row[key];
      if (typeof value === 'string') identifiers.add(value);
      if (Array.isArray(value)) {
        for (const identifier of value)
          if (typeof identifier === 'string') identifiers.add(identifier);
      }
    }
    if (Array.isArray(row.evidence)) {
      for (const evidence of row.evidence) {
        if (!isRecord(evidence)) continue;
        const identifier = valueFor(evidence, ['evidenceId', 'id']);
        if (typeof identifier === 'string') identifiers.add(identifier);
      }
    }
  }
  return identifiers.size;
}

function QueryConsoleReceipt({
  release,
  result,
  selected,
}: Readonly<{
  release: ApiEnvelope;
  result: ApiEnvelope;
  selected: QueryConsoleOperation;
}>) {
  const releaseData = isRecord(release.data) ? release.data : {};
  const rows = rowsFromData(result.data);
  const citations = evidenceCount(rows);
  return (
    <section
      className="query-console-receipt"
      aria-labelledby="query-console-receipt-heading"
      aria-live="polite"
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">Terminal operation receipt</p>
          <h2 id="query-console-receipt-heading">DuckDB named query complete</h2>
        </div>
        <TruthBadge state="direct" />
      </div>
      <dl className="fact-grid">
        <div>
          <dt>Immutable release</dt>
          <dd>{result.releaseId}</dd>
        </div>
        <div>
          <dt>Fixed named operation</dt>
          <dd>{selected.toolName}</dd>
        </div>
        <div>
          <dt>DuckDB version</dt>
          <dd>{displayValue(releaseData.duckdbVersion)}</dd>
        </div>
        <div>
          <dt>Elapsed time</dt>
          <dd>{result.timing.elapsedMs.toLocaleString()} ms</dd>
        </div>
        <div>
          <dt>Bytes scanned</dt>
          <dd>
            {result.timing.bytesScanned === null
              ? 'Not reported'
              : result.timing.bytesScanned.toLocaleString()}
          </dd>
        </div>
        <div>
          <dt>Row count</dt>
          <dd>{rows.length.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Public evidence</dt>
          <dd>
            {selected.operation === 'dataset.getInfo'
              ? 'None — release metadata operation'
              : `${citations.toLocaleString()} public evidence identifiers`}
          </dd>
        </div>
      </dl>
    </section>
  );
}

export function QueryConsolePage() {
  const { client, releaseId } = useOracle();
  const [searchParams, setSearchParams] = useSearchParams();
  const selected = consoleOperation(searchParams.get('operation'));
  const [draftOperation, setDraftOperation] = useState<string>(
    selected?.toolName ?? queryConsoleOperations[0]?.toolName ?? 'get_dataset_info',
  );
  const draft = consoleOperation(draftOperation) ?? queryConsoleOperations[0] ?? null;
  const request = consoleRequest(selected, searchParams, releaseId);
  const operation = selected?.operation ?? 'dataset.getInfo';
  const query = useApiQuery(
    client,
    operation,
    request.input,
    selected !== null && request.error === null && (!selected.releaseBound || releaseId !== null),
  );

  function submit(event: FormSubmitEvent) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const submitted = consoleOperation(formString(form, 'operation'));
    if (submitted === null) return;
    const next = new URLSearchParams({ operation: submitted.toolName });
    if (submitted.releaseBound) {
      const limit = formString(form, 'limit');
      const parsedLimit = Number(limit);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) return;
      next.set('limit', limit);
      const city = formString(form, 'city').trim();
      if (city !== '') next.set('city', city);
      for (const field of submitted.fields) {
        if (field.type === 'checkbox') {
          next.set(field.key, form.get(field.key) === 'on' ? 'true' : 'false');
        } else {
          next.set(field.key, formString(form, field.key));
        }
      }
    }
    setSearchParams(next);
  }

  return (
    <>
      <PageHeader
        eyebrow="DuckDB evaluator"
        title="SQL-free DuckDB named query console"
        description="Choose one allowlisted operation and bounded structured fields. The browser accepts no query text, relation, path, URL, host, object key, or caller-controlled data authority."
      />
      <div className="semantic-warning">
        <ShieldCheck aria-hidden="true" />
        <p>
          <strong>Fixed execution boundary:</strong> every selection maps to one reviewed operation;
          values are parameters and the immutable release remains server-owned.
        </p>
      </div>
      <form
        className="filter-panel query-console-form"
        aria-label="Named query controls"
        onSubmit={submit}
      >
        <label className="field field-grow">
          <span>Fixed named operation</span>
          <select
            name="operation"
            value={draftOperation}
            onChange={(event) => setDraftOperation(event.currentTarget.value)}
          >
            {queryConsoleOperations.map((candidate) => (
              <option key={candidate.toolName} value={candidate.toolName}>
                {candidate.title} — {candidate.toolName}
              </option>
            ))}
          </select>
        </label>
        {draft?.releaseBound === true ? (
          <>
            <label className="field">
              <span>City</span>
              <input
                name="city"
                maxLength={100}
                defaultValue={searchParams.get('city') ?? ''}
                placeholder="All cities"
              />
            </label>
            <label className="field field-small">
              <span>Maximum rows</span>
              <input
                name="limit"
                type="number"
                min="1"
                max="100"
                step="1"
                defaultValue={searchParams.get('limit') ?? '25'}
              />
            </label>
            {draft.fields.map((field) =>
              field.type === 'checkbox' ? (
                <label className="check-field" key={field.key}>
                  <input
                    name={field.key}
                    type="checkbox"
                    defaultChecked={
                      searchParams.has(field.key)
                        ? searchParams.get(field.key) === 'true'
                        : field.checked === true
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
                    min={field.step === '0.1' ? '0' : '1'}
                    max={consoleFieldMaximum(field.key)}
                    step={field.step ?? '1'}
                    defaultValue={searchParams.get(field.key) ?? field.value}
                  />
                </label>
              ),
            )}
          </>
        ) : null}
        <button className="button primary" type="submit">
          <Play aria-hidden="true" /> Run fixed operation
        </button>
      </form>
      {request.error === null ? null : (
        <div className="form-alert" role="alert">
          <AlertTriangle aria-hidden="true" /> {request.error}
        </div>
      )}
      <ReleaseGate>
        {(release) => (
          <>
            <ReleaseBar envelope={release} />
            {query.status === 'success' && selected !== null ? (
              query.data.releaseId === release.releaseId ? (
                <QueryConsoleReceipt release={release} result={query.data} selected={selected} />
              ) : (
                <section className="state-panel error-state" role="alert">
                  <AlertTriangle aria-hidden="true" />
                  <div>
                    <h2>Release mismatch</h2>
                    <p>The operation response did not match the immutable evaluator release.</p>
                  </div>
                </section>
              )
            ) : null}
            {request.error === null ? (
              <StatePanel state={query} onRetry={query.retry}>
                {(data) => {
                  const rows = rowsFromData(data.data);
                  return (
                    <>
                      {selected?.operation === 'dataset.getInfo' ? (
                        <FactGrid record={rows[0] ?? {}} />
                      ) : (
                        <ResultViews
                          rows={rows}
                          caption={`${selected?.title ?? 'Named query'} results`}
                        />
                      )}
                      <CapabilityDetails envelope={data} />
                      <EnvelopeNotes envelope={data} />
                    </>
                  );
                }}
              </StatePanel>
            ) : null}
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
        description="Each public artifact is content-addressed by its own SHA-256 hash. The immutable release as a whole is addressed on IPFS by one manifest CID; there is no separate per-artifact CID."
      />
      <ReleaseGate>
        {(release) => (
          <>
            <ReleaseBar envelope={release} />
            <div className="architecture-note">
              <ShieldCheck aria-hidden="true" />
              <div>
                <strong>Content addressing</strong>
                <p>
                  Every row below is addressed by its per-artifact SHA-256 content hash. The whole
                  immutable release is addressed on IPFS by the manifest CID{' '}
                  <code>{release.manifestCid}</code>.
                </p>
              </div>
            </div>
            <StatePanel state={query} onRetry={query.retry}>
              {(data) => (
                <>
                  <EvidenceTable
                    caption="Immutable public release artifacts"
                    rows={rowsFromData(data.data)}
                    columns={[
                      {
                        label: 'Artifact relation',
                        keys: ['relation', 'artifactId', 'name', 'type'],
                      },
                      { label: 'Media type', keys: ['media_type', 'mediaType', 'contentType'] },
                      { label: 'SHA-256 content hash', keys: ['sha256', 'checksum'] },
                      { label: 'Bytes', keys: ['byte_size', 'bytes', 'sizeBytes'] },
                      { label: 'Rows', keys: ['row_count', 'rowCount', 'rows'] },
                      { label: 'Publication', keys: ['visibility', 'publicationClass'] },
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
                      { label: 'Entity', keys: ['relation_name', 'entity', 'table'] },
                      { label: 'Field', keys: ['column_name', 'field', 'name'] },
                      { label: 'Type', keys: ['duckdb_type', 'type', 'dataType'] },
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
                {namedEvidenceTools.map((tool) => (
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
