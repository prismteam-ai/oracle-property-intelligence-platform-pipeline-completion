import {
  AlertTriangle,
  Ban,
  Calculator,
  CheckCircle2,
  CircleHelp,
  Clock3,
  Database,
  FileWarning,
  MapPinned,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { displayValue, isRecord, rowsFromData, truthStateFrom, valueFor } from './api.js';
import type { ApiEnvelope, DataRow, QueryState, TruthState } from './types.js';

const truthContent: Readonly<Record<TruthState, Readonly<{ label: string; icon: ReactNode }>>> = {
  direct: { label: 'Supported — direct evidence', icon: <CheckCircle2 aria-hidden="true" /> },
  derived: { label: 'Supported — derived evidence', icon: <Calculator aria-hidden="true" /> },
  proxy: { label: 'Proxy — review required', icon: <AlertTriangle aria-hidden="true" /> },
  partial: { label: 'Partial coverage', icon: <FileWarning aria-hidden="true" /> },
  blocked: { label: 'Blocked — source/access', icon: <ShieldAlert aria-hidden="true" /> },
  unsupported: { label: 'Unsupported', icon: <Ban aria-hidden="true" /> },
  unknown: { label: 'Evidence unknown', icon: <CircleHelp aria-hidden="true" /> },
};

export function TruthBadge({ state }: Readonly<{ state: TruthState }>) {
  const content = truthContent[state];
  return (
    <span className={`truth-badge truth-${state}`} data-truth-state={state}>
      {content.icon}
      {content.label}
    </span>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: Readonly<{
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}>) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1 tabIndex={-1}>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {actions === undefined ? null : <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function ReleaseBar({ envelope }: Readonly<{ envelope: ApiEnvelope }>) {
  return (
    <section className="release-bar" aria-label="Immutable dataset release">
      <Database aria-hidden="true" />
      <div>
        <span className="release-label">Immutable verified release</span>
        <strong>{envelope.releaseId}</strong>
      </div>
      <dl>
        <div>
          <dt>As of</dt>
          <dd>{formatDate(envelope.asOf)}</dd>
        </div>
        <div>
          <dt>Run</dt>
          <dd>{envelope.runId}</dd>
        </div>
        <div>
          <dt>Manifest CID</dt>
          <dd>{envelope.manifestCid}</dd>
        </div>
      </dl>
    </section>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
      }).format(date) + ' UTC';
}

function returnedCapabilities(envelope: ApiEnvelope) {
  if (isRecord(envelope.data) && isRecord(envelope.data.capability)) {
    return [{ name: 'Query', capability: envelope.data.capability }] as const;
  }
  if (!isRecord(envelope.coverage)) return [];
  return Object.entries(envelope.coverage)
    .filter((entry): entry is [string, Readonly<Record<string, unknown>>] => isRecord(entry[1]))
    .filter(([, capability]) => typeof capability.state === 'string')
    .map(([name, capability]) => ({ name, capability }));
}

export function CapabilityDetails({ envelope }: Readonly<{ envelope: ApiEnvelope }>) {
  const capabilities = returnedCapabilities(envelope);
  if (capabilities.length === 0) return null;
  return (
    <section
      className="capability-summary"
      aria-label="Returned capability"
      data-capability-state={
        capabilities.length === 1 ? displayValue(capabilities[0].capability.state) : 'multiple'
      }
    >
      <h3>Returned capability</h3>
      {capabilities.map(({ name, capability }) => {
        const supportClasses = Array.isArray(capability.supportClasses)
          ? capability.supportClasses
          : [];
        const limitations = Array.isArray(capability.limitations)
          ? capability.limitations.filter((value): value is string => typeof value === 'string')
          : [];
        return (
          <article key={name}>
            <h4>{name.replaceAll('_', ' ')} capability</h4>
            <dl className="fact-grid">
              <div>
                <dt>Capability state</dt>
                <dd>{displayValue(capability.state)}</dd>
              </div>
              <div>
                <dt>Supported result classes</dt>
                <dd>{displayValue(supportClasses)}</dd>
              </div>
              <div>
                <dt>Evidence coverage</dt>
                <dd>
                  {displayValue(capability.numerator)} / {displayValue(capability.denominator)}
                </dd>
              </div>
            </dl>
            {limitations.length === 0 ? null : (
              <div>
                <strong>Capability limitations</strong>
                <ul>
                  {limitations.map((limitation) => (
                    <li key={limitation}>{limitation}</li>
                  ))}
                </ul>
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}

export function StatePanel({
  state,
  onRetry,
  emptyTitle = 'No verified records returned',
  emptyDetail = 'The release returned an empty result for these parameters.',
  children,
}: Readonly<{
  state: QueryState;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyDetail?: string;
  children: (data: ApiEnvelope) => ReactNode;
}>) {
  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <section className="state-panel loading-state" aria-live="polite" aria-busy="true">
        <span className="loading-orbit" aria-hidden="true" />
        <div>
          <h2>Loading verified release data</h2>
          <p>Waiting for the immutable API response. No placeholder county data is shown.</p>
        </div>
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section className="state-panel error-state" role="alert">
        <AlertTriangle aria-hidden="true" />
        <div>
          <h2>Verified data is unavailable</h2>
          <p>{state.error.message}</p>
          <p className="state-guidance">
            Production remains fail-closed; deterministic test fixtures are never substituted.
          </p>
          {onRetry === undefined ? null : (
            <button className="button secondary" type="button" onClick={onRetry}>
              <RefreshCw aria-hidden="true" /> Retry
            </button>
          )}
        </div>
      </section>
    );
  }
  const successfulData = state.data;
  if (successfulData === null) return null;
  if (rowsFromData(successfulData.data).length === 0) {
    return (
      <section className="state-panel empty-state" role="status">
        <CircleHelp aria-hidden="true" />
        <div>
          <h2>{emptyTitle}</h2>
          <p>{emptyDetail}</p>
          <CapabilityDetails envelope={successfulData} />
          <EnvelopeNotes envelope={successfulData} />
        </div>
      </section>
    );
  }
  return <>{children(successfulData)}</>;
}

export type TableColumn = Readonly<{
  label: string;
  keys: readonly string[];
  kind?: 'text' | 'truth' | 'property-link';
}>;

export function EvidenceTable({
  caption,
  rows,
  columns,
}: Readonly<{ caption: string; rows: readonly DataRow[]; columns: readonly TableColumn[] }>) {
  return (
    <div className="table-frame" tabIndex={0} role="region" aria-label={`${caption}, scrollable`}>
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th scope="col" key={column.label}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={displayValue(
                valueFor(row, ['propertyId', 'id', 'runId', 'artifactId']) ?? index,
              )}
            >
              {columns.map((column) => {
                const value = valueFor(row, column.keys);
                if (column.kind === 'truth') {
                  return (
                    <td key={column.label}>
                      <TruthBadge state={truthStateFrom(value)} />
                    </td>
                  );
                }
                if (column.kind === 'property-link' && typeof value === 'string') {
                  return (
                    <td key={column.label}>
                      <Link className="table-link" to={`/properties/${encodeURIComponent(value)}`}>
                        {value}
                      </Link>
                    </td>
                  );
                }
                return <td key={column.label}>{displayValue(value)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const resultColumns: readonly TableColumn[] = [
  { label: 'Property', keys: ['propertyId', 'property_id', 'id'], kind: 'property-link' },
  {
    label: 'Address',
    keys: ['address', 'formattedAddress', 'siteAddress', 'addressStreet', 'address_street'],
  },
  {
    label: 'Matched value',
    keys: ['matchedValue', 'value', 'featureValue', 'score', 'combined_review_score'],
  },
  {
    label: 'Evidence state',
    keys: ['supportState', 'support', 'state', 'supportClass'],
    kind: 'truth',
  },
  {
    label: 'Evidence / coverage',
    keys: ['evidenceIds', 'evidenceId', 'sourceIds', 'sourceId', 'evidence_coverage'],
  },
];

export function ResultViews({
  rows,
  caption,
}: Readonly<{ rows: readonly DataRow[]; caption: string }>) {
  const [view, setView] = useState<'table' | 'spatial'>('table');
  const rankingComponents = rows.flatMap((row, index) => {
    const value = valueFor(row, ['value']);
    if (!isRecord(value) || !Array.isArray(value.components)) return [];
    const components = value.components.filter(isRecord);
    if (components.length === 0) return [];
    return [
      {
        propertyId: displayValue(valueFor(row, ['propertyId', 'property_id', 'id'])),
        index,
        components,
      },
    ];
  });
  return (
    <section className="result-section" aria-labelledby="result-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Verified response</p>
          <h2 id="result-heading">{rows.length.toLocaleString()} returned rows</h2>
        </div>
        <div className="segmented-control" aria-label="Result view">
          <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')}>
            <Database aria-hidden="true" /> Table
          </button>
          <button
            type="button"
            aria-pressed={view === 'spatial'}
            onClick={() => setView('spatial')}
          >
            <MapPinned aria-hidden="true" /> Spatial evidence
          </button>
        </div>
      </div>
      {view === 'table' ? (
        <EvidenceTable caption={caption} rows={rows} columns={resultColumns} />
      ) : (
        <ol className="spatial-list" aria-label="Map-equivalent result list">
          {rows.map((row, index) => {
            const propertyId = displayValue(valueFor(row, ['propertyId', 'property_id', 'id']));
            return (
              <li key={`${propertyId}-${index}`}>
                <MapPinned aria-hidden="true" />
                <div>
                  <strong>
                    {displayValue(
                      valueFor(row, ['address', 'formattedAddress', 'addressStreet', 'address_street']),
                    )}
                  </strong>
                  <span>Property {propertyId}</span>
                </div>
                <dl>
                  <div>
                    <dt>Coordinates</dt>
                    <dd>
                      {displayValue(valueFor(row, ['latitude', 'lat']))},{' '}
                      {displayValue(valueFor(row, ['longitude', 'lng', 'lon']))}
                    </dd>
                  </div>
                  <div>
                    <dt>Distance / route basis</dt>
                    <dd>
                      {displayValue(
                        valueFor(row, ['networkDistanceMeters', 'distanceMeters', 'routeBasis']),
                      )}
                    </dd>
                  </div>
                </dl>
              </li>
            );
          })}
        </ol>
      )}
      {rankingComponents.length === 0 ? null : (
        <section className="ranking-components" aria-label="Returned ranking components">
          <h3>Score components and contributions</h3>
          {rankingComponents.map(({ propertyId, index, components }) => (
            <EvidenceTable
              key={`${propertyId}-${index}`}
              caption={`Ranking components for ${propertyId}`}
              rows={components}
              columns={[
                { label: 'Criterion', keys: ['criterion'] },
                { label: 'Evidence state', keys: ['supportClass'], kind: 'truth' },
                { label: 'Normalized value', keys: ['normalizedValue'] },
                { label: 'Weight', keys: ['weight'] },
                { label: 'Proxy multiplier', keys: ['proxyMultiplier'] },
                { label: 'Contribution', keys: ['contribution'] },
              ]}
            />
          ))}
        </section>
      )}
    </section>
  );
}

export function EnvelopeNotes({ envelope }: Readonly<{ envelope: ApiEnvelope }>) {
  return (
    <aside className="envelope-notes" aria-label="Query metadata and limitations">
      <Clock3 aria-hidden="true" />
      <div>
        <strong>Query receipt</strong>
        <span>
          {envelope.timing.elapsedMs.toLocaleString()} ms ·{' '}
          {envelope.timing.bytesScanned === null
            ? 'scan bytes not reported'
            : `${envelope.timing.bytesScanned.toLocaleString()} bytes scanned`}
        </span>
      </div>
      {envelope.limitations.length === 0 ? (
        <p>No public limitations were returned for this response.</p>
      ) : (
        <ul>
          {envelope.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      )}
    </aside>
  );
}
