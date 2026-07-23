export interface RecordBudgetLease {
  release(): void;
}

export type RecordBudgetMetrics = Readonly<{
  capacity: number;
  inUse: number;
  highWaterRecords: number;
  waiting: number;
  totalAcquired: number;
}>;

export interface SharedRecordBudget {
  readonly capacity: number;
  acquire(signal: AbortSignal): Promise<RecordBudgetLease>;
  /** Returns immediately; callers may spill/flush under an already-held record slot on pressure. */
  tryAcquire(): RecordBudgetLease | undefined;
  metrics(): RecordBudgetMetrics;
}

interface Waiter {
  readonly signal: AbortSignal;
  readonly resolve: (lease: RecordBudgetLease) => void;
  readonly reject: (reason: unknown) => void;
  readonly onAbort: () => void;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Record budget acquisition aborted', { cause: signal.reason });
}

export function createSharedRecordBudget(capacity: number): SharedRecordBudget {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError('Record budget capacity must be a positive safe integer');
  }
  let inUse = 0;
  let highWaterRecords = 0;
  let totalAcquired = 0;
  const waiting: Waiter[] = [];

  const grant = (): RecordBudgetLease => {
    inUse += 1;
    totalAcquired += 1;
    highWaterRecords = Math.max(highWaterRecords, inUse);
    let released = false;
    return Object.freeze({
      release: () => {
        if (released) return;
        released = true;
        inUse -= 1;
        drain();
      },
    });
  };

  const drain = (): void => {
    while (inUse < capacity && waiting.length > 0) {
      const waiter = waiting.shift();
      if (waiter === undefined) return;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal.aborted) waiter.reject(abortReason(waiter.signal));
      else waiter.resolve(grant());
    }
  };

  return Object.freeze({
    capacity,
    acquire: (signal: AbortSignal): Promise<RecordBudgetLease> => {
      if (signal.aborted) return Promise.reject(abortReason(signal));
      if (inUse < capacity) return Promise.resolve(grant());
      return new Promise<RecordBudgetLease>((resolve, reject) => {
        const waiter: Waiter = {
          signal,
          resolve,
          reject,
          onAbort: () => {
            const index = waiting.indexOf(waiter);
            if (index >= 0) waiting.splice(index, 1);
            reject(abortReason(signal));
          },
        };
        waiting.push(waiter);
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      });
    },
    tryAcquire: () => (inUse < capacity ? grant() : undefined),
    metrics: () =>
      Object.freeze({ capacity, inUse, highWaterRecords, waiting: waiting.length, totalAcquired }),
  });
}
