// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it } from 'vitest';
import { useLayoutEffect } from 'react';
import { MemoryRouter } from 'react-router-dom';

import { App } from './app.js';
import {
  createTestOnlyFixtureClient,
  TEST_ONLY_FIXTURE_LABEL,
  TEST_ONLY_RELEASE_ID,
} from './test-fixtures.js';
import type { ApiClient, ApiEnvelope, ApplicationOperation } from './types.js';

afterEach(() => cleanup());

function renderRoute(route: string, client: ApiClient = createTestOnlyFixtureClient()) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <App client={client} testFixtureLabel={TEST_ONLY_FIXTURE_LABEL} />
    </MemoryRouter>,
  );
}

describe('Oracle evaluator routes', () => {
  it('renders the release-bound overview without automated accessibility violations', async () => {
    const result = renderRoute('/');
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Property intelligence with evidence in the foreground.',
      }),
    ).toBeTruthy();
    expect(screen.getByTestId('release-id').textContent).toContain('release-test-only');
    expect(screen.getByText(/Test-only deterministic data/u).textContent).toContain(
      TEST_ONLY_FIXTURE_LABEL,
    );
    expect((await axe(result.container)).violations).toHaveLength(0);
  });

  it.each(['/pipeline', '/about/architecture', '/properties/TEST-PROP-001'])(
    'exposes the exact immutable release identity once on direct entry to %s',
    async (route) => {
      renderRoute(route);
      const releaseMarkers = await screen.findAllByTestId('release-id');
      expect(releaseMarkers).toHaveLength(1);
      expect(releaseMarkers[0]?.textContent).toBe(TEST_ONLY_RELEASE_ID);
      expect(releaseMarkers[0]?.closest('main')).toBeNull();
      expect(
        screen.getByRole('status', {
          name: `Immutable dataset release identity: ${TEST_ONLY_RELEASE_ID}`,
        }),
      ).toBeTruthy();
    },
  );

  it('does not expose a release identity while deep-link release metadata is loading', async () => {
    const fixtureClient = createTestOnlyFixtureClient();
    let resolveRelease: ((release: ApiEnvelope) => void) | undefined;
    const pendingRelease = new Promise<ApiEnvelope>((resolve) => {
      resolveRelease = resolve;
    });
    const delayedClient: ApiClient = {
      execute(operation: ApplicationOperation, input, signal) {
        return operation === 'dataset.getInfo'
          ? pendingRelease
          : fixtureClient.execute(operation, input, signal);
      },
    };

    renderRoute('/about/architecture', delayedClient);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Immutable data, replaceable compute' }),
    ).toBeTruthy();
    expect(screen.queryByTestId('release-id')).toBeNull();

    const fixtureRelease = await fixtureClient.execute('dataset.getInfo', {});
    resolveRelease?.(fixtureRelease);
    expect((await screen.findByTestId('release-id')).textContent).toBe(TEST_ONLY_RELEASE_ID);
  });

  it('clears a prior release identity while replacement metadata loads and fails', async () => {
    const fixtureClient = createTestOnlyFixtureClient();
    let rejectRelease: ((error: Error) => void) | undefined;
    const unavailableRelease = new Promise<ApiEnvelope>((_resolve, reject) => {
      rejectRelease = reject;
    });
    const unavailableClient: ApiClient = {
      execute(operation: ApplicationOperation, input, signal) {
        return operation === 'dataset.getInfo'
          ? unavailableRelease
          : fixtureClient.execute(operation, input, signal);
      },
    };
    const result = renderRoute('/about/architecture', fixtureClient);
    expect((await screen.findByTestId('release-id')).textContent).toBe(TEST_ONLY_RELEASE_ID);

    result.rerender(
      <MemoryRouter initialEntries={['/about/architecture']}>
        <App client={unavailableClient} testFixtureLabel={TEST_ONLY_FIXTURE_LABEL} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.queryByTestId('release-id')).toBeNull());

    rejectRelease?.(new Error('Replacement release metadata is unavailable.'));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('Replacement release metadata is unavailable.'),
    );
    expect(screen.queryByTestId('release-id')).toBeNull();
  });

  it('does not commit a prior release identity for a replacement client', async () => {
    const fixtureClient = createTestOnlyFixtureClient();
    const pendingClient: ApiClient = {
      execute(operation: ApplicationOperation, input, signal) {
        return operation === 'dataset.getInfo'
          ? new Promise<ApiEnvelope>(() => undefined)
          : fixtureClient.execute(operation, input, signal);
      },
    };
    const committedReleaseIds: (string | null)[] = [];
    function CommitProbe({ client }: Readonly<{ client: ApiClient }>) {
      useLayoutEffect(() => {
        committedReleaseIds.push(
          document.querySelector<HTMLElement>('[data-testid="release-id"]')?.textContent ?? null,
        );
      }, [client]);
      return <App client={client} testFixtureLabel={TEST_ONLY_FIXTURE_LABEL} />;
    }
    const result = render(
      <MemoryRouter initialEntries={['/about/architecture']}>
        <CommitProbe client={fixtureClient} />
      </MemoryRouter>,
    );
    expect((await screen.findByTestId('release-id')).textContent).toBe(TEST_ONLY_RELEASE_ID);

    result.rerender(
      <MemoryRouter initialEntries={['/about/architecture']}>
        <CommitProbe client={pendingClient} />
      </MemoryRouter>,
    );
    expect(committedReleaseIds.at(-1)).toBeNull();
    expect(screen.queryByTestId('release-id')).toBeNull();
  });

  it('ignores late fulfillment from a superseded release request', async () => {
    const fixtureClient = createTestOnlyFixtureClient();
    let resolveOldRelease: ((release: ApiEnvelope) => void) | undefined;
    let rejectCurrentRelease: ((error: Error) => void) | undefined;
    const oldRelease = new Promise<ApiEnvelope>((resolve) => {
      resolveOldRelease = resolve;
    });
    const currentRelease = new Promise<ApiEnvelope>((_resolve, reject) => {
      rejectCurrentRelease = reject;
    });
    const oldClient: ApiClient = {
      execute(operation: ApplicationOperation, input, signal) {
        return operation === 'dataset.getInfo'
          ? oldRelease
          : fixtureClient.execute(operation, input, signal);
      },
    };
    const currentClient: ApiClient = {
      execute(operation: ApplicationOperation, input, signal) {
        return operation === 'dataset.getInfo'
          ? currentRelease
          : fixtureClient.execute(operation, input, signal);
      },
    };
    const result = renderRoute('/about/architecture', oldClient);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Immutable data, replaceable compute' }),
    ).toBeTruthy();

    result.rerender(
      <MemoryRouter initialEntries={['/about/architecture']}>
        <App client={currentClient} testFixtureLabel={TEST_ONLY_FIXTURE_LABEL} />
      </MemoryRouter>,
    );
    const fixtureRelease = await fixtureClient.execute('dataset.getInfo', {});
    await act(async () => {
      resolveOldRelease?.(fixtureRelease);
      await Promise.resolve();
    });
    expect(screen.queryByTestId('release-id')).toBeNull();

    await act(async () => {
      rejectCurrentRelease?.(new Error('Current release is unavailable.'));
      await Promise.resolve();
    });
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('Current release is unavailable.'),
    );
    expect(screen.queryByTestId('release-id')).toBeNull();
  });

  it('ignores late rejection from a superseded release request', async () => {
    const fixtureClient = createTestOnlyFixtureClient();
    let rejectOldRelease: ((error: Error) => void) | undefined;
    const oldRelease = new Promise<ApiEnvelope>((_resolve, reject) => {
      rejectOldRelease = reject;
    });
    const oldClient: ApiClient = {
      execute(operation: ApplicationOperation, input, signal) {
        return operation === 'dataset.getInfo'
          ? oldRelease
          : fixtureClient.execute(operation, input, signal);
      },
    };
    const result = renderRoute('/about/architecture', oldClient);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Immutable data, replaceable compute' }),
    ).toBeTruthy();

    result.rerender(
      <MemoryRouter initialEntries={['/about/architecture']}>
        <App client={fixtureClient} testFixtureLabel={TEST_ONLY_FIXTURE_LABEL} />
      </MemoryRouter>,
    );
    expect((await screen.findByTestId('release-id')).textContent).toBe(TEST_ONLY_RELEASE_ID);

    await act(async () => {
      rejectOldRelease?.(new Error('Superseded release failed late.'));
      await Promise.resolve();
    });
    expect(screen.getByTestId('release-id').textContent).toBe(TEST_ONLY_RELEASE_ID);
    expect(screen.queryByText('Superseded release failed late.')).toBeNull();
  });

  it('starts a newly owned release request when an evaluator retries', async () => {
    const user = userEvent.setup();
    const fixtureClient = createTestOnlyFixtureClient();
    let releaseAttempts = 0;
    const retryClient: ApiClient = {
      execute(operation: ApplicationOperation, input, signal) {
        if (operation !== 'dataset.getInfo') return fixtureClient.execute(operation, input, signal);
        releaseAttempts += 1;
        return releaseAttempts === 1
          ? Promise.reject(new Error('Release metadata failed once.'))
          : fixtureClient.execute(operation, input, signal);
      },
    };
    renderRoute('/about/architecture', retryClient);
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('Release metadata failed once.'),
    );
    expect(screen.queryByTestId('release-id')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect((await screen.findByTestId('release-id')).textContent).toBe(TEST_ONLY_RELEASE_ID);
    expect(releaseAttempts).toBe(2);
  });

  it('exposes property search, links, spatial equivalent, and URL-backed inquiry controls', async () => {
    const user = userEvent.setup();
    renderRoute('/properties?q=Test');
    expect(await screen.findByRole('searchbox', { name: 'Search properties' })).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'TEST-PROP-001' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Spatial evidence' }));
    expect(screen.getByRole('list', { name: 'Map-equivalent result list' })).toBeTruthy();

    cleanup();
    renderRoute('/inquiries/roof-age?minimumAgeYears=20&includeProxy=true');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Roofs older than 15 years' }),
    ).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: 'Minimum roof age (years)' })).toHaveProperty(
      'value',
      '20',
    );
    expect(
      screen.getByRole('checkbox', { name: 'Include clearly labeled proxy candidates' }),
    ).toHaveProperty('checked', true);
  });

  it('shows a model-unavailable state and then a cited tool trace', async () => {
    const user = userEvent.setup();
    renderRoute('/agent');
    expect((await screen.findByRole('alert')).textContent).toContain('Agent unavailable');
    const prompt = screen.getByRole('textbox', { name: 'Property intelligence question' });
    await user.type(prompt, 'Which properties have old roofs?');
    await user.click(screen.getByRole('button', { name: 'Ask agent' }));
    expect(await screen.findByRole('heading', { name: 'Tool trace' })).toBeTruthy();
    expect(screen.getAllByText(/TEST-EVIDENCE-001/u).length).toBeGreaterThanOrEqual(1);
  });

  it('renders a conspicuous fail-closed production composition error', async () => {
    const unavailableClient: ApiClient = {
      execute() {
        return Promise.reject(
          new Error('The verified release adapter is not composed in production.'),
        );
      },
    };
    renderRoute('/', unavailableClient);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Verified data is unavailable');
    expect(alert.textContent).toContain('never substituted');
    expect(screen.queryByTestId('release-id')).toBeNull();
    await waitFor(() => expect(screen.queryByText('TEST-PROP-001')).toBeNull());
  });
});
