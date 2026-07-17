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

  it('rejects unsupported commands', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(main(['--run'])).resolves.toBe(2);
    expect(write).toHaveBeenCalledOnce();
    write.mockRestore();
  });
});
