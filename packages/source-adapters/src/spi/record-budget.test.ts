import { describe, expect, it } from 'vitest';

import { createSharedRecordBudget } from './record-budget.js';

describe('shared record budget', () => {
  it('enforces a process-wide boundary of one across concurrent sources', async () => {
    const budget = createSharedRecordBudget(1);
    const controller = new AbortController();
    const first = await budget.acquire(controller.signal);
    let secondEntered = false;
    const second = budget.acquire(controller.signal).then((lease) => {
      secondEntered = true;
      return lease;
    });
    await Promise.resolve();
    expect(secondEntered).toBe(false);
    expect(budget.metrics()).toMatchObject({ inUse: 1, highWaterRecords: 1, waiting: 1 });
    first.release();
    (await second).release();
    expect(budget.metrics()).toMatchObject({ inUse: 0, highWaterRecords: 1, totalAcquired: 2 });
  });

  it('removes aborted waiters without leaking capacity', async () => {
    const budget = createSharedRecordBudget(1);
    const activeController = new AbortController();
    const active = await budget.acquire(activeController.signal);
    const waitingController = new AbortController();
    const waiting = budget.acquire(waitingController.signal);
    waitingController.abort(new Error('stop'));
    await expect(waiting).rejects.toThrow('stop');
    active.release();
    expect(budget.metrics()).toMatchObject({ inUse: 0, waiting: 0, highWaterRecords: 1 });
  });

  it('supports non-blocking spill pressure without exceeding the shared capacity', () => {
    const budget = createSharedRecordBudget(1);
    const first = budget.tryAcquire();
    expect(first).toBeDefined();
    expect(budget.tryAcquire()).toBeUndefined();
    expect(budget.metrics()).toMatchObject({ inUse: 1, highWaterRecords: 1 });
    first?.release();
    expect(budget.tryAcquire()).toBeDefined();
  });
});
