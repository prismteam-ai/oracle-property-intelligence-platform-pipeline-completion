import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  collectResponseHeaders,
  FetchTransport,
  isWithinAuthorizationScope,
  RedirectRejectedError,
  runCommand,
} from './run.js';

const temporaryDirectories: string[] = [];
const WORKSPACE_DIRECTORY = fileURLToPath(new URL('../../../../', import.meta.url));

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `oracle-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  // Test-created paths are kept until process cleanup so failed runs remain inspectable.
  temporaryDirectories.length = 0;
});

describe('executable pipeline commands', () => {
  it('rejects a requested instant later than the runtime clock', async () => {
    await expect(
      runCommand({
        profile: 'pilot',
        fixture: true,
        requestedAt: '2026-07-17T13:00:00.001Z',
        workspaceDirectory: WORKSPACE_DIRECTORY,
        outputDirectory: await temporaryDirectory('future-request'),
      }),
    ).rejects.toThrow('requestedAt cannot be later than the current runtime clock');
  });

  it('preserves duplicate response cookies for stateful portal adapters', () => {
    const headers = new Headers({ 'x-source': 'test' });
    headers.append('set-cookie', 'session=one; Path=/');
    headers.append('set-cookie', 'route=two; Path=/');
    expect(collectResponseHeaders(headers)).toEqual({
      'set-cookie': 'session=one; Path=/,route=two; Path=/',
      'x-source': 'test',
    });
  });

  it('matches authorization only within the configured feed origin and path boundary', () => {
    const scope = 'https://api.511.org/transit/datafeeds';
    expect(isWithinAuthorizationScope(scope, scope)).toBe(true);
    expect(isWithinAuthorizationScope(`${scope}/vta`, scope)).toBe(true);
    expect(isWithinAuthorizationScope('https://api.511.org/transit/datafeeds-evil', scope)).toBe(
      false,
    );
    expect(
      isWithinAuthorizationScope('https://unrelated.example.test/transit/datafeeds', scope),
    ).toBe(false);
  });

  it('uses manual redirects, rejects 3xx, and reports the transport final URL', async () => {
    const originalFetch = globalThis.fetch;
    const calls: RequestInit[] = [];
    try {
      globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
        calls.push(init ?? {});
        return Promise.resolve({
          status: 302,
          headers: new Headers({ location: '/moved' }),
          body: null,
          url: 'https://source.example.test/original',
        });
      }) as typeof fetch;
      const transport = new FetchTransport([], 1_000);
      await expect(
        transport.send(
          { method: 'GET', url: 'https://source.example.test/original', headers: {} },
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(RedirectRejectedError);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.redirect).toBe('manual');

      globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
        calls.push(init ?? {});
        return Promise.resolve({
          status: 200,
          headers: new Headers(),
          body: null,
          url: 'https://source.example.test/canonical',
        });
      }) as typeof fetch;
      const response = await transport.send(
        { method: 'GET', url: 'https://source.example.test/original', headers: {} },
        new AbortController().signal,
      );
      expect(response.finalUrl).toBe('https://source.example.test/canonical');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('runs every real parcel-adapter phase and the real reducer, reconciliation, feature, and mart processors', async () => {
    const result = await runCommand({
      profile: 'pilot',
      fixture: true,
      workspaceDirectory: WORKSPACE_DIRECTORY,
      outputDirectory: await temporaryDirectory('phases'),
    });

    expect(result.manifest.status).toBe('succeeded');
    expect(result.manifest.sources).toHaveLength(1);
    const source = result.manifest.sources[0];
    expect(source?.terminalState).toBe('complete');
    expect(source?.coverage).toMatchObject({
      expectedRecords: 2,
      observedRecords: 2,
      acceptedRecords: 2,
      quarantinedRecords: 0,
      ratio: 1,
    });
    expect(source?.timings.map(({ phase }) => phase)).toEqual([
      'discover',
      'plan',
      'acquire',
      'decode',
      'validate',
      'normalize',
      'summarize',
    ]);
    expect(result.manifest.artifacts.map(({ phase }) => phase)).toEqual([
      'reconcile',
      'derive_features',
      'build_marts',
    ]);
    expect(source?.summary?.normalizedMutations).toBeGreaterThan(0);
    expect(source?.sourceHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(source?.schemaHashes).toHaveLength(1);
    expect(source?.snapshotIdentity.observedContentId).toMatch(
      /^sc:snapshot:santa-clara-socrata-parcels:[a-f0-9]{64}$/u,
    );
    expect(result.manifest.countyCompletion).toMatchObject({
      state: 'not_applicable',
      claim: 'pilot is not a county-completion profile.',
    });
  });

  it('runs discovery without acquiring or claiming loaded records', async () => {
    const result = await runCommand({
      profile: 'discovery',
      fixture: true,
      workspaceDirectory: WORKSPACE_DIRECTORY,
      outputDirectory: await temporaryDirectory('discovery'),
    });
    expect(result.manifest.status).toBe('succeeded');
    expect(result.manifest.sources[0]?.coverage.observedRecords).toBe(0);
    expect(result.manifest.sources[0]?.artifacts.map(({ phase }) => phase)).toEqual(['discover']);
    expect(result.manifest.artifacts).toEqual([]);
    expect(result.manifest.countyCompletion.state).toBe('not_applicable');
  });

  it('checkpoints an interruption and resumes without replaying durable phases', async () => {
    const outputDirectory = await temporaryDirectory('resume');
    const controller = new AbortController();
    const visited: string[] = [];
    await expect(
      runCommand({
        profile: 'pilot',
        fixture: true,
        workspaceDirectory: WORKSPACE_DIRECTORY,
        outputDirectory,
        signal: controller.signal,
        beforePhase: (phase) => {
          visited.push(phase);
          if (phase === 'decode')
            controller.abort(new DOMException('test interruption', 'AbortError'));
        },
      }),
    ).rejects.toThrow('test interruption');
    expect(visited).toContain('acquire');

    const resumedPhases: string[] = [];
    const resumed = await runCommand({
      profile: 'pilot',
      fixture: true,
      workspaceDirectory: WORKSPACE_DIRECTORY,
      outputDirectory,
      beforePhase: (phase) => {
        resumedPhases.push(phase);
      },
    });
    expect(resumed.manifest.status).toBe('succeeded');
    expect(resumedPhases).not.toContain('discover');
    expect(resumedPhases).not.toContain('plan');
    expect(resumedPhases).not.toContain('acquire');
    expect(resumedPhases).toContain('decode');
  });

  it('returns the immutable completed run on duplicate replay', async () => {
    const outputDirectory = await temporaryDirectory('replay');
    const first = await runCommand({
      profile: 'pilot',
      fixture: true,
      workspaceDirectory: WORKSPACE_DIRECTORY,
      outputDirectory,
    });
    const phases: string[] = [];
    const replay = await runCommand({
      profile: 'pilot',
      fixture: true,
      workspaceDirectory: WORKSPACE_DIRECTORY,
      outputDirectory,
      beforePhase: (phase) => {
        phases.push(phase);
      },
    });
    expect(replay.manifestArtifact.sha256).toBe(first.manifestArtifact.sha256);
    expect(replay.manifest).toEqual(first.manifest);
    expect(phases).toEqual([]);
  });

  it('produces byte-identical manifests in independent clean output directories', async () => {
    const first = await runCommand({
      profile: 'pilot',
      fixture: true,
      workspaceDirectory: WORKSPACE_DIRECTORY,
      outputDirectory: await temporaryDirectory('determinism-a'),
    });
    const second = await runCommand({
      profile: 'pilot',
      fixture: true,
      workspaceDirectory: WORKSPACE_DIRECTORY,
      outputDirectory: await temporaryDirectory('determinism-b'),
    });
    expect(second.manifestArtifact.sha256).toBe(first.manifestArtifact.sha256);
    expect(second.manifest).toEqual(first.manifest);
    expect(first.manifest.backpressure).toEqual({
      maxConcurrentSources: 2,
      maxBufferedRecords: 50,
      observedHighWaterRecords: 50,
      observedHighWaterActiveRecords: 1,
      observedHighWaterBufferedEvents: 49,
      observedHighWaterCombinedRecordsAndEvents: 50,
      activeRecordsAtCompletion: 0,
      bufferedEventsAtCompletion: 0,
      // Includes permits used to materialize the truthful mutation/validation physical projections,
      // not only the canonical normalization-event stream.
      totalBudgetAcquisitions: 116,
    });
  });

  it('binds the networkless run to the committed real official excerpt bytes', async () => {
    const bytes = await readFile(
      resolve(
        WORKSPACE_DIRECTORY,
        'packages/testkit/src/sources/santa-clara-socrata-parcels/duplicate-apn.geojson',
      ),
    );
    const fixtureHash = createHash('sha256').update(bytes).digest('hex');
    const result = await runCommand({
      profile: 'pilot',
      fixture: true,
      workspaceDirectory: WORKSPACE_DIRECTORY,
      outputDirectory: await temporaryDirectory('fixture-hash'),
    });
    expect(result.manifest.sources[0]?.snapshotId).toBe(
      `sc:snapshot:santa-clara-socrata-parcels:${fixtureHash}`,
    );
  });
});
