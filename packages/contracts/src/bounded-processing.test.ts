import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  BOUNDED_PROCESSING_CONTRACT_VERSION,
  BOUNDED_PROCESSING_STAGES,
  BOUNDED_PROCESSOR_KIND,
  BOUNDED_PROCESSOR_COMPATIBILITY_POLICY,
  BOUNDED_AUTHORITATIVE_CAPABILITY_SOURCE_IDS,
  BOUNDED_AUTHORITATIVE_COUNTY_CAPABILITIES,
  BOUNDED_AUTHORITATIVE_PERMIT_AUTHORITIES,
  BoundedAuthoritativeRegistryError,
  BoundedDescriptorInventoryError,
  P8_FROZEN_CID,
  P8_FROZEN_MANIFEST_SHA256,
  assertCheckpointMatchesInput,
  assertAuthoritativeCountyRegistry,
  assertIdenticalFinalizationWinner,
  assertLegacyV1CheckpointCompatibility,
  assertP8FrozenCompatibility,
  assertProcessorProfileCompatibility,
  boundedGenerationSpecSha256,
  boundedAuthoritativeCountyRegistrySha256,
  boundedAuthoritativeCountyRegistrySchema,
  boundedDescriptorPageIndexSchema,
  boundedDescriptorPageSha256,
  boundedProcessingCheckpointSchema,
  boundedProcessingCheckpointSha256,
  boundedProcessingGenerationId,
  boundedProcessingInputSchema,
  boundedStageManifestSchema,
  boundedStageManifestSha256,
  boundedTrustedAcquiredSourceSchema,
  boundedTrustedAcquisitionManifestSchema,
  boundedTrustedAcquisitionManifestSha256,
  boundedTrustedCapabilityEvidenceSha256,
  boundedTrustedCapabilityStateSha256,
  boundedTrustedSchemaSha256,
  boundedTrustedSourceSha256,
  budgetPolicySha256,
  immutableBoundedArtifactSchema,
  logicalOutputIdentitySha256,
  mutationSortKeyHex,
  partitionForMutation,
  physicalMutationManifestSha256,
  partitionPlanSha256,
  releaseIdentitySha256,
  semanticMutationGroupKey,
  stageVersionsSha256,
  streamVerifiedBoundedDescriptorInventory,
  type BoundedMutationLogInput,
  type BoundedProcessingCheckpoint,
  type BoundedProcessingInput,
  type BoundedStageManifest,
  type BoundedTrustedAcquiredSource,
  type BoundedTrustedAcquisitionManifest,
} from './bounded-processing.js';
import { runIdSchema, snapshotIdSchema, sourceIdSchema } from './ids.js';
import { acquiredArtifactSchema } from './source.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const RUN_ID = runIdSchema.parse(`sc:run:${HASH_A}`);
const SOURCE_ID = sourceIdSchema.parse('sc:source:test-source');
const SNAPSHOT_ID = snapshotIdSchema.parse(`sc:snapshot:test-source:${HASH_B}`);

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected test fixture value');
  return value;
}

function trustedSource(slug: string, capability: string): BoundedTrustedAcquiredSource {
  const sourceId = sourceIdSchema.parse(`sc:source:${slug}`);
  const artifactSha256 = capability === 'cap-a' ? HASH_A : HASH_B;
  const snapshotId = snapshotIdSchema.parse(`sc:snapshot:${slug}:${artifactSha256}`);
  const artifact = acquiredArtifactSchema.parse({
    artifactId: `sc:artifact:sha256:${artifactSha256}`,
    sourceId,
    snapshotId,
    retrievedAt: '2026-07-18T00:00:00.000Z',
    sourceAsOf: { state: 'reported', at: '2026-07-17T00:00:00.000Z' },
    request: {
      requestKey: capability,
      method: 'GET',
      url: `https://example.test/${slug}.json`,
      headers: [],
      bodySha256: null,
      attempt: 1,
    },
    response: {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      finalUrl: `https://example.test/${slug}.json`,
    },
    mediaType: 'application/json',
    encoding: 'json',
    byteSize: 100,
    sha256: artifactSha256,
    schemaFingerprint: {
      algorithm: 'sha256',
      value: capability === 'cap-a' ? HASH_C : HASH_D,
      schemaName: `${slug}-schema`,
      canonicalizationVersion: '1.0.0',
    },
    rawUri: `file:///trusted/${slug}.json`,
    licenseSnapshotRef: `sc:license:${slug}:${HASH_C}`,
    visibility: 'restricted',
  });
  return boundedTrustedAcquiredSourceSchema.parse({
    sourceId,
    snapshotId,
    acquiredArtifacts: [artifact],
    sourceSha256: boundedTrustedSourceSha256([artifact]),
    schemaSha256: boundedTrustedSchemaSha256([artifact]),
    asOf: '2026-07-17T00:00:00.000Z',
    contributors: [`Contributor ${slug}`],
    terminalState: 'succeeded',
    permissionState: 'allowed',
    limitations: [],
    capabilities: [capability],
    permitAuthorityIds: [],
  });
}

function trustedManifest(): BoundedTrustedAcquisitionManifest {
  const sources = [trustedSource('source-a', 'cap-a'), trustedSource('source-b', 'cap-b')];
  const sourceMap = new Map(sources.map((source) => [source.sourceId, source]));
  const capabilities = ['cap-a', 'cap-b'].map((capability, index) => {
    const withoutEvidence = {
      capability,
      state: 'succeeded' as const,
      sourceIds: [required(sources[index]).sourceId],
      limitations: [],
    };
    return {
      ...withoutEvidence,
      evidenceSha256: boundedTrustedCapabilityEvidenceSha256(withoutEvidence, sourceMap),
    };
  });
  const withoutHash: Omit<BoundedTrustedAcquisitionManifest, 'manifestSha256'> = {
    format: 'oracle-trusted-acquisition-manifest-v1',
    runId: RUN_ID,
    county: 'Santa Clara',
    state: 'CA',
    createdAt: '2026-07-18T00:00:00.000Z',
    runStatus: 'succeeded',
    sources,
    capabilities,
  };
  return boundedTrustedAcquisitionManifestSchema.parse({
    ...withoutHash,
    manifestSha256: boundedTrustedAcquisitionManifestSha256(withoutHash),
  });
}

describe('trusted source-state closure', () => {
  it('preserves an artifact-less blocked lane but rejects artifact-less successful states', () => {
    const baseline = trustedSource('source-blocked', 'cap-blocked');
    const artifactless = {
      ...baseline,
      acquiredArtifacts: [],
      sourceSha256: boundedTrustedSourceSha256([]),
      schemaSha256: boundedTrustedSchemaSha256([]),
      terminalState: 'blocked' as const,
      limitations: ['Acquisition was blocked before any source bytes were received.'],
    };

    expect(boundedTrustedAcquiredSourceSchema.parse(artifactless)).toMatchObject({
      terminalState: 'blocked',
      acquiredArtifacts: [],
    });
    expect(() =>
      boundedTrustedAcquiredSourceSchema.parse({
        ...artifactless,
        terminalState: 'succeeded',
        limitations: [],
      }),
    ).toThrow('require acquired artifact evidence');
    expect(() =>
      boundedTrustedAcquiredSourceSchema.parse({ ...artifactless, terminalState: 'partial' }),
    ).toThrow('require acquired artifact evidence');
  });

  it('derives run and capability state instead of accepting caller assertions', () => {
    const manifest = trustedManifest();
    const { manifestSha256: ignored, ...payload } = manifest;
    void ignored;
    const callerPartial = { ...payload, runStatus: 'partial' as const };
    expect(() =>
      boundedTrustedAcquisitionManifestSchema.parse({
        ...callerPartial,
        manifestSha256: boundedTrustedAcquisitionManifestSha256(callerPartial),
      }),
    ).toThrow('must be derived');

    const sourceMap = new Map(manifest.sources.map((source) => [source.sourceId, source]));
    const first = required(manifest.capabilities[0]);
    const assertedBlocked = {
      ...first,
      state: 'blocked' as const,
      limitations: ['Caller asserted.'],
    };
    const capabilities = [
      {
        ...assertedBlocked,
        evidenceSha256: boundedTrustedCapabilityEvidenceSha256(assertedBlocked, sourceMap),
      },
      ...manifest.capabilities.slice(1),
    ];
    const callerCapability = { ...payload, capabilities };
    expect(() =>
      boundedTrustedAcquisitionManifestSchema.parse({
        ...callerCapability,
        manifestSha256: boundedTrustedAcquisitionManifestSha256(callerCapability),
      }),
    ).toThrow('must be derived');
  });
});

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function authoritativeManifest(
  synthetic: 'none' | 'all' | 'request-only' = 'none',
): BoundedTrustedAcquisitionManifest {
  const capabilityBySource = new Map<string, string[]>();
  for (const capability of BOUNDED_AUTHORITATIVE_COUNTY_CAPABILITIES) {
    for (const sourceId of BOUNDED_AUTHORITATIVE_CAPABILITY_SOURCE_IDS[capability]) {
      capabilityBySource.set(sourceId, [...(capabilityBySource.get(sourceId) ?? []), capability]);
    }
  }
  const authorityBySource = new Map<string, string>(
    BOUNDED_AUTHORITATIVE_PERMIT_AUTHORITIES.map(({ authorityId, sourceId }) => [
      sourceId,
      authorityId,
    ]),
  );
  const sourceIds = [
    ...new Set([...capabilityBySource.keys(), ...authorityBySource.keys()]),
  ].sort();
  const sources = sourceIds.map((sourceId, index) => {
    const slug = sourceId.slice('sc:source:'.length);
    const artifactSha256 = digest(`artifact:${sourceId}`);
    const snapshotId = snapshotIdSchema.parse(`sc:snapshot:${slug}:${artifactSha256}`);
    const requestUrl =
      synthetic !== 'none' && index === 0
        ? `https://example.test/${slug}.json`
        : `https://data.sccgov.org/resource/${slug}.json`;
    const rawUri =
      synthetic === 'all' && index === 0
        ? `https://example.test/${slug}.json`
        : `https://data.sccgov.org/resource/${slug}.json`;
    const artifact = acquiredArtifactSchema.parse({
      artifactId: `sc:artifact:sha256:${artifactSha256}`,
      sourceId,
      snapshotId,
      retrievedAt: '2026-07-18T00:00:00.000Z',
      sourceAsOf: { state: 'reported', at: '2026-07-17T00:00:00.000Z' },
      request: {
        requestKey: slug,
        method: 'GET',
        url: requestUrl,
        headers: [],
        bodySha256: null,
        attempt: 1,
      },
      response: { httpStatus: 200, etag: null, lastModified: null, finalUrl: requestUrl },
      mediaType: 'application/json',
      encoding: 'json',
      byteSize: 100,
      sha256: artifactSha256,
      schemaFingerprint: {
        algorithm: 'sha256',
        value: digest(`schema:${sourceId}`),
        schemaName: `${slug}-schema`,
        canonicalizationVersion: '1.0.0',
      },
      rawUri,
      licenseSnapshotRef: `sc:license:${slug}:${HASH_C}`,
      visibility: 'restricted',
    });
    return boundedTrustedAcquiredSourceSchema.parse({
      sourceId,
      snapshotId,
      acquiredArtifacts: [artifact],
      sourceSha256: boundedTrustedSourceSha256([artifact]),
      schemaSha256: boundedTrustedSchemaSha256([artifact]),
      asOf: '2026-07-17T00:00:00.000Z',
      contributors: [`Authority ${slug}`],
      terminalState: 'succeeded',
      permissionState: 'allowed',
      limitations: [],
      capabilities: capabilityBySource.get(sourceId) ?? [],
      permitAuthorityIds: authorityBySource.has(sourceId)
        ? [required(authorityBySource.get(sourceId))]
        : [],
    });
  });
  const sourceMap = new Map<string, BoundedTrustedAcquiredSource>(
    sources.map((source) => [source.sourceId, source]),
  );
  const capabilities = [...BOUNDED_AUTHORITATIVE_COUNTY_CAPABILITIES].sort().map((capability) => {
    const withoutEvidence = {
      capability,
      state: 'succeeded' as const,
      sourceIds: [...BOUNDED_AUTHORITATIVE_CAPABILITY_SOURCE_IDS[capability]],
      limitations: [],
    };
    return {
      ...withoutEvidence,
      evidenceSha256: boundedTrustedCapabilityEvidenceSha256(withoutEvidence, sourceMap),
    };
  });
  const sourceBinding = (sourceId: string) => {
    const source = required(sourceMap.get(sourceId));
    return {
      sourceId: source.sourceId,
      sourceSha256: source.sourceSha256,
      schemaSha256: source.schemaSha256,
      artifactIds: source.acquiredArtifacts.map(({ artifactId }) => artifactId),
    };
  };
  const registryWithoutHash = {
    format: 'oracle-santa-clara-authoritative-registry-v1' as const,
    county: 'Santa Clara' as const,
    state: 'CA' as const,
    capabilities: BOUNDED_AUTHORITATIVE_COUNTY_CAPABILITIES.map((capability) => ({
      capability,
      sources: BOUNDED_AUTHORITATIVE_CAPABILITY_SOURCE_IDS[capability].map(sourceBinding),
    })),
    permitAuthorities: BOUNDED_AUTHORITATIVE_PERMIT_AUTHORITIES.map(
      ({ authorityId, sourceId }) => ({ authorityId, source: sourceBinding(sourceId) }),
    ),
  };
  const authoritativeCountyRegistry = {
    ...registryWithoutHash,
    registrySha256: boundedAuthoritativeCountyRegistrySha256(registryWithoutHash),
  };
  const withoutHash = {
    format: 'oracle-trusted-acquisition-manifest-v1' as const,
    runId: RUN_ID,
    county: 'Santa Clara' as const,
    state: 'CA' as const,
    createdAt: '2026-07-18T00:00:00.000Z',
    runStatus: 'succeeded' as const,
    sources,
    capabilities,
    authoritativeCountyRegistry,
  };
  return boundedTrustedAcquisitionManifestSchema.parse({
    ...withoutHash,
    manifestSha256: boundedTrustedAcquisitionManifestSha256(withoutHash),
  });
}

function descriptorInventoryFixture() {
  const descriptors = [
    { byteSize: 11, key: 'a', recordCount: 2 },
    { byteSize: 13, key: 'b', recordCount: 3 },
  ];
  const pages = descriptors.map((descriptor, page) => {
    const withoutHash = {
      format: 'oracle-bounded-descriptor-page-v1' as const,
      page,
      descriptors: [descriptor],
    };
    return { ...withoutHash, pageSha256: boundedDescriptorPageSha256(withoutHash) };
  });
  const references = pages.map((page) => ({
    page: page.page,
    uri: `memory://page/${page.page}`,
    sha256: digest(stableJson(page)),
    descriptorCount: page.descriptors.length,
    firstOrderKey: required(page.descriptors[0]).key,
    lastOrderKey: required(page.descriptors[0]).key,
  }));
  const index = { format: 'oracle-bounded-descriptor-page-index-v1' as const, pages: references };
  const root = {
    format: 'oracle-bounded-descriptor-root-v1' as const,
    descriptorCount: 2,
    recordCount: 5,
    byteSize: 24,
    rootSha256: createHash('sha256')
      .update(descriptors.map((value) => `${stableJson(value)}\n`).join(''))
      .digest('hex'),
    firstOrderKey: 'a',
    lastOrderKey: 'b',
    pageCount: 2,
    pageIndexUri: 'memory://index',
    pageIndexSha256: digest(stableJson(index)),
  };
  return { descriptors, pages, index, root };
}

async function verifyDescriptorFixture(fixture: ReturnType<typeof descriptorInventoryFixture>) {
  const verified = streamVerifiedBoundedDescriptorInventory({
    root: fixture.root,
    resolver: {
      loadPageIndex: () => Promise.resolve(fixture.index),
      loadPage: ({ uri }) =>
        Promise.resolve(fixture.pages[Number(uri.slice('memory://page/'.length))]),
    },
    parseDescriptor: (value) => value as (typeof fixture.descriptors)[number],
    orderKey: ({ key }) => key,
    recordCount: ({ recordCount }) => recordCount,
    byteSize: ({ byteSize }) => byteSize,
  });
  const observed = [];
  try {
    for await (const descriptor of verified.descriptors) observed.push(descriptor);
    return { observed, completion: await verified.completion };
  } catch (error) {
    await verified.completion.catch(() => undefined);
    throw error;
  }
}

function chunk(
  sequence: number,
  firstOrdinal: number,
  recordCount: number,
  root = 'file:///root-a',
) {
  return {
    schemaVersion: '2.0.0' as const,
    sequence,
    firstOrdinal,
    lastOrdinal: firstOrdinal + recordCount - 1,
    recordCount,
    logicalKey: `runs/test/mutations/${sequence}-${HASH_C}.ndjson`,
    uri: `${root}/mutations/${sequence}.ndjson`,
    mediaType: 'application/x-ndjson' as const,
    byteSize: 100 + recordCount,
    sha256: sequence === 0 ? HASH_C : HASH_D,
    visibility: 'restricted' as const,
    licenseSnapshotRef: 'license:test',
    resumeCursor: `cursor:${firstOrdinal + recordCount - 1}`,
  };
}

function mutationLog(chunks = [chunk(0, 0, 2), chunk(1, 2, 2)]): BoundedMutationLogInput {
  const withoutHash: Omit<BoundedMutationLogInput, 'physicalManifestSha256'> = {
    format: 'oracle-bounded-mutation-log-v2' as const,
    recordCount: 4,
    logicalSha256: HASH_A,
    mutationSchemaSha256: HASH_B,
    sources: [
      {
        sourceId: SOURCE_ID,
        snapshotId: SNAPSHOT_ID,
        mutationSchemaSha256: HASH_B,
        recordCount: 4,
        logicalSha256: HASH_A,
        chunks,
      },
    ],
  };
  return {
    ...withoutHash,
    physicalManifestSha256: physicalMutationManifestSha256(withoutHash),
  };
}

function processingInput(
  overrides: Partial<
    Omit<
      BoundedProcessingInput,
      'contractVersion' | 'processorKind' | 'generationId' | 'logicalOutputIdentitySha256'
    >
  > = {},
): BoundedProcessingInput {
  const withoutIdentities = {
    contractVersion: BOUNDED_PROCESSING_CONTRACT_VERSION,
    processorKind: BOUNDED_PROCESSOR_KIND,
    runId: overrides.runId ?? RUN_ID,
    pipelineVersion: overrides.pipelineVersion ?? '2.0.0',
    profile: overrides.profile ?? ('full' as const),
    configurationSha256: overrides.configurationSha256 ?? HASH_C,
    requestedAt: overrides.requestedAt ?? '2026-07-18T00:00:00.000Z',
    sourceManifestSha256: overrides.sourceManifestSha256 ?? HASH_D,
    capabilityStateSha256: overrides.capabilityStateSha256 ?? HASH_A,
    sourceSnapshotIds: overrides.sourceSnapshotIds ?? [SNAPSHOT_ID],
    release: overrides.release ?? {
      releaseId: 'santa-clara-test',
      releaseContractVersion: '1.0.0',
      county: 'Santa Clara' as const,
      state: 'CA' as const,
      generatedAt: '2026-07-18T00:00:00.000Z',
    },
    mutationLog: overrides.mutationLog ?? mutationLog(),
    partitionPlan: overrides.partitionPlan ?? {
      algorithm: 'sha256-leading-64-bit-modulo-v1' as const,
      partitionCount: 16,
      groupKeyVersion: 'canonical-mutation-group-key-v1' as const,
      mutationSortVersion: 'length-prefixed-utf8-mutation-sort-v1' as const,
    },
    budget: overrides.budget ?? {
      policyVersion: 'bounded-process-budget-v1' as const,
      maxBufferedRecords: 1_000,
      maxBufferedBytes: 16 * 1024 * 1024,
      maxRssBytes: 768 * 1024 * 1024,
      duckdbMemoryBytes: 256 * 1024 * 1024,
      runtimeReserveBytes: 128 * 1024 * 1024,
      maxOpenFiles: 64,
      maxWorkers: 2,
      maxRecordsPerOutputChunk: 500,
      maxBytesPerOutputChunk: 8 * 1024 * 1024,
      rssSampleIntervalRecords: 100,
    },
    stageVersions:
      overrides.stageVersions ??
      (Object.fromEntries(
        BOUNDED_PROCESSING_STAGES.map((stage) => [stage, `${stage}-v1`]),
      ) as BoundedProcessingInput['stageVersions']),
  };
  const logicalOutputIdentity = logicalOutputIdentitySha256(withoutIdentities);
  const withLogicalIdentity = {
    ...withoutIdentities,
    logicalOutputIdentitySha256: logicalOutputIdentity,
  };
  return {
    ...withLogicalIdentity,
    generationId: boundedProcessingGenerationId(withLogicalIdentity),
  };
}

function artifact(input: BoundedProcessingInput, sequence = 0) {
  return {
    generationId: input.generationId,
    stage: 'partition_mutations' as const,
    dataset: 'partitioned_mutations',
    partitionId: 0,
    sequence,
    logicalKey: `bounded/${input.generationId}/partitioned/${sequence}.ndjson`,
    uri: `file:///workspace/${sequence}.ndjson`,
    mediaType: 'application/x-ndjson',
    byteSize: 100,
    sha256: sequence === 0 ? HASH_A : HASH_B,
    recordCount: 2,
    firstSortKey: `${sequence}a`,
    lastSortKey: `${sequence}z`,
    schemaSha256: HASH_C,
    sourceLineageSha256: HASH_A,
    licenseIdentitySha256: HASH_B,
    visibility: 'mixed_internal' as const,
  };
}

function stageManifest(input: BoundedProcessingInput): BoundedStageManifest {
  const withoutHash = {
    contractVersion: '2.0.0' as const,
    generationId: input.generationId,
    stage: 'partition_mutations' as const,
    stageVersion: 'partition_mutations-v1',
    inputLogicalSha256s: [input.mutationLog.logicalSha256],
    parents: [],
    datasets: [
      {
        dataset: 'partitioned_mutations',
        schemaSha256: HASH_C,
        sortKeyVersion: 'length-prefixed-utf8-mutation-sort-v1',
        recordCount: 2,
        logicalSha256: HASH_D,
      },
    ],
    artifacts: [artifact(input)],
  };
  return { ...withoutHash, manifestSha256: boundedStageManifestSha256(withoutHash) };
}

function checkpoint(input: BoundedProcessingInput): BoundedProcessingCheckpoint {
  const manifest = stageManifest(input);
  const withoutHash = {
    schemaVersion: 'oracle-bounded-processing-checkpoint-v1' as const,
    generationId: input.generationId,
    generationSpecSha256: boundedGenerationSpecSha256(input),
    expectedRevision: null,
    physicalInputManifestSha256: input.mutationLog.physicalManifestSha256,
    releaseIdentitySha256: releaseIdentitySha256(input.release),
    logicalOutputIdentitySha256: input.logicalOutputIdentitySha256,
    partitionPlanSha256: partitionPlanSha256(input.partitionPlan),
    budgetPolicySha256: budgetPolicySha256(input.budget),
    stageVersionsSha256: stageVersionsSha256(input.stageVersions),
    durablePartitions: [
      {
        stage: 'reduce_canonical' as const,
        partitionId: 1,
        ledgerEntryCount: 1,
        partitionLedgerManifestSha256: HASH_B,
        logicalOutputIdentitySha256: input.logicalOutputIdentitySha256,
        outputManifestSha256: manifest.manifestSha256,
      },
    ],
    activeCursor: null,
    orphanCandidate: null,
    completedStages: [
      {
        stage: 'partition_mutations' as const,
        outputManifestSha256: manifest.manifestSha256,
        partitionLedgerManifestSha256: HASH_C,
        partitionCount: input.partitionPlan.partitionCount,
      },
    ],
    finalization: null,
  };
  return { ...withoutHash, checkpointSha256: boundedProcessingCheckpointSha256(withoutHash) };
}

function rehashCheckpoint(
  checkpointValue: BoundedProcessingCheckpoint,
  changes: Partial<BoundedProcessingCheckpoint>,
): BoundedProcessingCheckpoint {
  const candidate = { ...checkpointValue, ...changes };
  return { ...candidate, checkpointSha256: boundedProcessingCheckpointSha256(candidate) };
}

function artifactMutation(sequence = 1) {
  return {
    kind: 'artifact_reference' as const,
    mutationId: `sc:mutation:${HASH_A}` as const,
    runId: RUN_ID,
    sourceId: SOURCE_ID,
    snapshotId: SNAPSHOT_ID,
    sequence,
    emittedAt: '2026-07-18T00:00:00.000Z',
    visibility: 'public' as const,
    artifact: {
      artifactId: `sc:artifact:sha256:${HASH_B}` as const,
      role: 'raw' as const,
      entityId: null,
      description: 'test artifact',
    },
  };
}

function linkMutation() {
  return {
    kind: 'link_candidate' as const,
    mutationId: `sc:mutation:${HASH_C}` as const,
    runId: RUN_ID,
    sourceId: SOURCE_ID,
    snapshotId: SNAPSHOT_ID,
    sequence: 2,
    emittedAt: '2026-07-18T00:00:00.000Z',
    visibility: 'public' as const,
    link: {
      linkId: `sc:link:${HASH_D}` as const,
      fromEntityId: 'sc:entity:address:test-address' as const,
      toEntityId: 'sc:entity:property:test-property' as const,
      method: 'authoritative' as const,
      score: 1,
      evidenceObservationIds: [`sc:observation:${HASH_B}` as const],
      algorithmVersion: '1.0.0',
      reviewStatus: 'accepted' as const,
    },
  };
}

describe('bounded_streaming_v2 processing contract', () => {
  it('binds county capability evidence to independently acquired source and schema manifests', () => {
    const manifest = trustedManifest();
    expect(boundedTrustedAcquisitionManifestSchema.parse(manifest)).toEqual(manifest);

    const first = required(manifest.sources[0]);
    const forgedSource = {
      ...manifest,
      sources: [{ ...first, sourceSha256: HASH_D }, ...manifest.sources.slice(1)],
    };
    expect(boundedTrustedAcquisitionManifestSchema.safeParse(forgedSource).success).toBe(false);
    const forgedSchema = {
      ...manifest,
      sources: [{ ...first, schemaSha256: HASH_A }, ...manifest.sources.slice(1)],
    };
    expect(boundedTrustedAcquisitionManifestSchema.safeParse(forgedSchema).success).toBe(false);

    const synthetic = { ...first, capabilities: ['cap-a', 'cap-b'] };
    const syntheticMap = new Map([[synthetic.sourceId, synthetic]]);
    const syntheticCapabilities = ['cap-a', 'cap-b'].map((capability) => {
      const evidence = {
        capability,
        state: 'succeeded' as const,
        sourceIds: [synthetic.sourceId],
        limitations: [],
      };
      return {
        ...evidence,
        evidenceSha256: boundedTrustedCapabilityEvidenceSha256(evidence, syntheticMap),
      };
    });
    const syntheticWithoutHash = {
      ...manifest,
      sources: [synthetic],
      capabilities: syntheticCapabilities,
    };
    const syntheticManifest = {
      ...syntheticWithoutHash,
      manifestSha256: boundedTrustedAcquisitionManifestSha256(syntheticWithoutHash),
    };
    expect(boundedTrustedAcquisitionManifestSchema.safeParse(syntheticManifest).success).toBe(
      false,
    );
  });

  it('canonicalizes trusted identities and logical input identity across caller order', () => {
    const manifest = trustedManifest();
    const reordered = {
      ...manifest,
      sources: [...manifest.sources].reverse(),
      capabilities: [...manifest.capabilities].reverse(),
    };
    expect(boundedTrustedAcquisitionManifestSha256(reordered)).toBe(manifest.manifestSha256);
    expect(boundedTrustedCapabilityStateSha256(reordered)).toBe(
      boundedTrustedCapabilityStateSha256(manifest),
    );

    const baseline = processingInput();
    const secondSourceId = sourceIdSchema.parse('sc:source:test-source-b');
    const secondSnapshotId = snapshotIdSchema.parse(`sc:snapshot:test-source-b:${HASH_C}`);
    const secondSource = {
      ...required(baseline.mutationLog.sources[0]),
      sourceId: secondSourceId,
      snapshotId: secondSnapshotId,
      logicalSha256: HASH_B,
      chunks: [
        {
          ...chunk(0, 0, 4),
          logicalKey: 'test/source-b/0.ndjson',
          uri: 'file:///source-b/0.ndjson',
        },
      ],
    };
    const firstSource = required(baseline.mutationLog.sources[0]);
    const mutation = {
      ...baseline.mutationLog,
      recordCount: 8,
      sources: [firstSource, secondSource],
    };
    const ordered = processingInput({
      mutationLog: {
        ...mutation,
        physicalManifestSha256: physicalMutationManifestSha256(mutation),
      },
      sourceSnapshotIds: [SNAPSHOT_ID, secondSnapshotId],
    });
    const callerReordered = {
      ...ordered,
      sourceSnapshotIds: [...ordered.sourceSnapshotIds].reverse(),
      mutationLog: { ...ordered.mutationLog, sources: [...ordered.mutationLog.sources].reverse() },
    };
    expect(logicalOutputIdentitySha256(callerReordered)).toBe(ordered.logicalOutputIdentitySha256);
  });

  it('accepts rooted stage inventories beyond the inline 2,048 descriptor cap', () => {
    const input = processingInput();
    const withoutHash = {
      contractVersion: BOUNDED_PROCESSING_CONTRACT_VERSION,
      generationId: input.generationId,
      stage: 'partition_mutations' as const,
      stageVersion: 'partition_mutations-v1',
      inputLogicalSha256s: [HASH_A],
      parents: [],
      datasets: [
        {
          dataset: 'property_evidence',
          schemaSha256: HASH_C,
          sortKeyVersion: 'evidence-order-v1',
          recordCount: 1_000_000,
          logicalSha256: HASH_D,
        },
      ],
      artifacts: [],
      artifactInventory: {
        root: {
          format: 'oracle-bounded-descriptor-root-v1' as const,
          descriptorCount: 2_930,
          recordCount: 1_000_000,
          byteSize: 123_456_789,
          rootSha256: HASH_A,
          firstOrderKey: '0000',
          lastOrderKey: '2929',
          pageCount: 2_930,
          pageIndexUri: 'file:///immutable/property-evidence-pages/index.json',
          pageIndexSha256: HASH_B,
        },
        datasets: [
          {
            dataset: 'property_evidence',
            artifactCount: 2_930,
            recordCount: 1_000_000,
            rootSha256: HASH_A,
          },
        ],
      },
    };
    const rooted = {
      ...withoutHash,
      manifestSha256: boundedStageManifestSha256(withoutHash),
    };
    expect(boundedStageManifestSchema.parse(rooted).artifactInventory?.root.descriptorCount).toBe(
      2_930,
    );
  });

  it('independently verifies rooted descriptor membership, count, order, and root', async () => {
    const baseline = descriptorInventoryFixture();
    const verified = await verifyDescriptorFixture(baseline);
    expect(verified.observed).toEqual(baseline.descriptors);
    expect(verified.completion).toMatchObject({
      descriptorCount: 2,
      recordCount: 5,
      byteSize: 24,
      rootSha256: baseline.root.rootSha256,
    });

    const omitted = descriptorInventoryFixture();
    omitted.index = { ...omitted.index, pages: omitted.index.pages.slice(0, 1) };
    omitted.root = {
      ...omitted.root,
      pageIndexSha256: digest(stableJson(omitted.index)),
    };
    await expect(verifyDescriptorFixture(omitted)).rejects.toBeInstanceOf(
      BoundedDescriptorInventoryError,
    );

    const reordered = descriptorInventoryFixture();
    reordered.index = { ...reordered.index, pages: [...reordered.index.pages].reverse() };
    reordered.root = {
      ...reordered.root,
      pageIndexSha256: digest(stableJson(reordered.index)),
    };
    await expect(verifyDescriptorFixture(reordered)).rejects.toBeInstanceOf(
      BoundedDescriptorInventoryError,
    );

    const duplicated = descriptorInventoryFixture();
    duplicated.index = {
      ...duplicated.index,
      pages: [required(duplicated.index.pages[0]), required(duplicated.index.pages[0])],
    };
    duplicated.root = {
      ...duplicated.root,
      pageIndexSha256: digest(stableJson(duplicated.index)),
    };
    await expect(verifyDescriptorFixture(duplicated)).rejects.toBeInstanceOf(
      BoundedDescriptorInventoryError,
    );

    const substituted = descriptorInventoryFixture();
    substituted.pages = [
      {
        ...required(substituted.pages[0]),
        descriptors: [{ ...required(substituted.descriptors[0]), recordCount: 99 }],
      },
      required(substituted.pages[1]),
    ];
    await expect(verifyDescriptorFixture(substituted)).rejects.toBeInstanceOf(
      BoundedDescriptorInventoryError,
    );
  });

  it('accepts the observed 2,934-page rooted index under an explicit fixed cap', () => {
    const page = descriptorInventoryFixture().index.pages[0];
    if (page === undefined) throw new Error('fixture descriptor page');
    const pages = Array.from({ length: 2_934 }, (_, index) => ({
      ...page,
      page: index,
      uri: `memory://page/${index}`,
      firstOrderKey: index.toString().padStart(4, '0'),
      lastOrderKey: index.toString().padStart(4, '0'),
    }));
    expect(
      boundedDescriptorPageIndexSchema.parse({
        format: 'oracle-bounded-descriptor-page-index-v1',
        pages,
      }).pages,
    ).toHaveLength(2_934);
  });

  it('accepts only the frozen authority registry bound to nonsynthetic acquired evidence', () => {
    const trusted = authoritativeManifest();
    expect(assertAuthoritativeCountyRegistry(trusted).permitAuthorities).toHaveLength(16);
    expect(() => assertAuthoritativeCountyRegistry(authoritativeManifest('all'))).toThrow(
      BoundedAuthoritativeRegistryError,
    );
    expect(() => assertAuthoritativeCountyRegistry(authoritativeManifest('request-only'))).toThrow(
      BoundedAuthoritativeRegistryError,
    );

    const registry = required(trusted.authoritativeCountyRegistry);
    const forgedSplitWithoutHash = {
      ...registry,
      capabilities: registry.capabilities.map((binding, index) =>
        index === 0
          ? {
              ...binding,
              sources: [
                ...binding.sources,
                required(required(registry.capabilities[1]).sources[0]),
              ],
            }
          : binding,
      ),
    };
    const forgedSplit = {
      ...forgedSplitWithoutHash,
      registrySha256: boundedAuthoritativeCountyRegistrySha256(forgedSplitWithoutHash),
    };
    expect(boundedAuthoritativeCountyRegistrySchema.safeParse(forgedSplit).success).toBe(false);

    const arbitraryCapability = {
      ...registry,
      capabilities: registry.capabilities.map((binding, index) =>
        index === 0 ? { ...binding, capability: 'caller_declared_complete' } : binding,
      ),
    };
    expect(
      boundedAuthoritativeCountyRegistrySchema.safeParse({
        ...arbitraryCapability,
        registrySha256: boundedAuthoritativeCountyRegistrySha256(arbitraryCapability as never),
      }).success,
    ).toBe(false);

    const arbitraryAuthorityWithoutHash = {
      ...registry,
      permitAuthorities: registry.permitAuthorities.map((binding, index) =>
        index === 0 ? { ...binding, authorityId: 'caller-authority-16' } : binding,
      ),
    };
    expect(
      boundedAuthoritativeCountyRegistrySchema.safeParse({
        ...arbitraryAuthorityWithoutHash,
        registrySha256: boundedAuthoritativeCountyRegistrySha256(
          arbitraryAuthorityWithoutHash as never,
        ),
      }).success,
    ).toBe(false);
  });

  it('binds exact physical chunks while logical identity ignores root, rechunking, workers, and budgets', () => {
    const baseline = processingInput();
    expect(boundedProcessingInputSchema.parse(baseline)).toEqual(baseline);

    const movedLog = mutationLog([
      chunk(0, 0, 1, 'file:///root-b'),
      chunk(1, 1, 3, 'file:///root-b'),
    ]);
    const moved = processingInput({
      mutationLog: movedLog,
      budget: {
        ...baseline.budget,
        maxOpenFiles: 128,
        maxWorkers: 4,
        rssSampleIntervalRecords: 50,
      },
    });

    expect(moved.mutationLog.physicalManifestSha256).not.toBe(
      baseline.mutationLog.physicalManifestSha256,
    );
    expect(moved.generationId).not.toBe(baseline.generationId);
    expect(moved.logicalOutputIdentitySha256).toBe(baseline.logicalOutputIdentitySha256);
  });

  it('rejects hostile caller inventories before iteration or canonical copying', () => {
    const hostileSources = new Proxy(new Array(65), {
      get(target, property, receiver) {
        if (property === Symbol.iterator) throw new Error('caller inventory was iterated');
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    expect(() =>
      physicalMutationManifestSha256({
        format: 'oracle-bounded-mutation-log-v2',
        recordCount: 0,
        logicalSha256: HASH_A,
        mutationSchemaSha256: HASH_B,
        sources: hostileSources,
      } as never),
    ).toThrow(RangeError);
  });

  it('changes logical identity for semantic mutation, release, and algorithm versions', () => {
    const baseline = processingInput();
    const changedLog = mutationLog();
    const changedMutation = processingInput({
      mutationLog: {
        ...changedLog,
        logicalSha256: HASH_D,
        physicalManifestSha256: physicalMutationManifestSha256({
          ...changedLog,
          logicalSha256: HASH_D,
        }),
      },
    });
    const changedRelease = processingInput({
      release: { ...baseline.release, releaseId: 'santa-clara-next' },
    });
    const changedAlgorithm = {
      ...baseline,
      stageVersions: { ...baseline.stageVersions, derive_features: 'derive-features-v2' },
    };
    const changedAlgorithmLogical = logicalOutputIdentitySha256(changedAlgorithm);

    expect(changedMutation.logicalOutputIdentitySha256).not.toBe(
      baseline.logicalOutputIdentitySha256,
    );
    expect(changedRelease.logicalOutputIdentitySha256).not.toBe(
      baseline.logicalOutputIdentitySha256,
    );
    expect(changedAlgorithmLogical).not.toBe(baseline.logicalOutputIdentitySha256);
  });

  it('binds every output-bearing run, source, capability, and release dimension independently', () => {
    const baseline = processingInput();
    const variants = [
      processingInput({ runId: runIdSchema.parse(`sc:run:${HASH_B}`) }),
      processingInput({ pipelineVersion: '3.0.0' }),
      processingInput({ profile: 'incremental' }),
      processingInput({ configurationSha256: HASH_D }),
      processingInput({ requestedAt: '2026-07-18T00:00:01.000Z' }),
      processingInput({ sourceManifestSha256: HASH_C }),
      processingInput({ capabilityStateSha256: HASH_B }),
      processingInput({
        sourceSnapshotIds: [snapshotIdSchema.parse(`sc:snapshot:test-source:${HASH_C}`)],
      }),
      processingInput({
        release: { ...baseline.release, generatedAt: '2026-07-18T00:00:01.000Z' },
      }),
    ];
    for (const variant of variants) {
      expect(variant.logicalOutputIdentitySha256).not.toBe(baseline.logicalOutputIdentitySha256);
    }

    const budgetOnly = processingInput({
      budget: { ...baseline.budget, maxOpenFiles: 128, maxWorkers: 4 },
    });
    expect(budgetOnly.logicalOutputIdentitySha256).toBe(baseline.logicalOutputIdentitySha256);
    expect(budgetOnly.generationId).not.toBe(baseline.generationId);
  });

  it('uses semantic grouping, leading-64-bit partitioning, and stable length-prefixed sort keys', () => {
    const mutation = artifactMutation();
    expect(semanticMutationGroupKey(mutation)).toBe(mutation.artifact.artifactId);
    const partition = partitionForMutation(mutation, 31);
    expect(partition).toBeGreaterThanOrEqual(0);
    expect(partition).toBeLessThan(31);
    expect(partitionForMutation(structuredClone(mutation), 31)).toBe(partition);
    expect(mutationSortKeyHex(structuredClone(mutation))).toBe(mutationSortKeyHex(mutation));
    expect(mutationSortKeyHex({ ...mutation, sequence: 2 })).not.toBe(mutationSortKeyHex(mutation));
    const link = linkMutation();
    expect(semanticMutationGroupKey(link)).toBe(link.link.fromEntityId);
  });

  it('accepts canonical stage manifests and rejects order, generation, relation, and self-hash drift', () => {
    const input = processingInput();
    const manifest = stageManifest(input);
    expect(boundedStageManifestSchema.parse(manifest)).toEqual(manifest);

    const second = { ...artifact(input, 1), recordCount: 0, firstSortKey: null, lastSortKey: null };
    const dataset = required(manifest.datasets[0]);
    const firstArtifact = required(manifest.artifacts[0]);
    const unsorted = {
      ...manifest,
      datasets: [{ ...dataset, recordCount: 2 }],
      artifacts: [second, firstArtifact],
    };
    expect(boundedStageManifestSchema.safeParse(unsorted).success).toBe(false);
    expect(
      boundedStageManifestSchema.safeParse({
        ...manifest,
        artifacts: [{ ...firstArtifact, generationId: `sc:generation:${HASH_D}` }],
      }).success,
    ).toBe(false);
    expect(
      boundedStageManifestSchema.safeParse({
        ...manifest,
        parents: [{ stage: 'reduce_canonical', manifestSha256: HASH_A }],
      }).success,
    ).toBe(false);
    expect(
      boundedStageManifestSchema.safeParse({ ...manifest, manifestSha256: HASH_A }).success,
    ).toBe(false);
  });

  it('rejects corrupt, non-contiguous, duplicate, and aggregate-drift mutation inputs', () => {
    const valid = mutationLog();
    expect(boundedProcessingInputSchema.safeParse(processingInput()).success).toBe(true);

    const corruptHash = { ...valid, physicalManifestSha256: HASH_D };
    expect(
      boundedProcessingInputSchema.safeParse(processingInput({ mutationLog: corruptHash })).success,
    ).toBe(false);

    const brokenChunks = [chunk(0, 0, 2), chunk(1, 3, 2)];
    const validSource = required(valid.sources[0]);
    const brokenSource = { ...validSource, chunks: brokenChunks };
    const broken = {
      ...valid,
      sources: [brokenSource],
      physicalManifestSha256: physicalMutationManifestSha256({ ...valid, sources: [brokenSource] }),
    };
    expect(
      boundedProcessingInputSchema.safeParse(processingInput({ mutationLog: broken })).success,
    ).toBe(false);

    const duplicateSource = {
      ...valid,
      recordCount: 8,
      sources: [validSource, validSource],
    };
    const duplicate = {
      ...duplicateSource,
      physicalManifestSha256: physicalMutationManifestSha256(duplicateSource),
    };
    expect(
      boundedProcessingInputSchema.safeParse(processingInput({ mutationLog: duplicate })).success,
    ).toBe(false);
  });

  it('rejects impossible budgets, unknown fields, and stale generation identities', () => {
    const valid = processingInput();
    expect(
      boundedProcessingInputSchema.safeParse({
        ...valid,
        budget: { ...valid.budget, maxBytesPerOutputChunk: valid.budget.maxBufferedBytes + 1 },
      }).success,
    ).toBe(false);
    expect(
      boundedProcessingInputSchema.safeParse({
        ...valid,
        budget: {
          ...valid.budget,
          maxRssBytes:
            valid.budget.maxBufferedBytes +
            valid.budget.duckdbMemoryBytes +
            valid.budget.runtimeReserveBytes -
            1,
        },
      }).success,
    ).toBe(false);
    expect(boundedProcessingInputSchema.safeParse({ ...valid, unexpected: true }).success).toBe(
      false,
    );
    expect(
      boundedProcessingInputSchema.safeParse({ ...valid, generationId: `sc:generation:${HASH_D}` })
        .success,
    ).toBe(false);
  });

  it('validates checkpoint ordering, durable prefixes, finalization, and self-hashes', () => {
    const input = processingInput();
    const valid = checkpoint(input);
    expect(boundedProcessingCheckpointSchema.parse(valid)).toEqual(valid);

    const staleUnit = {
      ...valid,
      durablePartitions: [
        {
          stage: 'derive_features' as const,
          partitionId: 0,
          ledgerEntryCount: 1,
          partitionLedgerManifestSha256: HASH_B,
          logicalOutputIdentitySha256: input.logicalOutputIdentitySha256,
          outputManifestSha256: HASH_A,
        },
      ],
    };
    expect(boundedProcessingCheckpointSchema.safeParse(staleUnit).success).toBe(false);

    const promotedWithoutFinalStage = {
      ...valid,
      finalization: {
        state: 'promoted' as const,
        releaseManifestSha256: HASH_A,
        releaseEvidenceSha256: HASH_B,
        destinationIdentitySha256: HASH_C,
        winnerGenerationId: input.generationId,
        winnerManifestSha256: HASH_A,
        winnerCasRevision: HASH_D,
      },
    };
    expect(boundedProcessingCheckpointSchema.safeParse(promotedWithoutFinalStage).success).toBe(
      false,
    );
    expect(
      boundedProcessingCheckpointSchema.safeParse({ ...valid, checkpointSha256: HASH_D }).success,
    ).toBe(false);
  });

  it('rejects every mixed checkpoint identity with a typed dimension', () => {
    const input = processingInput();
    const valid = checkpoint(input);
    expect(assertCheckpointMatchesInput(valid, input)).toEqual(valid);
    const mixed = [
      rehashCheckpoint(valid, {
        generationId: `sc:generation:${HASH_D}`,
        generationSpecSha256: HASH_D,
      }),
      rehashCheckpoint(valid, { physicalInputManifestSha256: HASH_D }),
      rehashCheckpoint(valid, { releaseIdentitySha256: HASH_D }),
      rehashCheckpoint(valid, { logicalOutputIdentitySha256: HASH_D }),
      rehashCheckpoint(valid, { partitionPlanSha256: HASH_D }),
      rehashCheckpoint(valid, { budgetPolicySha256: HASH_D }),
      rehashCheckpoint(valid, { stageVersionsSha256: HASH_D }),
    ];
    for (const candidate of mixed) {
      expect(() => assertCheckpointMatchesInput(candidate, input)).toThrow(
        /does not match processing input/u,
      );
    }
  });

  it('binds a full orphan interval and resumable active cursor to one durable artifact', () => {
    const input = processingInput();
    const base = checkpoint(input);
    const durableArtifact = {
      ...artifact(input),
      stage: 'reduce_canonical' as const,
      partitionId: 1,
    };
    const orphanArtifact = {
      ...durableArtifact,
      sequence: 1,
      logicalKey: `bounded/${input.generationId}/partitioned/1.ndjson`,
      uri: 'file:///workspace/1.ndjson',
      firstSortKey: 'output:canonical:0001',
      lastSortKey: 'output:canonical:0002',
    };
    const candidate = rehashCheckpoint(base, {
      activeCursor: {
        stage: 'reduce_canonical',
        partitionId: 1,
        inputSortKey: 'sort:0002',
        inputContentSha256: HASH_A,
        inputOrdinal: 2,
        outputOrdinal: 2,
        durableChunkCount: 1,
        outputRecordCount: 2,
        outputByteCount: 100,
        logicalPrefixSha256: HASH_B,
        lastDurableArtifact: durableArtifact,
      },
      orphanCandidate: {
        artifact: orphanArtifact,
        exactInputInterval: {
          firstOrdinal: 2,
          lastOrdinal: 3,
          firstSortKey: 'sort:0002',
          lastSortKey: 'sort:0003',
          firstContentSha256: HASH_A,
          logicalPrefixSha256: HASH_B,
          outputRecordCount: orphanArtifact.recordCount,
          outputByteCount: orphanArtifact.byteSize,
        },
        expectedStageManifestSha256: HASH_D,
      },
    });
    expect(boundedProcessingCheckpointSchema.parse(candidate).orphanCandidate?.artifact).toEqual(
      orphanArtifact,
    );
    expect(assertCheckpointMatchesInput(candidate, input)).toEqual(candidate);
    const mixedOrphan = rehashCheckpoint(candidate, {
      orphanCandidate: {
        ...required(candidate.orphanCandidate ?? undefined),
        artifact: { ...orphanArtifact, generationId: `sc:generation:${HASH_D}` },
      },
    });
    expect(boundedProcessingCheckpointSchema.safeParse(mixedOrphan).success).toBe(false);
    for (const wrongArtifact of [
      { ...orphanArtifact, partitionId: 2 },
      { ...orphanArtifact, sequence: 2 },
    ]) {
      const invalid = rehashCheckpoint(candidate, {
        orphanCandidate: {
          ...required(candidate.orphanCandidate ?? undefined),
          artifact: wrongArtifact,
        },
      });
      expect(boundedProcessingCheckpointSchema.safeParse(invalid).success).toBe(false);
      expect(() => assertCheckpointMatchesInput(invalid, input)).toThrow();
    }
    for (const wrongInterval of [
      {
        ...required(candidate.orphanCandidate ?? undefined).exactInputInterval,
        firstSortKey: 'sort:0001',
      },
      {
        ...required(candidate.orphanCandidate ?? undefined).exactInputInterval,
        firstContentSha256: HASH_D,
      },
      {
        ...required(candidate.orphanCandidate ?? undefined).exactInputInterval,
        logicalPrefixSha256: HASH_D,
      },
    ]) {
      const invalid = rehashCheckpoint(candidate, {
        orphanCandidate: {
          ...required(candidate.orphanCandidate ?? undefined),
          exactInputInterval: wrongInterval,
        },
      });
      expect(boundedProcessingCheckpointSchema.safeParse(invalid).success).toBe(false);
      expect(() => assertCheckpointMatchesInput(invalid, input)).toThrow();
    }
  });

  it('preserves all source visibility classes plus explicit mixed-internal artifacts', () => {
    const input = processingInput();
    for (const visibility of [
      'public',
      'authenticated',
      'restricted',
      'prohibited_public',
      'mixed_internal',
    ] as const) {
      expect(
        immutableBoundedArtifactSchema.safeParse({ ...artifact(input), visibility }).success,
      ).toBe(true);
    }
    expect(
      immutableBoundedArtifactSchema.safeParse({ ...artifact(input), visibility: 'private' })
        .success,
    ).toBe(false);
  });

  it('freezes bounded/legacy profile behavior and the accepted nine-file p8 closure', () => {
    expect(() => assertProcessorProfileCompatibility('full', 'bounded_streaming_v2')).not.toThrow();
    expect(() =>
      assertProcessorProfileCompatibility('incremental', 'bounded_streaming_v2'),
    ).not.toThrow();
    expect(() => assertProcessorProfileCompatibility('full', 'small_run_only_v1')).toThrow(
      /cannot execute profile/u,
    );
    expect(() => assertProcessorProfileCompatibility('pilot', 'small_run_only_v1')).not.toThrow();
    expect(assertLegacyV1CheckpointCompatibility({ runLabel: 'p8', finalized: true })).toBe(
      'readable_unchanged',
    );
    expect(() =>
      assertLegacyV1CheckpointCompatibility({ runLabel: 'f1', finalized: false }),
    ).toThrow(/f1/u);
    expect(() =>
      assertLegacyV1CheckpointCompatibility({ runLabel: 'f1', finalized: true }),
    ).toThrow(/Rejected unbounded legacy run/u);
    expect(BOUNDED_PROCESSOR_COMPATIBILITY_POLICY.p8.manifestSha256).toBe(
      P8_FROZEN_MANIFEST_SHA256,
    );
    expect(BOUNDED_PROCESSOR_COMPATIBILITY_POLICY.p8.cid).toBe(P8_FROZEN_CID);
    expect(BOUNDED_PROCESSOR_COMPATIBILITY_POLICY.p8.closureFiles).toHaveLength(9);
    expect(() =>
      assertP8FrozenCompatibility(BOUNDED_PROCESSOR_COMPATIBILITY_POLICY.p8),
    ).not.toThrow();
    expect(() =>
      assertP8FrozenCompatibility({
        ...BOUNDED_PROCESSOR_COMPATIBILITY_POLICY.p8,
        propertyRows: 20,
      }),
    ).toThrow();
  });

  it('adopts only a byte-identical finalization race winner', () => {
    const input = processingInput();
    const expected = {
      state: 'adopted_identical_winner' as const,
      releaseManifestSha256: HASH_A,
      releaseEvidenceSha256: HASH_B,
      destinationIdentitySha256: HASH_C,
      winnerGenerationId: input.generationId,
      winnerManifestSha256: HASH_A,
      winnerCasRevision: HASH_D,
    };
    expect(
      assertIdenticalFinalizationWinner(expected, {
        destinationIdentitySha256: HASH_C,
        releaseManifestSha256: HASH_A,
        releaseEvidenceSha256: HASH_B,
        winnerGenerationId: input.generationId,
        winnerManifestSha256: HASH_A,
        winnerCasRevision: HASH_D,
      }),
    ).toBe('adopted_identical_winner');
    expect(() =>
      assertIdenticalFinalizationWinner(expected, {
        destinationIdentitySha256: HASH_C,
        releaseManifestSha256: HASH_B,
        releaseEvidenceSha256: HASH_B,
        winnerGenerationId: input.generationId,
        winnerManifestSha256: HASH_A,
        winnerCasRevision: HASH_D,
      }),
    ).toThrow(/nonidentical winner/u);
    expect(() =>
      assertIdenticalFinalizationWinner(expected, {
        destinationIdentitySha256: HASH_C,
        releaseManifestSha256: HASH_A,
        releaseEvidenceSha256: HASH_B,
        winnerGenerationId: `sc:generation:${HASH_D}`,
        winnerManifestSha256: HASH_A,
        winnerCasRevision: HASH_D,
      }),
    ).toThrow(/nonidentical winner/u);
    expect(() =>
      assertIdenticalFinalizationWinner(expected, {
        destinationIdentitySha256: HASH_C,
        releaseManifestSha256: HASH_A,
        releaseEvidenceSha256: HASH_B,
        winnerGenerationId: input.generationId,
        winnerManifestSha256: HASH_B,
        winnerCasRevision: HASH_D,
      }),
    ).toThrow(/nonidentical winner/u);
  });
});
