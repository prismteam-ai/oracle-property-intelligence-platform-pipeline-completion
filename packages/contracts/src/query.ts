import { z } from 'zod';

import {
  isoDateTimeSchema,
  jsonValueSchema,
  nonEmptyStringSchema,
  semverSchema,
} from './foundation.js';
import { evidenceIdSchema, manifestIdSchema } from './ids.js';
import { coverageMetricSchema } from './pipeline.js';
import { visibilitySchema } from './visibility.js';

export const namedQueryNameSchema = z.enum([
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
]);

export type NamedQueryName = z.infer<typeof namedQueryNameSchema>;

export const deterministicSortSchema = z.strictObject({
  field: nonEmptyStringSchema,
  direction: z.enum(['asc', 'desc']),
  nulls: z.enum(['first', 'last']),
});

export type DeterministicSort = z.infer<typeof deterministicSortSchema>;

export const namedQueryDefinitionSchema = z.strictObject({
  name: namedQueryNameSchema,
  contractVersion: semverSchema,
  description: nonEmptyStringSchema,
  maximumScanBytes: z.number().int().positive(),
  maximumResults: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  deterministicSort: z.array(deterministicSortSchema).min(1),
  maximumVisibility: visibilitySchema,
});

export type NamedQueryDefinition = z.infer<typeof namedQueryDefinitionSchema>;

export const namedQueryPageSchema = z.strictObject({
  limit: z.number().int().positive().max(1_000),
  cursor: nonEmptyStringSchema.nullable(),
});

export type NamedQueryPage = z.infer<typeof namedQueryPageSchema>;

export const namedQueryRequestSchema = z.strictObject({
  query: namedQueryNameSchema,
  releaseManifestId: manifestIdSchema,
  parameters: z.record(z.string(), jsonValueSchema),
  page: namedQueryPageSchema,
});

export type NamedQueryRequest = z.infer<typeof namedQueryRequestSchema>;

export const namedQueryResultSchema = z.strictObject({
  query: namedQueryNameSchema,
  releaseManifestId: manifestIdSchema,
  status: z.enum(['complete', 'partial', 'degraded']),
  generatedAt: isoDateTimeSchema,
  items: z.array(jsonValueSchema),
  evidenceIds: z.array(evidenceIdSchema),
  coverage: z.array(coverageMetricSchema),
  limitations: z.array(nonEmptyStringSchema),
  nextCursor: nonEmptyStringSchema.nullable(),
});

export type NamedQueryResult = z.infer<typeof namedQueryResultSchema>;
