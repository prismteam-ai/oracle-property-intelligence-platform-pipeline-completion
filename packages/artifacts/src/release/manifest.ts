import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export type ReleaseVisibility = 'public' | 'restricted';

export type ReleaseColumn = Readonly<{
  name: string;
  duckdbType: 'VARCHAR' | 'BOOLEAN' | 'BIGINT' | 'DOUBLE';
  nullable: boolean;
  description: string;
}>;

export type ReleaseArtifactInput = Readonly<{
  relation: string;
  relativePath: string;
  visibility: ReleaseVisibility;
  mediaType: string;
  byteSize: number;
  sha256: string;
  rowCount: number;
  schemaSha256: string;
  columns: readonly ReleaseColumn[];
  nonNullCounts: Readonly<Record<string, number>>;
}>;

export type PortableReleaseManifestPayload = Readonly<{
  contractVersion: '1.0.0';
  releaseId: string;
  runId: string;
  county: 'Santa Clara';
  state: 'CA';
  generatedAt: string;
  duckdbVersion: string;
  sourceIds: readonly string[];
  artifacts: readonly ReleaseArtifactInput[];
}>;

export type PortableReleaseManifest = PortableReleaseManifestPayload &
  Readonly<{ manifestSha256: string }>;

export type PortableReleaseManifestInput = Omit<
  PortableReleaseManifestPayload,
  'contractVersion' | 'county' | 'state'
>;

export function createPortableReleaseManifest(
  input: PortableReleaseManifestInput,
): PortableReleaseManifest {
  validateManifestInput(input);
  const payload: PortableReleaseManifestPayload = Object.freeze({
    contractVersion: '1.0.0',
    releaseId: input.releaseId,
    runId: input.runId,
    county: 'Santa Clara',
    state: 'CA',
    generatedAt: input.generatedAt,
    duckdbVersion: input.duckdbVersion,
    sourceIds: Object.freeze([...new Set(input.sourceIds)].sort()),
    artifacts: Object.freeze(
      input.artifacts
        .map((artifact) =>
          Object.freeze({
            ...artifact,
            columns: Object.freeze(artifact.columns.map((column) => Object.freeze({ ...column }))),
            nonNullCounts: Object.freeze(sortRecord(artifact.nonNullCounts)),
          }),
        )
        .sort(
          (left, right) =>
            left.visibility.localeCompare(right.visibility) ||
            left.relation.localeCompare(right.relation),
        ),
    ),
  });
  const manifestSha256 = sha256(Buffer.from(`${stableJson(payload)}\n`));
  return Object.freeze({ ...payload, manifestSha256 });
}

export function serializePortableReleaseManifest(manifest: PortableReleaseManifest): Uint8Array {
  verifyPortableReleaseManifest(manifest);
  return Buffer.from(`${stableJson(manifest)}\n`);
}

export async function writePortableReleaseManifest(
  path: string,
  manifest: PortableReleaseManifest,
): Promise<void> {
  const bytes = serializePortableReleaseManifest(manifest);
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, bytes, { flag: 'wx' });
}

export async function readPortableReleaseManifest(path: string): Promise<PortableReleaseManifest> {
  const value = JSON.parse(await readFile(path, 'utf8')) as PortableReleaseManifest;
  verifyPortableReleaseManifest(value);
  return value;
}

export function verifyPortableReleaseManifest(manifest: PortableReleaseManifest): void {
  const { manifestSha256, ...payload } = manifest;
  assertSha256(manifestSha256, 'manifestSha256');
  validateManifestInput(payload);
  const actual = sha256(Buffer.from(`${stableJson(payload)}\n`));
  if (manifestSha256 !== actual) {
    throw new ReleaseManifestIntegrityError(
      `Manifest hash mismatch: expected ${manifestSha256}, calculated ${actual}`,
    );
  }
}

function validateManifestInput(
  input: PortableReleaseManifestInput | Omit<PortableReleaseManifest, 'manifestSha256'>,
): void {
  for (const [label, value] of [
    ['releaseId', input.releaseId],
    ['runId', input.runId],
    ['duckdbVersion', input.duckdbVersion],
  ] as const) {
    if (value.trim().length === 0) throw new TypeError(`${label} is required`);
  }
  assertInstant(input.generatedAt, 'generatedAt');
  if (input.sourceIds.length === 0) throw new TypeError('sourceIds cannot be empty');
  if (input.artifacts.length === 0) throw new TypeError('artifacts cannot be empty');
  const identities = new Set<string>();
  for (const artifact of input.artifacts) {
    const identity = `${artifact.visibility}/${artifact.relation}`;
    if (identities.has(identity)) throw new TypeError(`Duplicate release artifact: ${identity}`);
    identities.add(identity);
    if (!/^[a-z][a-z0-9_]*$/u.test(artifact.relation)) {
      throw new TypeError(`Invalid relation name: ${artifact.relation}`);
    }
    if (
      artifact.relativePath.startsWith('/') ||
      artifact.relativePath.includes('..') ||
      artifact.relativePath.includes('\\')
    ) {
      throw new TypeError(`Artifact path must be portable and relative: ${artifact.relativePath}`);
    }
    if (!Number.isSafeInteger(artifact.byteSize) || artifact.byteSize <= 0) {
      throw new TypeError(`${identity} byteSize must be positive`);
    }
    if (!Number.isSafeInteger(artifact.rowCount) || artifact.rowCount < 0) {
      throw new TypeError(`${identity} rowCount must be non-negative`);
    }
    assertSha256(artifact.sha256, `${identity} sha256`);
    assertSha256(artifact.schemaSha256, `${identity} schemaSha256`);
    const columnNames = artifact.columns.map(({ name }) => name);
    if (columnNames.length === 0 || new Set(columnNames).size !== columnNames.length) {
      throw new TypeError(`${identity} columns must be non-empty and unique`);
    }
    if (
      JSON.stringify(Object.keys(artifact.nonNullCounts).sort()) !==
      JSON.stringify([...columnNames].sort())
    ) {
      throw new TypeError(`${identity} nonNullCounts do not match its columns`);
    }
    for (const [name, count] of Object.entries(artifact.nonNullCounts)) {
      if (!Number.isSafeInteger(count) || count < 0 || count > artifact.rowCount) {
        throw new TypeError(`${identity}.${name} has an invalid non-null count`);
      }
    }
  }
}

function assertInstant(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value)) || !/[zZ]|[+-]\d\d:\d\d$/u.test(value)) {
    throw new TypeError(`${label} must be an offset-qualified ISO-8601 timestamp`);
  }
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${label} must be lowercase SHA-256`);
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

function sortRecord<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class ReleaseManifestIntegrityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReleaseManifestIntegrityError';
  }
}
