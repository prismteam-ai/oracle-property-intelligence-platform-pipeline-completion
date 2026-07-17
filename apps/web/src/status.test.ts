import { describe, expect, it } from 'vitest';

import { statusCards } from './status.js';

describe('status content', () => {
  it('labels every future product vertical as not implemented', () => {
    expect(statusCards).toHaveLength(3);
    expect(statusCards.map((card) => card.state)).toEqual([
      'not_implemented',
      'not_implemented',
      'not_implemented',
    ]);
    expect(statusCards.map((card) => card.title)).toEqual([
      'Property pipeline',
      'Query experience',
      'Full MCP work',
    ]);
  });
});
