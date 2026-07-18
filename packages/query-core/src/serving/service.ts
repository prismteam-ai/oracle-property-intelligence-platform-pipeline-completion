import { pathToFileURL } from 'node:url';

import type { NamedQueryName } from '@oracle/contracts/query';
import type { AnalyticalRow, AnalyticalSession } from '@oracle/data-runtime/analytical-runtime';
import {
  QueryTimeoutError,
  ScanBudgetExceededError,
  ScanBudgetUnavailableError,
} from '@oracle/data-runtime/duckdb/duckdb-analytical-runtime';

import type {
  CombinedRankingInput,
  InquiryResponse,
  OwnershipAgeInput,
  RegionalOwnerInput,
  RoofAgeInput,
  WalkabilityInput,
  WaterViewInput,
} from '../inquiries/contracts.js';
import { NamedInquiryExecutor } from '../inquiries/executor.js';
import {
  PROPERTY_SEARCH_EXTENDED_INPUT_FIELDS,
  PROPERTY_SEARCH_SORTS,
  REGIONAL_OWNER_POLICY_ID,
  ProductionServingError,
  type PropertySearchSort,
  type ProductionServingConfig,
  type ProductionServingEnvelope,
  type ProductionServingRelease,
  type ProductionServingRequest,
  type ProductionServingService,
} from './contracts.js';
import { ProductionCursorCodec } from './cursor.js';
import { fixedGeneralQuery, SERVING_PAGE_SIZE_MAXIMUM, type GeneralPlanName } from './plans.js';
import { loadProductionRelease, type LoadedProductionRelease } from './release.js';

const RESPONSE_BYTES_MAXIMUM = 1024 * 1024;
const DISCOVERY_OPERATION: NamedQueryName = 'get_dataset_info';
const featureNames = Object.freeze([
  'roof_age',
  'water_view_candidate',
  'ownership_age',
  'regional_owner',
  'transit_walkability',
  'starbucks_walkability',
  'combined_review_score',
] as const);
const propertySearchPlanBySort = Object.freeze({
  property_id: 'search_properties_by_property_id',
  address: 'search_properties_by_address',
  parcel_identifier: 'search_properties_by_parcel_identifier',
} as const satisfies Readonly<Record<PropertySearchSort, GeneralPlanName>>);

export async function createProductionServingService(
  config: ProductionServingConfig,
): Promise<ProductionServingService> {
  const loaded = await loadProductionRelease(config);
  return new VerifiedProductionServingService(loaded, config.cursorSecret);
}

class VerifiedProductionServingService implements ProductionServingService {
  public readonly release: ProductionServingRelease;
  readonly #loaded: LoadedProductionRelease;
  readonly #cursor: ProductionCursorCodec;
  readonly #inquiries: NamedInquiryExecutor;

  public constructor(loaded: LoadedProductionRelease, cursorSecret: Uint8Array) {
    this.#loaded = loaded;
    this.#cursor = new ProductionCursorCodec(cursorSecret);
    this.#inquiries = new NamedInquiryExecutor(loaded.inquiryRelease, cursorSecret);
    this.release = Object.freeze({
      schemaVersion: loaded.inquiryRelease.schemaVersion,
      releaseId: loaded.manifest.releaseId,
      runId: loaded.manifest.runId,
      manifestCid: loaded.inquiryRelease.manifestCid,
      manifestSha256: loaded.manifest.manifestSha256,
      asOf: loaded.inquiryRelease.asOf,
      policyVersion: loaded.inquiryRelease.policyVersion,
      county: 'Santa Clara',
      state: 'CA',
      immutable: true,
      verified: true,
    });
  }

  public validateCursor(
    request: Readonly<{
      operation: NamedQueryName;
      releaseId: string;
      cursor: string;
    }>,
  ): void {
    this.#cursor.validate(request.operation, request.releaseId, request.cursor);
  }

  public async execute(request: ProductionServingRequest): Promise<ProductionServingEnvelope> {
    try {
      const input = strictObject(request.input, 'Operation input');
      if (request.operation !== DISCOVERY_OPERATION) this.#assertRelease(input.releaseId);
      const session = await this.#loaded.runtime.open(
        {
          releaseId: this.release.releaseId,
          manifestUri: pathToFileURL(this.#loaded.manifestPath).href,
          manifestSha256: this.#loaded.manifestFileSha256,
        },
        request.signal,
      );
      try {
        return await this.#executeWithSession(request.operation, input, session, request.signal);
      } finally {
        await session[Symbol.asyncDispose]();
      }
    } catch (error) {
      if (error instanceof ProductionServingError) throw error;
      if (
        error instanceof QueryTimeoutError ||
        error instanceof ScanBudgetExceededError ||
        error instanceof ScanBudgetUnavailableError
      ) {
        throw new ProductionServingError(
          'QUERY_BUDGET_EXCEEDED',
          'The named query exceeded its immutable execution budget.',
          { releaseId: this.release.releaseId, cause: error },
        );
      }
      if (error instanceof TypeError || error instanceof RangeError) {
        throw new ProductionServingError('INVALID_REQUEST', error.message, {
          releaseId: this.release.releaseId,
          cause: error,
        });
      }
      throw new ProductionServingError(
        'INTERNAL_QUERY_ERROR',
        'The immutable named query failed without exposing internal details.',
        { releaseId: this.release.releaseId, cause: error },
      );
    }
  }

  async #executeWithSession(
    operation: NamedQueryName,
    input: Readonly<Record<string, unknown>>,
    session: AnalyticalSession,
    signal?: AbortSignal,
  ): Promise<ProductionServingEnvelope> {
    switch (operation) {
      case 'get_dataset_info':
        return this.#datasetInfo(input, session, signal);
      case 'get_dataset_coverage':
        return this.#datasetCoverage(input, session, signal);
      case 'list_pipeline_runs':
        return this.#listPipelineRuns(input, session, signal);
      case 'get_pipeline_run':
        return this.#getPipelineRun(input, session, signal);
      case 'search_properties':
        return this.#searchProperties(input, session, signal);
      case 'get_property':
        return this.#getProperty(input, session, signal);
      case 'get_property_evidence':
        return this.#getPropertyEvidence(input, session, signal);
      case 'find_roof_age_candidates':
        return this.#inquiry(operation, this.#roofInput(input), session, signal);
      case 'find_water_view_candidates':
        return this.#inquiry(operation, this.#waterInput(input), session, signal);
      case 'find_ownership_age_candidates':
        return this.#inquiry(operation, this.#ownershipInput(input), session, signal);
      case 'find_regional_owner_properties':
        return this.#inquiry(operation, this.#regionalOwnerInput(input), session, signal);
      case 'find_transit_walkable_properties':
        return this.#inquiry(operation, this.#walkabilityInput(input, 'transit'), session, signal);
      case 'find_starbucks_walkable_properties':
        return this.#inquiry(
          operation,
          this.#walkabilityInput(input, 'starbucks'),
          session,
          signal,
        );
      case 'rank_review_candidates':
        return this.#inquiry(operation, this.#rankingInput(input), session, signal);
      case 'list_artifacts':
        return this.#listArtifacts(input, session, signal);
      case 'get_data_dictionary':
        return this.#dataDictionary(input, session, signal);
    }
  }

  async #datasetInfo(
    input: Readonly<Record<string, unknown>>,
    session: AnalyticalSession,
    signal?: AbortSignal,
  ): Promise<ProductionServingEnvelope> {
    exactKeys(input, []);
    const result = await session.execute(
      withSignal(fixedGeneralQuery('get_dataset_info', [], 1), signal),
    );
    const summary = requiredSingleRow(result.rows, 'dataset info');
    return this.#envelope({
      coverage: this.#capabilityCoverage(),
      data: {
        release: this.release,
        propertyCount: safeNumber(summary.property_count, 'property count'),
        sourceCount: safeNumber(summary.source_count, 'source count'),
        pipelineRunCount: safeNumber(summary.pipeline_run_count, 'pipeline run count'),
        latestRunId: nullableText(summary.latest_run_id, 'latest run ID'),
        latestRunStatus: nullableText(summary.latest_run_status, 'latest run status'),
        artifactCount: this.#loaded.manifest.artifacts.filter(
          ({ visibility }) => visibility === 'public',
        ).length,
        sourceIds: this.#loaded.manifest.sourceIds,
        duckdbVersion: this.#loaded.manifest.duckdbVersion,
      },
      limitations: this.#loaded.limitations,
      nextCursor: null,
      truncated: result.truncated,
      elapsedMs: result.elapsedMs,
      bytesScanned: requiredScannedBytes(result.scannedBytes),
    });
  }

  async #datasetCoverage(
    input: Readonly<Record<string, unknown>>,
    session: AnalyticalSession,
    signal?: AbortSignal,
  ): Promise<ProductionServingEnvelope> {
    exactKeys(input, ['releaseId']);
    const [sources, fields, relationships] = await Promise.all([
      session.execute(
        withSignal(
          fixedGeneralQuery('get_dataset_coverage_source', [SERVING_PAGE_SIZE_MAXIMUM + 1]),
          signal,
        ),
      ),
      session.execute(
        withSignal(
          fixedGeneralQuery('get_dataset_coverage_field', [SERVING_PAGE_SIZE_MAXIMUM + 1]),
          signal,
        ),
      ),
      session.execute(
        withSignal(
          fixedGeneralQuery('get_dataset_coverage_relation', [SERVING_PAGE_SIZE_MAXIMUM + 1]),
          signal,
        ),
      ),
    ] as const);
    const truncated = [sources, fields, relationships].some(
      (result) => result.rows.length > SERVING_PAGE_SIZE_MAXIMUM || result.truncated,
    );
    const rows = [sources, fields, relationships].map((result) =>
      normalizeRows(result.rows.slice(0, SERVING_PAGE_SIZE_MAXIMUM)),
    );
    return this.#envelope({
      coverage: this.#capabilityCoverage(),
      data: { sources: rows[0], fields: rows[1], relationships: rows[2] },
      limitations: mergeLimitations(this.#loaded.limitations, ...rows.flat()),
      nextCursor: null,
      truncated,
      elapsedMs: sources.elapsedMs + fields.elapsedMs + relationships.elapsedMs,
      bytesScanned:
        requiredScannedBytes(sources.scannedBytes) +
        requiredScannedBytes(fields.scannedBytes) +
        requiredScannedBytes(relationships.scannedBytes),
    });
  }

  async #listPipelineRuns(
    input: Readonly<Record<string, unknown>>,
    session: AnalyticalSession,
    signal?: AbortSignal,
  ): Promise<ProductionServingEnvelope> {
    exactKeys(input, ['releaseId', 'limit', 'cursor']);
    const page = pageInput(input);
    const fingerprint = this.#cursor.fingerprint({ limit: page.limit });
    let afterStartedAt: string | null = null;
    let afterRunId: string | null = null;
    if (page.cursor !== null) {
      const keys = this.#cursor.decode(page.cursor, {
        operation: 'list_pipeline_runs',
        releaseId: this.release.releaseId,
        queryFingerprint: fingerprint,
      });
      if (keys.length !== 2 || typeof keys[0] !== 'string' || typeof keys[1] !== 'string') {
        throw new ProductionServingError('STALE_OR_TAMPERED_CURSOR', 'Invalid run cursor.');
      }
      [afterStartedAt, afterRunId] = keys;
    }
    const result = await session.execute(
      withSignal(
        fixedGeneralQuery('list_pipeline_runs', [
          afterStartedAt,
          afterStartedAt,
          afterStartedAt,
          afterRunId,
          page.limit + 1,
        ]),
        signal,
      ),
    );
    const rows = normalizeRows(result.rows.slice(0, page.limit));
    const hasMore = result.rows.length > page.limit;
    const last = rows.at(-1);
    return this.#envelope({
      coverage: this.#capabilityCoverage(),
      data: { runs: rows },
      limitations: mergeLimitations(this.#loaded.limitations, ...rows),
      nextCursor:
        hasMore && last !== undefined
          ? this.#cursor.encode({
              operation: 'list_pipeline_runs',
              releaseId: this.release.releaseId,
              queryFingerprint: fingerprint,
              keys: [
                requiredText(last.started_at, 'started_at'),
                requiredText(last.run_id, 'run_id'),
              ],
            })
          : null,
      truncated: hasMore || result.truncated,
      elapsedMs: result.elapsedMs,
      bytesScanned: requiredScannedBytes(result.scannedBytes),
    });
  }

  async #getPipelineRun(
    input: Readonly<Record<string, unknown>>,
    session: AnalyticalSession,
    signal?: AbortSignal,
  ): Promise<ProductionServingEnvelope> {
    exactKeys(input, ['releaseId', 'runId']);
    const runId = boundedText(input.runId, 'runId', 256);
    const result = await session.execute(
      withSignal(fixedGeneralQuery('get_pipeline_run', [runId], 2), signal),
    );
    if (result.rows.length > 1) throw releaseInvalid('Pipeline-run grain drift detected.');
    const rows = normalizeRows(result.rows);
    return this.#envelope({
      coverage: this.#capabilityCoverage(),
      data: { run: rows[0] ?? null },
      limitations: mergeLimitations(this.#loaded.limitations, ...rows),
      nextCursor: null,
      truncated: false,
      elapsedMs: result.elapsedMs,
      bytesScanned: requiredScannedBytes(result.scannedBytes),
    });
  }

  async #searchProperties(
    input: Readonly<Record<string, unknown>>,
    session: AnalyticalSession,
    signal?: AbortSignal,
  ): Promise<ProductionServingEnvelope> {
    exactKeys(input, PROPERTY_SEARCH_EXTENDED_INPUT_FIELDS);
    const page = pageInput(input);
    const normalized = {
      city: optionalText(input.city, 'city', 100),
      postalCode: optionalText(input.postalCode, 'postalCode', 20),
      propertyId: optionalText(input.propertyId, 'propertyId', 256),
      parcelIdentifier: optionalText(input.parcelIdentifier, 'parcelIdentifier', 64),
      query: optionalSearchQuery(input.query),
      sort: optionalEnum(input.sort, 'sort', PROPERTY_SEARCH_SORTS) ?? 'property_id',
      limit: page.limit,
    };
    const fingerprint = this.#cursor.fingerprint(normalized);
    let afterSortValue: string | null = null;
    let afterPropertyId: string | null = null;
    if (page.cursor !== null) {
      const keys = this.#cursor.decode(page.cursor, {
        operation: 'search_properties',
        releaseId: this.release.releaseId,
        queryFingerprint: fingerprint,
      });
      const validPropertyIdCursor =
        normalized.sort === 'property_id' && keys.length === 1 && typeof keys[0] === 'string';
      const validCompositeCursor =
        normalized.sort !== 'property_id' &&
        keys.length === 2 &&
        typeof keys[0] === 'string' &&
        typeof keys[1] === 'string';
      if (!validPropertyIdCursor && !validCompositeCursor) {
        throw new ProductionServingError('STALE_OR_TAMPERED_CURSOR', 'Invalid property cursor.');
      }
      if (normalized.sort === 'property_id') {
        afterPropertyId = keys[0] as string;
      } else {
        afterSortValue = keys[0] as string;
        afterPropertyId = keys[1] as string;
      }
    }
    const commonParameters = [
      normalized.city,
      normalized.city,
      normalized.postalCode,
      normalized.postalCode,
      normalized.propertyId,
      normalized.propertyId,
      normalized.parcelIdentifier,
      normalized.parcelIdentifier,
      normalized.query,
      normalized.query,
      normalized.query,
      normalized.query,
    ] as const;
    const keysetParameters =
      normalized.sort === 'property_id'
        ? [afterPropertyId, afterPropertyId]
        : [afterSortValue, afterSortValue, afterSortValue, afterPropertyId];
    const result = await session.execute(
      withSignal(
        fixedGeneralQuery(propertySearchPlanBySort[normalized.sort], [
          ...commonParameters,
          ...keysetParameters,
          page.limit + 1,
        ]),
        signal,
      ),
    );
    const rows = normalizeRows(result.rows.slice(0, page.limit));
    const hasMore = result.rows.length > page.limit;
    const last = rows.at(-1);
    return this.#envelope({
      coverage: this.#capabilityCoverage(),
      data: { properties: rows, resultCount: rows.length },
      limitations: this.#loaded.limitations,
      nextCursor:
        hasMore && last !== undefined
          ? this.#cursor.encode({
              operation: 'search_properties',
              releaseId: this.release.releaseId,
              queryFingerprint: fingerprint,
              keys:
                normalized.sort === 'property_id'
                  ? [requiredText(last.property_id, 'property_id')]
                  : [
                      coalescedText(
                        normalized.sort === 'address'
                          ? last.address_street
                          : last.parcel_identifier,
                        normalized.sort,
                      ),
                      requiredText(last.property_id, 'property_id'),
                    ],
            })
          : null,
      truncated: hasMore || result.truncated,
      elapsedMs: result.elapsedMs,
      bytesScanned: requiredScannedBytes(result.scannedBytes),
    });
  }

  async #getProperty(
    input: Readonly<Record<string, unknown>>,
    session: AnalyticalSession,
    signal?: AbortSignal,
  ): Promise<ProductionServingEnvelope> {
    exactKeys(input, ['releaseId', 'propertyId']);
    const propertyId = boundedText(input.propertyId, 'propertyId', 256);
    const result = await session.execute(
      withSignal(fixedGeneralQuery('get_property', [propertyId], 2), signal),
    );
    if (result.rows.length > 1) throw releaseInvalid('Property grain drift detected.');
    return this.#envelope({
      coverage: this.#capabilityCoverage(),
      data: { property: normalizeRows(result.rows)[0] ?? null },
      limitations: this.#loaded.limitations,
      nextCursor: null,
      truncated: false,
      elapsedMs: result.elapsedMs,
      bytesScanned: requiredScannedBytes(result.scannedBytes),
    });
  }

  async #getPropertyEvidence(
    input: Readonly<Record<string, unknown>>,
    session: AnalyticalSession,
    signal?: AbortSignal,
  ): Promise<ProductionServingEnvelope> {
    exactKeys(input, ['releaseId', 'propertyId', 'feature', 'limit', 'cursor']);
    const propertyId = boundedText(input.propertyId, 'propertyId', 256);
    const feature = optionalEnum(input.feature, 'feature', featureNames);
    const page = pageInput(input);
    const fingerprint = this.#cursor.fingerprint({ propertyId, feature, limit: page.limit });
    let afterEvidenceId: string | null = null;
    if (page.cursor !== null) {
      const keys = this.#cursor.decode(page.cursor, {
        operation: 'get_property_evidence',
        releaseId: this.release.releaseId,
        queryFingerprint: fingerprint,
      });
      if (keys.length !== 1 || typeof keys[0] !== 'string') {
        throw new ProductionServingError('STALE_OR_TAMPERED_CURSOR', 'Invalid evidence cursor.');
      }
      [afterEvidenceId] = keys;
    }
    const result = await session.execute(
      withSignal(
        fixedGeneralQuery('get_property_evidence', [
          propertyId,
          feature,
          feature,
          afterEvidenceId,
          afterEvidenceId,
          page.limit + 1,
        ]),
        signal,
      ),
    );
    const rows = normalizeRows(result.rows.slice(0, page.limit));
    const hasMore = result.rows.length > page.limit;
    const last = rows.at(-1);
    return this.#envelope({
      coverage: this.#capabilityCoverage(),
      data: { evidence: rows, resultCount: rows.length },
      limitations: mergeLimitations(this.#loaded.limitations, ...rows),
      nextCursor:
        hasMore && last !== undefined
          ? this.#cursor.encode({
              operation: 'get_property_evidence',
              releaseId: this.release.releaseId,
              queryFingerprint: fingerprint,
              keys: [requiredText(last.evidence_id, 'evidence_id')],
            })
          : null,
      truncated: hasMore || result.truncated,
      elapsedMs: result.elapsedMs,
      bytesScanned: requiredScannedBytes(result.scannedBytes),
    });
  }

  async #listArtifacts(
    input: Readonly<Record<string, unknown>>,
    session: AnalyticalSession,
    signal?: AbortSignal,
  ): Promise<ProductionServingEnvelope> {
    exactKeys(input, ['releaseId', 'publicationClass', 'limit', 'cursor']);
    if (input.publicationClass !== undefined && input.publicationClass !== 'public') {
      throw new ProductionServingError('INVALID_REQUEST', 'Only public artifacts are available.');
    }
    const page = pageInput(input);
    const fingerprint = this.#cursor.fingerprint({ publicationClass: 'public', limit: page.limit });
    let afterRelation: string | null = null;
    if (page.cursor !== null) {
      const keys = this.#cursor.decode(page.cursor, {
        operation: 'list_artifacts',
        releaseId: this.release.releaseId,
        queryFingerprint: fingerprint,
      });
      if (keys.length !== 1 || typeof keys[0] !== 'string') {
        throw new ProductionServingError('STALE_OR_TAMPERED_CURSOR', 'Invalid artifact cursor.');
      }
      [afterRelation] = keys;
    }
    const result = await session.execute(
      withSignal(
        fixedGeneralQuery('list_artifacts', [afterRelation, afterRelation, page.limit + 1]),
        signal,
      ),
    );
    const rows = normalizeRows(result.rows.slice(0, page.limit));
    const hasMore = result.rows.length > page.limit;
    const last = rows.at(-1);
    return this.#envelope({
      coverage: this.#capabilityCoverage(),
      data: { artifacts: rows, resultCount: rows.length },
      limitations: mergeLimitations(this.#loaded.limitations, ...rows),
      nextCursor:
        hasMore && last !== undefined
          ? this.#cursor.encode({
              operation: 'list_artifacts',
              releaseId: this.release.releaseId,
              queryFingerprint: fingerprint,
              keys: [requiredText(last.relation, 'relation')],
            })
          : null,
      truncated: hasMore || result.truncated,
      elapsedMs: result.elapsedMs,
      bytesScanned: requiredScannedBytes(result.scannedBytes),
    });
  }

  async #dataDictionary(
    input: Readonly<Record<string, unknown>>,
    session: AnalyticalSession,
    signal?: AbortSignal,
  ): Promise<ProductionServingEnvelope> {
    exactKeys(input, ['releaseId', 'entity', 'limit', 'cursor']);
    const entity = optionalEnum(input.entity, 'entity', [
      'property',
      'property_unit',
      'permit',
      'ownership',
      'contractor',
      'business',
      'transit_stop',
      'place',
      'hydro_feature',
    ] as const);
    const releasedRelation = entity === 'property' ? 'property_query' : entity;
    const page = pageInput(input);
    const fingerprint = this.#cursor.fingerprint({ entity, limit: page.limit });
    let afterRelation: string | null = null;
    let afterOrdinal: number | null = null;
    if (page.cursor !== null) {
      const keys = this.#cursor.decode(page.cursor, {
        operation: 'get_data_dictionary',
        releaseId: this.release.releaseId,
        queryFingerprint: fingerprint,
      });
      if (keys.length !== 2 || typeof keys[0] !== 'string' || typeof keys[1] !== 'number') {
        throw new ProductionServingError('STALE_OR_TAMPERED_CURSOR', 'Invalid dictionary cursor.');
      }
      [afterRelation, afterOrdinal] = keys;
    }
    const result = await session.execute(
      withSignal(
        fixedGeneralQuery('get_data_dictionary', [
          releasedRelation,
          releasedRelation,
          afterRelation,
          afterRelation,
          afterRelation,
          afterOrdinal,
          page.limit + 1,
        ]),
        signal,
      ),
    );
    const rows = normalizeRows(result.rows.slice(0, page.limit));
    const hasMore = result.rows.length > page.limit;
    const last = rows.at(-1);
    return this.#envelope({
      coverage: this.#capabilityCoverage(),
      data: { fields: rows, resultCount: rows.length },
      limitations: this.#loaded.limitations,
      nextCursor:
        hasMore && last !== undefined
          ? this.#cursor.encode({
              operation: 'get_data_dictionary',
              releaseId: this.release.releaseId,
              queryFingerprint: fingerprint,
              keys: [
                requiredText(last.relation_name, 'relation_name'),
                safeNumber(last.ordinal, 'ordinal'),
              ],
            })
          : null,
      truncated: hasMore || result.truncated,
      elapsedMs: result.elapsedMs,
      bytesScanned: requiredScannedBytes(result.scannedBytes),
    });
  }

  async #inquiry(
    operation: NamedQueryName,
    input:
      | RoofAgeInput
      | WaterViewInput
      | OwnershipAgeInput
      | RegionalOwnerInput
      | WalkabilityInput
      | CombinedRankingInput,
    session: AnalyticalSession,
    signal?: AbortSignal,
  ): Promise<ProductionServingEnvelope> {
    const context = { session, ...(signal === undefined ? {} : { signal }) };
    let response: InquiryResponse<unknown>;
    switch (operation) {
      case 'find_roof_age_candidates':
        response = await this.#inquiries.roofAge(input, context);
        break;
      case 'find_water_view_candidates':
        response = await this.#inquiries.waterViewCandidates(input, context);
        break;
      case 'find_ownership_age_candidates':
        response = await this.#inquiries.ownershipAge(input, context);
        break;
      case 'find_regional_owner_properties':
        response = await this.#inquiries.regionalOwners(input, context);
        break;
      case 'find_transit_walkable_properties':
        response = await this.#inquiries.transitWalkability(input, context);
        break;
      case 'find_starbucks_walkable_properties':
        response = await this.#inquiries.starbucksWalkability(input, context);
        break;
      case 'rank_review_candidates':
        response = await this.#inquiries.combinedRanking(input, context);
        break;
      default:
        throw new ProductionServingError('INVALID_REQUEST', 'Operation is not an inquiry.');
    }
    const query =
      operation === 'find_regional_owner_properties'
        ? Object.freeze({
            ...response.query,
            parameters: Object.freeze({
              ...response.query.parameters,
              regionPolicyId: REGIONAL_OWNER_POLICY_ID,
            }),
          })
        : response.query;
    return this.#envelope({
      coverage: { [response.query.name]: response.capability },
      data: {
        query,
        capability: response.capability,
        results: response.results,
        resultCount: response.resultCount,
      },
      limitations: [...new Set([...this.#loaded.limitations, ...response.limitations])],
      nextCursor: response.nextCursor,
      truncated: response.truncated,
      elapsedMs: response.timing.elapsedMs,
      bytesScanned: requiredScannedBytes(response.timing.bytesScanned),
    });
  }

  #roofInput(input: Readonly<Record<string, unknown>>): RoofAgeInput {
    exactKeys(input, [
      'releaseId',
      'city',
      'postalCode',
      'propertyId',
      'minimumAgeYears',
      'asOf',
      'evidenceMode',
      'includeProxy',
      'limit',
      'cursor',
    ]);
    const mode =
      optionalEnum(input.evidenceMode, 'evidenceMode', [
        'explicit_completed_roof_work',
        'issued_roof_permit_proxy',
        'no_recent_roof_permit',
        'building_age_proxy',
      ] as const) ?? 'explicit_completed_roof_work';
    if (mode !== 'explicit_completed_roof_work') {
      throw new ProductionServingError(
        'INVALID_REQUEST',
        'Proxy classes are selected with includeProxy; individual proxy classes are not interchangeable.',
      );
    }
    return {
      ...commonInquiryInput(input),
      minimumAgeYears: optionalInteger(input.minimumAgeYears, 'minimumAgeYears', 1, 200) ?? 15,
      includeProxy: optionalBoolean(input.includeProxy, 'includeProxy') ?? false,
      ...(input.asOf === undefined ? {} : { asOf: immutableAsOf(input.asOf, this.release.asOf) }),
    };
  }

  #waterInput(input: Readonly<Record<string, unknown>>): WaterViewInput {
    exactKeys(input, [
      'releaseId',
      'city',
      'postalCode',
      'propertyId',
      'maximumWaterDistanceMeters',
      'minimumTerrainVisibilityConfidence',
      'waterFeatureTypes',
      'includeProxy',
      'limit',
      'cursor',
    ]);
    const confidence =
      optionalNumber(
        input.minimumTerrainVisibilityConfidence,
        'minimumTerrainVisibilityConfidence',
        0,
        1,
      ) ?? 0.5;
    if (confidence !== 0.5) unsupportedReleasedFilter('minimumTerrainVisibilityConfidence');
    if (input.waterFeatureTypes !== undefined) {
      const allowed = ['ocean', 'bay', 'reservoir', 'lake', 'river', 'stream', 'canal'] as const;
      const values = stringArray(input.waterFeatureTypes, 'waterFeatureTypes', allowed);
      if (values.length !== allowed.length || allowed.some((value) => !values.includes(value))) {
        unsupportedReleasedFilter('waterFeatureTypes');
      }
    }
    return {
      ...commonInquiryInput(input),
      maximumDistanceMeters:
        optionalInteger(
          input.maximumWaterDistanceMeters,
          'maximumWaterDistanceMeters',
          1,
          50_000,
        ) ?? 5_000,
      includeProxy: optionalBoolean(input.includeProxy, 'includeProxy') ?? false,
    };
  }

  #ownershipInput(input: Readonly<Record<string, unknown>>): OwnershipAgeInput {
    exactKeys(input, [
      'releaseId',
      'city',
      'postalCode',
      'propertyId',
      'minimumTenureYears',
      'requireCompleteHistory',
      'asOf',
      'limit',
      'cursor',
    ]);
    if (input.requireCompleteHistory !== undefined && input.requireCompleteHistory !== true) {
      throw new ProductionServingError(
        'INVALID_REQUEST',
        'Complete ownership history is required.',
      );
    }
    if (input.asOf !== undefined) immutableAsOf(input.asOf, this.release.asOf);
    return {
      ...commonInquiryInput(input),
      minimumTenureYears:
        optionalInteger(input.minimumTenureYears, 'minimumTenureYears', 1, 200) ?? 10,
    };
  }

  #regionalOwnerInput(input: Readonly<Record<string, unknown>>): RegionalOwnerInput {
    exactKeys(input, [
      'releaseId',
      'city',
      'postalCode',
      'propertyId',
      'regionPolicyId',
      'requireCurrentOwner',
      'limit',
      'cursor',
    ]);
    const policy =
      optionalText(input.regionPolicyId, 'regionPolicyId', 256) ?? REGIONAL_OWNER_POLICY_ID;
    if (policy !== REGIONAL_OWNER_POLICY_ID) {
      throw new ProductionServingError(
        'RELEASE_MISMATCH',
        'Region policy differs from the immutable inquiry policy.',
      );
    }
    if (input.requireCurrentOwner !== undefined && input.requireCurrentOwner !== true) {
      throw new ProductionServingError('INVALID_REQUEST', 'Current-owner evidence is required.');
    }
    return commonInquiryInput(input);
  }

  #walkabilityInput(
    input: Readonly<Record<string, unknown>>,
    kind: 'transit' | 'starbucks',
  ): WalkabilityInput {
    const extra =
      kind === 'transit' ? ['serviceDate', 'agencyId', 'routeId'] : ['minimumPlaceConfidence'];
    exactKeys(input, [
      'releaseId',
      'city',
      'postalCode',
      'propertyId',
      'maximumNetworkDistanceMeters',
      'maximumSnapDistanceMeters',
      'includeProxy',
      'limit',
      'cursor',
      ...extra,
    ]);
    const snap =
      optionalInteger(input.maximumSnapDistanceMeters, 'maximumSnapDistanceMeters', 1, 2_000) ??
      200;
    if (snap !== 200) unsupportedReleasedFilter('maximumSnapDistanceMeters');
    if (kind === 'transit') {
      if (input.serviceDate !== undefined) immutableAsOf(input.serviceDate, this.release.asOf);
      if (input.agencyId !== undefined) unsupportedReleasedFilter('agencyId');
      if (input.routeId !== undefined) unsupportedReleasedFilter('routeId');
    } else {
      const confidence =
        optionalNumber(input.minimumPlaceConfidence, 'minimumPlaceConfidence', 0, 1) ?? 0.7;
      if (confidence !== 0.7) unsupportedReleasedFilter('minimumPlaceConfidence');
    }
    return {
      ...commonInquiryInput(input),
      maximumNetworkDistanceMeters:
        optionalInteger(
          input.maximumNetworkDistanceMeters,
          'maximumNetworkDistanceMeters',
          1,
          10_000,
        ) ?? 800,
      includeProxy: optionalBoolean(input.includeProxy, 'includeProxy') ?? false,
    };
  }

  #rankingInput(input: Readonly<Record<string, unknown>>): CombinedRankingInput {
    exactKeys(input, [
      'releaseId',
      'city',
      'postalCode',
      'propertyId',
      'criteria',
      'weights',
      'includeProxy',
      'minimumEvidenceCoverage',
      'limit',
      'cursor',
    ]);
    const criteria = stringArray(input.criteria, 'criteria', [
      'roof_age',
      'water_view_candidate',
      'ownership_age',
      'regional_owner',
      'transit_walkability',
      'starbucks_walkability',
    ] as const);
    const weights =
      input.weights === undefined
        ? undefined
        : array(input.weights, 'weights').map((item, index) => {
            const record = strictObject(item, `weights[${index}]`);
            exactKeys(record, ['criterion', 'weight', 'proxyMultiplier']);
            return {
              criterion: requiredEnum(record.criterion, 'criterion', criteria),
              weight: requiredNumber(record.weight, 'weight', 0, 100),
              proxyMultiplier: requiredNumber(record.proxyMultiplier, 'proxyMultiplier', 0, 1),
            };
          });
    return {
      ...commonInquiryInput(input),
      criteria,
      ...(weights === undefined ? {} : { weights }),
      includeProxy: optionalBoolean(input.includeProxy, 'includeProxy') ?? false,
      minimumEvidenceCoverage:
        optionalNumber(input.minimumEvidenceCoverage, 'minimumEvidenceCoverage', 0, 1) ?? 0,
    };
  }

  #capabilityCoverage(): Readonly<Record<string, unknown>> {
    return this.#loaded.inquiryRelease.capabilities;
  }

  #assertRelease(value: unknown): void {
    if (typeof value !== 'string' || value !== this.release.releaseId) {
      throw new ProductionServingError(
        'RELEASE_MISMATCH',
        'The requested release does not match the configured immutable release.',
        typeof value === 'string' ? { releaseId: value } : {},
      );
    }
  }

  #envelope(
    input: Omit<
      ProductionServingEnvelope,
      'schemaVersion' | 'releaseId' | 'runId' | 'manifestCid' | 'asOf' | 'timing'
    > &
      Readonly<{ elapsedMs: number; bytesScanned: number }>,
  ): ProductionServingEnvelope {
    const envelope: ProductionServingEnvelope = Object.freeze({
      schemaVersion: this.release.schemaVersion,
      releaseId: this.release.releaseId,
      runId: this.release.runId,
      manifestCid: this.release.manifestCid,
      asOf: this.release.asOf,
      coverage: Object.freeze({ ...input.coverage }),
      limitations: Object.freeze([...input.limitations]),
      data: jsonSafe(input.data),
      nextCursor: input.nextCursor,
      truncated: input.truncated,
      timing: Object.freeze({ elapsedMs: input.elapsedMs, bytesScanned: input.bytesScanned }),
    });
    if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > RESPONSE_BYTES_MAXIMUM) {
      throw new ProductionServingError('RESULT_TOO_LARGE', 'Response exceeds 1 MiB.', {
        releaseId: this.release.releaseId,
      });
    }
    return envelope;
  }
}

function commonInquiryInput(input: Readonly<Record<string, unknown>>): Readonly<{
  releaseId: string;
  city?: string;
  postalCode?: string;
  propertyId?: string;
  limit: number;
  cursor?: string;
}> {
  const page = pageInput(input);
  const city = optionalText(input.city, 'city', 100);
  const postalCode = optionalText(input.postalCode, 'postalCode', 20);
  const propertyId = optionalText(input.propertyId, 'propertyId', 256);
  return {
    releaseId: boundedText(input.releaseId, 'releaseId', 256),
    ...(city === null ? {} : { city }),
    ...(postalCode === null ? {} : { postalCode }),
    ...(propertyId === null ? {} : { propertyId }),
    limit: page.limit,
    ...(page.cursor === null ? {} : { cursor: page.cursor }),
  };
}

function pageInput(
  input: Readonly<Record<string, unknown>>,
): Readonly<{ limit: number; cursor: string | null }> {
  return Object.freeze({
    limit: optionalInteger(input.limit, 'limit', 1, SERVING_PAGE_SIZE_MAXIMUM) ?? 50,
    cursor: optionalText(input.cursor, 'cursor', 512),
  });
}

function strictObject(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProductionServingError('INVALID_REQUEST', `${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) {
    throw new ProductionServingError('INVALID_REQUEST', `Unsupported input field: ${unexpected}.`);
  }
}

function optionalText(value: unknown, label: string, maximum: number): string | null {
  if (value === undefined || value === null) return null;
  return boundedText(value, label, maximum);
}

function optionalSearchQuery(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const normalized = boundedText(value, 'query', 200);
  if (Buffer.byteLength(normalized, 'utf8') < 3) {
    throw new ProductionServingError('INVALID_REQUEST', 'query is outside its allowed bounds.');
  }
  return normalized;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') {
    throw new ProductionServingError('INVALID_REQUEST', `${label} must be a string.`);
  }
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized, 'utf8') > maximum ||
    containsControlCharacter(normalized)
  ) {
    throw new ProductionServingError('INVALID_REQUEST', `${label} is outside its allowed bounds.`);
  }
  return normalized;
}

function nullableText(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requiredText(value, label);
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw releaseInvalid(`${label} is invalid.`);
  return value;
}

function coalescedText(value: unknown, label: string): string {
  if (value === null) return '';
  if (typeof value !== 'string') throw releaseInvalid(`${label} sort key is invalid.`);
  return value;
}

function optionalInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | null {
  if (value === undefined) return null;
  const result = requiredNumber(value, label, minimum, maximum);
  if (!Number.isInteger(result))
    throw new ProductionServingError('INVALID_REQUEST', `${label} must be an integer.`);
  return result;
}

function optionalNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | null {
  return value === undefined ? null : requiredNumber(value, label, minimum, maximum);
}

function requiredNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ProductionServingError('INVALID_REQUEST', `${label} is outside its allowed bounds.`);
  }
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | null {
  if (value === undefined) return null;
  if (typeof value !== 'boolean')
    throw new ProductionServingError('INVALID_REQUEST', `${label} must be boolean.`);
  return value;
}

function optionalEnum<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T | null {
  if (value === undefined) return null;
  return requiredEnum(value, label, allowed);
}

function requiredEnum<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ProductionServingError('INVALID_REQUEST', `${label} is invalid.`);
  }
  return value as T;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new ProductionServingError(
      'INVALID_REQUEST',
      `${label} must be a bounded non-empty array.`,
    );
  }
  return value;
}

function stringArray<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): readonly T[] {
  const values = array(value, label);
  if (!values.every((item) => typeof item === 'string' && allowed.includes(item as T))) {
    throw new ProductionServingError('INVALID_REQUEST', `${label} contains an unsupported value.`);
  }
  if (new Set(values).size !== values.length) {
    throw new ProductionServingError('INVALID_REQUEST', `${label} must contain unique values.`);
  }
  return Object.freeze(values as T[]);
}

function immutableAsOf(value: unknown, releaseAsOf: string): string {
  const date = boundedText(value, 'asOf', 64);
  if (date !== releaseAsOf && date !== releaseAsOf.slice(0, 10)) {
    throw new ProductionServingError(
      'RELEASE_MISMATCH',
      'asOf differs from the immutable release.',
    );
  }
  return releaseAsOf;
}

function unsupportedReleasedFilter(field: string): never {
  throw new ProductionServingError(
    'INVALID_REQUEST',
    `${field} is not a selectable dimension in this immutable release.`,
  );
}

function normalizeRows(
  rows: readonly AnalyticalRow[],
): readonly Readonly<Record<string, unknown>>[] {
  return Object.freeze(rows.map((row) => Object.freeze(normalizeRow(row))));
}

function normalizeRow(row: AnalyticalRow): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      key.endsWith('_json') && typeof value === 'string'
        ? parseReleasedJson(value, key)
        : jsonSafe(value),
    ]),
  );
}

function parseReleasedJson(value: string, label: string): unknown {
  try {
    return jsonSafe(JSON.parse(value) as unknown);
  } catch (error) {
    throw releaseInvalid(`${label} contains invalid JSON.`, error);
  }
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return safeNumber(value, 'integer');
  if (Array.isArray(value)) return Object.freeze(value.map(jsonSafe));
  if (value !== null && typeof value === 'object') {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)])),
    );
  }
  return value;
}

function safeNumber(value: unknown, label: string): number {
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number))
    throw releaseInvalid(`${label} is not a safe integer.`);
  return number;
}

function mergeLimitations(
  defaults: readonly string[],
  ...rows: readonly Readonly<Record<string, unknown>>[]
): readonly string[] {
  const limitations = rows.flatMap((row) => {
    const value = row.limitations_json;
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
  });
  return Object.freeze([...new Set([...defaults, ...limitations])]);
}

function requiredSingleRow(rows: readonly AnalyticalRow[], label: string): AnalyticalRow {
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw releaseInvalid(`${label} returned an invalid row count.`);
  }
  return row;
}

function requiredScannedBytes(value: number | null): number {
  if (value === null || !Number.isSafeInteger(value) || value < 0) {
    throw releaseInvalid('The runtime did not report an immutable scan bound.');
  }
  return value;
}

function withSignal<T extends object>(
  query: T,
  signal?: AbortSignal,
): T & Readonly<{ signal?: AbortSignal }> {
  return signal === undefined ? query : Object.freeze({ ...query, signal });
}

function releaseInvalid(message: string, cause?: unknown): ProductionServingError {
  return new ProductionServingError('RELEASE_INVALID', message, {
    ...(cause === undefined ? {} : { cause }),
  });
}
