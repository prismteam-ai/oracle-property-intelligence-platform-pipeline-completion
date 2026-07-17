// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { App } from './app.js';
import { createTestOnlyFixtureClient, TEST_ONLY_FIXTURE_LABEL } from './test-fixtures.js';
import type { ApiClient } from './types.js';

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
    expect(screen.getByRole('status').textContent).toContain(TEST_ONLY_FIXTURE_LABEL);
    expect((await axe(result.container)).violations).toHaveLength(0);
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
    await waitFor(() => expect(screen.queryByText('TEST-PROP-001')).toBeNull());
  });
});
