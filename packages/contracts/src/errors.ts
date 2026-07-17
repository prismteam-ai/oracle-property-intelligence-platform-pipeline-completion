import { z } from 'zod';

import { nonEmptyStringSchema } from './foundation.js';
import { runIdSchema, sourceIdSchema } from './ids.js';

export const oracleErrorCodeSchema = z.enum([
  'TRANSIENT_SOURCE',
  'AUTHENTICATION',
  'TERMS_ACCESS',
  'SCHEMA_DRIFT',
  'RECORD_QUALITY',
  'RECONCILIATION',
  'PUBLICATION',
  'RESTRICTED_DATA_LEAK',
  'QUERY_REGRESSION',
]);

export type OracleErrorCode = z.infer<typeof oracleErrorCodeSchema>;

const oracleErrorContextShape = {
  message: nonEmptyStringSchema,
  sourceId: sourceIdSchema.optional(),
  runId: runIdSchema.optional(),
  phase: nonEmptyStringSchema.optional(),
  details: z.record(z.string(), z.unknown()).optional(),
};

export const oracleErrorSchema = z.discriminatedUnion('code', [
  z.strictObject({
    code: z.literal('TRANSIENT_SOURCE'),
    retryable: z.literal(true),
    ...oracleErrorContextShape,
  }),
  z.strictObject({
    code: z.literal('AUTHENTICATION'),
    retryable: z.literal(false),
    ...oracleErrorContextShape,
  }),
  z.strictObject({
    code: z.literal('TERMS_ACCESS'),
    retryable: z.literal(false),
    ...oracleErrorContextShape,
  }),
  z.strictObject({
    code: z.literal('SCHEMA_DRIFT'),
    retryable: z.literal(false),
    ...oracleErrorContextShape,
  }),
  z.strictObject({
    code: z.literal('RECORD_QUALITY'),
    retryable: z.literal(false),
    ...oracleErrorContextShape,
  }),
  z.strictObject({
    code: z.literal('RECONCILIATION'),
    retryable: z.literal(false),
    ...oracleErrorContextShape,
  }),
  z.strictObject({
    code: z.literal('PUBLICATION'),
    retryable: z.literal(false),
    ...oracleErrorContextShape,
  }),
  z.strictObject({
    code: z.literal('RESTRICTED_DATA_LEAK'),
    retryable: z.literal(false),
    ...oracleErrorContextShape,
  }),
  z.strictObject({
    code: z.literal('QUERY_REGRESSION'),
    retryable: z.literal(false),
    ...oracleErrorContextShape,
  }),
]);

export type OracleError = z.infer<typeof oracleErrorSchema>;

export function isRetryableOracleError(error: OracleError): boolean {
  return error.retryable;
}
