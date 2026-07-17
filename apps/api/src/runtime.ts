import type { NamedQueryName } from '@oracle/contracts';

import type { ApplicationOperation } from './contract.js';

export type ReleaseDescriptor = Readonly<{
  schemaVersion: string;
  releaseId: string;
  runId: string;
  manifestCid: string;
  asOf: string;
  immutable: true;
  verified: true;
}>;

export type QueryBudget = Readonly<{
  timeoutMs: number;
  maximumScanBytes: number;
  maximumResults: number;
}>;

export type QueryRequest = Readonly<{
  operation: NamedQueryName;
  releaseId: string | null;
  parameters: Readonly<Record<string, unknown>>;
  continuation: readonly (number | string)[] | null;
  budget: QueryBudget;
  signal: AbortSignal;
}>;

export type RuntimeTiming = Readonly<{
  elapsedMs: number;
  bytesScanned: number | null;
}>;

export type QueryResult = Readonly<{
  release: ReleaseDescriptor;
  coverage: unknown;
  limitations: readonly string[];
  data: unknown;
  nextContinuation: readonly (number | string)[] | null;
  truncated: boolean;
  timing: RuntimeTiming;
}>;

export type AgentRequest = Readonly<{
  releaseId: string;
  prompt: string;
  maximumToolCalls: 6;
  maximumSteps: 3;
  timeoutMs: number;
  signal: AbortSignal;
}>;

export type AgentResult = Readonly<{
  release: ReleaseDescriptor;
  status: 'available';
  answer: unknown;
  citations: readonly string[];
  limitations: readonly string[];
  timing: RuntimeTiming;
}>;

export type AgentStatus = Readonly<{
  release: ReleaseDescriptor;
  status: 'available' | 'unavailable' | 'policy_drift';
  modelProfile: string | null;
  policyHash: string | null;
  limitations: readonly string[];
}>;

export interface ImmutableQueryService {
  readonly kind: 'verified-immutable-release';
  execute(request: QueryRequest): Promise<QueryResult>;
}

export interface BoundedAgentService {
  readonly kind: 'no-fallback-bounded-agent';
  ask(request: AgentRequest): Promise<AgentResult>;
  status(releaseId: string, signal: AbortSignal): Promise<AgentStatus>;
}

export type RuntimeServices = Readonly<{
  query: ImmutableQueryService;
  agent: BoundedAgentService | null;
  cursorSecret: Uint8Array;
  allowedOrigins: readonly string[];
  deployment: 'production' | 'test';
  readiness: 'ready' | 'unconfigured' | 'test_fixture';
  fixtureLabel?: 'TEST_ONLY_DETERMINISTIC_FIXTURE';
}>;

export type ApiSuccessEnvelope = Readonly<{
  schemaVersion: string;
  releaseId: string;
  runId: string;
  manifestCid: string;
  asOf: string;
  coverage: unknown;
  limitations: readonly string[];
  data: unknown;
  nextCursor: string | null;
  truncated: boolean;
  timing: RuntimeTiming;
}>;

export type ApiErrorCode =
  | 'INVALID_REQUEST'
  | 'REQUEST_TOO_LARGE'
  | 'RESPONSE_TOO_LARGE'
  | 'UNKNOWN_OPERATION'
  | 'METHOD_NOT_ALLOWED'
  | 'ORIGIN_NOT_ALLOWED'
  | 'RELEASE_MISMATCH'
  | 'STALE_CURSOR'
  | 'QUERY_BUDGET_EXCEEDED'
  | 'DATA_CORRUPTION'
  | 'AGENT_UNAVAILABLE'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export type ApiErrorEnvelope = Readonly<{
  error: Readonly<{
    code: ApiErrorCode;
    message: string;
    operation: ApplicationOperation | 'unknown';
    requestId: string;
    retryable: boolean;
  }>;
}>;
