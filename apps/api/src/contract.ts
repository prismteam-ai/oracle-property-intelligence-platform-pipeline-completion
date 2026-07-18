export const API_SCHEMA_VERSION = '1.0.0';

export const API_LIMITS = Object.freeze({
  requestBytes: 16 * 1024,
  responseBytes: 1024 * 1024,
  cursorBytes: 512,
  defaultPageSize: 25,
  maximumPageSize: 100,
  queryTimeoutMs: 5_000,
  agentTimeoutMs: 30_000,
  maximumScanBytes: 512 * 1024 * 1024,
  maximumAgentPromptCharacters: 2_000,
});

export const applicationOperations = [
  'dataset.getInfo',
  'dataset.getCoverage',
  'pipeline.listRuns',
  'pipeline.getRun',
  'property.search',
  'property.get',
  'property.getEvidence',
  'inquiry.roofAge',
  'inquiry.waterCandidates',
  'inquiry.ownershipAge',
  'inquiry.regionalOwner',
  'inquiry.transitWalkability',
  'inquiry.starbucksWalkability',
  'inquiry.rankCandidates',
  'artifacts.list',
  'artifacts.getDataDictionary',
  'agent.ask',
  'agent.status',
] as const;

export type ApplicationOperation = (typeof applicationOperations)[number];

export const queryOperationByApplicationOperation = Object.freeze({
  'dataset.getInfo': 'get_dataset_info',
  'dataset.getCoverage': 'get_dataset_coverage',
  'pipeline.listRuns': 'list_pipeline_runs',
  'pipeline.getRun': 'get_pipeline_run',
  'property.search': 'search_properties',
  'property.get': 'get_property',
  'property.getEvidence': 'get_property_evidence',
  'inquiry.roofAge': 'find_roof_age_candidates',
  'inquiry.waterCandidates': 'find_water_view_candidates',
  'inquiry.ownershipAge': 'find_ownership_age_candidates',
  'inquiry.regionalOwner': 'find_regional_owner_properties',
  'inquiry.transitWalkability': 'find_transit_walkable_properties',
  'inquiry.starbucksWalkability': 'find_starbucks_walkable_properties',
  'inquiry.rankCandidates': 'rank_review_candidates',
  'artifacts.list': 'list_artifacts',
  'artifacts.getDataDictionary': 'get_data_dictionary',
} as const);

export type QueryApplicationOperation = keyof typeof queryOperationByApplicationOperation;

export type ParsedRequest = Readonly<{
  releaseId: string | null;
  parameters: Readonly<Record<string, unknown>>;
  cursor: string | null;
  limit: number;
}>;

export class InputContractError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InputContractError';
  }
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InputContractError('Request body must be a JSON object.');
  }
  return value as Readonly<Record<string, unknown>>;
}

function exact(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra !== undefined) throw new InputContractError(`Unknown input field: ${extra}`);
}

function optionalString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  maximum: number,
): string | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > maximum) {
    throw new InputContractError(
      `${key} must be a non-empty string of at most ${maximum} characters.`,
    );
  }
  return candidate;
}

function requiredString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  maximum: number,
): string {
  const candidate = optionalString(value, key, maximum);
  if (candidate === undefined) throw new InputContractError(`${key} is required.`);
  return candidate;
}

function optionalSearchQuery(value: Readonly<Record<string, unknown>>): string | undefined {
  const candidate = value.query;
  if (candidate === undefined) return undefined;
  if (typeof candidate !== 'string') {
    throw new InputContractError('query must be a string containing 3 to 200 UTF-8 bytes.');
  }
  const normalized = candidate.trim();
  const bytes = Buffer.byteLength(normalized, 'utf8');
  if (bytes < 3 || bytes > 200 || containsControlCharacter(normalized)) {
    throw new InputContractError('query must be a string containing 3 to 200 UTF-8 bytes.');
  }
  return normalized;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

function optionalBoolean(
  value: Readonly<Record<string, unknown>>,
  key: string,
): boolean | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== 'boolean') throw new InputContractError(`${key} must be a boolean.`);
  return candidate;
}

function optionalNumber(
  value: Readonly<Record<string, unknown>>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (
    typeof candidate !== 'number' ||
    !Number.isFinite(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw new InputContractError(`${key} must be a number between ${minimum} and ${maximum}.`);
  }
  return candidate;
}

function optionalInteger(
  value: Readonly<Record<string, unknown>>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const candidate = optionalNumber(value, key, minimum, maximum);
  if (candidate !== undefined && !Number.isInteger(candidate)) {
    throw new InputContractError(`${key} must be an integer.`);
  }
  return candidate;
}

function optionalEnum<T extends string>(
  value: Readonly<Record<string, unknown>>,
  key: string,
  choices: readonly T[],
): T | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== 'string' || !choices.includes(candidate as T)) {
    throw new InputContractError(`${key} must be one of: ${choices.join(', ')}.`);
  }
  return candidate as T;
}

function optionalStringArray<T extends string>(
  value: Readonly<Record<string, unknown>>,
  key: string,
  choices: readonly T[],
  maximumItems: number,
): readonly T[] | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (
    !Array.isArray(candidate) ||
    candidate.length === 0 ||
    candidate.length > maximumItems ||
    !candidate.every((item) => typeof item === 'string' && choices.includes(item as T)) ||
    new Set(candidate).size !== candidate.length
  ) {
    throw new InputContractError(`${key} must contain 1 to ${maximumItems} unique allowed values.`);
  }
  return Object.freeze(candidate.map((item) => item as T));
}

function optionalIsoDate(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const candidate = optionalString(value, key, 10);
  if (candidate !== undefined) {
    const timestamp = Date.parse(`${candidate}T00:00:00.000Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(candidate) ||
      Number.isNaN(timestamp) ||
      new Date(timestamp).toISOString().slice(0, 10) !== candidate
    ) {
      throw new InputContractError(`${key} must be a real calendar date using YYYY-MM-DD.`);
    }
  }
  return candidate;
}

const releaseKeys = ['releaseId'] as const;
const pageKeys = ['limit', 'cursor'] as const;
const filterKeys = ['city', 'postalCode', 'propertyId'] as const;

function common(
  value: Readonly<Record<string, unknown>>,
  requireRelease: boolean,
): Pick<ParsedRequest, 'releaseId' | 'cursor' | 'limit'> {
  const releaseId = requireRelease
    ? requiredString(value, 'releaseId', 160)
    : (optionalString(value, 'releaseId', 160) ?? null);
  const cursor = optionalString(value, 'cursor', API_LIMITS.cursorBytes) ?? null;
  const limit =
    optionalInteger(value, 'limit', 1, API_LIMITS.maximumPageSize) ?? API_LIMITS.defaultPageSize;
  return { releaseId, cursor, limit };
}

function filters(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...(optionalString(value, 'city', 100) === undefined
      ? {}
      : { city: optionalString(value, 'city', 100) }),
    ...(optionalString(value, 'postalCode', 10) === undefined
      ? {}
      : { postalCode: optionalString(value, 'postalCode', 10) }),
    ...(optionalString(value, 'propertyId', 256) === undefined
      ? {}
      : { propertyId: optionalString(value, 'propertyId', 256) }),
  });
}

function parsed(
  value: Readonly<Record<string, unknown>>,
  parameters: Readonly<Record<string, unknown>>,
  requireRelease = true,
): ParsedRequest {
  return Object.freeze({ ...common(value, requireRelease), parameters: Object.freeze(parameters) });
}

export function parseApplicationRequest(
  operation: ApplicationOperation,
  input: unknown,
): ParsedRequest {
  const value = object(input);
  switch (operation) {
    case 'dataset.getInfo':
      exact(value, []);
      return parsed(value, {}, false);
    case 'dataset.getCoverage':
    case 'agent.status':
      exact(value, releaseKeys);
      return parsed(value, {});
    case 'artifacts.getDataDictionary':
      exact(value, [...releaseKeys, ...pageKeys]);
      return parsed(value, {});
    case 'pipeline.listRuns':
    case 'artifacts.list': {
      const keys =
        operation === 'artifacts.list'
          ? [...releaseKeys, ...pageKeys, 'artifactType']
          : [...releaseKeys, ...pageKeys];
      exact(value, keys);
      const artifactType =
        operation === 'artifacts.list'
          ? optionalEnum(value, 'artifactType', [
              'query_mart',
              'coverage',
              'evidence',
              'manifest',
              'per_property_json',
              'car',
            ] as const)
          : undefined;
      return parsed(value, artifactType === undefined ? {} : { artifactType });
    }
    case 'pipeline.getRun':
      exact(value, [...releaseKeys, 'runId']);
      return parsed(value, { runId: requiredString(value, 'runId', 256) });
    case 'property.search': {
      exact(value, [...releaseKeys, ...pageKeys, ...filterKeys, 'query', 'sort']);
      const query = optionalSearchQuery(value);
      const sort = optionalEnum(value, 'sort', [
        'property_id',
        'address',
        'parcel_identifier',
      ] as const);
      return parsed(value, {
        ...filters(value),
        ...(query === undefined ? {} : { query }),
        ...(sort === undefined ? {} : { sort }),
      });
    }
    case 'property.get':
      exact(value, [...releaseKeys, 'propertyId']);
      return parsed(value, { propertyId: requiredString(value, 'propertyId', 256) });
    case 'property.getEvidence':
      exact(value, [...releaseKeys, ...pageKeys, 'propertyId', 'feature']);
      return parsed(value, {
        propertyId: requiredString(value, 'propertyId', 256),
        ...(optionalEnum(value, 'feature', [
          'roof_age',
          'water_view_candidate',
          'ownership_age',
          'regional_owner',
          'transit_walkability',
          'starbucks_walkability',
        ] as const) === undefined
          ? {}
          : {
              feature: optionalEnum(value, 'feature', [
                'roof_age',
                'water_view_candidate',
                'ownership_age',
                'regional_owner',
                'transit_walkability',
                'starbucks_walkability',
              ] as const),
            }),
      });
    case 'inquiry.roofAge':
      exact(value, [
        ...releaseKeys,
        ...pageKeys,
        ...filterKeys,
        'minimumAgeYears',
        'includeProxy',
        'asOf',
      ]);
      return parsed(value, {
        ...filters(value),
        minimumAgeYears: optionalInteger(value, 'minimumAgeYears', 1, 200) ?? 15,
        includeProxy: optionalBoolean(value, 'includeProxy') ?? false,
        ...(optionalIsoDate(value, 'asOf') === undefined
          ? {}
          : { asOf: optionalIsoDate(value, 'asOf') }),
      });
    case 'inquiry.waterCandidates':
      exact(value, [
        ...releaseKeys,
        ...pageKeys,
        ...filterKeys,
        'maximumDistanceMeters',
        'minimumTerrainConfidence',
        'waterFeatureTypes',
        'includeProxy',
      ]);
      return parsed(value, {
        ...filters(value),
        maximumDistanceMeters: optionalInteger(value, 'maximumDistanceMeters', 1, 50_000) ?? 5_000,
        minimumTerrainConfidence: optionalNumber(value, 'minimumTerrainConfidence', 0, 1) ?? 0.5,
        waterFeatureTypes: optionalStringArray(
          value,
          'waterFeatureTypes',
          ['ocean', 'bay', 'reservoir', 'lake', 'river', 'stream', 'canal'] as const,
          7,
        ) ?? ['ocean', 'bay', 'reservoir', 'lake', 'river', 'stream', 'canal'],
        includeProxy: optionalBoolean(value, 'includeProxy') ?? false,
      });
    case 'inquiry.ownershipAge':
      exact(value, [
        ...releaseKeys,
        ...pageKeys,
        ...filterKeys,
        'minimumTenureYears',
        'requireCompleteCoverage',
      ]);
      return parsed(value, {
        ...filters(value),
        minimumTenureYears: optionalInteger(value, 'minimumTenureYears', 1, 200) ?? 10,
        requireCompleteCoverage: optionalBoolean(value, 'requireCompleteCoverage') ?? true,
      });
    case 'inquiry.regionalOwner':
      exact(value, [...releaseKeys, ...pageKeys, ...filterKeys, 'policyId']);
      return parsed(value, {
        ...filters(value),
        policyId:
          optionalEnum(value, 'policyId', ['bay-area-nine-counties-v1'] as const) ??
          'bay-area-nine-counties-v1',
      });
    case 'inquiry.transitWalkability':
      exact(value, [
        ...releaseKeys,
        ...pageKeys,
        ...filterKeys,
        'maximumNetworkDistanceMeters',
        'maximumSnapDistanceMeters',
        'serviceDate',
        'transitMode',
        'agency',
        'route',
        'includeProxy',
      ]);
      return parsed(value, {
        ...filters(value),
        maximumNetworkDistanceMeters:
          optionalInteger(value, 'maximumNetworkDistanceMeters', 1, 10_000) ?? 800,
        maximumSnapDistanceMeters:
          optionalInteger(value, 'maximumSnapDistanceMeters', 1, 2_000) ?? 200,
        ...(optionalIsoDate(value, 'serviceDate') === undefined
          ? {}
          : { serviceDate: optionalIsoDate(value, 'serviceDate') }),
        ...(optionalEnum(value, 'transitMode', ['bus', 'rail', 'tram', 'subway'] as const) ===
        undefined
          ? {}
          : {
              transitMode: optionalEnum(value, 'transitMode', [
                'bus',
                'rail',
                'tram',
                'subway',
              ] as const),
            }),
        ...(optionalString(value, 'agency', 100) === undefined
          ? {}
          : { agency: optionalString(value, 'agency', 100) }),
        ...(optionalString(value, 'route', 100) === undefined
          ? {}
          : { route: optionalString(value, 'route', 100) }),
        includeProxy: optionalBoolean(value, 'includeProxy') ?? false,
      });
    case 'inquiry.starbucksWalkability':
      exact(value, [
        ...releaseKeys,
        ...pageKeys,
        ...filterKeys,
        'maximumNetworkDistanceMeters',
        'maximumSnapDistanceMeters',
        'minimumValidationConfidence',
        'includeProxy',
      ]);
      return parsed(value, {
        ...filters(value),
        maximumNetworkDistanceMeters:
          optionalInteger(value, 'maximumNetworkDistanceMeters', 1, 10_000) ?? 800,
        maximumSnapDistanceMeters:
          optionalInteger(value, 'maximumSnapDistanceMeters', 1, 2_000) ?? 200,
        minimumValidationConfidence:
          optionalNumber(value, 'minimumValidationConfidence', 0, 1) ?? 0.7,
        includeProxy: optionalBoolean(value, 'includeProxy') ?? false,
      });
    case 'inquiry.rankCandidates': {
      exact(value, [
        ...releaseKeys,
        ...pageKeys,
        ...filterKeys,
        'signals',
        'weights',
        'includeProxy',
        'minimumEvidenceCoverage',
      ]);
      const signals = optionalStringArray(
        value,
        'signals',
        [
          'roof_age',
          'water_view_candidate',
          'ownership_age',
          'regional_owner',
          'transit_walkability',
          'starbucks_walkability',
        ] as const,
        6,
      ) ?? ['roof_age', 'ownership_age', 'transit_walkability'];
      const weightsValue = value.weights === undefined ? {} : object(value.weights);
      exact(weightsValue, [
        'roof_age',
        'water_view_candidate',
        'ownership_age',
        'regional_owner',
        'transit_walkability',
        'starbucks_walkability',
      ]);
      const weights = Object.fromEntries(
        signals.map((signal) => [signal, optionalNumber(weightsValue, signal, 0, 100) ?? 1]),
      );
      return parsed(value, {
        ...filters(value),
        signals,
        weights,
        includeProxy: optionalBoolean(value, 'includeProxy') ?? false,
        minimumEvidenceCoverage: optionalNumber(value, 'minimumEvidenceCoverage', 0, 1) ?? 0.5,
      });
    }
    case 'agent.ask':
      exact(value, [...releaseKeys, 'prompt']);
      return parsed(value, {
        prompt: requiredString(value, 'prompt', API_LIMITS.maximumAgentPromptCharacters),
      });
  }
}

export function isApplicationOperation(value: string): value is ApplicationOperation {
  return (applicationOperations as readonly string[]).includes(value);
}
