import { createHash } from 'node:crypto';
import { access, mkdir, open, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { DuckDBInstance, type DuckDBAppender, type DuckDBConnection } from '@duckdb/node-api';

import {
  PUBLIC_PROHIBITED_COLUMN_PATTERN,
  SERVING_RELATIONS,
  type ServingColumn,
  type ServingRelationDefinition,
  type ServingRelationName,
  type ServingRow,
  type ServingScalar,
  type ServingVisibility,
} from './schema.js';

type InputRelationName = Exclude<ServingRelationName, 'data_dictionary'>;

export type ServingProfileInput = Readonly<{
  visibility: ServingVisibility;
  relations: Readonly<Partial<Record<InputRelationName, readonly ServingRow[]>>>;
}>;

export type PortableServingBuildInput = Readonly<{
  outputDirectory: string;
  releaseId: string;
  runId: string;
  generatedAt: string;
  sourceIds: readonly string[];
  profiles: readonly ServingProfileInput[];
}>;

export type BuiltServingArtifact = Readonly<{
  relation: ServingRelationName;
  relativePath: string;
  visibility: ServingVisibility;
  mediaType: 'application/vnd.apache.parquet';
  byteSize: number;
  sha256: string;
  rowCount: number;
  schemaSha256: string;
  columns: readonly ServingColumn[];
  nonNullCounts: Readonly<Record<string, number>>;
}>;

export type PortableServingBuildResult = Readonly<{
  releaseId: string;
  runId: string;
  generatedAt: string;
  sourceIds: readonly string[];
  duckdbVersion: string;
  artifacts: readonly BuiltServingArtifact[];
}>;

const SUPPORT_CLASSES = new Set(['supported', 'proxy', 'unknown', 'unsupported']);
const VISIBILITY_COLUMNS = new Set<ServingRelationName>([
  'canonical_history',
  'property_query',
  'property_evidence',
  'data_dictionary',
]);

export async function buildPortableServingRelease(
  input: PortableServingBuildInput,
): Promise<PortableServingBuildResult> {
  const normalizedInput = validateBuildInput(input);
  await assertTargetsAbsent(normalizedInput);
  const instance = await DuckDBInstance.create(':memory:', { threads: '1' });
  let connection: DuckDBConnection | undefined;
  try {
    connection = await instance.connect();
    await connection.run('SET preserve_insertion_order = true');
    await connection.run('SET threads = 1');
    const versionRows = await connection.runAndReadAll('PRAGMA version');
    const version = versionRows.getRowObjects()[0]?.library_version;
    if (typeof version !== 'string' || version.length === 0) {
      throw new Error('DuckDB did not report a library version');
    }
    const artifacts: BuiltServingArtifact[] = [];
    for (const profile of normalizedInput.profiles) {
      const built = await buildProfile(connection, normalizedInput.outputDirectory, profile);
      artifacts.push(...built);
    }
    return Object.freeze({
      releaseId: normalizedInput.releaseId,
      runId: normalizedInput.runId,
      generatedAt: normalizedInput.generatedAt,
      sourceIds: normalizedInput.sourceIds,
      duckdbVersion: version,
      artifacts: Object.freeze(
        artifacts.sort(
          (left, right) =>
            left.visibility.localeCompare(right.visibility) ||
            left.relation.localeCompare(right.relation),
        ),
      ),
    });
  } finally {
    connection?.closeSync();
    instance.closeSync();
  }
}

async function buildProfile(
  connection: DuckDBConnection,
  outputDirectory: string,
  profile: ServingProfileInput,
): Promise<readonly BuiltServingArtifact[]> {
  const relationRows = new Map<ServingRelationName, readonly ServingRow[]>();
  for (const [name, rows] of Object.entries(profile.relations) as [
    InputRelationName,
    readonly ServingRow[],
  ][]) {
    relationRows.set(name, normalizeRows(SERVING_RELATIONS[name], rows, profile.visibility));
  }
  const dictionaryRows = dataDictionaryRows([...relationRows.keys()], profile.visibility);
  relationRows.set(
    'data_dictionary',
    normalizeRows(SERVING_RELATIONS.data_dictionary, dictionaryRows, profile.visibility),
  );
  assertEvidenceReferences(relationRows);

  const profileDirectory = join(outputDirectory, profile.visibility);
  await mkdir(profileDirectory, { recursive: true });
  const artifacts: BuiltServingArtifact[] = [];
  for (const [name, rows] of [...relationRows.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const definition = SERVING_RELATIONS[name];
    const tableName = `build_${profile.visibility}_${name}`;
    await connection.run(createTableSql(tableName, definition.columns));
    const appender = await connection.createAppender(tableName);
    try {
      for (const row of rows) appendRow(appender, definition.columns, row);
      appender.flushSync();
    } finally {
      appender.closeSync();
    }
    const artifactPath = join(profileDirectory, definition.fileName);
    await connection.run(copyParquetSql(tableName, definition, artifactPath));
    const bytes = await readFile(artifactPath);
    const fileStat = await stat(artifactPath);
    if (fileStat.size !== bytes.byteLength) throw new Error(`Unstable file size: ${artifactPath}`);
    artifacts.push(
      Object.freeze({
        relation: name,
        relativePath: portableRelativePath(outputDirectory, artifactPath),
        visibility: profile.visibility,
        mediaType: 'application/vnd.apache.parquet',
        byteSize: bytes.byteLength,
        sha256: sha256(bytes),
        rowCount: rows.length,
        schemaSha256: sha256(Buffer.from(stableJson(definition.columns))),
        columns: definition.columns,
        nonNullCounts: Object.freeze(nonNullCounts(definition, rows)),
      }),
    );
    await connection.run(`DROP TABLE ${quoteIdentifier(tableName)}`);
  }
  return Object.freeze(artifacts);
}

function validateBuildInput(input: PortableServingBuildInput): PortableServingBuildInput {
  if (input.outputDirectory.trim().length === 0) throw new TypeError('outputDirectory is required');
  if (input.releaseId.trim().length === 0) throw new TypeError('releaseId is required');
  if (input.runId.trim().length === 0) throw new TypeError('runId is required');
  assertInstant(input.generatedAt, 'generatedAt');
  if (input.sourceIds.length === 0 || input.sourceIds.some((value) => value.trim().length === 0)) {
    throw new TypeError('At least one non-empty sourceId is required');
  }
  const visibilities = input.profiles.map(({ visibility }) => visibility);
  if (input.profiles.length === 0 || new Set(visibilities).size !== visibilities.length) {
    throw new TypeError('Build profiles must contain unique visibility classes');
  }
  for (const profile of input.profiles) {
    for (const name of Object.keys(profile.relations) as InputRelationName[]) {
      const definition = SERVING_RELATIONS[name];
      if (!definition.allowedVisibilities.includes(profile.visibility)) {
        throw new PublicArtifactPolicyError(
          `${name} is not allowed in the ${profile.visibility} artifact class`,
        );
      }
      if (
        profile.visibility === 'public' &&
        definition.columns.some(({ name: columnName }) =>
          PUBLIC_PROHIBITED_COLUMN_PATTERN.test(columnName),
        )
      ) {
        throw new PublicArtifactPolicyError(
          `Public relation ${name} contains a prohibited column contract`,
        );
      }
    }
  }
  return Object.freeze({
    ...input,
    outputDirectory: resolve(input.outputDirectory),
    sourceIds: Object.freeze([...new Set(input.sourceIds)].sort()),
    profiles: Object.freeze(
      input.profiles
        .map((profile) => Object.freeze({ ...profile }))
        .sort((left, right) => left.visibility.localeCompare(right.visibility)),
    ),
  });
}

async function assertTargetsAbsent(input: PortableServingBuildInput): Promise<void> {
  for (const profile of input.profiles) {
    const names = [
      ...(Object.keys(profile.relations) as InputRelationName[]),
      'data_dictionary' as const,
    ];
    for (const name of names) {
      const target = join(
        input.outputDirectory,
        profile.visibility,
        SERVING_RELATIONS[name].fileName,
      );
      try {
        await access(target);
      } catch {
        continue;
      }
      throw new ImmutableReleaseExistsError(target);
    }
  }
}

function normalizeRows(
  definition: ServingRelationDefinition,
  rows: readonly ServingRow[],
  visibility: ServingVisibility,
): readonly ServingRow[] {
  const normalized = rows.map((row, rowIndex) =>
    normalizeRow(definition, row, rowIndex, visibility),
  );
  normalized.sort((left, right) => compareRows(definition.sortColumns, left, right));
  const seen = new Set<string>();
  for (const row of normalized) {
    const key = definition.uniqueColumns.map((name) => scalarKey(row[name])).join('\0');
    if (seen.has(key)) {
      throw new RowGrainError(`${definition.name} contains duplicate grain key ${key}`);
    }
    seen.add(key);
  }
  return Object.freeze(normalized.map((row) => Object.freeze(row)));
}

function normalizeRow(
  definition: ServingRelationDefinition,
  row: ServingRow,
  rowIndex: number,
  visibility: ServingVisibility,
): ServingRow {
  const expected = definition.columns.map(({ name }) => name);
  const actual = Object.keys(row).sort();
  const expectedSorted = [...expected].sort();
  if (actual.join('\0') !== expectedSorted.join('\0')) {
    throw new ServingSchemaError(
      `${definition.name}[${rowIndex}] keys differ from schema: expected ${expectedSorted.join(',')}; received ${actual.join(',')}`,
    );
  }
  const output: Record<string, ServingScalar> = {};
  for (const column of definition.columns) {
    const raw = row[column.name];
    if (raw === null) {
      if (!column.nullable) {
        throw new ServingSchemaError(
          `${definition.name}[${rowIndex}].${column.name} cannot be null`,
        );
      }
      output[column.name] = null;
      continue;
    }
    if (raw === undefined) {
      throw new ServingSchemaError(`${definition.name}[${rowIndex}].${column.name} is missing`);
    }
    output[column.name] = normalizeScalar(definition.name, column, raw, rowIndex);
  }
  validateSemanticRow(definition.name, output, rowIndex, visibility);
  return output;
}

function normalizeScalar(
  relation: ServingRelationName,
  column: ServingColumn,
  raw: Exclude<ServingScalar, null>,
  rowIndex: number,
): Exclude<ServingScalar, null> {
  if (column.duckdbType === 'VARCHAR') {
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new ServingSchemaError(
        `${relation}[${rowIndex}].${column.name} must be a non-empty string`,
      );
    }
    if (column.name.endsWith('_json')) {
      try {
        return stableJson(JSON.parse(raw) as unknown);
      } catch (error) {
        throw new ServingSchemaError(
          `${relation}[${rowIndex}].${column.name} must contain valid JSON`,
          { cause: error },
        );
      }
    }
    return raw;
  }
  if (column.duckdbType === 'BOOLEAN') {
    if (typeof raw !== 'boolean') {
      throw new ServingSchemaError(`${relation}[${rowIndex}].${column.name} must be boolean`);
    }
    return raw;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new ServingSchemaError(`${relation}[${rowIndex}].${column.name} must be finite`);
  }
  if (column.duckdbType === 'BIGINT' && !Number.isSafeInteger(raw)) {
    throw new ServingSchemaError(`${relation}[${rowIndex}].${column.name} must be a safe integer`);
  }
  return raw;
}

function validateSemanticRow(
  relation: ServingRelationName,
  row: Record<string, ServingScalar>,
  rowIndex: number,
  visibility: ServingVisibility,
): void {
  if (VISIBILITY_COLUMNS.has(relation) && row.visibility !== visibility) {
    throw new PublicArtifactPolicyError(
      `${relation}[${rowIndex}] visibility ${String(row.visibility)} does not match ${visibility} artifact`,
    );
  }
  for (const [name, value] of Object.entries(row)) {
    if (name.endsWith('_support_class') || name === 'support_class') {
      if (typeof value !== 'string' || !SUPPORT_CLASSES.has(value)) {
        throw new ServingSchemaError(`${relation}[${rowIndex}].${name} has invalid support class`);
      }
    }
    if (name === 'confidence' || name === 'ratio' || name === 'evidence_coverage') {
      if (typeof value !== 'number' || value < 0 || value > 1) {
        throw new ServingSchemaError(`${relation}[${rowIndex}].${name} must be in [0,1]`);
      }
    }
    if (name === 'latitude' && value !== null && (Number(value) < -90 || Number(value) > 90)) {
      throw new ServingSchemaError(`${relation}[${rowIndex}].latitude is out of range`);
    }
    if (name === 'longitude' && value !== null && (Number(value) < -180 || Number(value) > 180)) {
      throw new ServingSchemaError(`${relation}[${rowIndex}].longitude is out of range`);
    }
    if (
      (name.endsWith('_at') || name === 'as_of' || name === 'valid_from' || name === 'valid_to') &&
      value !== null
    ) {
      assertInstant(String(value), `${relation}[${rowIndex}].${name}`);
    }
    if (name.endsWith('sha256') && (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))) {
      throw new ServingSchemaError(`${relation}[${rowIndex}].${name} must be lowercase SHA-256`);
    }
  }
  if (relation === 'field_coverage') assertRatio(row, 'numerator', 'denominator', rowIndex);
  if (relation === 'relation_coverage')
    assertRatio(row, 'linked_count', 'eligible_count', rowIndex);
  if (relation === 'source_coverage') {
    const expected = row.expected_count;
    const observed = row.observed_count;
    if (typeof expected === 'number' && typeof observed === 'number' && observed > expected) {
      throw new ServingSchemaError(
        `source_coverage[${rowIndex}] observed_count exceeds expected_count`,
      );
    }
  }
}

function assertRatio(
  row: Record<string, ServingScalar>,
  numeratorName: string,
  denominatorName: string,
  rowIndex: number,
): void {
  const numerator = row[numeratorName];
  const denominator = row[denominatorName];
  const ratio = row.ratio;
  if (
    typeof numerator !== 'number' ||
    typeof denominator !== 'number' ||
    typeof ratio !== 'number'
  ) {
    throw new ServingSchemaError(`coverage[${rowIndex}] count and ratio types are invalid`);
  }
  if (numerator < 0 || denominator < 0 || numerator > denominator) {
    throw new ServingSchemaError(`coverage[${rowIndex}] has invalid counts`);
  }
  const expected = denominator === 0 ? 0 : numerator / denominator;
  if (Math.abs(ratio - expected) > 1e-12) {
    throw new ServingSchemaError(`coverage[${rowIndex}] ratio does not match counts`);
  }
}

function assertEvidenceReferences(
  relations: ReadonlyMap<ServingRelationName, readonly ServingRow[]>,
): void {
  const properties = relations.get('property_query');
  const evidence = relations.get('property_evidence');
  if (properties === undefined || evidence === undefined) return;
  const propertyIds = new Set(properties.map((row) => row.property_id));
  for (const row of evidence) {
    if (!propertyIds.has(row.property_id)) {
      throw new RowGrainError(`Evidence ${String(row.evidence_id)} references an absent property`);
    }
  }
}

function dataDictionaryRows(
  relationNames: readonly ServingRelationName[],
  visibility: ServingVisibility,
): readonly ServingRow[] {
  const names = [...relationNames, 'data_dictionary' as const].sort();
  return Object.freeze(
    names.flatMap((name) => {
      const definition = SERVING_RELATIONS[name];
      return definition.columns.map((item, index) => ({
        relation_name: definition.name,
        ordinal: index + 1,
        column_name: item.name,
        duckdb_type: item.duckdbType,
        nullable: item.nullable,
        grain: definition.grain,
        description: item.description,
        visibility,
      }));
    }),
  );
}

function createTableSql(table: string, columns: readonly ServingColumn[]): string {
  const definitions = columns.map(
    ({ name, duckdbType, nullable }) =>
      `${quoteIdentifier(name)} ${duckdbType}${nullable ? '' : ' NOT NULL'}`,
  );
  return `CREATE TABLE ${quoteIdentifier(table)} (${definitions.join(', ')})`;
}

function appendRow(
  appender: DuckDBAppender,
  columns: readonly ServingColumn[],
  row: ServingRow,
): void {
  for (const column of columns) {
    const value = row[column.name];
    if (value === null || value === undefined) appender.appendNull();
    else if (column.duckdbType === 'VARCHAR') appender.appendVarchar(String(value));
    else if (column.duckdbType === 'BOOLEAN') appender.appendBoolean(Boolean(value));
    else if (column.duckdbType === 'BIGINT') appender.appendBigInt(BigInt(Number(value)));
    else appender.appendDouble(Number(value));
  }
  appender.endRow();
}

function copyParquetSql(
  table: string,
  definition: ServingRelationDefinition,
  artifactPath: string,
): string {
  const columns = definition.columns.map(({ name }) => quoteIdentifier(name)).join(', ');
  const order = definition.sortColumns.map(quoteIdentifier).join(', ');
  return `COPY (SELECT ${columns} FROM ${quoteIdentifier(table)} ORDER BY ${order}) TO '${sqlPath(artifactPath)}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 122880)`;
}

function nonNullCounts(
  definition: ServingRelationDefinition,
  rows: readonly ServingRow[],
): Record<string, number> {
  return Object.fromEntries(
    definition.columns.map(({ name }) => [
      name,
      rows.reduce((count, row) => count + (row[name] === null ? 0 : 1), 0),
    ]),
  );
}

function compareRows(columns: readonly string[], left: ServingRow, right: ServingRow): number {
  for (const name of columns) {
    const compared = scalarKey(left[name]).localeCompare(scalarKey(right[name]));
    if (compared !== 0) return compared;
  }
  return 0;
}

function scalarKey(value: ServingScalar | undefined): string {
  if (value === null || value === undefined) return '\uffff';
  if (typeof value === 'number') return value.toString().padStart(24, '0');
  return String(value);
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

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqlPath(value: string): string {
  return resolve(value).replaceAll('\\', '/').replaceAll("'", "''");
}

function portableRelativePath(root: string, path: string): string {
  const result = relative(resolve(root), resolve(path)).replaceAll('\\', '/');
  if (result.startsWith('../') || result === '..') throw new Error('Artifact escaped release root');
  return result;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertInstant(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value)) || !/[zZ]|[+-]\d\d:\d\d$/u.test(value)) {
    throw new ServingSchemaError(`${label} must be an offset-qualified ISO-8601 timestamp`);
  }
}

export async function readArtifactRange(
  path: string,
  start: number,
  endInclusive: number,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(endInclusive) ||
    start < 0 ||
    endInclusive < start
  ) {
    throw new RangeError('Range must use non-negative inclusive safe-integer bounds');
  }
  const handle = await open(path, 'r');
  try {
    const length = endInclusive - start + 1;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    if (bytesRead !== length) throw new RangeError('Requested range exceeds artifact length');
    return buffer;
  } finally {
    await handle.close();
  }
}

export class ServingSchemaError extends TypeError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ServingSchemaError';
  }
}

export class RowGrainError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RowGrainError';
  }
}

export class PublicArtifactPolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PublicArtifactPolicyError';
  }
}

export class ImmutableReleaseExistsError extends Error {
  public constructor(path: string) {
    super(`Immutable release artifact already exists: ${path}`);
    this.name = 'ImmutableReleaseExistsError';
  }
}
