import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { DuckDBInstance } from '@duckdb/node-api';
import { describe, expect, it } from 'vitest';

import {
  buildPortableServingRelease,
  ImmutableReleaseExistsError,
  PublicArtifactPolicyError,
  readArtifactRange,
  RowGrainError,
  ServingSchemaError,
  type BuiltServingArtifact,
  type PortableServingBuildInput,
} from './builder.js';
import {
  SERVING_RELATIONS,
  type ServingRelationName,
  type ServingRow,
  type ServingScalar,
} from './schema.js';
import {
  ArtifactCorruptionError,
  ArtifactCountDriftError,
  ArtifactSchemaDriftError,
  ArtifactVisibilityError,
  openServingProfile,
  verifyServingArtifacts,
} from './verifier.js';

const INSTANT = '2026-07-17T12:00:00.000Z';
const SHA_A = 'a'.repeat(64);

describe('portable DuckDB serving release', () => {
  it('rebuilds byte-identical Parquet, reopens both profiles, and matches direct DuckDB', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oracle-serving-clean-room-'));
    try {
      const firstRoot = join(root, 'first');
      const secondRoot = join(root, 'second');
      const first = await buildPortableServingRelease(buildInput(firstRoot));
      const second = await buildPortableServingRelease(buildInput(secondRoot));

      expect(artifactSignatures(first.artifacts)).toEqual(artifactSignatures(second.artifacts));
      for (const artifact of first.artifacts) {
        const firstBytes = await readFile(resolve(firstRoot, artifact.relativePath));
        const secondBytes = await readFile(resolve(secondRoot, artifact.relativePath));
        expect(firstBytes.equals(secondBytes)).toBe(true);
      }

      await expect(verifyServingArtifacts(firstRoot, first.artifacts)).resolves.toHaveLength(5);
      const queryArtifact = requiredArtifact(first.artifacts, 'public', 'property_query');
      const queryPath = resolve(firstRoot, queryArtifact.relativePath);
      await expect(readArtifactRange(queryPath, 0, 3)).resolves.toEqual(Buffer.from('PAR1'));
      await expect(
        readArtifactRange(queryPath, queryArtifact.byteSize - 4, queryArtifact.byteSize - 1),
      ).resolves.toEqual(Buffer.from('PAR1'));
      await expect(
        readArtifactRange(queryPath, queryArtifact.byteSize - 2, queryArtifact.byteSize),
      ).rejects.toThrow(RangeError);

      const profile = await openServingProfile(firstRoot, first.artifacts, 'public');
      const directInstance = await DuckDBInstance.create(':memory:', { threads: '1' });
      const direct = await directInstance.connect();
      try {
        const profileRows = (
          await profile.connection.runAndReadAll(
            'SELECT property_id, parcel_identifier FROM property_query ORDER BY property_id',
          )
        ).getRowObjects();
        const directRows = (
          await direct.runAndReadAll(
            `SELECT property_id, parcel_identifier FROM read_parquet('${sqlPath(queryPath)}') ORDER BY property_id`,
          )
        ).getRowObjects();
        expect(profileRows).toEqual(directRows);
        expect(profileRows.map(({ property_id }) => property_id)).toEqual([
          'property-a',
          'property-b',
        ]);
        await expect(
          profile.connection.runAndReadAll('SELECT * FROM elephant_properties'),
        ).rejects.toThrow(/elephant_properties/iu);
      } finally {
        profile.connection.closeSync();
        profile.instance.closeSync();
        direct.closeSync();
        directInstance.closeSync();
      }

      const databasePath = join(root, 'portable-serving.duckdb');
      const databaseWriter = await DuckDBInstance.create(databasePath, { threads: '1' });
      const writerConnection = await databaseWriter.connect();
      try {
        await writerConnection.run(
          `CREATE TABLE property_query AS SELECT * FROM read_parquet('${sqlPath(queryPath)}')`,
        );
        await writerConnection.run('CHECKPOINT');
      } finally {
        writerConnection.closeSync();
        databaseWriter.closeSync();
      }
      const reopenedDatabase = await DuckDBInstance.create(databasePath, { threads: '1' });
      const reopenedConnection = await reopenedDatabase.connect();
      try {
        const reopenedRows = (
          await reopenedConnection.runAndReadAll(
            'SELECT property_id, parcel_identifier FROM property_query ORDER BY property_id',
          )
        ).getRowObjects();
        expect(reopenedRows).toEqual([
          { property_id: 'property-a', parcel_identifier: '132-38-069' },
          { property_id: 'property-b', parcel_identifier: '132-38-069' },
        ]);
      } finally {
        reopenedConnection.closeSync();
        reopenedDatabase.closeSync();
      }

      const restricted = await openServingProfile(firstRoot, first.artifacts, 'restricted');
      try {
        const owners = (
          await restricted.connection.runAndReadAll(
            'SELECT property_id, owner_name FROM elephant_properties ORDER BY property_id',
          )
        ).getRowObjects();
        expect(owners).toEqual([
          { property_id: 'property-a', owner_name: 'Restricted Fixture Owner' },
        ]);
      } finally {
        restricted.connection.closeSync();
        restricted.instance.closeSync();
      }

      await expect(buildPortableServingRelease(buildInput(firstRoot))).rejects.toBeInstanceOf(
        ImmutableReleaseExistsError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed on null/duplicate property IDs, type/schema drift, and public leakage', async () => {
    const cases: readonly Readonly<{
      name: string;
      rows: readonly ServingRow[];
      error: typeof RowGrainError | typeof ServingSchemaError;
    }>[] = [
      {
        name: 'null property ID',
        rows: [relationRow('property_query', { property_id: null })],
        error: ServingSchemaError,
      },
      {
        name: 'duplicate property ID',
        rows: [
          relationRow('property_query', { property_id: 'duplicate' }),
          relationRow('property_query', { property_id: 'duplicate' }),
        ],
        error: RowGrainError,
      },
      {
        name: 'type drift',
        rows: [relationRow('property_query', { property_id: 'property-a', latitude: 'north' })],
        error: ServingSchemaError,
      },
      {
        name: 'schema drift',
        rows: [
          withoutField(relationRow('property_query', { property_id: 'property-a' }), 'address_zip'),
        ],
        error: ServingSchemaError,
      },
    ];
    for (const testCase of cases) {
      const root = await mkdtemp(join(tmpdir(), 'oracle-serving-invalid-'));
      try {
        await expect(
          buildPortableServingRelease({
            ...buildInput(root),
            profiles: [{ visibility: 'public', relations: { property_query: testCase.rows } }],
          }),
          testCase.name,
        ).rejects.toBeInstanceOf(testCase.error);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

    const leakRoot = await mkdtemp(join(tmpdir(), 'oracle-serving-leak-'));
    try {
      await expect(
        buildPortableServingRelease({
          ...buildInput(leakRoot),
          profiles: [
            {
              visibility: 'public',
              relations: {
                canonical_history: [
                  relationRow('canonical_history', {
                    entity_id: 'property-a',
                    payload_json: '{"nested":{"ownerName":"must-not-publish"}}',
                  }),
                ],
              },
            },
          ],
        }),
      ).rejects.toBeInstanceOf(PublicArtifactPolicyError);
      await expect(
        buildPortableServingRelease({
          ...buildInput(join(leakRoot, 'relation')),
          profiles: [
            {
              visibility: 'public',
              relations: { elephant_properties: [relationRow('elephant_properties')] },
            },
          ],
        }),
      ).rejects.toBeInstanceOf(PublicArtifactPolicyError);
    } finally {
      await rm(leakRoot, { recursive: true, force: true });
    }
  });

  it('detects corruption plus type/order/schema/count and visibility metadata drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oracle-serving-verifier-'));
    try {
      const build = await buildPortableServingRelease(buildInput(root));
      const artifact = requiredArtifact(build.artifacts, 'public', 'property_query');

      await expect(
        verifyServingArtifacts(root, [{ ...artifact, rowCount: artifact.rowCount + 1 }]),
      ).rejects.toBeInstanceOf(ArtifactCountDriftError);
      await expect(
        verifyServingArtifacts(root, [{ ...artifact, columns: [...artifact.columns].reverse() }]),
      ).rejects.toBeInstanceOf(ArtifactSchemaDriftError);
      await expect(
        verifyServingArtifacts(root, [
          {
            ...artifact,
            nonNullCounts: { ...artifact.nonNullCounts, property_id: 0 },
          },
        ]),
      ).rejects.toBeInstanceOf(ArtifactCountDriftError);

      const restrictedArtifact = requiredArtifact(
        build.artifacts,
        'restricted',
        'elephant_properties',
      );
      await expect(
        verifyServingArtifacts(root, [
          {
            ...restrictedArtifact,
            visibility: 'public',
          },
        ]),
      ).rejects.toBeInstanceOf(ArtifactVisibilityError);

      const evidence = requiredArtifact(build.artifacts, 'public', 'property_evidence');
      const evidencePath = resolve(root, evidence.relativePath);
      const leakPath = resolve(root, 'public', 'property-evidence-leak.parquet');
      const leakWriter = await DuckDBInstance.create(':memory:', { threads: '1' });
      const leakConnection = await leakWriter.connect();
      try {
        await leakConnection.run(
          `COPY (SELECT * REPLACE ('{"ownerName":"must-not-publish"}' AS value_json) FROM read_parquet('${sqlPath(evidencePath)}')) TO '${sqlPath(leakPath)}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
        );
      } finally {
        leakConnection.closeSync();
        leakWriter.closeSync();
      }
      const leakedBytes = await readFile(leakPath);
      await writeFile(evidencePath, leakedBytes);
      await expect(
        verifyServingArtifacts(root, [
          {
            ...evidence,
            byteSize: leakedBytes.byteLength,
            sha256: sha256(leakedBytes),
          },
        ]),
      ).rejects.toBeInstanceOf(ArtifactVisibilityError);

      const path = resolve(root, artifact.relativePath);
      const original = await readFile(path);
      const corrupt = Buffer.from(original);
      const corruptIndex = Math.floor(corrupt.byteLength / 2);
      corrupt[corruptIndex] = (corrupt[corruptIndex] ?? 0) ^ 0xff;
      await writeFile(path, corrupt);
      await expect(verifyServingArtifacts(root, [artifact])).rejects.toBeInstanceOf(
        ArtifactCorruptionError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function buildInput(outputDirectory: string): PortableServingBuildInput {
  return {
    outputDirectory,
    releaseId: 'santa-clara-clean-room-v1',
    runId: 'run-clean-room-v1',
    generatedAt: INSTANT,
    sourceIds: ['source-b', 'source-a'],
    profiles: [
      {
        visibility: 'restricted',
        relations: {
          elephant_properties: [
            relationRow('elephant_properties', {
              property_id: 'property-a',
              parcel_identifier: '132-38-069',
              owner_name: 'Restricted Fixture Owner',
            }),
          ],
        },
      },
      {
        visibility: 'public',
        relations: {
          property_query: [
            relationRow('property_query', {
              property_id: 'property-b',
              parcel_identifier: '132-38-069',
            }),
            relationRow('property_query', {
              property_id: 'property-a',
              parcel_identifier: '132-38-069',
            }),
          ],
          property_evidence: [
            relationRow('property_evidence', {
              evidence_id: 'evidence-b',
              property_id: 'property-b',
            }),
            relationRow('property_evidence', {
              evidence_id: 'evidence-a',
              property_id: 'property-a',
            }),
          ],
        },
      },
    ],
  };
}

function relationRow(
  relation: ServingRelationName,
  overrides: Readonly<Record<string, ServingScalar>> = {},
): ServingRow {
  const definition = SERVING_RELATIONS[relation];
  return Object.fromEntries(
    definition.columns.map((column) => [
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
  if (type === 'DOUBLE') {
    return name === 'confidence' || name === 'ratio' || name === 'evidence_coverage' ? 1 : 1.5;
  }
  if (name.endsWith('_json')) return '[]';
  if (name.endsWith('_support_class') || name === 'support_class') return 'supported';
  if (name === 'visibility') return 'public';
  if (name.endsWith('_at') || name === 'as_of' || name === 'valid_from') return INSTANT;
  if (name.endsWith('sha256')) return SHA_A;
  return `${name}-fixture`;
}

function withoutField(row: ServingRow, field: string): ServingRow {
  return Object.fromEntries(Object.entries(row).filter(([name]) => name !== field));
}

function requiredArtifact(
  artifacts: readonly BuiltServingArtifact[],
  visibility: BuiltServingArtifact['visibility'],
  relation: BuiltServingArtifact['relation'],
): BuiltServingArtifact {
  const artifact = artifacts.find(
    (candidate) => candidate.visibility === visibility && candidate.relation === relation,
  );
  if (artifact === undefined) throw new Error(`Missing ${visibility}/${relation}`);
  return artifact;
}

function artifactSignatures(artifacts: readonly BuiltServingArtifact[]): readonly unknown[] {
  return artifacts.map(({ relativePath, rowCount, schemaSha256, sha256, byteSize }) => ({
    relativePath,
    rowCount,
    schemaSha256,
    sha256,
    byteSize,
  }));
}

function sqlPath(path: string): string {
  return path.replaceAll('\\', '/').replaceAll("'", "''");
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
