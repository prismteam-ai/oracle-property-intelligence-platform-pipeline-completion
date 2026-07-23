export type ApplicationOperation =
  | 'dataset.getInfo'
  | 'dataset.getCoverage'
  | 'pipeline.listRuns'
  | 'pipeline.getRun'
  | 'property.search'
  | 'property.get'
  | 'property.getEvidence'
  | 'inquiry.roofAge'
  | 'inquiry.waterCandidates'
  | 'inquiry.ownershipAge'
  | 'inquiry.regionalOwner'
  | 'inquiry.transitWalkability'
  | 'inquiry.starbucksWalkability'
  | 'inquiry.rankCandidates'
  | 'artifacts.list'
  | 'artifacts.getDataDictionary'
  | 'agent.ask'
  | 'agent.status';

export type ApiTiming = Readonly<{
  elapsedMs: number;
  bytesScanned: number | null;
}>;

export type ApiEnvelope = Readonly<{
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
  timing: ApiTiming;
}>;

export interface ApiClient {
  execute(
    operation: ApplicationOperation,
    input: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<ApiEnvelope>;
}

export type QueryState =
  | Readonly<{ status: 'idle' | 'loading'; data: null; error: null }>
  | Readonly<{ status: 'success'; data: ApiEnvelope; error: null }>
  | Readonly<{ status: 'error'; data: null; error: Error }>;

export type TruthState =
  'direct' | 'derived' | 'proxy' | 'partial' | 'blocked' | 'unsupported' | 'unknown';

export type DataRow = Readonly<Record<string, unknown>>;
