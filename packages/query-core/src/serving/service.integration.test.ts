import { createHash } from 'node:crypto';
import { readFile, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createPortableReleaseManifest,
  writePortableReleaseManifest,
  type ReleaseArtifactInput,
} from '@oracle/artifacts/release/manifest';
import { namedQueryNameSchema, type NamedQueryName } from '@oracle/contracts/query';
import {
  buildPortableServingRelease,
  type BuiltServingArtifact,
  type PortableServingBuildInput,
} from '@oracle/data-runtime/serving/builder';
import {
  SERVING_RELATIONS,
  type ServingRelationName,
  type ServingRow,
  type ServingScalar,
} from '@oracle/data-runtime/serving/schema';
import { afterEach, describe, expect, it } from 'vitest';

import type { InquiryReleaseContext } from '../inquiries/contracts.js';
import {
  PRODUCTION_SERVING_INPUT_FIELDS,
  ProductionServingError,
  type ProductionServingConfig,
  type ProductionServingService,
} from './contracts.js';
import { createProductionServingService } from './service.js';

const INSTANT = '2026-07-17T12:00:00.000Z';
const RELEASE_ID = 'santa-clara-production-v1';
const RUN_ID = 'run-production-v1';
const SOURCE_ID = 'source-santa-clara';
const PROPERTY_A = 'sc:property:a';
const PROPERTY_B = 'sc:property:b';
const CURSOR_SECRET = new Uint8Array(32).fill(7);
const roots: string[] = [];

afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe('production serving composition', () => {
  it('exposes all 16 frozen operations over verified native DuckDB relations', async () => {
    const { service } = await fixture();
    const inputs = minimumInputs();
    const operations = namedQueryNameSchema.options;
    expect(Object.keys(PRODUCTION_SERVING_INPUT_FIELDS).sort()).toEqual([...operations].sort());
    const results = await Promise.all(
      operations.map((operation) => service.execute({ operation, input: inputs[operation] })),
    );

    expect(results).toHaveLength(16);
    expect(new Set(results.map(({ releaseId }) => releaseId))).toEqual(new Set([RELEASE_ID]));
    expect(results.every(({ timing }) => timing.bytesScanned >= 0)).toBe(true);
    expect(
      results.every(({ limitations }) => limitations.includes('Public fixture release.')),
    ).toBe(true);
    const info = results[operations.indexOf('get_dataset_info')];
    expect(info?.data).toMatchObject({ propertyCount: 2, sourceCount: 1, artifactCount: 7 });
    const property = results[operations.indexOf('get_property')];
    expect(property?.data).toMatchObject({ property: { property_id: PROPERTY_A } });
    const artifacts = results[operations.indexOf('list_artifacts')];
    expect(artifacts?.data).toMatchObject({ artifacts: expect.any(Array) });
    const roof = results[operations.indexOf('find_roof_age_candidates')];
    expect(roof?.data).toMatchObject({
      results: [
        {
          propertyId: PROPERTY_A,
          supportClass: 'supported',
          evidence: [
            {
              evidenceId: 'evidence-roof-a',
              sourceIds: [SOURCE_ID],
              limitations: ['Evidence fixture only.'],
            },
          ],
        },
      ],
    });
  });

  it('uses HMAC cursors bound to operation, release, and normalized input', async () => {
    const { service } = await fixture();
    const first = await service.execute({
      operation: 'search_properties',
      input: { releaseId: RELEASE_ID, limit: 1 },
    });
    expect(first.data).toMatchObject({ properties: [{ property_id: PROPERTY_A }] });
    expect(first.nextCursor).not.toBeNull();
    if (first.nextCursor === null) throw new Error('Expected cursor');
    const cursor = first.nextCursor;
    service.validateCursor({
      operation: 'search_properties',
      releaseId: RELEASE_ID,
      cursor,
    });
    const second = await service.execute({
      operation: 'search_properties',
      input: { releaseId: RELEASE_ID, limit: 1, cursor },
    });
    expect(second.data).toMatchObject({ properties: [{ property_id: PROPERTY_B }] });
    await expect(
      service.execute({
        operation: 'search_properties',
        input: { releaseId: RELEASE_ID, limit: 2, cursor },
      }),
    ).rejects.toMatchObject({ code: 'STALE_OR_TAMPERED_CURSOR' });
    expect(() =>
      service.validateCursor({
        operation: 'list_pipeline_runs',
        releaseId: RELEASE_ID,
        cursor,
      }),
    ).toThrow(ProductionServingError);
    expect(() =>
      service.validateCursor({
        operation: 'search_properties',
        releaseId: RELEASE_ID,
        cursor: `${cursor.slice(0, -1)}x`,
      }),
    ).toThrow(ProductionServingError);
    expect(() =>
      service.validateCursor({
        operation: 'find_roof_age_candidates',
        releaseId: RELEASE_ID,
        cursor: 'a'.repeat(513),
      }),
    ).toThrow(ProductionServingError);
  }, 15_000);

  it('serves a public-only package without requiring restricted release bytes', async () => {
    const { service } = await fixture();
    await expect(
      service.execute({ operation: 'list_artifacts', input: { releaseId: RELEASE_ID } }),
    ).resolves.toMatchObject({
      data: {
        artifacts: expect.not.arrayContaining([
          expect.objectContaining({ relation: 'restricted_owner_record' }),
        ]),
      },
    });
  });

  it('keeps caller text parameterized and rejects caller authority or unreleased filters', async () => {
    const { service } = await fixture();
    const hostile = "Palo Alto' OR read_parquet('https://attacker.invalid') IS NOT NULL --";
    await expect(
      service.execute({
        operation: 'search_properties',
        input: { releaseId: RELEASE_ID, city: hostile },
      }),
    ).resolves.toMatchObject({ data: { properties: [] } });
    await expect(
      service.execute({
        operation: 'search_properties',
        input: { releaseId: RELEASE_ID, sql: 'select * from property_query' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      service.execute({
        operation: 'find_transit_walkable_properties',
        input: { releaseId: RELEASE_ID, agencyId: 'caller-selected-agency' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      service.execute({
        operation: 'list_artifacts',
        input: { releaseId: RELEASE_ID, publicationClass: 'restricted' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('fails closed when an artifact or configured release hash drifts', async () => {
    const { root, service, config } = await fixture();
    const propertyPath = join(root, 'public', 'property-query.parquet');
    const bytes = await readFile(propertyPath);
    const corrupt = Buffer.from(bytes);
    corrupt[Math.floor(corrupt.byteLength / 2)] =
      (corrupt[Math.floor(corrupt.byteLength / 2)] ?? 0) ^ 0xff;
    await writeFile(propertyPath, corrupt);
    await expect(
      service.execute({ operation: 'get_dataset_info', input: {} }),
    ).rejects.toMatchObject({ code: 'RELEASE_INVALID' });

    await expect(
      createProductionServingService({
        ...config,
        expected: { ...config.expected, manifestSha256: '0'.repeat(64) },
      }),
    ).rejects.toMatchObject({ code: 'RELEASE_INVALID' });
  });

  it('rejects a self-consistent manifest for another county or state', async () => {
    const { root, config } = await fixture();
    const manifestPath = join(root, 'release-manifest.json');
    const document = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    delete document.manifestSha256;
    document.county = 'Another County';
    const manifestSha256 = createHash('sha256')
      .update(`${stableJson(document)}\n`)
      .digest('hex');
    await writeFile(manifestPath, `${stableJson({ ...document, manifestSha256 })}\n`, 'utf8');
    await expect(
      createProductionServingService({
        ...config,
        expected: { ...config.expected, manifestSha256 },
      }),
    ).rejects.toMatchObject({ code: 'RELEASE_INVALID' });
  });
});

async function fixture(): Promise<
  Readonly<{
    root: string;
    service: ProductionServingService;
    config: ProductionServingConfig;
  }>
> {
  const root = await mkdtemp(join(tmpdir(), 'oracle-production-serving-'));
  roots.push(root);
  const build = await buildPortableServingRelease(buildInput(root));
  const artifacts = [...build.artifacts.map(releaseArtifact), missingRestrictedArtifact()];
  const manifest = createPortableReleaseManifest({
    releaseId: RELEASE_ID,
    runId: RUN_ID,
    generatedAt: INSTANT,
    duckdbVersion: build.duckdbVersion,
    sourceIds: [SOURCE_ID],
    artifacts,
  });
  await writePortableReleaseManifest(join(root, 'release-manifest.json'), manifest);
  const config: ProductionServingConfig = {
    releaseRoot: root,
    manifestRelativePath: 'release-manifest.json',
    expected: {
      releaseId: RELEASE_ID,
      runId: RUN_ID,
      manifestSha256: manifest.manifestSha256,
      manifestCid: 'bafy-production-manifest',
      asOf: INSTANT,
      schemaVersion: '1.0.0',
      policyVersion: 'bay-area-nine-counties-v1',
    },
    cursorSecret: CURSOR_SECRET,
    rankingWeights: rankingWeights(),
    capabilities: capabilities(),
    limitations: ['Public fixture release.'],
  };
  return { root, config, service: await createProductionServingService(config) };
}

function buildInput(outputDirectory: string): PortableServingBuildInput {
  return {
    outputDirectory,
    releaseId: RELEASE_ID,
    runId: RUN_ID,
    generatedAt: INSTANT,
    sourceIds: [SOURCE_ID],
    profiles: [
      {
        visibility: 'public',
        relations: {
          property_query: [property(PROPERTY_B, false), property(PROPERTY_A, true)],
          property_evidence: evidenceRows(),
          source_coverage: [
            relationRow('source_coverage', {
              source_id: SOURCE_ID,
              scope: 'county',
              expected_count: 2,
              observed_count: 2,
              quarantine_count: 0,
              limitations_json: '["Coverage fixture only."]',
            }),
          ],
          field_coverage: [
            relationRow('field_coverage', {
              relation_name: 'property_query',
              field_name: 'property_id',
              numerator: 2,
              denominator: 2,
              ratio: 1,
              source_ids_json: `["${SOURCE_ID}"]`,
              limitations_json: '[]',
            }),
          ],
          relation_coverage: [
            relationRow('relation_coverage', {
              relation_name: 'property_evidence',
              linked_count: 2,
              eligible_count: 2,
              ratio: 1,
              limitations_json: '[]',
            }),
          ],
          pipeline_runs: [
            relationRow('pipeline_runs', {
              run_id: RUN_ID,
              status: 'succeeded',
              started_at: '2026-07-17T10:00:00.000Z',
              completed_at: INSTANT,
              source_ids_json: `["${SOURCE_ID}"]`,
              expected_count: 2,
              observed_count: 2,
              quarantine_count: 0,
              limitations_json: '["Run fixture only."]',
            }),
          ],
        },
      },
    ],
  };
}

function property(propertyId: string, supported: boolean): ServingRow {
  return relationRow('property_query', {
    property_id: propertyId,
    parcel_identifier: supported ? '001' : '002',
    address_street: supported ? '1 University Ave' : '2 University Ave',
    address_city: 'Palo Alto',
    address_zip: '94301',
    roof_support_class: supported ? 'supported' : 'unknown',
    roof_age_years: supported ? 20 : null,
    roof_reference_date: supported ? '2006-01-01' : null,
    water_support_class: supported ? 'supported' : 'unknown',
    water_distance_meters: supported ? 200 : null,
    water_visibility_state: supported ? 'terrain_clear_candidate' : null,
    ownership_support_class: supported ? 'supported' : 'unknown',
    years_since_exchange: supported ? 12 : null,
    last_exchange_date: supported ? '2013-01-01' : null,
    regional_owner_support_class: supported ? 'supported' : 'unknown',
    is_regional_owner: supported ? true : null,
    transit_support_class: supported ? 'supported' : 'unknown',
    transit_distance_meters: supported ? 300 : null,
    transit_walk_minutes: supported ? 4 : null,
    starbucks_support_class: supported ? 'supported' : 'unknown',
    starbucks_distance_meters: supported ? 400 : null,
    starbucks_walk_minutes: supported ? 5 : null,
    combined_review_score: supported ? 1 : null,
    evidence_coverage: supported ? 1 : 0,
  });
}

function evidenceRows(): readonly ServingRow[] {
  return [
    'roof_age',
    'water_view_candidate',
    'ownership_age',
    'regional_owner',
    'transit_walkability',
    'starbucks_walkability',
  ].map((feature) =>
    relationRow('property_evidence', {
      evidence_id: `evidence-${feature === 'roof_age' ? 'roof' : feature}-a`,
      property_id: PROPERTY_A,
      feature,
      support_class: 'supported',
      confidence: 1,
      value_json: '{}',
      source_ids_json: `["${SOURCE_ID}"]`,
      source_references_json: '[{"recordKey":"public-fixture"}]',
      limitations_json: '["Evidence fixture only."]',
    }),
  );
}

function relationRow(
  relation: ServingRelationName,
  overrides: Readonly<Record<string, ServingScalar>>,
): ServingRow {
  return Object.fromEntries(
    SERVING_RELATIONS[relation].columns.map((column) => [
      column.name,
      Object.hasOwn(overrides, column.name)
        ? overrides[column.name]
        : defaultScalar(column.name, column.duckdbType, column.nullable),
    ]),
  ) as ServingRow;
}

function defaultScalar(
  name: string,
  type: 'VARCHAR' | 'BOOLEAN' | 'BIGINT' | 'DOUBLE',
  nullable: boolean,
): ServingScalar {
  if (nullable) return null;
  if (type === 'BOOLEAN') return false;
  if (type === 'BIGINT') return 1;
  if (type === 'DOUBLE') return name === 'confidence' || name === 'ratio' ? 1 : 1.5;
  if (name.endsWith('_json')) return '[]';
  if (name.endsWith('_support_class') || name === 'support_class') return 'supported';
  if (name === 'visibility') return 'public';
  if (name.endsWith('_at') || name === 'as_of' || name === 'valid_from') return INSTANT;
  if (name.endsWith('sha256')) return 'a'.repeat(64);
  return `${name}-fixture`;
}

function releaseArtifact(artifact: BuiltServingArtifact): ReleaseArtifactInput {
  return {
    ...artifact,
    grain: SERVING_RELATIONS[artifact.relation].grain,
    sourceLineage: [
      {
        sourceId: SOURCE_ID,
        snapshotId: 'snapshot-santa-clara-v1',
        sourceSha256: 'b'.repeat(64),
        schemaSha256: 'c'.repeat(64),
        asOf: INSTANT,
        role: 'direct',
      },
    ],
    limitations: ['Public fixture release.'],
  };
}

function missingRestrictedArtifact(): ReleaseArtifactInput {
  return {
    relation: 'restricted_owner_record',
    relativePath: 'restricted/restricted-owner-record.parquet',
    visibility: 'restricted',
    mediaType: 'application/vnd.apache.parquet',
    byteSize: 128,
    sha256: 'd'.repeat(64),
    rowCount: 1,
    schemaSha256: 'e'.repeat(64),
    columns: [
      {
        name: 'property_id',
        duckdbType: 'VARCHAR',
        nullable: false,
        description: 'Restricted fixture property identity.',
      },
    ],
    nonNullCounts: { property_id: 1 },
    grain: 'one row per restricted owner record',
    sourceLineage: [
      {
        sourceId: SOURCE_ID,
        snapshotId: 'snapshot-santa-clara-v1',
        sourceSha256: 'b'.repeat(64),
        schemaSha256: 'c'.repeat(64),
        asOf: INSTANT,
        role: 'direct',
      },
    ],
    limitations: ['Restricted bytes are intentionally absent from the public package.'],
  };
}

function rankingWeights(): InquiryReleaseContext['rankingWeights'] {
  return [
    'roof_age',
    'water_view_candidate',
    'ownership_age',
    'regional_owner',
    'transit_walkability',
    'starbucks_walkability',
  ].map((criterion) => ({
    criterion: criterion as InquiryReleaseContext['rankingWeights'][number]['criterion'],
    weight: 1,
    proxyMultiplier: 0.5,
  }));
}

function capabilities(): InquiryReleaseContext['capabilities'] {
  const capability = {
    state: 'supported',
    supportClasses: ['supported', 'proxy', 'unknown', 'unsupported'],
    numerator: 1,
    denominator: 2,
    limitations: ['Public fixture release.'],
  } as const;
  return {
    roof_age: capability,
    water_view_candidate: capability,
    ownership_age: capability,
    regional_owner: capability,
    transit_walkability: capability,
    starbucks_walkability: capability,
  };
}

function minimumInputs(): Readonly<Record<NamedQueryName, Readonly<Record<string, unknown>>>> {
  return {
    get_dataset_info: {},
    get_dataset_coverage: { releaseId: RELEASE_ID },
    list_pipeline_runs: { releaseId: RELEASE_ID },
    get_pipeline_run: { releaseId: RELEASE_ID, runId: RUN_ID },
    search_properties: { releaseId: RELEASE_ID },
    get_property: { releaseId: RELEASE_ID, propertyId: PROPERTY_A },
    get_property_evidence: { releaseId: RELEASE_ID, propertyId: PROPERTY_A },
    find_roof_age_candidates: { releaseId: RELEASE_ID, propertyId: PROPERTY_A },
    find_water_view_candidates: { releaseId: RELEASE_ID, propertyId: PROPERTY_A },
    find_ownership_age_candidates: { releaseId: RELEASE_ID, propertyId: PROPERTY_A },
    find_regional_owner_properties: { releaseId: RELEASE_ID, propertyId: PROPERTY_A },
    find_transit_walkable_properties: { releaseId: RELEASE_ID, propertyId: PROPERTY_A },
    find_starbucks_walkable_properties: { releaseId: RELEASE_ID, propertyId: PROPERTY_A },
    rank_review_candidates: {
      releaseId: RELEASE_ID,
      propertyId: PROPERTY_A,
      criteria: ['roof_age'],
    },
    list_artifacts: { releaseId: RELEASE_ID },
    get_data_dictionary: { releaseId: RELEASE_ID },
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}
