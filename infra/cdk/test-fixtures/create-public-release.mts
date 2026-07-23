import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  createPortableReleaseManifest,
  writePortableReleaseManifest,
} from '../../../packages/artifacts/dist/release/manifest.js';
import { buildPortableServingRelease } from '../../../packages/data-runtime/dist/serving/builder.js';
import { SERVING_RELATIONS } from '../../../packages/data-runtime/dist/serving/schema.js';

const RELEASE_ID = 'test-only-cdk-public-release';
const RUN_ID = 'test-only-cdk-run';
const INSTANT = '2026-07-17T00:00:00.000Z';
const SOURCE_ID = 'test-only-source';
const OUTPUT_DIRECTORY = resolve(import.meta.dirname, 'generated-public-release');

if (process.argv[2] === 'remove') {
  await rm(OUTPUT_DIRECTORY, { recursive: true, force: true });
  process.exit(0);
}
if (process.argv[2] !== 'create') {
  throw new Error('Expected create or remove.');
}

await rm(OUTPUT_DIRECTORY, { recursive: true, force: true });
await mkdir(OUTPUT_DIRECTORY, { recursive: true });

const build = await buildPortableServingRelease({
  outputDirectory: OUTPUT_DIRECTORY,
  releaseId: RELEASE_ID,
  runId: RUN_ID,
  generatedAt: INSTANT,
  sourceIds: [SOURCE_ID],
  profiles: [
    {
      visibility: 'public',
      relations: {
        property_query: [],
        property_evidence: [],
        source_coverage: [],
        field_coverage: [],
        relation_coverage: [],
        pipeline_runs: [],
      },
    },
  ],
});
const manifest = createPortableReleaseManifest({
  releaseId: RELEASE_ID,
  runId: RUN_ID,
  generatedAt: INSTANT,
  duckdbVersion: build.duckdbVersion,
  sourceIds: [SOURCE_ID],
  artifacts: build.artifacts.map((artifact) => ({
    ...artifact,
    grain: SERVING_RELATIONS[artifact.relation].grain,
    sourceLineage: [
      {
        sourceId: SOURCE_ID,
        snapshotId: 'test-only-snapshot',
        sourceSha256: 'a'.repeat(64),
        schemaSha256: 'b'.repeat(64),
        asOf: INSTANT,
        role: 'direct',
      },
    ],
    limitations: ['Test-only empty release; no production data.'],
  })),
});
await writePortableReleaseManifest(resolve(OUTPUT_DIRECTORY, 'release-manifest.json'), manifest);

const criteria = [
  'roof_age',
  'water_view_candidate',
  'ownership_age',
  'regional_owner',
  'transit_walkability',
  'starbucks_walkability',
] as const;
const configuration = {
  manifestRelativePath: 'release-manifest.json',
  expected: {
    releaseId: RELEASE_ID,
    runId: RUN_ID,
    manifestSha256: manifest.manifestSha256,
    manifestCid: 'bafy-test-only-cdk-public-release',
    asOf: INSTANT,
    schemaVersion: '1.0.0',
    policyVersion: 'test-only-policy-v1',
  },
  rankingWeights: criteria.map((criterion) => ({
    criterion,
    weight: 1,
    proxyMultiplier: 0.5,
  })),
  capabilities: Object.fromEntries(
    criteria.map((criterion) => [
      criterion,
      {
        state: 'blocked',
        supportClasses: ['unknown', 'unsupported'],
        numerator: 0,
        denominator: 0,
        limitations: ['Test-only empty release; no production data.'],
      },
    ]),
  ),
  limitations: ['Test-only empty release; never select for production deployment.'],
};
await writeFile(
  resolve(OUTPUT_DIRECTORY, 'serving-config.json'),
  `${JSON.stringify(configuration, null, 2)}\n`,
  'utf8',
);
