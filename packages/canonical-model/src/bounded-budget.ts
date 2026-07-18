import { createHash } from 'node:crypto';

import {
  boundedProcessingBudgetSchema,
  type BoundedProcessingBudget,
} from '@oracle/contracts/bounded-processing';

export interface ProcessWideBudgetSnapshot {
  readonly bufferedRecords: number;
  readonly bufferedBytes: number;
  readonly peakBufferedRecords: number;
  readonly peakBufferedBytes: number;
}

/** Structural shape shared with feature-stage ProcessWideFeatureBudget. */
export interface ProcessWideBudgetCoordinator {
  acquire(records: number, bytes: number): () => void;
  assertPolicy(policy: BoundedProcessingBudget): void;
  snapshot(): ProcessWideBudgetSnapshot;
}

export class ProcessWideBudgetExceededError extends Error {
  public readonly code = 'BOUNDED_BUDGET_EXCEEDED' as const;
}

/**
 * A synchronous process-wide lease coordinator. One instance is passed to all
 * concurrent downstream workers and stages. JavaScript execution makes each
 * acquire/release transition atomic within the process.
 */
export class ProcessWideBoundedBudget implements ProcessWideBudgetCoordinator {
  private bufferedRecords = 0;
  private bufferedBytes = 0;
  private peakBufferedRecords = 0;
  private peakBufferedBytes = 0;
  private readonly policy: BoundedProcessingBudget;
  private readonly policySha256: string;

  public constructor(policy: BoundedProcessingBudget) {
    this.policy = boundedProcessingBudgetSchema.parse(policy);
    this.policySha256 = policyHash(this.policy);
  }

  public acquire(records: number, bytes: number): () => void {
    assertSafeNonnegative(records, 'lease records');
    assertSafeNonnegative(bytes, 'lease bytes');
    const nextRecords = this.bufferedRecords + records;
    const nextBytes = this.bufferedBytes + bytes;
    if (nextRecords > this.policy.maxBufferedRecords || nextBytes > this.policy.maxBufferedBytes) {
      throw new ProcessWideBudgetExceededError('Process-wide buffered budget was exceeded');
    }
    this.bufferedRecords = nextRecords;
    this.bufferedBytes = nextBytes;
    this.peakBufferedRecords = Math.max(this.peakBufferedRecords, nextRecords);
    this.peakBufferedBytes = Math.max(this.peakBufferedBytes, nextBytes);
    let released = false;
    return () => {
      if (released) throw new Error('Process-wide budget lease was released twice');
      released = true;
      this.bufferedRecords -= records;
      this.bufferedBytes -= bytes;
    };
  }

  public assertPolicy(policy: BoundedProcessingBudget): void {
    const parsed = boundedProcessingBudgetSchema.parse(policy);
    if (policyHash(parsed) !== this.policySha256) {
      throw new ProcessWideBudgetExceededError(
        'Process-wide budget coordinator does not match the requested policy',
      );
    }
  }

  public snapshot(): ProcessWideBudgetSnapshot {
    return Object.freeze({
      bufferedRecords: this.bufferedRecords,
      bufferedBytes: this.bufferedBytes,
      peakBufferedRecords: this.peakBufferedRecords,
      peakBufferedBytes: this.peakBufferedBytes,
    });
  }
}

function assertSafeNonnegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function policyHash(policy: BoundedProcessingBudget): string {
  const ordered = Object.entries(policy).sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256').update(JSON.stringify(ordered), 'utf8').digest('hex');
}
