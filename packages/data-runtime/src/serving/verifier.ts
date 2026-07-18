import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

import { readArtifactRange, type BuiltServingArtifact } from './builder.js';
import {
  BOUNDED_SERVING_RELATIONS,
  PUBLIC_PROHIBITED_COLUMN_PATTERN,
  SERVING_RELATIONS,
  type ServingRelationDefinition,
  type ServingVisibility,
} from './schema.js';

export type ArtifactVerification = Readonly<{
  relation: BuiltServingArtifact['relation'];
  visibility: ServingVisibility;
  rowCount: number;
  byteSize: number;
  sha256: string;
}>;

export async function verifyServingArtifacts(
  releaseRoot: string,
  artifacts: readonly BuiltServingArtifact[],
): Promise<readonly ArtifactVerification[]> {
  const instance = await DuckDBInstance.create(':memory:', { threads: '1' });
  let connection: DuckDBConnection | undefined;
  try {
    connection = await instance.connect();
    const results: ArtifactVerification[] = [];
    for (const artifact of artifacts) {
      const path = resolveInside(releaseRoot, artifact.relativePath);
      const fileStat = await stat(path);
      const bytes = await readFile(path);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== artifact.sha256) {
        throw new ArtifactCorruptionError(`${artifact.relativePath} SHA-256 mismatch`);
      }
      if (bytes.byteLength !== artifact.byteSize || fileStat.size !== artifact.byteSize) {
        throw new ArtifactCorruptionError(`${artifact.relativePath} byte-size mismatch`);
      }
      if (bytes.byteLength < 8)
        throw new ArtifactCorruptionError(`${artifact.relativePath} is too short`);
      const first = Buffer.from(await readArtifactRange(path, 0, 3)).toString('ascii');
      const last = Buffer.from(
        await readArtifactRange(path, artifact.byteSize - 4, artifact.byteSize - 1),
      ).toString('ascii');
      if (first !== 'PAR1' || last !== 'PAR1') {
        throw new ArtifactCorruptionError(
          `${artifact.relativePath} does not have Parquet boundaries`,
        );
      }
      assertArtifactContract(artifact);
      await assertDuckDbSchema(connection, path, artifact);
      await assertDuckDbGrain(connection, path, artifact);
      await assertDuckDbNonNullCounts(connection, path, artifact);
      if (artifact.visibility === 'public') {
        await assertNoRestrictedJsonFields(connection, path, artifact);
      }
      results.push(
        Object.freeze({
          relation: artifact.relation,
          visibility: artifact.visibility,
          rowCount: artifact.rowCount,
          byteSize: artifact.byteSize,
          sha256: artifact.sha256,
        }),
      );
    }
    return Object.freeze(results);
  } finally {
    connection?.closeSync();
    instance.closeSync();
  }
}

export async function openServingProfile(
  releaseRoot: string,
  artifacts: readonly BuiltServingArtifact[],
  visibility: ServingVisibility,
): Promise<Readonly<{ instance: DuckDBInstance; connection: DuckDBConnection }>> {
  const selected = artifacts.filter((artifact) => artifact.visibility === visibility);
  if (selected.length === 0) throw new Error(`Release has no ${visibility} serving artifacts`);
  const instance = await DuckDBInstance.create(':memory:', { threads: '1' });
  const connection = await instance.connect();
  try {
    for (const artifact of selected) {
      const path = resolveInside(releaseRoot, artifact.relativePath);
      await connection.run(
        `CREATE VIEW ${quoteIdentifier(artifact.relation)} AS SELECT * FROM read_parquet('${sqlPath(path)}')`,
      );
    }
    return Object.freeze({ instance, connection });
  } catch (error) {
    connection.closeSync();
    instance.closeSync();
    throw error;
  }
}

async function assertDuckDbSchema(
  connection: DuckDBConnection,
  path: string,
  artifact: BuiltServingArtifact,
): Promise<void> {
  const result = await connection.runAndReadAll(
    `DESCRIBE SELECT * FROM read_parquet('${sqlPath(path)}')`,
  );
  const rows = result.getRowObjects();
  const actual = rows.map((row) => ({ name: row.column_name, type: row.column_type }));
  const expected = artifact.columns.map(({ name, duckdbType }) => ({ name, type: duckdbType }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ArtifactSchemaDriftError(
      `${artifact.relativePath} schema drift: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
  if (
    artifact.visibility === 'public' &&
    artifact.columns.some(({ name }) => PUBLIC_PROHIBITED_COLUMN_PATTERN.test(name))
  ) {
    throw new ArtifactVisibilityError(
      `${artifact.relativePath} exposes a prohibited public column`,
    );
  }
}

function assertArtifactContract(artifact: BuiltServingArtifact): void {
  const definition = artifactDefinition(artifact);
  const expectedPath = `${artifact.visibility}/${definition.fileName}`;
  if (artifact.relativePath !== expectedPath) {
    throw new ArtifactVisibilityError(
      `${artifact.relativePath} does not match its ${artifact.visibility} release class`,
    );
  }
  if (!definition.allowedVisibilities.includes(artifact.visibility)) {
    throw new ArtifactVisibilityError(
      `${artifact.relation} is not allowed in the ${artifact.visibility} release class`,
    );
  }
  if (stableJson(artifact.columns) !== stableJson(definition.columns)) {
    throw new ArtifactSchemaDriftError(
      `${artifact.relativePath} metadata drifted from the serving contract`,
    );
  }
  const schemaSha256 = createHash('sha256').update(stableJson(definition.columns)).digest('hex');
  if (artifact.schemaSha256 !== schemaSha256) {
    throw new ArtifactSchemaDriftError(`${artifact.relativePath} schema hash mismatch`);
  }
  const expectedColumns = definition.columns.map(({ name }) => name).sort();
  if (
    JSON.stringify(Object.keys(artifact.nonNullCounts).sort()) !== JSON.stringify(expectedColumns)
  ) {
    throw new ArtifactSchemaDriftError(
      `${artifact.relativePath} non-null counts do not cover the exact schema`,
    );
  }
}

async function assertDuckDbNonNullCounts(
  connection: DuckDBConnection,
  path: string,
  artifact: BuiltServingArtifact,
): Promise<void> {
  const projections = artifact.columns
    .map(({ name }) => `count(${quoteIdentifier(name)})::BIGINT AS ${quoteIdentifier(name)}`)
    .join(', ');
  const result = await connection.runAndReadAll(
    `SELECT ${projections} FROM read_parquet('${sqlPath(path)}')`,
  );
  const row = result.getRowObjects()[0];
  for (const { name } of artifact.columns) {
    if (Number(row?.[name]) !== artifact.nonNullCounts[name]) {
      throw new ArtifactCountDriftError(
        `${artifact.relativePath}.${name} non-null count differs from manifest`,
      );
    }
  }
}

async function assertNoRestrictedJsonFields(
  connection: DuckDBConnection,
  path: string,
  artifact: BuiltServingArtifact,
): Promise<void> {
  const jsonColumns = artifact.columns.filter(({ name }) => name.endsWith('_json'));
  if (jsonColumns.length === 0) return;
  const keyPattern =
    '(?i)"[^"]*(owner[_ -]?name|owners[_ -]?text|mailing[_ -]?address|grantor|grantee|email|phone|contact)[^"]*"\\s*:';
  const predicate = jsonColumns
    .map(({ name }) => `regexp_matches(${quoteIdentifier(name)}, '${keyPattern}')`)
    .join(' OR ');
  const result = await connection.runAndReadAll(
    `SELECT count(*)::BIGINT AS leaks FROM read_parquet('${sqlPath(path)}') WHERE ${predicate}`,
  );
  if (Number(result.getRowObjects()[0]?.leaks) !== 0) {
    throw new ArtifactVisibilityError(`${artifact.relativePath} contains restricted JSON fields`);
  }
}

async function assertDuckDbGrain(
  connection: DuckDBConnection,
  path: string,
  artifact: BuiltServingArtifact,
): Promise<void> {
  const definition = artifactDefinition(artifact);
  const keys = definition.uniqueColumns.map(quoteIdentifier).join(', ');
  const nullPredicate = definition.uniqueColumns
    .map((column) => `${quoteIdentifier(column)} IS NULL`)
    .join(' OR ');
  const query = `
    SELECT
      count(*)::BIGINT AS row_count,
      count(*) FILTER (WHERE ${nullPredicate})::BIGINT AS null_keys,
      count(*)::BIGINT - count(DISTINCT (${keys}))::BIGINT AS duplicate_keys
    FROM read_parquet('${sqlPath(path)}')
  `;
  const result = await connection.runAndReadAll(query);
  const row = result.getRowObjects()[0];
  const rowCount = Number(row?.row_count);
  const nullKeys = Number(row?.null_keys);
  const duplicateKeys = Number(row?.duplicate_keys);
  if (rowCount !== artifact.rowCount) {
    throw new ArtifactCountDriftError(
      `${artifact.relativePath} row count ${rowCount} differs from manifest ${artifact.rowCount}`,
    );
  }
  if (nullKeys !== 0 || duplicateKeys !== 0) {
    throw new ArtifactGrainError(
      `${artifact.relativePath} has ${nullKeys} null and ${duplicateKeys} duplicate grain keys`,
    );
  }
}

/**
 * Portable releases remain readable under the frozen legacy schema, while the
 * bounded county processor emits an additive property-query provenance schema.
 * Select only one of those two exact contracts from manifest metadata; never
 * accept an arbitrary additive or reordered schema.
 */
function artifactDefinition(artifact: BuiltServingArtifact): ServingRelationDefinition {
  const legacy = SERVING_RELATIONS[artifact.relation];
  if (stableJson(artifact.columns) === stableJson(legacy.columns)) return legacy;
  const bounded = BOUNDED_SERVING_RELATIONS[artifact.relation];
  if (stableJson(artifact.columns) === stableJson(bounded.columns)) return bounded;
  throw new ArtifactSchemaDriftError(
    `${artifact.relativePath} metadata drifted from every supported serving contract`,
  );
}

function resolveInside(root: string, relativePath: string): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, relativePath);
  if (
    resolvedPath !== resolvedRoot &&
    !resolvedPath.startsWith(`${resolvedRoot}\\`) &&
    !resolvedPath.startsWith(`${resolvedRoot}/`)
  ) {
    throw new ArtifactVisibilityError('Artifact path escapes release root');
  }
  return resolvedPath;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqlPath(value: string): string {
  return resolve(value).replaceAll('\\', '/').replaceAll("'", "''");
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

export class ArtifactCorruptionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ArtifactCorruptionError';
  }
}

export class ArtifactSchemaDriftError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ArtifactSchemaDriftError';
  }
}

export class ArtifactCountDriftError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ArtifactCountDriftError';
  }
}

export class ArtifactGrainError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ArtifactGrainError';
  }
}

export class ArtifactVisibilityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ArtifactVisibilityError';
  }
}
