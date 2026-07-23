import {
  createCheckpointEnvelope,
  type CheckpointEnvelope,
  type CheckpointStore,
  type CheckpointValue,
} from '@oracle/artifacts/checkpoint-store';

import type { PersistedRunState } from './types.js';

export function runCheckpointScope(runId: string): string {
  return `pipeline-run:${runId}`;
}

export async function loadRunState(
  store: CheckpointStore,
  runId: string,
): Promise<
  Readonly<{ envelope: CheckpointEnvelope | undefined; state: PersistedRunState | undefined }>
> {
  const envelope = await store.load(runCheckpointScope(runId));
  if (envelope === undefined) return Object.freeze({ envelope: undefined, state: undefined });
  return Object.freeze({ envelope, state: parseRunState(envelope.payload) });
}

export async function commitRunState(
  input: Readonly<{
    store: CheckpointStore;
    previous: CheckpointEnvelope | undefined;
    state: PersistedRunState;
    writtenAt: string;
  }>,
): Promise<CheckpointEnvelope> {
  const checkpoint = createCheckpointEnvelope({
    scope: runCheckpointScope(input.state.runId),
    previousRevision: input.previous?.revision ?? null,
    writtenAt: input.writtenAt,
    payload: input.state,
  });
  const result = await input.store.commit({
    expectedRevision: input.previous?.revision ?? null,
    checkpoint,
  });
  if (result.status === 'conflict') {
    throw new Error(`Concurrent orchestration checkpoint conflict for ${input.state.runId}`);
  }
  return result.checkpoint;
}

function parseRunState(payload: CheckpointValue): PersistedRunState {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Invalid orchestration checkpoint payload');
  }
  const value = payload as Readonly<Record<string, CheckpointValue>>;
  if (
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    typeof value.runId !== 'string' ||
    typeof value.configurationHash !== 'string' ||
    !Array.isArray(value.sources)
  ) {
    throw new TypeError('Unsupported orchestration checkpoint payload');
  }
  if (value.schemaVersion === 1) {
    const manifestArtifact = value.manifestArtifact;
    if (manifestArtifact === null || manifestArtifact === undefined) {
      throw new LegacyCheckpointIncompatibleError(value.runId);
    }
    // Finalized v1 is immutable/readable. Its manifest short-circuits execution before v2 fields
    // are observed, so it is safe to retain only as a compatibility view.
    return payload as unknown as PersistedRunState;
  }
  return payload as unknown as PersistedRunState;
}

export class LegacyCheckpointIncompatibleError extends Error {
  public readonly code = 'LEGACY_INCOMPLETE_CHECKPOINT';

  public constructor(public readonly runId: string) {
    super(
      `Incomplete orchestration checkpoint v1 for ${runId} cannot resume safely. Preserve it for evidence and start a new v2 run; no source was reacquired.`,
    );
    this.name = 'LegacyCheckpointIncompatibleError';
  }
}
