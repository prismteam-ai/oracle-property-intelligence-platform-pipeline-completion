import {
  API_LIMITS,
  API_SCHEMA_VERSION,
  queryOperationByApplicationOperation,
  type ApplicationOperation,
  type ParsedRequest,
  type QueryApplicationOperation,
} from './contract.js';
import { ApiFailure } from './errors.js';
import type { ApiSuccessEnvelope, RuntimeServices } from './runtime.js';

function isQueryOperation(operation: ApplicationOperation): operation is QueryApplicationOperation {
  return operation in queryOperationByApplicationOperation;
}

async function bounded<T>(
  durationMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ApiFailure('QUERY_BUDGET_EXCEEDED'));
    }, durationMs);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function verifyRelease(
  actual: { releaseId: string; immutable: boolean; verified: boolean },
  requested: string | null,
): void {
  if (!actual.immutable || !actual.verified) throw new ApiFailure('DATA_CORRUPTION');
  if (requested !== null && actual.releaseId !== requested)
    throw new ApiFailure('RELEASE_MISMATCH');
}

export async function executeOperation(
  services: RuntimeServices,
  operation: ApplicationOperation,
  request: ParsedRequest,
): Promise<ApiSuccessEnvelope> {
  if (isQueryOperation(operation)) {
    const result = await bounded(API_LIMITS.queryTimeoutMs, (signal) =>
      services.query.execute({
        operation: queryOperationByApplicationOperation[operation],
        releaseId: request.releaseId,
        parameters: request.parameters,
        cursor: request.cursor,
        budget: {
          timeoutMs: API_LIMITS.queryTimeoutMs,
          maximumScanBytes: API_LIMITS.maximumScanBytes,
          maximumResults: request.limit,
        },
        signal,
      }),
    );
    verifyRelease(result.release, request.releaseId);
    if (
      result.timing.elapsedMs < 0 ||
      (result.timing.bytesScanned !== null &&
        (result.timing.bytesScanned < 0 ||
          result.timing.bytesScanned > API_LIMITS.maximumScanBytes))
    )
      throw new ApiFailure('QUERY_BUDGET_EXCEEDED');
    if (
      result.nextCursor !== null &&
      Buffer.byteLength(result.nextCursor, 'utf8') > API_LIMITS.cursorBytes
    )
      throw new ApiFailure('DATA_CORRUPTION');
    return Object.freeze({
      schemaVersion: API_SCHEMA_VERSION,
      releaseId: result.release.releaseId,
      runId: result.release.runId,
      manifestCid: result.release.manifestCid,
      asOf: result.release.asOf,
      coverage: result.coverage,
      limitations: Object.freeze([...result.limitations]),
      data: result.data,
      nextCursor: result.nextCursor,
      truncated: result.truncated,
      timing: result.timing,
    });
  }

  const releaseId = request.releaseId;
  if (releaseId === null) throw new ApiFailure('INVALID_REQUEST');
  const agent = services.agent;
  if (agent === null) throw new ApiFailure('AGENT_UNAVAILABLE');
  if (operation === 'agent.status') {
    const status = await bounded(API_LIMITS.queryTimeoutMs, (signal) =>
      agent.status(releaseId, signal),
    );
    verifyRelease(status.release, releaseId);
    return Object.freeze({
      schemaVersion: API_SCHEMA_VERSION,
      releaseId: status.release.releaseId,
      runId: status.release.runId,
      manifestCid: status.release.manifestCid,
      asOf: status.release.asOf,
      coverage: {},
      limitations: status.limitations,
      data: status,
      nextCursor: null,
      truncated: false,
      timing: { elapsedMs: 0, bytesScanned: 0 },
    });
  }
  const prompt = request.parameters.prompt;
  if (typeof prompt !== 'string') throw new ApiFailure('INVALID_REQUEST');
  const result = await bounded(API_LIMITS.agentTimeoutMs, (signal) =>
    agent.ask({
      releaseId,
      prompt,
      maximumToolCalls: 6,
      maximumSteps: 3,
      timeoutMs: API_LIMITS.agentTimeoutMs,
      signal,
    }),
  );
  verifyRelease(result.release, releaseId);
  return Object.freeze({
    schemaVersion: API_SCHEMA_VERSION,
    releaseId: result.release.releaseId,
    runId: result.release.runId,
    manifestCid: result.release.manifestCid,
    asOf: result.release.asOf,
    coverage: {},
    limitations: result.limitations,
    data: { status: result.status, answer: result.answer, citations: result.citations },
    nextCursor: null,
    truncated: false,
    timing: result.timing,
  });
}
