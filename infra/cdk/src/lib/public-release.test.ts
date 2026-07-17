import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { validatePublicReleaseBundle } from './public-release.js';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../../../');
const FIXTURE_PARENT = resolve(REPOSITORY_ROOT, 'infra/cdk/test-fixtures');
const PARQUET = Buffer.from('PAR1testPAR1');
const RELATIONS = Object.freeze({
  property_query: [
    'property-query.parquet',
    'exactly one row per property_id',
    '1777bd6cd41a50ef103e462955fafbf9c8ec98025ea99f1ddd2f533359a4bbfa',
  ],
  property_evidence: [
    'property-evidence.parquet',
    'one row per immutable evidence_id',
    'df58028d7225b271fbf618ed33302c6a58e0eece72c8eb92a14de0c45cbfefed',
  ],
  source_coverage: [
    'source-coverage.parquet',
    'one row per source and measured scope',
    'a0d269a3800eed76c1faec1e16f264b2c8ab9ba3794cdf6811ca87d048d62aef',
  ],
  field_coverage: [
    'field-coverage.parquet',
    'one row per relation and field',
    '0921849241395eb9797eb30ee38d0fdd3ab9025fb24d1a5c3da3beb059043613',
  ],
  relation_coverage: [
    'relation-coverage.parquet',
    'one row per relationship type',
    '7ddd90a3a771a79445e0f3213e6699efe62982f0d03a4c2feba4615a084de389',
  ],
  pipeline_runs: [
    'pipeline-runs.parquet',
    'one row per immutable pipeline run',
    '00c9bff133ff790233a8f66cf7e90b5066db54e01403b1d399efab3828d99a6e',
  ],
  data_dictionary: [
    'data-dictionary.parquet',
    'one row per released relation column',
    '94a89caff14e8927d2b85d5d804327a3973d79a19685b732adbc33f40744b893',
  ],
} as const);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('public release asset validation', () => {
  it('accepts an explicit verified test package only through the test seam', async () => {
    const root = await fixture();
    expect(() => validate(root, false)).toThrow('test fixtures cannot be selected');
    expect(validate(root, true)).toMatchObject({
      servingConfigRelativePath: 'serving-config.json',
    });
  });

  it('rejects absent, outside-repository, and malformed selections', async () => {
    expect(() =>
      validatePublicReleaseBundle({
        repositoryRoot: REPOSITORY_ROOT,
        releaseDirectory: undefined,
        servingConfigRelativePath: 'serving-config.json',
      }),
    ).toThrow('caller-selected');

    const outside = await mkdtemp(join(tmpdir(), 'oracle-outside-release-'));
    roots.push(outside);
    expect(() =>
      validatePublicReleaseBundle({
        repositoryRoot: REPOSITORY_ROOT,
        releaseDirectory: outside,
        servingConfigRelativePath: 'serving-config.json',
      }),
    ).toThrow('child of the repository');

    const root = await fixture();
    expect(() =>
      validatePublicReleaseBundle({
        repositoryRoot: REPOSITORY_ROOT,
        releaseDirectory: root,
        servingConfigRelativePath: '../serving-config.json',
        allowTestFixture: true,
      }),
    ).toThrow('portable relative path');
  });

  it('rejects symlinks, unexpected credentials, restricted bytes, and owner-bearing schemas', async () => {
    const rootTarget = await fixture();
    const rootLinkParent = await mkdtemp(join(FIXTURE_PARENT, 'root-link-'));
    roots.push(rootLinkParent);
    const rootLink = join(rootLinkParent, 'release');
    await symlink(rootTarget, rootLink, 'junction');
    expect(() => validate(rootLink, true)).toThrow('Symlinks are prohibited');

    const symlinkRoot = await fixture();
    const target = await mkdtemp(join(FIXTURE_PARENT, 'symlink-target-'));
    roots.push(target);
    await symlink(target, join(symlinkRoot, 'linked'), 'junction');
    expect(() => validate(symlinkRoot, true)).toThrow('Symlinks are prohibited');

    const credentialRoot = await fixture();
    await writeFile(join(credentialRoot, 'credentials.json'), '{}\n');
    expect(() => validate(credentialRoot, true)).toThrow('Unexpected release file');

    const restrictedRoot = await fixture({ restrictedArtifact: true });
    await mkdir(join(restrictedRoot, 'restricted'));
    await writeFile(join(restrictedRoot, 'restricted', 'owner.parquet'), PARQUET);
    expect(() => validate(restrictedRoot, true)).toThrow(
      'Restricted artifact bytes are prohibited',
    );

    const ownerRoot = await fixture({ ownerColumn: true });
    expect(() => validate(ownerRoot, true)).toThrow('schema is unsafe');
  });

  it('rejects manifest, artifact, schema, and closure drift before asset construction', async () => {
    const hashRoot = await fixture();
    await writeFile(
      join(hashRoot, 'public', 'property-query.parquet'),
      Buffer.from('PAR1bad!PAR1'),
    );
    expect(() => validate(hashRoot, true)).toThrow('integrity check failed');

    const schemaRoot = await fixture({ schemaDrift: true });
    expect(() => validate(schemaRoot, true)).toThrow('contract drift');

    const manifestRoot = await fixture({ manifestHashDrift: true });
    expect(() => validate(manifestRoot, true)).toThrow('manifest hash mismatch');
  });
});

function validate(root: string, allowTestFixture: boolean) {
  return validatePublicReleaseBundle({
    repositoryRoot: REPOSITORY_ROOT,
    releaseDirectory: root,
    servingConfigRelativePath: 'serving-config.json',
    allowTestFixture,
  });
}

async function fixture(
  options: Readonly<{
    manifestHashDrift?: boolean;
    ownerColumn?: boolean;
    restrictedArtifact?: boolean;
    schemaDrift?: boolean;
  }> = {},
): Promise<string> {
  await mkdir(FIXTURE_PARENT, { recursive: true });
  const root = await mkdtemp(join(FIXTURE_PARENT, 'validation-release-'));
  roots.push(root);
  await mkdir(join(root, 'public'));
  const parquetSha256 = sha256(PARQUET);
  const artifacts = Object.entries(RELATIONS).map(([relation, contract]) => {
    const [fileName, grain, schemaSha256] = contract;
    return {
      relation,
      relativePath: `public/${fileName}`,
      visibility: 'public',
      mediaType: 'application/vnd.apache.parquet',
      byteSize: PARQUET.byteLength,
      sha256: parquetSha256,
      rowCount: 0,
      schemaSha256:
        options.schemaDrift === true && relation === 'property_query'
          ? 'f'.repeat(64)
          : schemaSha256,
      columns: [
        {
          name: options.ownerColumn === true && relation === 'property_query' ? 'owner_name' : 'id',
          duckdbType: 'VARCHAR',
          nullable: false,
          description: 'Test-only validation fixture.',
        },
      ],
      nonNullCounts: {
        [options.ownerColumn === true && relation === 'property_query' ? 'owner_name' : 'id']: 0,
      },
      grain,
      sourceLineage: [
        {
          sourceId: 'test-source',
          snapshotId: 'test-snapshot',
          sourceSha256: 'a'.repeat(64),
          schemaSha256: 'b'.repeat(64),
          asOf: '2026-07-17T00:00:00.000Z',
          role: 'direct',
        },
      ],
      limitations: ['Test-only validation fixture.'],
    };
  });
  if (options.restrictedArtifact === true) {
    const templateArtifact = artifacts[0];
    if (templateArtifact === undefined) throw new Error('Test release has no public artifact.');
    artifacts.push({
      ...templateArtifact,
      relation: 'restricted_owner_record',
      relativePath: 'restricted/owner.parquet',
      visibility: 'restricted',
    });
  }
  for (const artifact of artifacts.filter(({ visibility }) => visibility === 'public')) {
    await writeFile(join(root, artifact.relativePath), PARQUET);
  }
  const payload = {
    artifacts,
    contractVersion: '1.0.0',
    county: 'Santa Clara',
    duckdbVersion: 'v1.4.5',
    generatedAt: '2026-07-17T00:00:00.000Z',
    releaseId: 'test-release',
    runId: 'test-run',
    sourceIds: ['test-source'],
    state: 'CA',
  };
  const manifestSha256 = sha256(Buffer.from(`${stableJson(payload)}\n`));
  await writeFile(
    join(root, 'release-manifest.json'),
    `${stableJson({
      ...payload,
      manifestSha256: options.manifestHashDrift === true ? '0'.repeat(64) : manifestSha256,
    })}\n`,
  );
  const criteria = [
    'roof_age',
    'water_view_candidate',
    'ownership_age',
    'regional_owner',
    'transit_walkability',
    'starbucks_walkability',
  ];
  await writeFile(
    join(root, 'serving-config.json'),
    `${JSON.stringify({
      manifestRelativePath: 'release-manifest.json',
      expected: {
        releaseId: payload.releaseId,
        runId: payload.runId,
        manifestSha256: options.manifestHashDrift === true ? '0'.repeat(64) : manifestSha256,
        manifestCid: 'bafy-test-manifest',
        asOf: payload.generatedAt,
        schemaVersion: '1.0.0',
        policyVersion: 'test-policy',
      },
      rankingWeights: criteria.map((criterion) => ({ criterion, weight: 1, proxyMultiplier: 0.5 })),
      capabilities: Object.fromEntries(
        criteria.map((criterion) => [
          criterion,
          {
            state: 'blocked',
            supportClasses: ['unknown', 'unsupported'],
            numerator: 0,
            denominator: 0,
            limitations: ['Test-only validation fixture.'],
          },
        ]),
      ),
      limitations: ['Test-only validation fixture.'],
    })}\n`,
  );
  return root;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}
