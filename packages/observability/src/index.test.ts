import { describe, expect, it } from 'vitest';

import { createObservability } from './index.js';

describe('observability factory', () => {
  it('provides logger, tracer, and metrics as one reusable boundary', () => {
    const observability = createObservability('foundation-test');
    expect(observability.logger).toBeDefined();
    expect(observability.tracer).toBeDefined();
    expect(observability.metrics).toBeDefined();
    expect(Object.isFrozen(observability)).toBe(true);
  });
});
