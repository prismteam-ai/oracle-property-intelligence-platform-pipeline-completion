import { describe, expect, it, vi } from 'vitest';

import { runCheck } from './check.js';
import { main } from './cli.js';

describe('pipeline foundation check', () => {
  it('is deterministic, offline, and honest', () => {
    expect(runCheck()).toEqual({
      command: 'pipeline.check',
      networkAccess: false,
      status: 'ok',
      pipelineState: 'not_implemented',
    });
  });

  it('accepts only --check', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(main(['--run'])).toBe(2);
    expect(write).toHaveBeenCalledOnce();
    write.mockRestore();
  });
});
