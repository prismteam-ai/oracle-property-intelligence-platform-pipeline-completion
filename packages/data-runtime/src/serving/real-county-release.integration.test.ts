import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';

import type { PortableServingBuildInput } from './builder.js';
import {
  buildOwnerFreePublicServingClosure,
  buildOwnerFreePublicServingRelease,
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

  it('rejects prohibited nested privacy keys without relying on restricted value overlap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oracle-real-county-json-privacy-'));
    try {
      const candidate = input(join(root, 'bundle'));
      const profiles = candidate.build.profiles.map((profile) =>
        profile.visibility === 'public'
          ? {
              ...profile,
              relations: {
                ...profile.relations,
                property_evidence: (profile.relations.property_evidence ?? []).map((row) => ({
                  ...row,
                  source_references_json: '[{"owner_text":"Never in restricted comparison"}]',
                })),
              },
            }
          : profile,
      );
      await expect(
        buildRealCountyReleaseBundle({
          ...candidate,
          build: { ...candidate.build, profiles },
        }),
      ).rejects.toBeInstanceOf(ReleasePrivacyError);
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

const REPOSITORY_ROOT = existsSync(resolve('.cache/oracle-real-county/p7.manifest.json'))
  ? resolve('.')
  : resolve('../..');
const P7_ROOT = resolve(REPOSITORY_ROOT, '.cache/oracle-real-county/p7');
const P7_INPUTS = Object.freeze({
  pipelineManifestPath: resolve(REPOSITORY_ROOT, '.cache/oracle-real-county/p7.manifest.json'),
  pipelineMartPath: join(
    P7_ROOT,
    'artifacts/objects/5c8cb23c83824eedd56047180c4fe5bb0f6f99cf68982a4559d7e3c0658c0d38/body',
  ),
  normalizedMutationArtifactPath: join(
    P7_ROOT,
    'artifacts/objects/bed575f31f4431e28253a42abf0267da642fe01d111fb4d7af9dc4d7e5bbbd23/body',
  ),
  rawSourceArtifactPath: join(
    P7_ROOT,
    'artifacts/objects/129756d97feafa6548ba64a54797010a0997a79be76c2f06830ed382cf25e7dd/body',
  ),
  sourceAcquisitionReceiptPath: join(
    P7_ROOT,
    'artifacts/objects/43b83e68aec646201476ee2c04188abbf1fbaa00259316b344b91a3406441155/body',
  ),
});
const HAS_ACCEPTED_P7 = Object.values(P7_INPUTS).every(existsSync);

describe('accepted p7 owner-free serving recovery', () => {
  it.runIf(HAS_ACCEPTED_P7)(
    'rejects immutable p7 input drift',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'oracle-owner-free-p8-pin-'));
      try {
        const driftedReceipt = join(root, 'receipt.json');
        await writeFile(driftedReceipt, '{}\n');
        await expect(
          buildOwnerFreePublicServingRelease({
            ...P7_INPUTS,
            sourceAcquisitionReceiptPath: driftedReceipt,
            outputDirectory: join(root, 'output'),
          }),
        ).rejects.toThrow(/acquisition receipt/iu);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.runIf(HAS_ACCEPTED_P7)(
    'rebuilds deterministic p8 bytes and stages only the public production closure',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'oracle-owner-free-p8-'));
      try {
        const first = await buildOwnerFreePublicServingRelease({
          ...P7_INPUTS,
          outputDirectory: join(root, 'first'),
        });
        const second = await buildOwnerFreePublicServingRelease({
          ...P7_INPUTS,
          outputDirectory: join(root, 'second'),
        });
        expect(first.manifest).toEqual(second.manifest);
        expect(first.evidence.gates).toMatchObject({
          ownerBearingPublicValues: 0,
          restrictedSensitiveValueHashes: 61,
        });
        expect(
          first.manifest.artifacts.find(
            ({ relation, visibility }) => relation === 'property_query' && visibility === 'public',
          )?.rowCount,
        ).toBe(19);
        expect(
          first.manifest.artifacts.find(
            ({ relation, visibility }) =>
              relation === 'property_evidence' && visibility === 'public',
          )?.rowCount,
        ).toBe(114);
        const publicCatalog = await DuckDBInstance.create(
          join(first.outputDirectory, 'public/oracle-public.duckdb'),
          { threads: '1' },
        );
        const publicConnection = await publicCatalog.connect();
        try {
          const rows = (
            await publicConnection.runAndReadAll(
              'SELECT property_id, parcel_identifier FROM property_query',
            )
          ).getRowObjects();
          expect(rows).toHaveLength(19);
          for (const row of rows) {
            const parcelIdentifier = String(row.parcel_identifier);
            expect(parcelIdentifier).toMatch(/^\d{3}-\d{2}-\d{3}$/u);
            expect(row.property_id).toBe(
              `sc:entity:property:${createHash('sha256')
                .update(`santa-clara-ca|apn|${parcelIdentifier}`)
                .digest('hex')}`,
            );
          }
        } finally {
          publicConnection.closeSync();
          publicCatalog.closeSync();
        }
        for (const artifact of first.manifest.artifacts) {
          const firstBytes = await readFile(resolve(first.outputDirectory, artifact.relativePath));
          const secondBytes = await readFile(
            resolve(second.outputDirectory, artifact.relativePath),
          );
          expect(firstBytes.equals(secondBytes), artifact.relativePath).toBe(true);
        }
        await verifyRealCountyReleaseBundle(first.outputDirectory);

        const closure = await buildOwnerFreePublicServingClosure(
          first.outputDirectory,
          join(root, 'first-closure'),
        );
        const secondClosure = await buildOwnerFreePublicServingClosure(
          second.outputDirectory,
          join(root, 'second-closure'),
        );
        expect(closure.manifestCid).toMatch(/^bafkrei[a-z2-7]{52}$/u);
        expect(closure).toMatchObject({
          manifestSha256: secondClosure.manifestSha256,
          manifestFileSha256: secondClosure.manifestFileSha256,
          manifestCid: secondClosure.manifestCid,
        });
        for (const path of await recursiveFiles(closure.outputDirectory)) {
          expect(
            (await readFile(join(closure.outputDirectory, path))).equals(
              await readFile(join(secondClosure.outputDirectory, path)),
            ),
            path,
          ).toBe(true);
        }
        expect((await recursiveFiles(closure.outputDirectory)).sort()).toEqual([
          'public/data-dictionary.parquet',
          'public/field-coverage.parquet',
          'public/pipeline-runs.parquet',
          'public/property-evidence.parquet',
          'public/property-query.parquet',
          'public/relation-coverage.parquet',
          'public/source-coverage.parquet',
          'release-manifest.json',
          'serving-config.json',
        ]);
        const closureManifest = JSON.parse(
          await readFile(join(closure.outputDirectory, 'release-manifest.json'), 'utf8'),
        ) as { artifacts: readonly { visibility: string }[] };
        expect(closureManifest.artifacts).toHaveLength(7);
        expect(closureManifest.artifacts.every(({ visibility }) => visibility === 'public')).toBe(
          true,
        );

        const alteredBundle = join(root, 'altered-operator-bundle');
        await cp(first.outputDirectory, alteredBundle, { recursive: true });
        const alteredManifestPath = join(alteredBundle, 'release-manifest.json');
        const alteredManifest = JSON.parse(await readFile(alteredManifestPath, 'utf8')) as Record<
          string,
          unknown
        >;
        const alteredArtifacts = alteredManifest.artifacts as Record<string, unknown>[];
        alteredArtifacts[0] = {
          ...alteredArtifacts[0],
          limitations: ['Self-consistent but not the accepted p8 operator manifest.'],
        };
        await writeRehashedManifest(alteredManifestPath, alteredManifest);
        const alteredEvidencePath = join(alteredBundle, 'release-evidence.json');
        const alteredEvidence = JSON.parse(await readFile(alteredEvidencePath, 'utf8')) as Record<
          string,
          unknown
        >;
        alteredEvidence.manifestSha256 = alteredManifest.manifestSha256;
        alteredEvidence.manifestFileSha256 = createHash('sha256')
          .update(await readFile(alteredManifestPath))
          .digest('hex');
        await writeRehashedEvidence(alteredEvidencePath, alteredEvidence);
        await expect(
          buildOwnerFreePublicServingClosure(alteredBundle, join(root, 'rejected-closure')),
        ).rejects.toThrow(/exact accepted p8/iu);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

async function recursiveFiles(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await recursiveFiles(root, relativePath)));
    else files.push(relativePath);
  }
  return files;
}

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
