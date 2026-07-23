import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

import type {
  BoundedPortableReleaseArtifact,
  BoundedServingReleaseEvidence,
  BoundedServingReleaseManifest,
} from './bounded-release.js';
import {
  buildPortableServingRelease,
  type BuiltServingArtifact,
  type PortableServingBuildInput,
} from './builder.js';
import {
  PUBLIC_PROHIBITED_COLUMN_PATTERN,
  SERVING_RELATIONS,
  type ServingRelationName,
  type ServingRow,
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
const SAN_JOSE_SOURCE_ID = 'sc:source:san-jose-building-permits';
const SAN_JOSE_ACTIVE_SOURCE_URL =
  'https://data.sanjoseca.gov/dataset/fd9ceb0c-75e0-402e-9fe3-3f6e04f2c23f/resource/761b7ae8-3be1-4ad6-923d-c7af6404a904/download/buildingpermitsactive.csv';
const SAN_JOSE_CC0_TERMS_SHA256 =
  'a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499';
const ACCEPTED_P7_RUN_ID =
  'sc:run:ba8503d4c26d2831b3184f1cb283ce5568ca3f2b43194e228fb766531167be6a';
const ACCEPTED_P7_MART_SHA256 = '267c50fc264175206965de6bd0654a7a6f8c079b80c6eaba196807193592ff5d';
const ACCEPTED_P7_MUTATION_SHA256 =
  'f123997681c6d7c5bf1a373236389479c049021bc24606442cda6d1d8f87455e';
const ACCEPTED_P7_ACQUISITION_RECEIPT_SHA256 =
  '3399337628b33777e24ae7e2258ee0792350007b3bc73471d2091df93aabbe88';
const ACCEPTED_P7_RAW_SHA256 = 'f6254f86470703795ecc37588af81a56c622359f95c33b8e10cf671ca6f194db';
const ACCEPTED_P7_INTENT_SNAPSHOT_ID =
  'sc:snapshot:san-jose-building-permits:5c5adb686a96a012aa37dcef1d1e293c0d8fd1e02af09b514e434bd3364af758';
const ACCEPTED_P7_OBSERVED_SNAPSHOT_ID =
  'sc:snapshot:san-jose-building-permits:364caba50008afb149c57e795a965cbfdae515e0d247a81b15e1eecf78f87e18';
const ACCEPTED_P7_SCHEMA_SHA256 =
  '2b232748fbdba4ab6ee0331412232b77c73cf7529261a7ea66b45bf1bf352fe7';
const ACCEPTED_P7_SOURCE_SHA256 =
  'f7114e1b2ac3a614b163f95dce19a2718bc140736db71f0111cbb9eb388d61d9';
const ACCEPTED_P7_SOURCE_AS_OF = '2026-07-17T11:02:50.000Z';
const ACCEPTED_P7_RETRIEVED_AT = '2026-07-17T21:29:56.262Z';
const ACCEPTED_P7_MART_GENERATED_AT = '2026-07-17T21:30:33.863Z';
const ACCEPTED_P7_MANIFEST_COMPLETED_AT = '2026-07-17T21:30:33.928Z';
const ACCEPTED_P8_OPERATOR_MANIFEST_SHA256 =
  '91127b0e9beb7bf9ba7b9de947797829054263b791673bac6886c73ce36f44a8';
const ACCEPTED_P8_OPERATOR_MANIFEST_FILE_SHA256 =
  '5685a813f0543dabeebc685db1cd142522b0ded930c6c8d43c23899a51c019ec';
const OWNER_FREE_RELEASE_ID = 'santa-clara-p8-public-serving';
const OWNER_FREE_FEATURES = Object.freeze([
  'roof_age',
  'water_view_candidate',
  'ownership_age',
  'regional_owner',
  'transit_walkability',
  'starbucks_walkability',
] as const);
const OWNER_FREE_PUBLIC_RELATIONS = Object.freeze([
  'property_query',
  'property_evidence',
  'source_coverage',
  'field_coverage',
  'relation_coverage',
  'pipeline_runs',
  'data_dictionary',
] as const satisfies readonly ServingRelationName[]);

type OwnerFreeFeature = (typeof OWNER_FREE_FEATURES)[number];

export type OwnerFreePublicReleasePaths = Readonly<{
  pipelineManifestPath: string;
  pipelineMartPath: string;
  normalizedMutationArtifactPath: string;
  rawSourceArtifactPath: string;
  sourceAcquisitionReceiptPath: string;
  outputDirectory: string;
}>;

export type PublicServingClosure = Readonly<{
  outputDirectory: string;
  manifestSha256: string;
  manifestFileSha256: string;
  manifestCid: string;
  publicArtifactCount: 7;
}>;

export type OwnerFreePublicServingClosure = PublicServingClosure;

export type BoundedPublicLicenseVerificationInput = Readonly<{
  authorizationVersion: 'bounded-public-serving-license@1.0.0';
  trustRootSha256: string;
  releaseId: string;
  runId: string;
  manifestSha256: string;
  publicArtifactSha256s: readonly string[];
}>;

export type TrustedBoundedPublicLicenseApproval = Readonly<{
  authorizationVersion: 'bounded-public-serving-license@1.0.0';
  trustRootSha256: string;
  releaseId: string;
  runId: string;
  manifestSha256: string;
  publicArtifactSha256s: readonly string[];
  decision: 'allowed_public';
  policyVersion: string;
  licenseSnapshotRefs: readonly string[];
}>;

export type SignedBoundedPublicLicenseApproval = Readonly<{
  authorization: TrustedBoundedPublicLicenseApproval;
  signatureBase64: string;
}>;

export interface BoundedPublicLicenseTrust {
  readonly trustRootSha256: string;
  readonly publicKeyPem: string;
  authorizePublicRelease(
    input: BoundedPublicLicenseVerificationInput,
  ): Promise<SignedBoundedPublicLicenseApproval | null>;
}

export type BoundedPublicServingClosureOptions = Readonly<{
  licenseTrust: BoundedPublicLicenseTrust;
}>;

export function boundedPublicLicenseAuthorizationBytes(
  authorization: TrustedBoundedPublicLicenseApproval,
): Uint8Array {
  return Buffer.from(`${stableJson(authorization)}\n`);
}

type AcceptedPipelineManifest = Readonly<{
  runId: string;
  profile: string;
  status: string;
  completedAt: string;
  sources: readonly Readonly<Record<string, unknown>>[];
  artifacts: readonly Readonly<Record<string, unknown>>[];
}>;

type AcceptedMutation = Readonly<Record<string, unknown>>;

type PublicIdentityObservation = Readonly<{
  propertyId: string;
  apn: string;
  observations: readonly Readonly<{
    observationId: string;
    sourceRecord: Readonly<Record<string, unknown>>;
  }>[];
}>;

type RestrictedComparisonObservation = Readonly<{
  observationId: string;
  fieldPath: string;
  value: string;
  observedAt: string;
  sourceAsOf: string;
  sourceRecord: Readonly<Record<string, unknown>>;
}>;

/**
 * Rebuilds the accepted p7 pilot as an owner-free public serving release.
 *
 * The projection is intentionally fixed: the only public property values are the exact non-null
 * normalized APNs from the frozen CC0 San Jose ACTIVE permit snapshot and their deterministic
 * county-scoped property IDs. No parcel/MTC value, free text, address, owner/applicant/contractor
 * value, raw payload, or caller-selected field can enter the public relations.
 */
export async function buildOwnerFreePublicServingRelease(
  paths: OwnerFreePublicReleasePaths,
): Promise<RealCountyReleaseResult> {
  const [pipelineManifestBytes, pipelineMartBytes, mutationBytes, rawBytes, receiptBytes] =
    await Promise.all([
      readFile(resolve(paths.pipelineManifestPath)),
      readFile(resolve(paths.pipelineMartPath)),
      readFile(resolve(paths.normalizedMutationArtifactPath)),
      readFile(resolve(paths.rawSourceArtifactPath)),
      readFile(resolve(paths.sourceAcquisitionReceiptPath)),
    ]);
  const pipelineManifest = acceptedPipelineManifest(JSON.parse(pipelineManifestBytes.toString()));
  const pipelineMart = acceptedPipelineMart(JSON.parse(pipelineMartBytes.toString()));
  const mutations = acceptedMutations(JSON.parse(mutationBytes.toString()));
  const receipt = acceptedRawReceipt(JSON.parse(receiptBytes.toString()));
  const accepted = validateAcceptedSanJoseArtifacts({
    pipelineManifest,
    pipelineMart,
    mutations,
    pipelineMartSha256: sha256(pipelineMartBytes),
    mutationSha256: sha256(mutationBytes),
    rawSha256: sha256(rawBytes),
    rawByteSize: rawBytes.byteLength,
    acquisitionReceiptSha256: sha256(receiptBytes),
    receipt,
  });
  const identities = publicIdentityObservations(mutations, accepted.intentSnapshotId);
  const comparisons = restrictedComparisonObservations(mutations, accepted.intentSnapshotId);
  if (identities.length === 0) {
    throw new ReleaseCompletenessError(
      'The accepted San Jose snapshot has no non-null public normalized APN observation',
    );
  }
  if (comparisons.length === 0) {
    throw new ReleasePrivacyError(
      'The owner-bearing San Jose source has no restricted sensitive-value comparison population',
    );
  }

  const sourceGate = pipelineMart.portableReleaseInput.sourceSnapshots.find(
    ({ sourceId }) => sourceId === SAN_JOSE_SOURCE_ID,
  );
  if (sourceGate === undefined) throw new ReleaseLicenseError('San Jose source gate is absent');
  const lineage = Object.freeze([
    Object.freeze({
      sourceId: sourceGate.sourceId,
      snapshotId: sourceGate.snapshotId,
      role: 'derived' as const,
    }),
  ]);
  const directLineage = Object.freeze([
    Object.freeze({
      sourceId: sourceGate.sourceId,
      snapshotId: sourceGate.snapshotId,
      role: 'direct' as const,
    }),
  ]);
  const lineageContext = Object.freeze({
    sourceId: SAN_JOSE_SOURCE_ID,
    sourceUrl: SAN_JOSE_ACTIVE_SOURCE_URL,
    attribution: 'City of San Jose Open Data',
    license: 'CC0-1.0',
    licenseTermsSha256: SAN_JOSE_CC0_TERMS_SHA256,
    intentSnapshotId: accepted.intentSnapshotId,
    observedSnapshotId: accepted.observedSnapshotId,
    sourceAsOf: accepted.sourceAsOf,
    retrievedAt: accepted.retrievedAt,
    rawArtifactSha256: accepted.rawSha256,
    normalizedArtifactSha256: accepted.mutationSha256,
  });
  const properties = ownerFreePropertyRows(identities);
  const evidence = ownerFreeEvidenceRows(identities, lineageContext);
  const fieldCoverage = ownerFreeFieldCoverageRows(properties.length, evidence.length);
  const normalizedObservationCount = identities.reduce(
    (total, identity) => total + identity.observations.length,
    0,
  );
  const relationCoverage = ownerFreeRelationCoverageRows(
    properties.length,
    evidence.length,
    normalizedObservationCount,
  );
  const base = pipelineMart.portableReleaseInput;
  const publicProfile = base.build.profiles.find(({ visibility }) => visibility === 'public');
  if (publicProfile === undefined)
    throw new ReleaseSegregationError('Accepted mart has no public profile');
  const sourceCoverage = publicProfile.relations.source_coverage;
  const pipelineRuns = publicProfile.relations.pipeline_runs;
  if (sourceCoverage === undefined || pipelineRuns === undefined) {
    throw new ReleaseCompletenessError('Accepted mart is missing public source/run coverage');
  }
  const sourceLineage = Object.freeze(
    base.sourceSnapshots.map(({ sourceId, snapshotId }) =>
      Object.freeze({ sourceId, snapshotId, role: 'direct' as const }),
    ),
  );
  const sourceLimit = Object.freeze([
    `Public identity is limited to ${properties.length} distinct non-null APNs in the accepted bounded San Jose ACTIVE permit snapshot.`,
    `Source URL: ${SAN_JOSE_ACTIVE_SOURCE_URL}`,
    `Retrieved at ${accepted.retrievedAt}; source as-of ${accepted.sourceAsOf}.`,
    `Raw SHA-256 ${accepted.rawSha256}; normalized mutation SHA-256 ${accepted.mutationSha256}.`,
    `CC0 terms evidence SHA-256 ${SAN_JOSE_CC0_TERMS_SHA256}; attribution: City of San Jose Open Data.`,
  ]);
  return buildRealCountyReleaseBundle({
    outputDirectory: paths.outputDirectory,
    releaseScope: 'pilot',
    permitAuthoritiesCovered: 1,
    permitAuthoritiesTotal: 16,
    sourceSnapshots: base.sourceSnapshots,
    capabilities: base.capabilities,
    build: {
      releaseId: OWNER_FREE_RELEASE_ID,
      runId: base.build.runId,
      generatedAt: base.build.generatedAt,
      sourceIds: base.build.sourceIds,
      profiles: Object.freeze([
        Object.freeze({
          visibility: 'public' as const,
          relations: Object.freeze({
            property_query: properties,
            property_evidence: evidence,
            source_coverage: sourceCoverage,
            field_coverage: fieldCoverage,
            relation_coverage: relationCoverage,
            pipeline_runs: pipelineRuns,
          }),
        }),
        Object.freeze({
          visibility: 'restricted' as const,
          relations: Object.freeze({
            canonical_history: restrictedComparisonRows(comparisons, lineageContext),
          }),
        }),
      ]),
    },
    artifactPolicies: Object.freeze([
      Object.freeze({
        visibility: 'public' as const,
        relation: 'property_query' as const,
        contentClass: 'derived_data' as const,
        sourceLineage: lineage,
        limitations: sourceLimit,
      }),
      Object.freeze({
        visibility: 'public' as const,
        relation: 'property_evidence' as const,
        contentClass: 'derived_data' as const,
        sourceLineage: lineage,
        limitations: Object.freeze([
          ...sourceLimit,
          'Six evidence rows per public property preserve unknown/unsupported states; identity lineage does not support a positive criterion fact.',
        ]),
      }),
      Object.freeze({
        visibility: 'public' as const,
        relation: 'source_coverage' as const,
        contentClass: 'capability_metadata' as const,
        sourceLineage,
        limitations: Object.freeze([
          'Accepted p7 source coverage metadata; no blocked source contributes public data.',
        ]),
      }),
      Object.freeze({
        visibility: 'public' as const,
        relation: 'field_coverage' as const,
        contentClass: 'capability_metadata' as const,
        sourceLineage: lineage,
        limitations: Object.freeze([
          'Exact semantic coverage for the owner-free public property and evidence relations.',
        ]),
      }),
      Object.freeze({
        visibility: 'public' as const,
        relation: 'relation_coverage' as const,
        contentClass: 'capability_metadata' as const,
        sourceLineage: lineage,
        limitations: Object.freeze([
          'Exact APN identity and evidence foreign-key coverage for this bounded pilot.',
        ]),
      }),
      Object.freeze({
        visibility: 'public' as const,
        relation: 'pipeline_runs' as const,
        contentClass: 'capability_metadata' as const,
        sourceLineage,
        limitations: Object.freeze(['Accepted p7 run evidence; county completion remains false.']),
      }),
      Object.freeze({
        visibility: 'restricted' as const,
        relation: 'canonical_history' as const,
        contentClass: 'source_data' as const,
        sourceLineage: directLineage,
        limitations: Object.freeze([
          'Exact owner, applicant, and authenticated contractor observations retained only for restricted hash comparison.',
        ]),
      }),
    ]),
  });
}

/**
 * Creates the exact public deployment closure from a fully verified operator bundle.
 *
 * The closure manifest is independently self-hashed after restricted artifact descriptors are
 * removed. Its CID is CIDv1/raw/sha2-256 over those exact canonical manifest bytes, so the value is
 * locally reproducible without uploading or assigning publication authority.
 */
export async function buildOwnerFreePublicServingClosure(
  verifiedBundleDirectory: string,
  outputDirectoryPath: string,
): Promise<OwnerFreePublicServingClosure> {
  const sourceRoot = resolve(verifiedBundleDirectory);
  const outputDirectory = resolve(outputDirectoryPath);
  assertDistinctReleaseRoots(sourceRoot, outputDirectory);
  await assertPathAncestorsAreReal(sourceRoot);
  await assertPathAncestorsAreReal(outputDirectory);
  await rejectReleaseSymlinks(sourceRoot);
  await assertPathAbsent(outputDirectory);
  const outputParentIdentity = await prepareRealOutputParent(outputDirectory);
  const verified = await verifyRealCountyReleaseBundle(sourceRoot);
  if (
    verified.releaseId !== OWNER_FREE_RELEASE_ID ||
    verified.runId !== ACCEPTED_P7_RUN_ID ||
    verified.releaseScope !== 'pilot' ||
    verified.publicArtifactCount !== OWNER_FREE_PUBLIC_RELATIONS.length
  ) {
    throw new ReleaseManifestError('Only the exact verified p8 owner-free bundle can be staged');
  }

  const sourceManifest = await readCanonicalDocument<RealCountyPortableManifest>(
    join(sourceRoot, MANIFEST_FILE),
  );
  verifySelfHash(sourceManifest, 'manifestSha256');
  const [sourceManifestBytes, sourceEvidence] = await Promise.all([
    readFile(join(sourceRoot, MANIFEST_FILE)),
    readCanonicalDocument<RealCountyReleaseEvidence>(join(sourceRoot, EVIDENCE_FILE)),
  ]);
  if (
    sourceManifest.manifestSha256 !== ACCEPTED_P8_OPERATOR_MANIFEST_SHA256 ||
    sha256(sourceManifestBytes) !== ACCEPTED_P8_OPERATOR_MANIFEST_FILE_SHA256 ||
    sourceEvidence.gates.restrictedSensitiveValueHashes !== 61
  ) {
    throw new ReleaseManifestError('Operator bundle differs from the exact accepted p8 build');
  }
  const publicArtifacts = sourceManifest.artifacts.filter(
    ({ visibility }) => visibility === 'public',
  );
  const publicRelations = publicArtifacts.map(({ relation }) => relation).sort();
  if (
    stableJson(publicRelations) !== stableJson([...OWNER_FREE_PUBLIC_RELATIONS].sort()) ||
    publicArtifacts.some(({ relativePath }) => !relativePath.startsWith('public/'))
  ) {
    throw new ReleaseManifestError('p8 public relation closure is incomplete');
  }

  const publicManifestPayload = Object.freeze({
    ...Object.fromEntries(
      Object.entries(sourceManifest).filter(
        ([key]) => key !== 'artifacts' && key !== 'manifestSha256',
      ),
    ),
    artifacts: Object.freeze(publicArtifacts),
  });
  const manifest = Object.freeze({
    ...publicManifestPayload,
    manifestSha256: sha256(Buffer.from(`${stableJson(publicManifestPayload)}\n`)),
  });
  const manifestBytes = Buffer.from(`${stableJson(manifest)}\n`);
  const manifestCid = rawCidV1Sha256(manifestBytes);
  const servingConfig = createP8ServingConfig(sourceManifest, manifest, manifestCid);

  return stagePublicServingClosure({
    sourceRoot,
    outputDirectory,
    publicArtifacts,
    manifestBytes,
    manifestSha256: manifest.manifestSha256,
    manifestCid,
    servingConfig,
    outputParentIdentity,
  });
}

/**
 * Converts any fully verified bounded operator release into the exact nine-file public closure
 * consumed by CDK. Operator evidence, catalogs, checkpoints, and restricted bytes are verification
 * inputs only and are never staged.
 */
export async function buildBoundedPublicServingClosure(
  verifiedBundleDirectory: string,
  outputDirectoryPath: string,
  options: BoundedPublicServingClosureOptions,
): Promise<PublicServingClosure> {
  const sourceRoot = resolve(verifiedBundleDirectory);
  const outputDirectory = resolve(outputDirectoryPath);
  assertDistinctReleaseRoots(sourceRoot, outputDirectory);
  await assertPathAncestorsAreReal(sourceRoot);
  await assertPathAncestorsAreReal(outputDirectory);
  await rejectReleaseSymlinks(sourceRoot);
  await assertPathAbsent(outputDirectory);
  const outputParentIdentity = await prepareRealOutputParent(outputDirectory);

  // Dynamic import avoids a runtime initialization cycle: bounded-release uses the capability
  // contract exported by this module.
  const { verifyBoundedServingRelease } = await import('./bounded-release.js');
  const verified = await verifyBoundedServingRelease(sourceRoot);
  const [sourceManifest, sourceEvidence] = await Promise.all([
    readCanonicalDocument<BoundedServingReleaseManifest>(join(sourceRoot, MANIFEST_FILE)),
    readCanonicalDocument<BoundedServingReleaseEvidence>(join(sourceRoot, EVIDENCE_FILE)),
  ]);
  if (
    stableJson(sourceManifest) !== stableJson(verified.manifest) ||
    stableJson(sourceEvidence) !== stableJson(verified.evidence)
  ) {
    throw new ReleaseManifestError('Bounded verifier result differs from canonical release files');
  }

  assertBoundedPublicClosure(sourceManifest, sourceEvidence);
  const suppliedOptions = options as BoundedPublicServingClosureOptions | undefined;

  const outputParent = dirname(outputDirectory);
  await assertDirectoryIdentity(outputParent, outputParentIdentity);
  const projectionRoot = await mkdtemp(
    join(outputParent, `.${basename(outputDirectory)}.projection-`),
  );
  try {
    await assertDirectoryIdentity(outputParent, outputParentIdentity);
    const deploymentArtifacts = await materializeCdkPublicArtifacts(
      sourceRoot,
      projectionRoot,
      sourceManifest.artifacts,
    );
    // The public projection drops the restricted artifacts, so it must also drop
    // the sources that only those artifacts cited. The manifest's sourceIds are a
    // claim about what the bundle contains, and the immutable-release verifier
    // (packages/artifacts release manifest) fails closed unless sourceIds equals
    // the union of the present artifacts' lineage exactly. Copying the operator
    // manifest's full source list would declare sources whose data is absent from
    // every public artifact - both untrue and rejected at load. Recompute it from
    // the public artifacts actually being published.
    const publicSourceIds = Object.freeze(
      [
        ...new Set(
          deploymentArtifacts.flatMap((artifact) =>
            artifact.sourceLineage.map((lineage) => lineage.sourceId),
          ),
        ),
      ].sort((left, right) => left.localeCompare(right)),
    );
    const publicManifestPayload = Object.freeze({
      ...Object.fromEntries(
        Object.entries(sourceManifest).filter(
          ([key]) => key !== 'artifacts' && key !== 'manifestSha256' && key !== 'sourceIds',
        ),
      ),
      sourceIds: publicSourceIds,
      artifacts: Object.freeze(deploymentArtifacts),
    });
    const manifest = Object.freeze({
      ...publicManifestPayload,
      manifestSha256: sha256(Buffer.from(`${stableJson(publicManifestPayload)}\n`)),
    });
    const manifestBytes = Buffer.from(`${stableJson(manifest)}\n`);
    const manifestCid = rawCidV1Sha256(manifestBytes);
    const servingConfig = await createBoundedServingConfig(
      projectionRoot,
      sourceManifest,
      sourceEvidence,
      manifest,
      manifestCid,
    );
    await requireTrustedPublicLicenseApproval(
      suppliedOptions?.licenseTrust,
      Object.freeze({
        releaseId: sourceManifest.releaseId,
        runId: sourceManifest.runId,
        manifestSha256: manifest.manifestSha256,
      }),
      deploymentArtifacts,
    );
    await assertDirectoryIdentity(outputParent, outputParentIdentity);

    return await stagePublicServingClosure({
      sourceRoot: projectionRoot,
      outputDirectory,
      publicArtifacts: deploymentArtifacts,
      manifestBytes,
      manifestSha256: manifest.manifestSha256,
      manifestCid,
      servingConfig,
      outputParentIdentity,
    });
  } finally {
    if (await directoryIdentityMatches(outputParent, outputParentIdentity)) {
      await rm(projectionRoot, { recursive: true, force: true });
    }
  }
}

function createP8ServingConfig(
  sourceManifest: RealCountyPortableManifest,
  manifest: Readonly<{ manifestSha256: string }>,
  manifestCid: string,
): Readonly<Record<string, unknown>> {
  const denominator = 19;
  const unsupportedOwnershipLimitation =
    'The accepted public snapshot contains no redistributable ownership-transfer evidence.';
  const unknownFeatureLimitation =
    'The accepted public snapshot supports property identity only; this criterion remains unknown.';
  const capabilities = Object.fromEntries(
    OWNER_FREE_FEATURES.map((criterion) => [
      criterion,
      Object.freeze({
        state: 'blocked',
        supportClasses: Object.freeze([
          criterion === 'ownership_age' || criterion === 'regional_owner'
            ? 'unsupported'
            : 'unknown',
        ]),
        numerator: 0,
        denominator,
        limitations: Object.freeze([
          criterion === 'ownership_age' || criterion === 'regional_owner'
            ? unsupportedOwnershipLimitation
            : unknownFeatureLimitation,
        ]),
      }),
    ]),
  );
  return Object.freeze({
    manifestRelativePath: MANIFEST_FILE,
    expected: Object.freeze({
      releaseId: OWNER_FREE_RELEASE_ID,
      runId: ACCEPTED_P7_RUN_ID,
      manifestSha256: manifest.manifestSha256,
      manifestCid,
      asOf: sourceManifest.generatedAt,
      schemaVersion: sourceManifest.contractVersion,
      policyVersion: 'owner-free-public-serving@1.0.0',
    }),
    rankingWeights: Object.freeze(
      OWNER_FREE_FEATURES.map((criterion) =>
        Object.freeze({ criterion, weight: 1, proxyMultiplier: 0.5 }),
      ),
    ),
    capabilities: Object.freeze(capabilities),
    limitations: Object.freeze([
      'Bounded San Jose permit pilot: 19 distinct APNs from 34 non-null APN observations in 50 accepted ACTIVE rows.',
      'County completion is false; no criterion has a positive public fact in this release.',
      'Owner, applicant, contractor, address, contact, raw payload, and restricted comparison bytes are absent.',
    ]),
  });
}

async function stagePublicServingClosure(
  input: Readonly<{
    sourceRoot: string;
    outputDirectory: string;
    publicArtifacts: readonly Pick<
      BoundedPortableReleaseArtifact,
      'relation' | 'relativePath' | 'byteSize' | 'sha256'
    >[];
    manifestBytes: Uint8Array;
    manifestSha256: string;
    manifestCid: string;
    servingConfig: Readonly<Record<string, unknown>>;
    outputParentIdentity: DirectoryIdentity;
  }>,
): Promise<PublicServingClosure> {
  const {
    sourceRoot,
    outputDirectory,
    publicArtifacts,
    manifestBytes,
    manifestSha256,
    manifestCid,
    servingConfig,
    outputParentIdentity,
  } = input;
  await assertPathAbsent(outputDirectory);
  const outputParent = dirname(outputDirectory);
  await assertDirectoryIdentity(outputParent, outputParentIdentity);
  const staging = await mkdtemp(join(outputParent, `.${basename(outputDirectory)}.tmp-`));
  try {
    await assertDirectoryIdentity(outputParent, outputParentIdentity);
    await mkdir(join(staging, 'public'), { recursive: true });
    await writeFile(join(staging, MANIFEST_FILE), manifestBytes, { flag: 'wx' });
    await writeCanonicalCreateOnly(join(staging, 'serving-config.json'), servingConfig);
    for (const artifact of publicArtifacts) {
      const sourcePath = await verifiedRegularFile(sourceRoot, artifact.relativePath);
      const targetPath = resolveInside(staging, artifact.relativePath);
      await copyFile(sourcePath, targetPath, 1);
      const copied = await hashRegularFile(targetPath);
      if (copied.byteSize !== artifact.byteSize || copied.sha256 !== artifact.sha256) {
        throw new ReleaseParityError(`Deployment artifact drifted: ${artifact.relation}`);
      }
    }
    const stagedFiles = await releaseFiles(staging);
    const expectedFiles = [
      MANIFEST_FILE,
      'serving-config.json',
      ...OWNER_FREE_PUBLIC_RELATIONS.map(
        (relation) => `public/${SERVING_RELATIONS[relation].fileName}`,
      ),
    ].sort();
    if (stableJson(stagedFiles) !== stableJson(expectedFiles)) {
      throw new ReleaseSegregationError('Deployment closure is not the exact nine-file set');
    }
    await assertDirectoryIdentity(outputParent, outputParentIdentity);
    await rename(staging, outputDirectory);
  } catch (error) {
    if (!(await directoryIdentityMatches(outputParent, outputParentIdentity))) {
      throw new ReleaseSegregationError(
        'Output parent identity changed; unsafe temporary cleanup was refused',
      );
    }
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  return Object.freeze({
    outputDirectory,
    manifestSha256,
    manifestFileSha256: sha256(manifestBytes),
    manifestCid,
    publicArtifactCount: 7,
  });
}

function assertBoundedPublicClosure(
  manifest: BoundedServingReleaseManifest,
  evidence: BoundedServingReleaseEvidence,
): readonly BoundedPortableReleaseArtifact[] {
  if (evidence.releaseScope !== 'partial_county') {
    throw new ReleaseManifestError(
      'Generic bounded public closure requires exact partial_county release scope',
    );
  }
  const evidenceRecord = evidence as unknown as Readonly<Record<string, unknown>>;
  const gates = evidence.gates as unknown as Readonly<Record<string, unknown>>;
  if (
    gates.license !== 'passed' ||
    gates.manifest !== 'passed' ||
    gates.parquet !== 'passed' ||
    gates.cleanReopen !== 'passed' ||
    gates.publicRestrictedSegregation !== 'passed' ||
    gates.ownerBearingPublicValues !== 0 ||
    evidenceRecord.publicRestrictedValueOverlap !== 0 ||
    evidenceRecord.publicRelationCount !== 7 ||
    evidenceRecord.restrictedRelationCount !== 7 ||
    evidenceRecord.portableReopen !== 'passed' ||
    evidenceRecord.schemaOrder !== 'passed' ||
    evidenceRecord.rowOrder !== 'passed' ||
    evidenceRecord.immutableHashes !== 'passed'
  ) {
    throw new ReleasePrivacyError('Bounded release owner-free verification gates did not pass');
  }
  if (
    manifest.releaseId !== evidence.releaseId ||
    manifest.runId !== evidence.runId ||
    manifest.manifestSha256 !== evidence.manifestSha256
  ) {
    throw new ReleaseManifestError('Bounded manifest and evidence identities are mixed');
  }
  const evidenceArtifacts = manifest.artifacts.map(
    ({ relation, visibility, relativePath, rowCount, byteSize, sha256: hash }) => ({
      relation,
      visibility,
      relativePath,
      rowCount,
      byteSize,
      sha256: hash,
    }),
  );
  if (stableJson(evidence.artifacts) !== stableJson(evidenceArtifacts)) {
    throw new ReleaseManifestError('Bounded evidence artifact inventory differs from the manifest');
  }
  const expectedCatalogs = new Map<ServingVisibility, string>([
    ['public', 'public/oracle-public.duckdb'],
    ['restricted', 'restricted/oracle-restricted.duckdb'],
  ]);
  if (
    evidence.catalogs.length !== expectedCatalogs.size ||
    evidence.catalogs.some(
      ({ visibility, relativePath, relationCount }) =>
        expectedCatalogs.get(visibility) !== relativePath || (relationCount as unknown) !== 7,
    )
  ) {
    throw new ReleaseParityError('Bounded release portable catalog evidence is incomplete');
  }

  const publicArtifacts = manifest.artifacts.filter(({ visibility }) => visibility === 'public');
  const restrictedArtifacts = manifest.artifacts.filter(
    ({ visibility }) => visibility === 'restricted',
  );
  assertExactRelationInventory(publicArtifacts, 'public');
  assertExactRelationInventory(restrictedArtifacts, 'restricted');
  for (const artifact of publicArtifacts) assertPublicArtifactLineage(manifest, artifact);
  return Object.freeze(publicArtifacts);
}

async function requireTrustedPublicLicenseApproval(
  trust: BoundedPublicLicenseTrust | undefined,
  manifest: Readonly<{ releaseId: string; runId: string; manifestSha256: string }>,
  publicArtifacts: readonly Pick<ReleaseArtifact, 'relation' | 'relativePath' | 'sha256'>[],
): Promise<void> {
  if (trust === undefined || typeof trust.authorizePublicRelease !== 'function') {
    throw new ReleaseLicenseError(
      'Bounded public closure requires an explicit trusted license authorizer',
    );
  }
  assertSha256(trust.trustRootSha256, 'bounded public license trust root');
  let publicKey;
  try {
    publicKey = createPublicKey(trust.publicKeyPem);
  } catch {
    throw new ReleaseLicenseError('Bounded public license trust root is not a valid public key');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new ReleaseLicenseError(
      'Bounded public license trust root must be an Ed25519 public key',
    );
  }
  const actualTrustRootSha256 = sha256(publicKey.export({ format: 'der', type: 'spki' }));
  if (actualTrustRootSha256 !== trust.trustRootSha256) {
    throw new ReleaseLicenseError(
      'Bounded public license trust-root fingerprint does not match the supplied public key',
    );
  }
  const verificationInput = Object.freeze({
    authorizationVersion: 'bounded-public-serving-license@1.0.0' as const,
    trustRootSha256: actualTrustRootSha256,
    releaseId: manifest.releaseId,
    runId: manifest.runId,
    manifestSha256: manifest.manifestSha256,
    publicArtifactSha256s: Object.freeze(
      publicArtifacts
        .map(
          ({ relation, relativePath, sha256: artifactSha256 }) =>
            `${relation}:${relativePath}:${artifactSha256}`,
        )
        .sort(),
    ),
  } satisfies BoundedPublicLicenseVerificationInput);
  const signedApproval = await trust.authorizePublicRelease(verificationInput);
  if (signedApproval === null) {
    throw new ReleaseLicenseError('Trusted license authorizer denied this release');
  }
  const approval = signedApproval.authorization;
  const authorizationVersion: string = approval.authorizationVersion;
  const decision: string = approval.decision;
  if (
    authorizationVersion !== verificationInput.authorizationVersion ||
    approval.trustRootSha256 !== verificationInput.trustRootSha256 ||
    approval.releaseId !== verificationInput.releaseId ||
    approval.runId !== verificationInput.runId ||
    decision !== 'allowed_public' ||
    approval.policyVersion.trim().length === 0 ||
    approval.manifestSha256 !== verificationInput.manifestSha256 ||
    stableJson(approval.publicArtifactSha256s) !==
      stableJson(verificationInput.publicArtifactSha256s) ||
    approval.licenseSnapshotRefs.length === 0 ||
    approval.licenseSnapshotRefs.some((reference) => reference.trim().length === 0) ||
    new Set(approval.licenseSnapshotRefs).size !== approval.licenseSnapshotRefs.length
  ) {
    throw new ReleaseLicenseError('Trusted license authorizer did not approve this exact release');
  }
  const signature = strictBase64(signedApproval.signatureBase64, 'license authorization signature');
  if (
    signature.byteLength !== 64 ||
    !verifySignature(null, boundedPublicLicenseAuthorizationBytes(approval), publicKey, signature)
  ) {
    throw new ReleaseLicenseError('Trusted license authorization signature is invalid');
  }
}

function assertExactRelationInventory(
  artifacts: readonly BoundedPortableReleaseArtifact[],
  visibility: ServingVisibility,
): void {
  const relations = artifacts.map(({ relation }) => relation).sort();
  if (stableJson(relations) !== stableJson([...OWNER_FREE_PUBLIC_RELATIONS].sort())) {
    throw new ReleaseManifestError(
      `Bounded ${visibility} release must contain the exact seven serving relations`,
    );
  }
  for (const artifact of artifacts) {
    const expectedPath = `${visibility}/${SERVING_RELATIONS[artifact.relation].fileName}`;
    if (artifact.visibility !== visibility || artifact.relativePath !== expectedPath) {
      throw new ReleaseSegregationError(
        `Bounded ${visibility}/${artifact.relation} path is not canonical`,
      );
    }
    resolveInside('.', artifact.relativePath);
  }
}

function assertPublicArtifactLineage(
  manifest: BoundedServingReleaseManifest,
  artifact: BoundedPortableReleaseArtifact,
): void {
  if (artifact.sourceLineage.length === 0) {
    throw new ReleaseManifestError(`Public ${artifact.relation} has no source lineage`);
  }
  const identities = new Set<string>();
  for (const lineage of artifact.sourceLineage) {
    const lineageRecord = lineage as unknown as Readonly<Record<string, unknown>>;
    const identity = `${lineage.sourceId}\0${lineage.snapshotId}`;
    if (
      identities.has(identity) ||
      !manifest.sourceIds.includes(lineage.sourceId) ||
      lineage.snapshotId.trim().length === 0 ||
      (lineageRecord.role !== 'direct' && lineageRecord.role !== 'derived') ||
      lineage.contributors.length === 0 ||
      lineage.contributors.some((contributor) => contributor.trim().length === 0) ||
      new Set(lineage.contributors).size !== lineage.contributors.length
    ) {
      throw new ReleaseManifestError(`Public ${artifact.relation} lineage is malformed`);
    }
    assertSha256(lineage.sourceSha256, `${artifact.relation} source lineage hash`);
    assertSha256(lineage.schemaSha256, `${artifact.relation} schema lineage hash`);
    if (lineage.asOf !== null) assertInstant(lineage.asOf, `${artifact.relation} lineage asOf`);
    identities.add(identity);
  }
}

function toPrivacyArtifact(
  artifact: Pick<
    BoundedPortableReleaseArtifact,
    | 'relation'
    | 'relativePath'
    | 'visibility'
    | 'mediaType'
    | 'byteSize'
    | 'sha256'
    | 'rowCount'
    | 'schemaSha256'
    | 'columns'
    | 'nonNullCounts'
  >,
): BuiltServingArtifact {
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

async function materializeCdkPublicArtifacts(
  sourceRoot: string,
  projectionRoot: string,
  sourceArtifacts: readonly BoundedPortableReleaseArtifact[],
): Promise<readonly ReleaseArtifact[]> {
  await mkdir(join(projectionRoot, 'public'), { recursive: true });
  await mkdir(join(projectionRoot, 'restricted'), { recursive: true });
  for (const artifact of sourceArtifacts) {
    const sourcePath = await verifiedRegularFile(sourceRoot, artifact.relativePath);
    const targetPath = resolveInside(projectionRoot, artifact.relativePath);
    await copyFile(sourcePath, targetPath, 1);
    const copied = await hashRegularFile(targetPath);
    if (copied.byteSize !== artifact.byteSize || copied.sha256 !== artifact.sha256) {
      throw new ReleaseParityError(`Operator artifact changed while copying: ${artifact.relation}`);
    }
  }
  await rejectReleaseSymlinks(sourceRoot);

  const instance = await DuckDBInstance.create(':memory:', { threads: '1' });
  const connection = await instance.connect();
  const artifacts: ReleaseArtifact[] = [];
  try {
    for (const artifact of sourceArtifacts.filter(({ visibility }) => visibility === 'public')) {
      const targetPath = resolveInside(projectionRoot, artifact.relativePath);
      if (artifact.relation !== 'property_query' && artifact.relation !== 'data_dictionary') {
        artifacts.push(toRuntimePublicArtifact(artifact));
        continue;
      }

      const definition = SERVING_RELATIONS[artifact.relation];
      const columns = definition.columns.map(({ name }) => quoteIdentifier(name)).join(', ');
      const predicate =
        artifact.relation === 'data_dictionary'
          ? " WHERE NOT (relation_name = 'property_query' AND column_name IN ('source_ids_json', 'field_source_ids_json'))"
          : '';
      const order = definition.sortColumns.map(quoteIdentifier).join(', ');
      const projectedPath = `${targetPath}.projected`;
      await connection.run(
        `COPY (SELECT ${columns} FROM read_parquet('${sqlPath(targetPath)}')${predicate} ORDER BY ${order}) TO '${sqlPath(projectedPath)}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 122880)`,
      );
      await rm(targetPath);
      await rename(projectedPath, targetPath);
      const file = await hashRegularFile(targetPath);
      const rowCount = await scalarCount(
        connection,
        `SELECT count(*)::BIGINT AS count FROM read_parquet('${sqlPath(targetPath)}')`,
      );
      const nonNullSelections = definition.columns
        .map(({ name }) => `count(${quoteIdentifier(name)})::BIGINT AS ${quoteIdentifier(name)}`)
        .join(', ');
      const nonNullResult = await connection.runAndReadAll(
        `SELECT ${nonNullSelections} FROM read_parquet('${sqlPath(targetPath)}')`,
      );
      const nonNullRow = nonNullResult.getRowObjects()[0];
      if (nonNullRow === undefined) {
        throw new ReleaseParityError(`Projected artifact counts are absent: ${artifact.relation}`);
      }
      const nonNullCounts = Object.fromEntries(
        definition.columns.map(({ name }) => {
          const count = Number(nonNullRow[name]);
          if (!Number.isSafeInteger(count) || count < 0 || count > rowCount) {
            throw new ReleaseParityError(
              `Projected artifact count is invalid: ${artifact.relation}.${name}`,
            );
          }
          return [name, count];
        }),
      );
      artifacts.push(
        toRuntimePublicArtifact(artifact, {
          ...artifact,
          byteSize: file.byteSize,
          sha256: file.sha256,
          rowCount,
          schemaSha256: sha256(Buffer.from(stableJson(definition.columns))),
          columns: definition.columns,
          nonNullCounts: Object.freeze(nonNullCounts),
          grain: definition.grain,
        }),
      );
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  const frozen = Object.freeze(artifacts);
  await verifyServingArtifacts(projectionRoot, frozen.map(toPrivacyArtifact));
  const restrictedArtifacts = sourceArtifacts
    .filter(({ visibility }) => visibility === 'restricted')
    .map(toPrivacyArtifact);
  const privacy = await verifyPublicRestrictedPrivacy(projectionRoot, [
    ...frozen.map(toPrivacyArtifact),
    ...restrictedArtifacts,
  ]);
  if (privacy.ownerBearingPublicValues !== 0) {
    throw new ReleasePrivacyError(
      `Final public projection intersects ${privacy.ownerBearingPublicValues} restricted value hashes`,
    );
  }
  return frozen;
}

function toRuntimePublicArtifact(
  source: BoundedPortableReleaseArtifact,
  values: BoundedPortableReleaseArtifact = source,
): ReleaseArtifact {
  return Object.freeze({
    relation: values.relation,
    relativePath: values.relativePath,
    visibility: values.visibility,
    mediaType: values.mediaType,
    byteSize: values.byteSize,
    sha256: values.sha256,
    rowCount: values.rowCount,
    schemaSha256: values.schemaSha256,
    columns: values.columns,
    nonNullCounts: values.nonNullCounts,
    grain: values.grain,
    sourceLineage: Object.freeze(
      source.sourceLineage.map(({ sourceId, snapshotId, sourceSha256, schemaSha256, asOf, role }) =>
        Object.freeze({ sourceId, snapshotId, sourceSha256, schemaSha256, asOf, role }),
      ),
    ),
    limitations: values.limitations,
  });
}

const FEATURE_SUPPORT_COLUMNS = Object.freeze({
  roof_age: 'roof_support_class',
  water_view_candidate: 'water_support_class',
  ownership_age: 'ownership_support_class',
  regional_owner: 'regional_owner_support_class',
  transit_walkability: 'transit_support_class',
  starbucks_walkability: 'starbucks_support_class',
} as const satisfies Readonly<Record<OwnerFreeFeature, string>>);

async function createBoundedServingConfig(
  projectionRoot: string,
  sourceManifest: BoundedServingReleaseManifest,
  sourceEvidence: BoundedServingReleaseEvidence,
  manifest: Readonly<{ manifestSha256: string }>,
  manifestCid: string,
): Promise<Readonly<Record<string, unknown>>> {
  const propertyPath = await verifiedRegularFile(projectionRoot, 'public/property-query.parquet');
  const pipelinePath = await verifiedRegularFile(projectionRoot, 'public/pipeline-runs.parquet');
  const instance = await DuckDBInstance.create(':memory:', { threads: '1' });
  const connection = await instance.connect();
  try {
    const matchingRuns = await scalarCount(
      connection,
      `SELECT count(*)::BIGINT AS count FROM read_parquet('${sqlPath(pipelinePath)}') WHERE run_id = '${sqlLiteral(sourceManifest.runId)}' AND status = '${sqlLiteral(sourceEvidence.runStatus)}'`,
    );
    if (matchingRuns !== 1) {
      throw new ReleaseManifestError(
        'Pipeline run rows are mixed with the bounded release identity',
      );
    }
    const propertyArtifact = sourceManifest.artifacts.find(
      ({ visibility, relation }) => visibility === 'public' && relation === 'property_query',
    );
    if (propertyArtifact === undefined) {
      throw new ReleaseCompletenessError('Bounded release has no public property relation');
    }
    const capabilities = Object.fromEntries(
      await Promise.all(
        OWNER_FREE_FEATURES.map(async (criterion) => {
          const column = quoteIdentifier(FEATURE_SUPPORT_COLUMNS[criterion]);
          const grouped = await connection.runAndReadAll(
            `SELECT ${column} AS support_class, count(*)::BIGINT AS count FROM read_parquet('${sqlPath(propertyPath)}') GROUP BY ${column} ORDER BY ${column}`,
          );
          const counts = new Map<string, number>();
          for (const row of grouped.getRowObjects()) {
            const supportClass = row.support_class;
            const count = Number(row.count);
            if (
              typeof supportClass !== 'string' ||
              !['supported', 'proxy', 'unknown', 'unsupported'].includes(supportClass) ||
              !Number.isSafeInteger(count) ||
              count < 0
            ) {
              throw new ReleaseCompletenessError(
                `Public ${criterion} support-class coverage is invalid`,
              );
            }
            counts.set(supportClass, count);
          }
          const observed = [...counts.values()].reduce((total, count) => total + count, 0);
          if (observed !== propertyArtifact.rowCount) {
            throw new ReleaseParityError(`Public ${criterion} coverage denominator drifted`);
          }
          const denominator = propertyArtifact.rowCount;
          const numerator = counts.get('supported') ?? 0;
          const positive = numerator + (counts.get('proxy') ?? 0);
          const state =
            denominator > 0 && numerator === denominator
              ? ('supported' as const)
              : positive > 0
                ? ('partial' as const)
                : ('blocked' as const);
          const supportClasses =
            counts.size === 0
              ? Object.freeze(['unknown'])
              : Object.freeze([...counts.keys()].sort());
          const limitations =
            state === 'supported'
              ? Object.freeze([])
              : Object.freeze([
                  state === 'partial'
                    ? `Public ${criterion} evidence is partial in bounded release ${sourceManifest.releaseId}.`
                    : `No supported or proxy public ${criterion} evidence is present in bounded release ${sourceManifest.releaseId}.`,
                ]);
          return [
            criterion,
            Object.freeze({ state, supportClasses, numerator, denominator, limitations }),
          ] as const;
        }),
      ),
    );

    return Object.freeze({
      manifestRelativePath: MANIFEST_FILE,
      expected: Object.freeze({
        releaseId: sourceManifest.releaseId,
        runId: sourceManifest.runId,
        manifestSha256: manifest.manifestSha256,
        manifestCid,
        asOf: sourceManifest.generatedAt,
        schemaVersion: sourceManifest.contractVersion,
        policyVersion: 'owner-free-public-serving@1.0.0',
      }),
      rankingWeights: Object.freeze(
        OWNER_FREE_FEATURES.map((criterion) =>
          Object.freeze({ criterion, weight: 1, proxyMultiplier: 0.5 }),
        ),
      ),
      capabilities: Object.freeze(capabilities),
      limitations: Object.freeze([
        `Verified ${sourceEvidence.releaseScope} bounded release; run status ${sourceEvidence.runStatus}.`,
        'Restricted artifacts, operator evidence, catalogs, and checkpoints are absent from this public closure.',
      ]),
    });
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

function assertDistinctReleaseRoots(sourceRoot: string, outputDirectory: string): void {
  if (
    sourceRoot === outputDirectory ||
    isInside(sourceRoot, outputDirectory) ||
    isInside(outputDirectory, sourceRoot)
  ) {
    throw new ReleaseSegregationError('Source and public closure directories must be disjoint');
  }
}

type DirectoryIdentity = Readonly<{
  device: string;
  inode: string;
  realPath: string;
}>;

async function prepareRealOutputParent(outputDirectory: string): Promise<DirectoryIdentity> {
  await assertPathAncestorsAreReal(outputDirectory);
  const parent = dirname(outputDirectory);
  await mkdir(parent, { recursive: true });
  await assertPathAncestorsAreReal(parent);
  return directoryIdentity(parent);
}

async function assertPathAncestorsAreReal(path: string): Promise<void> {
  const ancestors: string[] = [];
  let cursor = resolve(path);
  for (;;) {
    ancestors.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const ancestor of ancestors.reverse()) {
    let metadata;
    try {
      metadata = await lstat(ancestor);
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new ReleaseSegregationError(`Symlink or junction ancestor is prohibited: ${ancestor}`);
    }
    const actual = await realpath(ancestor);
    if (normalizedFilesystemPath(actual) !== normalizedFilesystemPath(ancestor)) {
      throw new ReleaseSegregationError(`Reparse ancestor is prohibited: ${ancestor}`);
    }
  }
}

async function directoryIdentity(path: string): Promise<DirectoryIdentity> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new ReleaseSegregationError(`Output parent must remain a real directory: ${path}`);
  }
  return Object.freeze({
    device: String(metadata.dev),
    inode: String(metadata.ino),
    realPath: normalizedFilesystemPath(await realpath(path)),
  });
}

async function assertDirectoryIdentity(path: string, expected: DirectoryIdentity): Promise<void> {
  const current = await directoryIdentity(path);
  if (stableJson(current) !== stableJson(expected)) {
    throw new ReleaseSegregationError('Output parent identity changed during closure staging');
  }
}

async function directoryIdentityMatches(
  path: string,
  expected: DirectoryIdentity,
): Promise<boolean> {
  try {
    return stableJson(await directoryIdentity(path)) === stableJson(expected);
  } catch {
    return false;
  }
}

function normalizedFilesystemPath(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isMissingPathError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as Readonly<{ code?: unknown }>).code === 'ENOENT'
  );
}

async function rejectReleaseSymlinks(root: string): Promise<void> {
  const rootEntry = await lstat(root);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new ReleaseSegregationError('Operator release root must be a real directory');
  }
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new ReleaseSegregationError(
          `Symlinks are prohibited in operator releases: ${entry.name}`,
        );
      }
      if (metadata.isDirectory()) await visit(path);
      else if (!metadata.isFile()) {
        throw new ReleaseSegregationError(`Unsupported operator release entry: ${entry.name}`);
      }
    }
  };
  await visit(root);
}

async function verifiedRegularFile(root: string, relativePath: string): Promise<string> {
  const path = resolveInside(root, relativePath);
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new ReleaseSegregationError(`Release entry must be a regular file: ${relativePath}`);
  }
  const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)]);
  if (!isInside(realRoot, realPath)) {
    throw new ReleaseSegregationError(`Release entry escapes its root: ${relativePath}`);
  }
  return path;
}

async function hashRegularFile(
  path: string,
): Promise<Readonly<{ byteSize: number; sha256: string }>> {
  const hash = createHash('sha256');
  let byteSize = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(bytes);
    byteSize += bytes.byteLength;
  }
  return Object.freeze({ byteSize, sha256: hash.digest('hex') });
}

async function releaseFiles(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new ReleaseSegregationError(`Symlink entered staged closure: ${relativePath}`);
    }
    if (entry.isDirectory()) files.push(...(await releaseFiles(root, relativePath)));
    else if (entry.isFile()) files.push(relativePath);
    else throw new ReleaseSegregationError(`Unsupported staged entry: ${relativePath}`);
  }
  return files.sort();
}

function acceptedPipelineManifest(value: unknown): AcceptedPipelineManifest {
  const record = objectRecord(value, 'pipeline manifest');
  const sources = record.sources;
  const artifacts = record.artifacts;
  if (!Array.isArray(sources) || !Array.isArray(artifacts)) {
    throw new ReleaseManifestError('Pipeline manifest source/artifact inventories are invalid');
  }
  return Object.freeze({
    runId: requiredString(record.runId, 'pipeline manifest runId'),
    profile: requiredString(record.profile, 'pipeline manifest profile'),
    status: requiredString(record.status, 'pipeline manifest status'),
    completedAt: requiredString(record.completedAt, 'pipeline manifest completedAt'),
    sources: Object.freeze(sources.map((item) => objectRecord(item, 'pipeline source'))),
    artifacts: Object.freeze(artifacts.map((item) => objectRecord(item, 'pipeline artifact'))),
  });
}

function acceptedPipelineMart(
  value: unknown,
): Readonly<{ portableReleaseInput: Omit<RealCountyReleaseInput, 'outputDirectory'> }> {
  const record = objectRecord(value, 'pipeline mart');
  if (record.format !== 'oracle-real-county-portable-release-input-v1') {
    throw new ReleaseManifestError('Pipeline mart format is not the accepted real-county format');
  }
  const input = objectRecord(record.portableReleaseInput, 'portable release input');
  return Object.freeze({
    portableReleaseInput: input as Omit<RealCountyReleaseInput, 'outputDirectory'>,
  });
}

function acceptedMutations(value: unknown): readonly AcceptedMutation[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ReleaseManifestError('Normalized source artifact must be a non-empty mutation array');
  }
  return Object.freeze(value.map((item) => objectRecord(item, 'normalized mutation')));
}

function acceptedRawReceipt(value: unknown): Readonly<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new ReleaseManifestError('Accepted acquisition receipt must contain one ACTIVE artifact');
  }
  return objectRecord(value[0], 'raw source artifact receipt');
}

function validateAcceptedSanJoseArtifacts(
  input: Readonly<{
    pipelineManifest: AcceptedPipelineManifest;
    pipelineMart: Readonly<{
      portableReleaseInput: Omit<RealCountyReleaseInput, 'outputDirectory'>;
    }>;
    mutations: readonly AcceptedMutation[];
    pipelineMartSha256: string;
    mutationSha256: string;
    rawSha256: string;
    rawByteSize: number;
    acquisitionReceiptSha256: string;
    receipt: Readonly<Record<string, unknown>>;
  }>,
): Readonly<{
  intentSnapshotId: string;
  observedSnapshotId: string;
  sourceAsOf: string;
  retrievedAt: string;
  rawSha256: string;
  mutationSha256: string;
}> {
  const { pipelineManifest: manifest, pipelineMart } = input;
  const release = pipelineMart.portableReleaseInput;
  if (
    manifest.runId !== ACCEPTED_P7_RUN_ID ||
    input.pipelineMartSha256 !== ACCEPTED_P7_MART_SHA256 ||
    input.mutationSha256 !== ACCEPTED_P7_MUTATION_SHA256 ||
    input.acquisitionReceiptSha256 !== ACCEPTED_P7_ACQUISITION_RECEIPT_SHA256 ||
    input.rawSha256 !== ACCEPTED_P7_RAW_SHA256 ||
    manifest.profile !== 'pilot' ||
    manifest.status !== 'partial' ||
    release.releaseScope !== 'pilot' ||
    manifest.runId !== release.build.runId ||
    manifest.completedAt !== ACCEPTED_P7_MANIFEST_COMPLETED_AT ||
    release.build.generatedAt !== ACCEPTED_P7_MART_GENERATED_AT
  ) {
    throw new ReleaseManifestError(
      'Pipeline manifest and accepted pilot mart are not release-bound',
    );
  }
  assertInstant(manifest.completedAt, 'pipeline manifest completedAt');
  const martArtifact = manifest.artifacts.find(({ phase }) => phase === 'build_marts');
  if (martArtifact?.sha256 !== input.pipelineMartSha256) {
    throw new ReleaseManifestError('Pipeline mart bytes differ from the accepted p7 manifest');
  }
  const source = manifest.sources.find(({ sourceId }) => sourceId === SAN_JOSE_SOURCE_ID);
  if (source === undefined) throw new ReleaseLicenseError('Accepted p7 has no San Jose source');
  const sourceLicense = objectRecord(source.license, 'San Jose source license');
  if (
    source.capability !== 'san_jose_permits' ||
    source.terminalState !== 'partial' ||
    sourceLicense.redistribution !== 'approved' ||
    sourceLicense.containsPersonalData !== true
  ) {
    throw new ReleaseLicenseError('Accepted San Jose source rights/state do not permit projection');
  }
  const snapshotIdentity = objectRecord(source.snapshotIdentity, 'San Jose snapshot identity');
  const intentSnapshotId = requiredString(snapshotIdentity.intentId, 'intent snapshot ID');
  const observedSnapshotId = requiredString(
    snapshotIdentity.observedContentId,
    'observed snapshot ID',
  );
  if (snapshotIdentity.method !== 'configured_intent_plus_observed_content_v1') {
    throw new ReleaseManifestError('San Jose configured-to-observed snapshot mapping is absent');
  }
  const sourceAsOf = requiredString(source.sourceAsOf, 'San Jose source as-of');
  assertInstant(sourceAsOf, 'San Jose source as-of');
  const sourceArtifacts = source.artifacts;
  if (!Array.isArray(sourceArtifacts))
    throw new ReleaseManifestError('San Jose artifacts are absent');
  const normalized = sourceArtifacts
    .map((item) => objectRecord(item, 'San Jose artifact'))
    .find(({ phase }) => phase === 'normalize');
  const acquired = sourceArtifacts
    .map((item) => objectRecord(item, 'San Jose artifact'))
    .find(({ phase }) => phase === 'acquire');
  if (normalized?.sha256 !== input.mutationSha256) {
    throw new ReleaseManifestError('San Jose normalized mutations differ from accepted p7');
  }
  if (acquired?.sha256 !== input.acquisitionReceiptSha256) {
    throw new ReleaseManifestError('San Jose acquisition receipt differs from accepted p7');
  }
  const gate = release.sourceSnapshots.find(({ sourceId }) => sourceId === SAN_JOSE_SOURCE_ID);
  const schemaHashes = source.schemaHashes;
  if (
    gate === undefined ||
    intentSnapshotId !== ACCEPTED_P7_INTENT_SNAPSHOT_ID ||
    observedSnapshotId !== ACCEPTED_P7_OBSERVED_SNAPSHOT_ID ||
    source.sourceHash !== ACCEPTED_P7_SOURCE_SHA256 ||
    sourceAsOf !== ACCEPTED_P7_SOURCE_AS_OF ||
    gate.snapshotId !== observedSnapshotId ||
    gate.sourceSha256 !== source.sourceHash ||
    gate.publicProjectionPermission !== 'allowed' ||
    gate.privateUsePermission !== 'allowed' ||
    !gate.containsOwnerData ||
    !Array.isArray(schemaHashes) ||
    schemaHashes.length !== 1 ||
    gate.schemaSha256 !== schemaHashes[0]
  ) {
    throw new ReleaseLicenseError(
      'San Jose release gate is not bound to the accepted source snapshot',
    );
  }
  const request = objectRecord(input.receipt.request, 'acquisition request');
  const response = objectRecord(input.receipt.response, 'acquisition response');
  const schemaFingerprint = objectRecord(
    input.receipt.schemaFingerprint,
    'acquisition schema fingerprint',
  );
  const sourceAsOfReceipt = objectRecord(input.receipt.sourceAsOf, 'acquisition source as-of');
  const retrievedAt = requiredString(input.receipt.retrievedAt, 'raw source retrieval time');
  assertInstant(retrievedAt, 'raw source retrieval time');
  if (
    retrievedAt !== ACCEPTED_P7_RETRIEVED_AT ||
    input.receipt.sha256 !== input.rawSha256 ||
    input.receipt.byteSize !== input.rawByteSize ||
    input.receipt.mediaType !== 'text/csv' ||
    input.receipt.artifactId !== `sc:artifact:sha256:${input.rawSha256}` ||
    input.receipt.licenseSnapshotRef !==
      `sc:license:san-jose-building-permits:${SAN_JOSE_CC0_TERMS_SHA256}` ||
    input.receipt.snapshotId !== intentSnapshotId ||
    input.receipt.sourceId !== SAN_JOSE_SOURCE_ID ||
    input.receipt.visibility !== 'public' ||
    request.method !== 'GET' ||
    request.requestKey !== 'active' ||
    request.url !== SAN_JOSE_ACTIVE_SOURCE_URL ||
    response.finalUrl !== SAN_JOSE_ACTIVE_SOURCE_URL ||
    response.httpStatus !== 200 ||
    response.lastModified !== ACCEPTED_P7_SOURCE_AS_OF ||
    sourceAsOfReceipt.at !== ACCEPTED_P7_SOURCE_AS_OF ||
    sourceAsOfReceipt.state !== 'reported' ||
    schemaFingerprint.value !== ACCEPTED_P7_SCHEMA_SHA256
  ) {
    throw new ReleaseManifestError(
      'Raw San Jose receipt does not bind the accepted CC0 ACTIVE CSV',
    );
  }
  const rawArtifactId = `sc:artifact:sha256:${input.rawSha256}`;
  for (const mutation of input.mutations) {
    if (
      mutation.runId !== manifest.runId ||
      mutation.sourceId !== SAN_JOSE_SOURCE_ID ||
      mutation.snapshotId !== intentSnapshotId
    ) {
      throw new ReleaseManifestError(
        'Normalized mutation escaped the accepted San Jose run/snapshot',
      );
    }
    const observation =
      mutation.kind === 'field_observation'
        ? objectRecord(mutation.observation, 'observation')
        : null;
    const entity =
      mutation.kind === 'entity_upsert' ? objectRecord(mutation.entity, 'entity') : null;
    const entityLineage: unknown = entity?.lineage;
    const lineage =
      observation?.lineage ??
      (Array.isArray(entityLineage) ? (entityLineage[0] as unknown) : undefined);
    if (lineage !== undefined) {
      const lineageRecord = objectRecord(lineage, 'mutation lineage');
      const sourceRecord = objectRecord(lineageRecord.sourceRecord, 'source record');
      if (
        sourceRecord.artifactId !== rawArtifactId ||
        sourceRecord.sourceId !== SAN_JOSE_SOURCE_ID ||
        sourceRecord.snapshotId !== intentSnapshotId
      ) {
        throw new ReleaseManifestError('Mutation lineage is not bound to the accepted raw CSV');
      }
    }
  }
  return Object.freeze({
    intentSnapshotId,
    observedSnapshotId,
    sourceAsOf,
    retrievedAt,
    rawSha256: input.rawSha256,
    mutationSha256: input.mutationSha256,
  });
}

function publicIdentityObservations(
  mutations: readonly AcceptedMutation[],
  intentSnapshotId: string,
): readonly PublicIdentityObservation[] {
  const grouped = new Map<
    string,
    {
      propertyId: string;
      apn: string;
      observations: { observationId: string; sourceRecord: Readonly<Record<string, unknown>> }[];
    }
  >();
  for (const mutation of mutations) {
    if (mutation.kind !== 'field_observation' || mutation.visibility !== 'public') continue;
    const observation = objectRecord(mutation.observation, 'public APN observation');
    if (observation.fieldPath !== '/source/normalized_apn') continue;
    if (observation.value === null) continue;
    const apn = requiredString(observation.value, 'normalized APN');
    if (!/^\d{8}$/u.test(apn)) {
      throw new ReleaseCompletenessError(
        'Public normalized APN does not match the frozen 8-digit contract',
      );
    }
    const lineage = objectRecord(observation.lineage, 'public APN lineage');
    const sourceRecord = objectRecord(lineage.sourceRecord, 'public APN source record');
    if (sourceRecord.snapshotId !== intentSnapshotId) {
      throw new ReleaseManifestError('Public APN observation snapshot identity drifted');
    }
    const observationId = requiredString(observation.observationId, 'APN observation ID');
    const canonicalApn = `${apn.slice(0, 3)}-${apn.slice(3, 5)}-${apn.slice(5)}`;
    const propertyId = `sc:entity:property:${sha256(
      Buffer.from(`santa-clara-ca|apn|${canonicalApn}`),
    )}`;
    const existing = grouped.get(canonicalApn) ?? {
      propertyId,
      apn: canonicalApn,
      observations: [],
    };
    existing.observations.push({ observationId, sourceRecord });
    grouped.set(canonicalApn, existing);
  }
  return Object.freeze(
    [...grouped.values()]
      .sort((left, right) => left.propertyId.localeCompare(right.propertyId))
      .map((identity) =>
        Object.freeze({
          ...identity,
          observations: Object.freeze(
            identity.observations
              .sort((left, right) => left.observationId.localeCompare(right.observationId))
              .map((item) => Object.freeze(item)),
          ),
        }),
      ),
  );
}

function restrictedComparisonObservations(
  mutations: readonly AcceptedMutation[],
  intentSnapshotId: string,
): readonly RestrictedComparisonObservation[] {
  const sensitivePaths = new Set([
    '/source/owner_text',
    '/source/applicant_text',
    '/source/contractor_text',
  ]);
  const selected: RestrictedComparisonObservation[] = [];
  for (const mutation of mutations) {
    if (mutation.kind !== 'field_observation') continue;
    const observation = objectRecord(mutation.observation, 'sensitive observation');
    const fieldPath = String(observation.fieldPath);
    if (!sensitivePaths.has(fieldPath)) continue;
    const wrapped = objectRecord(observation.value, 'sensitive observation value');
    if (wrapped.text === null) continue;
    const value = requiredString(wrapped.text, 'sensitive observation text').trim();
    if (value.length === 0) continue;
    const expectedVisibility =
      fieldPath === '/source/contractor_text' ? 'authenticated' : 'restricted';
    if (
      mutation.visibility !== expectedVisibility ||
      observation.visibility !== expectedVisibility
    ) {
      throw new ReleasePrivacyError('Sensitive San Jose text has an unexpected visibility class');
    }
    const lineage = objectRecord(observation.lineage, 'sensitive observation lineage');
    const sourceRecord = objectRecord(lineage.sourceRecord, 'sensitive source record');
    if (sourceRecord.snapshotId !== intentSnapshotId) {
      throw new ReleaseManifestError('Sensitive observation snapshot identity drifted');
    }
    selected.push(
      Object.freeze({
        observationId: requiredString(observation.observationId, 'sensitive observation ID'),
        fieldPath,
        value,
        observedAt: requiredString(observation.observedAt, 'sensitive observation observedAt'),
        sourceAsOf: requiredString(observation.sourceAsOf, 'sensitive observation sourceAsOf'),
        sourceRecord,
      }),
    );
  }
  return Object.freeze(
    selected.sort((left, right) => left.observationId.localeCompare(right.observationId)),
  );
}

function ownerFreePropertyRows(
  identities: readonly PublicIdentityObservation[],
): readonly ServingRow[] {
  return Object.freeze(
    identities.map(({ propertyId, apn }) =>
      Object.freeze({
        property_id: propertyId,
        parcel_identifier: apn,
        address_street: null,
        address_city: null,
        address_zip: null,
        latitude: null,
        longitude: null,
        roof_support_class: 'unknown',
        roof_age_years: null,
        roof_reference_date: null,
        water_support_class: 'unknown',
        water_distance_meters: null,
        water_visibility_state: null,
        ownership_support_class: 'unsupported',
        years_since_exchange: null,
        last_exchange_date: null,
        regional_owner_support_class: 'unsupported',
        is_regional_owner: null,
        transit_support_class: 'unknown',
        transit_distance_meters: null,
        transit_walk_minutes: null,
        starbucks_support_class: 'unknown',
        starbucks_distance_meters: null,
        starbucks_walk_minutes: null,
        combined_review_score: null,
        evidence_coverage: 0,
        visibility: 'public',
      }),
    ),
  );
}

function ownerFreeEvidenceRows(
  identities: readonly PublicIdentityObservation[],
  context: Readonly<Record<string, unknown>>,
): readonly ServingRow[] {
  return Object.freeze(
    identities.flatMap((identity) =>
      OWNER_FREE_FEATURES.map((feature) => {
        const supportClass = ownerFreeFeatureSupport(feature);
        const sourceReferences = identity.observations.map(({ observationId, sourceRecord }) =>
          Object.freeze({
            role: 'property_identity_only',
            observationId,
            sourceId: sourceRecord.sourceId,
            intentSnapshotId: context.intentSnapshotId,
            observedSnapshotId: context.observedSnapshotId,
            artifactId: sourceRecord.artifactId,
            recordKey: sourceRecord.recordKey,
            recordSha256: sourceRecord.recordSha256,
            fieldPath: '/source/normalized_apn',
            sourceUrl: context.sourceUrl,
            retrievedAt: context.retrievedAt,
            sourceAsOf: context.sourceAsOf,
            rawArtifactSha256: context.rawArtifactSha256,
            normalizedArtifactSha256: context.normalizedArtifactSha256,
            license: context.license,
            licenseTermsSha256: context.licenseTermsSha256,
            attribution: context.attribution,
          }),
        );
        const limitations = ownerFreeFeatureLimitations(feature);
        return Object.freeze({
          evidence_id: `sc:evidence:${sha256(Buffer.from(`${OWNER_FREE_RELEASE_ID}|${identity.propertyId}|${feature}`))}`,
          property_id: identity.propertyId,
          feature,
          support_class: supportClass,
          confidence: 0,
          as_of: String(context.sourceAsOf),
          algorithm_name: 'owner-free-public-projection',
          algorithm_version: '1.0.0',
          value_json: 'null',
          source_ids_json: canonicalStableJson([SAN_JOSE_SOURCE_ID]),
          source_references_json: canonicalStableJson(sourceReferences),
          limitations_json: canonicalStableJson(limitations),
          visibility: 'public',
        });
      }),
    ),
  );
}

function ownerFreeFeatureSupport(feature: OwnerFreeFeature): 'unknown' | 'unsupported' {
  return feature === 'ownership_age' || feature === 'regional_owner' ? 'unsupported' : 'unknown';
}

function ownerFreeFeatureLimitations(feature: OwnerFreeFeature): readonly string[] {
  const common =
    'The San Jose APN observation supports property identity only, not a positive criterion fact.';
  switch (feature) {
    case 'roof_age':
      return Object.freeze([common, 'No conclusive completed roof-work evidence is asserted.']);
    case 'water_view_candidate':
      return Object.freeze([
        common,
        'No lawful parcel coordinate and terrain relation is available for this property.',
      ]);
    case 'ownership_age':
      return Object.freeze([
        common,
        'The accepted ownership-transfer capability is blocked; absence cannot prove no exchange.',
      ]);
    case 'regional_owner':
      return Object.freeze([
        common,
        'Owner/applicant text is excluded and cannot establish current owner region.',
      ]);
    case 'transit_walkability':
      return Object.freeze([
        common,
        'No supported property entrance or pedestrian-route relation is available.',
      ]);
    case 'starbucks_walkability':
      return Object.freeze([
        common,
        'No supported property entrance, destination, or pedestrian-route relation is available.',
      ]);
  }
}

function ownerFreeFieldCoverageRows(
  propertyCount: number,
  evidenceCount: number,
): readonly ServingRow[] {
  const rows: ServingRow[] = [];
  for (const definition of [
    SERVING_RELATIONS.property_query,
    SERVING_RELATIONS.property_evidence,
  ]) {
    const denominator = definition.name === 'property_query' ? propertyCount : evidenceCount;
    for (const field of definition.columns) {
      const supported =
        definition.name === 'property_query'
          ? new Set(['property_id', 'parcel_identifier', 'visibility']).has(field.name)
          : field.name !== 'value_json';
      rows.push(
        Object.freeze({
          relation_name: definition.name,
          field_name: field.name,
          support_class: supported ? 'supported' : fieldSupportClass(field.name),
          numerator: supported ? denominator : 0,
          denominator,
          ratio: supported && denominator > 0 ? 1 : 0,
          source_ids_json: canonicalStableJson([SAN_JOSE_SOURCE_ID]),
          limitations_json: canonicalStableJson(
            supported
              ? ['Coverage is exact for the bounded owner-free public projection.']
              : [
                  'No supported public value is projected for this field; null/unknown is intentional.',
                ],
          ),
        }),
      );
    }
  }
  return Object.freeze(rows);
}

function fieldSupportClass(fieldName: string): 'unknown' | 'unsupported' {
  return fieldName.startsWith('ownership_') ||
    fieldName.startsWith('regional_owner_') ||
    fieldName === 'years_since_exchange' ||
    fieldName === 'last_exchange_date' ||
    fieldName === 'is_regional_owner'
    ? 'unsupported'
    : 'unknown';
}

function ownerFreeRelationCoverageRows(
  propertyCount: number,
  evidenceCount: number,
  normalizedObservationCount: number,
): readonly ServingRow[] {
  const semantic = OWNER_FREE_FEATURES.map((feature) =>
    Object.freeze({
      relation_name: `property_to_${feature}_evidence`,
      support_class: ownerFreeFeatureSupport(feature),
      linked_count: 0,
      eligible_count: propertyCount,
      ratio: 0,
      method_version: 'owner-free-public-projection@1.0.0',
      limitations_json: canonicalStableJson(ownerFreeFeatureLimitations(feature)),
    }),
  );
  return Object.freeze([
    Object.freeze({
      relation_name: 'san_jose_permit_apn_to_public_property',
      support_class: 'supported',
      linked_count: normalizedObservationCount,
      eligible_count: 50,
      ratio: normalizedObservationCount / 50,
      method_version: 'normalized-apn-exact@1.0.0',
      limitations_json: canonicalStableJson([
        'Thirty-four accepted permit rows have a non-null normalized APN; duplicates collapse to nineteen public property identities.',
      ]),
    }),
    Object.freeze({
      relation_name: 'property_evidence_to_property',
      support_class: 'supported',
      linked_count: evidenceCount,
      eligible_count: evidenceCount,
      ratio: evidenceCount === 0 ? 0 : 1,
      method_version: 'evidence-foreign-key@1.0.0',
      limitations_json: canonicalStableJson([
        'Every evidence row references one released public property.',
      ]),
    }),
    ...semantic,
  ]);
}

function restrictedComparisonRows(
  comparisons: readonly RestrictedComparisonObservation[],
  context: Readonly<Record<string, unknown>>,
): readonly ServingRow[] {
  return Object.freeze(
    comparisons.map((comparison) => {
      const sensitiveKey =
        comparison.fieldPath === '/source/owner_text'
          ? 'owner_text'
          : comparison.fieldPath === '/source/applicant_text'
            ? 'applicant_text'
            : 'contractor_text';
      return Object.freeze({
        entity_id: `sc:restricted-comparison:${sha256(Buffer.from(comparison.observationId))}`,
        entity_kind: 'source-sensitive-observation',
        version: 1,
        valid_from: comparison.sourceAsOf,
        valid_to: null,
        recorded_at: comparison.observedAt,
        source_ids_json: canonicalStableJson([SAN_JOSE_SOURCE_ID]),
        payload_json: canonicalStableJson({ [sensitiveKey]: comparison.value }),
        lineage_json: canonicalStableJson({
          observationId: comparison.observationId,
          fieldPath: comparison.fieldPath,
          sourceId: comparison.sourceRecord.sourceId,
          intentSnapshotId: context.intentSnapshotId,
          observedSnapshotId: context.observedSnapshotId,
          artifactId: comparison.sourceRecord.artifactId,
          recordKey: comparison.sourceRecord.recordKey,
          recordSha256: comparison.sourceRecord.recordSha256,
          rawArtifactSha256: context.rawArtifactSha256,
          normalizedArtifactSha256: context.normalizedArtifactSha256,
        }),
        visibility: 'restricted',
      });
    }),
  );
}

function canonicalStableJson(value: unknown): string {
  return stableJson(value);
}

function objectRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReleaseManifestError(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ReleaseManifestError(`${label} must be a non-empty string`);
  }
  return value;
}

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
              AND regexp_matches(regexp_replace(lower(j.key), '[^a-z0-9]', '', 'g'), '(ownername|ownertext|ownerstext|applicanttext|contractortext|mailingaddress|grantor|grantee|email|phone|contact)')
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
    for (const artifact of artifacts.filter(({ visibility }) => visibility === 'public')) {
      const path = sqlPath(resolveInside(root, artifact.relativePath));
      for (const column of artifact.columns.filter(({ duckdbType }) => duckdbType === 'VARCHAR')) {
        const identifier = quoteIdentifier(column.name);
        if (column.name.endsWith('_json')) {
          const prohibitedKeys = await scalarCount(
            connection,
            `SELECT count(*)::BIGINT AS count FROM read_parquet('${path}'), json_tree(${identifier}) AS j WHERE j.key IS NOT NULL AND regexp_matches(regexp_replace(lower(j.key), '[^a-z0-9]', '', 'g'), '(owner(name|text|stext)?|applicant(name|text)?|contractor(name|text)?|mail(ing)?address|grantor|grantee|email(address)?|phone(number)?|contact(info|name)?|raw(payload|json|record|source))')`,
          );
          if (prohibitedKeys > 0) {
            throw new ReleasePrivacyError(
              `Public ${artifact.relation}.${column.name} contains prohibited JSON keys`,
            );
          }
          if (hashCount > 0) {
            overlaps += await scalarCount(
              connection,
              `SELECT count(*)::BIGINT AS count FROM read_parquet('${path}'), json_tree(${identifier}) AS j JOIN restricted_value_hashes r ON r.value_hash = sha256(lower(trim(json_extract_string(j.value, '$')))) WHERE j.type = 'VARCHAR'`,
            );
          }
        } else if (hashCount > 0) {
          overlaps += await scalarCount(
            connection,
            `SELECT count(*)::BIGINT AS count FROM read_parquet('${path}') p JOIN restricted_value_hashes r ON r.value_hash = sha256(lower(trim(p.${identifier}))) WHERE p.${identifier} IS NOT NULL`,
          );
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

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path.length > 0 &&
    path !== '..' &&
    !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  );
}

function rawCidV1Sha256(bytes: Uint8Array): string {
  const digest = createHash('sha256').update(bytes).digest();
  const cidBytes = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]);
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let accumulator = 0;
  let encoded = '';
  for (const byte of cidBytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += alphabet.charAt((accumulator >>> bits) & 31);
    }
  }
  if (bits > 0) encoded += alphabet.charAt((accumulator << (5 - bits)) & 31);
  return `b${encoded}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function strictBase64(value: unknown, label: string): Buffer {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)
  ) {
    throw new ReleaseLicenseError(`${label} must be canonical base64`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    throw new ReleaseLicenseError(`${label} must be canonical base64`);
  }
  return bytes;
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
