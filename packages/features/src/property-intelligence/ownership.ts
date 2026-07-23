import type { EntityId } from '@oracle/contracts/ids';
import type { SupportState } from '@oracle/contracts/pipeline';

import {
  buildInquiryResult,
  coverageContains,
  parseInstant,
  wholeYearsBetween,
  yearsBefore,
  type CoverageState,
  type InquiryCoverage,
  type InquiryResult,
  type SourceObservation,
} from './common.js';

export const OWNERSHIP_TENURE_ALGORITHM = Object.freeze({
  name: 'oracle-complete-transfer-tenure',
  version: '1.0.0',
});

export const BAY_AREA_NINE_COUNTIES_POLICY = Object.freeze({
  policyId: 'bay-area-nine-counties-v1',
  basis: 'current_owner_verified_mailing_county',
  regionalOwnerDefinition: 'outside_included_counties',
  includedCounties: Object.freeze([
    'Alameda',
    'Contra Costa',
    'Marin',
    'Napa',
    'San Francisco',
    'San Mateo',
    'Santa Clara',
    'Solano',
    'Sonoma',
  ]),
  unknownHandling: 'exclude-and-report',
} as const);

export interface OwnershipInquiryCoverage extends InquiryCoverage {
  readonly currentOwnerState: CoverageState;
  readonly transferHistoryState: CoverageState;
}

export interface OwnerMailingLocation {
  readonly county: string | null;
  readonly state: string | null;
  readonly country: string | null;
  readonly validation: 'verified_county' | 'po_box' | 'unresolved' | 'invalid';
}

export interface CurrentOwnerObservation extends SourceObservation {
  readonly interestId: EntityId;
  readonly partyId: EntityId;
  readonly supportState: SupportState;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly mailingLocation: OwnerMailingLocation | null;
}

export interface TransferObservation extends SourceObservation {
  readonly eventId: EntityId;
  readonly supportState: SupportState;
  readonly occurredAt: string;
  readonly granteePartyIds: readonly EntityId[];
}

interface OwnershipInputBase {
  readonly propertyId: EntityId;
  readonly asOf: string;
  readonly currentOwners: readonly CurrentOwnerObservation[];
  readonly transfers: readonly TransferObservation[];
  readonly coverage: OwnershipInquiryCoverage;
}

export interface OwnershipTenureInput extends OwnershipInputBase {
  readonly minimumTenureYears?: number;
}

export interface OwnershipTenureValue {
  readonly latestVerifiedTransferAt: string;
  readonly tenureYears: number;
  readonly minimumTenureYears: number;
  readonly hasNotExchangedOwnership: boolean;
  readonly currentOwnerCount: number;
  readonly strictEvidence: true;
}

export interface RegionalOwnerValue {
  readonly policyId: typeof BAY_AREA_NINE_COUNTIES_POLICY.policyId;
  readonly regionalOwnerDefinition: typeof BAY_AREA_NINE_COUNTIES_POLICY.regionalOwnerDefinition;
  readonly isRegionalOwner: boolean;
  readonly insideRegionOwnerCount: number;
  readonly outsideRegionOwnerCount: number;
  readonly currentOwnerCount: number;
  readonly rawOwnerIdentityExposed: false;
}

export type OwnershipTenureResult = InquiryResult<OwnershipTenureValue>;
export type RegionalOwnerResult = InquiryResult<RegionalOwnerValue>;

interface ValidatedOwnership {
  readonly currentOwners: readonly CurrentOwnerObservation[];
  readonly latestTransfer: TransferObservation;
  readonly observations: readonly SourceObservation[];
}

function safeCurrentOwnerObservation(observation: CurrentOwnerObservation): SourceObservation {
  return Object.freeze({
    observationId: observation.observationId,
    kind: observation.kind,
    reference: observation.reference,
    observedAt: observation.observedAt,
    sourceAsOf: observation.sourceAsOf,
    visibility: observation.visibility,
    fields: Object.freeze({
      interestId: observation.interestId,
      partyId: observation.partyId,
      supportState: observation.supportState,
      effectiveFrom: observation.effectiveFrom,
      effectiveTo: observation.effectiveTo,
      mailingCounty: observation.mailingLocation?.county ?? null,
      mailingState: observation.mailingLocation?.state ?? null,
      mailingCountry: observation.mailingLocation?.country ?? null,
      mailingValidation: observation.mailingLocation?.validation ?? 'unresolved',
    }),
  });
}

function safeTransferObservation(observation: TransferObservation): SourceObservation {
  return Object.freeze({
    observationId: observation.observationId,
    kind: observation.kind,
    reference: observation.reference,
    observedAt: observation.observedAt,
    sourceAsOf: observation.sourceAsOf,
    visibility: observation.visibility,
    fields: Object.freeze({
      eventId: observation.eventId,
      supportState: observation.supportState,
      occurredAt: observation.occurredAt,
      granteePartyIds: Object.freeze([...observation.granteePartyIds].sort()),
    }),
  });
}

function safeCoverage(coverage: OwnershipInquiryCoverage): OwnershipInquiryCoverage {
  return Object.freeze({
    ...coverage,
    observations: Object.freeze(
      coverage.observations.map((observation) =>
        Object.freeze({
          ...observation,
          fields: Object.freeze({
            capabilityState: coverage.state,
            currentOwnerState: coverage.currentOwnerState,
            transferHistoryState: coverage.transferHistoryState,
            windowStart: coverage.windowStart,
            windowEnd: coverage.windowEnd,
          }),
        }),
      ),
    ),
  });
}

function sortedSet(values: readonly EntityId[]): readonly EntityId[] {
  return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}

function sameValues(left: readonly EntityId[], right: readonly EntityId[]): boolean {
  const sortedLeft = sortedSet(left);
  const sortedRight = sortedSet(right);
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

function conflictingById<T>(
  values: readonly T[],
  id: (value: T) => EntityId,
  signature: (value: T) => string,
): boolean {
  const signatures = new Map<EntityId, Set<string>>();
  for (const value of values) {
    const key = id(value);
    const collected = signatures.get(key) ?? new Set<string>();
    collected.add(signature(value));
    signatures.set(key, collected);
  }
  return [...signatures.values()].some((collected) => collected.size > 1);
}

function validateOwnership(
  input: OwnershipInputBase,
  requiredStart: string,
): Readonly<{ validated: ValidatedOwnership | null; limitations: readonly string[] }> {
  const coverage = input.coverage;
  const observations = Object.freeze([
    ...input.currentOwners.map(safeCurrentOwnerObservation),
    ...input.transfers.map(safeTransferObservation),
  ]);
  if (
    coverage.state !== 'complete' ||
    coverage.currentOwnerState !== 'complete' ||
    coverage.transferHistoryState !== 'complete' ||
    !coverageContains(coverage, requiredStart, input.asOf)
  ) {
    return Object.freeze({
      validated: null,
      limitations: Object.freeze([
        'Complete current-owner and transfer-history evidence through the inquiry as-of date is required.',
        `${coverage.state} ownership coverage cannot support a strict ownership claim.`,
      ]),
    });
  }

  const asOfMilliseconds = parseInstant(input.asOf, 'asOf');
  if (
    conflictingById(
      input.currentOwners,
      ({ interestId }) => interestId,
      (owner) =>
        JSON.stringify({
          partyId: owner.partyId,
          supportState: owner.supportState,
          effectiveFrom: owner.effectiveFrom,
          effectiveTo: owner.effectiveTo,
          mailingLocation: owner.mailingLocation,
        }),
    ) ||
    conflictingById(
      input.transfers,
      ({ eventId }) => eventId,
      (event) =>
        JSON.stringify({
          supportState: event.supportState,
          occurredAt: event.occurredAt,
          granteePartyIds: sortedSet(event.granteePartyIds),
        }),
    )
  ) {
    return Object.freeze({
      validated: null,
      limitations: Object.freeze([
        'Contradictory ownership observations share an interest or event identifier; row order is not used to resolve them.',
      ]),
    });
  }

  const currentOwners = input.currentOwners.filter((owner) => {
    const from = Date.parse(owner.effectiveFrom);
    const to = owner.effectiveTo === null ? null : Date.parse(owner.effectiveTo);
    return (
      owner.supportState === 'supported' &&
      Number.isFinite(from) &&
      from <= asOfMilliseconds &&
      (to === null || (Number.isFinite(to) && to > asOfMilliseconds))
    );
  });
  if (
    currentOwners.length === 0 ||
    currentOwners.length !== input.currentOwners.length ||
    new Set(currentOwners.map(({ partyId }) => partyId)).size !== currentOwners.length
  ) {
    return Object.freeze({
      validated: null,
      limitations: Object.freeze([
        'Current ownership is missing, duplicated, invalid, expired, or not directly supported.',
      ]),
    });
  }

  const validTransfers = input.transfers.filter((transfer) => {
    const occurredAt = Date.parse(transfer.occurredAt);
    return (
      transfer.supportState === 'supported' &&
      Number.isFinite(occurredAt) &&
      occurredAt <= asOfMilliseconds &&
      transfer.granteePartyIds.length > 0
    );
  });
  if (validTransfers.length === 0 || validTransfers.length !== input.transfers.length) {
    return Object.freeze({
      validated: null,
      limitations: Object.freeze([
        'Transfer history contains missing, future, invalid, empty-grantee, or non-supported evidence.',
      ]),
    });
  }
  const latestTransfer = [...validTransfers].sort(
    (left, right) =>
      right.occurredAt.localeCompare(left.occurredAt) || left.eventId.localeCompare(right.eventId),
  )[0];
  if (
    latestTransfer === undefined ||
    !sameValues(
      latestTransfer.granteePartyIds,
      currentOwners.map(({ partyId }) => partyId),
    ) ||
    currentOwners.some(
      ({ effectiveFrom }) => Date.parse(effectiveFrom) > Date.parse(latestTransfer.occurredAt),
    )
  ) {
    return Object.freeze({
      validated: null,
      limitations: Object.freeze([
        'The latest verified transfer grantees and effective current-owner parties do not agree.',
      ]),
    });
  }

  return Object.freeze({
    validated: Object.freeze({
      currentOwners: Object.freeze(
        [...currentOwners].sort((left, right) => left.partyId.localeCompare(right.partyId)),
      ),
      latestTransfer,
      observations,
    }),
    limitations: Object.freeze([]),
  });
}

export function deriveOwnershipTenure(input: OwnershipTenureInput): OwnershipTenureResult {
  const minimumTenureYears = input.minimumTenureYears ?? 10;
  if (!Number.isInteger(minimumTenureYears) || minimumTenureYears <= 0) {
    throw new RangeError('minimumTenureYears must be a positive integer');
  }
  parseInstant(input.asOf, 'asOf');
  const requiredStart = yearsBefore(input.asOf, minimumTenureYears);
  const coverage = safeCoverage(input.coverage);
  const result = validateOwnership({ ...input, coverage }, requiredStart);
  const observations = [
    ...input.currentOwners.map(safeCurrentOwnerObservation),
    ...input.transfers.map(safeTransferObservation),
  ];
  const calculation = Object.freeze({
    ...OWNERSHIP_TENURE_ALGORITHM,
    parameters: Object.freeze({ minimumTenureYears, completenessRequired: true }),
  });
  if (result.validated === null) {
    return buildInquiryResult({
      propertyId: input.propertyId,
      feature: 'ownership_age',
      value: null,
      supportClass: 'unknown',
      confidence: 0,
      observations,
      calculation,
      asOf: input.asOf,
      coverage,
      limitations: [
        ...result.limitations,
        'Missing records or source blockage must not become a positive no-exchange claim.',
      ],
    });
  }

  const tenureYears = wholeYearsBetween(result.validated.latestTransfer.occurredAt, input.asOf);
  return buildInquiryResult({
    propertyId: input.propertyId,
    feature: 'ownership_age',
    value: {
      latestVerifiedTransferAt: result.validated.latestTransfer.occurredAt,
      tenureYears,
      minimumTenureYears,
      hasNotExchangedOwnership: tenureYears > minimumTenureYears,
      currentOwnerCount: result.validated.currentOwners.length,
      strictEvidence: true,
    },
    supportClass: 'supported',
    confidence: 1,
    observations,
    calculation,
    asOf: input.asOf,
    coverage,
    limitations: [
      'The result is limited to verified recorded transfers within the declared complete source window.',
    ],
  });
}

function normalizeCounty(county: string): string {
  return county
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/\bCOUNTY\b/giu, '')
    .replace(/[^a-z]+/giu, ' ')
    .trim()
    .toLowerCase()
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function classifyLocation(location: OwnerMailingLocation | null): 'inside' | 'outside' | 'unknown' {
  if (location?.validation !== 'verified_county') {
    return 'unknown';
  }
  const country = location.country?.trim().toUpperCase() ?? null;
  const state = location.state?.trim().toUpperCase() ?? null;
  if (country !== null && !['US', 'USA', 'UNITED STATES'].includes(country)) {
    return 'outside';
  }
  if (state !== 'CA') {
    return state === null ? 'unknown' : 'outside';
  }
  if (location.county === null) {
    return 'unknown';
  }
  const county = normalizeCounty(location.county);
  return BAY_AREA_NINE_COUNTIES_POLICY.includedCounties.some(
    (included) => normalizeCounty(included) === county,
  )
    ? 'inside'
    : 'outside';
}

export function deriveRegionalOwner(input: OwnershipInputBase): RegionalOwnerResult {
  parseInstant(input.asOf, 'asOf');
  const coverage = safeCoverage(input.coverage);
  const requiredStart = coverage.windowStart ?? input.asOf;
  const result = validateOwnership({ ...input, coverage }, requiredStart);
  const observations = [
    ...input.currentOwners.map(safeCurrentOwnerObservation),
    ...input.transfers.map(safeTransferObservation),
  ];
  const calculation = Object.freeze({
    name: 'oracle-regional-owner-nine-counties',
    version: '1.0.0',
    parameters: Object.freeze({
      policyId: BAY_AREA_NINE_COUNTIES_POLICY.policyId,
      regionalOwnerDefinition: BAY_AREA_NINE_COUNTIES_POLICY.regionalOwnerDefinition,
      includedCounties: BAY_AREA_NINE_COUNTIES_POLICY.includedCounties,
      completenessRequired: true,
    }),
  });
  if (result.validated === null) {
    return buildInquiryResult({
      propertyId: input.propertyId,
      feature: 'regional_owner',
      value: null,
      supportClass: 'unknown',
      confidence: 0,
      observations,
      calculation,
      asOf: input.asOf,
      coverage,
      limitations: [
        ...result.limitations,
        'Regional-owner classification requires complete supported transfer and current-owner evidence.',
      ],
    });
  }

  const classifications = result.validated.currentOwners.map(({ mailingLocation }) =>
    classifyLocation(mailingLocation),
  );
  if (classifications.includes('unknown')) {
    return buildInquiryResult({
      propertyId: input.propertyId,
      feature: 'regional_owner',
      value: null,
      supportClass: 'unknown',
      confidence: 0,
      observations,
      calculation,
      asOf: input.asOf,
      coverage,
      limitations: [
        'A current owner has no verified mailing county; PO boxes and failed geocodes are not classified by assumption.',
      ],
    });
  }
  const insideRegionOwnerCount = classifications.filter((value) => value === 'inside').length;
  const outsideRegionOwnerCount = classifications.filter((value) => value === 'outside').length;
  return buildInquiryResult({
    propertyId: input.propertyId,
    feature: 'regional_owner',
    value: {
      policyId: BAY_AREA_NINE_COUNTIES_POLICY.policyId,
      regionalOwnerDefinition: BAY_AREA_NINE_COUNTIES_POLICY.regionalOwnerDefinition,
      isRegionalOwner: outsideRegionOwnerCount > 0,
      insideRegionOwnerCount,
      outsideRegionOwnerCount,
      currentOwnerCount: classifications.length,
      rawOwnerIdentityExposed: false,
    },
    supportClass: 'supported',
    confidence: 1,
    observations,
    calculation,
    asOf: input.asOf,
    coverage,
    limitations: [
      'Under bay-area-nine-counties-v1, regional owner means at least one verified current owner mailing outside the nine included counties.',
      'Public output contains only coarse classification; raw owner names and mailing addresses are not returned.',
    ],
  });
}
