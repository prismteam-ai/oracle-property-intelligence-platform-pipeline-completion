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
    payload: input.state as unknown as CheckpointValue,
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
    value.schemaVersion !== 1 ||
    typeof value.runId !== 'string' ||
    typeof value.configurationHash !== 'string' ||
    !Array.isArray(value.sources)
  ) {
    throw new TypeError('Unsupported orchestration checkpoint payload');
  }
  return payload as unknown as PersistedRunState;
}
