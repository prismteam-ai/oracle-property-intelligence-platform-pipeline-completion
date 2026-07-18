import { createHash } from 'node:crypto';

import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';

import { evaluatorTargetConfiguration } from '../support/target.js';

const target = evaluatorTargetConfiguration();
const protocolVersion = '2025-11-25';
const mcpHeaders = Object.freeze({
  accept: 'application/json, text/event-stream',
  'content-type': 'application/json',
  'mcp-protocol-version': protocolVersion,
});
const expectedTools = Object.freeze([
  'get_dataset_info',
  'get_dataset_coverage',
  'list_pipeline_runs',
  'get_pipeline_run',
  'search_properties',
  'get_property',
  'get_property_evidence',
  'find_roof_age_candidates',
  'find_water_view_candidates',
  'find_ownership_age_candidates',
  'find_regional_owner_properties',
  'find_transit_walkable_properties',
  'find_starbucks_walkable_properties',
  'rank_review_candidates',
  'list_artifacts',
  'get_data_dictionary',
]);

type JsonRecord = Readonly<Record<string, unknown>>;

test.skip(target.target !== 'hosted', 'The release proof requires parent-supplied hosted outputs.');

function asRecord(value: unknown, label: string): JsonRecord {
  expect(value, `${label} must be an object.`).not.toBeNull();
  expect(Array.isArray(value), `${label} must not be an array.`).toBe(false);
  expect(typeof value, `${label} must be an object.`).toBe('object');
  return value as JsonRecord;
}

function requiredString(value: JsonRecord, key: string): string {
  const result = value[key];
  expect(typeof result, `${key} must be a string.`).toBe('string');
  expect(String(result).length, `${key} must not be empty.`).toBeGreaterThan(0);
  return String(result);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

async function apiOperation(
  request: APIRequestContext,
  operation: string,
  input: JsonRecord,
): Promise<Readonly<{ response: APIResponse; body: JsonRecord }>> {
  const response = await request.post(`${target.apiBaseURL}/${operation}`, { data: input });
  const body = asRecord((await response.json()) as unknown, `${operation} response`);
  return { response, body };
}

async function mcpRequest(
  request: APIRequestContext,
  id: number,
  method: string,
  params: JsonRecord,
): Promise<JsonRecord> {
  const response = await request.post(target.mcpURL, {
    headers: mcpHeaders,
    data: { jsonrpc: '2.0', id, method, params },
  });
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/json');
  return asRecord((await response.json()) as unknown, `${method} response`);
}

function toolEnvelope(response: JsonRecord): JsonRecord {
  const result = asRecord(response.result, 'tools/call result');
  expect(result.isError).not.toBe(true);
  expect(Array.isArray(result.content)).toBe(true);
  const first = asRecord((result.content as readonly unknown[])[0], 'tools/call content');
  const text = requiredString(first, 'text');
  return asRecord(JSON.parse(text) as unknown, 'tools/call envelope');
}

test('hosted API and MCP share one immutable release and reject schema authority', async ({
  request,
}) => {
  const apiInfo = await apiOperation(request, 'dataset.getInfo', {});
  expect(apiInfo.response.status()).toBe(200);
  const apiReleaseId = requiredString(apiInfo.body, 'releaseId');

  const initialize = await mcpRequest(request, 1, 'initialize', {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'oracle-hosted-release-proof', version: '1.0.0' },
  });
  expect(asRecord(initialize.result, 'initialize result').protocolVersion).toBe(protocolVersion);

  const listed = await mcpRequest(request, 2, 'tools/list', {});
  const tools = asRecord(listed.result, 'tools/list result').tools;
  expect(Array.isArray(tools)).toBe(true);
  const names = (tools as readonly unknown[])
    .map((tool) => requiredString(asRecord(tool, 'listed tool'), 'name'))
    .sort();
  expect(names).toEqual([...expectedTools].sort());
  for (const tool of tools as readonly unknown[]) {
    const schema = asRecord(asRecord(tool, 'listed tool').inputSchema, 'tool input schema');
    expect(schema.additionalProperties).toBe(false);
  }

  const called = await mcpRequest(request, 3, 'tools/call', {
    name: 'get_dataset_info',
    arguments: {},
  });
  const mcpEnvelope = toolEnvelope(called);
  expect(requiredString(mcpEnvelope, 'releaseId')).toBe(apiReleaseId);
  for (const field of ['schemaVersion', 'runId', 'manifestCid', 'asOf']) {
    expect(mcpEnvelope[field]).toBe(apiInfo.body[field]);
  }
  for (const field of ['coverage', 'limitations', 'data', 'nextCursor', 'truncated']) {
    expect(mcpEnvelope[field]).toEqual(apiInfo.body[field]);
  }

  const rejectedMcp = await mcpRequest(request, 4, 'tools/call', {
    name: 'get_dataset_info',
    arguments: { sql: 'SELECT 1' },
  });
  const rejectedMcpResult = asRecord(rejectedMcp.result, 'rejected tools/call result');
  expect(rejectedMcpResult.isError).toBe(true);
  expect(JSON.stringify(rejectedMcpResult)).toMatch(/invalid|additional|unrecognized|request/i);

  const rejectedApi = await apiOperation(request, 'dataset.getInfo', { sql: 'SELECT 1' });
  expect(rejectedApi.response.status()).toBe(400);
  expect(asRecord(rejectedApi.body.error, 'API error').code).toBe('INVALID_REQUEST');
});

test('hosted MCP health is ready, query-free, and release composed', async ({ request }) => {
  const response = await request.get(`${target.apiBaseURL}/mcp/health`);
  expect(response.status()).toBe(200);
  const health = asRecord((await response.json()) as unknown, 'MCP health');
  expect(health.service).toBe('oracle-named-evidence-mcp');
  expect(health.status).toBe('ready');
  expect(health.readiness).toBe('ready');
  expect(health.dataQueriesExecuted).toBe(0);
  expect(health.fixture).toBeNull();
});

test('public immutable artifacts pass HEAD, range, size, and SHA-256 proof', async ({
  request,
}) => {
  const manifestUrl = `${target.publicArtifactBaseURL}/release-manifest.json`;
  const manifestHead = await request.head(manifestUrl);
  expect(manifestHead.status()).toBe(200);
  const manifestResponse = await request.get(manifestUrl);
  expect(manifestResponse.status()).toBe(200);
  const manifestBytes = await manifestResponse.body();
  const manifest = asRecord(JSON.parse(manifestBytes.toString('utf8')) as unknown, 'manifest');
  const embeddedManifestHash = requiredString(manifest, 'manifestSha256');
  const manifestPayload = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== 'manifestSha256'),
  );
  const calculatedManifestHash = createHash('sha256')
    .update(`${stableJson(manifestPayload)}\n`)
    .digest('hex');
  expect(calculatedManifestHash).toBe(embeddedManifestHash);

  const apiInfo = await apiOperation(request, 'dataset.getInfo', {});
  expect(apiInfo.response.status()).toBe(200);
  expect(requiredString(manifest, 'releaseId')).toBe(requiredString(apiInfo.body, 'releaseId'));
  const release = asRecord(asRecord(apiInfo.body.data, 'dataset data').release, 'dataset release');
  expect(release.manifestSha256).toBe(embeddedManifestHash);

  expect(Array.isArray(manifest.artifacts)).toBe(true);
  const publicArtifacts = (manifest.artifacts as readonly unknown[])
    .map((item) => asRecord(item, 'manifest artifact'))
    .filter((item) => item.visibility === 'public')
    .sort((left, right) => Number(left.byteSize) - Number(right.byteSize));
  expect(publicArtifacts.length).toBeGreaterThan(0);
  const artifact = publicArtifacts[0];
  if (artifact === undefined) throw new Error('No public artifact was present.');
  const relativePath = requiredString(artifact, 'relativePath');
  expect(relativePath.startsWith('public/')).toBe(true);
  const artifactUrl = `${target.publicArtifactBaseURL}/${relativePath}`;
  const head = await request.head(artifactUrl);
  expect(head.status()).toBe(200);
  expect(Number(head.headers()['content-length'])).toBe(artifact.byteSize);

  const range = await request.get(artifactUrl, { headers: { range: 'bytes=0-3' } });
  expect(range.status()).toBe(206);
  expect(range.headers()['content-range']).toMatch(/^bytes 0-3\/\d+$/u);
  expect((await range.body()).toString('ascii')).toBe('PAR1');

  const maximumHashProofBytes = 32 * 1024 * 1024;
  expect(Number(artifact.byteSize)).toBeLessThanOrEqual(maximumHashProofBytes);
  const complete = await request.get(artifactUrl);
  expect(complete.status()).toBe(200);
  const calculatedArtifactHash = createHash('sha256')
    .update(await complete.body())
    .digest('hex');
  expect(calculatedArtifactHash).toBe(requiredString(artifact, 'sha256'));
});

test('representative SPA deep links retain the immutable release identity', async ({ page }) => {
  const releaseIds = new Set<string>();
  for (const path of ['/agent', '/query-console', '/mcp', '/about/architecture']) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('main')).toBeVisible();
    const release = page.locator('[data-release-id], [data-testid="release-id"]').first();
    await expect(release).toBeVisible();
    releaseIds.add(((await release.textContent()) ?? '').trim());
  }
  expect(releaseIds.size).toBe(1);
});
