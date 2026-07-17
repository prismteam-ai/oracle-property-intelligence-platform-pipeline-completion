import { z } from 'zod';

export const foundationCapabilitiesSchema = z.object({
  propertyPipeline: z.literal('not_implemented'),
  queryExperience: z.literal('not_implemented'),
  mcpProtocol: z.literal('not_implemented'),
});

export const foundationStatusSchema = z.object({
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

export const healthResponseSchema = z.object({
  service: z.enum(['api', 'mcp']),
  status: z.literal('ok'),
  foundationOnly: z.literal(true),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(['UNKNOWN_OPERATION', 'INVALID_REQUEST']),
    message: z.string(),
    operation: z.string().optional(),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

export const operationRequestSchema = z.object({
  operation: z.string().min(1),
});

export type OperationRequest = z.infer<typeof operationRequestSchema>;

export const mcpFoundationErrorSchema = z.object({
  error: z.object({
    code: z.literal('MCP_FOUNDATION_ONLY'),
    message: z.string(),
  }),
});

export type McpFoundationError = z.infer<typeof mcpFoundationErrorSchema>;
