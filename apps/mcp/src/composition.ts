import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import {
  createProductionServingService,
  ProductionServingError,
  type ProductionServingConfig,
  type ProductionServingService,
} from '@oracle/query-core/serving/index';

import type { McpToolErrorCode } from './schemas.js';
import {
  NamedEvidenceServiceError,
  UnavailableNamedEvidenceService,
  type NamedEvidenceRequest,
  type NamedEvidenceService,
} from './service.js';
import { createLambdaMcpHandler } from './transport.js';

const REQUIRED_ENVIRONMENT = [
  'ORACLE_RELEASE_ROOT',
  'ORACLE_SERVING_CONFIG_RELATIVE_PATH',
  'ORACLE_CURSOR_HMAC_SECRET_BASE64',
] as const;

export type McpProductionEnvironment = Readonly<Record<string, string | undefined>>;
export type ProductionServingFactory = (
  config: ProductionServingConfig,
) => Promise<ProductionServingService>;
type LambdaHandler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;

export class ProductionCompositionError extends Error {
  public constructor() {
    super('The production MCP release configuration is incomplete or invalid.');
    this.name = 'ProductionCompositionError';
  }
}

class ProductionServingNamedEvidenceService implements NamedEvidenceService {
  public readonly kind = 'verified-immutable-release' as const;
  readonly #serving: ProductionServingService;

  public constructor(serving: ProductionServingService) {
    this.#serving = serving;
  }

  public async execute(request: NamedEvidenceRequest): Promise<unknown> {
    try {
      const result = await this.#serving.execute({
        operation: request.tool,
        input: toServingInput(request.input),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const release = this.#serving.release;
      if (
        result.schemaVersion !== release.schemaVersion ||
        result.releaseId !== release.releaseId ||
        result.runId !== release.runId ||
        result.manifestCid !== release.manifestCid ||
        result.asOf !== release.asOf
      ) {
        throw new NamedEvidenceServiceError(
          'SERVICE_UNAVAILABLE',
          'The verified immutable release returned inconsistent metadata.',
          releaseIdFrom(request.input),
        );
      }
      return result;
    } catch (error) {
      if (error instanceof NamedEvidenceServiceError) throw error;
      throw redactedServingError(error, releaseIdFrom(request.input));
    }
  }

  public validateCursor(request: {
    tool: NamedEvidenceRequest['tool'];
    releaseId: string;
    cursor: string;
  }): void {
    this.#serving.validateCursor({
      operation: request.tool,
      releaseId: request.releaseId,
      cursor: request.cursor,
    });
  }
}

export async function productionServingConfigFromEnvironment(
  environment: McpProductionEnvironment,
): Promise<ProductionServingConfig | null> {
  const present = REQUIRED_ENVIRONMENT.filter((name) => hasValue(environment[name]));
  if (present.length === 0) return null;
  if (present.length !== REQUIRED_ENVIRONMENT.length) throw new ProductionCompositionError();

  try {
    const cursorSecretText = required(environment, 'ORACLE_CURSOR_HMAC_SECRET_BASE64');
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(cursorSecretText) || cursorSecretText.length % 4 !== 0) {
      throw new ProductionCompositionError();
    }
    const cursorSecret = Buffer.from(cursorSecretText, 'base64');
    if (cursorSecret.toString('base64') !== cursorSecretText)
      throw new ProductionCompositionError();
    if (cursorSecret.byteLength < 32) throw new ProductionCompositionError();

    const releaseRoot = required(environment, 'ORACLE_RELEASE_ROOT');
    if (!isAbsolute(releaseRoot) || !(await stat(releaseRoot)).isDirectory()) {
      throw new ProductionCompositionError();
    }
    const configPath = resolvePackagedPath(
      releaseRoot,
      required(environment, 'ORACLE_SERVING_CONFIG_RELATIVE_PATH'),
    );
    const packaged = await readPackagedConfiguration(configPath);
    const rankingWeights = packaged.rankingWeights;
    const capabilities = packaged.capabilities;
    const limitations = packaged.limitations ?? [];
    if (!Array.isArray(rankingWeights) || !Array.isArray(limitations)) {
      throw new ProductionCompositionError();
    }
    if (typeof capabilities !== 'object' || capabilities === null || Array.isArray(capabilities)) {
      throw new ProductionCompositionError();
    }
    if (!limitations.every((value) => typeof value === 'string')) {
      throw new ProductionCompositionError();
    }
    resolvePackagedPath(releaseRoot, packaged.manifestRelativePath as string);

    return {
      releaseRoot: resolve(releaseRoot),
      manifestRelativePath: packaged.manifestRelativePath as string,
      expected: packaged.expected as ProductionServingConfig['expected'],
      cursorSecret: new Uint8Array(cursorSecret),
      rankingWeights: rankingWeights as ProductionServingConfig['rankingWeights'],
      capabilities: capabilities as ProductionServingConfig['capabilities'],
      limitations: Object.freeze([...limitations]),
    };
  } catch (error) {
    if (error instanceof ProductionCompositionError) throw error;
    throw new ProductionCompositionError();
  }
}

export async function createProductionNamedEvidenceService(
  environment: McpProductionEnvironment,
  factory: ProductionServingFactory = createProductionServingService,
): Promise<NamedEvidenceService> {
  try {
    const config = await productionServingConfigFromEnvironment(environment);
    if (config === null) return new UnavailableNamedEvidenceService();
    return new ProductionServingNamedEvidenceService(await factory(config));
  } catch {
    return new UnavailableNamedEvidenceService();
  }
}

export async function createProductionMcpHandler(
  environment: McpProductionEnvironment,
  factory: ProductionServingFactory = createProductionServingService,
): Promise<LambdaHandler> {
  const service = await createProductionNamedEvidenceService(environment, factory);
  return createLambdaMcpHandler(service, { deployment: 'production' });
}

function redactedServingError(
  error: unknown,
  requestedReleaseId?: string,
): NamedEvidenceServiceError {
  if (!(error instanceof ProductionServingError)) {
    return new NamedEvidenceServiceError(
      'INTERNAL_ERROR',
      'The immutable named-evidence request failed.',
      requestedReleaseId,
    );
  }
  const code = publicCode(error.code);
  return new NamedEvidenceServiceError(
    code,
    publicMessage(code),
    error.releaseId ?? requestedReleaseId,
  );
}

function publicCode(code: ProductionServingError['code']): McpToolErrorCode {
  switch (code) {
    case 'INVALID_REQUEST':
    case 'RELEASE_MISMATCH':
    case 'STALE_OR_TAMPERED_CURSOR':
    case 'RESULT_TOO_LARGE':
    case 'QUERY_BUDGET_EXCEEDED':
      return code;
    case 'RELEASE_INVALID':
      return 'SERVICE_UNAVAILABLE';
    case 'INTERNAL_QUERY_ERROR':
      return 'INTERNAL_ERROR';
  }
}

function publicMessage(code: McpToolErrorCode): string {
  switch (code) {
    case 'INVALID_REQUEST':
      return 'The request does not match the named operation contract.';
    case 'RELEASE_MISMATCH':
      return 'The immutable release does not match the request.';
    case 'STALE_OR_TAMPERED_CURSOR':
      return 'The cursor is invalid, stale, or belongs to another release or operation.';
    case 'RESULT_TOO_LARGE':
      return 'The named-evidence result exceeded its response budget.';
    case 'QUERY_BUDGET_EXCEEDED':
      return 'The named-evidence query exceeded its execution budget.';
    case 'RESTRICTED_EVIDENCE':
      return 'Restricted evidence is unavailable on this public MCP surface.';
    case 'SERVICE_UNAVAILABLE':
      return 'No verified immutable production release is configured.';
    case 'INTERNAL_ERROR':
      return 'The immutable named-evidence request failed.';
  }
}

function releaseIdFrom(input: Readonly<Record<string, unknown>>): string | undefined {
  return typeof input.releaseId === 'string' ? input.releaseId : undefined;
}

function hasValue(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function required(environment: McpProductionEnvironment, name: string): string {
  const value = environment[name];
  if (!hasValue(value)) throw new ProductionCompositionError();
  return value.trim();
}

function toServingInput(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (input.pageSize === undefined) return input;
  const { pageSize, ...rest } = input;
  return Object.freeze({ ...rest, limit: pageSize });
}

function resolvePackagedPath(root: string, relativePath: string): string {
  if (
    !isAbsolute(root) ||
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    relativePath.includes('\\') ||
    relativePath.split('/').includes('..')
  ) {
    throw new ProductionCompositionError();
  }
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, relativePath);
  const foldedRoot = resolvedRoot.toLowerCase();
  const foldedPath = resolvedPath.toLowerCase();
  if (
    foldedPath !== foldedRoot &&
    !foldedPath.startsWith(`${foldedRoot}\\`) &&
    !foldedPath.startsWith(`${foldedRoot}/`)
  ) {
    throw new ProductionCompositionError();
  }
  return resolvedPath;
}

async function readPackagedConfiguration(path: string): Promise<Readonly<Record<string, unknown>>> {
  if (!(await stat(path)).isFile()) throw new ProductionCompositionError();
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProductionCompositionError();
  }
  const record = parsed as Readonly<Record<string, unknown>>;
  const allowed = new Set([
    'manifestRelativePath',
    'expected',
    'rankingWeights',
    'capabilities',
    'limitations',
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new ProductionCompositionError();
  }
  if (
    typeof record.manifestRelativePath !== 'string' ||
    typeof record.expected !== 'object' ||
    record.expected === null ||
    Array.isArray(record.expected)
  ) {
    throw new ProductionCompositionError();
  }
  const expected = record.expected as Readonly<Record<string, unknown>>;
  const expectedKeys = [
    'releaseId',
    'runId',
    'manifestSha256',
    'manifestCid',
    'asOf',
    'schemaVersion',
    'policyVersion',
  ];
  if (
    Object.keys(expected).some((key) => !expectedKeys.includes(key)) ||
    expectedKeys.some((key) => typeof expected[key] !== 'string') ||
    !Array.isArray(record.rankingWeights) ||
    typeof record.capabilities !== 'object' ||
    record.capabilities === null ||
    Array.isArray(record.capabilities) ||
    (record.limitations !== undefined &&
      (!Array.isArray(record.limitations) ||
        !record.limitations.every((item) => typeof item === 'string' && item.trim().length > 0)))
  ) {
    throw new ProductionCompositionError();
  }
  return record;
}
