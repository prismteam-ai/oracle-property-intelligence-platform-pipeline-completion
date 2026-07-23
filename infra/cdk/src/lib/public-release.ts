import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  type Dirent,
  type Stats,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const REQUIRED_PUBLIC_RELATIONS = Object.freeze({
  property_query: Object.freeze({
    fileName: 'property-query.parquet',
    grain: 'exactly one row per property_id',
    schemaSha256: '1777bd6cd41a50ef103e462955fafbf9c8ec98025ea99f1ddd2f533359a4bbfa',
  }),
  property_evidence: Object.freeze({
    fileName: 'property-evidence.parquet',
    grain: 'one row per immutable evidence_id',
    schemaSha256: 'df58028d7225b271fbf618ed33302c6a58e0eece72c8eb92a14de0c45cbfefed',
  }),
  source_coverage: Object.freeze({
    fileName: 'source-coverage.parquet',
    grain: 'one row per source and measured scope',
    schemaSha256: 'a0d269a3800eed76c1faec1e16f264b2c8ab9ba3794cdf6811ca87d048d62aef',
  }),
  field_coverage: Object.freeze({
    fileName: 'field-coverage.parquet',
    grain: 'one row per relation and field',
    schemaSha256: '0921849241395eb9797eb30ee38d0fdd3ab9025fb24d1a5c3da3beb059043613',
  }),
  relation_coverage: Object.freeze({
    fileName: 'relation-coverage.parquet',
    grain: 'one row per relationship type',
    schemaSha256: '7ddd90a3a771a79445e0f3213e6699efe62982f0d03a4c2feba4615a084de389',
  }),
  pipeline_runs: Object.freeze({
    fileName: 'pipeline-runs.parquet',
    grain: 'one row per immutable pipeline run',
    schemaSha256: '00c9bff133ff790233a8f66cf7e90b5066db54e01403b1d399efab3828d99a6e',
  }),
  data_dictionary: Object.freeze({
    fileName: 'data-dictionary.parquet',
    grain: 'one row per released relation column',
    schemaSha256: '94a89caff14e8927d2b85d5d804327a3973d79a19685b732adbc33f40744b893',
  }),
});

const REQUIRED_CRITERIA = Object.freeze([
  'roof_age',
  'water_view_candidate',
  'ownership_age',
  'regional_owner',
  'transit_walkability',
  'starbucks_walkability',
]);
const SHA256 = /^[a-f0-9]{64}$/u;
const PROHIBITED_PUBLIC_COLUMN =
  /(^|_)(owner_name|owners_text|mailing_address|grantor|grantee|email|phone|contact)(_|$)/iu;
const PROHIBITED_PATH_SEGMENT =
  /(^|[._-])(credential|credentials|secret|secrets|token|tokens|password|private[-_]?key|access[-_]?key)([._-]|$)/iu;
const PROHIBITED_JSON_KEY =
  /(^|[_ -])(owner[_ -]?name|owners[_ -]?text|mailing[_ -]?address|grantor|grantee|email|phone|contact|credential|secret|token|password|private[_ -]?key|access[_ -]?key)([_ -]|$)/iu;

type JsonObject = Readonly<Record<string, unknown>>;

type ManifestArtifact = Readonly<{
  relation: string;
  relativePath: string;
  visibility: 'public' | 'restricted';
  mediaType: string;
  byteSize: number;
  sha256: string;
  rowCount: number;
  schemaSha256: string;
  columns: readonly Readonly<{ name: string; duckdbType: string; nullable: boolean }>[];
  nonNullCounts: Readonly<Record<string, number>>;
  grain: string;
}>;

export type VerifiedPublicRelease = Readonly<{
  directory: string;
  repositoryRelativeDirectory: string;
  servingConfigRelativePath: string;
}>;

export type PublicReleaseValidationOptions = Readonly<{
  repositoryRoot: string;
  releaseDirectory: string | undefined;
  servingConfigRelativePath: string | undefined;
  allowTestFixture?: boolean;
}>;

export function validatePublicReleaseBundle(
  options: PublicReleaseValidationOptions,
): VerifiedPublicRelease {
  const repositoryRoot = realDirectory(options.repositoryRoot, 'Repository root');
  if (options.releaseDirectory === undefined || options.releaseDirectory.trim().length === 0) {
    throw new Error('A caller-selected Oracle public release directory is required.');
  }
  if (
    options.servingConfigRelativePath === undefined ||
    options.servingConfigRelativePath.trim().length === 0
  ) {
    throw new Error('The Oracle serving configuration relative path is required.');
  }

  const requestedDirectory = isAbsolute(options.releaseDirectory)
    ? resolve(options.releaseDirectory)
    : resolve(repositoryRoot, options.releaseDirectory);
  let requestedEntry: Stats;
  try {
    requestedEntry = lstatSync(requestedDirectory);
  } catch {
    throw new Error('Oracle public release directory does not exist.');
  }
  if (requestedEntry.isSymbolicLink()) {
    throw new Error(`Symlinks are prohibited in release bundles: ${requestedDirectory}`);
  }
  const releaseDirectory = realDirectory(requestedDirectory, 'Oracle public release directory');
  const repositoryRelativeDirectory = portableRelative(repositoryRoot, releaseDirectory);
  if (repositoryRelativeDirectory.length === 0 || repositoryRelativeDirectory.startsWith('../')) {
    throw new Error('The Oracle public release directory must be a child of the repository root.');
  }
  if (
    repositoryRelativeDirectory.startsWith('infra/cdk/test-fixtures/') &&
    options.allowTestFixture !== true
  ) {
    throw new Error('CDK test fixtures cannot be selected as a production Oracle release.');
  }

  rejectSymlinks(releaseDirectory);
  const configRelativePath = portablePath(
    options.servingConfigRelativePath,
    'Oracle serving configuration path',
  );
  const configPath = resolveInside(releaseDirectory, configRelativePath);
  const config = jsonObject(readJson(configPath, 'Oracle serving configuration'));
  exactKeys(
    config,
    ['manifestRelativePath', 'expected', 'rankingWeights', 'capabilities', 'limitations'],
    'Oracle serving configuration',
  );
  const manifestRelativePath = requiredString(config.manifestRelativePath, 'manifestRelativePath');
  const manifestPath = resolveInside(
    releaseDirectory,
    portablePath(manifestRelativePath, 'Oracle release manifest path'),
  );
  const manifest = jsonObject(readJson(manifestPath, 'Oracle release manifest'));
  verifyManifest(manifest);
  verifyServingConfig(config, manifest);

  const artifacts = manifest.artifacts as readonly ManifestArtifact[];
  const allowedFiles = new Set([configPath, manifestPath]);
  const publicArtifacts = new Map<string, ManifestArtifact>();
  for (const artifact of artifacts) {
    if (artifact.visibility === 'restricted') {
      const restrictedPath = resolveInside(releaseDirectory, artifact.relativePath);
      if (existsFile(restrictedPath)) {
        throw new Error(`Restricted artifact bytes are prohibited: ${artifact.relativePath}`);
      }
      continue;
    }
    if (!Object.hasOwn(REQUIRED_PUBLIC_RELATIONS, artifact.relation)) {
      throw new Error(`Unsupported public relation in release: ${artifact.relation}`);
    }
    const contract =
      REQUIRED_PUBLIC_RELATIONS[artifact.relation as keyof typeof REQUIRED_PUBLIC_RELATIONS];
    if (publicArtifacts.has(artifact.relation)) {
      throw new Error(`Duplicate public relation in release: ${artifact.relation}`);
    }
    if (
      artifact.relativePath !== `public/${contract.fileName}` ||
      artifact.grain !== contract.grain ||
      artifact.schemaSha256 !== contract.schemaSha256
    ) {
      throw new Error(`Public relation contract drift: ${artifact.relation}`);
    }
    if (
      artifact.columns.some(({ name }) => PROHIBITED_PUBLIC_COLUMN.test(name)) ||
      artifact.columns.length === 0 ||
      new Set(artifact.columns.map(({ name }) => name)).size !== artifact.columns.length
    ) {
      throw new Error(`Public relation schema is unsafe or malformed: ${artifact.relation}`);
    }
    const artifactPath = resolveInside(releaseDirectory, artifact.relativePath);
    verifyFile(artifactPath, artifact.relativePath, artifact.byteSize, artifact.sha256);
    allowedFiles.add(artifactPath);
    publicArtifacts.set(artifact.relation, artifact);
  }

  const missingRelations = Object.keys(REQUIRED_PUBLIC_RELATIONS).filter(
    (relation) => !publicArtifacts.has(relation),
  );
  if (missingRelations.length > 0) {
    throw new Error(`Oracle public release is missing relations: ${missingRelations.join(', ')}`);
  }
  verifyClosure(releaseDirectory, allowedFiles);

  return Object.freeze({
    directory: releaseDirectory,
    repositoryRelativeDirectory,
    servingConfigRelativePath: configRelativePath,
  });
}

function verifyManifest(manifest: JsonObject): void {
  exactKeys(
    manifest,
    [
      'contractVersion',
      'releaseId',
      'runId',
      'county',
      'state',
      'generatedAt',
      'duckdbVersion',
      'sourceIds',
      'artifacts',
      'manifestSha256',
    ],
    'Oracle release manifest',
  );
  if (
    manifest.contractVersion !== '1.0.0' ||
    manifest.county !== 'Santa Clara' ||
    manifest.state !== 'CA' ||
    manifest.duckdbVersion !== 'v1.4.5'
  ) {
    throw new Error('Oracle release identity or DuckDB version is invalid.');
  }
  requiredString(manifest.releaseId, 'releaseId');
  requiredString(manifest.runId, 'runId');
  instant(manifest.generatedAt, 'generatedAt');
  const sourceIds = stringArray(manifest.sourceIds, 'sourceIds');
  if (sourceIds.length === 0 || new Set(sourceIds).size !== sourceIds.length) {
    throw new Error('Oracle release sourceIds must be non-empty and unique.');
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error('Oracle release artifacts must be a non-empty array.');
  }
  for (const value of manifest.artifacts) validateArtifact(jsonObject(value));

  const manifestSha256 = requiredString(manifest.manifestSha256, 'manifestSha256');
  if (!SHA256.test(manifestSha256)) throw new Error('Manifest SHA-256 is malformed.');
  const { manifestSha256: ignored, ...payload } = manifest;
  void ignored;
  const actual = sha256(Buffer.from(`${stableJson(payload)}\n`));
  if (actual !== manifestSha256) throw new Error('Oracle release manifest hash mismatch.');
}

function validateArtifact(value: JsonObject): void {
  exactKeys(
    value,
    [
      'relation',
      'relativePath',
      'visibility',
      'mediaType',
      'byteSize',
      'sha256',
      'rowCount',
      'schemaSha256',
      'columns',
      'nonNullCounts',
      'grain',
      'sourceLineage',
      'limitations',
    ],
    'Oracle release artifact',
  );
  requiredString(value.relation, 'artifact relation');
  const relativePath = portablePath(
    requiredString(value.relativePath, 'artifact relativePath'),
    'artifact relativePath',
  );
  if (value.visibility !== 'public' && value.visibility !== 'restricted') {
    throw new Error(`Artifact visibility is invalid: ${relativePath}`);
  }
  if (value.mediaType !== 'application/vnd.apache.parquet') {
    throw new Error(`Artifact media type is invalid: ${relativePath}`);
  }
  positiveInteger(value.byteSize, `${relativePath} byteSize`);
  nonNegativeInteger(value.rowCount, `${relativePath} rowCount`);
  for (const [label, hash] of [
    ['sha256', value.sha256],
    ['schemaSha256', value.schemaSha256],
  ] as const) {
    if (typeof hash !== 'string' || !SHA256.test(hash)) {
      throw new Error(`${relativePath} ${label} is malformed.`);
    }
  }
  requiredString(value.grain, `${relativePath} grain`);
  if (!Array.isArray(value.columns) || value.columns.length === 0) {
    throw new Error(`${relativePath} columns are malformed.`);
  }
  const columns = value.columns.map((column) => jsonObject(column));
  const names = columns.map((column) => requiredString(column.name, `${relativePath} column`));
  const nonNullCounts = jsonObject(value.nonNullCounts);
  if (stableJson(Object.keys(nonNullCounts).sort()) !== stableJson([...names].sort())) {
    throw new Error(`${relativePath} non-null counts do not match its columns.`);
  }
  const rowCount = value.rowCount as number;
  for (const [name, count] of Object.entries(nonNullCounts)) {
    nonNegativeInteger(count, `${relativePath}.${name} non-null count`);
    if ((count as number) > rowCount) throw new Error(`${relativePath}.${name} exceeds row count.`);
  }
  if (!Array.isArray(value.sourceLineage) || value.sourceLineage.length === 0) {
    throw new Error(`${relativePath} source lineage is required.`);
  }
  stringArray(value.limitations, `${relativePath} limitations`);
}

function verifyServingConfig(config: JsonObject, manifest: JsonObject): void {
  const expected = jsonObject(config.expected);
  exactKeys(
    expected,
    [
      'releaseId',
      'runId',
      'manifestSha256',
      'manifestCid',
      'asOf',
      'schemaVersion',
      'policyVersion',
    ],
    'Oracle expected release',
  );
  for (const [expectedKey, manifestKey] of [
    ['releaseId', 'releaseId'],
    ['runId', 'runId'],
    ['manifestSha256', 'manifestSha256'],
    ['asOf', 'generatedAt'],
  ] as const) {
    if (expected[expectedKey] !== manifest[manifestKey]) {
      throw new Error(`Serving configuration ${expectedKey} does not match the manifest.`);
    }
  }
  requiredString(expected.manifestCid, 'manifestCid');
  if (expected.schemaVersion !== '1.0.0') throw new Error('Serving schema version is invalid.');
  requiredString(expected.policyVersion, 'policyVersion');

  if (!Array.isArray(config.rankingWeights) || config.rankingWeights.length !== 6) {
    throw new Error('Serving rankingWeights must cover the six frozen criteria.');
  }
  const rankingCriteria = config.rankingWeights.map((value) => {
    const weight = jsonObject(value);
    exactKeys(weight, ['criterion', 'weight', 'proxyMultiplier'], 'Serving ranking weight');
    finiteNumber(weight.weight, 'ranking weight');
    finiteNumber(weight.proxyMultiplier, 'ranking proxy multiplier');
    return requiredString(weight.criterion, 'ranking criterion');
  });
  if (stableJson([...rankingCriteria].sort()) !== stableJson([...REQUIRED_CRITERIA].sort())) {
    throw new Error('Serving rankingWeights do not cover the frozen criteria exactly.');
  }

  const capabilities = jsonObject(config.capabilities);
  if (stableJson(Object.keys(capabilities).sort()) !== stableJson([...REQUIRED_CRITERIA].sort())) {
    throw new Error('Serving capabilities do not cover the frozen criteria exactly.');
  }
  for (const [criterion, raw] of Object.entries(capabilities)) {
    const capability = jsonObject(raw);
    exactKeys(
      capability,
      ['state', 'supportClasses', 'numerator', 'denominator', 'limitations'],
      `${criterion} capability`,
    );
    if (!['supported', 'partial', 'blocked'].includes(String(capability.state))) {
      throw new Error(`${criterion} capability state is invalid.`);
    }
    const supportClasses = stringArray(capability.supportClasses, `${criterion} supportClasses`);
    if (
      supportClasses.length === 0 ||
      supportClasses.some(
        (value) => !['supported', 'proxy', 'unknown', 'unsupported'].includes(value),
      )
    ) {
      throw new Error(`${criterion} support classes are invalid.`);
    }
    nonNegativeInteger(capability.numerator, `${criterion} numerator`);
    nonNegativeInteger(capability.denominator, `${criterion} denominator`);
    if ((capability.numerator as number) > (capability.denominator as number)) {
      throw new Error(`${criterion} numerator exceeds its denominator.`);
    }
    stringArray(capability.limitations, `${criterion} limitations`);
  }
  if (config.limitations !== undefined) stringArray(config.limitations, 'Serving limitations');
  rejectSensitiveJson(config, 'serving configuration');
}

function verifyFile(path: string, label: string, byteSize: number, expectedSha256: string): void {
  if (!statSync(path).isFile()) throw new Error(`Release artifact is not a file: ${label}`);
  const bytes = readFileSync(path);
  if (bytes.byteLength !== byteSize || sha256(bytes) !== expectedSha256) {
    throw new Error(`Release artifact integrity check failed: ${label}`);
  }
  if (
    bytes.byteLength < 8 ||
    bytes.subarray(0, 4).toString('ascii') !== 'PAR1' ||
    bytes.subarray(-4).toString('ascii') !== 'PAR1'
  ) {
    throw new Error(`Release artifact is not bounded Parquet: ${label}`);
  }
}

function verifyClosure(root: string, allowedFiles: ReadonlySet<string>): void {
  for (const file of walk(root)) {
    const relativePath = portableRelative(root, file);
    if (!allowedFiles.has(file)) throw new Error(`Unexpected release file: ${relativePath}`);
    for (const segment of relativePath.split('/')) {
      if (segment === '.config' || PROHIBITED_PATH_SEGMENT.test(segment)) {
        throw new Error(`Credential-like release path is prohibited: ${relativePath}`);
      }
    }
  }
}

function rejectSensitiveJson(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectSensitiveJson(item, label);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (PROHIBITED_JSON_KEY.test(key))
      throw new Error(`Sensitive field is prohibited in ${label}.`);
    rejectSensitiveJson(item, label);
  }
}

function rejectSymlinks(root: string): void {
  const visit = (path: string): void => {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink())
      throw new Error(`Symlinks are prohibited in release bundles: ${path}`);
    if (!entry.isDirectory()) return;
    for (const child of readdirSync(path, { withFileTypes: true }))
      visit(resolve(path, child.name));
  };
  visit(root);
}

function walk(root: string): readonly string[] {
  const files: string[] = [];
  const visit = (directory: string, entries: readonly Dirent[]): void => {
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path, readdirSync(path, { withFileTypes: true }));
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Unsupported release filesystem entry: ${path}`);
    }
  };
  visit(root, readdirSync(root, { withFileTypes: true }));
  return files;
}

function realDirectory(path: string, label: string): string {
  let real: string;
  try {
    real = realpathSync(resolve(path));
  } catch {
    throw new Error(`${label} does not exist.`);
  }
  if (!statSync(real).isDirectory()) throw new Error(`${label} must be a directory.`);
  return real;
}

function portableRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function portablePath(path: string, label: string): string {
  const trimmed = path.trim();
  if (
    trimmed.length === 0 ||
    isAbsolute(trimmed) ||
    trimmed.includes('\\') ||
    trimmed
      .split('/')
      .some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(`${label} must be a portable relative path.`);
  }
  return trimmed;
}

function resolveInside(root: string, portable: string): string {
  const path = resolve(root, portable);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new Error('Release path escapes the selected directory.');
  }
  return path;
}

function readJson(path: string, label: string): unknown {
  if (!statSync(path).isFile()) throw new Error(`${label} must be a file.`);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
}

function jsonObject(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object in the Oracle public release.');
  }
  return value as JsonObject;
}

function exactKeys(value: JsonObject, keys: readonly string[], label: string): void {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(`${label} fields are malformed.`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.trim().length === 0)
  ) {
    throw new Error(`${label} must contain only non-empty strings.`);
  }
  return value as readonly string[];
}

function instant(value: unknown, label: string): void {
  const text = requiredString(value, label);
  if (!Number.isFinite(Date.parse(text)) || !/[zZ]|[+-]\d\d:\d\d$/u.test(text)) {
    throw new Error(`${label} must be an offset-qualified ISO-8601 timestamp.`);
  }
}

function positiveInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function nonNegativeInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}

function finiteNumber(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be finite.`);
  }
}

function existsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
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
