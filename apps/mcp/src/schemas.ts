import { z } from 'zod';

export const MAX_REQUEST_BYTES = 16 * 1024;
export const MAX_CURSOR_BYTES = 512;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_TOOL_PAYLOAD_BYTES = 900 * 1024;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

const authorityIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, 'Expected an opaque identifier');
const propertyIdSchema = authorityIdSchema.describe('Opaque canonical property identifier');
const releaseIdSchema = authorityIdSchema.describe('Immutable release identifier');
const runIdSchema = authorityIdSchema.describe('Pipeline run identifier');
const parcelIdentifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 -]*$/u, 'Expected a parcel identifier');
const citySchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[\p{L}\p{M} .'-]+$/u, 'Expected a city name');
const postalCodeSchema = z.string().regex(/^\d{5}(?:-\d{4})?$/u, 'Expected a US ZIP code');
const isoDateSchema = z.iso.date();

export const cursorSchema = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_CURSOR_BYTES, {
    message: `Cursor must be at most ${MAX_CURSOR_BYTES} UTF-8 bytes`,
  })
  .describe('Opaque, integrity-protected, release-bound continuation cursor');

const pageShape = {
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: cursorSchema.optional(),
};

const filterShape = {
  city: citySchema.optional(),
  postalCode: postalCodeSchema.optional(),
  propertyId: propertyIdSchema.optional(),
};

const releaseShape = { releaseId: releaseIdSchema };

const getDatasetInfoInputSchema = z.strictObject({});
const getDatasetCoverageInputSchema = z.strictObject(releaseShape);
const listPipelineRunsInputSchema = z.strictObject({ ...releaseShape, ...pageShape });
const getPipelineRunInputSchema = z.strictObject({ ...releaseShape, runId: runIdSchema });
const searchPropertiesInputSchema = z.strictObject({
  ...releaseShape,
  ...filterShape,
  parcelIdentifier: parcelIdentifierSchema.optional(),
  ...pageShape,
});
const getPropertyInputSchema = z.strictObject({ ...releaseShape, propertyId: propertyIdSchema });
const getPropertyEvidenceInputSchema = z.strictObject({
  ...releaseShape,
  propertyId: propertyIdSchema,
  feature: z
    .enum([
      'roof_age',
      'water_view_candidate',
      'ownership_age',
      'regional_owner',
      'transit_walkability',
      'starbucks_walkability',
      'combined_review_score',
    ])
    .optional(),
  ...pageShape,
});
const roofAgeInputSchema = z.strictObject({
  ...releaseShape,
  ...filterShape,
  minimumAgeYears: z.number().int().min(1).max(200).default(15),
  asOf: isoDateSchema.optional(),
  evidenceMode: z
    .enum([
      'explicit_completed_roof_work',
      'issued_roof_permit_proxy',
      'no_recent_roof_permit',
      'building_age_proxy',
    ])
    .default('explicit_completed_roof_work'),
  includeProxy: z.boolean().default(false),
  ...pageShape,
});
const waterViewInputSchema = z.strictObject({
  ...releaseShape,
  ...filterShape,
  maximumWaterDistanceMeters: z.number().int().min(1).max(50_000).default(5_000),
  minimumTerrainVisibilityConfidence: z.number().min(0).max(1).default(0.5),
  waterFeatureTypes: z
    .array(z.enum(['ocean', 'bay', 'reservoir', 'lake', 'river', 'stream', 'canal']))
    .min(1)
    .max(7)
    .optional(),
  includeProxy: z.boolean().default(false),
  ...pageShape,
});
const ownershipAgeInputSchema = z.strictObject({
  ...releaseShape,
  ...filterShape,
  minimumTenureYears: z.number().int().min(1).max(200).default(10),
  requireCompleteHistory: z.literal(true).default(true),
  asOf: isoDateSchema.optional(),
  ...pageShape,
});
const regionalOwnerInputSchema = z.strictObject({
  ...releaseShape,
  ...filterShape,
  regionPolicyId: z.literal('bay-area-nine-counties-v1').default('bay-area-nine-counties-v1'),
  requireCurrentOwner: z.literal(true).default(true),
  ...pageShape,
});
const walkabilityShape = {
  ...releaseShape,
  ...filterShape,
  maximumNetworkDistanceMeters: z.number().int().min(1).max(10_000).default(800),
  maximumSnapDistanceMeters: z.number().int().min(1).max(2_000).default(200),
  includeProxy: z.boolean().default(false),
  ...pageShape,
};
const transitWalkabilityInputSchema = z.strictObject({
  ...walkabilityShape,
  serviceDate: isoDateSchema.optional(),
  agencyId: authorityIdSchema.optional(),
  routeId: authorityIdSchema.optional(),
});
const starbucksWalkabilityInputSchema = z.strictObject({
  ...walkabilityShape,
  minimumPlaceConfidence: z.number().min(0).max(1).default(0.7),
});
const rankingCriterionSchema = z.enum([
  'roof_age',
  'water_view_candidate',
  'ownership_age',
  'regional_owner',
  'transit_walkability',
  'starbucks_walkability',
]);
const rankReviewCandidatesInputSchema = z.strictObject({
  ...releaseShape,
  ...filterShape,
  criteria: z.array(rankingCriterionSchema).min(1).max(6),
  weights: z
    .array(
      z.strictObject({
        criterion: rankingCriterionSchema,
        weight: z.number().min(0).max(100),
        proxyMultiplier: z.number().min(0).max(1),
      }),
    )
    .min(1)
    .max(6)
    .optional(),
  includeProxy: z.boolean().default(false),
  minimumEvidenceCoverage: z.number().min(0).max(1).default(0),
  ...pageShape,
});
const listArtifactsInputSchema = z.strictObject({
  ...releaseShape,
  publicationClass: z.literal('public').default('public'),
  ...pageShape,
});
const getDataDictionaryInputSchema = z.strictObject({
  ...releaseShape,
  entity: z
    .enum([
      'property',
      'property_unit',
      'permit',
      'ownership',
      'contractor',
      'business',
      'transit_stop',
      'place',
      'hydro_feature',
    ])
    .optional(),
  ...pageShape,
});

export const evidenceEnvelopeSchema = z.strictObject({
  schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
  releaseId: releaseIdSchema,
  runId: runIdSchema,
  manifestCid: z.string().min(1).max(128),
  asOf: z.iso.datetime({ offset: true }),
  coverage: z.record(z.string(), z.unknown()),
  limitations: z.array(z.string().min(1).max(2_000)).max(100),
  data: z.unknown(),
  nextCursor: cursorSchema.nullable(),
  truncated: z.boolean(),
  timing: z.strictObject({
    elapsedMs: z.number().nonnegative(),
    bytesScanned: z.number().int().nonnegative(),
  }),
});

export type EvidenceEnvelope = z.infer<typeof evidenceEnvelopeSchema>;

export const mcpToolErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum([
      'INVALID_REQUEST',
      'RELEASE_MISMATCH',
      'STALE_OR_TAMPERED_CURSOR',
      'RESULT_TOO_LARGE',
      'QUERY_BUDGET_EXCEEDED',
      'RESTRICTED_EVIDENCE',
      'SERVICE_UNAVAILABLE',
      'INTERNAL_ERROR',
    ]),
    message: z.string().min(1).max(500),
    releaseId: releaseIdSchema.optional(),
  }),
});

export type McpToolError = z.infer<typeof mcpToolErrorSchema>;
export type McpToolErrorCode = McpToolError['error']['code'];

type InputSchema = z.ZodType<Readonly<Record<string, unknown>>>;

export type NamedEvidenceToolDefinition = Readonly<{
  name: NamedEvidenceToolName;
  title: string;
  description: string;
  inputSchema: InputSchema;
}>;

export const namedEvidenceToolNames = [
  'get_dataset_info',
  'get_dataset_coverage',
  'list_pipeline_runs',
  'get_pipeline_run',
  'search_properties',
  'get_property',
  'get_property_evidence',
  'find_roof_age_candidates',
  'find_water_view_candidates',
  'find_ownership_age_candidates',
  'find_regional_owner_properties',
  'find_transit_walkable_properties',
  'find_starbucks_walkable_properties',
  'rank_review_candidates',
  'list_artifacts',
  'get_data_dictionary',
] as const;

export type NamedEvidenceToolName = (typeof namedEvidenceToolNames)[number];

export const namedEvidenceToolDefinitions: readonly NamedEvidenceToolDefinition[] = [
  [
    'get_dataset_info',
    'Dataset info',
    'Discover the current immutable Oracle release.',
    getDatasetInfoInputSchema,
  ],
  [
    'get_dataset_coverage',
    'Dataset coverage',
    'Return source and capability coverage for one release.',
    getDatasetCoverageInputSchema,
  ],
  [
    'list_pipeline_runs',
    'Pipeline runs',
    'List release-bound pipeline runs with stable pagination.',
    listPipelineRunsInputSchema,
  ],
  [
    'get_pipeline_run',
    'Pipeline run',
    'Get one release-bound pipeline run and its limitations.',
    getPipelineRunInputSchema,
  ],
  [
    'search_properties',
    'Search properties',
    'Search public property identities using bounded structured filters.',
    searchPropertiesInputSchema,
  ],
  [
    'get_property',
    'Property detail',
    'Get one public property record by opaque identifier.',
    getPropertyInputSchema,
  ],
  [
    'get_property_evidence',
    'Property evidence',
    'Get source-backed feature evidence for one property.',
    getPropertyEvidenceInputSchema,
  ],
  [
    'find_roof_age_candidates',
    'Roof-age candidates',
    'Find properties using explicit roof evidence or visibly requested proxies.',
    roofAgeInputSchema,
  ],
  [
    'find_water_view_candidates',
    'Water-view candidates',
    'Find potential water-view candidates without claiming an observed view.',
    waterViewInputSchema,
  ],
  [
    'find_ownership_age_candidates',
    'Ownership-age candidates',
    'Find supported ownership-age candidates and preserve unknown states.',
    ownershipAgeInputSchema,
  ],
  [
    'find_regional_owner_properties',
    'Regional-owner properties',
    'Apply the frozen regional-owner policy to supported current-owner evidence.',
    regionalOwnerInputSchema,
  ],
  [
    'find_transit_walkable_properties',
    'Transit-walkable properties',
    'Find properties within bounded pedestrian-network distance of active transit.',
    transitWalkabilityInputSchema,
  ],
  [
    'find_starbucks_walkable_properties',
    'Starbucks-walkable properties',
    'Find properties within bounded pedestrian-network distance of qualified Starbucks places.',
    starbucksWalkabilityInputSchema,
  ],
  [
    'rank_review_candidates',
    'Rank review candidates',
    'Apply a deterministic transparent ranking over selected evidence signals.',
    rankReviewCandidatesInputSchema,
  ],
  [
    'list_artifacts',
    'Release artifacts',
    'List immutable release artifacts and publication classifications.',
    listArtifactsInputSchema,
  ],
  [
    'get_data_dictionary',
    'Data dictionary',
    'Return the release-bound public data dictionary.',
    getDataDictionaryInputSchema,
  ],
].map(([name, title, description, inputSchema]) =>
  Object.freeze({ name, title, description, inputSchema }),
) as readonly NamedEvidenceToolDefinition[];
