import { evidenceIdSchema, jsonValueSchema } from '@oracle/contracts';
import { z } from 'zod';

export const SUPPORT_STATES = ['supported', 'proxy', 'unknown', 'unsupported'] as const;
export const evidenceSupportStateSchema = z.enum(SUPPORT_STATES);
export type EvidenceSupportState = z.infer<typeof evidenceSupportStateSchema>;

const withoutControls = (value: string): boolean =>
  !Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || (code >= 127 && code <= 159);
  });
const boundedText = (maximumBytes: number) =>
  z
    .string()
    .trim()
    .min(1)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= maximumBytes)
    .refine(withoutControls);
const boundedId = boundedText(256);
const releaseInput = { releaseId: boundedId.optional() } as const;
const pageInput = {
  limit: z.number().int().min(1).max(100).optional(),
  cursor: boundedText(512).nullable().optional(),
} as const;
const propertyFilters = {
  city: boundedText(100).optional(),
  postalCode: boundedText(20).optional(),
  propertyId: boundedId.optional(),
} as const;

export const namedEvidenceInputSchemas = {
  get_dataset_info: z.strictObject(releaseInput),
  get_dataset_coverage: z.strictObject(releaseInput),
  list_pipeline_runs: z.strictObject({ ...releaseInput, ...pageInput }),
  get_pipeline_run: z.strictObject({ ...releaseInput, runId: boundedId }),
  search_properties: z.strictObject({
    ...releaseInput,
    ...pageInput,
    ...propertyFilters,
    query: boundedText(200)
      .refine((value) => Buffer.byteLength(value, 'utf8') >= 3)
      .optional(),
  }),
  get_property: z.strictObject({ ...releaseInput, propertyId: boundedId }),
  get_property_evidence: z.strictObject({
    ...releaseInput,
    ...pageInput,
    propertyId: boundedId,
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
  }),
  find_roof_age_candidates: z.strictObject({
    ...releaseInput,
    ...pageInput,
    ...propertyFilters,
    minimumAgeYears: z.number().int().min(1).max(200).optional(),
    includeProxy: z.boolean().optional(),
  }),
  find_water_view_candidates: z.strictObject({
    ...releaseInput,
    ...pageInput,
    ...propertyFilters,
    maximumDistanceMeters: z.number().int().min(1).max(50_000).optional(),
    includeProxy: z.boolean().optional(),
  }),
  find_ownership_age_candidates: z.strictObject({
    ...releaseInput,
    ...pageInput,
    ...propertyFilters,
    minimumTenureYears: z.number().int().min(1).max(200).optional(),
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
    maximumNetworkDistanceMeters: z.number().int().min(1).max(10_000).optional(),
    includeProxy: z.boolean().optional(),
  }),
  find_starbucks_walkable_properties: z.strictObject({
    ...releaseInput,
    ...pageInput,
    ...propertyFilters,
    maximumNetworkDistanceMeters: z.number().int().min(1).max(10_000).optional(),
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
  get_data_dictionary: z.strictObject({ ...releaseInput, ...pageInput }),
} as const;

export type NamedEvidenceToolName = keyof typeof namedEvidenceInputSchemas;
export const NAMED_EVIDENCE_TOOL_NAMES = Object.freeze(
  Object.keys(namedEvidenceInputSchemas) as NamedEvidenceToolName[],
);

export const evidenceReferenceSchema = z
  .strictObject({
    evidenceId: evidenceIdSchema,
    propertyId: boundedId.nullable(),
    supportState: evidenceSupportStateSchema,
    sourceIds: z.array(boundedId).max(100),
    limitations: z.array(z.string().trim().min(1).max(2_000)).max(100),
  })
  .superRefine((value, context) => {
    if (
      (value.supportState === 'supported' || value.supportState === 'proxy') &&
      value.sourceIds.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Positive public evidence requires at least one source ID',
        path: ['sourceIds'],
      });
    }
    if (
      (value.supportState === 'unknown' || value.supportState === 'unsupported') &&
      value.limitations.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Non-positive public evidence requires a limitation',
        path: ['limitations'],
      });
    }
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
