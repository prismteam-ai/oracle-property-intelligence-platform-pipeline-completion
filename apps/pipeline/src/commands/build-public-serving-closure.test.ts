import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { LocalArtifactStore } from '@oracle/artifacts/implementations/local-artifact-store';
import type { PhaseArtifact, PipelineRunManifest } from '../orchestration/types.js';
import { canonicalBytes } from '../orchestration/canonical-json.js';
import type {
  BoundedServingReleaseEvidence,
  BoundedServingReleaseManifest,
} from '@oracle/data-runtime/serving/bounded-release';
import {
  boundedPublicLicenseAuthorizationBytes,
  type BoundedPublicLicenseVerificationInput,
  type BoundedPublicServingClosureOptions,
  type PublicServingClosure,
  type SignedBoundedPublicLicenseApproval,
} from '@oracle/data-runtime/serving/real-county-release';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  PUBLIC_CLOSURE_FILES,
  PublicClosureValidationError,
  runPublicClosureCommand,
  type PublicClosureAuthorizationPolicy,
  type PublicClosureCommandDependencies,
} from './build-public-serving-closure.js';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../../..');
const TEST_TEMP_ROOT = join(REPOSITORY_ROOT, 'tmp', `public-closure-command-tests-${process.pid}`);
const TEST_SECRET_ROOT = join(
  REPOSITORY_ROOT,
  'secrets',
  `public-closure-command-tests-${process.pid}`,
);
const RUN_ID = `sc:run:${'1'.repeat(64)}`;
const GENERATION_ID = `sc:generation:${'2'.repeat(64)}`;
const RELEASE_ID = 'santa-clara-public-closure-command-fixture';
const OPERATOR_MANIFEST_SHA256 = '3'.repeat(64);
const EVIDENCE_SHA256 = '4'.repeat(64);
const FINAL_MANIFEST_SHA256 = '5'.repeat(64);
const FINAL_MANIFEST_CID = `bafkrei${'a'.repeat(52)}`;
const RESTRICTED_SENTINEL = 'restricted-owner-value-must-not-escape';
const createdPaths: string[] = [];

type Harness = Readonly<{
  root: string;
  runRoot: string;
  manifestPath: string;
  policyPath: string;
  privateKeyPath: string;
  outputDirectory: string;
  releaseDirectory: string;
  manifest: PipelineRunManifest;
  policy: PublicClosureAuthorizationPolicy;
  releaseManifest: BoundedServingReleaseManifest;
  releaseEvidence: BoundedServingReleaseEvidence;
  privateKeyPem: string;
}>;

interface DependencyObservation {
  verifiedDirectories: string[];
  approval: SignedBoundedPublicLicenseApproval | null;
}

afterEach(async () => {
  await Promise.all(
    createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

afterAll(async () => {
  await Promise.all(
    [TEST_TEMP_ROOT, TEST_SECRET_ROOT].map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('public-closure operator command', () => {
  it('selects the immutable descriptor from the terminal manifest when newer generations exist', async () => {
    const harness = await createHarness();
    const newerGeneration = `sc:generation:${'9'.repeat(64)}`;
    const newerRelease = join(
      harness.runRoot,
      'releases',
      newerGeneration.slice('sc:generation:'.length, 'sc:generation:'.length + 32),
      'newer-but-unselected',
    );
    await mkdir(newerRelease, { recursive: true });
    await writeDescriptorArtifact(harness.runRoot, RUN_ID, {
      generationId: newerGeneration,
      releaseDirectory: `releases/${'9'.repeat(32)}/newer-but-unselected`,
      manifestSha256: '8'.repeat(64),
      evidenceSha256: '7'.repeat(64),
      artifactCount: 14,
      countyCompletionClaim: false,
    });
    const observation = createObservation();

    const summary = await runPublicClosureCommand(
      commandOptions(harness),
      createDependencies(harness, observation),
    );

    expect(observation.verifiedDirectories).toEqual([harness.releaseDirectory]);
    expect(summary).toEqual({
      outputPath: harness.outputDirectory,
      manifestSha256: FINAL_MANIFEST_SHA256,
      manifestCid: FINAL_MANIFEST_CID,
      publicArtifactCount: 7,
    });
  });

  it.each([
    ['declared byte size', (artifact: PhaseArtifact) => ({ ...artifact, byteSize: 1 })],
    [
      'declared SHA-256',
      (artifact: PhaseArtifact) => ({
        ...artifact,
        sha256: 'a'.repeat(64),
      }),
    ],
  ])('rejects a descriptor %s mismatch', async (_label, mutate) => {
    const harness = await createHarness();
    const descriptorArtifact = harness.manifest.artifacts[0];
    if (descriptorArtifact === undefined) throw new Error('fixture descriptor missing');
    await replaceManifest(harness, {
      ...harness.manifest,
      artifacts: [mutate(descriptorArtifact)],
    });

    await expect(
      runPublicClosureCommand(commandOptions(harness), createDependencies(harness)),
    ).rejects.toBeInstanceOf(PublicClosureValidationError);
  });

  it('rejects an artifact-store junction that physically escapes the run root', async () => {
    const harness = await createHarness();
    const artifactRoot = join(harness.runRoot, 'artifacts');
    const escapedArtifactRoot = join(harness.root, 'escaped-artifacts');
    await rename(artifactRoot, escapedArtifactRoot);
    await linkDirectory(escapedArtifactRoot, artifactRoot);
    const observation = createObservation();

    await expect(
      runPublicClosureCommand(commandOptions(harness), createDependencies(harness, observation)),
    ).rejects.toThrow(/artifact|real directory|escapes/iu);
    expect(observation.verifiedDirectories).toEqual([]);
  });

  it.each(['release-root junction', 'nested release junction'])(
    'rejects a %s before release verification',
    async (variant) => {
      const harness = await createHarness();
      const escapedRelease = join(harness.root, `escaped-release-${variant.replaceAll(' ', '-')}`);
      await mkdir(escapedRelease, { recursive: true });
      if (variant === 'release-root junction') {
        await rm(harness.releaseDirectory, { recursive: true });
        await linkDirectory(escapedRelease, harness.releaseDirectory);
      } else {
        await linkDirectory(escapedRelease, join(harness.releaseDirectory, 'linked-material'));
      }
      const observation = createObservation();

      await expect(
        runPublicClosureCommand(commandOptions(harness), createDependencies(harness, observation)),
      ).rejects.toThrow(/release|symlink|real directory|escapes/iu);
      expect(observation.verifiedDirectories).toEqual([]);
    },
  );

  it.each(['running', 'failed', 'aborted'])('rejects a %s run', async (status) => {
    const harness = await createHarness();
    await replaceManifest(harness, { ...harness.manifest, status });

    await expect(
      runPublicClosureCommand(commandOptions(harness), createDependencies(harness)),
    ).rejects.toThrow(/nonterminal|failed|aborted/iu);
  });

  it.each([
    ['expectedRunId', `sc:run:${'a'.repeat(64)}`],
    ['expectedGenerationId', `sc:generation:${'b'.repeat(64)}`],
    ['expectedOperatorManifestSha256', 'c'.repeat(64)],
    ['expectedReleaseId', 'another-release'],
  ] as const)('rejects a policy %s mismatch', async (field, value) => {
    const harness = await createHarness();
    await replacePolicy(harness, { ...harness.policy, [field]: value });

    await expect(
      runPublicClosureCommand(commandOptions(harness), createDependencies(harness)),
    ).rejects.toBeInstanceOf(PublicClosureValidationError);
  });

  it.each([
    ['duplicate', ['sc:license:approved', 'sc:license:approved']],
    ['empty', ['']],
    ['missing', []],
  ])('rejects %s approved license snapshot references', async (_label, references) => {
    const harness = await createHarness();
    await replacePolicy(harness, { ...harness.policy, licenseSnapshotRefs: references });

    await expect(
      runPublicClosureCommand(commandOptions(harness), createDependencies(harness)),
    ).rejects.toThrow(/policy/iu);
  });

  it('rejects an existing output before invoking the release builder', async () => {
    const harness = await createHarness();
    await mkdir(harness.outputDirectory);
    let invoked = false;
    const dependencies = createDependencies(harness, undefined, () => {
      invoked = true;
      return Promise.reject(new Error('builder must not run'));
    });

    await expect(runPublicClosureCommand(commandOptions(harness), dependencies)).rejects.toThrow(
      /must not exist/iu,
    );
    expect(invoked).toBe(false);
  });

  it('cleans failed postcondition staging and supports a clean retry', async () => {
    const harness = await createHarness();
    const successfulDependencies = createDependencies(harness);
    const successfulBuilder = successfulDependencies.buildClosure;
    if (successfulBuilder === undefined) throw new Error('fixture builder missing');
    const failingDependencies: PublicClosureCommandDependencies = {
      ...successfulDependencies,
      buildClosure: async (releaseDirectory, stagingDirectory, options) => {
        const closure = await successfulBuilder(releaseDirectory, stagingDirectory, options);
        await writeFile(join(stagingDirectory, 'unexpected.txt'), 'postcondition failure\n');
        return closure;
      },
    };

    await expect(
      runPublicClosureCommand(commandOptions(harness), failingDependencies),
    ).rejects.toThrow(/exact nine files/iu);
    await expect(pathExists(harness.outputDirectory)).resolves.toBe(false);
    expect(
      (await readdir(harness.root)).filter((entry) =>
        entry.startsWith('.public-output.public-closure-'),
      ),
    ).toEqual([]);

    await expect(
      runPublicClosureCommand(commandOptions(harness), successfulDependencies),
    ).resolves.toMatchObject({ outputPath: harness.outputDirectory, publicArtifactCount: 7 });
  });

  it('rejects invalid, forged-public, and non-Ed25519 private key material', async () => {
    const harness = await createHarness();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const cases = [
      'not a PEM',
      generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      rsa.export({ format: 'pem', type: 'pkcs8' }).toString(),
    ];
    for (const material of cases) {
      await writeFile(harness.privateKeyPath, material, 'utf8');
      await expect(
        runPublicClosureCommand(commandOptions(harness), createDependencies(harness)),
      ).rejects.toThrow(/private key|Ed25519/iu);
    }
  });

  it('rejects a symlinked private key', async () => {
    const harness = await createHarness();
    const target = join(dirname(harness.privateKeyPath), 'target.pem');
    await writeFile(target, harness.privateKeyPem, 'utf8');
    await rm(harness.privateKeyPath);
    await symlink(target, harness.privateKeyPath, 'file');

    await expect(
      runPublicClosureCommand(commandOptions(harness), createDependencies(harness)),
    ).rejects.toThrow(/symlink/iu);
  });

  it('rejects unignored and tracked key paths before parsing key bytes', async () => {
    const harness = await createHarness();
    const unignored = join(REPOSITORY_ROOT, `public-closure-unignored-${process.pid}.txt`);
    createdPaths.push(unignored);
    await writeFile(unignored, harness.privateKeyPem, 'utf8');

    await expect(
      runPublicClosureCommand(
        { ...commandOptions(harness), privateKeyPath: unignored },
        createDependencies(harness),
      ),
    ).rejects.toThrow(/ignored by Git/iu);
    await expect(
      runPublicClosureCommand(
        { ...commandOptions(harness), privateKeyPath: join(REPOSITORY_ROOT, 'package.json') },
        createDependencies(harness),
      ),
    ).rejects.toThrow(/tracked by Git/iu);
  });

  it('signs the exact bounded authorization bytes and emits only an exact nine-file closure', async () => {
    const harness = await createHarness();
    const observation = createObservation();
    const restrictedPath = join(harness.releaseDirectory, 'restricted', 'operator-only.txt');
    await mkdir(dirname(restrictedPath), { recursive: true });
    await writeFile(restrictedPath, RESTRICTED_SENTINEL, 'utf8');

    const summary = await runPublicClosureCommand(
      commandOptions(harness),
      createDependencies(harness, observation),
    );

    const approval = observation.approval;
    if (approval === null) throw new Error('fixture builder did not receive an approval');
    const emitted = JSON.stringify(summary);
    const outputContents = await Promise.all(
      PUBLIC_CLOSURE_FILES.map((path) => readFile(join(harness.outputDirectory, path), 'utf8')),
    );
    expect(approval.authorization.manifestSha256).toBe(FINAL_MANIFEST_SHA256);
    expect(approval.authorization.policyVersion).toBe(harness.policy.policyVersion);
    expect(approval.authorization.licenseSnapshotRefs).toEqual(harness.policy.licenseSnapshotRefs);
    expect(emitted).not.toContain('PRIVATE KEY');
    expect(emitted).not.toContain(approval.signatureBase64);
    expect(emitted).not.toContain(RESTRICTED_SENTINEL);
    expect(outputContents.join('\n')).not.toContain('PRIVATE KEY');
    expect(outputContents.join('\n')).not.toContain(approval.signatureBase64);
    expect(outputContents.join('\n')).not.toContain(RESTRICTED_SENTINEL);
  });

  it('rejects a mixed verified manifest or failed release gate before signing', async () => {
    const harness = await createHarness();
    const mismatchedManifest = {
      ...harness.releaseManifest,
      runId: `sc:run:${'d'.repeat(64)}`,
    } as BoundedServingReleaseManifest;
    const failedEvidence = {
      ...harness.releaseEvidence,
      gates: { ...harness.releaseEvidence.gates, ownerBearingPublicValues: 1 },
    } as unknown as BoundedServingReleaseEvidence;

    await expect(
      runPublicClosureCommand(commandOptions(harness), {
        ...createDependencies(harness),
        verifyRelease: () =>
          Promise.resolve({ manifest: mismatchedManifest, evidence: harness.releaseEvidence }),
      }),
    ).rejects.toThrow(/mixed/iu);
    await expect(
      runPublicClosureCommand(commandOptions(harness), {
        ...createDependencies(harness),
        verifyRelease: () =>
          Promise.resolve({ manifest: harness.releaseManifest, evidence: failedEvidence }),
      }),
    ).rejects.toThrow(/privacy|parity/iu);
  });
});

async function createHarness(): Promise<Harness> {
  await Promise.all([
    mkdir(TEST_TEMP_ROOT, { recursive: true }),
    mkdir(TEST_SECRET_ROOT, { recursive: true }),
  ]);
  const root = await mkdtemp(join(TEST_TEMP_ROOT, 'case-'));
  const secretRoot = await mkdtemp(join(TEST_SECRET_ROOT, 'case-'));
  createdPaths.push(root, secretRoot);
  const runRoot = join(root, 'run');
  await mkdir(runRoot);
  const descriptor = {
    generationId: GENERATION_ID,
    releaseDirectory: `releases/${'2'.repeat(32)}/${RELEASE_ID}`,
    manifestSha256: OPERATOR_MANIFEST_SHA256,
    evidenceSha256: EVIDENCE_SHA256,
    artifactCount: 14,
    countyCompletionClaim: false,
  };
  const descriptorArtifact = await writeDescriptorArtifact(runRoot, RUN_ID, descriptor);
  const manifest = {
    schemaVersion: '2.0.0',
    runId: RUN_ID,
    pipelineVersion: '2.0.0',
    profile: 'full',
    status: 'partial',
    requestedAt: '2026-07-19T00:00:00.000Z',
    completedAt: '2026-07-19T01:00:00.000Z',
    configurationHash: '6'.repeat(64),
    coverageDenominators: {
      expectedRecords: null,
      observedRecords: 1,
      acceptedRecords: 1,
      quarantinedRecords: 0,
    },
    backpressure: {
      maxConcurrentSources: 1,
      maxBufferedRecords: 1,
      observedHighWaterRecords: 1,
      observedHighWaterActiveRecords: 1,
      observedHighWaterBufferedEvents: 0,
      observedHighWaterCombinedRecordsAndEvents: 1,
      activeRecordsAtCompletion: 0,
      bufferedEventsAtCompletion: 0,
      totalBudgetAcquisitions: 1,
    },
    sources: [],
    artifacts: [descriptorArtifact],
    countyCompletion: {
      state: 'partial',
      requiredSourceCount: 1,
      completeRequiredSourceCount: 0,
      blockingSourceIds: [],
      missingRequiredCapabilities: [],
      unexpectedRequiredCapabilities: [],
      claim: 'partial fixture',
    },
    limitations: [],
  } as unknown as PipelineRunManifest;
  const manifestPath = join(root, 'terminal-run.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
  const policy: PublicClosureAuthorizationPolicy = Object.freeze({
    expectedRunId: RUN_ID,
    expectedGenerationId: GENERATION_ID,
    expectedOperatorManifestSha256: OPERATOR_MANIFEST_SHA256,
    expectedReleaseId: RELEASE_ID,
    policyVersion: 'public-closure-command-policy-v1',
    licenseSnapshotRefs: Object.freeze(['sc:license:approved-fixture']),
  });
  const policyPath = join(secretRoot, 'authorization.json');
  await writeFile(policyPath, `${JSON.stringify(policy)}\n`, 'utf8');
  const keys = generateKeyPairSync('ed25519');
  const privateKeyPem = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const privateKeyPath = join(secretRoot, 'authorization.pem');
  await writeFile(privateKeyPath, privateKeyPem, 'utf8');
  const releaseDirectory = join(runRoot, descriptor.releaseDirectory);
  await mkdir(releaseDirectory, { recursive: true });
  const releaseManifest = {
    contractVersion: '1.0.0',
    releaseId: RELEASE_ID,
    runId: RUN_ID,
    county: 'Santa Clara',
    state: 'CA',
    generatedAt: '2026-07-19T01:00:00.000Z',
    duckdbVersion: 'fixture',
    sourceIds: [],
    artifacts: [],
    manifestSha256: OPERATOR_MANIFEST_SHA256,
  } as BoundedServingReleaseManifest;
  const releaseEvidence = {
    contractVersion: '1.0.0',
    releaseId: RELEASE_ID,
    runId: RUN_ID,
    county: 'Santa Clara',
    state: 'CA',
    generatedAt: '2026-07-19T01:00:00.000Z',
    runStatus: 'partial',
    releaseScope: 'partial_county',
    countyCompletionClaim: false,
    permitAuthorityCoverage: { covered: 1, total: 16 },
    capabilities: [],
    sourceStates: [],
    manifestSha256: OPERATOR_MANIFEST_SHA256,
    artifacts: [],
    catalogs: [],
    gates: {
      license: 'passed',
      manifest: 'passed',
      parquet: 'passed',
      cleanReopen: 'passed',
      publicRestrictedSegregation: 'passed',
      ownerBearingPublicValues: 0,
    },
    logicalOutputIdentitySha256: '7'.repeat(64),
    publicRestrictedValueOverlap: 0,
    publicRelationCount: 7,
    restrictedRelationCount: 7,
    portableReopen: 'passed',
    schemaOrder: 'passed',
    rowOrder: 'passed',
    immutableHashes: 'passed',
    budget: {
      peakBufferedRecords: 1,
      peakBufferedBytes: 1,
      peakRssBytes: 1,
      maxBufferedRecords: 1,
      maxBufferedBytes: 1,
      maxRssBytes: 1,
    },
    evidenceSha256: EVIDENCE_SHA256,
  } as BoundedServingReleaseEvidence;
  return Object.freeze({
    root,
    runRoot,
    manifestPath,
    policyPath,
    privateKeyPath,
    outputDirectory: join(root, 'public-output'),
    releaseDirectory,
    manifest,
    policy,
    releaseManifest,
    releaseEvidence,
    privateKeyPem,
  });
}

async function writeDescriptorArtifact(
  runRoot: string,
  runId: string,
  descriptor: Readonly<Record<string, unknown>>,
): Promise<PhaseArtifact> {
  const bytes = canonicalBytes(descriptor);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const logicalKey = `runs/${runId.slice('sc:run:'.length)}/bounded/build_marts/${sha256}.json`;
  const physicalLogicalKey = `objects/${createHash('sha256').update(logicalKey).digest('hex')}`;
  const store = new LocalArtifactStore({
    rootDirectory: join(runRoot, 'artifacts'),
    now: () => '2026-07-19T01:00:00.000Z',
  });
  const stored = await store.putImmutable({
    logicalKey: physicalLogicalKey,
    mediaType: 'application/json',
    body: bytes,
    expectedSha256: sha256,
    metadata: Object.freeze({
      oracleOriginalLogicalKey: logicalKey,
      processorKind: 'bounded_streaming_v2',
      phase: 'build_marts',
      rowBearing: 'false',
    }),
    ifAbsent: true,
  });
  return Object.freeze({
    phase: 'build_marts',
    logicalKey,
    uri: `file://oracle-artifact/${Buffer.from(logicalKey).toString('base64url')}`,
    mediaType: stored.mediaType,
    byteSize: stored.byteSize,
    sha256: stored.sha256,
  });
}

function commandOptions(harness: Harness) {
  return {
    runRoot: harness.runRoot,
    runManifestPath: harness.manifestPath,
    authorizationPolicyPath: harness.policyPath,
    privateKeyPath: harness.privateKeyPath,
    outputDirectory: harness.outputDirectory,
  };
}

function createObservation(): DependencyObservation {
  return { verifiedDirectories: [], approval: null };
}

function createDependencies(
  harness: Harness,
  observation: DependencyObservation = createObservation(),
  buildOverride?: (
    verifiedBundleDirectory: string,
    outputDirectoryPath: string,
    options: BoundedPublicServingClosureOptions,
  ) => Promise<PublicServingClosure>,
): PublicClosureCommandDependencies {
  return {
    repositoryRoot: REPOSITORY_ROOT,
    verifyRelease: (directory) => {
      observation.verifiedDirectories.push(directory);
      return Promise.resolve({
        manifest: harness.releaseManifest,
        evidence: harness.releaseEvidence,
      });
    },
    buildClosure:
      buildOverride ??
      (async (_verifiedBundleDirectory, outputDirectory, options) => {
        const input: BoundedPublicLicenseVerificationInput = Object.freeze({
          authorizationVersion: 'bounded-public-serving-license@1.0.0',
          trustRootSha256: options.licenseTrust.trustRootSha256,
          releaseId: RELEASE_ID,
          runId: RUN_ID,
          manifestSha256: FINAL_MANIFEST_SHA256,
          publicArtifactSha256s: Object.freeze(
            Array.from(
              { length: 7 },
              (_, index) => `relation-${index}:public/file-${index}:${index}`,
            ),
          ),
        });
        const approval = await options.licenseTrust.authorizePublicRelease(input);
        if (approval === null) throw new Error('fixture approval missing');
        observation.approval = approval;
        const publicKey = createPublicKey(options.licenseTrust.publicKeyPem);
        if (
          !verify(
            null,
            boundedPublicLicenseAuthorizationBytes(approval.authorization),
            publicKey,
            Buffer.from(approval.signatureBase64, 'base64'),
          )
        ) {
          throw new Error('fixture approval signature mismatch');
        }
        const publicDer = publicKey.export({ format: 'der', type: 'spki' });
        if (
          createHash('sha256').update(publicDer).digest('hex') !==
          options.licenseTrust.trustRootSha256
        ) {
          throw new Error('fixture trust-root mismatch');
        }
        await Promise.all(
          PUBLIC_CLOSURE_FILES.map(async (relativePath) => {
            const path = join(outputDirectory, relativePath);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, `safe fixture ${relativePath}\n`, 'utf8');
          }),
        );
        return Object.freeze({
          outputDirectory,
          manifestSha256: FINAL_MANIFEST_SHA256,
          manifestFileSha256: '6'.repeat(64),
          manifestCid: FINAL_MANIFEST_CID,
          publicArtifactCount: 7 as const,
        });
      }),
  };
}

async function replaceManifest(harness: Harness, manifest: unknown): Promise<void> {
  await writeFile(harness.manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
}

async function replacePolicy(harness: Harness, policy: unknown): Promise<void> {
  await writeFile(harness.policyPath, `${JSON.stringify(policy)}\n`, 'utf8');
}

async function linkDirectory(target: string, path: string): Promise<void> {
  await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
