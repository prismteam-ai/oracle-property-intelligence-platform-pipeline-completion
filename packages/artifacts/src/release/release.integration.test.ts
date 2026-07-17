import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createElephantCompatibilityReport,
  ELEPHANT_COMPATIBILITY_COLUMNS,
  ElephantContractDriftError,
  ElephantDenominatorDriftError,
  type ElephantFieldLineage,
} from './elephant-compatibility.js';
import {
  createPortableReleaseManifest,
  readPortableReleaseManifest,
  ReleaseArtifactIntegrityError,
  ReleaseManifestIntegrityError,
  serializePortableReleaseManifest,
  verifyPortableReleaseFiles,
  writePortableReleaseManifest,
  type ReleaseArtifactInput,
  type ReleaseColumn,
} from './manifest.js';

const INSTANT = '2026-07-17T12:00:00.000Z';
const SOURCE_SHA = 'a'.repeat(64);
const SCHEMA_SHA = 'b'.repeat(64);

describe('portable release manifest', () => {
  it('writes and reopens canonical JSON binding bytes, schema, counts, lineage, visibility, and limitations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oracle-release-manifest-'));
    try {
      const artifactBytes = Buffer.from('PAR1tiny-clean-room-parquetPAR1');
      const artifact = releaseArtifact(artifactBytes);
      const artifactPath = join(root, artifact.relativePath);
      await mkdir(dirname(artifactPath), { recursive: true });
      await writeFile(artifactPath, artifactBytes);

      const input = {
        releaseId: 'santa-clara-release-v1',
        runId: 'run-v1',
        generatedAt: INSTANT,
        duckdbVersion: 'v1.4.5',
        sourceIds: ['source-b', 'source-a'],
        artifacts: [artifact],
      } as const;
      const first = createPortableReleaseManifest(input);
      const second = createPortableReleaseManifest({
        ...input,
        sourceIds: [...input.sourceIds].reverse(),
        artifacts: [
          {
            ...artifact,
            limitations: [...artifact.limitations].reverse(),
            sourceLineage: [...artifact.sourceLineage].reverse(),
          },
        ],
      });
      expect(serializePortableReleaseManifest(first)).toEqual(
        serializePortableReleaseManifest(second),
      );
      expect(first.artifacts[0]).toMatchObject({
        byteSize: artifactBytes.byteLength,
        rowCount: 2,
        grain: 'exactly one row per property_id',
        visibility: 'public',
        limitations: ['Fixture only.', 'Owner-bearing fields excluded.'],
      });
      expect(first.artifacts[0]?.sourceLineage).toHaveLength(2);

      const manifestPath = join(root, 'artifact-manifest.json');
      await writePortableReleaseManifest(manifestPath, first);
      const reopened = await readPortableReleaseManifest(manifestPath);
      expect(reopened).toEqual(first);
      await expect(verifyPortableReleaseFiles(root, reopened)).resolves.toEqual([
        {
          relativePath: artifact.relativePath,
          byteSize: artifactBytes.byteLength,
          sha256: sha256(artifactBytes),
        },
      ]);
      await expect(writePortableReleaseManifest(manifestPath, first)).rejects.toThrow();

      const changedBytes = Buffer.from(artifactBytes);
      changedBytes[6] = (changedBytes[6] ?? 0) ^ 0xff;
      await writeFile(artifactPath, changedBytes);
      await expect(verifyPortableReleaseFiles(root, reopened)).rejects.toBeInstanceOf(
        ReleaseArtifactIntegrityError,
      );

      const json = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      json.runId = 'tampered-run';
      await writeFile(manifestPath, JSON.stringify(json));
      await expect(readPortableReleaseManifest(manifestPath)).rejects.toBeInstanceOf(
        ReleaseManifestIntegrityError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects incomplete artifact bindings and portable path/source-lineage drift', () => {
    const artifact = releaseArtifact(Buffer.from('PAR1fixturePAR1'));
    const base = {
      releaseId: 'release-v1',
      runId: 'run-v1',
      generatedAt: INSTANT,
      duckdbVersion: 'v1.4.5',
      sourceIds: ['source-a', 'source-b'],
      artifacts: [artifact],
    } as const;
    expect(() =>
      createPortableReleaseManifest({
        ...base,
        artifacts: [{ ...artifact, relativePath: '../restricted/data.parquet' }],
      }),
    ).toThrow(/portable and relative/iu);
    expect(() => createPortableReleaseManifest({ ...base, sourceIds: ['source-a'] })).toThrow(
      /exactly match artifact source lineage/iu,
    );
    expect(() =>
      createPortableReleaseManifest({
        ...base,
        artifacts: [{ ...artifact, sourceLineage: [] }],
      }),
    ).toThrow(/sourceLineage/iu);
    expect(() =>
      createPortableReleaseManifest({
        ...base,
        artifacts: [{ ...artifact, limitations: ['', 'Fixture only.'] }],
      }),
    ).toThrow(/limitations/iu);
    expect(() =>
      createPortableReleaseManifest({
        ...base,
        artifacts: [{ ...artifact, grain: '' }],
      }),
    ).toThrow(/grain/iu);
  });
});

describe('Elephant field-by-field compatibility release report', () => {
  it('diffs every audited field and deterministically identifies filled, unchanged, and regressed coverage', () => {
    const artifact = elephantArtifact();
    const baselineNonNullCounts = Object.fromEntries(
      ELEPHANT_COMPATIBILITY_COLUMNS.map(({ name }) => [name, 0]),
    );
    baselineNonNullCounts.property_id = 2;
    baselineNonNullCounts.address_city = 1;
    const lineage = Object.fromEntries(
      ELEPHANT_COMPATIBILITY_COLUMNS.map(({ name }) => [name, fieldLineage(name)]),
    );
    const input = {
      artifact,
      auditedSource: {
        repository: 'elephant-query-db',
        commitSha: '0123456789abcdef0123456789abcdef01234567',
        path: 'src/properties.ts',
      },
      baseline: { rowCount: 2, distinctPropertyIds: 2, nonNullCounts: baselineNonNullCounts },
      releaseDistinctPropertyIds: 2,
      lineage,
    } as const;

    const first = createElephantCompatibilityReport(input);
    const second = createElephantCompatibilityReport(input);
    expect(first).toEqual(second);
    expect(first.fields).toHaveLength(37);
    expect(first.fields.map(({ ordinal }) => ordinal)).toEqual(
      Array.from({ length: 37 }, (_, index) => index + 1),
    );
    expect(first.fields.find(({ name }) => name === 'property_id')?.change).toBe('unchanged');
    expect(first.fields.find(({ name }) => name === 'parcel_identifier')?.change).toBe('filled');
    expect(first.fields.find(({ name }) => name === 'address_city')?.change).toBe('regressed');
    expect(first.fields.every(({ lineage: item }) => item.transformation.length > 0)).toBe(true);
  });

  it('rejects column order/type and row-grain denominator drift', () => {
    const artifact = elephantArtifact();
    const baseline = {
      rowCount: 2,
      distinctPropertyIds: 2,
      nonNullCounts: Object.fromEntries(
        ELEPHANT_COMPATIBILITY_COLUMNS.map(({ name }) => [name, name === 'property_id' ? 2 : 0]),
      ),
    };
    const lineage = Object.fromEntries(
      ELEPHANT_COMPATIBILITY_COLUMNS.map(({ name }) => [name, fieldLineage(name)]),
    );
    const input = {
      artifact,
      auditedSource: { repository: 'repo', commitSha: 'sha', path: 'path' },
      baseline,
      releaseDistinctPropertyIds: 2,
      lineage,
    } as const;
    expect(() =>
      createElephantCompatibilityReport({
        ...input,
        artifact: { ...artifact, columns: [...artifact.columns].reverse() },
      }),
    ).toThrow(ElephantContractDriftError);
    expect(() =>
      createElephantCompatibilityReport({ ...input, releaseDistinctPropertyIds: 1 }),
    ).toThrow(ElephantDenominatorDriftError);
  });
});

function releaseArtifact(bytes: Uint8Array): ReleaseArtifactInput {
  return {
    relation: 'property_query',
    relativePath: 'public/property-query.parquet',
    visibility: 'public',
    mediaType: 'application/vnd.apache.parquet',
    byteSize: bytes.byteLength,
    sha256: sha256(bytes),
    rowCount: 2,
    schemaSha256: SCHEMA_SHA,
    columns: [
      {
        name: 'property_id',
        duckdbType: 'VARCHAR',
        nullable: false,
        description: 'Stable property identifier.',
      },
    ],
    nonNullCounts: { property_id: 2 },
    grain: 'exactly one row per property_id',
    sourceLineage: [
      {
        sourceId: 'source-b',
        snapshotId: 'snapshot-b',
        sourceSha256: 'c'.repeat(64),
        schemaSha256: 'd'.repeat(64),
        asOf: null,
        role: 'derived',
      },
      {
        sourceId: 'source-a',
        snapshotId: 'snapshot-a',
        sourceSha256: SOURCE_SHA,
        schemaSha256: SCHEMA_SHA,
        asOf: INSTANT,
        role: 'direct',
      },
    ],
    limitations: ['Owner-bearing fields excluded.', 'Fixture only.'],
  };
}

function elephantArtifact(): ReleaseArtifactInput {
  const nonNullCounts = Object.fromEntries(
    ELEPHANT_COMPATIBILITY_COLUMNS.map(({ name }) => [name, 0]),
  );
  nonNullCounts.property_id = 2;
  nonNullCounts.parcel_identifier = 2;
  nonNullCounts.built_year = 1;
  const columns: readonly ReleaseColumn[] = ELEPHANT_COMPATIBILITY_COLUMNS.map((column) => ({
    ...column,
    description: `${column.name} compatibility field.`,
  }));
  return {
    relation: 'elephant_properties',
    relativePath: 'restricted/elephant-properties.parquet',
    visibility: 'restricted',
    mediaType: 'application/vnd.apache.parquet',
    byteSize: 128,
    sha256: 'e'.repeat(64),
    rowCount: 2,
    schemaSha256: 'f'.repeat(64),
    columns,
    nonNullCounts,
    grain: 'exactly one row per Elephant property_id',
    sourceLineage: [
      {
        sourceId: 'elephant-baseline',
        snapshotId: 'baseline-v1',
        sourceSha256: SOURCE_SHA,
        schemaSha256: SCHEMA_SHA,
        asOf: INSTANT,
        role: 'direct',
      },
    ],
    limitations: ['Owner-bearing compatibility projection remains restricted.'],
  };
}

function fieldLineage(name: string): ElephantFieldLineage {
  return {
    canonicalRelation: name === 'owner_name' ? 'restricted_ownership' : 'property',
    canonicalField: name,
    sourceIds: ['source-a'],
    transformation: `project:${name}:v1`,
    completenessWindow: '2026-07-17',
    matchMethod: 'canonical_property_id',
    confidence: 'high',
    nullSemantics: 'null means unavailable or unsupported; absence is not a positive claim',
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
