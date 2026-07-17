import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';

import type { PortableServingBuildInput } from './builder.js';
import {
  buildRealCountyReleaseBundle,
  buildRealCountyReleaseFromPipelineArtifact,
  REAL_COUNTY_CAPABILITIES,
  ReleaseCompletenessError,
  ReleaseLicenseError,
  ReleaseParityError,
  ReleasePrivacyError,
  ReleaseSegregationError,
  verifyRealCountyReleaseBundle,
  type ArtifactReleasePolicy,
  type CapabilityReleaseState,
  type RealCountyReleaseInput,
  type SourceSnapshotGate,
} from './real-county-release.js';
import {
  SERVING_RELATIONS,
  type ServingRelationName,
  type ServingRow,
  type ServingScalar,
} from './schema.js';

const INSTANT = '2026-07-17T12:00:00.000Z';
const SOURCE_PUBLIC = 'source-public';
const SOURCE_RESTRICTED = 'source-restricted';
const SOURCE_OWNERSHIP_BLOCKED = 'source-ownership-blocked';
const SOURCE_FBN_BLOCKED = 'source-fbn-blocked';
const OWNER_SENTINEL = 'Private Owner Sentinel 9281';

describe('real Santa Clara release bundle', () => {
  it('builds immutable segregated Parquet/DuckDB, canonical manifests, and clean reopen proof', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oracle-real-county-release-'));
    try {
      const first = await buildRealCountyReleaseBundle(input(join(root, 'first')));
      const second = await buildRealCountyReleaseBundle(input(join(root, 'second')));
      const handoff = input('unused');
      const portableReleaseInput = Object.fromEntries(
        Object.entries(handoff).filter(([key]) => key !== 'outputDirectory'),
      );
      const martPath = join(root, 'pipeline-mart.json');
      await writeFile(
        martPath,
        `${JSON.stringify({
          format: 'oracle-real-county-portable-release-input-v1',
          portableReleaseInput,
        })}\n`,
      );
      const third = await buildRealCountyReleaseFromPipelineArtifact(martPath, join(root, 'third'));

      expect(first.manifest).toEqual(second.manifest);
      expect(first.evidence).toEqual(second.evidence);
      expect(third.manifest).toEqual(first.manifest);
      expect(first.evidence.releaseScope).toBe('partial_county');
      expect(first.evidence.countyCompletionClaim).toBe(false);
      expect(first.evidence.permitAuthorityCoverage).toEqual({ covered: 1, total: 16 });
      expect(first.evidence.gates).toMatchObject({
        license: 'passed',
        manifest: 'passed',
        parquet: 'passed',
        cleanReopen: 'passed',
        publicRestrictedSegregation: 'passed',
        ownerBearingPublicValues: 0,
      });
      expect(first.evidence.gates.restrictedSensitiveValueHashes).toBeGreaterThan(0);

      for (const artifact of first.manifest.artifacts) {
        const firstBytes = await readFile(resolve(first.outputDirectory, artifact.relativePath));
        const secondBytes = await readFile(resolve(second.outputDirectory, artifact.relativePath));
        expect(firstBytes.equals(secondBytes), artifact.relativePath).toBe(true);
      }
      for (const catalog of first.evidence.catalogs) {
        const firstBytes = await readFile(resolve(first.outputDirectory, catalog.relativePath));
        const secondBytes = await readFile(resolve(second.outputDirectory, catalog.relativePath));
        expect(firstBytes.equals(secondBytes), catalog.relativePath).toBe(true);
      }

      const verified = await verifyRealCountyReleaseBundle(first.outputDirectory);
      expect(verified).toMatchObject({
        releaseId: 'santa-clara-real-county-test-v1',
        runId: 'run-real-county-test-v1',
        releaseScope: 'partial_county',
        ownerBearingPublicValues: 0,
      });

      await expect(buildRealCountyReleaseBundle(input(first.outputDirectory))).rejects.toThrow(
        /already exists/iu,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects a full-county claim while capabilities or permit authorities are incomplete', async () => {
    const candidate = input('unused');
    await expect(
      buildRealCountyReleaseBundle({
        ...candidate,
        releaseScope: 'full_county',
      }),
    ).rejects.toBeInstanceOf(ReleaseCompletenessError);
  });

  it('rejects public data whose exact source projection is not approved', async () => {
    const candidate = input('unused');
    await expect(
      buildRealCountyReleaseBundle({
        ...candidate,
        sourceSnapshots: candidate.sourceSnapshots.map((source) =>
          source.sourceId === SOURCE_PUBLIC
            ? { ...source, publicProjectionPermission: 'restricted' as const }
            : source,
        ),
      }),
    ).rejects.toBeInstanceOf(ReleaseLicenseError);
    await expect(
      buildRealCountyReleaseBundle({
        ...candidate,
        artifactPolicies: candidate.artifactPolicies.map((policy) =>
          policy.visibility === 'public' && policy.relation === 'property_query'
            ? { ...policy, contentClass: 'capability_metadata' as const }
            : policy,
        ),
      }),
    ).rejects.toBeInstanceOf(ReleaseLicenseError);
  });

  it('finds an owner-bearing value hidden in an otherwise public scalar without disclosing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oracle-real-county-privacy-'));
    try {
      const candidate = input(join(root, 'leak'));
      const profiles = candidate.build.profiles.map((profile) =>
        profile.visibility === 'public'
          ? {
              ...profile,
              relations: {
                ...profile.relations,
                property_query: [
                  relationRow('property_query', {
                    property_id: 'property-a',
                    parcel_identifier: '127-69-001',
                    address_street: OWNER_SENTINEL,
                    visibility: 'public',
                  }),
                ],
              },
            }
          : profile,
      );
      let message = '';
      try {
        await buildRealCountyReleaseBundle({
          ...candidate,
          build: { ...candidate.build, profiles },
        });
      } catch (error) {
        expect(error).toBeInstanceOf(ReleasePrivacyError);
        message = error instanceof Error ? error.message : '';
      }
      expect(message).not.toContain(OWNER_SENTINEL);
      expect(message).toMatch(/restricted value hashes/iu);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a self-consistent evidence document whose catalog path escapes the bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oracle-real-county-path-'));
    try {
      const result = await buildRealCountyReleaseBundle(input(join(root, 'bundle')));
      const evidencePath = join(result.outputDirectory, 'release-evidence.json');
      const evidence = JSON.parse(await readFile(evidencePath, 'utf8')) as Record<string, unknown>;
      const catalogs = evidence.catalogs as Record<string, unknown>[];
      catalogs[0] = { ...catalogs[0], relativePath: '../outside.duckdb' };
      await writeRehashedEvidence(evidencePath, evidence);

      await expect(verifyRealCountyReleaseBundle(result.outputDirectory)).rejects.toBeInstanceOf(
        ReleaseSegregationError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a self-consistently rehashed manifest whose Parquet path escapes the bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oracle-real-county-parquet-path-'));
    try {
      const result = await buildRealCountyReleaseBundle(input(join(root, 'bundle')));
      const manifestPath = join(result.outputDirectory, 'release-manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      const artifacts = manifest.artifacts as Record<string, unknown>[];
      const originalPath = artifacts[0]?.relativePath;
      expect(typeof originalPath).toBe('string');
      artifacts[0] = { ...artifacts[0], relativePath: '../outside.parquet' };
      await writeRehashedManifest(manifestPath, manifest);

      const evidencePath = join(result.outputDirectory, 'release-evidence.json');
      const evidence = JSON.parse(await readFile(evidencePath, 'utf8')) as Record<string, unknown>;
      evidence.manifestSha256 = manifest.manifestSha256;
      evidence.manifestFileSha256 = createHash('sha256')
        .update(await readFile(manifestPath))
        .digest('hex');
      const summaries = evidence.artifacts as Record<string, unknown>[];
      const summaryIndex = summaries.findIndex(({ relativePath }) => relativePath === originalPath);
      expect(summaryIndex).toBeGreaterThanOrEqual(0);
      summaries[summaryIndex] = {
        ...summaries[summaryIndex],
        relativePath: '../outside.parquet',
      };
      await writeRehashedEvidence(evidencePath, evidence);

      await expect(verifyRealCountyReleaseBundle(result.outputDirectory)).rejects.toBeInstanceOf(
        ReleaseSegregationError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reopens a self-consistently rehashed catalog and rejects table/parquet parity drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oracle-real-county-parity-'));
    try {
      const result = await buildRealCountyReleaseBundle(input(join(root, 'bundle')));
      const catalogPath = join(result.outputDirectory, 'public', 'oracle-public.duckdb');
      const instance = await DuckDBInstance.create(catalogPath, { threads: '1' });
      const connection = await instance.connect();
      try {
        await connection.run('DROP TABLE property_query');
        await connection.run('CHECKPOINT');
      } finally {
        connection.closeSync();
        instance.closeSync();
      }

      const evidencePath = join(result.outputDirectory, 'release-evidence.json');
      const evidence = JSON.parse(await readFile(evidencePath, 'utf8')) as Record<string, unknown>;
      const catalogs = evidence.catalogs as Record<string, unknown>[];
      const bytes = await readFile(catalogPath);
      const publicIndex = catalogs.findIndex(({ visibility }) => visibility === 'public');
      catalogs[publicIndex] = {
        ...catalogs[publicIndex],
        byteSize: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      await writeRehashedEvidence(evidencePath, evidence);

      await expect(verifyRealCountyReleaseBundle(result.outputDirectory)).rejects.toBeInstanceOf(
        ReleaseParityError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a self-consistent evidence rewrite that upgrades a partial release to full county', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oracle-real-county-scope-'));
    try {
      const result = await buildRealCountyReleaseBundle(input(join(root, 'bundle')));
      const evidencePath = join(result.outputDirectory, 'release-evidence.json');
      const evidence = JSON.parse(await readFile(evidencePath, 'utf8')) as Record<string, unknown>;
      evidence.releaseScope = 'full_county';
      evidence.countyCompletionClaim = true;
      evidence.permitAuthorityCoverage = { covered: 16, total: 16 };
      await writeRehashedEvidence(evidencePath, evidence);

      await expect(verifyRealCountyReleaseBundle(result.outputDirectory)).rejects.toBeInstanceOf(
        ReleaseCompletenessError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeRehashedManifest(
  path: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  delete manifest.manifestSha256;
  manifest.manifestSha256 = createHash('sha256')
    .update(`${stableJson(manifest)}\n`)
    .digest('hex');
  await writeFile(path, `${stableJson(manifest)}\n`);
}

async function writeRehashedEvidence(
  path: string,
  evidence: Record<string, unknown>,
): Promise<void> {
  delete evidence.evidenceSha256;
  evidence.evidenceSha256 = createHash('sha256')
    .update(`${stableJson(evidence)}\n`)
    .digest('hex');
  await writeFile(path, `${stableJson(evidence)}\n`);
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

function input(outputDirectory: string): RealCountyReleaseInput {
  const sourceSnapshots = sources();
  return {
    outputDirectory,
    releaseScope: 'partial_county',
    permitAuthoritiesCovered: 1,
    permitAuthoritiesTotal: 16,
    sourceSnapshots,
    capabilities: capabilities(),
    artifactPolicies: policies(sourceSnapshots),
    build: buildInput(),
  };
}

function buildInput(): Omit<PortableServingBuildInput, 'outputDirectory'> {
  return {
    releaseId: 'santa-clara-real-county-test-v1',
    runId: 'run-real-county-test-v1',
    generatedAt: INSTANT,
    sourceIds: [SOURCE_PUBLIC, SOURCE_RESTRICTED, SOURCE_OWNERSHIP_BLOCKED, SOURCE_FBN_BLOCKED],
    profiles: [
      {
        visibility: 'public',
        relations: {
          property_query: [
            relationRow('property_query', {
              property_id: 'property-a',
              parcel_identifier: '127-69-001',
              address_street: 'Public Situs Fixture',
              visibility: 'public',
            }),
          ],
          property_evidence: [
            relationRow('property_evidence', {
              evidence_id: 'evidence-a',
              property_id: 'property-a',
              support_class: 'unknown',
              limitations_json: '["No strict feature claim in this fixture."]',
              visibility: 'public',
            }),
          ],
          source_coverage: [
            coverageRow(SOURCE_PUBLIC, 'supported', 1, 1),
            coverageRow(SOURCE_RESTRICTED, 'proxy', 1, 1),
            coverageRow(SOURCE_OWNERSHIP_BLOCKED, 'unsupported', null, 0),
            coverageRow(SOURCE_FBN_BLOCKED, 'unsupported', null, 0),
          ],
          pipeline_runs: [
            relationRow('pipeline_runs', {
              run_id: 'run-real-county-test-v1',
              status: 'partial',
              source_ids_json: JSON.stringify([
                SOURCE_FBN_BLOCKED,
                SOURCE_OWNERSHIP_BLOCKED,
                SOURCE_PUBLIC,
                SOURCE_RESTRICTED,
              ]),
              expected_count: null,
              observed_count: 2,
              quarantine_count: 0,
              limitations_json: '["Ownership and FBN capabilities are blocked."]',
            }),
          ],
        },
      },
      {
        visibility: 'restricted',
        relations: {
          elephant_properties: [
            relationRow('elephant_properties', {
              property_id: 'property-a',
              parcel_identifier: '127-69-001',
              owner_name: OWNER_SENTINEL,
              owners_text: OWNER_SENTINEL,
            }),
          ],
        },
      },
    ],
  };
}

function sources(): readonly SourceSnapshotGate[] {
  return [
    source(SOURCE_PUBLIC, '1', 'succeeded', 'allowed', false),
    source(SOURCE_RESTRICTED, '2', 'succeeded', 'restricted', true),
    source(SOURCE_OWNERSHIP_BLOCKED, '3', 'blocked', 'prohibited', true),
    source(SOURCE_FBN_BLOCKED, '4', 'blocked', 'prohibited', true),
  ];
}

function source(
  sourceId: string,
  hashDigit: string,
  terminalState: SourceSnapshotGate['terminalState'],
  publicProjectionPermission: SourceSnapshotGate['publicProjectionPermission'],
  containsOwnerData: boolean,
): SourceSnapshotGate {
  const blocked = terminalState === 'blocked';
  return {
    sourceId,
    snapshotId: `${sourceId}-snapshot`,
    sourceSha256: hashDigit.repeat(64),
    schemaSha256: (Number(hashDigit) + 4).toString().repeat(64),
    asOf: INSTANT,
    terminalState,
    acquisitionPermission: blocked ? 'blocked' : 'allowed',
    privateUsePermission: blocked ? 'prohibited' : 'allowed',
    publicProjectionPermission,
    capabilityMetadataPublic: true,
    containsOwnerData,
    limitations: blocked ? Object.freeze(['Capability blocked; no source rows acquired.']) : [],
  };
}

function capabilities(): readonly CapabilityReleaseState[] {
  return REAL_COUNTY_CAPABILITIES.map((capability) => {
    if (capability === 'ownership_transfers') {
      return {
        capability,
        state: 'blocked',
        sourceIds: [SOURCE_OWNERSHIP_BLOCKED],
        limitations: ['No approved subscribed transfer snapshot.'],
      };
    }
    if (capability === 'santa_clara_fbn') {
      return {
        capability,
        state: 'blocked',
        sourceIds: [SOURCE_FBN_BLOCKED],
        limitations: ['No approved purchased FBN snapshot.'],
      };
    }
    if (capability === 'transit_511_fallback') {
      return {
        capability,
        state: 'not_configured',
        sourceIds: [],
        limitations: [
          'Direct VTA and Caltrain feeds are selected; 511 fallback is not configured.',
        ],
      };
    }
    return {
      capability,
      state: 'succeeded',
      sourceIds: capability === 'cslb_contractors' ? [SOURCE_RESTRICTED] : [SOURCE_PUBLIC],
      limitations: [],
    };
  });
}

function policies(sourcesInput: readonly SourceSnapshotGate[]): readonly ArtifactReleasePolicy[] {
  const byId = new Map(sourcesInput.map((item) => [item.sourceId, item]));
  const reference = (sourceId: string, role: 'direct' | 'derived' = 'derived') => {
    const selected = byId.get(sourceId);
    if (selected === undefined) throw new Error('Missing fixture source');
    return { sourceId, snapshotId: selected.snapshotId, role };
  };
  return [
    {
      visibility: 'public',
      relation: 'property_query',
      contentClass: 'derived_data',
      sourceLineage: [reference(SOURCE_PUBLIC)],
      limitations: ['Test-only public property mart.'],
    },
    {
      visibility: 'public',
      relation: 'property_evidence',
      contentClass: 'derived_data',
      sourceLineage: [reference(SOURCE_PUBLIC)],
      limitations: ['No strict feature claim.'],
    },
    {
      visibility: 'public',
      relation: 'source_coverage',
      contentClass: 'capability_metadata',
      sourceLineage: sourcesInput.map((item) => reference(item.sourceId)),
      limitations: ['Blocked capabilities remain explicit.'],
    },
    {
      visibility: 'public',
      relation: 'pipeline_runs',
      contentClass: 'capability_metadata',
      sourceLineage: sourcesInput.map((item) => reference(item.sourceId)),
      limitations: ['Partial run; not a county-completion claim.'],
    },
    {
      visibility: 'restricted',
      relation: 'elephant_properties',
      contentClass: 'source_data',
      sourceLineage: [reference(SOURCE_RESTRICTED, 'direct')],
      limitations: ['Owner-bearing fixture remains restricted.'],
    },
  ];
}

function coverageRow(
  sourceId: string,
  supportClass: string,
  expected: number | null,
  observed: number,
): ServingRow {
  const hashDigit =
    sourceId === SOURCE_PUBLIC
      ? 1
      : sourceId === SOURCE_RESTRICTED
        ? 2
        : sourceId === SOURCE_OWNERSHIP_BLOCKED
          ? 3
          : 4;
  return relationRow('source_coverage', {
    source_id: sourceId,
    scope: 'fixture-scope',
    support_class: supportClass,
    expected_count: expected,
    observed_count: observed,
    quarantine_count: 0,
    source_sha256: String(hashDigit).repeat(64),
    schema_sha256: String(hashDigit + 4).repeat(64),
    as_of: INSTANT,
    limitations_json:
      supportClass === 'unsupported' ? '["Capability blocked; no source rows acquired."]' : '[]',
  });
}

function relationRow(
  relation: ServingRelationName,
  overrides: Readonly<Record<string, ServingScalar>> = {},
): ServingRow {
  const definition = SERVING_RELATIONS[relation];
  return Object.fromEntries(
    definition.columns.map((column) => [
      column.name,
      Object.hasOwn(overrides, column.name)
        ? overrides[column.name]
        : defaultScalar(column.name, column.duckdbType, column.nullable),
    ]),
  ) as ServingRow;
}

function defaultScalar(
  name: string,
  type: 'VARCHAR' | 'BOOLEAN' | 'BIGINT' | 'DOUBLE',
  nullable: boolean,
): ServingScalar {
  if (nullable) return null;
  if (type === 'BOOLEAN') return false;
  if (type === 'BIGINT') return 1;
  if (type === 'DOUBLE') {
    return name === 'confidence' || name === 'ratio' || name === 'evidence_coverage' ? 1 : 1.5;
  }
  if (name.endsWith('_json')) return '[]';
  if (name.endsWith('_support_class') || name === 'support_class') return 'unknown';
  if (name === 'visibility') return 'public';
  if (name.endsWith('_at') || name === 'as_of' || name === 'valid_from') return INSTANT;
  if (name.endsWith('sha256')) return 'a'.repeat(64);
  return `${name}-fixture`;
}
