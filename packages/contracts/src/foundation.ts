import { z } from 'zod';

export const isoDateTimeSchema = z.iso.datetime({ offset: true });
export const sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, 'Expected a lowercase SHA-256 hex digest');
export const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/u, 'Expected an exact semver');
export const nonEmptyStringSchema = z.string().trim().min(1);

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const foundationCapabilitiesSchema = z.strictObject({
  propertyPipeline: z.literal('not_implemented'),
  queryExperience: z.literal('not_implemented'),
  mcpProtocol: z.literal('not_implemented'),
});

export const foundationStatusSchema = z.strictObject({
  operation: z.literal('foundation.status'),
  service: z.literal('oracle-property-intelligence-platform'),
  state: z.literal('foundation_only'),
  capabilities: foundationCapabilitiesSchema,
});

export type FoundationStatus = z.infer<typeof foundationStatusSchema>;

export const FOUNDATION_STATUS: FoundationStatus = Object.freeze({
  operation: 'foundation.status',
  service: 'oracle-property-intelligence-platform',
  state: 'foundation_only',
  capabilities: Object.freeze({
    propertyPipeline: 'not_implemented',
    queryExperience: 'not_implemented',
    mcpProtocol: 'not_implemented',
  }),
});

export const healthResponseSchema = z.strictObject({
  service: z.enum(['api', 'mcp']),
  status: z.literal('ok'),
  foundationOnly: z.literal(true),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(['UNKNOWN_OPERATION', 'INVALID_REQUEST']),
    message: nonEmptyStringSchema,
    operation: nonEmptyStringSchema.optional(),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

export const operationRequestSchema = z.strictObject({
  operation: nonEmptyStringSchema,
});

export type OperationRequest = z.infer<typeof operationRequestSchema>;

export const mcpFoundationErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.literal('MCP_FOUNDATION_ONLY'),
    message: nonEmptyStringSchema,
  }),
});

export type McpFoundationError = z.infer<typeof mcpFoundationErrorSchema>;
