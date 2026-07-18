import { createHash } from 'node:crypto';

import { z } from 'zod';

import { canonicalMutationSchema, type CanonicalMutation } from './canonical/mutation.js';
import {
  isoDateTimeSchema,
  nonEmptyStringSchema,
  semverSchema,
  sha256Schema,
} from './foundation.js';
import { runIdSchema, snapshotBelongsToSource, snapshotIdSchema, sourceIdSchema } from './ids.js';
import { acquiredArtifactSchema } from './source.js';
import { visibilitySchema } from './visibility.js';

export const BOUNDED_PROCESSOR_KIND = 'bounded_streaming_v2' as const;
export const BOUNDED_PROCESSING_CONTRACT_VERSION = '2.0.0' as const;
export const BOUNDED_MUTATION_CHUNK_SCHEMA_VERSION = '2.0.0' as const;
export const BOUNDED_MAX_SOURCES = 64 as const;
export const BOUNDED_MAX_CHUNKS_PER_SOURCE = 65_536 as const;
export const BOUNDED_MAX_STAGE_DATASETS = 256 as const;
export const BOUNDED_MAX_INLINE_DESCRIPTORS = 2_048 as const;
export const BOUNDED_MAX_STAGE_ARTIFACTS = BOUNDED_MAX_INLINE_DESCRIPTORS;
export const BOUNDED_MAX_INPUT_HASHES = 256 as const;
export const BOUNDED_MAX_ACQUIRED_ARTIFACTS_PER_SOURCE = 4_096 as const;
export const BOUNDED_MAX_CONTRIBUTORS_PER_SOURCE = 128 as const;
export const BOUNDED_MAX_CAPABILITIES = 64 as const;
export const BOUNDED_MAX_CAPABILITIES_PER_SOURCE = 4 as const;
export const BOUNDED_MAX_LIMITATIONS = 256 as const;
export const BOUNDED_MAX_DESCRIPTOR_PAGE_SIZE = 2_048 as const;
export const BOUNDED_MAX_DESCRIPTOR_PAGES = 65_536 as const;

/**
 * Frozen county-completion vocabulary. These are authority-owned identifiers,
 * not labels a run may extend or reinterpret.
 */
export const BOUNDED_AUTHORITATIVE_COUNTY_CAPABILITIES = Object.freeze([
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

export const boundedAuthoritativeCountyCapabilitySchema = z.enum(
  BOUNDED_AUTHORITATIVE_COUNTY_CAPABILITIES,
);
export type BoundedAuthoritativeCountyCapability = z.infer<
  typeof boundedAuthoritativeCountyCapabilitySchema
>;

export const BOUNDED_AUTHORITATIVE_CAPABILITY_SOURCE_IDS = Object.freeze({
  santa_clara_parcels: Object.freeze(['sc:source:santa-clara-socrata-parcels']),
  san_jose_permits: Object.freeze(['sc:source:san-jose-building-permits']),
  palo_alto_year_built: Object.freeze(['sc:source:mtc-palo-alto-year-built']),
  vta_gtfs: Object.freeze(['sc:source:vta-static-gtfs']),
  caltrain_gtfs: Object.freeze(['sc:source:caltrain-static-gtfs']),
  transit_511_fallback: Object.freeze([
    'sc:source:511-caltrain-static-gtfs',
    'sc:source:511-vta-static-gtfs',
  ]),
  osm_pedestrian_graph: Object.freeze(['sc:source:osm-pedestrian-graph']),
  noaa_shoreline: Object.freeze(['sc:source:noaa-cusp-shoreline']),
  usgs_hydrography: Object.freeze(['sc:source:usgs-3dhp-hydrography']),
  usgs_elevation: Object.freeze(['sc:source:usgs-3dep-elevation']),
  overture_starbucks: Object.freeze(['sc:source:overture-starbucks']),
  cslb_contractors: Object.freeze(['sc:source:cslb-contractors']),
  ca_sos_businesses: Object.freeze(['sc:source:ca-sos-businesses']),
  ownership_transfers: Object.freeze(['sc:source:santa-clara-ownership-transfers']),
  santa_clara_fbn: Object.freeze(['sc:source:santa-clara-fbn-capability']),
} as const satisfies Readonly<Record<BoundedAuthoritativeCountyCapability, readonly string[]>>);

/** The 15 incorporated cities plus the County's unincorporated authority. */
export const BOUNDED_AUTHORITATIVE_PERMIT_AUTHORITIES = Object.freeze([
  Object.freeze({
    authorityId: 'sc:permit-authority:campbell',
    sourceId: 'sc:source:campbell-building-permits',
  }),
  Object.freeze({
    authorityId: 'sc:permit-authority:cupertino',
    sourceId: 'sc:source:cupertino-building-permits',
  }),
  Object.freeze({
    authorityId: 'sc:permit-authority:gilroy',
    sourceId: 'sc:source:gilroy-building-permits',
  }),
  Object.freeze({
    authorityId: 'sc:permit-authority:los-altos',
    sourceId: 'sc:source:los-altos-building-permits',
  }),
  Object.freeze({
    authorityId: 'sc:permit-authority:los-altos-hills',
    sourceId: 'sc:source:los-altos-hills-building-permits',
  }),
  Object.freeze({
    authorityId: 'sc:permit-authority:los-gatos',
    sourceId: 'sc:source:los-gatos-building-permits',
  }),
  Object.freeze({
    authorityId: 'sc:permit-authority:milpitas',
    sourceId: 'sc:source:milpitas-building-permits',
  }),
  Object.freeze({
    authorityId: 'sc:permit-authority:monte-sereno',
    sourceId: 'sc:source:monte-sereno-building-permits',
  }),
  Object.freeze({
    authorityId: 'sc:permit-authority:morgan-hill',
    sourceId: 'sc:source:morgan-hill-building-permits',
  }),
  Object.freeze({
    authorityId: 'sc:permit-authority:mountain-view',
    sourceId: 'sc:source:mountain-view-building-permits',
  }),
  Object.freeze({
    authorityId: 'sc:permit-authority:palo-alto',
    sourceId: 'sc:source:palo-alto-building-permits',
  }),
  Object.freeze({
    authorityId: 'sc:permit-authority:san-jose',
    sourceId: 'sc:source:san-jose-building-permits',
  }),
  Object.freeze({
    authorityId: 'sc:permit-authority:santa-clara',
    sourceId: 'sc:source:santa-clara-building-permits',
  }),
  Object.freeze({
    authorityId: 'sc:permit-authority:santa-clara-county',
    sourceId: 'sc:source:santa-clara-county-building-permits',
  }),
  Object.freeze({
    authorityId: 'sc:permit-authority:saratoga',
    sourceId: 'sc:source:saratoga-building-permits',
  }),
  Object.freeze({
    authorityId: 'sc:permit-authority:sunnyvale',
    sourceId: 'sc:source:sunnyvale-building-permits',
  }),
] as const);

export const BOUNDED_PROCESSING_STAGES = Object.freeze([
  'partition_mutations',
  'reduce_canonical',
  'build_link_index',
  'reconcile_links',
  'derive_features',
  'build_marts',
  'finalize_release',
] as const);

export const boundedProcessingStageSchema = z.enum(BOUNDED_PROCESSING_STAGES);
export type BoundedProcessingStage = z.infer<typeof boundedProcessingStageSchema>;

export const BOUNDED_PROCESSING_ERROR_CODES = Object.freeze([
  'BOUNDED_INPUT_INTEGRITY',
  'BOUNDED_GENERATION_MISMATCH',
  'BOUNDED_CHECKPOINT_STALE',
  'BOUNDED_MIXED_GENERATION',
  'BOUNDED_ORPHAN_MISMATCH',
  'BOUNDED_BUDGET_EXCEEDED',
  'BOUNDED_FINALIZE_CONFLICT',
  'UNBOUNDED_COUNTY_PHASE',
  'LEGACY_INCOMPLETE_CHECKPOINT',
] as const);

export const boundedProcessingErrorCodeSchema = z.enum(BOUNDED_PROCESSING_ERROR_CODES);
export type BoundedProcessingErrorCode = z.infer<typeof boundedProcessingErrorCodeSchema>;

export const P8_FROZEN_MANIFEST_SHA256 =
  '29b424b88d9a63cd852dc9bbf1dd9c91d46bc8f024005c3dedca63b46376b7ba' as const;
export const P8_FROZEN_MANIFEST_FILE_SHA256 =
  'df24a663efb3c1c4b32923a53b6052ce5d5f6e9bd56fadf164c2165b41e9d8e2' as const;
export const P8_FROZEN_CID = 'bafkreig7estgh35tyhclgkjduu5wauwolvpw5g6vn6w7czgccznud2oy4i' as const;
export const P8_FROZEN_CLOSURE_FILES = Object.freeze([
  'release-manifest.json',
  'serving-config.json',
  'property-query.parquet',
  'property-evidence.parquet',
  'source-coverage.parquet',
  'field-coverage.parquet',
  'relation-coverage.parquet',
  'pipeline-runs.parquet',
  'data-dictionary.parquet',
] as const);

export const boundedProcessorCompatibilityPolicySchema = z.strictObject({
  policyVersion: z.literal('bounded-processor-compatibility-v1'),
  boundedStreamingV2Profiles: z.tuple([z.literal('full'), z.literal('incremental')]),
  smallRunOnlyV1Profiles: z.tuple([z.literal('pilot')]),
  finalizedV1: z.literal('readable_unchanged'),
  incompleteV1ErrorCode: z.literal('LEGACY_INCOMPLETE_CHECKPOINT'),
  rejectedLegacyRunLabels: z.tuple([z.literal('f1')]),
  p8: z.strictObject({
    releaseId: z.literal('santa-clara-p8-public-serving'),
    manifestSha256: z.literal(P8_FROZEN_MANIFEST_SHA256),
    manifestFileSha256: z.literal(P8_FROZEN_MANIFEST_FILE_SHA256),
    cid: z.literal(P8_FROZEN_CID),
    propertyRows: z.literal(19),
    evidenceRows: z.literal(114),
    fieldCoverageRows: z.literal(40),
    relationCoverageRows: z.literal(8),
    sourceCoverageRows: z.literal(14),
    pipelineRunRows: z.literal(1),
    dictionaryRows: z.literal(83),
    restrictedComparisonRows: z.literal(107),
    restrictedSensitiveHashes: z.literal(61),
    publicSensitiveOverlap: z.literal(0),
    closureFiles: z.tuple([
      z.literal('release-manifest.json'),
      z.literal('serving-config.json'),
      z.literal('property-query.parquet'),
      z.literal('property-evidence.parquet'),
      z.literal('source-coverage.parquet'),
      z.literal('field-coverage.parquet'),
      z.literal('relation-coverage.parquet'),
      z.literal('pipeline-runs.parquet'),
      z.literal('data-dictionary.parquet'),
    ]),
  }),
});

export type BoundedProcessorCompatibilityPolicy = z.infer<
  typeof boundedProcessorCompatibilityPolicySchema
>;

export const BOUNDED_PROCESSOR_COMPATIBILITY_POLICY = Object.freeze({
  policyVersion: 'bounded-processor-compatibility-v1',
  boundedStreamingV2Profiles: Object.freeze(['full', 'incremental']),
  smallRunOnlyV1Profiles: Object.freeze(['pilot']),
  finalizedV1: 'readable_unchanged',
  incompleteV1ErrorCode: 'LEGACY_INCOMPLETE_CHECKPOINT',
  rejectedLegacyRunLabels: Object.freeze(['f1']),
  p8: Object.freeze({
    releaseId: 'santa-clara-p8-public-serving',
    manifestSha256: P8_FROZEN_MANIFEST_SHA256,
    manifestFileSha256: P8_FROZEN_MANIFEST_FILE_SHA256,
    cid: P8_FROZEN_CID,
    propertyRows: 19,
    evidenceRows: 114,
    fieldCoverageRows: 40,
    relationCoverageRows: 8,
    sourceCoverageRows: 14,
    pipelineRunRows: 1,
    dictionaryRows: 83,
    restrictedComparisonRows: 107,
    restrictedSensitiveHashes: 61,
    publicSensitiveOverlap: 0,
    closureFiles: P8_FROZEN_CLOSURE_FILES,
  }),
} as const);

const generationIdSchema = z
  .string()
  .regex(/^sc:generation:[a-f0-9]{64}$/u, 'Expected a deterministic generation ID');
const nonnegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const boundedProcessingBudgetSchema = z
  .strictObject({
    policyVersion: z.literal('bounded-process-budget-v1'),
    maxBufferedRecords: positiveSafeIntegerSchema,
    maxBufferedBytes: positiveSafeIntegerSchema,
    maxRssBytes: positiveSafeIntegerSchema,
    duckdbMemoryBytes: positiveSafeIntegerSchema,
    runtimeReserveBytes: positiveSafeIntegerSchema,
    maxOpenFiles: positiveSafeIntegerSchema,
    maxWorkers: positiveSafeIntegerSchema,
    maxRecordsPerOutputChunk: positiveSafeIntegerSchema,
    maxBytesPerOutputChunk: positiveSafeIntegerSchema,
    rssSampleIntervalRecords: positiveSafeIntegerSchema,
  })
  .superRefine((budget, context) => {
    if (budget.maxRecordsPerOutputChunk > budget.maxBufferedRecords) {
      context.addIssue({
        code: 'custom',
        path: ['maxRecordsPerOutputChunk'],
        message: 'Output chunk records cannot exceed the shared record budget',
      });
    }
    if (budget.maxBytesPerOutputChunk > budget.maxBufferedBytes) {
      context.addIssue({
        code: 'custom',
        path: ['maxBytesPerOutputChunk'],
        message: 'Output chunk bytes cannot exceed the shared byte budget',
      });
    }
    if (
      budget.maxBufferedBytes + budget.duckdbMemoryBytes + budget.runtimeReserveBytes >
      budget.maxRssBytes
    ) {
      context.addIssue({
        code: 'custom',
        path: ['maxRssBytes'],
        message: 'Aggregate buffered, DuckDB, and runtime reserve bytes exceed the RSS envelope',
      });
    }
    if (budget.maxOpenFiles < budget.maxWorkers + 4) {
      context.addIssue({
        code: 'custom',
        path: ['maxOpenFiles'],
        message: 'Open-file budget must cover workers and fixed coordinator files',
      });
    }
  });

export type BoundedProcessingBudget = z.infer<typeof boundedProcessingBudgetSchema>;

export const mutationChunkInputSchema = z.strictObject({
  schemaVersion: z.literal(BOUNDED_MUTATION_CHUNK_SCHEMA_VERSION),
  sequence: nonnegativeSafeIntegerSchema,
  firstOrdinal: nonnegativeSafeIntegerSchema,
  lastOrdinal: nonnegativeSafeIntegerSchema,
  recordCount: positiveSafeIntegerSchema,
  logicalKey: nonEmptyStringSchema,
  uri: nonEmptyStringSchema,
  mediaType: z.literal('application/x-ndjson'),
  byteSize: positiveSafeIntegerSchema,
  sha256: sha256Schema,
  visibility: visibilitySchema,
  licenseSnapshotRef: nonEmptyStringSchema,
  resumeCursor: z.string().nullable(),
});

export type MutationChunkInput = z.infer<typeof mutationChunkInputSchema>;

export const boundedDescriptorRootSchema = z.strictObject({
  format: z.literal('oracle-bounded-descriptor-root-v1'),
  descriptorCount: nonnegativeSafeIntegerSchema,
  recordCount: nonnegativeSafeIntegerSchema,
  byteSize: nonnegativeSafeIntegerSchema,
  rootSha256: sha256Schema,
  firstOrderKey: nonEmptyStringSchema.nullable(),
  lastOrderKey: nonEmptyStringSchema.nullable(),
  pageCount: positiveSafeIntegerSchema,
  pageIndexUri: nonEmptyStringSchema,
  pageIndexSha256: sha256Schema,
});

export type BoundedDescriptorRoot = z.infer<typeof boundedDescriptorRootSchema>;

export const boundedDescriptorPageReferenceSchema = z.strictObject({
  page: nonnegativeSafeIntegerSchema,
  uri: nonEmptyStringSchema,
  sha256: sha256Schema,
  descriptorCount: positiveSafeIntegerSchema,
  firstOrderKey: nonEmptyStringSchema,
  lastOrderKey: nonEmptyStringSchema,
});

export const boundedDescriptorPageIndexSchema = z.strictObject({
  format: z.literal('oracle-bounded-descriptor-page-index-v1'),
  pages: z.array(boundedDescriptorPageReferenceSchema).min(1).max(BOUNDED_MAX_DESCRIPTOR_PAGES),
});

export const boundedDescriptorPageSchema = z.strictObject({
  format: z.literal('oracle-bounded-descriptor-page-v1'),
  page: nonnegativeSafeIntegerSchema,
  descriptors: z.array(z.unknown()).min(1).max(BOUNDED_MAX_DESCRIPTOR_PAGE_SIZE),
  pageSha256: sha256Schema,
});

export interface BoundedDescriptorPageResolver {
  /** Implementations must verify immutable bytes before returning parsed JSON. */
  loadPageIndex(reference: Readonly<{ uri: string; sha256: string }>): Promise<unknown>;
  /** Implementations must verify immutable bytes before returning parsed JSON. */
  loadPage(reference: Readonly<{ uri: string; sha256: string }>): Promise<unknown>;
}

export type VerifiedBoundedDescriptorInventory<T> = Readonly<{
  descriptors: AsyncIterable<T>;
  completion: Promise<
    Readonly<{
      descriptorCount: number;
      recordCount: number;
      byteSize: number;
      rootSha256: string;
      firstOrderKey: string;
      lastOrderKey: string;
    }>
  >;
}>;

/**
 * Loads index/pages independently and recomputes every membership, ordering,
 * count, and root claim. Descriptors are yielded only in rooted page order.
 */
export function streamVerifiedBoundedDescriptorInventory<T>(
  input: Readonly<{
    root: BoundedDescriptorRoot;
    resolver: BoundedDescriptorPageResolver;
    parseDescriptor(value: unknown): T;
    orderKey(value: T): string;
    recordCount(value: T): number;
    byteSize(value: T): number;
  }>,
): VerifiedBoundedDescriptorInventory<T> {
  let resolveCompletion!: (
    value: Readonly<{
      descriptorCount: number;
      recordCount: number;
      byteSize: number;
      rootSha256: string;
      firstOrderKey: string;
      lastOrderKey: string;
    }>,
  ) => void;
  let rejectCompletion!: (reason: unknown) => void;
  const completion = new Promise<
    Readonly<{
      descriptorCount: number;
      recordCount: number;
      byteSize: number;
      rootSha256: string;
      firstOrderKey: string;
      lastOrderKey: string;
    }>
  >((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const descriptors = (async function* (): AsyncIterable<T> {
    try {
      const root = boundedDescriptorRootSchema.parse(input.root);
      const rawIndex = await input.resolver.loadPageIndex({
        uri: root.pageIndexUri,
        sha256: root.pageIndexSha256,
      });
      if (canonicalSha256(rawIndex) !== root.pageIndexSha256) {
        throw new BoundedDescriptorInventoryError('page index hash mismatch');
      }
      const index = boundedDescriptorPageIndexSchema.parse(rawIndex);
      if (index.pages.length !== root.pageCount) {
        throw new BoundedDescriptorInventoryError('page omission or duplication');
      }
      const hash = createHash('sha256');
      let descriptorCount = 0;
      let recordCount = 0;
      let byteSize = 0;
      let firstOrderKey: string | null = null;
      let lastOrderKey: string | null = null;
      for (let pageOrdinal = 0; pageOrdinal < index.pages.length; pageOrdinal += 1) {
        const reference = index.pages[pageOrdinal];
        if (reference?.page !== pageOrdinal) {
          throw new BoundedDescriptorInventoryError('page order is not contiguous');
        }
        const rawPage = await input.resolver.loadPage({
          uri: reference.uri,
          sha256: reference.sha256,
        });
        const page = boundedDescriptorPageSchema.parse(rawPage);
        if (
          page.page !== pageOrdinal ||
          page.pageSha256 !== boundedDescriptorPageSha256(page) ||
          canonicalSha256(rawPage) !== reference.sha256 ||
          page.descriptors.length !== reference.descriptorCount
        ) {
          throw new BoundedDescriptorInventoryError('page substitution or count mismatch');
        }
        let pageFirst: string | null = null;
        let pageLast: string | null = null;
        for (const rawDescriptor of page.descriptors) {
          const descriptor = input.parseDescriptor(rawDescriptor);
          const orderKey = input.orderKey(descriptor);
          if (lastOrderKey !== null && compareUtf8(lastOrderKey, orderKey) >= 0) {
            throw new BoundedDescriptorInventoryError('descriptor duplicate or reorder');
          }
          firstOrderKey ??= orderKey;
          lastOrderKey = orderKey;
          pageFirst ??= orderKey;
          pageLast = orderKey;
          descriptorCount += 1;
          recordCount += input.recordCount(descriptor);
          byteSize += input.byteSize(descriptor);
          hash.update(`${canonicalJson(descriptor)}\n`);
          yield descriptor;
        }
        if (pageFirst !== reference.firstOrderKey || pageLast !== reference.lastOrderKey) {
          throw new BoundedDescriptorInventoryError('page boundary mismatch');
        }
      }
      const rootSha256 = hash.digest('hex');
      if (
        firstOrderKey === null ||
        lastOrderKey === null ||
        descriptorCount !== root.descriptorCount ||
        recordCount !== root.recordCount ||
        byteSize !== root.byteSize ||
        firstOrderKey !== root.firstOrderKey ||
        lastOrderKey !== root.lastOrderKey ||
        rootSha256 !== root.rootSha256
      ) {
        throw new BoundedDescriptorInventoryError('root membership/count/order mismatch');
      }
      resolveCompletion(
        Object.freeze({
          descriptorCount,
          recordCount,
          byteSize,
          rootSha256,
          firstOrderKey,
          lastOrderKey,
        }),
      );
    } catch (error) {
      rejectCompletion(error);
      throw error;
    }
  })();
  return Object.freeze({ descriptors, completion });
}

export function boundedDescriptorPageSha256(
  page: Readonly<{
    format: 'oracle-bounded-descriptor-page-v1';
    page: number;
    descriptors: readonly unknown[];
    pageSha256?: string;
  }>,
): string {
  assertArrayBound(page.descriptors, BOUNDED_MAX_DESCRIPTOR_PAGE_SIZE, 'descriptor page');
  return canonicalSha256(withoutKey(page, 'pageSha256'));
}

export class BoundedDescriptorInventoryError extends Error {
  public readonly code: BoundedProcessingErrorCode = 'BOUNDED_INPUT_INTEGRITY';

  public constructor(reason: string) {
    super(`Bounded descriptor inventory rejected: ${reason}`);
    this.name = 'BoundedDescriptorInventoryError';
  }
}

export const mutationSourceInputSchema = z
  .strictObject({
    sourceId: sourceIdSchema,
    snapshotId: snapshotIdSchema,
    mutationSchemaSha256: sha256Schema,
    recordCount: nonnegativeSafeIntegerSchema,
    logicalSha256: sha256Schema,
    chunks: z.array(mutationChunkInputSchema).max(BOUNDED_MAX_INLINE_DESCRIPTORS),
    chunkInventory: boundedDescriptorRootSchema.nullable().optional(),
  })
  .superRefine((source, context) => {
    if (!snapshotBelongsToSource(source.snapshotId, source.sourceId)) {
      context.addIssue({
        code: 'custom',
        path: ['snapshotId'],
        message: 'Mutation snapshot must belong to its source',
      });
    }
    let nextOrdinal = 0;
    let total = 0;
    const logicalKeys = new Set<string>();
    const uris = new Set<string>();
    source.chunks.forEach((chunk, index) => {
      if (
        chunk.sequence !== index ||
        chunk.firstOrdinal !== nextOrdinal ||
        chunk.lastOrdinal !== chunk.firstOrdinal + chunk.recordCount - 1
      ) {
        context.addIssue({
          code: 'custom',
          path: ['chunks', index],
          message: 'Mutation chunks must be ordered, contiguous, and internally consistent',
        });
      }
      if (logicalKeys.has(chunk.logicalKey) || uris.has(chunk.uri)) {
        context.addIssue({
          code: 'custom',
          path: ['chunks', index],
          message: 'Mutation chunk logical keys and URIs must be unique per source',
        });
      }
      logicalKeys.add(chunk.logicalKey);
      uris.add(chunk.uri);
      total += chunk.recordCount;
      nextOrdinal = chunk.lastOrdinal + 1;
    });
    const rooted = source.chunkInventory ?? null;
    if (
      (rooted === null && source.recordCount !== total) ||
      (rooted !== null &&
        (source.chunks.length !== 0 ||
          rooted.recordCount !== source.recordCount ||
          rooted.descriptorCount < 1)) ||
      (source.recordCount === 0) !== (source.chunks.length === 0 && rooted === null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['recordCount'],
        message: 'Source record count must equal its exact chunk aggregate',
      });
    }
  });

export type MutationSourceInput = z.infer<typeof mutationSourceInputSchema>;

const mutationLogShape = {
  format: z.literal('oracle-bounded-mutation-log-v2'),
  recordCount: nonnegativeSafeIntegerSchema,
  logicalSha256: sha256Schema,
  mutationSchemaSha256: sha256Schema,
  physicalManifestSha256: sha256Schema,
  sources: z.array(mutationSourceInputSchema).min(1).max(BOUNDED_MAX_SOURCES),
};

export const boundedMutationLogInputSchema = z
  .strictObject(mutationLogShape)
  .superRefine((log, context) => {
    const sourceIds = new Set<string>();
    const snapshotIds = new Set<string>();
    const logicalKeys = new Set<string>();
    const uris = new Set<string>();
    let total = 0;
    log.sources.forEach((source, index) => {
      if (index > 0 && compareUtf8(log.sources[index - 1]?.sourceId ?? '', source.sourceId) >= 0) {
        context.addIssue({
          code: 'custom',
          path: ['sources', index],
          message: 'Mutation sources must be canonically ordered',
        });
      }
      if (sourceIds.has(source.sourceId) || snapshotIds.has(source.snapshotId)) {
        context.addIssue({
          code: 'custom',
          path: ['sources', index],
          message: 'Mutation sources and snapshots must be unique',
        });
      }
      source.chunks.forEach((chunk, chunkIndex) => {
        if (logicalKeys.has(chunk.logicalKey) || uris.has(chunk.uri)) {
          context.addIssue({
            code: 'custom',
            path: ['sources', index, 'chunks', chunkIndex],
            message: 'Mutation chunks cannot be reused across sources',
          });
        }
        logicalKeys.add(chunk.logicalKey);
        uris.add(chunk.uri);
      });
      sourceIds.add(source.sourceId);
      snapshotIds.add(source.snapshotId);
      if (source.mutationSchemaSha256 !== log.mutationSchemaSha256) {
        context.addIssue({
          code: 'custom',
          path: ['sources', index, 'mutationSchemaSha256'],
          message: 'Every source must use the log mutation schema',
        });
      }
      total += source.recordCount;
    });
    if (total !== log.recordCount) {
      context.addIssue({
        code: 'custom',
        path: ['recordCount'],
        message: 'Mutation-log count must equal its source aggregate',
      });
    }
    const expected = physicalMutationManifestSha256(log);
    if (log.physicalManifestSha256 !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['physicalManifestSha256'],
        message: 'Physical mutation manifest hash does not bind the exact chunks',
      });
    }
  });

export type BoundedMutationLogInput = z.infer<typeof boundedMutationLogInputSchema>;

const canonicalUniqueStringsSchema = (maximum: number, requireOne = false) => {
  const schema = z.array(nonEmptyStringSchema).max(maximum);
  return (requireOne ? schema.min(1) : schema).superRefine((values, context) => {
    if (!isStrictlySortedUnique(values, (value) => value)) {
      context.addIssue({
        code: 'custom',
        message: 'Set-like values must be canonically sorted and unique',
      });
    }
  });
};

export const boundedTrustedAcquiredSourceSchema = z
  .strictObject({
    sourceId: sourceIdSchema,
    snapshotId: snapshotIdSchema,
    acquiredArtifacts: z
      .array(acquiredArtifactSchema)
      .min(1)
      .max(BOUNDED_MAX_ACQUIRED_ARTIFACTS_PER_SOURCE),
    sourceSha256: sha256Schema,
    schemaSha256: sha256Schema,
    asOf: isoDateTimeSchema.nullable(),
    contributors: canonicalUniqueStringsSchema(BOUNDED_MAX_CONTRIBUTORS_PER_SOURCE, true),
    terminalState: z.enum(['succeeded', 'partial', 'blocked', 'failed']),
    permissionState: z.enum(['allowed', 'pending', 'restricted', 'prohibited']),
    limitations: canonicalUniqueStringsSchema(BOUNDED_MAX_LIMITATIONS),
    // Authority-only acquisition lanes are allowed to contribute a permit authority
    // artifact without inventing a capability label. The authoritative registry binds
    // those lanes separately and exactly.
    capabilities: canonicalUniqueStringsSchema(BOUNDED_MAX_CAPABILITIES_PER_SOURCE, false),
    permitAuthorityIds: canonicalUniqueStringsSchema(16),
  })
  .superRefine((source, context) => {
    if (!snapshotBelongsToSource(source.snapshotId, source.sourceId)) {
      context.addIssue({
        code: 'custom',
        path: ['snapshotId'],
        message: 'Trusted acquisition snapshot must belong to its source',
      });
    }
    source.acquiredArtifacts.forEach((artifact, index) => {
      if (artifact.sourceId !== source.sourceId || artifact.snapshotId !== source.snapshotId) {
        context.addIssue({
          code: 'custom',
          path: ['acquiredArtifacts', index],
          message: 'Trusted acquired artifact belongs to another source or snapshot',
        });
      }
    });
    if (!isStrictlySortedUnique(source.acquiredArtifacts, (artifact) => artifact.artifactId)) {
      context.addIssue({
        code: 'custom',
        path: ['acquiredArtifacts'],
        message: 'Trusted acquired artifacts must be canonically sorted and unique',
      });
    }
    if (source.sourceSha256 !== boundedTrustedSourceSha256(source.acquiredArtifacts)) {
      context.addIssue({
        code: 'custom',
        path: ['sourceSha256'],
        message: 'Trusted source hash does not bind the acquired artifact inventory',
      });
    }
    if (source.schemaSha256 !== boundedTrustedSchemaSha256(source.acquiredArtifacts)) {
      context.addIssue({
        code: 'custom',
        path: ['schemaSha256'],
        message: 'Trusted schema hash does not bind acquired schema fingerprints',
      });
    }
    if (
      (source.terminalState !== 'succeeded' || source.permissionState !== 'allowed') &&
      source.limitations.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['limitations'],
        message: 'Incomplete or non-public trusted sources require a limitation',
      });
    }
  });

export type BoundedTrustedAcquiredSource = z.infer<typeof boundedTrustedAcquiredSourceSchema>;

export const boundedTrustedCapabilityEvidenceSchema = z.strictObject({
  capability: nonEmptyStringSchema,
  state: z.enum(['succeeded', 'partial', 'blocked', 'failed', 'not_configured']),
  sourceIds: canonicalUniqueStringsSchema(BOUNDED_MAX_SOURCES),
  limitations: canonicalUniqueStringsSchema(BOUNDED_MAX_LIMITATIONS),
  evidenceSha256: sha256Schema,
});

export type BoundedTrustedCapabilityEvidence = z.infer<
  typeof boundedTrustedCapabilityEvidenceSchema
>;

const boundedAuthoritativeSourceBindingSchema = z.strictObject({
  sourceId: sourceIdSchema,
  sourceSha256: sha256Schema,
  schemaSha256: sha256Schema,
  artifactIds: canonicalUniqueStringsSchema(BOUNDED_MAX_ACQUIRED_ARTIFACTS_PER_SOURCE, true),
});

const boundedAuthoritativeCapabilityBindingSchema = z.strictObject({
  capability: boundedAuthoritativeCountyCapabilitySchema,
  sources: z.array(boundedAuthoritativeSourceBindingSchema).max(2),
});

const permitAuthorityIdSchema = z.enum(
  BOUNDED_AUTHORITATIVE_PERMIT_AUTHORITIES.map(({ authorityId }) => authorityId) as [
    (typeof BOUNDED_AUTHORITATIVE_PERMIT_AUTHORITIES)[number]['authorityId'],
    ...(typeof BOUNDED_AUTHORITATIVE_PERMIT_AUTHORITIES)[number]['authorityId'][],
  ],
);

const boundedAuthoritativePermitBindingSchema = z.strictObject({
  authorityId: permitAuthorityIdSchema,
  source: boundedAuthoritativeSourceBindingSchema,
});

export const boundedAuthoritativeCountyRegistrySchema = z
  .strictObject({
    format: z.literal('oracle-santa-clara-authoritative-registry-v1'),
    county: z.literal('Santa Clara'),
    state: z.literal('CA'),
    capabilities: z
      .array(boundedAuthoritativeCapabilityBindingSchema)
      .length(BOUNDED_AUTHORITATIVE_COUNTY_CAPABILITIES.length),
    permitAuthorities: z
      .array(boundedAuthoritativePermitBindingSchema)
      .length(BOUNDED_AUTHORITATIVE_PERMIT_AUTHORITIES.length),
    registrySha256: sha256Schema,
  })
  .superRefine((registry, context) => {
    if (
      canonicalJson(registry.capabilities.map(({ capability }) => capability)) !==
      canonicalJson(BOUNDED_AUTHORITATIVE_COUNTY_CAPABILITIES)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['capabilities'],
        message: 'Authoritative capabilities must use frozen canonical order',
      });
    }
    registry.capabilities.forEach((binding, index) => {
      const expected = BOUNDED_AUTHORITATIVE_CAPABILITY_SOURCE_IDS[binding.capability];
      const actual = binding.sources.map(({ sourceId }) => sourceId);
      const fallbackAbsent = binding.capability === 'transit_511_fallback' && actual.length === 0;
      if (!fallbackAbsent && canonicalJson(actual) !== canonicalJson(expected)) {
        context.addIssue({
          code: 'custom',
          path: ['capabilities', index, 'sources'],
          message: 'Capability sources differ from the frozen authority mapping',
        });
      }
    });
    if (
      canonicalJson(registry.permitAuthorities.map(({ authorityId }) => authorityId)) !==
        canonicalJson(
          BOUNDED_AUTHORITATIVE_PERMIT_AUTHORITIES.map(({ authorityId }) => authorityId),
        ) ||
      registry.permitAuthorities.some((binding) => {
        const expected = BOUNDED_AUTHORITATIVE_PERMIT_AUTHORITIES.find(
          ({ authorityId }) => authorityId === binding.authorityId,
        );
        return expected?.sourceId !== binding.source.sourceId;
      })
    ) {
      context.addIssue({
        code: 'custom',
        path: ['permitAuthorities'],
        message: 'Permit authorities differ from the frozen 16-authority source mapping',
      });
    }
    if (registry.registrySha256 !== boundedAuthoritativeCountyRegistrySha256(registry)) {
      context.addIssue({
        code: 'custom',
        path: ['registrySha256'],
        message: 'Authoritative county registry self-hash mismatch',
      });
    }
  });

export type BoundedAuthoritativeCountyRegistry = z.infer<
  typeof boundedAuthoritativeCountyRegistrySchema
>;

const trustedAcquisitionManifestShape = {
  format: z.literal('oracle-trusted-acquisition-manifest-v1'),
  runId: runIdSchema,
  county: z.literal('Santa Clara'),
  state: z.literal('CA'),
  createdAt: isoDateTimeSchema,
  runStatus: z.enum(['succeeded', 'partial', 'failed']),
  sources: z.array(boundedTrustedAcquiredSourceSchema).min(1).max(BOUNDED_MAX_SOURCES),
  capabilities: z
    .array(boundedTrustedCapabilityEvidenceSchema)
    .min(1)
    .max(BOUNDED_MAX_CAPABILITIES),
  /** Optional for partial runs; mandatory and exact for a full_county claim. */
  authoritativeCountyRegistry: boundedAuthoritativeCountyRegistrySchema.optional(),
  manifestSha256: sha256Schema,
};

export const boundedTrustedAcquisitionManifestSchema = z
  .strictObject(trustedAcquisitionManifestShape)
  .superRefine((manifest, context) => {
    if (!isStrictlySortedUnique(manifest.sources, (source) => source.sourceId)) {
      context.addIssue({
        code: 'custom',
        path: ['sources'],
        message: 'Trusted sources must be canonically sorted and unique',
      });
    }
    if (!isStrictlySortedUnique(manifest.capabilities, (value) => value.capability)) {
      context.addIssue({
        code: 'custom',
        path: ['capabilities'],
        message: 'Trusted capabilities must be canonically sorted and unique',
      });
    }
    const sources = new Map<string, BoundedTrustedAcquiredSource>(
      manifest.sources.map((source) => [source.sourceId, source]),
    );
    manifest.capabilities.forEach((capability, index) => {
      const declaredSourceIds = manifest.sources
        .filter((source) => source.capabilities.includes(capability.capability))
        .map(({ sourceId }) => sourceId);
      if (canonicalJson(declaredSourceIds) !== canonicalJson(capability.sourceIds)) {
        context.addIssue({
          code: 'custom',
          path: ['capabilities', index, 'sourceIds'],
          message: 'Capability sources must exactly match trusted source declarations',
        });
      }
      if (
        capability.sourceIds.some((sourceId) => !sources.has(sourceId)) ||
        (capability.state === 'not_configured' && capability.sourceIds.length !== 0) ||
        (capability.state !== 'not_configured' && capability.sourceIds.length === 0) ||
        (capability.state !== 'succeeded' && capability.limitations.length === 0)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['capabilities', index],
          message: 'Capability state is not supported by trusted source evidence',
        });
      }
      if (
        capability.state === 'succeeded' &&
        !capability.sourceIds.some(
          (sourceId) => sources.get(sourceId)?.terminalState === 'succeeded',
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['capabilities', index, 'state'],
          message: 'Succeeded capability requires a succeeded trusted source',
        });
      }
      if (
        capability.evidenceSha256 !== boundedTrustedCapabilityEvidenceSha256(capability, sources)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['capabilities', index, 'evidenceSha256'],
          message: 'Capability evidence hash does not bind trusted source and schema hashes',
        });
      }
    });
    if (
      manifest.capabilities.length > 1 &&
      manifest.sources.some((source) => source.capabilities.length === manifest.capabilities.length)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sources'],
        message: 'One source cannot self-attest every county capability',
      });
    }
    if (manifest.manifestSha256 !== boundedTrustedAcquisitionManifestSha256(manifest)) {
      context.addIssue({
        code: 'custom',
        path: ['manifestSha256'],
        message: 'Trusted acquisition manifest self-hash mismatch',
      });
    }
  });

export type BoundedTrustedAcquisitionManifest = z.infer<
  typeof boundedTrustedAcquisitionManifestSchema
>;

export const boundedTrustedAcquisitionReferenceSchema = z.strictObject({
  uri: nonEmptyStringSchema,
  manifestSha256: sha256Schema,
});

export type BoundedTrustedAcquisitionReference = z.infer<
  typeof boundedTrustedAcquisitionReferenceSchema
>;

export interface BoundedTrustedAcquisitionResolver {
  /** Load the immutable manifest and verify the reference against the trusted acquisition store. */
  loadVerified(reference: BoundedTrustedAcquisitionReference): Promise<unknown>;
}

export const boundedReleaseIdentitySchema = z.strictObject({
  releaseId: nonEmptyStringSchema,
  releaseContractVersion: semverSchema,
  county: z.literal('Santa Clara'),
  state: z.literal('CA'),
  generatedAt: isoDateTimeSchema,
});

export type BoundedReleaseIdentity = z.infer<typeof boundedReleaseIdentitySchema>;

export const deterministicPartitionPlanSchema = z.strictObject({
  algorithm: z.literal('sha256-leading-64-bit-modulo-v1'),
  partitionCount: positiveSafeIntegerSchema,
  groupKeyVersion: z.literal('canonical-mutation-group-key-v1'),
  mutationSortVersion: z.literal('length-prefixed-utf8-mutation-sort-v1'),
});

export type DeterministicPartitionPlan = z.infer<typeof deterministicPartitionPlanSchema>;

const stageVersionShape = Object.fromEntries(
  BOUNDED_PROCESSING_STAGES.map((stage) => [stage, nonEmptyStringSchema]),
) as Record<BoundedProcessingStage, typeof nonEmptyStringSchema>;

export const boundedStageVersionsSchema = z.strictObject(stageVersionShape);
export type BoundedStageVersions = z.infer<typeof boundedStageVersionsSchema>;

const processingInputShape = {
  contractVersion: z.literal(BOUNDED_PROCESSING_CONTRACT_VERSION),
  processorKind: z.literal(BOUNDED_PROCESSOR_KIND),
  generationId: generationIdSchema,
  logicalOutputIdentitySha256: sha256Schema,
  runId: runIdSchema,
  pipelineVersion: semverSchema,
  profile: z.enum(['full', 'incremental']),
  configurationSha256: sha256Schema,
  requestedAt: isoDateTimeSchema,
  sourceManifestSha256: sha256Schema,
  capabilityStateSha256: sha256Schema,
  sourceSnapshotIds: z.array(snapshotIdSchema).min(1).max(BOUNDED_MAX_SOURCES),
  release: boundedReleaseIdentitySchema,
  mutationLog: boundedMutationLogInputSchema,
  partitionPlan: deterministicPartitionPlanSchema,
  budget: boundedProcessingBudgetSchema,
  stageVersions: boundedStageVersionsSchema,
};

export const boundedProcessingInputSchema = z
  .strictObject(processingInputShape)
  .superRefine((input, context) => {
    if (!isStrictlySortedUnique(input.sourceSnapshotIds, (value) => value)) {
      context.addIssue({
        code: 'custom',
        path: ['sourceSnapshotIds'],
        message: 'Source snapshot identities must be sorted and unique',
      });
    }
    const logicalIdentity = logicalOutputIdentitySha256(input);
    if (input.logicalOutputIdentitySha256 !== logicalIdentity) {
      context.addIssue({
        code: 'custom',
        path: ['logicalOutputIdentitySha256'],
        message: 'Logical output identity does not match semantic inputs',
      });
    }
    const expectedGenerationId = boundedProcessingGenerationId(input);
    if (input.generationId !== expectedGenerationId) {
      context.addIssue({
        code: 'custom',
        path: ['generationId'],
        message: 'Generation ID does not bind the exact resumable processing input',
      });
    }
  });

export type BoundedProcessingInput = z.infer<typeof boundedProcessingInputSchema>;

export const immutableBoundedArtifactSchema = z
  .strictObject({
    generationId: generationIdSchema,
    stage: boundedProcessingStageSchema,
    dataset: nonEmptyStringSchema,
    partitionId: nonnegativeSafeIntegerSchema,
    sequence: nonnegativeSafeIntegerSchema,
    logicalKey: nonEmptyStringSchema,
    uri: nonEmptyStringSchema,
    mediaType: nonEmptyStringSchema,
    byteSize: nonnegativeSafeIntegerSchema,
    sha256: sha256Schema,
    recordCount: nonnegativeSafeIntegerSchema,
    firstSortKey: z.string().min(1).nullable(),
    lastSortKey: z.string().min(1).nullable(),
    schemaSha256: sha256Schema,
    sourceLineageSha256: sha256Schema,
    licenseIdentitySha256: sha256Schema,
    visibility: z.union([visibilitySchema, z.literal('mixed_internal')]),
  })
  .superRefine((artifact, context) => {
    const empty = artifact.recordCount === 0;
    if (empty !== (artifact.firstSortKey === null && artifact.lastSortKey === null)) {
      context.addIssue({
        code: 'custom',
        path: ['recordCount'],
        message: 'Only empty artifacts may omit both sort boundaries',
      });
    }
    if (
      artifact.firstSortKey !== null &&
      artifact.lastSortKey !== null &&
      compareUtf8(artifact.firstSortKey, artifact.lastSortKey) > 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['lastSortKey'],
        message: 'Artifact sort boundaries are reversed',
      });
    }
  });

export type ImmutableBoundedArtifact = z.infer<typeof immutableBoundedArtifactSchema>;

export const logicalDatasetIdentitySchema = z.strictObject({
  dataset: nonEmptyStringSchema,
  schemaSha256: sha256Schema,
  sortKeyVersion: nonEmptyStringSchema,
  recordCount: nonnegativeSafeIntegerSchema,
  logicalSha256: sha256Schema,
});

export type LogicalDatasetIdentity = z.infer<typeof logicalDatasetIdentitySchema>;

const parentStageSchema = z.strictObject({
  stage: boundedProcessingStageSchema,
  manifestSha256: sha256Schema,
});

const expectedParents = {
  partition_mutations: [],
  reduce_canonical: ['partition_mutations'],
  build_link_index: ['reduce_canonical'],
  reconcile_links: ['reduce_canonical', 'build_link_index'],
  derive_features: ['reduce_canonical', 'reconcile_links'],
  build_marts: ['reduce_canonical', 'reconcile_links', 'derive_features'],
  finalize_release: ['build_marts'],
} as const satisfies Readonly<Record<BoundedProcessingStage, readonly BoundedProcessingStage[]>>;

const stageManifestShape = {
  contractVersion: z.literal(BOUNDED_PROCESSING_CONTRACT_VERSION),
  generationId: generationIdSchema,
  stage: boundedProcessingStageSchema,
  stageVersion: nonEmptyStringSchema,
  inputLogicalSha256s: z.array(sha256Schema).max(BOUNDED_MAX_INPUT_HASHES),
  parents: z.array(parentStageSchema).max(3),
  datasets: z.array(logicalDatasetIdentitySchema).max(BOUNDED_MAX_STAGE_DATASETS),
  artifacts: z.array(immutableBoundedArtifactSchema).max(BOUNDED_MAX_STAGE_ARTIFACTS),
  artifactInventory: z
    .strictObject({
      root: boundedDescriptorRootSchema,
      datasets: z
        .array(
          z.strictObject({
            dataset: nonEmptyStringSchema,
            artifactCount: positiveSafeIntegerSchema,
            recordCount: nonnegativeSafeIntegerSchema,
            rootSha256: sha256Schema,
          }),
        )
        .min(1)
        .max(BOUNDED_MAX_STAGE_DATASETS),
    })
    .nullable()
    .optional(),
  manifestSha256: sha256Schema,
};

export const boundedStageManifestSchema = z
  .strictObject(stageManifestShape)
  .superRefine((manifest, context) => {
    if (!isStrictlySortedUnique(manifest.inputLogicalSha256s, (value) => value)) {
      context.addIssue({
        code: 'custom',
        path: ['inputLogicalSha256s'],
        message: 'Input logical hashes must be sorted and unique',
      });
    }
    const expected = expectedParents[manifest.stage];
    if (
      manifest.parents.length !== expected.length ||
      manifest.parents.some((parent, index) => parent.stage !== expected[index])
    ) {
      context.addIssue({
        code: 'custom',
        path: ['parents'],
        message: 'Stage manifest has stale or malformed parent-stage relations',
      });
    }
    if (!isStrictlySortedUnique(manifest.datasets, (dataset) => dataset.dataset)) {
      context.addIssue({
        code: 'custom',
        path: ['datasets'],
        message: 'Logical datasets must be sorted and unique',
      });
    }
    if (!isStrictlySortedUnique(manifest.artifacts, boundedArtifactOrderKey)) {
      context.addIssue({
        code: 'custom',
        path: ['artifacts'],
        message: 'Bounded artifacts must use canonical unique order',
      });
    }
    const artifactInventory = manifest.artifactInventory ?? null;
    if (artifactInventory !== null) {
      if (manifest.artifacts.length !== 0) {
        context.addIssue({
          code: 'custom',
          path: ['artifacts'],
          message: 'Rooted artifact inventories cannot also inline descriptors',
        });
      }
      if (
        !isStrictlySortedUnique(artifactInventory.datasets, ({ dataset }) => dataset) ||
        artifactInventory.root.descriptorCount !==
          artifactInventory.datasets.reduce((total, dataset) => total + dataset.artifactCount, 0) ||
        artifactInventory.root.recordCount !==
          artifactInventory.datasets.reduce((total, dataset) => total + dataset.recordCount, 0)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['artifactInventory'],
          message: 'Rooted artifact dataset rollups are incomplete or non-canonical',
        });
      }
    }
    const datasets = new Map(manifest.datasets.map((dataset) => [dataset.dataset, dataset]));
    const aggregateCounts = new Map<string, number>();
    const nextSequences = new Map<string, number>();
    manifest.artifacts.forEach((artifact, index) => {
      if (artifact.generationId !== manifest.generationId || artifact.stage !== manifest.stage) {
        context.addIssue({
          code: 'custom',
          path: ['artifacts', index],
          message: 'Stage artifacts cannot mix generations or stages',
        });
      }
      const dataset = datasets.get(artifact.dataset);
      if (dataset?.schemaSha256 !== artifact.schemaSha256) {
        context.addIssue({
          code: 'custom',
          path: ['artifacts', index, 'dataset'],
          message: 'Artifact dataset/schema is not declared by the stage',
        });
      }
      aggregateCounts.set(
        artifact.dataset,
        (aggregateCounts.get(artifact.dataset) ?? 0) + artifact.recordCount,
      );
      const sequenceGroup = `${artifact.dataset}\0${artifact.visibility}\0${artifact.partitionId}`;
      const expectedSequence = nextSequences.get(sequenceGroup) ?? 0;
      if (artifact.sequence !== expectedSequence) {
        context.addIssue({
          code: 'custom',
          path: ['artifacts', index, 'sequence'],
          message: 'Artifact sequences must be contiguous within each dataset partition',
        });
      }
      nextSequences.set(sequenceGroup, expectedSequence + 1);
    });
    const rootedCounts = new Map(
      artifactInventory?.datasets.map((dataset) => [dataset.dataset, dataset.recordCount]),
    );
    manifest.datasets.forEach((dataset, index) => {
      const aggregate =
        artifactInventory === null
          ? (aggregateCounts.get(dataset.dataset) ?? 0)
          : rootedCounts.get(dataset.dataset);
      if (aggregate !== dataset.recordCount) {
        context.addIssue({
          code: 'custom',
          path: ['datasets', index, 'recordCount'],
          message: 'Logical dataset count must equal its artifact aggregate',
        });
      }
    });
    if (manifest.manifestSha256 !== boundedStageManifestSha256(manifest)) {
      context.addIssue({
        code: 'custom',
        path: ['manifestSha256'],
        message: 'Stage manifest self-hash mismatch',
      });
    }
  });

export type BoundedStageManifest = z.infer<typeof boundedStageManifestSchema>;

export const boundedCheckpointStageSchema = z.strictObject({
  stage: boundedProcessingStageSchema,
  outputManifestSha256: sha256Schema,
  partitionLedgerManifestSha256: sha256Schema,
  partitionCount: positiveSafeIntegerSchema,
});

export const boundedFinalizationSchema = z.strictObject({
  state: z.enum(['verified', 'promoted', 'adopted_identical_winner']),
  releaseManifestSha256: sha256Schema,
  releaseEvidenceSha256: sha256Schema,
  destinationIdentitySha256: sha256Schema,
  winnerGenerationId: generationIdSchema,
  winnerManifestSha256: sha256Schema,
  winnerCasRevision: sha256Schema,
});

export const boundedDurablePartitionSchema = z.strictObject({
  stage: boundedProcessingStageSchema,
  partitionId: nonnegativeSafeIntegerSchema,
  ledgerEntryCount: nonnegativeSafeIntegerSchema,
  partitionLedgerManifestSha256: sha256Schema,
  logicalOutputIdentitySha256: sha256Schema,
  outputManifestSha256: sha256Schema,
});

export const boundedActiveCursorSchema = z.strictObject({
  stage: boundedProcessingStageSchema,
  partitionId: nonnegativeSafeIntegerSchema,
  inputSortKey: nonEmptyStringSchema,
  inputContentSha256: sha256Schema,
  inputOrdinal: nonnegativeSafeIntegerSchema,
  outputOrdinal: nonnegativeSafeIntegerSchema,
  durableChunkCount: nonnegativeSafeIntegerSchema,
  outputRecordCount: nonnegativeSafeIntegerSchema,
  outputByteCount: nonnegativeSafeIntegerSchema,
  logicalPrefixSha256: sha256Schema,
  lastDurableArtifact: immutableBoundedArtifactSchema.nullable(),
});

export const boundedOrphanArtifactSchema = z.strictObject({
  artifact: immutableBoundedArtifactSchema,
  exactInputInterval: z.strictObject({
    firstOrdinal: nonnegativeSafeIntegerSchema,
    lastOrdinal: nonnegativeSafeIntegerSchema,
    firstSortKey: nonEmptyStringSchema,
    lastSortKey: nonEmptyStringSchema,
    firstContentSha256: sha256Schema,
    logicalPrefixSha256: sha256Schema,
    outputRecordCount: nonnegativeSafeIntegerSchema,
    outputByteCount: nonnegativeSafeIntegerSchema,
  }),
  expectedStageManifestSha256: sha256Schema,
});

const checkpointShape = {
  schemaVersion: z.literal('oracle-bounded-processing-checkpoint-v1'),
  generationId: generationIdSchema,
  generationSpecSha256: sha256Schema,
  expectedRevision: sha256Schema.nullable(),
  physicalInputManifestSha256: sha256Schema,
  releaseIdentitySha256: sha256Schema,
  logicalOutputIdentitySha256: sha256Schema,
  partitionPlanSha256: sha256Schema,
  budgetPolicySha256: sha256Schema,
  stageVersionsSha256: sha256Schema,
  durablePartitions: z.array(boundedDurablePartitionSchema).max(BOUNDED_MAX_STAGE_ARTIFACTS),
  activeCursor: boundedActiveCursorSchema.nullable(),
  orphanCandidate: boundedOrphanArtifactSchema.nullable(),
  completedStages: z.array(boundedCheckpointStageSchema).max(BOUNDED_PROCESSING_STAGES.length),
  finalization: boundedFinalizationSchema.nullable(),
  checkpointSha256: sha256Schema,
};

export const boundedProcessingCheckpointSchema = z
  .strictObject(checkpointShape)
  .superRefine((checkpoint, context) => {
    if (
      checkpoint.generationSpecSha256 !== checkpoint.generationId.slice('sc:generation:'.length)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['generationSpecSha256'],
        message: 'Checkpoint generation hash must match its generation ID',
      });
    }
    if (!isStrictlySortedUnique(checkpoint.durablePartitions, durablePartitionOrderKey)) {
      context.addIssue({
        code: 'custom',
        path: ['durablePartitions'],
        message: 'Durable partition ledger must be canonically sorted and unique',
      });
    }
    if (
      !isStrictlySortedUnique(checkpoint.completedStages, (value) =>
        stageOrder(value.stage).toString().padStart(2, '0'),
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['completedStages'],
        message: 'Completed stages must be sorted and unique',
      });
    }
    checkpoint.completedStages.forEach((value, index) => {
      if (stageOrder(value.stage) !== index) {
        context.addIssue({
          code: 'custom',
          path: ['completedStages', index],
          message: 'Completed stages must form a durable prefix',
        });
      }
    });
    const completedStageSet = new Set(checkpoint.completedStages.map(({ stage }) => stage));
    const firstIncomplete = BOUNDED_PROCESSING_STAGES[checkpoint.completedStages.length];
    checkpoint.durablePartitions.forEach((partition, index) => {
      if (partition.stage !== firstIncomplete) {
        context.addIssue({
          code: 'custom',
          path: ['durablePartitions', index, 'stage'],
          message: 'Durable partition belongs to a stale or skipped stage',
        });
      }
    });
    if (
      checkpoint.orphanCandidate !== null &&
      checkpoint.orphanCandidate.artifact.stage !== firstIncomplete
    ) {
      context.addIssue({
        code: 'custom',
        path: ['orphanCandidate', 'artifact', 'stage'],
        message: 'Orphan artifact belongs to a stale or skipped stage',
      });
    }
    if (checkpoint.orphanCandidate !== null) {
      const orphan = checkpoint.orphanCandidate;
      const cursor = checkpoint.activeCursor;
      if (cursor === null) {
        context.addIssue({
          code: 'custom',
          path: ['orphanCandidate'],
          message: 'An orphan candidate requires an active durable cursor',
        });
      } else if (
        orphan.artifact.stage !== cursor.stage ||
        orphan.artifact.partitionId !== cursor.partitionId ||
        orphan.artifact.sequence !== cursor.durableChunkCount ||
        orphan.exactInputInterval.firstOrdinal !== cursor.inputOrdinal ||
        orphan.exactInputInterval.firstSortKey !== cursor.inputSortKey ||
        orphan.exactInputInterval.firstContentSha256 !== cursor.inputContentSha256 ||
        orphan.exactInputInterval.logicalPrefixSha256 !== cursor.logicalPrefixSha256 ||
        orphan.artifact.recordCount !== orphan.exactInputInterval.outputRecordCount ||
        orphan.artifact.byteSize !== orphan.exactInputInterval.outputByteCount ||
        orphan.exactInputInterval.outputRecordCount < 1
      ) {
        context.addIssue({
          code: 'custom',
          path: ['orphanCandidate'],
          message: 'Orphan identity does not continue the active cursor exactly',
        });
      }
      if (orphan.artifact.generationId !== checkpoint.generationId) {
        context.addIssue({
          code: 'custom',
          path: ['orphanCandidate', 'artifact', 'generationId'],
          message: 'Orphan artifact cannot cross generations',
        });
      }
      if (
        orphan.exactInputInterval.firstOrdinal > orphan.exactInputInterval.lastOrdinal ||
        compareUtf8(orphan.exactInputInterval.firstSortKey, orphan.exactInputInterval.lastSortKey) >
          0
      ) {
        context.addIssue({
          code: 'custom',
          path: ['orphanCandidate', 'exactInputInterval'],
          message: 'Orphan input interval must be exact and ordered',
        });
      }
    }
    if (
      checkpoint.activeCursor?.stage !== undefined &&
      checkpoint.activeCursor.stage !== firstIncomplete
    ) {
      context.addIssue({
        code: 'custom',
        path: ['activeCursor', 'stage'],
        message: 'Active cursor must belong to the first incomplete stage',
      });
    }
    if (checkpoint.activeCursor?.lastDurableArtifact !== undefined) {
      const artifact = checkpoint.activeCursor.lastDurableArtifact;
      if (
        (checkpoint.activeCursor.durableChunkCount === 0) !==
        (checkpoint.activeCursor.lastDurableArtifact === null)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['activeCursor', 'lastDurableArtifact'],
          message: 'Active cursor durable chunk count must match its last durable artifact',
        });
      }
      if (
        artifact !== null &&
        (artifact.generationId !== checkpoint.generationId ||
          artifact.stage !== checkpoint.activeCursor.stage ||
          artifact.partitionId !== checkpoint.activeCursor.partitionId ||
          artifact.sequence + 1 !== checkpoint.activeCursor.durableChunkCount)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['activeCursor', 'lastDurableArtifact'],
          message: 'Active cursor durable artifact identity is inconsistent',
        });
      }
    }
    if (
      checkpoint.finalization !== null &&
      !completedStageSet.has('finalize_release') &&
      checkpoint.finalization.state !== 'verified'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['finalization'],
        message: 'A promoted finalization requires the final stage checkpoint',
      });
    }
    if (
      checkpoint.finalization !== null &&
      (checkpoint.finalization.winnerGenerationId !== checkpoint.generationId ||
        checkpoint.finalization.winnerManifestSha256 !==
          checkpoint.finalization.releaseManifestSha256)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['finalization'],
        message: 'Finalization winner must bind this generation and exact release manifest',
      });
    }
    if (checkpoint.checkpointSha256 !== boundedProcessingCheckpointSha256(checkpoint)) {
      context.addIssue({
        code: 'custom',
        path: ['checkpointSha256'],
        message: 'Bounded-processing checkpoint self-hash mismatch',
      });
    }
  });

export type BoundedProcessingCheckpoint = z.infer<typeof boundedProcessingCheckpointSchema>;

export function boundedTrustedSourceSha256(
  artifacts: readonly z.infer<typeof acquiredArtifactSchema>[],
): string {
  assertArrayBound(
    artifacts,
    BOUNDED_MAX_ACQUIRED_ARTIFACTS_PER_SOURCE,
    'trusted acquired artifacts',
  );
  return canonicalSha256(
    [...artifacts]
      .sort((left, right) => compareUtf8(left.artifactId, right.artifactId))
      .map(({ artifactId, byteSize, rawUri, sha256 }) => ({
        artifactId,
        byteSize,
        rawUri,
        sha256,
      })),
  );
}

export function boundedTrustedSchemaSha256(
  artifacts: readonly z.infer<typeof acquiredArtifactSchema>[],
): string {
  assertArrayBound(
    artifacts,
    BOUNDED_MAX_ACQUIRED_ARTIFACTS_PER_SOURCE,
    'trusted acquired artifacts',
  );
  return canonicalSha256(
    [...artifacts]
      .sort((left, right) => compareUtf8(left.artifactId, right.artifactId))
      .map(({ artifactId, schemaFingerprint }) => ({ artifactId, schemaFingerprint })),
  );
}

export function boundedTrustedCapabilityEvidenceSha256(
  capability:
    Omit<BoundedTrustedCapabilityEvidence, 'evidenceSha256'> | BoundedTrustedCapabilityEvidence,
  sources: ReadonlyMap<string, BoundedTrustedAcquiredSource>,
): string {
  assertArrayBound(capability.sourceIds, BOUNDED_MAX_SOURCES, 'capability source IDs');
  assertArrayBound(capability.limitations, BOUNDED_MAX_LIMITATIONS, 'capability limitations');
  return canonicalSha256({
    capability: capability.capability,
    state: capability.state,
    sourceEvidence: [...capability.sourceIds].sort(compareUtf8).map((sourceId) => {
      const source = sources.get(sourceId);
      if (source === undefined) return { sourceId, missing: true };
      return {
        sourceId,
        snapshotId: source.snapshotId,
        sourceSha256: source.sourceSha256,
        schemaSha256: source.schemaSha256,
        terminalState: source.terminalState,
      };
    }),
    limitations: [...capability.limitations].sort(compareUtf8),
  });
}

export function boundedTrustedAcquisitionManifestSha256(
  manifest:
    Omit<BoundedTrustedAcquisitionManifest, 'manifestSha256'> | BoundedTrustedAcquisitionManifest,
): string {
  const value = withoutKey(manifest, 'manifestSha256') as Omit<
    BoundedTrustedAcquisitionManifest,
    'manifestSha256'
  >;
  assertArrayBound(value.sources, BOUNDED_MAX_SOURCES, 'trusted sources');
  assertArrayBound(value.capabilities, BOUNDED_MAX_CAPABILITIES, 'trusted capabilities');
  for (const source of value.sources) {
    assertArrayBound(
      source.acquiredArtifacts,
      BOUNDED_MAX_ACQUIRED_ARTIFACTS_PER_SOURCE,
      'trusted acquired artifacts',
    );
    assertArrayBound(source.contributors, BOUNDED_MAX_CONTRIBUTORS_PER_SOURCE, 'contributors');
    assertArrayBound(source.limitations, BOUNDED_MAX_LIMITATIONS, 'source limitations');
    assertArrayBound(
      source.capabilities,
      BOUNDED_MAX_CAPABILITIES_PER_SOURCE,
      'source capabilities',
    );
    assertArrayBound(source.permitAuthorityIds, 16, 'permit authorities');
  }
  return canonicalSha256({
    ...value,
    sources: [...value.sources]
      .sort((left, right) => compareUtf8(left.sourceId, right.sourceId))
      .map((source) => ({
        ...source,
        acquiredArtifacts: [...source.acquiredArtifacts].sort((left, right) =>
          compareUtf8(left.artifactId, right.artifactId),
        ),
        contributors: [...source.contributors].sort(compareUtf8),
        limitations: [...source.limitations].sort(compareUtf8),
        capabilities: [...source.capabilities].sort(compareUtf8),
        permitAuthorityIds: [...source.permitAuthorityIds].sort(compareUtf8),
      })),
    capabilities: canonicalTrustedCapabilities(value.capabilities),
  });
}

export function boundedTrustedCapabilityStateSha256(
  manifest: Pick<BoundedTrustedAcquisitionManifest, 'capabilities'>,
): string {
  assertArrayBound(manifest.capabilities, BOUNDED_MAX_CAPABILITIES, 'trusted capabilities');
  return canonicalSha256(canonicalTrustedCapabilities(manifest.capabilities));
}

export function boundedAuthoritativeCountyRegistrySha256(
  registry:
    Omit<BoundedAuthoritativeCountyRegistry, 'registrySha256'> | BoundedAuthoritativeCountyRegistry,
): string {
  return canonicalSha256(withoutKey(registry, 'registrySha256'));
}

/**
 * Verifies that a full-county registry repeats immutable evidence from the
 * trusted acquisition closure exactly. Caller labels cannot create authority.
 */
export function assertAuthoritativeCountyRegistry(
  manifest: BoundedTrustedAcquisitionManifest,
): BoundedAuthoritativeCountyRegistry {
  const registryInput = manifest.authoritativeCountyRegistry;
  if (registryInput === undefined) {
    throw new BoundedAuthoritativeRegistryError('missing authoritative county registry');
  }
  const registry = boundedAuthoritativeCountyRegistrySchema.parse(registryInput);
  const trustedSources = new Map<string, BoundedTrustedAcquiredSource>(
    manifest.sources.map((source) => [source.sourceId, source]),
  );
  const boundSourceIds = new Set<string>();
  const assertBinding = (
    binding: z.infer<typeof boundedAuthoritativeSourceBindingSchema>,
    label: string,
  ): void => {
    const trusted = trustedSources.get(binding.sourceId);
    if (
      trusted?.sourceSha256 !== binding.sourceSha256 ||
      trusted.schemaSha256 !== binding.schemaSha256 ||
      canonicalJson(trusted.acquiredArtifacts.map(({ artifactId }) => artifactId)) !==
        canonicalJson(binding.artifactIds)
    ) {
      throw new BoundedAuthoritativeRegistryError(`${label} is not bound to trusted artifacts`);
    }
    for (const artifact of trusted.acquiredArtifacts) {
      assertNonsyntheticArtifactUri(artifact.request.url);
      assertNonsyntheticArtifactUri(artifact.response.finalUrl);
      assertNonsyntheticArtifactUri(artifact.rawUri);
    }
    boundSourceIds.add(binding.sourceId);
  };
  for (const capability of registry.capabilities) {
    const trustedCapability = manifest.capabilities.find(
      (candidate) => candidate.capability === capability.capability,
    );
    const sourceIds = capability.sources.map(({ sourceId }) => sourceId);
    if (
      trustedCapability === undefined ||
      canonicalJson(trustedCapability.sourceIds) !== canonicalJson(sourceIds)
    ) {
      throw new BoundedAuthoritativeRegistryError(
        `capability ${capability.capability} differs from trusted evidence`,
      );
    }
    for (const source of capability.sources) assertBinding(source, capability.capability);
  }
  for (const permit of registry.permitAuthorities) {
    assertBinding(permit.source, permit.authorityId);
    const trusted = trustedSources.get(permit.source.sourceId);
    if (
      trusted === undefined ||
      canonicalJson(trusted.permitAuthorityIds) !== canonicalJson([permit.authorityId])
    ) {
      throw new BoundedAuthoritativeRegistryError(
        `permit authority ${permit.authorityId} is not exact trusted source evidence`,
      );
    }
  }
  if (
    manifest.capabilities.length !== BOUNDED_AUTHORITATIVE_COUNTY_CAPABILITIES.length ||
    manifest.capabilities.some(
      ({ capability }) =>
        !BOUNDED_AUTHORITATIVE_COUNTY_CAPABILITIES.some((expected) => expected === capability),
    ) ||
    [...boundSourceIds].some((sourceId) => !trustedSources.has(sourceId))
  ) {
    throw new BoundedAuthoritativeRegistryError('trusted capability inventory is not frozen');
  }
  return registry;
}

export class BoundedAuthoritativeRegistryError extends Error {
  public readonly code: BoundedProcessingErrorCode = 'BOUNDED_INPUT_INTEGRITY';

  public constructor(reason: string) {
    super(`Authoritative county registry rejected: ${reason}`);
    this.name = 'BoundedAuthoritativeRegistryError';
  }
}

function canonicalTrustedCapabilities(
  capabilities: readonly BoundedTrustedCapabilityEvidence[],
): readonly BoundedTrustedCapabilityEvidence[] {
  assertArrayBound(capabilities, BOUNDED_MAX_CAPABILITIES, 'trusted capabilities');
  return [...capabilities]
    .sort((left, right) => compareUtf8(left.capability, right.capability))
    .map((capability) => ({
      ...capability,
      sourceIds: [...capability.sourceIds].sort(compareUtf8),
      limitations: [...capability.limitations].sort(compareUtf8),
    }));
}

function assertNonsyntheticArtifactUri(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BoundedAuthoritativeRegistryError('acquired artifact URI is not absolute');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 's3:') ||
    hostname.length === 0 ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === 'example.com' ||
    hostname.endsWith('.example.com') ||
    hostname === 'example.test' ||
    hostname.endsWith('.example.test') ||
    hostname.endsWith('.invalid')
  ) {
    throw new BoundedAuthoritativeRegistryError('synthetic or untrusted acquired artifact URI');
  }
}

export function physicalMutationManifestSha256(
  input: Omit<BoundedMutationLogInput, 'physicalManifestSha256'> | BoundedMutationLogInput,
): string {
  assertArrayBound(input.sources, BOUNDED_MAX_SOURCES, 'mutation sources');
  for (const source of input.sources) {
    assertArrayBound(source.chunks, BOUNDED_MAX_INLINE_DESCRIPTORS, 'mutation chunks');
  }
  return canonicalSha256(withoutKey(input, 'physicalManifestSha256'));
}

export function logicalOutputIdentitySha256(
  input: Pick<
    BoundedProcessingInput,
    | 'contractVersion'
    | 'processorKind'
    | 'runId'
    | 'pipelineVersion'
    | 'profile'
    | 'configurationSha256'
    | 'requestedAt'
    | 'sourceManifestSha256'
    | 'capabilityStateSha256'
    | 'sourceSnapshotIds'
    | 'release'
    | 'mutationLog'
    | 'partitionPlan'
    | 'stageVersions'
  >,
): string {
  assertArrayBound(input.sourceSnapshotIds, BOUNDED_MAX_SOURCES, 'source snapshot IDs');
  return canonicalSha256({
    contractVersion: input.contractVersion,
    processorKind: input.processorKind,
    runId: input.runId,
    pipelineVersion: input.pipelineVersion,
    profile: input.profile,
    configurationSha256: input.configurationSha256,
    requestedAt: input.requestedAt,
    sourceManifestSha256: input.sourceManifestSha256,
    capabilityStateSha256: input.capabilityStateSha256,
    sourceSnapshotIds: [...input.sourceSnapshotIds].sort(compareUtf8),
    release: input.release,
    logicalMutationInputSha256: logicalMutationInputSha256(input.mutationLog),
    partitionAlgorithms: {
      algorithm: input.partitionPlan.algorithm,
      groupKeyVersion: input.partitionPlan.groupKeyVersion,
      mutationSortVersion: input.partitionPlan.mutationSortVersion,
    },
    stageVersions: input.stageVersions,
  });
}

export function logicalMutationInputSha256(input: BoundedMutationLogInput): string {
  assertArrayBound(input.sources, BOUNDED_MAX_SOURCES, 'mutation sources');
  return canonicalSha256({
    format: input.format,
    recordCount: input.recordCount,
    logicalSha256: input.logicalSha256,
    mutationSchemaSha256: input.mutationSchemaSha256,
    sources: [...input.sources]
      .sort((left, right) => compareUtf8(left.sourceId, right.sourceId))
      .map((source) => ({
        sourceId: source.sourceId,
        snapshotId: source.snapshotId,
        recordCount: source.recordCount,
        logicalSha256: source.logicalSha256,
        mutationSchemaSha256: source.mutationSchemaSha256,
      })),
  });
}

export function releaseIdentitySha256(input: BoundedReleaseIdentity): string {
  return canonicalSha256(input);
}

export function partitionPlanSha256(input: DeterministicPartitionPlan): string {
  return canonicalSha256(input);
}

export function budgetPolicySha256(input: BoundedProcessingBudget): string {
  return canonicalSha256(input);
}

export function stageVersionsSha256(input: BoundedStageVersions): string {
  return canonicalSha256(input);
}

export function boundedGenerationSpecSha256(
  input: Omit<BoundedProcessingInput, 'generationId'> | BoundedProcessingInput,
): string {
  return canonicalSha256(withoutKey(input, 'generationId'));
}

export function boundedProcessingGenerationId(
  input: Omit<BoundedProcessingInput, 'generationId'> | BoundedProcessingInput,
): string {
  return `sc:generation:${boundedGenerationSpecSha256(input)}`;
}

export function boundedStageManifestSha256(
  input: Omit<BoundedStageManifest, 'manifestSha256'> | BoundedStageManifest,
): string {
  assertArrayBound(input.inputLogicalSha256s, BOUNDED_MAX_INPUT_HASHES, 'stage input hashes');
  assertArrayBound(input.parents, 3, 'stage parents');
  assertArrayBound(input.datasets, BOUNDED_MAX_STAGE_DATASETS, 'stage datasets');
  assertArrayBound(input.artifacts, BOUNDED_MAX_STAGE_ARTIFACTS, 'stage artifacts');
  return canonicalSha256(withoutKey(input, 'manifestSha256'));
}

export function boundedProcessingCheckpointSha256(
  input: Omit<BoundedProcessingCheckpoint, 'checkpointSha256'> | BoundedProcessingCheckpoint,
): string {
  assertArrayBound(input.durablePartitions, BOUNDED_MAX_STAGE_ARTIFACTS, 'durable partitions');
  assertArrayBound(input.completedStages, BOUNDED_PROCESSING_STAGES.length, 'completed stages');
  return canonicalSha256(withoutKey(input, 'checkpointSha256'));
}

export function assertCheckpointMatchesInput(
  checkpointInput: unknown,
  processingInput: BoundedProcessingInput,
): BoundedProcessingCheckpoint {
  const checkpoint = boundedProcessingCheckpointSchema.parse(checkpointInput);
  const expected = {
    generationId: processingInput.generationId,
    generationSpecSha256: boundedGenerationSpecSha256(processingInput),
    physicalInputManifestSha256: physicalMutationManifestSha256(processingInput.mutationLog),
    releaseIdentitySha256: releaseIdentitySha256(processingInput.release),
    logicalOutputIdentitySha256: logicalOutputIdentitySha256(processingInput),
    partitionPlanSha256: partitionPlanSha256(processingInput.partitionPlan),
    budgetPolicySha256: budgetPolicySha256(processingInput.budget),
    stageVersionsSha256: stageVersionsSha256(processingInput.stageVersions),
  } as const;
  for (const [key, value] of Object.entries(expected)) {
    if (checkpoint[key as keyof typeof expected] !== value) {
      throw new BoundedCheckpointMismatchError(key);
    }
  }
  if (checkpoint.durablePartitions.length > processingInput.partitionPlan.partitionCount) {
    throw new BoundedCheckpointMismatchError('durablePartitions.length');
  }
  for (const partition of checkpoint.durablePartitions) {
    if (
      partition.partitionId >= processingInput.partitionPlan.partitionCount ||
      partition.logicalOutputIdentitySha256 !== processingInput.logicalOutputIdentitySha256
    ) {
      throw new BoundedCheckpointMismatchError(`durablePartitions.${partition.partitionId}`);
    }
  }
  for (const stage of checkpoint.completedStages) {
    if (stage.partitionCount !== processingInput.partitionPlan.partitionCount) {
      throw new BoundedCheckpointMismatchError(`completedStages.${stage.stage}.partitionCount`);
    }
  }
  if (
    checkpoint.activeCursor !== null &&
    checkpoint.activeCursor.partitionId >= processingInput.partitionPlan.partitionCount
  ) {
    throw new BoundedCheckpointMismatchError('activeCursor.partitionId');
  }
  if (
    checkpoint.orphanCandidate !== null &&
    checkpoint.orphanCandidate.artifact.partitionId >= processingInput.partitionPlan.partitionCount
  ) {
    throw new BoundedCheckpointMismatchError('orphanCandidate.artifact.partitionId');
  }
  if (
    checkpoint.finalization !== null &&
    checkpoint.finalization.winnerGenerationId !== processingInput.generationId
  ) {
    throw new BoundedCheckpointMismatchError('finalization.winnerGenerationId');
  }
  return checkpoint;
}

export class BoundedCheckpointMismatchError extends Error {
  public readonly code: BoundedProcessingErrorCode = 'BOUNDED_MIXED_GENERATION';

  public constructor(public readonly dimension: string) {
    super(`Bounded checkpoint does not match processing input: ${dimension}`);
    this.name = 'BoundedCheckpointMismatchError';
  }
}

export function assertIdenticalFinalizationWinner(
  expected: z.infer<typeof boundedFinalizationSchema>,
  observed: Readonly<{
    destinationIdentitySha256: string;
    releaseManifestSha256: string;
    releaseEvidenceSha256: string;
    winnerGenerationId: string;
    winnerManifestSha256: string;
    winnerCasRevision: string;
  }>,
): 'adopted_identical_winner' {
  if (
    expected.destinationIdentitySha256 !== observed.destinationIdentitySha256 ||
    expected.releaseManifestSha256 !== observed.releaseManifestSha256 ||
    expected.releaseEvidenceSha256 !== observed.releaseEvidenceSha256 ||
    expected.winnerGenerationId !== observed.winnerGenerationId ||
    expected.winnerManifestSha256 !== observed.winnerManifestSha256 ||
    expected.winnerCasRevision !== observed.winnerCasRevision
  ) {
    throw new BoundedFinalizationConflictError();
  }
  return 'adopted_identical_winner';
}

export class BoundedFinalizationConflictError extends Error {
  public readonly code: BoundedProcessingErrorCode = 'BOUNDED_FINALIZE_CONFLICT';

  public constructor() {
    super('Finalization destination has a nonidentical winner');
    this.name = 'BoundedFinalizationConflictError';
  }
}

export function assertProcessorProfileCompatibility(
  profile: 'pilot' | 'full' | 'incremental',
  memoryProfile: 'small_run_only_v1' | 'bounded_streaming_v2',
): void {
  const accepted =
    memoryProfile === 'bounded_streaming_v2'
      ? profile === 'full' || profile === 'incremental'
      : profile === 'pilot';
  if (!accepted) throw new BoundedProcessorProfileError(profile, memoryProfile);
}

export function assertLegacyV1CheckpointCompatibility(
  input: Readonly<{
    runLabel: string;
    finalized: boolean;
  }>,
): 'readable_unchanged' {
  if (
    BOUNDED_PROCESSOR_COMPATIBILITY_POLICY.rejectedLegacyRunLabels.some(
      (runLabel) => runLabel === input.runLabel,
    )
  ) {
    throw new RejectedLegacyRunError(input.runLabel);
  }
  if (!input.finalized) throw new LegacyIncompleteCheckpointError(input.runLabel);
  return 'readable_unchanged';
}

export function assertP8FrozenCompatibility(input: unknown): void {
  boundedProcessorCompatibilityPolicySchema.parse({
    ...BOUNDED_PROCESSOR_COMPATIBILITY_POLICY,
    p8: input,
  });
}

export class BoundedProcessorProfileError extends Error {
  public readonly code: BoundedProcessingErrorCode = 'UNBOUNDED_COUNTY_PHASE';

  public constructor(
    public readonly profile: 'pilot' | 'full' | 'incremental',
    public readonly memoryProfile: 'small_run_only_v1' | 'bounded_streaming_v2',
  ) {
    super(`Processor ${memoryProfile} cannot execute profile ${profile}`);
    this.name = 'BoundedProcessorProfileError';
  }
}

export class LegacyIncompleteCheckpointError extends Error {
  public readonly code: BoundedProcessingErrorCode = 'LEGACY_INCOMPLETE_CHECKPOINT';

  public constructor(public readonly runLabel: string) {
    super(`Incomplete legacy v1 checkpoint cannot resume: ${runLabel}`);
    this.name = 'LegacyIncompleteCheckpointError';
  }
}

export class RejectedLegacyRunError extends Error {
  public readonly code: BoundedProcessingErrorCode = 'UNBOUNDED_COUNTY_PHASE';

  public constructor(public readonly runLabel: string) {
    super(`Rejected unbounded legacy run cannot be read or resumed: ${runLabel}`);
    this.name = 'RejectedLegacyRunError';
  }
}

export function boundedArtifactOrderKey(artifact: ImmutableBoundedArtifact): string {
  return [
    artifact.dataset,
    artifact.visibility,
    artifact.partitionId.toString().padStart(12, '0'),
    artifact.sequence.toString().padStart(12, '0'),
    artifact.logicalKey,
  ].join('\0');
}

export function semanticMutationGroupKey(input: unknown): string {
  const mutation = canonicalMutationSchema.parse(input);
  switch (mutation.kind) {
    case 'entity_upsert':
      return mutation.entity.id;
    case 'field_observation':
      return mutation.observation.entityId;
    case 'link_candidate':
      return mutation.link.fromEntityId;
    case 'artifact_reference':
      return mutation.artifact.artifactId;
  }
}

export function partitionForMutation(input: unknown, partitionCount: number): number {
  if (!Number.isSafeInteger(partitionCount) || partitionCount < 1) {
    throw new RangeError('partitionCount must be a positive safe integer');
  }
  const digest = createHash('sha256')
    .update('bounded-streaming-v2\0')
    .update(semanticMutationGroupKey(input))
    .digest();
  const leading = digest.readBigUInt64BE(0);
  return Number(leading % BigInt(partitionCount));
}

export function mutationSortKey(input: unknown): Uint8Array {
  const mutation = canonicalMutationSchema.parse(input);
  const kindRank: Readonly<Record<CanonicalMutation['kind'], string>> = Object.freeze({
    entity_upsert: '0',
    field_observation: '1',
    link_candidate: '2',
    artifact_reference: '3',
  });
  const fieldPath = mutation.kind === 'field_observation' ? mutation.observation.fieldPath : '';
  const nestedIdentity =
    mutation.kind === 'entity_upsert'
      ? mutation.entity.id
      : mutation.kind === 'field_observation'
        ? mutation.observation.observationId
        : mutation.kind === 'link_candidate'
          ? mutation.link.linkId
          : mutation.artifact.artifactId;
  const segments = [
    semanticMutationGroupKey(mutation),
    kindRank[mutation.kind],
    fieldPath,
    nestedIdentity,
    mutation.mutationId,
    canonicalSha256(mutation),
  ];
  return lengthPrefixedUtf8(segments);
}

export function mutationSortKeyHex(input: unknown): string {
  return Buffer.from(mutationSortKey(input)).toString('hex');
}

function durablePartitionOrderKey(
  partition: z.infer<typeof boundedDurablePartitionSchema>,
): string {
  return `${stageOrder(partition.stage).toString().padStart(2, '0')}\0${partition.partitionId
    .toString()
    .padStart(12, '0')}`;
}

function stageOrder(stage: BoundedProcessingStage): number {
  return BOUNDED_PROCESSING_STAGES.indexOf(stage);
}

function isStrictlySortedUnique<T>(values: readonly T[], keyFor: (value: T) => string): boolean {
  let previous: string | undefined;
  for (const value of values) {
    const key = keyFor(value);
    if (previous !== undefined && compareUtf8(previous, key) >= 0) return false;
    previous = key;
  }
  return true;
}

function lengthPrefixedUtf8(values: readonly string[]): Uint8Array {
  assertArrayBound(values, 16, 'mutation sort segments');
  const encoded = values.map((value) => new TextEncoder().encode(value));
  const length = encoded.reduce((total, value) => total + 4 + value.byteLength, 0);
  const output = new Uint8Array(length);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const value of encoded) {
    view.setUint32(offset, value.byteLength, false);
    offset += 4;
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
}

function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Readonly<Record<string, unknown>>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareUtf8(left, right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  throw new TypeError(`Unsupported canonical value: ${typeof value}`);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function withoutKey(value: object, key: string): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).filter(([candidate]) => candidate !== key));
}

function assertArrayBound(values: readonly unknown[], maximum: number, label: string): void {
  if (values.length > maximum) {
    throw new RangeError(`${label} exceeds the bounded maximum of ${maximum}`);
  }
}
