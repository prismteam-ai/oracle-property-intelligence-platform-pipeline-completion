import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

import {
  buildPortableServingRelease,
  type BuiltServingArtifact,
  type PortableServingBuildInput,
} from './builder.js';
import {
  PUBLIC_PROHIBITED_COLUMN_PATTERN,
  SERVING_RELATIONS,
  type ServingRelationName,
  type ServingVisibility,
} from './schema.js';
import { verifyServingArtifacts } from './verifier.js';

export const REAL_COUNTY_CAPABILITIES = Object.freeze([
  'santa_clara_parcels',
  'san_jose_permits',
  'palo_alto_year_built',
  'vta_gtfs',
  'caltrain_gtfs',
  'transit_511_fallback',
  'osm_pedestrian_graph',
  'noaa_shoreline',
  'usgs_hydrography',
  'usgs_elevation',
  'overture_starbucks',
  'cslb_contractors',
  'ca_sos_businesses',
  'ownership_transfers',
  'santa_clara_fbn',
] as const);

export type RealCountyCapability = (typeof REAL_COUNTY_CAPABILITIES)[number];
export type CapabilityState = 'succeeded' | 'partial' | 'blocked' | 'failed' | 'not_configured';
export type ReleaseScope = 'evaluator_evidence' | 'pilot' | 'partial_county' | 'full_county';
export type SourceTerminalState = 'succeeded' | 'partial' | 'blocked' | 'failed';
export type PermissionState = 'allowed' | 'pending' | 'restricted' | 'prohibited';

export type SourceSnapshotGate = Readonly<{
  sourceId: string;
  snapshotId: string;
  sourceSha256: string;
  schemaSha256: string;
  asOf: string | null;
  terminalState: SourceTerminalState;
  acquisitionPermission: 'allowed' | 'blocked';
  privateUsePermission: PermissionState;
  publicProjectionPermission: PermissionState;
  capabilityMetadataPublic: boolean;
  containsOwnerData: boolean;
  limitations: readonly string[];
}>;

export type CapabilityReleaseState = Readonly<{
  capability: RealCountyCapability;
  state: CapabilityState;
  sourceIds: readonly string[];
  limitations: readonly string[];
}>;

export type ArtifactContentClass =
  'source_data' | 'derived_data' | 'capability_metadata' | 'schema_metadata';

export type ArtifactSourceReference = Readonly<{
  sourceId: string;
  snapshotId: string;
  role: 'direct' | 'derived';
}>;

export type ArtifactReleasePolicy = Readonly<{
  visibility: ServingVisibility;
  relation: Exclude<ServingRelationName, 'data_dictionary'>;
  contentClass: ArtifactContentClass;
  sourceLineage: readonly ArtifactSourceReference[];
  limitations: readonly string[];
}>;

export type RealCountyReleaseInput = Readonly<{
  build: Omit<PortableServingBuildInput, 'outputDirectory'>;
  outputDirectory: string;
  releaseScope: ReleaseScope;
  permitAuthoritiesCovered: number;
  permitAuthoritiesTotal: 16;
  sourceSnapshots: readonly SourceSnapshotGate[];
  capabilities: readonly CapabilityReleaseState[];
  artifactPolicies: readonly ArtifactReleasePolicy[];
}>;

type ReleaseArtifactSource = Readonly<{
  sourceId: string;
  snapshotId: string;
  sourceSha256: string;
  schemaSha256: string;
  asOf: string | null;
  role: 'direct' | 'derived';
}>;

type ReleaseArtifact = BuiltServingArtifact &
  Readonly<{
    grain: string;
    sourceLineage: readonly ReleaseArtifactSource[];
    limitations: readonly string[];
  }>;

export type RealCountyPortableManifest = Readonly<{
  contractVersion: '1.0.0';
  releaseId: string;
  runId: string;
  county: 'Santa Clara';
  state: 'CA';
  generatedAt: string;
  duckdbVersion: string;
  sourceIds: readonly string[];
  artifacts: readonly ReleaseArtifact[];
  manifestSha256: string;
}>;

type CatalogVerification = Readonly<{
  visibility: ServingVisibility;
  relativePath: string;
  byteSize: number;
  sha256: string;
  relationCount: number;
  rowCount: number;
}>;

export type RealCountyReleaseEvidence = Readonly<{
  contractVersion: '1.0.0';
  releaseId: string;
  runId: string;
  county: 'Santa Clara';
  state: 'CA';
  generatedAt: string;
  releaseScope: ReleaseScope;
  countyCompletionClaim: boolean;
  permitAuthorityCoverage: Readonly<{ covered: number; total: 16 }>;
  manifestSha256: string;
  manifestFileSha256: string;
  capabilities: readonly CapabilityReleaseState[];
  artifacts: readonly Readonly<{
    relation: ServingRelationName;
    visibility: ServingVisibility;
    relativePath: string;
    rowCount: number;
    byteSize: number;
    sha256: string;
  }>[];
  catalogs: readonly CatalogVerification[];
  gates: Readonly<{
    license: 'passed';
    manifest: 'passed';
    parquet: 'passed';
    cleanReopen: 'passed';
    publicRestrictedSegregation: 'passed';
    ownerBearingPublicValues: 0;
    restrictedSensitiveValueHashes: number;
  }>;
  evidenceSha256: string;
}>;

export type RealCountyReleaseResult = Readonly<{
  outputDirectory: string;
  manifest: RealCountyPortableManifest;
  evidence: RealCountyReleaseEvidence;
}>;

const MANIFEST_FILE = 'release-manifest.json';
const EVIDENCE_FILE = 'release-evidence.json';
const OPTIONAL_FULL_CAPABILITIES = new Set<RealCountyCapability>(['transit_511_fallback']);

export async function buildRealCountyReleaseFromPipelineArtifact(
  pipelineArtifactPath: string,
  outputDirectory: string,
): Promise<RealCountyReleaseResult> {
  const document = JSON.parse(await readFile(resolve(pipelineArtifactPath), 'utf8')) as unknown;
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new TypeError('Pipeline mart artifact must be a JSON object');
  }
  const record = document as Readonly<Record<string, unknown>>;
  if (record.format !== 'oracle-real-county-portable-release-input-v1') {
    throw new TypeError('Pipeline mart artifact has an unsupported format');
  }
  if (
    record.portableReleaseInput === null ||
    typeof record.portableReleaseInput !== 'object' ||
    Array.isArray(record.portableReleaseInput)
  ) {
    throw new TypeError('Pipeline mart artifact has no portableReleaseInput');
  }
  return buildRealCountyReleaseBundle({
    ...(record.portableReleaseInput as Omit<RealCountyReleaseInput, 'outputDirectory'>),
    outputDirectory,
  });
}

export async function buildRealCountyReleaseBundle(
  input: RealCountyReleaseInput,
): Promise<RealCountyReleaseResult> {
  const validated = validateReleaseInput(input);
  const outputDirectory = resolve(validated.outputDirectory);
  await assertPathAbsent(outputDirectory);
  await mkdir(dirname(outputDirectory), { recursive: true });
  const staging = await mkdtemp(
    join(dirname(outputDirectory), `.${basename(outputDirectory)}.staging-`),
  );
  try {
    const build = await buildPortableServingRelease({
      ...validated.build,
      outputDirectory: staging,
    });
    const artifacts = attachReleasePolicies(validated, build.artifacts);
    const manifest = createManifest(build, artifacts);
    const manifestPath = join(staging, MANIFEST_FILE);
    await writeCanonicalCreateOnly(manifestPath, manifest);

    await verifyServingArtifacts(staging, build.artifacts);
    const privacy = await verifyPublicRestrictedPrivacy(staging, build.artifacts);
    if (requiresOwnerComparison(validated) && privacy.restrictedSensitiveValueHashes === 0) {
      throw new ReleasePrivacyError(
        'Owner-bearing public derivation has no restricted sensitive-value comparison set',
      );
    }
    if (privacy.ownerBearingPublicValues !== 0) {
      throw new ReleasePrivacyError(
        `Public release intersects ${privacy.ownerBearingPublicValues} restricted value hashes`,
      );
    }

    const catalogs: CatalogVerification[] = [];
    for (const visibility of ['public', 'restricted'] as const) {
      catalogs.push(await buildAndVerifyCatalog(staging, build.artifacts, visibility));
    }

    const manifestBytes = await readFile(manifestPath);
    const evidence = createEvidence(validated, manifest, manifestBytes, catalogs, privacy);
    await writeCanonicalCreateOnly(join(staging, EVIDENCE_FILE), evidence);
    await verifyStagedBundle(staging, manifest, evidence);
    await rename(staging, outputDirectory);
    return Object.freeze({ outputDirectory, manifest, evidence });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyRealCountyReleaseBundle(outputDirectory: string): Promise<
  Readonly<{
    releaseId: string;
    runId: string;
    releaseScope: ReleaseScope;
    manifestSha256: string;
    evidenceSha256: string;
    publicArtifactCount: number;
    restrictedArtifactCount: number;
    ownerBearingPublicValues: 0;
  }>
> {
  const root = resolve(outputDirectory);
  const manifest = await readCanonicalDocument<RealCountyPortableManifest>(
    join(root, MANIFEST_FILE),
  );
  verifySelfHash(manifest, 'manifestSha256');
  const evidence = await readCanonicalDocument<RealCountyReleaseEvidence>(
    join(root, EVIDENCE_FILE),
  );
  verifySelfHash(evidence, 'evidenceSha256');
  await verifyStagedBundle(root, manifest, evidence);
  const artifacts = manifest.artifacts.map(toBuiltArtifact);
  const privacy = await verifyPublicRestrictedPrivacy(root, artifacts);
  if (privacy.ownerBearingPublicValues !== 0) {
    throw new ReleasePrivacyError('Public release contains owner-bearing restricted values');
  }
  for (const catalog of evidence.catalogs) {
    await verifyCatalogReopen(root, artifacts, catalog);
  }
  return Object.freeze({
    releaseId: manifest.releaseId,
    runId: manifest.runId,
    releaseScope: evidence.releaseScope,
    manifestSha256: manifest.manifestSha256,
    evidenceSha256: evidence.evidenceSha256,
    publicArtifactCount: manifest.artifacts.filter(({ visibility }) => visibility === 'public')
      .length,
    restrictedArtifactCount: manifest.artifacts.filter(
      ({ visibility }) => visibility === 'restricted',
    ).length,
    ownerBearingPublicValues: 0,
  });
}

function validateReleaseInput(input: RealCountyReleaseInput): RealCountyReleaseInput {
  if (input.outputDirectory.trim().length === 0) throw new TypeError('outputDirectory is required');
  if (
    !Number.isSafeInteger(input.permitAuthoritiesCovered) ||
    input.permitAuthoritiesCovered < 0 ||
    input.permitAuthoritiesCovered > input.permitAuthoritiesTotal
  ) {
    throw new ReleaseCompletenessError('Permit authority coverage is invalid');
  }
  const profileVisibilities = input.build.profiles.map(({ visibility }) => visibility).sort();
  if (profileVisibilities.join(',') !== 'public,restricted') {
    throw new ReleaseSegregationError(
      'Release requires exactly one public and one restricted profile',
    );
  }
  const capabilities = new Map(input.capabilities.map((item) => [item.capability, item]));
  if (
    input.capabilities.length !== REAL_COUNTY_CAPABILITIES.length ||
    capabilities.size !== REAL_COUNTY_CAPABILITIES.length ||
    REAL_COUNTY_CAPABILITIES.some((name) => !capabilities.has(name))
  ) {
    throw new ReleaseCompletenessError('Every real-county capability must have one explicit state');
  }
  for (const capability of input.capabilities) {
    assertUniqueNonEmpty(
      capability.sourceIds,
      `${capability.capability}.sourceIds`,
      capability.state !== 'not_configured',
    );
    assertUniqueNonEmpty(capability.limitations, `${capability.capability}.limitations`, false);
    if (capability.state !== 'succeeded' && capability.limitations.length === 0) {
      throw new ReleaseCompletenessError(
        `${capability.capability} ${capability.state} state requires a limitation`,
      );
    }
  }
  if (input.releaseScope === 'full_county') {
    const incomplete = input.capabilities.filter(
      ({ capability, state }) =>
        state !== 'succeeded' &&
        !(OPTIONAL_FULL_CAPABILITIES.has(capability) && state === 'not_configured'),
    );
    const sourceIncomplete = input.sourceSnapshots.some(
      ({ terminalState }) => terminalState !== 'succeeded',
    );
    const runRows = input.build.profiles.flatMap(({ relations }) =>
      relations.pipeline_runs === undefined ? [] : [...relations.pipeline_runs],
    );
    const fullRunSucceeded = runRows.some(
      (row) => row.run_id === input.build.runId && row.status === 'succeeded',
    );
    if (
      incomplete.length > 0 ||
      sourceIncomplete ||
      input.permitAuthoritiesCovered !== 16 ||
      !fullRunSucceeded
    ) {
      throw new ReleaseCompletenessError(
        'full_county requires a succeeded run, every source/capability, and all 16 permit authorities',
      );
    }
  }

  const snapshots = new Map<string, SourceSnapshotGate>();
  for (const snapshot of input.sourceSnapshots) {
    const key = snapshotKey(snapshot);
    if (snapshots.has(key)) throw new TypeError(`Duplicate source snapshot gate: ${key}`);
    assertSha256(snapshot.sourceSha256, `${key}.sourceSha256`);
    assertSha256(snapshot.schemaSha256, `${key}.schemaSha256`);
    if (snapshot.asOf !== null) assertInstant(snapshot.asOf, `${key}.asOf`);
    assertUniqueNonEmpty(snapshot.limitations, `${key}.limitations`, false);
    snapshots.set(key, snapshot);
  }
  const expectedSourceIds = [
    ...new Set(input.sourceSnapshots.map(({ sourceId }) => sourceId)),
  ].sort();
  if (stableJson(expectedSourceIds) !== stableJson([...new Set(input.build.sourceIds)].sort())) {
    throw new TypeError('Build sourceIds must exactly match source snapshot gates');
  }
  const capabilitySourceIds = new Set(input.capabilities.flatMap(({ sourceIds }) => sourceIds));
  if (stableJson([...capabilitySourceIds].sort()) !== stableJson(expectedSourceIds)) {
    throw new TypeError('Capability states must exactly cover the declared source IDs');
  }
  for (const capability of input.capabilities) {
    const related = input.sourceSnapshots.filter(({ sourceId }) =>
      capability.sourceIds.includes(sourceId),
    );
    if (
      capability.state === 'succeeded' &&
      !related.some(({ terminalState }) => terminalState === 'succeeded')
    ) {
      throw new ReleaseCompletenessError(
        `${capability.capability} cannot succeed without a succeeded source snapshot`,
      );
    }
    if (
      capability.state === 'blocked' &&
      !related.some(({ terminalState }) => terminalState === 'blocked')
    ) {
      throw new ReleaseCompletenessError(
        `${capability.capability} cannot be blocked without blocked source evidence`,
      );
    }
    if (
      capability.state === 'failed' &&
      !related.some(({ terminalState }) => terminalState === 'failed')
    ) {
      throw new ReleaseCompletenessError(
        `${capability.capability} cannot fail without failed source evidence`,
      );
    }
    if (capability.state === 'not_configured' && capability.sourceIds.length !== 0) {
      throw new ReleaseCompletenessError(
        `${capability.capability} not_configured state cannot reference a source snapshot`,
      );
    }
  }

  const expectedPolicies = new Set<string>();
  for (const profile of input.build.profiles) {
    for (const relation of Object.keys(profile.relations)) {
      expectedPolicies.add(`${profile.visibility}/${relation}`);
    }
  }
  const policies = new Set<string>();
  for (const policy of input.artifactPolicies) {
    const identity = policyKey(policy);
    if (policies.has(identity)) throw new TypeError(`Duplicate artifact policy: ${identity}`);
    policies.add(identity);
    assertUniqueNonEmpty(policy.limitations, `${identity}.limitations`, false);
    if (policy.sourceLineage.length === 0) {
      throw new ReleaseLicenseError(`${identity} requires source lineage`);
    }
    if (policy.contentClass === 'schema_metadata') {
      throw new ReleaseLicenseError(
        `${identity} cannot self-declare schema metadata; data dictionaries are generated`,
      );
    }
    if (
      policy.contentClass === 'capability_metadata' &&
      policy.relation !== 'source_coverage' &&
      policy.relation !== 'field_coverage' &&
      policy.relation !== 'relation_coverage' &&
      policy.relation !== 'pipeline_runs'
    ) {
      throw new ReleaseLicenseError(
        `${identity} relation cannot bypass data licensing as capability metadata`,
      );
    }
    for (const reference of policy.sourceLineage) {
      const snapshot = snapshots.get(snapshotKey(reference));
      if (snapshot === undefined) {
        throw new ReleaseLicenseError(`${identity} references an undeclared source snapshot`);
      }
      assertSourcePermission(policy, snapshot);
    }
  }
  if (stableJson([...policies].sort()) !== stableJson([...expectedPolicies].sort())) {
    throw new TypeError('Artifact policies must exactly match supplied profile relations');
  }
  const lineageSourceIds = new Set(
    input.artifactPolicies.flatMap(({ sourceLineage }) =>
      sourceLineage.map(({ sourceId }) => sourceId),
    ),
  );
  if (stableJson([...lineageSourceIds].sort()) !== stableJson(expectedSourceIds)) {
    throw new ReleaseLicenseError(
      'Artifact lineage must cover every declared source exactly by ID',
    );
  }
  for (const snapshot of input.sourceSnapshots.filter(
    ({ containsOwnerData }) => containsOwnerData,
  )) {
    const publicData = input.artifactPolicies.some(
      (policy) =>
        policy.visibility === 'public' &&
        (policy.contentClass === 'source_data' || policy.contentClass === 'derived_data') &&
        policy.sourceLineage.some((reference) => snapshotKey(reference) === snapshotKey(snapshot)),
    );
    const restrictedData = input.artifactPolicies.some(
      (policy) =>
        policy.visibility === 'restricted' &&
        (policy.contentClass === 'source_data' || policy.contentClass === 'derived_data') &&
        policy.sourceLineage.some((reference) => snapshotKey(reference) === snapshotKey(snapshot)),
    );
    if (publicData && !restrictedData) {
      throw new ReleasePrivacyError(
        'An owner-bearing source contributes public data without a restricted comparison artifact',
      );
    }
  }
  assertBlockedCoverage(input);
  return input;
}

function assertSourcePermission(policy: ArtifactReleasePolicy, snapshot: SourceSnapshotGate): void {
  const identity = policyKey(policy);
  if (policy.contentClass === 'schema_metadata') return;
  if (policy.contentClass === 'capability_metadata') {
    if (policy.visibility === 'public' && !snapshot.capabilityMetadataPublic) {
      throw new ReleaseLicenseError(`${identity} capability metadata is not public-approved`);
    }
    return;
  }
  if (snapshot.terminalState === 'blocked' || snapshot.terminalState === 'failed') {
    throw new ReleaseLicenseError(`${identity} cannot contain data from a terminal blocked source`);
  }
  if (snapshot.acquisitionPermission !== 'allowed') {
    throw new ReleaseLicenseError(`${identity} source acquisition is not approved`);
  }
  if (policy.visibility === 'public') {
    if (policy.contentClass === 'source_data' && snapshot.containsOwnerData) {
      throw new ReleasePrivacyError(`${identity} cannot publish owner-bearing source rows`);
    }
    if (snapshot.publicProjectionPermission !== 'allowed') {
      throw new ReleaseLicenseError(`${identity} source is not approved for public projection`);
    }
  } else if (snapshot.privateUsePermission !== 'allowed') {
    throw new ReleaseLicenseError(`${identity} source is not approved for restricted private use`);
  }
}

function assertBlockedCoverage(input: RealCountyReleaseInput): void {
  const coverageRows = input.build.profiles.flatMap(({ relations }) =>
    relations.source_coverage === undefined ? [] : [...relations.source_coverage],
  );
  const coveredSourceIds = new Set(coverageRows.map((row) => row.source_id));
  for (const source of input.sourceSnapshots) {
    if (!coveredSourceIds.has(source.sourceId)) {
      throw new ReleaseCompletenessError(`Source ${source.sourceId} has no coverage row`);
    }
    if (source.terminalState === 'blocked' || source.terminalState === 'failed') {
      const states = coverageRows.filter((row) => row.source_id === source.sourceId);
      if (
        states.some(
          (row) =>
            row.expected_count !== null ||
            row.observed_count !== 0 ||
            (row.support_class !== 'unsupported' && row.support_class !== 'unknown'),
        )
      ) {
        throw new ReleaseCompletenessError(
          `Blocked source ${source.sourceId} must remain unknown/unsupported with no fabricated denominator`,
        );
      }
    }
  }
  for (const row of coverageRows) {
    const candidates = input.sourceSnapshots.filter(({ sourceId }) => sourceId === row.source_id);
    const lineageMatches = candidates.some(
      (source) =>
        source.sourceSha256 === row.source_sha256 &&
        source.schemaSha256 === row.schema_sha256 &&
        (row.as_of === null || row.as_of === source.asOf),
    );
    if (!lineageMatches) {
      throw new ReleaseCompletenessError(
        `Coverage for ${String(row.source_id)} is not bound to a declared source snapshot`,
      );
    }
  }
}

function requiresOwnerComparison(input: RealCountyReleaseInput): boolean {
  const ownerSnapshots = new Set(
    input.sourceSnapshots.filter(({ containsOwnerData }) => containsOwnerData).map(snapshotKey),
  );
  return input.artifactPolicies.some(
    (policy) =>
      policy.visibility === 'public' &&
      (policy.contentClass === 'source_data' || policy.contentClass === 'derived_data') &&
      policy.sourceLineage.some((reference) => ownerSnapshots.has(snapshotKey(reference))),
  );
}

function attachReleasePolicies(
  input: RealCountyReleaseInput,
  built: readonly BuiltServingArtifact[],
): readonly ReleaseArtifact[] {
  const policies = new Map(input.artifactPolicies.map((policy) => [policyKey(policy), policy]));
  const snapshots = new Map(input.sourceSnapshots.map((source) => [snapshotKey(source), source]));
  const dictionaryPolicies = new Map<ServingVisibility, readonly ArtifactReleasePolicy[]>(
    (['public', 'restricted'] as const).map((visibility) => [
      visibility,
      input.artifactPolicies.filter((policy) => policy.visibility === visibility),
    ]),
  );
  return Object.freeze(
    built.map((artifact) => {
      const policy =
        artifact.relation === 'data_dictionary'
          ? dictionaryPolicy(artifact.visibility, dictionaryPolicies.get(artifact.visibility) ?? [])
          : policies.get(`${artifact.visibility}/${artifact.relation}`);
      if (policy === undefined) throw new TypeError(`Missing policy for ${artifact.relativePath}`);
      const sourceLineage = policy.sourceLineage.map((reference) => {
        const source = snapshots.get(snapshotKey(reference));
        if (source === undefined) throw new TypeError('Release policy source disappeared');
        return Object.freeze({
          sourceId: source.sourceId,
          snapshotId: source.snapshotId,
          sourceSha256: source.sourceSha256,
          schemaSha256: source.schemaSha256,
          asOf: source.asOf,
          role: reference.role,
        });
      });
      const sourceLimitations = policy.sourceLineage.flatMap(
        (reference) => snapshots.get(snapshotKey(reference))?.limitations ?? [],
      );
      return Object.freeze({
        ...artifact,
        grain: SERVING_RELATIONS[artifact.relation].grain,
        sourceLineage: Object.freeze(uniqueLineage(sourceLineage)),
        limitations: Object.freeze(uniqueStrings([...policy.limitations, ...sourceLimitations])),
      });
    }),
  );
}

function dictionaryPolicy(
  visibility: ServingVisibility,
  policies: readonly ArtifactReleasePolicy[],
): ArtifactReleasePolicy {
  return Object.freeze({
    visibility,
    relation: 'property_query',
    contentClass: 'schema_metadata',
    sourceLineage: Object.freeze(
      uniqueLineage(
        policies.flatMap(({ sourceLineage }) =>
          sourceLineage.map((reference) => ({ ...reference, role: 'derived' as const })),
        ),
      ),
    ),
    limitations: Object.freeze(['Schema metadata only; it does not add source coverage.']),
  });
}

function createManifest(
  build: Readonly<{
    releaseId: string;
    runId: string;
    generatedAt: string;
    duckdbVersion: string;
  }>,
  artifacts: readonly ReleaseArtifact[],
): RealCountyPortableManifest {
  const payload = Object.freeze({
    contractVersion: '1.0.0' as const,
    releaseId: build.releaseId,
    runId: build.runId,
    county: 'Santa Clara' as const,
    state: 'CA' as const,
    generatedAt: build.generatedAt,
    duckdbVersion: build.duckdbVersion,
    sourceIds: Object.freeze(
      [
        ...new Set(
          artifacts.flatMap(({ sourceLineage }) => sourceLineage.map(({ sourceId }) => sourceId)),
        ),
      ].sort(),
    ),
    artifacts: Object.freeze(
      [...artifacts].sort(
        (left, right) =>
          left.visibility.localeCompare(right.visibility) ||
          left.relation.localeCompare(right.relation),
      ),
    ),
  });
  return Object.freeze({
    ...payload,
    manifestSha256: sha256(Buffer.from(`${stableJson(payload)}\n`)),
  });
}

async function verifyPublicRestrictedPrivacy(
  root: string,
  artifacts: readonly BuiltServingArtifact[],
): Promise<
  Readonly<{
    ownerBearingPublicValues: number;
    restrictedSensitiveValueHashes: number;
  }>
> {
  const instance = await DuckDBInstance.create(':memory:', { threads: '1' });
  const connection = await instance.connect();
  try {
    await connection.run(
      'CREATE TEMP TABLE restricted_value_hashes(value_hash VARCHAR PRIMARY KEY)',
    );
    for (const artifact of artifacts.filter(({ visibility }) => visibility === 'restricted')) {
      const path = sqlPath(resolveInside(root, artifact.relativePath));
      for (const column of artifact.columns) {
        if (column.duckdbType !== 'VARCHAR') continue;
        const identifier = quoteIdentifier(column.name);
        if (PUBLIC_PROHIBITED_COLUMN_PATTERN.test(column.name)) {
          await connection.run(
            `INSERT OR IGNORE INTO restricted_value_hashes SELECT sha256(lower(trim(${identifier}))) FROM read_parquet('${path}') WHERE ${identifier} IS NOT NULL AND length(trim(${identifier})) > 0`,
          );
        }
        if (column.name.endsWith('_json')) {
          await connection.run(`
            INSERT OR IGNORE INTO restricted_value_hashes
            SELECT sha256(lower(trim(json_extract_string(j.value, '$'))))
            FROM read_parquet('${path}'), json_tree(${identifier}) AS j
            WHERE j.type = 'VARCHAR'
              AND regexp_matches(regexp_replace(lower(j.key), '[^a-z0-9]', '', 'g'), '(ownername|ownerstext|mailingaddress|grantor|grantee|email|phone|contact)')
              AND length(trim(json_extract_string(j.value, '$'))) > 0
          `);
        }
      }
    }
    const hashCount = await scalarCount(
      connection,
      'SELECT count(*)::BIGINT AS count FROM restricted_value_hashes',
    );
    let overlaps = 0;
    if (hashCount > 0) {
      for (const artifact of artifacts.filter(({ visibility }) => visibility === 'public')) {
        const path = sqlPath(resolveInside(root, artifact.relativePath));
        for (const column of artifact.columns.filter(
          ({ duckdbType }) => duckdbType === 'VARCHAR',
        )) {
          const identifier = quoteIdentifier(column.name);
          if (column.name.endsWith('_json')) {
            overlaps += await scalarCount(
              connection,
              `SELECT count(*)::BIGINT AS count FROM read_parquet('${path}'), json_tree(${identifier}) AS j JOIN restricted_value_hashes r ON r.value_hash = sha256(lower(trim(json_extract_string(j.value, '$')))) WHERE j.type = 'VARCHAR'`,
            );
          } else {
            overlaps += await scalarCount(
              connection,
              `SELECT count(*)::BIGINT AS count FROM read_parquet('${path}') p JOIN restricted_value_hashes r ON r.value_hash = sha256(lower(trim(p.${identifier}))) WHERE p.${identifier} IS NOT NULL`,
            );
          }
        }
      }
    }
    return Object.freeze({
      ownerBearingPublicValues: overlaps,
      restrictedSensitiveValueHashes: hashCount,
    });
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function buildAndVerifyCatalog(
  root: string,
  artifacts: readonly BuiltServingArtifact[],
  visibility: ServingVisibility,
): Promise<CatalogVerification> {
  const selected = artifacts.filter((artifact) => artifact.visibility === visibility);
  if (selected.length === 0) throw new ReleaseSegregationError(`No ${visibility} artifacts`);
  const relativePath = `${visibility}/oracle-${visibility}.duckdb`;
  const path = resolveInside(root, relativePath);
  const instance = await DuckDBInstance.create(path, { threads: '1' });
  const connection = await instance.connect();
  try {
    await connection.run('SET threads = 1');
    for (const artifact of selected) {
      await connection.run(
        `CREATE TABLE ${quoteIdentifier(artifact.relation)} AS SELECT * FROM read_parquet('${sqlPath(resolveInside(root, artifact.relativePath))}')`,
      );
    }
    await connection.run('CHECKPOINT');
  } finally {
    connection.closeSync();
    instance.closeSync();
  }

  const bytes = await readFile(path);
  const fileStat = await stat(path);
  const catalog = Object.freeze({
    visibility,
    relativePath,
    byteSize: fileStat.size,
    sha256: sha256(bytes),
    relationCount: selected.length,
    rowCount: selected.reduce((sum, artifact) => sum + artifact.rowCount, 0),
  });
  await verifyCatalogReopen(root, artifacts, catalog);
  return catalog;
}

async function verifyCatalogReopen(
  root: string,
  artifacts: readonly BuiltServingArtifact[],
  catalog: CatalogVerification,
): Promise<void> {
  const expectedPath = `${catalog.visibility}/oracle-${catalog.visibility}.duckdb`;
  if (catalog.relativePath !== expectedPath) {
    throw new ReleaseSegregationError('Catalog path does not match its visibility profile');
  }
  const selected = artifacts.filter(({ visibility }) => visibility === catalog.visibility);
  if (selected.length !== catalog.relationCount) {
    throw new ReleaseParityError(
      `${catalog.visibility} catalog relation count differs from evidence`,
    );
  }
  if (
    catalog.visibility === 'public' &&
    selected.some(
      ({ relation }) => !SERVING_RELATIONS[relation].allowedVisibilities.includes('public'),
    )
  ) {
    throw new ReleaseSegregationError('Restricted-only relation entered public catalog');
  }
  const path = resolveInside(root, catalog.relativePath);
  const reopened = await DuckDBInstance.create(path, { threads: '1' });
  const connection = await reopened.connect();
  try {
    const tableRows = await connection.runAndReadAll(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_type = 'BASE TABLE' ORDER BY table_name",
    );
    const actualTables = tableRows.getRowObjects().map(({ table_name }) => table_name);
    const expectedTables = selected.map(({ relation }) => relation).sort();
    if (stableJson(actualTables) !== stableJson(expectedTables)) {
      throw new ReleaseParityError(`${catalog.visibility} catalog table inventory drifted`);
    }
    let rowCount = 0;
    for (const artifact of selected) {
      await assertCatalogSchema(connection, artifact);
      rowCount += await relationParity(
        connection,
        artifact.relation,
        `read_parquet('${sqlPath(resolveInside(root, artifact.relativePath))}')`,
        artifact,
      );
    }
    if (rowCount !== catalog.rowCount) {
      throw new ReleaseParityError(`${catalog.visibility} catalog row count differs from evidence`);
    }
  } finally {
    connection.closeSync();
    reopened.closeSync();
  }
}

async function assertCatalogSchema(
  connection: DuckDBConnection,
  artifact: BuiltServingArtifact,
): Promise<void> {
  const described = await connection.runAndReadAll(
    `DESCRIBE ${quoteIdentifier(artifact.relation)}`,
  );
  const actual = described
    .getRowObjects()
    .map((row) => ({ name: row.column_name, duckdbType: row.column_type }));
  const expected = artifact.columns.map(({ name, duckdbType }) => ({ name, duckdbType }));
  if (stableJson(actual) !== stableJson(expected)) {
    throw new ReleaseParityError(
      `${artifact.visibility}/${artifact.relation} catalog schema drifted`,
    );
  }
}

async function relationParity(
  connection: DuckDBConnection,
  table: string,
  parquetRelation: string,
  artifact: BuiltServingArtifact,
): Promise<number> {
  const columns = artifact.columns.map(({ name }) => quoteIdentifier(name)).join(', ');
  const tableSummary = await connection.runAndReadAll(
    `SELECT count(*)::BIGINT AS count, bit_xor(hash(${columns}))::VARCHAR AS checksum FROM ${quoteIdentifier(table)}`,
  );
  const parquetSummary = await connection.runAndReadAll(
    `SELECT count(*)::BIGINT AS count, bit_xor(hash(${columns}))::VARCHAR AS checksum FROM ${parquetRelation}`,
  );
  const left = tableSummary.getRowObjects()[0];
  const right = parquetSummary.getRowObjects()[0];
  if (
    Number(left?.count) !== artifact.rowCount ||
    Number(right?.count) !== artifact.rowCount ||
    left?.checksum !== right?.checksum
  ) {
    throw new ReleaseParityError(
      `${artifact.visibility}/${artifact.relation} reopen parity failed`,
    );
  }
  return artifact.rowCount;
}

function createEvidence(
  input: RealCountyReleaseInput,
  manifest: RealCountyPortableManifest,
  manifestBytes: Uint8Array,
  catalogs: readonly CatalogVerification[],
  privacy: Readonly<{
    ownerBearingPublicValues: number;
    restrictedSensitiveValueHashes: number;
  }>,
): RealCountyReleaseEvidence {
  if (privacy.ownerBearingPublicValues !== 0) {
    throw new ReleasePrivacyError('Cannot create passing evidence for a privacy overlap');
  }
  const payload = Object.freeze({
    contractVersion: '1.0.0' as const,
    releaseId: manifest.releaseId,
    runId: manifest.runId,
    county: 'Santa Clara' as const,
    state: 'CA' as const,
    generatedAt: manifest.generatedAt,
    releaseScope: input.releaseScope,
    countyCompletionClaim: input.releaseScope === 'full_county',
    permitAuthorityCoverage: Object.freeze({
      covered: input.permitAuthoritiesCovered,
      total: input.permitAuthoritiesTotal,
    }),
    manifestSha256: manifest.manifestSha256,
    manifestFileSha256: sha256(manifestBytes),
    capabilities: Object.freeze(
      input.capabilities
        .map((capability) =>
          Object.freeze({
            ...capability,
            sourceIds: Object.freeze([...capability.sourceIds].sort()),
            limitations: Object.freeze(uniqueStrings(capability.limitations)),
          }),
        )
        .sort((left, right) => left.capability.localeCompare(right.capability)),
    ),
    artifacts: Object.freeze(
      manifest.artifacts.map(
        ({ relation, visibility, relativePath, rowCount, byteSize, sha256: hash }) =>
          Object.freeze({ relation, visibility, relativePath, rowCount, byteSize, sha256: hash }),
      ),
    ),
    catalogs: Object.freeze([...catalogs].sort((a, b) => a.visibility.localeCompare(b.visibility))),
    gates: Object.freeze({
      license: 'passed' as const,
      manifest: 'passed' as const,
      parquet: 'passed' as const,
      cleanReopen: 'passed' as const,
      publicRestrictedSegregation: 'passed' as const,
      ownerBearingPublicValues: 0 as const,
      restrictedSensitiveValueHashes: privacy.restrictedSensitiveValueHashes,
    }),
  });
  return Object.freeze({
    ...payload,
    evidenceSha256: sha256(Buffer.from(`${stableJson(payload)}\n`)),
  });
}

async function verifyStagedBundle(
  root: string,
  manifest: RealCountyPortableManifest,
  evidence: RealCountyReleaseEvidence,
): Promise<void> {
  verifySelfHash(manifest, 'manifestSha256');
  verifySelfHash(evidence, 'evidenceSha256');
  const manifestBytes = await readFile(join(root, MANIFEST_FILE));
  if (sha256(manifestBytes) !== evidence.manifestFileSha256) {
    throw new ReleaseManifestError('Release manifest file hash differs from evidence');
  }
  if (
    evidence.releaseId !== manifest.releaseId ||
    evidence.runId !== manifest.runId ||
    evidence.manifestSha256 !== manifest.manifestSha256
  ) {
    throw new ReleaseManifestError('Release evidence is not bound to the manifest');
  }
  assertEvidenceSemantics(manifest, evidence);
  const artifacts = manifest.artifacts.map(toBuiltArtifact);
  assertCanonicalArtifactPaths(artifacts);
  await verifyServingArtifacts(root, artifacts);
  await assertScopeMatchesReleaseData(root, manifest, evidence);
  for (const artifact of manifest.artifacts) {
    const bytes = await readFile(resolveInside(root, artifact.relativePath));
    if (bytes.byteLength !== artifact.byteSize || sha256(bytes) !== artifact.sha256) {
      throw new ReleaseManifestError(`${artifact.relativePath} differs from release manifest`);
    }
  }
  const expectedCatalogs = new Set([
    'public/oracle-public.duckdb',
    'restricted/oracle-restricted.duckdb',
  ]);
  if (
    evidence.catalogs.length !== expectedCatalogs.size ||
    new Set(evidence.catalogs.map(({ relativePath }) => relativePath)).size !==
      expectedCatalogs.size ||
    evidence.catalogs.some(({ relativePath }) => !expectedCatalogs.has(relativePath))
  ) {
    throw new ReleaseSegregationError(
      'Release evidence must contain the exact two profile catalogs',
    );
  }
  for (const catalog of evidence.catalogs) {
    const expectedPath = `${catalog.visibility}/oracle-${catalog.visibility}.duckdb`;
    if (catalog.relativePath !== expectedPath) {
      throw new ReleaseSegregationError('Catalog visibility and path disagree');
    }
    const bytes = await readFile(resolveInside(root, catalog.relativePath));
    if (bytes.byteLength !== catalog.byteSize || sha256(bytes) !== catalog.sha256) {
      throw new ReleaseParityError(`${catalog.visibility} catalog differs from release evidence`);
    }
  }
}

function assertCanonicalArtifactPaths(artifacts: readonly BuiltServingArtifact[]): void {
  for (const artifact of artifacts) {
    const expectedPath = `${artifact.visibility}/${SERVING_RELATIONS[artifact.relation].fileName}`;
    if (artifact.relativePath !== expectedPath) {
      throw new ReleaseSegregationError(
        `${artifact.visibility}/${artifact.relation} artifact path is not canonical`,
      );
    }
    resolveInside('.', artifact.relativePath);
  }
}

function assertEvidenceSemantics(
  manifest: RealCountyPortableManifest,
  evidence: RealCountyReleaseEvidence,
): void {
  const permitAuthorityTotal = (evidence.permitAuthorityCoverage as Readonly<{ total: unknown }>)
    .total;
  if (evidence.countyCompletionClaim !== (evidence.releaseScope === 'full_county')) {
    throw new ReleaseCompletenessError('County completion claim disagrees with release scope');
  }
  if (
    permitAuthorityTotal !== 16 ||
    !Number.isSafeInteger(evidence.permitAuthorityCoverage.covered) ||
    evidence.permitAuthorityCoverage.covered < 0 ||
    evidence.permitAuthorityCoverage.covered > 16
  ) {
    throw new ReleaseCompletenessError('Evidence permit-authority coverage is invalid');
  }
  const capabilityNames = evidence.capabilities.map(({ capability }) => capability);
  if (
    capabilityNames.length !== REAL_COUNTY_CAPABILITIES.length ||
    new Set(capabilityNames).size !== REAL_COUNTY_CAPABILITIES.length ||
    REAL_COUNTY_CAPABILITIES.some((capability) => !capabilityNames.includes(capability))
  ) {
    throw new ReleaseCompletenessError('Evidence capability inventory is incomplete');
  }
  for (const capability of evidence.capabilities) {
    if (capability.state !== 'succeeded' && capability.limitations.length === 0) {
      throw new ReleaseCompletenessError('Non-success capability evidence requires a limitation');
    }
    if (capability.state === 'not_configured' && capability.sourceIds.length !== 0) {
      throw new ReleaseCompletenessError('Not-configured capability cannot claim source lineage');
    }
  }
  const capabilitySourceIds = [
    ...new Set(evidence.capabilities.flatMap(({ sourceIds }) => sourceIds)),
  ].sort();
  if (stableJson(capabilitySourceIds) !== stableJson([...manifest.sourceIds].sort())) {
    throw new ReleaseCompletenessError('Evidence capabilities do not cover manifest sources');
  }
  if (evidence.releaseScope === 'full_county') {
    const incomplete = evidence.capabilities.some(
      ({ capability, state }) =>
        state !== 'succeeded' &&
        !(OPTIONAL_FULL_CAPABILITIES.has(capability) && state === 'not_configured'),
    );
    if (incomplete || evidence.permitAuthorityCoverage.covered !== 16) {
      throw new ReleaseCompletenessError('Evidence cannot support a full-county claim');
    }
  }
  const expectedArtifacts = manifest.artifacts.map(
    ({ relation, visibility, relativePath, rowCount, byteSize, sha256: hash }) => ({
      relation,
      visibility,
      relativePath,
      rowCount,
      byteSize,
      sha256: hash,
    }),
  );
  if (stableJson(evidence.artifacts) !== stableJson(expectedArtifacts)) {
    throw new ReleaseManifestError('Evidence artifact inventory differs from the release manifest');
  }
}

async function assertScopeMatchesReleaseData(
  root: string,
  manifest: RealCountyPortableManifest,
  evidence: RealCountyReleaseEvidence,
): Promise<void> {
  if (evidence.releaseScope !== 'full_county') return;
  const pipelineRuns = manifest.artifacts.find(
    ({ relation, visibility }) => relation === 'pipeline_runs' && visibility === 'public',
  );
  const sourceCoverage = manifest.artifacts.find(
    ({ relation, visibility }) => relation === 'source_coverage' && visibility === 'public',
  );
  if (pipelineRuns === undefined || sourceCoverage === undefined) {
    throw new ReleaseCompletenessError(
      'Full-county evidence requires public run and source coverage',
    );
  }
  const instance = await DuckDBInstance.create(':memory:', { threads: '1' });
  const connection = await instance.connect();
  try {
    const succeeded = await scalarCount(
      connection,
      `SELECT count(*)::BIGINT AS count FROM read_parquet('${sqlPath(resolveInside(root, pipelineRuns.relativePath))}') WHERE run_id = '${sqlLiteral(manifest.runId)}' AND status = 'succeeded'`,
    );
    const incomplete = await scalarCount(
      connection,
      `SELECT count(*)::BIGINT AS count FROM read_parquet('${sqlPath(resolveInside(root, sourceCoverage.relativePath))}') WHERE support_class <> 'supported'`,
    );
    if (succeeded !== 1 || incomplete !== 0) {
      throw new ReleaseCompletenessError(
        'Parquet run/coverage rows do not support full-county scope',
      );
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

function resolveInside(root: string, relativePath: string): string {
  if (relativePath.startsWith('/') || relativePath.includes('..') || relativePath.includes('\\')) {
    throw new ReleaseSegregationError('Release path must be portable and relative');
  }
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, relativePath);
  if (
    resolvedPath !== resolvedRoot &&
    !resolvedPath.startsWith(`${resolvedRoot}\\`) &&
    !resolvedPath.startsWith(`${resolvedRoot}/`)
  ) {
    throw new ReleaseSegregationError('Release path escapes bundle root');
  }
  return resolvedPath;
}

function toBuiltArtifact(artifact: ReleaseArtifact): BuiltServingArtifact {
  return Object.freeze({
    relation: artifact.relation,
    relativePath: artifact.relativePath,
    visibility: artifact.visibility,
    mediaType: artifact.mediaType,
    byteSize: artifact.byteSize,
    sha256: artifact.sha256,
    rowCount: artifact.rowCount,
    schemaSha256: artifact.schemaSha256,
    columns: artifact.columns,
    nonNullCounts: artifact.nonNullCounts,
  });
}

async function scalarCount(connection: DuckDBConnection, statement: string): Promise<number> {
  const result = await connection.runAndReadAll(statement);
  return Number(result.getRowObjects()[0]?.count ?? 0);
}

async function assertPathAbsent(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new ImmutableReleaseBundleExistsError(path);
}

async function writeCanonicalCreateOnly(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${stableJson(value)}\n`, { flag: 'wx' });
}

async function readCanonicalDocument<T>(path: string): Promise<T> {
  const text = await readFile(path, 'utf8');
  const value = JSON.parse(text) as T;
  if (text !== `${stableJson(value)}\n`)
    throw new ReleaseManifestError('Document is not canonical');
  return value;
}

function verifySelfHash<T extends object>(value: T, field: keyof T): void {
  const record = value as Readonly<Record<string, unknown>>;
  const expected = record[String(field)];
  if (typeof expected !== 'string') throw new ReleaseManifestError(`${String(field)} is missing`);
  const payload = Object.fromEntries(Object.entries(record).filter(([key]) => key !== field));
  const actual = sha256(Buffer.from(`${stableJson(payload)}\n`));
  if (expected !== actual) throw new ReleaseManifestError(`${String(field)} mismatch`);
}

function policyKey(policy: Pick<ArtifactReleasePolicy, 'visibility' | 'relation'>): string {
  return `${policy.visibility}/${policy.relation}`;
}

function snapshotKey(
  value:
    | Pick<SourceSnapshotGate, 'sourceId' | 'snapshotId'>
    | Pick<ArtifactSourceReference, 'sourceId' | 'snapshotId'>,
): string {
  return `${value.sourceId}\0${value.snapshotId}`;
}

function uniqueLineage<T extends { sourceId: string; snapshotId: string }>(
  values: readonly T[],
): T[] {
  const unique = new Map(values.map((value) => [snapshotKey(value), value]));
  return [...unique.values()].sort(
    (left, right) =>
      left.sourceId.localeCompare(right.sourceId) ||
      left.snapshotId.localeCompare(right.snapshotId),
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function assertUniqueNonEmpty(values: readonly string[], label: string, requireOne: boolean): void {
  if (
    (requireOne && values.length === 0) ||
    values.some((value) => value.trim().length === 0) ||
    new Set(values).size !== values.length
  ) {
    throw new TypeError(`${label} must contain unique non-empty values`);
  }
}

function assertInstant(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value)) || !/[zZ]|[+-]\d\d:\d\d$/u.test(value)) {
    throw new TypeError(`${label} must be an offset-qualified ISO-8601 timestamp`);
  }
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${label} must be lowercase SHA-256`);
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

function sqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class ReleaseCompletenessError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReleaseCompletenessError';
  }
}

export class ReleaseLicenseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReleaseLicenseError';
  }
}

export class ReleasePrivacyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReleasePrivacyError';
  }
}

export class ReleaseSegregationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReleaseSegregationError';
  }
}

export class ReleaseParityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReleaseParityError';
  }
}

export class ReleaseManifestError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReleaseManifestError';
  }
}

export class ImmutableReleaseBundleExistsError extends Error {
  public constructor(path: string) {
    super(`Immutable release bundle already exists: ${path}`);
    this.name = 'ImmutableReleaseBundleExistsError';
  }
}
