import { describe, expect, it } from 'vitest';

import {
  FOUNDATION_STATUS,
  foundationStatusSchema,
  healthResponseSchema,
  mcpFoundationErrorSchema,
} from './index.js';

describe('foundation contracts', () => {
  it('keeps the status response honest and parseable', () => {
    expect(foundationStatusSchema.parse(FOUNDATION_STATUS)).toEqual(FOUNDATION_STATUS);
    expect(new Set(Object.values(FOUNDATION_STATUS.capabilities))).toEqual(
      new Set(['not_implemented']),
    );
  });

  it('rejects health and MCP responses that overclaim readiness', () => {
    expect(() =>
      healthResponseSchema.parse({ service: 'api', status: 'ok', foundationOnly: false }),
    ).toThrow();
    expect(() =>
      mcpFoundationErrorSchema.parse({ error: { code: 'MCP_READY', message: 'ready' } }),
    ).toThrow();
  });
});
