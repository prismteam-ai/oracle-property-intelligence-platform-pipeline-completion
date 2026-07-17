import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readPipelineSourceConfig, sourceConfigFingerprint } from './source-config.js';

async function configFile(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'oracle-source-config-'));
  const path = join(directory, 'sources.json');
  await writeFile(path, JSON.stringify(value), 'utf8');
  return path;
}

describe('pipeline source configuration', () => {
  it('has deterministic secret-free defaults', async () => {
    const first = await readPipelineSourceConfig(undefined);
    const second = await readPipelineSourceConfig(undefined);
    expect(second).toEqual(first);
    expect(sourceConfigFingerprint(second)).toBe(sourceConfigFingerprint(first));
    expect(first.fallback511).toBeNull();
    expect(first.caSos).toBeNull();
    expect(first.osm).toBeNull();
    expect(first.runtime.requestTimeoutMs).toBe(30_000);
  });

  it('rejects literal credentials and credential-bearing URLs', async () => {
    await expect(
      readPipelineSourceConfig(
        await configFile({ schemaVersion: 1, fallback511: { apiKey: 'do-not-store' } }),
      ),
    ).rejects.toThrow('may not contain credential material');
    await expect(
      readPipelineSourceConfig(
        await configFile({
          schemaVersion: 1,
          caSos: {
            bulkArtifactUrl: 'https://example.test/bulk.zip?' + 'token=do-not-store',
            sourceAsOf: '2026-07-17T00:00:00.000Z',
            expectedSha256: 'a'.repeat(64),
            expectedRecordCount: 1,
            sourceVersion: 'test',
            encoding: 'zip',
            sourceLock: {},
          },
        }),
      ),
    ).rejects.toThrow('credential-bearing URL');
    await expect(
      readPipelineSourceConfig(
        await configFile({
          schemaVersion: 1,
          sanJosePermits: { authorization: 'Bearer ' + 'do-not-store' },
        }),
      ),
    ).rejects.toThrow('may not contain credential material');
    await expect(
      readPipelineSourceConfig(
        await configFile({
          schemaVersion: 1,
          sanJosePermits: { sourceLabel: 'Bearer ' + 'do-not-store' },
        }),
      ),
    ).rejects.toThrow('literal authorization credential');
    await expect(
      readPipelineSourceConfig(
        await configFile({ schemaVersion: 1, sanJosePermits: { headers: {} } }),
      ),
    ).rejects.toThrow('may not contain credential material');
  });

  it('allows only the validated fallback authorization environment-variable rule', async () => {
    const config = await readPipelineSourceConfig(
      await configFile({
        schemaVersion: 1,
        fallback511: {
          feeds: { vta: { url: 'https://api.511.org/transit/datafeeds' } },
          authorization: [
            {
              urlPrefix: 'https://api.511.org/transit/datafeeds',
              headerName: 'Authorization',
              environmentVariable: 'ORACLE_511_AUTH',
            },
          ],
        },
      }),
    );
    expect(config.fallback511?.authorization).toEqual([
      {
        urlPrefix: 'https://api.511.org/transit/datafeeds',
        headerName: 'Authorization',
        environmentVariable: 'ORACLE_511_AUTH',
      },
    ]);
  });

  it.each([
    ['https://', 'Authorization'],
    ['https://unrelated.example.test/feed', 'Authorization'],
    ['https://api.511.org/', 'Authorization'],
    ['https://api.511.org/transit/datafeeds', 'Cookie'],
  ])(
    'rejects broad, cross-origin, root, or unsafe authorization scope %s',
    async (urlPrefix, headerName) => {
      await expect(
        readPipelineSourceConfig(
          await configFile({
            schemaVersion: 1,
            fallback511: {
              feeds: { vta: { url: 'https://api.511.org/transit/datafeeds' } },
              authorization: [
                {
                  urlPrefix,
                  headerName,
                  environmentVariable: 'ORACLE_511_AUTH',
                },
              ],
            },
          }),
        ),
      ).rejects.toThrow(/invalid URL|urlPrefix is invalid|must be a non-root HTTPS scope/u);
    },
  );
});
