import { createHash } from 'node:crypto';

import type { ReleaseArtifactInput, ReleaseColumn } from './manifest.js';

export const ELEPHANT_COMPATIBILITY_COLUMNS: readonly Readonly<
  Pick<ReleaseColumn, 'name' | 'duckdbType' | 'nullable'>
>[] = Object.freeze(
  [
    ['property_id', 'VARCHAR', false],
    ['property_cid', 'VARCHAR', true],
    ['request_identifier', 'VARCHAR', true],
    ['parcel_identifier', 'VARCHAR', true],
    ['source_system', 'VARCHAR', true],
    ['county_name', 'VARCHAR', true],
    ['state_code', 'VARCHAR', true],
    ['address_street', 'VARCHAR', true],
    ['address_city', 'VARCHAR', true],
    ['address_zip', 'VARCHAR', true],
    ['latitude', 'DOUBLE', true],
    ['longitude', 'DOUBLE', true],
    ['lot_size_acre', 'DOUBLE', true],
    ['lot_area_sqft', 'DOUBLE', true],
    ['exterior_wall_material', 'VARCHAR', true],
    ['roof_covering_material', 'VARCHAR', true],
    ['property_type', 'VARCHAR', true],
    ['property_usage_type', 'VARCHAR', true],
    ['built_year', 'BIGINT', true],
    ['livable_floor_area', 'DOUBLE', true],
    ['total_area', 'DOUBLE', true],
    ['assessed_value', 'DOUBLE', true],
    ['market_value', 'DOUBLE', true],
    ['land_value', 'DOUBLE', true],
    ['avm_value', 'DOUBLE', true],
    ['owner_name', 'VARCHAR', true],
    ['owners_text', 'VARCHAR', true],
    ['owner_count', 'BIGINT', true],
    ['owner_occupied', 'BOOLEAN', true],
    ['last_sale_date', 'VARCHAR', true],
    ['last_sale_price', 'DOUBLE', true],
    ['subdivision', 'VARCHAR', true],
    ['has_permits', 'BOOLEAN', true],
    ['permit_count', 'BIGINT', true],
    ['has_sunbiz_tenant', 'BOOLEAN', true],
    ['has_bbb_contractor', 'BOOLEAN', true],
    ['hoa_flag', 'BOOLEAN', true],
  ].map(([name, duckdbType, nullable]) =>
    Object.freeze({ name, duckdbType, nullable }),
  ) as readonly Readonly<Pick<ReleaseColumn, 'name' | 'duckdbType' | 'nullable'>>[],
);

export type ElephantFieldLineage = Readonly<{
  canonicalRelation: string | null;
  canonicalField: string | null;
  sourceIds: readonly string[];
  transformation: string;
  completenessWindow: string | null;
  matchMethod: string;
  confidence: 'high' | 'medium' | 'low' | 'none';
  nullSemantics: string;
}>;

export type ElephantCompatibilityReportInput = Readonly<{
  artifact: ReleaseArtifactInput;
  auditedSource: Readonly<{
    repository: string;
    commitSha: string;
    path: string;
  }>;
  baseline: Readonly<{
    rowCount: number;
    distinctPropertyIds: number;
    nonNullCounts: Readonly<Record<string, number>>;
  }>;
  releaseDistinctPropertyIds: number;
  lineage: Readonly<Record<string, ElephantFieldLineage>>;
}>;

export type ElephantCompatibilityReport = Readonly<{
  contractVersion: '1.0.0';
  relation: 'elephant_properties';
  artifactSha256: string;
  auditedSource: ElephantCompatibilityReportInput['auditedSource'];
  baselineRowCount: number;
  releaseRowCount: number;
  baselineDistinctPropertyIds: number;
  releaseDistinctPropertyIds: number;
  fields: readonly Readonly<{
    ordinal: number;
    name: string;
    duckdbType: string;
    nullable: boolean;
    baselineNonNullCount: number;
    releaseNonNullCount: number;
    baselineCoverage: number;
    releaseCoverage: number;
    delta: number;
    change: 'unchanged' | 'filled' | 'improved' | 'regressed';
    lineage: ElephantFieldLineage;
  }>[];
  reportSha256: string;
}>;

export function createElephantCompatibilityReport(
  input: ElephantCompatibilityReportInput,
): ElephantCompatibilityReport {
  if (input.artifact.relation !== 'elephant_properties') {
    throw new TypeError('Compatibility report requires elephant_properties');
  }
  const actualSchema = input.artifact.columns.map(({ name, duckdbType, nullable }) => ({
    name,
    duckdbType,
    nullable,
  }));
  if (JSON.stringify(actualSchema) !== JSON.stringify(ELEPHANT_COMPATIBILITY_COLUMNS)) {
    throw new ElephantContractDriftError(
      'Elephant column order or types drifted from the audited contract',
    );
  }
  if (
    input.baseline.rowCount !== input.artifact.rowCount ||
    input.baseline.distinctPropertyIds !== input.releaseDistinctPropertyIds ||
    input.releaseDistinctPropertyIds !== input.artifact.rowCount
  ) {
    throw new ElephantDenominatorDriftError(
      'Elephant release must preserve the audited row/property denominator',
    );
  }
  assertExactFields(input.baseline.nonNullCounts, 'baseline non-null counts');
  assertExactFields(input.lineage, 'field lineage');
  const fields = ELEPHANT_COMPATIBILITY_COLUMNS.map((column, index) => {
    const baseline = input.baseline.nonNullCounts[column.name];
    const release = input.artifact.nonNullCounts[column.name];
    const lineage = input.lineage[column.name];
    if (baseline === undefined || release === undefined || lineage === undefined) {
      throw new TypeError(`Missing Elephant field evidence for ${column.name}`);
    }
    assertCount(baseline, input.baseline.rowCount, `baseline.${column.name}`);
    assertCount(release, input.artifact.rowCount, `release.${column.name}`);
    const baselineCoverage = ratio(baseline, input.baseline.rowCount);
    const releaseCoverage = ratio(release, input.artifact.rowCount);
    const change =
      release < baseline
        ? 'regressed'
        : baseline === 0 && release > 0
          ? 'filled'
          : release > baseline
            ? 'improved'
            : 'unchanged';
    return Object.freeze({
      ordinal: index + 1,
      ...column,
      baselineNonNullCount: baseline,
      releaseNonNullCount: release,
      baselineCoverage,
      releaseCoverage,
      delta: release - baseline,
      change,
      lineage: Object.freeze({
        ...lineage,
        sourceIds: Object.freeze([...lineage.sourceIds].sort()),
      }),
    });
  });
  const payload = Object.freeze({
    contractVersion: '1.0.0' as const,
    relation: 'elephant_properties' as const,
    artifactSha256: input.artifact.sha256,
    auditedSource: Object.freeze({ ...input.auditedSource }),
    baselineRowCount: input.baseline.rowCount,
    releaseRowCount: input.artifact.rowCount,
    baselineDistinctPropertyIds: input.baseline.distinctPropertyIds,
    releaseDistinctPropertyIds: input.releaseDistinctPropertyIds,
    fields: Object.freeze(fields),
  });
  return Object.freeze({
    ...payload,
    reportSha256: createHash('sha256')
      .update(`${stableJson(payload)}\n`)
      .digest('hex'),
  });
}

function assertExactFields(value: Readonly<Record<string, unknown>>, label: string): void {
  const expected = ELEPHANT_COMPATIBILITY_COLUMNS.map(({ name }) => name).sort();
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ElephantContractDriftError(`${label} must cover exactly all 37 Elephant columns`);
  }
}

function assertCount(value: number, denominator: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > denominator) {
    throw new TypeError(`${label} is outside its denominator`);
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

export class ElephantContractDriftError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ElephantContractDriftError';
  }
}

export class ElephantDenominatorDriftError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ElephantDenominatorDriftError';
  }
}
