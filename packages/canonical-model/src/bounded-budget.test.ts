import { describe, expect, it } from 'vitest';

import { ProcessWideBoundedBudget, ProcessWideBudgetExceededError } from './bounded-budget.js';

const MIB = 1024 * 1024;

const POLICY_512_MIB = Object.freeze({
  policyVersion: 'bounded-process-budget-v1' as const,
  maxBufferedRecords: 4_096,
  maxBufferedBytes: 64 * MIB,
  maxRssBytes: 512 * MIB,
  duckdbMemoryBytes: 256 * MIB,
  runtimeReserveBytes: 128 * MIB,
  maxOpenFiles: 32,
  maxWorkers: 4,
  maxRecordsPerOutputChunk: 1_024,
  maxBytesPerOutputChunk: 16 * MIB,
  rssSampleIntervalRecords: 256,
});

describe('process-wide bounded budget', () => {
  it('coordinates one honest 512 MiB policy and exposes high-water and zero outstanding leases', async () => {
    const coordinator = new ProcessWideBoundedBudget(POLICY_512_MIB);
    const releases = await Promise.all(
      [0, 1, 2, 3].map(async () => {
        await Promise.resolve();
        return coordinator.acquire(1_024, 16 * MIB);
      }),
    );

    expect(coordinator.snapshot()).toEqual({
      bufferedRecords: 4_096,
      bufferedBytes: 64 * MIB,
      peakBufferedRecords: 4_096,
      peakBufferedBytes: 64 * MIB,
    });
    expect(() => coordinator.acquire(1, 1)).toThrow(ProcessWideBudgetExceededError);

    for (const release of releases) release();
    expect(coordinator.snapshot()).toEqual({
      bufferedRecords: 0,
      bufferedBytes: 0,
      peakBufferedRecords: 4_096,
      peakBufferedBytes: 64 * MIB,
    });
  });
});
