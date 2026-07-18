import { createHash, generateKeyPairSync, sign as signBytes } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DuckDBInstance, type DuckDBAppender } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BOUNDED_COUNTY_OUTPUT_RELATIONS,
  boundedServingSchemaSha256,
  type BoundedPortableReleaseArtifact,
  type BoundedServingCatalog,
  type BoundedServingReleaseEvidence,
  type BoundedServingReleaseManifest,
} from './bounded-release.js';
import {
  boundedPublicLicenseAuthorizationBytes,
  buildBoundedPublicServingClosure,
  ReleaseLicenseError,
  ReleaseManifestError,
  ReleaseSegregationError,
  type BoundedPublicLicenseVerificationInput,
  type BoundedPublicServingClosureOptions,
  type SignedBoundedPublicLicenseApproval,
  type TrustedBoundedPublicLicenseApproval,
} from './real-county-release.js';
import {
  BOUNDED_SERVING_RELATIONS,
  SERVING_RELATIONS,
  type ServingRelationName,
  type ServingRow,
  type ServingScalar,
  type ServingVisibility,
} from './schema.js';

const RELEASE_ID = 'santa-clara-f4-serving-fixture';
const RUN_ID = `sc:run:${'a'.repeat(64)}`;
const INSTANT = '2026-07-18T18:00:00.000Z';
const SOURCE_ID = 'sc:source:bounded-fixture';
const PUBLIC_FILES = [
  'public/data-dictionary.parquet',
  'public/field-coverage.parquet',
  'public/pipeline-runs.parquet',
  'public/property-evidence.parquet',
  'public/property-query.parquet',
  'public/relation-coverage.parquet',
  'public/source-coverage.parquet',
  'release-manifest.json',
  'serving-config.json',
] as const;
const TRUSTED_LICENSE_KEYS = generateKeyPairSync('ed25519');
const FORGED_LICENSE_KEYS = generateKeyPairSync('ed25519');
const TRUSTED_PUBLIC_KEY_PEM = TRUSTED_LICENSE_KEYS.publicKey
  .export({ format: 'pem', type: 'spki' })
  .toString();
const TRUSTED_ROOT_SHA256 = digest(
  TRUSTED_LICENSE_KEYS.publicKey.export({ format: 'der', type: 'spki' }),
);
const FORGED_ROOT_SHA256 = digest(
  FORGED_LICENSE_KEYS.publicKey.export({ format: 'der', type: 'spki' }),
);

function licenseAuthorization(
  input: BoundedPublicLicenseVerificationInput,
  overrides: Partial<TrustedBoundedPublicLicenseApproval> = {},
): TrustedBoundedPublicLicenseApproval {
  return Object.freeze({
    ...input,
    decision: 'allowed_public' as const,
    policyVersion: 'fixture-trusted-license-v1',
    licenseSnapshotRefs: Object.freeze(['sc:license:fixture-approved']),
    ...overrides,
  });
}

function signLicenseAuthorization(
  authorization: TrustedBoundedPublicLicenseApproval,
): SignedBoundedPublicLicenseApproval {
  return Object.freeze({
    authorization,
    signatureBase64: signBytes(
      null,
      boundedPublicLicenseAuthorizationBytes(authorization),
      TRUSTED_LICENSE_KEYS.privateKey,
    ).toString('base64'),
  });
}

function trustedLicenseApproval(
  input: BoundedPublicLicenseVerificationInput,
): SignedBoundedPublicLicenseApproval {
  return signLicenseAuthorization(licenseAuthorization(input));
}

const TRUSTED_LICENSE_OPTIONS: BoundedPublicServingClosureOptions = Object.freeze({
  licenseTrust: Object.freeze({
    trustRootSha256: TRUSTED_ROOT_SHA256,
    publicKeyPem: TRUSTED_PUBLIC_KEY_PEM,
    authorizePublicRelease: (input: BoundedPublicLicenseVerificationInput) =>
      Promise.resolve(trustedLicenseApproval(input)),
  }),
});

describe('generic bounded public serving closure', () => {
  let root: string;
  let operatorRelease: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'oracle-bounded-public-closure-'));
    operatorRelease = join(root, 'operator-release');
    await createBoundedOperatorRelease(operatorRelease, RELEASE_ID, RUN_ID);
    await writeFile(join(operatorRelease, 'bounded-build-checkpoint.json'), 'operator-only\n');
  }, 30_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('accepts a partial_county f4-like release with the exact final signed approval', async () => {
    const closure = await buildBoundedPublicServingClosure(
      operatorRelease,
      join(root, 'public-closure'),
      TRUSTED_LICENSE_OPTIONS,
    );

    expect(closure.publicArtifactCount).toBe(7);
    expect(closure.manifestCid).toMatch(/^bafkrei[a-z2-7]{52}$/u);
    expect(await recursiveFiles(closure.outputDirectory)).toEqual(PUBLIC_FILES);
    const manifest = JSON.parse(
      await readFile(join(closure.outputDirectory, 'release-manifest.json'), 'utf8'),
    ) as BoundedServingReleaseManifest;
    const config = JSON.parse(
      await readFile(join(closure.outputDirectory, 'serving-config.json'), 'utf8'),
    ) as Readonly<{
      expected: Readonly<{ releaseId: string; runId: string; manifestSha256: string }>;
    }>;
    expect(manifest.releaseId).toBe(RELEASE_ID);
    expect(manifest.artifacts).toHaveLength(7);
    expect(manifest.artifacts.every(({ visibility }) => visibility === 'public')).toBe(true);
    const propertyArtifact = manifest.artifacts.find(
      ({ relation }) => relation === 'property_query',
    );
    expect(propertyArtifact?.schemaSha256).toBe(
      '1777bd6cd41a50ef103e462955fafbf9c8ec98025ea99f1ddd2f533359a4bbfa',
    );
    expect(propertyArtifact?.columns.map(({ name }) => name)).not.toContain('source_ids_json');
    expect(propertyArtifact?.columns.map(({ name }) => name)).not.toContain(
      'field_source_ids_json',
    );
    expect(
      manifest.artifacts.find(({ relation }) => relation === 'data_dictionary')?.rowCount,
    ).toBe(
      BOUNDED_COUNTY_OUTPUT_RELATIONS.reduce(
        (total, relation) => total + SERVING_RELATIONS[relation].columns.length,
        0,
      ),
    );
    expect(config.expected).toMatchObject({
      releaseId: RELEASE_ID,
      runId: RUN_ID,
      manifestSha256: manifest.manifestSha256,
    });
    expect(await pathExists(join(closure.outputDirectory, 'restricted'))).toBe(false);
    expect(await pathExists(join(closure.outputDirectory, 'release-evidence.json'))).toBe(false);
    expect(await pathExists(join(closure.outputDirectory, 'bounded-build-checkpoint.json'))).toBe(
      false,
    );
    expect(await pathExists(join(closure.outputDirectory, 'public/oracle-public.duckdb'))).toBe(
      false,
    );
  }, 30_000);

  it.each(['pilot', 'full_county'] as const)(
    'rejects a verified %s release before staging the generic closure',
    async (releaseScope) => {
      const scopedRelease = join(root, `${releaseScope}-scope-release`);
      await cp(operatorRelease, scopedRelease, { recursive: true });
      const evidencePath = join(scopedRelease, 'release-evidence.json');
      const evidence = JSON.parse(await readFile(evidencePath, 'utf8')) as Record<string, unknown>;
      evidence.releaseScope = releaseScope;
      evidence.countyCompletionClaim = releaseScope === 'full_county';
      if (releaseScope === 'full_county') {
        evidence.permitAuthorityCoverage = { covered: 16, total: 16 };
      }
      rehashEvidence(evidence);
      await writeCanonical(evidencePath, evidence);

      const output = join(root, `${releaseScope}-scope-output`);
      await expect(
        buildBoundedPublicServingClosure(scopedRelease, output, TRUSTED_LICENSE_OPTIONS),
      ).rejects.toBeInstanceOf(ReleaseManifestError);
      expect(await pathExists(output)).toBe(false);
    },
    30_000,
  );

  it('loads the closure through the production loader and the CDK public-release contract', async () => {
    const closure = await buildBoundedPublicServingClosure(
      operatorRelease,
      join(root, 'production-contract-closure'),
      TRUSTED_LICENSE_OPTIONS,
    );
    const manifest = JSON.parse(
      await readFile(join(closure.outputDirectory, 'release-manifest.json'), 'utf8'),
    ) as BoundedServingReleaseManifest;
    for (const artifact of manifest.artifacts) {
      for (const lineage of artifact.sourceLineage) {
        expect(Object.keys(lineage).sort()).toEqual([
          'asOf',
          'role',
          'schemaSha256',
          'snapshotId',
          'sourceId',
          'sourceSha256',
        ]);
      }
    }

    const { loadProductionRelease, validatePublicReleaseBundle } =
      await loadProductionContractModules();
    expect(
      validatePublicReleaseBundle({
        repositoryRoot: root,
        releaseDirectory: closure.outputDirectory,
        servingConfigRelativePath: 'serving-config.json',
      }),
    ).toMatchObject({ directory: closure.outputDirectory });

    const document = JSON.parse(
      await readFile(join(closure.outputDirectory, 'serving-config.json'), 'utf8'),
    ) as Readonly<Record<string, unknown>>;
    const loaded = await loadProductionRelease({
      ...document,
      releaseRoot: closure.outputDirectory,
      cursorSecret: new Uint8Array(32).fill(7),
    });
    expect(loaded.manifest.releaseId).toBe(RELEASE_ID);
    expect(loaded.publicArtifacts).toHaveLength(7);
  }, 30_000);

  it('projects from verified Parquet when the schema-compatible public catalog diverges', async () => {
    const divergent = join(root, 'catalog-divergent-release');
    await cp(operatorRelease, divergent, { recursive: true });
    await divergePublicCatalog(divergent);

    const closure = await buildBoundedPublicServingClosure(
      divergent,
      join(root, 'catalog-divergent-output'),
      TRUSTED_LICENSE_OPTIONS,
    );
    const config = JSON.parse(
      await readFile(join(closure.outputDirectory, 'serving-config.json'), 'utf8'),
    ) as Readonly<{
      capabilities: Readonly<Record<string, Readonly<{ state: string }>>>;
    }>;
    expect(config.capabilities.roof_age?.state).toBe('supported');
  }, 30_000);

  it('rejects a final projected artifact replaced during signed authorization', async () => {
    const output = join(root, 'projection-replacement-output');
    const options: BoundedPublicServingClosureOptions = {
      licenseTrust: {
        trustRootSha256: TRUSTED_ROOT_SHA256,
        publicKeyPem: TRUSTED_PUBLIC_KEY_PEM,
        authorizePublicRelease: async (input) => {
          const projectionPrefix = `.${basename(output)}.projection-`;
          const projection = (await readdir(root)).find((entry) =>
            entry.startsWith(projectionPrefix),
          );
          if (projection === undefined) throw new Error('fixture projection directory');
          const artifact = join(root, projection, 'public/property-query.parquet');
          const replacement = Buffer.concat([await readFile(artifact), Buffer.from([0])]);
          await rename(artifact, `${artifact}.authorized`);
          await writeFile(artifact, replacement);
          return trustedLicenseApproval(input);
        },
      },
    };

    await expect(
      buildBoundedPublicServingClosure(operatorRelease, output, options),
    ).rejects.toThrow();
    expect(await pathExists(output)).toBe(false);
  }, 30_000);

  it('rejects a valid signature bound to pre-projection manifest and artifact hashes', async () => {
    const sourceManifest = JSON.parse(
      await readFile(join(operatorRelease, 'release-manifest.json'), 'utf8'),
    ) as BoundedServingReleaseManifest;
    const preProjectionArtifacts = sourceManifest.artifacts
      .filter(({ visibility }) => visibility === 'public')
      .map(({ relation, relativePath, sha256 }) => `${relation}:${relativePath}:${sha256}`)
      .sort();
    const output = join(root, 'pre-projection-approval-output');
    const options: BoundedPublicServingClosureOptions = {
      licenseTrust: {
        trustRootSha256: TRUSTED_ROOT_SHA256,
        publicKeyPem: TRUSTED_PUBLIC_KEY_PEM,
        authorizePublicRelease: (input) =>
          Promise.resolve(
            signLicenseAuthorization(
              licenseAuthorization(input, {
                manifestSha256: sourceManifest.manifestSha256,
                publicArtifactSha256s: Object.freeze(preProjectionArtifacts),
              }),
            ),
          ),
      },
    };

    await expect(
      buildBoundedPublicServingClosure(operatorRelease, output, options),
    ).rejects.toBeInstanceOf(ReleaseLicenseError);
    expect(await pathExists(output)).toBe(false);
  }, 30_000);

  it('rejects a forged trust-root fingerprint even when the approval signature is valid', async () => {
    const output = join(root, 'forged-trust-root-output');
    const options: BoundedPublicServingClosureOptions = {
      licenseTrust: {
        trustRootSha256: FORGED_ROOT_SHA256,
        publicKeyPem: TRUSTED_PUBLIC_KEY_PEM,
        authorizePublicRelease: (input) => Promise.resolve(trustedLicenseApproval(input)),
      },
    };

    await expect(
      buildBoundedPublicServingClosure(operatorRelease, output, options),
    ).rejects.toBeInstanceOf(ReleaseLicenseError);
    expect(await pathExists(output)).toBe(false);
  }, 30_000);

  it('rejects output-parent replacement during trusted authorization', async () => {
    const outputParent = join(root, 'replaced-output-parent');
    const output = join(outputParent, 'closure');
    await mkdir(outputParent);
    const options: BoundedPublicServingClosureOptions = {
      licenseTrust: {
        trustRootSha256: TRUSTED_ROOT_SHA256,
        publicKeyPem: TRUSTED_PUBLIC_KEY_PEM,
        authorizePublicRelease: async (input) => {
          await rm(outputParent, { recursive: true, force: true });
          await mkdir(outputParent);
          return trustedLicenseApproval(input);
        },
      },
    };

    await expect(
      buildBoundedPublicServingClosure(operatorRelease, output, options),
    ).rejects.toBeInstanceOf(ReleaseSegregationError);
    expect(await pathExists(output)).toBe(false);
  }, 30_000);

  it('rejects a junction or symlink in the output ancestor chain', async () => {
    const realParent = join(root, 'real-output-parent');
    const linkedParent = join(root, 'linked-output-parent');
    await mkdir(realParent);
    await symlink(realParent, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(
      buildBoundedPublicServingClosure(
        operatorRelease,
        join(linkedParent, 'closure'),
        TRUSTED_LICENSE_OPTIONS,
      ),
    ).rejects.toBeInstanceOf(ReleaseSegregationError);
  });

  it('rejects artifact tampering before staging any output', async () => {
    const tampered = join(root, 'tampered-release');
    await cp(operatorRelease, tampered, { recursive: true });
    const artifact = join(tampered, 'public/property-query.parquet');
    await writeFile(artifact, Buffer.concat([await readFile(artifact), Buffer.from([0])]));

    const output = join(root, 'tampered-output');
    await expect(
      buildBoundedPublicServingClosure(tampered, output, TRUSTED_LICENSE_OPTIONS),
    ).rejects.toThrow();
    expect(await pathExists(output)).toBe(false);
  }, 30_000);

  it('rejects a self-asserted evidence license gate without a trusted caller authorizer', async () => {
    await expect(
      buildBoundedPublicServingClosure(
        operatorRelease,
        join(root, 'untrusted-license-output'),
        undefined as unknown as BoundedPublicServingClosureOptions,
      ),
    ).rejects.toBeInstanceOf(ReleaseLicenseError);
  });

  it('rejects symlinked operator material before verification or copying', async () => {
    const linked = join(root, 'linked-release');
    await cp(operatorRelease, linked, { recursive: true });
    await rm(join(linked, 'public'), { recursive: true, force: true });
    await symlink(
      join(operatorRelease, 'public'),
      join(linked, 'public'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(
      buildBoundedPublicServingClosure(
        linked,
        join(root, 'linked-output'),
        TRUSTED_LICENSE_OPTIONS,
      ),
    ).rejects.toBeInstanceOf(ReleaseSegregationError);
  });

  it('rejects rehashed public artifacts whose required lineage was removed', async () => {
    const drifted = join(root, 'lineage-drift-release');
    await cp(operatorRelease, drifted, { recursive: true });
    const manifestPath = join(drifted, 'release-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    const artifacts = manifest.artifacts as Record<string, unknown>[];
    const publicArtifact = artifacts.find(({ visibility }) => visibility === 'public');
    if (publicArtifact === undefined) throw new Error('fixture public artifact');
    publicArtifact.sourceLineage = [];
    rehashManifest(manifest);
    await writeCanonical(manifestPath, manifest);
    const evidencePath = join(drifted, 'release-evidence.json');
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8')) as Record<string, unknown>;
    evidence.manifestSha256 = manifest.manifestSha256;
    rehashEvidence(evidence);
    await writeCanonical(evidencePath, evidence);

    await expect(
      buildBoundedPublicServingClosure(
        drifted,
        join(root, 'lineage-drift-output'),
        TRUSTED_LICENSE_OPTIONS,
      ),
    ).rejects.toBeInstanceOf(ReleaseManifestError);
  }, 30_000);

  it('rejects a portable release whose pipeline row belongs to another run', async () => {
    const mixed = join(root, 'mixed-run-release');
    await createBoundedOperatorRelease(mixed, RELEASE_ID, `sc:run:${'b'.repeat(64)}`);

    await expect(
      buildBoundedPublicServingClosure(
        mixed,
        join(root, 'mixed-run-output'),
        TRUSTED_LICENSE_OPTIONS,
      ),
    ).rejects.toThrow(/mixed/iu);
  }, 30_000);

  it('rejects a rehashed evidence document with a failed owner-free intersection gate', async () => {
    const drifted = join(root, 'privacy-drift-release');
    await cp(operatorRelease, drifted, { recursive: true });
    const evidencePath = join(drifted, 'release-evidence.json');
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8')) as Record<string, unknown>;
    evidence.publicRestrictedValueOverlap = 1;
    rehashEvidence(evidence);
    await writeCanonical(evidencePath, evidence);

    await expect(
      buildBoundedPublicServingClosure(
        drifted,
        join(root, 'privacy-drift-output'),
        TRUSTED_LICENSE_OPTIONS,
      ),
    ).rejects.toThrow();
  }, 30_000);
});

async function loadProductionContractModules() {
  const dynamicImport = (specifier: string): Promise<unknown> => import(specifier);
  const loaderUrl = pathToFileURL(
    resolve(import.meta.dirname, '../../../query-core/dist/serving/release.js'),
  ).href;
  const cdkUrl = pathToFileURL(
    resolve(import.meta.dirname, '../../../../infra/cdk/dist/lib/public-release.js'),
  ).href;
  const [loader, cdk] = await Promise.all([dynamicImport(loaderUrl), dynamicImport(cdkUrl)]);
  return {
    loadProductionRelease: (loader as ProductionLoaderModule).loadProductionRelease,
    validatePublicReleaseBundle: (cdk as CdkPublicReleaseModule).validatePublicReleaseBundle,
  };
}

type ProductionLoaderModule = Readonly<{
  loadProductionRelease(config: Readonly<Record<string, unknown>>): Promise<
    Readonly<{
      manifest: Readonly<{ releaseId: string }>;
      publicArtifacts: readonly unknown[];
    }>
  >;
}>;

type CdkPublicReleaseModule = Readonly<{
  validatePublicReleaseBundle(options: Readonly<Record<string, unknown>>): Readonly<{
    directory: string;
  }>;
}>;

async function divergePublicCatalog(root: string): Promise<void> {
  const catalogPath = join(root, 'public/oracle-public.duckdb');
  const instance = await DuckDBInstance.create(catalogPath, { threads: '1' });
  const connection = await instance.connect();
  try {
    await connection.run("UPDATE property_query SET roof_support_class = 'unsupported'");
    await connection.run('CHECKPOINT');
  } finally {
    connection.closeSync();
    instance.closeSync();
  }

  const catalogBytes = await readFile(catalogPath);
  const evidencePath = join(root, 'release-evidence.json');
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8')) as Record<string, unknown>;
  const catalogs = evidence.catalogs as Record<string, unknown>[];
  const publicCatalog = catalogs.find(({ visibility }) => visibility === 'public');
  if (publicCatalog === undefined) throw new Error('fixture public catalog evidence');
  publicCatalog.byteSize = catalogBytes.byteLength;
  publicCatalog.sha256 = digest(catalogBytes);
  rehashEvidence(evidence);
  await writeCanonical(evidencePath, evidence);
}

async function createBoundedOperatorRelease(
  root: string,
  releaseId: string,
  pipelineRunId: string,
): Promise<void> {
  await mkdir(root, { recursive: true });
  const artifacts: BoundedPortableReleaseArtifact[] = [];
  const catalogs: BoundedServingCatalog[] = [];
  for (const visibility of ['public', 'restricted'] as const) {
    let catalogRecordCount = 0;
    const directory = join(root, visibility);
    await mkdir(directory, { recursive: true });
    const catalogPath = join(directory, `oracle-${visibility}.duckdb`);
    const instance = await DuckDBInstance.create(catalogPath, { threads: '1' });
    const connection = await instance.connect();
    try {
      for (const relation of BOUNDED_COUNTY_OUTPUT_RELATIONS) {
        const definition = BOUNDED_SERVING_RELATIONS[relation];
        await connection.run(
          `CREATE TABLE ${quote(relation)} (${definition.columns
            .map(
              ({ name, duckdbType, nullable }) =>
                `${quote(name)} ${duckdbType}${nullable ? '' : ' NOT NULL'}`,
            )
            .join(',')})`,
        );
        const rows = fixtureRows(relation, visibility, pipelineRunId);
        const appender = await connection.createAppender(relation);
        for (const row of rows) appendRow(appender, relation, row);
        appender.flushSync();
        appender.closeSync();
        catalogRecordCount += rows.length;
        const relativePath = `${visibility}/${definition.fileName}`;
        const parquetPath = join(root, relativePath);
        await connection.run(
          `COPY (SELECT * FROM ${quote(relation)} ORDER BY ${definition.sortColumns
            .map(quote)
            .join(',')}) TO '${sqlPath(parquetPath)}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
        );
        const bytes = await readFile(parquetPath);
        artifacts.push(
          Object.freeze({
            relation,
            relativePath,
            visibility,
            mediaType: 'application/vnd.apache.parquet' as const,
            byteSize: bytes.byteLength,
            sha256: digest(bytes),
            rowCount: rows.length,
            schemaSha256:
              relation === 'data_dictionary'
                ? digest(canonicalJson(definition.columns))
                : boundedServingSchemaSha256(relation),
            columns: definition.columns,
            nonNullCounts: Object.freeze(
              Object.fromEntries(
                definition.columns.map(({ name }) => [
                  name,
                  rows.filter((row) => row[name] !== null).length,
                ]),
              ),
            ),
            grain: definition.grain,
            sourceLineage: Object.freeze([
              Object.freeze({
                sourceId: SOURCE_ID,
                snapshotId: `sc:snapshot:fixture:${'c'.repeat(64)}`,
                sourceSha256: 'd'.repeat(64),
                schemaSha256: 'e'.repeat(64),
                asOf: INSTANT,
                role: 'derived' as const,
                contributors: Object.freeze(['Fixture contributor']),
              }),
            ]),
            limitations: Object.freeze([`Bounded ${visibility} ${relation} fixture.`]),
          }),
        );
      }
      await connection.run('CHECKPOINT');
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
    const catalogBytes = await readFile(catalogPath);
    catalogs.push(
      Object.freeze({
        visibility,
        relativePath: `${visibility}/oracle-${visibility}.duckdb`,
        byteSize: catalogBytes.byteLength,
        sha256: digest(catalogBytes),
        relationCount: 7 as const,
        recordCount: catalogRecordCount,
      }),
    );
  }

  const manifestPayload = {
    contractVersion: '1.0.0' as const,
    releaseId,
    runId: RUN_ID,
    county: 'Santa Clara' as const,
    state: 'CA' as const,
    generatedAt: INSTANT,
    duckdbVersion: 'v1.4.5',
    sourceIds: Object.freeze([SOURCE_ID]),
    artifacts: Object.freeze(artifacts),
  };
  const manifest: BoundedServingReleaseManifest = Object.freeze({
    ...manifestPayload,
    manifestSha256: digest(`${canonicalJson(manifestPayload)}\n`),
  });
  const evidencePayload = {
    contractVersion: '1.0.0' as const,
    releaseId,
    runId: RUN_ID,
    county: 'Santa Clara' as const,
    state: 'CA' as const,
    generatedAt: INSTANT,
    runStatus: 'succeeded' as const,
    releaseScope: 'partial_county' as const,
    countyCompletionClaim: false,
    permitAuthorityCoverage: Object.freeze({ covered: 1, total: 16 as const }),
    capabilities: Object.freeze([]),
    sourceStates: Object.freeze([]),
    manifestSha256: manifest.manifestSha256,
    artifacts: Object.freeze(
      artifacts.map(({ relation, visibility, relativePath, rowCount, byteSize, sha256 }) =>
        Object.freeze({ relation, visibility, relativePath, rowCount, byteSize, sha256 }),
      ),
    ),
    catalogs: Object.freeze(catalogs),
    gates: Object.freeze({
      license: 'passed' as const,
      manifest: 'passed' as const,
      parquet: 'passed' as const,
      cleanReopen: 'passed' as const,
      publicRestrictedSegregation: 'passed' as const,
      ownerBearingPublicValues: 0 as const,
    }),
    logicalOutputIdentitySha256: 'f'.repeat(64),
    publicRestrictedValueOverlap: 0 as const,
    publicRelationCount: 7 as const,
    restrictedRelationCount: 7 as const,
    portableReopen: 'passed' as const,
    schemaOrder: 'passed' as const,
    rowOrder: 'passed' as const,
    immutableHashes: 'passed' as const,
    budget: Object.freeze({
      peakBufferedRecords: 1,
      peakBufferedBytes: 1024,
      peakRssBytes: 1024,
      maxBufferedRecords: 100,
      maxBufferedBytes: 1024 * 1024,
      maxRssBytes: 512 * 1024 * 1024,
    }),
  };
  const evidence: BoundedServingReleaseEvidence = Object.freeze({
    ...evidencePayload,
    evidenceSha256: digest(canonicalJson(evidencePayload)),
  });
  await writeCanonical(join(root, 'release-manifest.json'), manifest);
  await writeCanonical(join(root, 'release-evidence.json'), evidence);
}

function fixtureRows(
  relation: ServingRelationName,
  visibility: ServingVisibility,
  pipelineRunId: string,
): readonly ServingRow[] {
  if (relation !== 'data_dictionary') {
    return [fixtureRow(relation, visibility, pipelineRunId)];
  }
  const base = fixtureRow(relation, visibility, pipelineRunId);
  return BOUNDED_COUNTY_OUTPUT_RELATIONS.flatMap((releasedRelation) => {
    const definition = BOUNDED_SERVING_RELATIONS[releasedRelation];
    return definition.columns.map((column, index) => ({
      ...base,
      relation_name: releasedRelation,
      ordinal: index + 1,
      column_name: column.name,
      duckdb_type: column.duckdbType,
      nullable: column.nullable,
      grain: definition.grain,
      description: column.description,
      visibility,
    }));
  });
}

function fixtureRow(
  relation: ServingRelationName,
  visibility: ServingVisibility,
  pipelineRunId: string,
): ServingRow {
  const overrides: Readonly<Record<string, ServingScalar>> =
    relation === 'property_query'
      ? {
          property_id: `${visibility}-property`,
          parcel_identifier: '127-69-001',
          roof_support_class: 'supported',
          water_support_class: 'proxy',
          ownership_support_class: 'unknown',
          regional_owner_support_class: 'unsupported',
          transit_support_class: 'supported',
          starbucks_support_class: 'unknown',
          evidence_coverage: 0.5,
          visibility,
          source_ids_json: JSON.stringify([SOURCE_ID]),
          field_source_ids_json: '{}',
        }
      : relation === 'property_evidence'
        ? {
            evidence_id: `${visibility}-evidence`,
            property_id: `${visibility}-property`,
            feature: 'roof_age',
            support_class: visibility === 'public' ? 'supported' : 'unknown',
            confidence: 1,
            as_of: INSTANT,
            value_json: '{}',
            source_ids_json: JSON.stringify([SOURCE_ID]),
            source_references_json: '[]',
            limitations_json: '[]',
            visibility,
          }
        : relation === 'pipeline_runs'
          ? {
              run_id: pipelineRunId,
              status: 'succeeded',
              source_ids_json: JSON.stringify([SOURCE_ID]),
              limitations_json: '[]',
            }
          : relation === 'source_coverage'
            ? {
                source_id: SOURCE_ID,
                source_sha256: 'd'.repeat(64),
                schema_sha256: 'e'.repeat(64),
                support_class: 'supported',
                limitations_json: '[]',
              }
            : relation === 'field_coverage'
              ? {
                  relation_name: 'property_query',
                  field_name: 'property_id',
                  support_class: 'supported',
                  numerator: 1,
                  denominator: 1,
                  ratio: 1,
                  source_ids_json: JSON.stringify([SOURCE_ID]),
                  limitations_json: '[]',
                }
              : relation === 'relation_coverage'
                ? {
                    relation_name: 'property_evidence_to_property_query',
                    support_class: 'supported',
                    linked_count: 1,
                    eligible_count: 1,
                    ratio: 1,
                    limitations_json: '[]',
                  }
                : relation === 'data_dictionary'
                  ? {
                      relation_name: 'property_query',
                      ordinal: 1,
                      column_name: 'property_id',
                      duckdb_type: 'VARCHAR',
                      nullable: false,
                      grain: BOUNDED_SERVING_RELATIONS.property_query.grain,
                      description: 'Fixture dictionary row.',
                      visibility,
                    }
                  : {};
  const definition = BOUNDED_SERVING_RELATIONS[relation];
  return Object.fromEntries(
    definition.columns.map((column) => [
      column.name,
      Object.hasOwn(overrides, column.name)
        ? overrides[column.name]
        : defaultScalar(column.name, column.duckdbType, column.nullable),
    ]),
  ) as ServingRow;
}

function appendRow(appender: DuckDBAppender, relation: ServingRelationName, row: ServingRow): void {
  for (const column of BOUNDED_SERVING_RELATIONS[relation].columns) {
    const value = row[column.name];
    if (value === null || value === undefined) appender.appendNull();
    else if (column.duckdbType === 'VARCHAR') appender.appendVarchar(String(value));
    else if (column.duckdbType === 'BOOLEAN') appender.appendBoolean(Boolean(value));
    else if (column.duckdbType === 'BIGINT') appender.appendBigInt(BigInt(Number(value)));
    else appender.appendDouble(Number(value));
  }
  appender.endRow();
}

function defaultScalar(
  name: string,
  type: 'VARCHAR' | 'BOOLEAN' | 'BIGINT' | 'DOUBLE',
  nullable: boolean,
): ServingScalar {
  if (nullable) return null;
  if (type === 'BOOLEAN') return false;
  if (type === 'BIGINT') return 1;
  if (type === 'DOUBLE') return 1;
  if (name.endsWith('_json')) return '[]';
  if (name.endsWith('_support_class') || name === 'support_class') return 'unknown';
  if (name.endsWith('_at') || name === 'as_of' || name === 'valid_from') return INSTANT;
  if (name.endsWith('sha256')) return 'a'.repeat(64);
  return `${name}-fixture`;
}

function rehashManifest(manifest: Record<string, unknown>): void {
  delete manifest.manifestSha256;
  manifest.manifestSha256 = digest(`${canonicalJson(manifest)}\n`);
}

function rehashEvidence(evidence: Record<string, unknown>): void {
  delete evidence.evidenceSha256;
  evidence.evidenceSha256 = digest(canonicalJson(evidence));
}

async function writeCanonical(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${canonicalJson(value)}\n`);
}

async function recursiveFiles(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await recursiveFiles(root, relativePath)));
    else files.push(relativePath);
  }
  return files.sort();
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqlPath(path: string): string {
  return resolve(path).replaceAll('\\', '/').replaceAll("'", "''");
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    typeof value === 'number'
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  throw new TypeError('Unsupported fixture value');
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
