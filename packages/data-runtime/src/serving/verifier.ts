import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

import { readArtifactRange, type BuiltServingArtifact } from './builder.js';
import {
  PUBLIC_PROHIBITED_COLUMN_PATTERN,
  SERVING_RELATIONS,
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
      await assertDuckDbSchema(connection, path, artifact);
      await assertDuckDbGrain(connection, path, artifact);
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

async function assertDuckDbGrain(
  connection: DuckDBConnection,
  path: string,
  artifact: BuiltServingArtifact,
): Promise<void> {
  const definition = SERVING_RELATIONS[artifact.relation];
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
