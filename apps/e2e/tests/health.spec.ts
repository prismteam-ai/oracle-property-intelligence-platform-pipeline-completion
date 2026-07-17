import { expect, test } from '@playwright/test';

import { evaluatorTargetConfiguration } from '../support/target.js';

const target = evaluatorTargetConfiguration();

test('API health is cheap, explicit, and release-query free', async ({ request }) => {
  const response = await request.get(`${target.apiBaseURL}/health`);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/json');
  const health = (await response.json()) as Readonly<Record<string, unknown>>;
  expect(health.service).toBe('api');
  expect(health.dataQueryPerformed).toBe(false);
  expect(health.productionReleaseRequired).toBe(true);
  if (target.target === 'hosted') {
    expect(health.status).toBe('ready');
    expect(health.readiness).toBe('ready');
    expect(health.fixture).toBeNull();
  } else {
    expect(health.readiness).toBe('test_fixture');
    expect(response.headers()['x-oracle-fixture']).toBe('TEST_ONLY_DETERMINISTIC_FIXTURE');
  }
});
