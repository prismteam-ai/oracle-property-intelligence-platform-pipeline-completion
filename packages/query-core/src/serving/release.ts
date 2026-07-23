import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  readPortableReleaseManifest,
  type PortableReleaseManifest,
  type ReleaseArtifactInput,
} from '@oracle/artifacts/release/manifest';
import { DuckDBAnalyticalRuntime } from '@oracle/data-runtime/duckdb/duckdb-analytical-runtime';
import { SERVING_RELATIONS, type ServingRelationName } from '@oracle/data-runtime/serving/schema';
import { verifyServingArtifacts } from '@oracle/data-runtime/serving/verifier';
import type { BuiltServingArtifact } from '@oracle/data-runtime/serving/builder';

import type { InquiryReleaseContext } from '../inquiries/contracts.js';
import { normalizeRelease } from '../inquiries/validation.js';
import { ProductionServingError, type ProductionServingConfig } from './contracts.js';

export const REQUIRED_PUBLIC_RELATIONS = Object.freeze([
  'property_query',
  'property_evidence',
  'source_coverage',
  'field_coverage',
  'relation_coverage',
  'pipeline_runs',
  'data_dictionary',
] as const satisfies readonly ServingRelationName[]);

export type LoadedProductionRelease = Readonly<{
  root: string;
  manifestPath: string;
  manifest: PortableReleaseManifest;
  manifestBytes: Uint8Array;
  manifestFileSha256: string;
  inquiryRelease: InquiryReleaseContext;
  limitations: readonly string[];
  publicArtifacts: readonly BuiltServingArtifact[];
  runtime: DuckDBAnalyticalRuntime;
}>;

export async function loadProductionRelease(
  config: ProductionServingConfig,
): Promise<LoadedProductionRelease> {
  const root = requireAbsolutePath(config.releaseRoot, 'releaseRoot');
  const manifestPath = resolveRelative(root, config.manifestRelativePath, 'manifestRelativePath');
  const loaded = await verifyRelease(root, manifestPath, config);
  const runtime = new DuckDBAnalyticalRuntime({
    nowMilliseconds: monotonicMilliseconds,
    loadSnapshot: async (snapshot, signal) => {
      throwIfAborted(signal);
      const current = await verifyRelease(root, manifestPath, config);
      if (
        snapshot.releaseId !== config.expected.releaseId ||
        snapshot.manifestSha256 !== current.manifestFileSha256 ||
        snapshot.manifestUri !== pathToFileURL(manifestPath).href
      ) {
        throw invalidRelease('Analytical snapshot binding drifted from server configuration.');
      }
      return {
        manifestBytes: current.manifestBytes,
        scanBytesByOperation: scanMap(current.manifest, current.publicArtifacts),
        initialize: async (connection) => {
          const versionRows = await connection.runAndReadAll('PRAGMA version');
          const actualDuckDbVersion = versionRows.getRowObjects()[0]?.library_version;
          if (actualDuckDbVersion !== current.manifest.duckdbVersion) {
            throw invalidRelease('DuckDB runtime version drifted from the portable release.');
          }
          for (const artifact of current.publicArtifacts) {
            const path = resolveRelative(root, artifact.relativePath, 'artifact path');
            await connection.run(
              `CREATE VIEW ${quoteIdentifier(artifact.relation)} AS SELECT * FROM read_parquet('${sqlPath(path)}')`,
            );
          }
          await connection.run(`CREATE TEMP TABLE release_artifacts(
            relation VARCHAR NOT NULL,
            media_type VARCHAR NOT NULL,
            byte_size BIGINT NOT NULL,
            sha256 VARCHAR NOT NULL,
            row_count BIGINT NOT NULL,
            schema_sha256 VARCHAR NOT NULL,
            grain VARCHAR NOT NULL,
            limitations_json VARCHAR NOT NULL,
            visibility VARCHAR NOT NULL
          )`);
          for (const artifact of current.manifest.artifacts.filter(
            ({ visibility }) => visibility === 'public',
          )) {
            await connection.run(
              'INSERT INTO release_artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
              [
                artifact.relation,
                artifact.mediaType,
                BigInt(artifact.byteSize),
                artifact.sha256,
                BigInt(artifact.rowCount),
                artifact.schemaSha256,
                artifact.grain,
                JSON.stringify(artifact.limitations),
                artifact.visibility,
              ],
            );
          }
        },
      };
    },
  });
  return Object.freeze({ ...loaded, root, manifestPath, runtime });
}

async function verifyRelease(
  root: string,
  manifestPath: string,
  config: ProductionServingConfig,
): Promise<Omit<LoadedProductionRelease, 'root' | 'manifestPath' | 'runtime'>> {
  try {
    const [manifest, manifestBytes] = await Promise.all([
      readPortableReleaseManifest(manifestPath),
      readFile(manifestPath),
    ]);
    assertManifestShape(manifest);
    assertExpectedRelease(manifest, config);
    await verifyPublicReleaseFiles(root, manifest);
    const publicArtifacts = requiredPublicArtifacts(manifest);
    await verifyServingArtifacts(root, publicArtifacts);
    const inquiryRelease = normalizeRelease({
      schemaVersion: config.expected.schemaVersion,
      releaseId: manifest.releaseId,
      runId: manifest.runId,
      manifestCid: config.expected.manifestCid,
      asOf: config.expected.asOf,
      policyVersion: config.expected.policyVersion,
      rankingWeights: config.rankingWeights,
      capabilities: config.capabilities,
    });
    const limitations = Object.freeze(
      [
        ...new Set([
          ...(config.limitations ?? []),
          ...manifest.artifacts
            .filter(({ visibility }) => visibility === 'public')
            .flatMap(({ limitations: artifactLimitations }) => artifactLimitations),
        ]),
      ].sort(),
    );
    return Object.freeze({
      manifest,
      manifestBytes,
      manifestFileSha256: sha256(manifestBytes),
      inquiryRelease,
      limitations,
      publicArtifacts,
    });
  } catch (error) {
    if (error instanceof ProductionServingError) throw error;
    throw invalidRelease('The configured portable release failed immutable verification.', error);
  }
}

async function verifyPublicReleaseFiles(
  root: string,
  manifest: PortableReleaseManifest,
): Promise<void> {
  for (const artifact of manifest.artifacts.filter(({ visibility }) => visibility === 'public')) {
    const path = resolveRelative(root, artifact.relativePath, 'public artifact path');
    const bytes = await readFile(path);
    if (bytes.byteLength !== artifact.byteSize || sha256(bytes) !== artifact.sha256) {
      throw invalidRelease(`Public artifact integrity drifted: ${artifact.relation}.`);
    }
  }
}

function assertManifestShape(manifest: PortableReleaseManifest): void {
  exactKeys(
    manifest,
    [
      'contractVersion',
      'releaseId',
      'runId',
      'county',
      'state',
      'generatedAt',
      'duckdbVersion',
      'sourceIds',
      'artifacts',
      'manifestSha256',
    ],
    'portable manifest',
  );
  for (const artifact of manifest.artifacts) {
    exactKeys(
      artifact,
      [
        'relation',
        'relativePath',
        'visibility',
        'mediaType',
        'byteSize',
        'sha256',
        'rowCount',
        'schemaSha256',
        'columns',
        'nonNullCounts',
        'grain',
        'sourceLineage',
        'limitations',
      ],
      `artifact ${artifact.relation}`,
    );
    for (const column of artifact.columns) {
      exactKeys(
        column,
        ['name', 'duckdbType', 'nullable', 'description'],
        `artifact ${artifact.relation} column`,
      );
    }
    for (const source of artifact.sourceLineage) {
      exactKeys(
        source,
        ['sourceId', 'snapshotId', 'sourceSha256', 'schemaSha256', 'asOf', 'role'],
        `artifact ${artifact.relation} lineage`,
      );
    }
  }
}

function exactKeys(value: object, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) {
    throw invalidRelease(`${label} contains an unsupported field.`);
  }
}

function assertExpectedRelease(
  manifest: PortableReleaseManifest,
  config: ProductionServingConfig,
): void {
  const expected = config.expected;
  const manifestRecord = manifest as unknown as Readonly<Record<string, unknown>>;
  if (
    manifest.releaseId !== expected.releaseId ||
    manifest.runId !== expected.runId ||
    manifest.manifestSha256 !== expected.manifestSha256 ||
    manifest.generatedAt !== expected.asOf ||
    manifest.contractVersion !== expected.schemaVersion ||
    manifestRecord.county !== 'Santa Clara' ||
    manifestRecord.state !== 'CA'
  ) {
    throw invalidRelease('Portable release metadata drifted from server-owned configuration.');
  }
  if (!/^[a-f0-9]{64}$/u.test(expected.manifestSha256)) {
    throw invalidRelease('Expected manifest SHA-256 is invalid.');
  }
  if (expected.manifestCid.trim().length === 0 || expected.policyVersion.trim().length === 0) {
    throw invalidRelease('Expected manifest CID and policy version are required.');
  }
}

function requiredPublicArtifacts(
  manifest: PortableReleaseManifest,
): readonly BuiltServingArtifact[] {
  const byRelation = new Map(
    manifest.artifacts
      .filter(({ visibility }) => visibility === 'public')
      .map((artifact) => [artifact.relation, artifact]),
  );
  return Object.freeze(
    REQUIRED_PUBLIC_RELATIONS.map((relation) => {
      const artifact = byRelation.get(relation);
      if (artifact === undefined) throw invalidRelease(`Missing public relation: ${relation}.`);
      return toBuiltArtifact(artifact, relation);
    }),
  );
}

function toBuiltArtifact(
  artifact: ReleaseArtifactInput,
  relation: ServingRelationName,
): BuiltServingArtifact {
  const definition = SERVING_RELATIONS[relation];
  if (
    artifact.mediaType !== 'application/vnd.apache.parquet' ||
    artifact.relativePath !== `public/${definition.fileName}` ||
    artifact.grain !== definition.grain
  ) {
    throw invalidRelease(`Public ${relation} metadata drifted from the serving relation.`);
  }
  return Object.freeze({
    relation,
    relativePath: artifact.relativePath,
    visibility: 'public',
    mediaType: 'application/vnd.apache.parquet',
    byteSize: artifact.byteSize,
    sha256: artifact.sha256,
    rowCount: artifact.rowCount,
    schemaSha256: artifact.schemaSha256,
    columns: artifact.columns,
    nonNullCounts: artifact.nonNullCounts,
  });
}

function scanMap(
  manifest: PortableReleaseManifest,
  artifacts: readonly BuiltServingArtifact[],
): Readonly<Record<string, number>> {
  const bytes = Object.fromEntries(artifacts.map(({ relation, byteSize }) => [relation, byteSize]));
  const sum = (...relations: readonly ServingRelationName[]): number =>
    relations.reduce((total, relation) => total + (bytes[relation] ?? 0), 0);
  return Object.freeze({
    'serving.get_dataset_info@1.0.0': sum('property_query', 'source_coverage', 'pipeline_runs'),
    'serving.get_dataset_coverage.source@1.0.0': sum('source_coverage'),
    'serving.get_dataset_coverage.field@1.0.0': sum('field_coverage'),
    'serving.get_dataset_coverage.relation@1.0.0': sum('relation_coverage'),
    'serving.list_pipeline_runs@1.0.0': sum('pipeline_runs'),
    'serving.get_pipeline_run@1.0.0': sum('pipeline_runs'),
    'serving.search_properties@1.0.0': sum('property_query'),
    'serving.get_property@1.0.0': sum('property_query'),
    'serving.get_property_evidence@1.0.0': sum('property_evidence'),
    'serving.list_artifacts@1.0.0': manifestArtifactBytes(manifest),
    'serving.get_data_dictionary@1.0.0': sum('data_dictionary'),
    'inquiry.roof_age@1.0.0': sum('property_query', 'property_evidence'),
    'inquiry.water_view_candidate@1.0.0': sum('property_query', 'property_evidence'),
    'inquiry.ownership_age@1.0.0': sum('property_query', 'property_evidence'),
    'inquiry.regional_owner@1.0.0': sum('property_query', 'property_evidence'),
    'inquiry.transit_walkability@1.0.0': sum('property_query', 'property_evidence'),
    'inquiry.starbucks_walkability@1.0.0': sum('property_query', 'property_evidence'),
    'inquiry.combined_review@1.0.0': sum('property_query', 'property_evidence'),
  });
}

function manifestArtifactBytes(manifest: PortableReleaseManifest): number {
  return Math.max(
    1,
    Buffer.byteLength(
      JSON.stringify(manifest.artifacts.filter(({ visibility }) => visibility === 'public')),
      'utf8',
    ),
  );
}

function requireAbsolutePath(value: string, label: string): string {
  if (value.trim().length === 0 || !isAbsolute(value)) {
    throw invalidRelease(`${label} is invalid.`);
  }
  const resolved = resolve(value);
  return resolved;
}

function resolveRelative(root: string, value: string, label: string): string {
  if (
    value.trim().length === 0 ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[a-z]+:/iu.test(value) ||
    value.includes('..')
  ) {
    throw invalidRelease(`${label} must be a portable relative path.`);
  }
  const path = resolve(root, value);
  if (!isInside(root, path)) throw invalidRelease(`${label} escapes the release root.`);
  return path;
}

function isInside(root: string, path: string): boolean {
  const normalizedRoot = resolve(root).toLowerCase();
  const normalizedPath = resolve(path).toLowerCase();
  return (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}\\`) ||
    normalizedPath.startsWith(`${normalizedRoot}/`)
  );
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqlPath(value: string): string {
  return resolve(value).replaceAll('\\', '/').replaceAll("'", "''");
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function monotonicMilliseconds(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw signal.reason;
}

function invalidRelease(message: string, cause?: unknown): ProductionServingError {
  return new ProductionServingError('RELEASE_INVALID', message, {
    ...(cause === undefined ? {} : { cause }),
  });
}
