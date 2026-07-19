import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { LocalArtifactStore } from '@oracle/artifacts/implementations/local-artifact-store';
import type { PhaseArtifact, PipelineRunManifest } from '../orchestration/types.js';
import { canonicalBytes } from '../orchestration/canonical-json.js';
import {
  verifyBoundedServingRelease,
  type BoundedServingReleaseEvidence,
  type BoundedServingReleaseManifest,
} from '@oracle/data-runtime/serving/bounded-release';
import {
  boundedPublicLicenseAuthorizationBytes,
  buildBoundedPublicServingClosure,
  type BoundedPublicLicenseVerificationInput,
  type PublicServingClosure,
} from '@oracle/data-runtime/serving/real-county-release';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RUN_ID_PATTERN = /^sc:run:[a-f0-9]{64}$/u;
const GENERATION_ID_PATTERN = /^sc:generation:[a-f0-9]{64}$/u;
const ORIGINAL_LOGICAL_KEY_METADATA = 'oracleOriginalLogicalKey';
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_POLICY_BYTES = 256 * 1024;
const MAX_KEY_BYTES = 64 * 1024;

export const PUBLIC_CLOSURE_FILES = Object.freeze([
  'public/data-dictionary.parquet',
  'public/field-coverage.parquet',
  'public/pipeline-runs.parquet',
  'public/property-evidence.parquet',
  'public/property-query.parquet',
  'public/relation-coverage.parquet',
  'public/source-coverage.parquet',
  'release-manifest.json',
  'serving-config.json',
] as const);

export type PublicClosureAuthorizationPolicy = Readonly<{
  expectedRunId: string;
  expectedGenerationId: string;
  expectedOperatorManifestSha256: string;
  expectedReleaseId: string;
  policyVersion: string;
  licenseSnapshotRefs: readonly string[];
}>;

export type PublicClosureCommandOptions = Readonly<{
  runRoot: string;
  runManifestPath: string;
  authorizationPolicyPath: string;
  privateKeyPath: string;
  outputDirectory: string;
}>;

export type PublicClosureSummary = Readonly<{
  outputPath: string;
  manifestSha256: string;
  manifestCid: string;
  publicArtifactCount: number;
}>;

export type PublicClosureCommandDependencies = Readonly<{
  repositoryRoot?: string;
  verifyRelease?: typeof verifyBoundedServingRelease;
  buildClosure?: typeof buildBoundedPublicServingClosure;
}>;

type BuildMartsDescriptor = Readonly<{
  generationId: string;
  releaseDirectory: string;
  manifestSha256: string;
  evidenceSha256: string;
  artifactCount: number;
  countyCompletionClaim: boolean;
}>;

export async function runPublicClosureCommand(
  options: PublicClosureCommandOptions,
  dependencies: PublicClosureCommandDependencies = {},
): Promise<PublicClosureSummary> {
  const runRoot = resolve(options.runRoot);
  const outputDirectory = resolve(options.outputDirectory);
  await assertRealDirectory(runRoot, 'run root');
  await assertAbsent(outputDirectory, 'output directory');
  assertDistinctPath(runRoot, outputDirectory, 'run root and output directory must be distinct');

  const repositoryRoot = resolve(dependencies.repositoryRoot ?? (await findRepositoryRoot()));
  const [manifestValue, policyValue] = await Promise.all([
    readJsonFile(options.runManifestPath, 'run manifest', MAX_MANIFEST_BYTES),
    readIgnoredJsonFile(
      repositoryRoot,
      options.authorizationPolicyPath,
      'authorization policy',
      MAX_POLICY_BYTES,
    ),
  ]);
  const runManifest = parseTerminalRunManifest(manifestValue);
  const policy = parseAuthorizationPolicy(policyValue);
  if (runManifest.runId !== policy.expectedRunId) {
    throw new PublicClosureValidationError(
      'Authorization policy runId does not match terminal run',
    );
  }

  const artifact = selectBuildMartsArtifact(runManifest);
  const descriptor = await readBuildMartsDescriptor(runRoot, runManifest.runId, artifact);
  assertDescriptorPolicyBindings(descriptor, policy);
  const releaseDirectory = resolveGenerationReleaseDirectory(
    runRoot,
    descriptor,
    policy.expectedReleaseId,
  );
  assertDistinctPath(
    releaseDirectory,
    outputDirectory,
    'operator release and output directory must be distinct',
  );
  await assertContainedReleaseTree(runRoot, releaseDirectory);

  const verified = await (dependencies.verifyRelease ?? verifyBoundedServingRelease)(
    releaseDirectory,
  );
  assertVerifiedReleaseBindings(
    runManifest,
    descriptor,
    policy,
    verified.manifest,
    verified.evidence,
  );

  const privateKey = await readIgnoredEd25519PrivateKey(repositoryRoot, options.privateKeyPath);
  const publicKey = createPublicKey(privateKey);
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
  const trustRootSha256 = createHash('sha256').update(publicKeyDer).digest('hex');
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

  const stagingDirectory = commandStagingDirectory(outputDirectory);
  await assertAbsent(stagingDirectory, 'command staging directory');
  let promoted = false;
  try {
    const closure = await (dependencies.buildClosure ?? buildBoundedPublicServingClosure)(
      releaseDirectory,
      stagingDirectory,
      {
        licenseTrust: {
          trustRootSha256,
          publicKeyPem,
          authorizePublicRelease: (input) =>
            Promise.resolve(
              signAuthorization(input, policy, trustRootSha256, privateKey, publicKey),
            ),
        },
      },
    );
    await assertExactPublicClosure(stagingDirectory, closure);
    await assertAbsent(outputDirectory, 'output directory');
    await atomicPromote(stagingDirectory, outputDirectory);
    promoted = true;

    return Object.freeze({
      outputPath: outputDirectory,
      manifestSha256: closure.manifestSha256,
      manifestCid: closure.manifestCid,
      publicArtifactCount: closure.publicArtifactCount,
    });
  } finally {
    if (!promoted) await cleanupCommandStaging(outputDirectory, stagingDirectory);
  }
}

function parseTerminalRunManifest(value: unknown): PipelineRunManifest {
  const record = requiredRecord(value, 'run manifest');
  if (
    record.schemaVersion !== '2.0.0' ||
    typeof record.runId !== 'string' ||
    !RUN_ID_PATTERN.test(record.runId) ||
    !Array.isArray(record.artifacts)
  ) {
    throw new PublicClosureValidationError('Run manifest is not a pipeline v2 terminal manifest');
  }
  if (record.status !== 'succeeded' && record.status !== 'partial') {
    throw new PublicClosureValidationError('Run manifest is nonterminal, failed, or aborted');
  }
  if (
    typeof record.completedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.completedAt)) ||
    new Date(record.completedAt).toISOString() !== record.completedAt
  ) {
    throw new PublicClosureValidationError('Run manifest completedAt is not canonical');
  }
  return record as PipelineRunManifest;
}

function parseAuthorizationPolicy(value: unknown): PublicClosureAuthorizationPolicy {
  const record = requiredRecord(value, 'authorization policy');
  const expectedKeys = [
    'expectedGenerationId',
    'expectedOperatorManifestSha256',
    'expectedReleaseId',
    'expectedRunId',
    'licenseSnapshotRefs',
    'policyVersion',
  ];
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expectedKeys)) {
    throw new PublicClosureValidationError('Authorization policy fields are not exact');
  }
  if (
    typeof record.expectedRunId !== 'string' ||
    !RUN_ID_PATTERN.test(record.expectedRunId) ||
    typeof record.expectedGenerationId !== 'string' ||
    !GENERATION_ID_PATTERN.test(record.expectedGenerationId) ||
    typeof record.expectedOperatorManifestSha256 !== 'string' ||
    !SHA256_PATTERN.test(record.expectedOperatorManifestSha256) ||
    typeof record.expectedReleaseId !== 'string' ||
    record.expectedReleaseId.trim().length === 0 ||
    typeof record.policyVersion !== 'string' ||
    record.policyVersion.trim().length === 0 ||
    !isNonEmptyUniqueStrings(record.licenseSnapshotRefs)
  ) {
    throw new PublicClosureValidationError('Authorization policy is invalid');
  }
  const policy: PublicClosureAuthorizationPolicy = Object.freeze({
    expectedRunId: record.expectedRunId,
    expectedGenerationId: record.expectedGenerationId,
    expectedOperatorManifestSha256: record.expectedOperatorManifestSha256,
    expectedReleaseId: record.expectedReleaseId,
    policyVersion: record.policyVersion,
    licenseSnapshotRefs: Object.freeze([...record.licenseSnapshotRefs]),
  });
  return policy;
}

function selectBuildMartsArtifact(manifest: PipelineRunManifest): PhaseArtifact {
  const candidates = manifest.artifacts.filter(
    (candidate): candidate is PhaseArtifact =>
      isRecord(candidate) && candidate.phase === 'build_marts',
  );
  if (candidates.length !== 1) {
    throw new PublicClosureValidationError(
      'Terminal run manifest must contain exactly one build_marts descriptor',
    );
  }
  const artifact = candidates[0];
  if (
    artifact === undefined ||
    typeof artifact.logicalKey !== 'string' ||
    typeof artifact.uri !== 'string' ||
    artifact.mediaType !== 'application/json' ||
    !Number.isSafeInteger(artifact.byteSize) ||
    artifact.byteSize < 2 ||
    artifact.byteSize > 64 * 1024 ||
    !SHA256_PATTERN.test(artifact.sha256)
  ) {
    throw new PublicClosureValidationError('build_marts descriptor identity is invalid');
  }
  const expectedLogicalKey = `runs/${manifest.runId.slice('sc:run:'.length)}/bounded/build_marts/${artifact.sha256}.json`;
  const expectedUri = `file://oracle-artifact/${Buffer.from(expectedLogicalKey).toString('base64url')}`;
  if (artifact.logicalKey !== expectedLogicalKey || artifact.uri !== expectedUri) {
    throw new PublicClosureValidationError('build_marts descriptor is not bound to this run');
  }
  return artifact;
}

async function readBuildMartsDescriptor(
  runRoot: string,
  runId: string,
  artifact: PhaseArtifact,
): Promise<BuildMartsDescriptor> {
  const physicalLogicalKey = `objects/${createHash('sha256').update(artifact.logicalKey).digest('hex')}`;
  const artifactRoot = join(runRoot, 'artifacts');
  await assertArtifactRecordPaths(runRoot, artifactRoot, physicalLogicalKey);
  const store = new LocalArtifactStore({
    rootDirectory: artifactRoot,
    now: () => new Date(0).toISOString(),
  });
  const stored = await store.headByLogicalKey(physicalLogicalKey);
  if (
    stored?.logicalKey !== physicalLogicalKey ||
    stored.mediaType !== artifact.mediaType ||
    stored.byteSize !== artifact.byteSize ||
    stored.sha256 !== artifact.sha256 ||
    stored.metadata[ORIGINAL_LOGICAL_KEY_METADATA] !== artifact.logicalKey ||
    stored.metadata.processorKind !== 'bounded_streaming_v2' ||
    stored.metadata.phase !== 'build_marts' ||
    stored.metadata.rowBearing !== 'false'
  ) {
    throw new PublicClosureValidationError('build_marts descriptor integrity mismatch');
  }
  const bytes = await collectBoundedBytes(store.read(stored.uri), artifact.byteSize);
  if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
    throw new PublicClosureValidationError('build_marts descriptor body hash mismatch');
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new PublicClosureValidationError('build_marts descriptor is not valid UTF-8 JSON');
  }
  if (!Buffer.from(canonicalBytes(value)).equals(Buffer.from(bytes))) {
    throw new PublicClosureValidationError('build_marts descriptor is not canonical JSON');
  }
  const descriptor = requiredRecord(value, 'build_marts descriptor');
  if (
    typeof descriptor.generationId !== 'string' ||
    !GENERATION_ID_PATTERN.test(descriptor.generationId) ||
    typeof descriptor.releaseDirectory !== 'string' ||
    descriptor.releaseDirectory.length === 0 ||
    typeof descriptor.manifestSha256 !== 'string' ||
    !SHA256_PATTERN.test(descriptor.manifestSha256) ||
    typeof descriptor.evidenceSha256 !== 'string' ||
    !SHA256_PATTERN.test(descriptor.evidenceSha256) ||
    !Number.isSafeInteger(descriptor.artifactCount) ||
    descriptor.artifactCount !== 14 ||
    descriptor.countyCompletionClaim !== false
  ) {
    throw new PublicClosureValidationError('build_marts descriptor contract is invalid');
  }
  if (!artifact.logicalKey.startsWith(`runs/${runId.slice('sc:run:'.length)}/`)) {
    throw new PublicClosureValidationError('build_marts descriptor run binding changed');
  }
  return descriptor as BuildMartsDescriptor;
}

function assertDescriptorPolicyBindings(
  descriptor: BuildMartsDescriptor,
  policy: PublicClosureAuthorizationPolicy,
): void {
  if (descriptor.generationId !== policy.expectedGenerationId) {
    throw new PublicClosureValidationError('Authorization policy generationId mismatch');
  }
  if (descriptor.manifestSha256 !== policy.expectedOperatorManifestSha256) {
    throw new PublicClosureValidationError('Authorization policy operator manifest mismatch');
  }
}

function resolveGenerationReleaseDirectory(
  runRoot: string,
  descriptor: BuildMartsDescriptor,
  expectedReleaseId: string,
): string {
  if (isAbsolute(descriptor.releaseDirectory) || descriptor.releaseDirectory.includes('\\')) {
    throw new PublicClosureValidationError('Release directory must be a portable relative path');
  }
  const releaseDirectory = resolve(runRoot, ...descriptor.releaseDirectory.split('/'));
  if (!isContainedPath(runRoot, releaseDirectory)) {
    throw new PublicClosureValidationError('Release directory escapes run root');
  }
  const generationHash = descriptor.generationId.slice('sc:generation:'.length);
  const expectedDirectory = `releases/${generationHash.slice(0, 32)}/${expectedReleaseId}`;
  if (descriptor.releaseDirectory !== expectedDirectory) {
    throw new PublicClosureValidationError('Release directory is not generation-scoped');
  }
  return releaseDirectory;
}

async function assertArtifactRecordPaths(
  runRoot: string,
  artifactRoot: string,
  physicalLogicalKey: string,
): Promise<void> {
  const objectsRoot = join(artifactRoot, 'objects');
  const recordDirectory = resolve(artifactRoot, ...physicalLogicalKey.split('/'));
  if (!isContainedPath(artifactRoot, recordDirectory)) {
    throw new PublicClosureValidationError('Artifact record path escapes artifact root');
  }
  await assertContainedDirectory(runRoot, artifactRoot, 'artifact root');
  await assertContainedDirectory(runRoot, objectsRoot, 'artifact objects root');
  await assertContainedDirectory(runRoot, recordDirectory, 'artifact record directory');
  await assertContainedRegularFile(
    runRoot,
    join(recordDirectory, 'record.json'),
    'artifact record',
  );
  await assertContainedRegularFile(runRoot, join(recordDirectory, 'body'), 'artifact body');
}

async function assertContainedReleaseTree(
  runRoot: string,
  releaseDirectory: string,
): Promise<void> {
  const relation = relative(runRoot, releaseDirectory);
  if (!isContainedRelation(relation)) {
    throw new PublicClosureValidationError('Operator release escapes run root');
  }
  let cursor = runRoot;
  for (const segment of relation.split(sep)) {
    cursor = join(cursor, segment);
    await assertContainedDirectory(runRoot, cursor, 'operator release directory');
  }

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new PublicClosureValidationError('Operator release must not contain symlinks');
      }
      if (entry.isDirectory()) {
        await assertContainedDirectory(runRoot, path, 'operator release directory');
        await visit(path);
      } else if (entry.isFile()) {
        await assertContainedRegularFile(runRoot, path, 'operator release file');
      } else {
        throw new PublicClosureValidationError(
          'Operator release contains a non-regular filesystem entry',
        );
      }
    }
  }
  await visit(releaseDirectory);
}

async function assertContainedDirectory(root: string, path: string, label: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new PublicClosureValidationError(`${label} must be a real directory`);
  }
  await assertPhysicalContainment(root, path, label);
}

async function assertContainedRegularFile(
  root: string,
  path: string,
  label: string,
): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new PublicClosureValidationError(`${label} must be a regular file`);
  }
  await assertPhysicalContainment(root, path, label);
}

async function assertPhysicalContainment(root: string, path: string, label: string): Promise<void> {
  const [physicalRoot, physicalPath] = await Promise.all([realpath(root), realpath(path)]);
  if (!isContainedPath(physicalRoot, physicalPath)) {
    throw new PublicClosureValidationError(`${label} physically escapes run root`);
  }
}

function assertVerifiedReleaseBindings(
  runManifest: PipelineRunManifest,
  descriptor: BuildMartsDescriptor,
  policy: PublicClosureAuthorizationPolicy,
  manifest: BoundedServingReleaseManifest,
  evidence: BoundedServingReleaseEvidence,
): void {
  const generationHash = descriptor.generationId.slice('sc:generation:'.length);
  const expectedRelativeDirectory = `releases/${generationHash.slice(0, 32)}/${manifest.releaseId}`;
  if (
    descriptor.releaseDirectory !== expectedRelativeDirectory ||
    manifest.runId !== runManifest.runId ||
    manifest.runId !== policy.expectedRunId ||
    manifest.releaseId !== policy.expectedReleaseId ||
    manifest.manifestSha256 !== descriptor.manifestSha256 ||
    manifest.manifestSha256 !== policy.expectedOperatorManifestSha256 ||
    evidence.runId !== manifest.runId ||
    evidence.releaseId !== manifest.releaseId ||
    evidence.manifestSha256 !== manifest.manifestSha256 ||
    evidence.evidenceSha256 !== descriptor.evidenceSha256
  ) {
    throw new PublicClosureValidationError('Descriptor, policy, manifest, and evidence are mixed');
  }
  const evidenceRecord = evidence as unknown as Readonly<Record<string, unknown>>;
  const gates = evidence.gates as unknown as Readonly<Record<string, unknown>>;
  if (
    evidence.releaseScope !== 'partial_county' ||
    gates.license !== 'passed' ||
    gates.manifest !== 'passed' ||
    gates.parquet !== 'passed' ||
    gates.cleanReopen !== 'passed' ||
    gates.publicRestrictedSegregation !== 'passed' ||
    gates.ownerBearingPublicValues !== 0 ||
    evidenceRecord.publicRestrictedValueOverlap !== 0 ||
    evidenceRecord.portableReopen !== 'passed' ||
    evidenceRecord.schemaOrder !== 'passed' ||
    evidenceRecord.rowOrder !== 'passed' ||
    evidenceRecord.immutableHashes !== 'passed'
  ) {
    throw new PublicClosureValidationError('Operator release privacy or parity gates did not pass');
  }
}

function signAuthorization(
  input: BoundedPublicLicenseVerificationInput,
  policy: PublicClosureAuthorizationPolicy,
  trustRootSha256: string,
  privateKey: KeyObject,
  publicKey: KeyObject,
) {
  if (
    input.trustRootSha256 !== trustRootSha256 ||
    input.runId !== policy.expectedRunId ||
    input.releaseId !== policy.expectedReleaseId
  ) {
    throw new PublicClosureValidationError(
      'License authorization request changed after verification',
    );
  }
  const authorization = Object.freeze({
    ...input,
    publicArtifactSha256s: Object.freeze([...input.publicArtifactSha256s]),
    decision: 'allowed_public' as const,
    policyVersion: policy.policyVersion,
    licenseSnapshotRefs: policy.licenseSnapshotRefs,
  });
  const authorizationBytes = boundedPublicLicenseAuthorizationBytes(authorization);
  const signature = sign(null, authorizationBytes, privateKey);
  if (signature.byteLength !== 64 || !verify(null, authorizationBytes, publicKey, signature)) {
    throw new PublicClosureValidationError('Generated license authorization signature is invalid');
  }
  return Object.freeze({
    authorization,
    signatureBase64: signature.toString('base64'),
  });
}

async function readIgnoredEd25519PrivateKey(
  repositoryRoot: string,
  path: string,
): Promise<KeyObject> {
  const resolvedPath = resolve(path);
  await assertIgnoredUntrackedRegularFile(repositoryRoot, resolvedPath, 'private key');
  const bytes = await readBoundedFile(resolvedPath, 'private key', MAX_KEY_BYTES);
  const decodedPem = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const pem = decodedPem.replaceAll('\r\n', '\n');
  if (pem.includes('\r')) {
    throw new PublicClosureValidationError('Private key must be an Ed25519 PKCS8 PEM');
  }
  const trimmed = pem.trim();
  if (
    !trimmed.startsWith('-----BEGIN PRIVATE KEY-----\n') ||
    !trimmed.endsWith('\n-----END PRIVATE KEY-----') ||
    trimmed.includes('-----BEGIN ENCRYPTED PRIVATE KEY-----') ||
    trimmed.indexOf('-----BEGIN PRIVATE KEY-----') !==
      trimmed.lastIndexOf('-----BEGIN PRIVATE KEY-----')
  ) {
    throw new PublicClosureValidationError('Private key must be an Ed25519 PKCS8 PEM');
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: pem, format: 'pem', type: 'pkcs8' });
  } catch {
    throw new PublicClosureValidationError('Private key must be an Ed25519 PKCS8 PEM');
  }
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new PublicClosureValidationError('Private key must be Ed25519');
  }
  return privateKey;
}

async function readIgnoredJsonFile(
  repositoryRoot: string,
  path: string,
  label: string,
  maximumBytes: number,
): Promise<unknown> {
  const resolvedPath = resolve(path);
  await assertIgnoredUntrackedRegularFile(repositoryRoot, resolvedPath, label);
  return parseJson(await readBoundedFile(resolvedPath, label, maximumBytes), label);
}

async function readJsonFile(path: string, label: string, maximumBytes: number): Promise<unknown> {
  const resolvedPath = resolve(path);
  await assertRegularFile(resolvedPath, label);
  return parseJson(await readBoundedFile(resolvedPath, label, maximumBytes), label);
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new PublicClosureValidationError(`${label} is not valid UTF-8 JSON`);
  }
}

async function readBoundedFile(
  path: string,
  label: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 1 ||
    before.size > maximumBytes
  ) {
    throw new PublicClosureValidationError(`${label} is not a bounded regular file`);
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    bytes.byteLength !== before.size
  ) {
    throw new PublicClosureValidationError(`${label} changed while being read`);
  }
  return bytes;
}

async function assertIgnoredUntrackedRegularFile(
  repositoryRoot: string,
  path: string,
  label: string,
): Promise<void> {
  const relation = relative(repositoryRoot, path);
  if (!isContainedRelation(relation)) {
    throw new PublicClosureValidationError(`${label} must be inside the repository`);
  }
  await assertNoSymlinkSegments(repositoryRoot, relation, label);
  await assertRegularFile(path, label);
  const gitPath = relation.split(sep).join('/');
  if ((await gitExitCode(repositoryRoot, ['ls-files', '--error-unmatch', '--', gitPath])) === 0) {
    throw new PublicClosureValidationError(`${label} must not be tracked by Git`);
  }
  if ((await gitExitCode(repositoryRoot, ['check-ignore', '--quiet', '--', gitPath])) !== 0) {
    throw new PublicClosureValidationError(`${label} must be explicitly ignored by Git`);
  }
}

async function assertNoSymlinkSegments(
  repositoryRoot: string,
  relation: string,
  label: string,
): Promise<void> {
  let cursor = repositoryRoot;
  for (const segment of relation.split(sep)) {
    cursor = join(cursor, segment);
    if ((await lstat(cursor)).isSymbolicLink()) {
      throw new PublicClosureValidationError(`${label} path must not contain symlinks`);
    }
  }
}

async function assertRealDirectory(path: string, label: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new PublicClosureValidationError(`${label} must be a real directory`);
  }
  if (resolve(await realpath(path)) !== resolve(path)) {
    throw new PublicClosureValidationError(`${label} must not traverse a symlink`);
  }
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new PublicClosureValidationError(`${label} must be a regular file`);
  }
}

async function assertAbsent(path: string, label: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  throw new PublicClosureValidationError(`${label} must not exist`);
}

async function collectBoundedBytes(
  stream: AsyncIterable<Uint8Array>,
  expectedBytes: number,
): Promise<Uint8Array> {
  const output = new Uint8Array(expectedBytes);
  let offset = 0;
  for await (const chunk of stream) {
    if (offset + chunk.byteLength > output.byteLength) {
      throw new PublicClosureValidationError('Descriptor exceeded its declared byte size');
    }
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== expectedBytes) {
    throw new PublicClosureValidationError('Descriptor ended before its declared byte size');
  }
  return output;
}

function commandStagingDirectory(outputDirectory: string): string {
  return join(
    dirname(outputDirectory),
    `.${basename(outputDirectory)}.public-closure-${randomUUID()}`,
  );
}

async function cleanupCommandStaging(
  outputDirectory: string,
  stagingDirectory: string,
): Promise<void> {
  const expectedParent = dirname(outputDirectory);
  const stagingName = basename(stagingDirectory);
  if (
    dirname(stagingDirectory) !== expectedParent ||
    !stagingName.startsWith(`.${basename(outputDirectory)}.public-closure-`)
  ) {
    throw new PublicClosureValidationError('Refusing to clean an invalid staging path');
  }
  await rm(stagingDirectory, { recursive: true, force: true });
}

async function atomicPromote(stagingDirectory: string, outputDirectory: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await assertAbsent(outputDirectory, 'output directory');
      await rename(stagingDirectory, outputDirectory);
      return;
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        attempt >= 4 ||
        (!hasErrorCode(error, 'EPERM') && !hasErrorCode(error, 'EBUSY'))
      ) {
        throw error;
      }
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25 * (attempt + 1)));
    }
  }
}

async function assertExactPublicClosure(
  outputDirectory: string,
  closure: PublicServingClosure,
): Promise<void> {
  await assertRealDirectory(outputDirectory, 'public closure staging directory');
  const closureRecord = closure as unknown as Readonly<Record<string, unknown>>;
  if (
    resolve(closure.outputDirectory) !== outputDirectory ||
    closureRecord.publicArtifactCount !== 7 ||
    !SHA256_PATTERN.test(closure.manifestSha256) ||
    !/^bafkrei[a-z2-7]{52}$/u.test(closure.manifestCid)
  ) {
    throw new PublicClosureValidationError('Public closure result identity is invalid');
  }
  const files = await recursiveFiles(outputDirectory);
  if (JSON.stringify(files) !== JSON.stringify(PUBLIC_CLOSURE_FILES)) {
    throw new PublicClosureValidationError('Public closure does not contain the exact nine files');
  }
}

async function recursiveFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new PublicClosureValidationError('Public closure must not contain symlinks');
      }
      if (entry.isDirectory()) await visit(path, relativePath);
      else if (entry.isFile()) files.push(relativePath);
      else throw new PublicClosureValidationError('Public closure contains a non-file entry');
    }
  }
  await visit(root, '');
  return Object.freeze(files.sort());
}

async function findRepositoryRoot(): Promise<string> {
  const child = spawn('git', ['-C', process.cwd(), 'rev-parse', '--show-toplevel'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  const code = await new Promise<number>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode) => resolveExit(exitCode ?? 1));
  });
  if (code !== 0) throw new PublicClosureValidationError('Unable to locate Git repository root');
  const root = Buffer.concat(chunks).toString('utf8').trim();
  if (root.length === 0) throw new PublicClosureValidationError('Git repository root is empty');
  return root;
}

async function gitExitCode(repositoryRoot: string, arguments_: readonly string[]): Promise<number> {
  const child = spawn('git', ['-C', repositoryRoot, ...arguments_], { stdio: 'ignore' });
  return new Promise<number>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolveExit(code ?? 1));
  });
}

function requiredRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new PublicClosureValidationError(`${label} must be a JSON object`);
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyUniqueStrings(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  const values: readonly unknown[] = value;
  return (
    values.length > 0 &&
    values.every((item) => typeof item === 'string' && item.trim().length > 0) &&
    new Set(values).size === values.length
  );
}

function assertDistinctPath(left: string, right: string, message: string): void {
  if (resolve(left) === resolve(right)) throw new PublicClosureValidationError(message);
}

function isContainedPath(root: string, candidate: string): boolean {
  return isContainedRelation(relative(resolve(root), resolve(candidate)));
}

function isContainedRelation(relation: string): boolean {
  return (
    relation.length > 0 &&
    relation !== '..' &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

function isNotFound(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT');
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export class PublicClosureValidationError extends Error {
  public readonly code = 'PUBLIC_CLOSURE_VALIDATION';

  public constructor(message: string) {
    super(message);
    this.name = 'PublicClosureValidationError';
  }
}
