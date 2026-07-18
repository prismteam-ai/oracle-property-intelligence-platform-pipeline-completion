import {
  createCheckpointEnvelope,
  type CheckpointCommit,
  type CheckpointCommitResult,
  type CheckpointEnvelope,
  type CheckpointStore,
  type CheckpointValue,
} from '@oracle/artifacts/checkpoint-store';
import { describe, expect, it } from 'vitest';

import {
  LegacyCheckpointIncompatibleError,
  loadRunState,
  runCheckpointScope,
} from './checkpoint.js';

class FixedCheckpointStore implements CheckpointStore {
  public constructor(private readonly value: CheckpointEnvelope) {}
  public load(): Promise<CheckpointEnvelope | undefined> {
    return Promise.resolve(this.value);
  }
  public commit<TPayload extends CheckpointValue>(
    request: CheckpointCommit<TPayload>,
  ): Promise<CheckpointCommitResult<TPayload>> {
    void request;
    throw new Error('not used');
  }
}

function legacy(manifestArtifact: unknown): CheckpointEnvelope {
  return createCheckpointEnvelope({
    scope: runCheckpointScope('sc:run:legacy'),
    previousRevision: null,
    writtenAt: '2026-07-18T00:00:00.000Z',
    payload: {
      schemaVersion: 1,
      runId: 'sc:run:legacy',
      configurationHash: 'a'.repeat(64),
      sources: [],
      manifestArtifact: manifestArtifact as never,
    },
  });
}

describe('orchestration checkpoint compatibility', () => {
  it('rejects incomplete v1 before any reacquisition with a typed action', async () => {
    await expect(
      loadRunState(new FixedCheckpointStore(legacy(null)), 'sc:run:legacy'),
    ).rejects.toBeInstanceOf(LegacyCheckpointIncompatibleError);
  });

  it('retains finalized v1 as a readable immutable compatibility view', async () => {
    const artifact = {
      phase: 'finalize',
      logicalKey: 'runs/legacy/final.json',
      uri: 'file:///legacy/final.json',
      mediaType: 'application/json',
      byteSize: 2,
      sha256: 'b'.repeat(64),
    };
    const loaded = await loadRunState(new FixedCheckpointStore(legacy(artifact)), 'sc:run:legacy');
    expect(loaded.state?.manifestArtifact).toEqual(artifact);
  });
});
