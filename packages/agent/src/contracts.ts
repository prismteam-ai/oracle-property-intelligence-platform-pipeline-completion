import { evidenceIdSchema, jsonValueSchema } from '@oracle/contracts';
import { z } from 'zod';

export const SUPPORT_STATES = ['supported', 'proxy', 'unknown', 'unsupported'] as const;
export const evidenceSupportStateSchema = z.enum(SUPPORT_STATES);
export type EvidenceSupportState = z.infer<typeof evidenceSupportStateSchema>;

const boundedId = z.string().trim().min(1).max(256);
const releaseInput = { releaseId: boundedId } as const;
const pageInput = {
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().max(512).nullable().optional(),
} as const;
const propertyFilters = {
  city: z.string().trim().min(1).max(128).optional(),
  postalCode: z.string().trim().min(1).max(16).optional(),
  propertyId: boundedId.optional(),
} as const;

export const namedEvidenceInputSchemas = {
  get_dataset_info: z.strictObject(releaseInput),
  get_dataset_coverage: z.strictObject({ ...releaseInput, dataset: boundedId.optional() }),
  list_pipeline_runs: z.strictObject({ ...releaseInput, ...pageInput }),
  get_pipeline_run: z.strictObject({ ...releaseInput, runId: boundedId }),
  search_properties: z.strictObject({
    ...releaseInput,
    ...pageInput,
    ...propertyFilters,
    query: z.string().trim().min(1).max(256).optional(),
  }),
  get_property: z.strictObject({ ...releaseInput, propertyId: boundedId }),
  get_property_evidence: z.strictObject({ ...releaseInput, propertyId: boundedId }),
  find_roof_age_candidates: z.strictObject({
    ...releaseInput,
    ...pageInput,
    ...propertyFilters,
    minimumAgeYears: z.number().min(0).max(200).optional(),
    includeProxy: z.boolean().optional(),
  }),
  find_water_view_candidates: z.strictObject({
    ...releaseInput,
    ...pageInput,
    ...propertyFilters,
    maximumDistanceMeters: z.number().positive().max(50_000).optional(),
    includeProxy: z.boolean().optional(),
  }),
  find_ownership_age_candidates: z.strictObject({
    ...releaseInput,
    ...pageInput,
    ...propertyFilters,
    minimumTenureYears: z.number().min(0).max(200).optional(),
  }),
  find_regional_owner_properties: z.strictObject({
    ...releaseInput,
    ...pageInput,
    ...propertyFilters,
    regionPolicyId: boundedId.optional(),
  }),
  find_transit_walkable_properties: z.strictObject({
    ...releaseInput,
    ...pageInput,
    ...propertyFilters,
    maximumNetworkDistanceMeters: z.number().positive().max(20_000).optional(),
    includeProxy: z.boolean().optional(),
  }),
  find_starbucks_walkable_properties: z.strictObject({
    ...releaseInput,
    ...pageInput,
    ...propertyFilters,
    maximumNetworkDistanceMeters: z.number().positive().max(20_000).optional(),
    includeProxy: z.boolean().optional(),
  }),
  rank_review_candidates: z.strictObject({
    ...releaseInput,
    ...pageInput,
    ...propertyFilters,
    includeProxy: z.boolean().optional(),
    minimumEvidenceCoverage: z.number().min(0).max(1).optional(),
  }),
  list_artifacts: z.strictObject({ ...releaseInput, ...pageInput }),
  get_data_dictionary: z.strictObject({ ...releaseInput }),
} as const;

export type NamedEvidenceToolName = keyof typeof namedEvidenceInputSchemas;
export const NAMED_EVIDENCE_TOOL_NAMES = Object.freeze(
  Object.keys(namedEvidenceInputSchemas) as NamedEvidenceToolName[],
);

export const evidenceReferenceSchema = z.strictObject({
  evidenceId: evidenceIdSchema,
  propertyId: boundedId.nullable(),
  supportState: evidenceSupportStateSchema,
  sourceIds: z.array(boundedId).max(100),
  limitations: z.array(z.string().trim().min(1).max(2_000)).max(100),
});

export const namedEvidenceEnvelopeSchema = z
  .strictObject({
    schemaVersion: boundedId,
    releaseId: boundedId,
    runId: boundedId,
    manifestCid: boundedId,
    asOf: z.iso.datetime({ offset: true }),
    coverage: jsonValueSchema,
    limitations: z.array(z.string().trim().min(1).max(2_000)).max(100),
    data: jsonValueSchema,
    evidence: z.array(evidenceReferenceSchema).max(1_000),
    nextCursor: z.string().max(512).nullable(),
    truncated: z.boolean(),
    timing: z.strictObject({
      elapsedMs: z.number().nonnegative(),
      bytesScanned: z.number().int().nonnegative().nullable(),
    }),
  })
  .superRefine((value, context) => {
    const ids = value.evidence.map(({ evidenceId }) => evidenceId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: 'custom',
        message: 'Evidence IDs must be unique',
        path: ['evidence'],
      });
    }
  });

export type NamedEvidenceEnvelope = z.infer<typeof namedEvidenceEnvelopeSchema>;

export type NamedEvidenceExecutor = Readonly<{
  execute: (
    name: NamedEvidenceToolName,
    input: Readonly<Record<string, unknown>>,
    options: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<unknown>;
}>;
