import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProductionApiClient } from './api.js';

afterEach(() => vi.unstubAllGlobals());

describe('production API client', () => {
  it('rejects deterministic test fixture labels in a successful production response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              schemaVersion: '1.0.0',
              releaseId: 'release-1',
              runId: 'run-1',
              manifestCid: 'bafy-manifest',
              asOf: '2026-07-17T00:00:00.000Z',
              coverage: {},
              limitations: [],
              data: { fixtureLabel: 'TEST_ONLY_DETERMINISTIC_FIXTURE' },
              nextCursor: null,
              truncated: false,
              timing: { elapsedMs: 1, bytesScanned: 0 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      ),
    );

    const client = createProductionApiClient('https://oracle.example');
    await expect(client.execute('dataset.getInfo', {})).rejects.toMatchObject({
      code: 'FIXTURE_REJECTED',
    });
  });

  it('preserves the stable fail-closed API error contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: 'SERVICE_UNAVAILABLE',
                message: 'The verified release adapter is not composed.',
                retryable: true,
              },
            }),
            { status: 503, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      ),
    );

    const client = createProductionApiClient('https://oracle.example');
    await expect(client.execute('dataset.getInfo', {})).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      retryable: true,
    });
  });
});
