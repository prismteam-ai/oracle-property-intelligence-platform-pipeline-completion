import {
  evidenceEnvelopeSchema,
  MAX_CURSOR_BYTES,
  MAX_TOOL_PAYLOAD_BYTES,
  mcpToolErrorSchema,
  type EvidenceEnvelope,
  type McpToolError,
  type McpToolErrorCode,
  type NamedEvidenceToolName,
} from './schemas.js';

export type NamedEvidenceRequest = Readonly<{
  tool: NamedEvidenceToolName;
  input: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}>;

export interface NamedEvidenceService {
  execute(request: NamedEvidenceRequest): Promise<unknown>;
  validateCursor?(
    request: Readonly<{
      tool: NamedEvidenceToolName;
      releaseId: string;
      cursor: string;
    }>,
  ): Promise<void> | void;
}

export class NamedEvidenceServiceError extends Error {
  public readonly code: McpToolErrorCode;
  public readonly releaseId: string | undefined;

  public constructor(code: McpToolErrorCode, message: string, releaseId?: string) {
    super(message);
    this.name = 'NamedEvidenceServiceError';
    this.code = code;
    this.releaseId = releaseId;
  }
}

export class UnavailableNamedEvidenceService implements NamedEvidenceService {
  public execute(request: NamedEvidenceRequest): Promise<never> {
    const releaseId =
      typeof request.input.releaseId === 'string' ? request.input.releaseId : undefined;
    return Promise.reject(
      new NamedEvidenceServiceError(
        'SERVICE_UNAVAILABLE',
        'The immutable named-evidence query service is not configured for this runtime.',
        releaseId,
      ),
    );
  }
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function releaseIdFrom(input: Readonly<Record<string, unknown>>): string | undefined {
  return typeof input.releaseId === 'string' ? input.releaseId : undefined;
}

export async function executeBoundedNamedEvidence(
  service: NamedEvidenceService,
  request: NamedEvidenceRequest,
): Promise<EvidenceEnvelope> {
  const releaseId = releaseIdFrom(request.input);
  const cursor = request.input.cursor;
  if (typeof cursor === 'string') {
    if (service.validateCursor === undefined) {
      throw new NamedEvidenceServiceError(
        'STALE_OR_TAMPERED_CURSOR',
        'Cursor validation is unavailable; the request was rejected fail closed.',
        releaseId,
      );
    }
    if (releaseId === undefined) {
      throw new NamedEvidenceServiceError(
        'INVALID_REQUEST',
        'A cursor requires an immutable release identifier.',
      );
    }
    try {
      await service.validateCursor({ tool: request.tool, releaseId, cursor });
    } catch {
      throw new NamedEvidenceServiceError(
        'STALE_OR_TAMPERED_CURSOR',
        'The cursor is invalid, stale, or belongs to another release or operation.',
        releaseId,
      );
    }
  }

  const result = evidenceEnvelopeSchema.parse(await service.execute(request));
  if (releaseId !== undefined && result.releaseId !== releaseId) {
    throw new NamedEvidenceServiceError(
      'RELEASE_MISMATCH',
      'The query result does not match the requested immutable release.',
      releaseId,
    );
  }
  if (
    result.nextCursor !== null &&
    Buffer.byteLength(result.nextCursor, 'utf8') > MAX_CURSOR_BYTES
  ) {
    throw new NamedEvidenceServiceError(
      'RESULT_TOO_LARGE',
      'The query service returned an invalid continuation cursor.',
      result.releaseId,
    );
  }
  if (result.nextCursor !== null) {
    if (service.validateCursor === undefined) {
      throw new NamedEvidenceServiceError(
        'RESULT_TOO_LARGE',
        'The query service returned a cursor without an integrity validator.',
        result.releaseId,
      );
    }
    try {
      await service.validateCursor({
        tool: request.tool,
        releaseId: result.releaseId,
        cursor: result.nextCursor,
      });
    } catch {
      throw new NamedEvidenceServiceError(
        'STALE_OR_TAMPERED_CURSOR',
        'The query service returned a cursor that is not bound to this release and operation.',
        result.releaseId,
      );
    }
  }
  if (byteLength(result) > MAX_TOOL_PAYLOAD_BYTES) {
    throw new NamedEvidenceServiceError(
      'RESULT_TOO_LARGE',
      'The named-evidence result exceeded the response budget.',
      result.releaseId,
    );
  }
  return result;
}

export function toMcpToolError(error: unknown): McpToolError {
  if (error instanceof NamedEvidenceServiceError) {
    return mcpToolErrorSchema.parse({
      error: {
        code: error.code,
        message: error.message,
        ...(error.releaseId === undefined ? {} : { releaseId: error.releaseId }),
      },
    });
  }
  return mcpToolErrorSchema.parse({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'The named-evidence request failed without exposing internal details.',
    },
  });
}
