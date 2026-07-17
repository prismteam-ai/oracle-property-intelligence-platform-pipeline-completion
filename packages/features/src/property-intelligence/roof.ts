import type { EntityId } from '@oracle/contracts/ids';

import {
  buildInquiryResult,
  coverageContains,
  parseInstant,
  wholeYearsBetween,
  yearsBefore,
  type InquiryCoverage,
  type InquiryResult,
  type SourceObservation,
} from './common.js';

export const ROOF_AGE_ALGORITHM = Object.freeze({
  name: 'oracle-roof-evidence-first',
  version: '1.0.0',
});

export type RoofWorkClassification =
  'replacement' | 'installation' | 'repair' | 'ambiguous_roof_work' | 'not_roof_work';

export interface RoofPermitObservation extends SourceObservation {
  readonly permitId: EntityId;
  readonly permitType: string;
  readonly description: string | null;
  readonly status: string;
  readonly issuedAt: string | null;
  readonly completedAt: string | null;
}

export interface BuildingAgeObservation extends SourceObservation {
  readonly yearBuilt: number | null;
  readonly effectiveYearBuilt: number | null;
}

export interface RoofAgeInput {
  readonly propertyId: EntityId;
  readonly asOf: string;
  readonly minimumAgeYears?: number;
  readonly permits: readonly RoofPermitObservation[];
  readonly buildingAge: readonly BuildingAgeObservation[];
  readonly permitCoverage: InquiryCoverage;
}

export interface RoofAgeValue {
  readonly mode:
    | 'explicit_completed_roof_work'
    | 'issued_roof_permit_proxy'
    | 'no_recent_roof_permit'
    | 'building_age_proxy';
  readonly classification: RoofWorkClassification | 'none_observed';
  readonly basisDate: string;
  readonly ageYears: number;
  readonly minimumAgeYears: number;
  readonly olderThanMinimum: boolean;
  readonly selectedPermitId: EntityId | null;
  readonly actualRoofAgeProven: boolean;
}

export type RoofAgeResult = InquiryResult<RoofAgeValue>;

const REPLACEMENT_PATTERN =
  /\b(?:RE\s*ROOF|ROOF\s+REPLAC(?:E|EMENT|ING)|TEAR\s*OFF|REMOVE\s+(?:AND|&)\s+REPLACE\s+ROOF)\b/u;
const INSTALLATION_PATTERN = /\b(?:NEW\s+ROOF|ROOF\s+INSTALL(?:ATION|ED|ING)?)\b/u;
const REPAIR_PATTERN =
  /\b(?:ROOF\s+REPAIR|REPAIR(?:ING)?\s+(?:THE\s+)?ROOF|PATCH(?:ING)?\s+ROOF)\b/u;
const ROOF_PATTERN = /\bROOF(?:ING)?\b/u;
const INCIDENTAL_ROOF_PATTERN =
  /\b(?:SOLAR|PHOTOVOLTAIC|HVAC|ANTENNA|SATELLITE|GUTTER|SKYLIGHT)\b/u;

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, ' ')
    .trim();
}

export function classifyRoofWork(
  input: Readonly<{ permitType: string; description: string | null }>,
): RoofWorkClassification {
  const text = normalizeText(`${input.permitType} ${input.description ?? ''}`);
  if (REPLACEMENT_PATTERN.test(text)) {
    return 'replacement';
  }
  if (INSTALLATION_PATTERN.test(text)) {
    return 'installation';
  }
  if (REPAIR_PATTERN.test(text)) {
    return 'repair';
  }
  if (ROOF_PATTERN.test(text)) {
    return INCIDENTAL_ROOF_PATTERN.test(text) ? 'not_roof_work' : 'ambiguous_roof_work';
  }
  return 'not_roof_work';
}

function hasTerminalStatus(status: string): boolean {
  const normalized = normalizeText(status);
  return /^(?:FINAL|FINALED|COMPLETED|CLOSED|CERTIFICATE ISSUED)$/u.test(normalized);
}

function validObservedDate(value: string | null, asOfMilliseconds: number): value is string {
  if (value === null) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && milliseconds <= asOfMilliseconds;
}

function observationSignature(observation: RoofPermitObservation): string {
  return JSON.stringify({
    classification: classifyRoofWork(observation),
    status: normalizeText(observation.status),
    issuedAt: observation.issuedAt,
    completedAt: observation.completedAt,
  });
}

function conflictingPermitIds(permits: readonly RoofPermitObservation[]): ReadonlySet<EntityId> {
  const signatures = new Map<EntityId, Set<string>>();
  for (const permit of permits) {
    const values = signatures.get(permit.permitId) ?? new Set<string>();
    values.add(observationSignature(permit));
    signatures.set(permit.permitId, values);
  }
  return new Set(
    [...signatures.entries()].filter(([, values]) => values.size > 1).map(([permitId]) => permitId),
  );
}

function latestPermit(
  permits: readonly RoofPermitObservation[],
  date: (permit: RoofPermitObservation) => string | null,
): RoofPermitObservation | null {
  return (
    [...permits].sort((left, right) => {
      const leftDate = date(left) ?? '';
      const rightDate = date(right) ?? '';
      return rightDate.localeCompare(leftDate) || left.permitId.localeCompare(right.permitId);
    })[0] ?? null
  );
}

function validBuildingYear(value: number | null, asOfYear: number): value is number {
  return value !== null && Number.isInteger(value) && value >= 1000 && value <= asOfYear;
}

function buildingProxy(
  observations: readonly BuildingAgeObservation[],
  asOf: string,
): Readonly<{ observation: BuildingAgeObservation; year: number }> | null {
  const asOfYear = new Date(parseInstant(asOf, 'asOf')).getUTCFullYear();
  return (
    observations
      .flatMap((observation) => {
        const year = validBuildingYear(observation.effectiveYearBuilt, asOfYear)
          ? observation.effectiveYearBuilt
          : validBuildingYear(observation.yearBuilt, asOfYear)
            ? observation.yearBuilt
            : null;
        return year === null ? [] : [{ observation, year }];
      })
      .sort(
        (left, right) =>
          right.year - left.year ||
          left.observation.observationId.localeCompare(right.observation.observationId),
      )[0] ?? null
  );
}

export function deriveRoofAge(input: RoofAgeInput): RoofAgeResult {
  const minimumAgeYears = input.minimumAgeYears ?? 15;
  if (!Number.isInteger(minimumAgeYears) || minimumAgeYears <= 0) {
    throw new RangeError('minimumAgeYears must be a positive integer');
  }
  const asOfMilliseconds = parseInstant(input.asOf, 'asOf');
  const conflicts = conflictingPermitIds(input.permits);
  const relevantConflict = input.permits.some(
    (permit) =>
      conflicts.has(permit.permitId) &&
      ['replacement', 'installation', 'ambiguous_roof_work'].includes(classifyRoofWork(permit)),
  );
  const observations = [...input.permits, ...input.buildingAge];
  const calculation = Object.freeze({
    ...ROOF_AGE_ALGORITHM,
    parameters: Object.freeze({ minimumAgeYears, strictCompletionField: 'completedAt' }),
  });

  if (relevantConflict) {
    return buildInquiryResult({
      propertyId: input.propertyId,
      feature: 'roof_age',
      value: null,
      supportClass: 'unknown',
      confidence: 0,
      observations,
      calculation,
      asOf: input.asOf,
      coverage: input.permitCoverage,
      limitations: [
        'Contradictory observations exist for the same roof-work permit; no observation was selected by row order.',
        'Roof age remains unknown until the source conflict is resolved.',
      ],
    });
  }

  const conclusive = input.permits.filter((permit) => {
    const classification = classifyRoofWork(permit);
    return (
      !conflicts.has(permit.permitId) &&
      ['replacement', 'installation'].includes(classification) &&
      validObservedDate(permit.completedAt, asOfMilliseconds) &&
      hasTerminalStatus(permit.status)
    );
  });
  const latestCompleted = latestPermit(conclusive, ({ completedAt }) => completedAt);
  if (latestCompleted !== null && latestCompleted.completedAt !== null) {
    if (coverageContains(input.permitCoverage, latestCompleted.completedAt, input.asOf)) {
      const ageYears = wholeYearsBetween(latestCompleted.completedAt, input.asOf);
      return buildInquiryResult({
        propertyId: input.propertyId,
        feature: 'roof_age',
        value: {
          mode: 'explicit_completed_roof_work',
          classification: classifyRoofWork(latestCompleted),
          basisDate: latestCompleted.completedAt,
          ageYears,
          minimumAgeYears,
          olderThanMinimum: ageYears > minimumAgeYears,
          selectedPermitId: latestCompleted.permitId,
          actualRoofAgeProven: true,
        },
        supportClass: 'supported',
        confidence: 1,
        observations,
        calculation,
        asOf: input.asOf,
        coverage: input.permitCoverage,
        limitations: [
          'The age is measured from the latest conclusive finalized roof-work evidence in the declared complete permit window.',
        ],
      });
    }
    return buildInquiryResult({
      propertyId: input.propertyId,
      feature: 'roof_age',
      value: null,
      supportClass: 'unknown',
      confidence: 0,
      observations,
      calculation,
      asOf: input.asOf,
      coverage: input.permitCoverage,
      limitations: [
        'Finalized roof work was observed, but incomplete permit coverage cannot establish that it is the latest roof work.',
      ],
    });
  }

  const issued = input.permits.filter((permit) => {
    const classification = classifyRoofWork(permit);
    return (
      !conflicts.has(permit.permitId) &&
      ['replacement', 'installation'].includes(classification) &&
      validObservedDate(permit.issuedAt, asOfMilliseconds)
    );
  });
  const latestIssued = latestPermit(issued, ({ issuedAt }) => issuedAt);
  if (latestIssued !== null && latestIssued.issuedAt !== null) {
    const ageYears = wholeYearsBetween(latestIssued.issuedAt, input.asOf);
    return buildInquiryResult({
      propertyId: input.propertyId,
      feature: 'roof_age',
      value: {
        mode: 'issued_roof_permit_proxy',
        classification: classifyRoofWork(latestIssued),
        basisDate: latestIssued.issuedAt,
        ageYears,
        minimumAgeYears,
        olderThanMinimum: ageYears > minimumAgeYears,
        selectedPermitId: latestIssued.permitId,
        actualRoofAgeProven: false,
      },
      supportClass: 'proxy',
      confidence: 0.5,
      observations,
      calculation,
      asOf: input.asOf,
      coverage: input.permitCoverage,
      limitations: [
        'Permit issuance does not prove that roof work occurred or identify a roof completion date.',
        'This proxy must not be presented as actual roof age.',
      ],
    });
  }

  const requiredStart = yearsBefore(input.asOf, minimumAgeYears);
  if (coverageContains(input.permitCoverage, requiredStart, input.asOf)) {
    return buildInquiryResult({
      propertyId: input.propertyId,
      feature: 'roof_age',
      value: {
        mode: 'no_recent_roof_permit',
        classification: 'none_observed',
        basisDate: requiredStart,
        ageYears: minimumAgeYears,
        minimumAgeYears,
        olderThanMinimum: false,
        selectedPermitId: null,
        actualRoofAgeProven: false,
      },
      supportClass: 'proxy',
      confidence: 0.25,
      observations,
      calculation,
      asOf: input.asOf,
      coverage: input.permitCoverage,
      limitations: [
        'No conclusive roof permit was observed in a complete permit window; absence does not prove roof age or condition.',
        'This proxy must not be presented as actual roof age.',
      ],
    });
  }

  const building = buildingProxy(input.buildingAge, input.asOf);
  if (building !== null) {
    const basisDate = `${String(building.year).padStart(4, '0')}-01-01T00:00:00.000Z`;
    const ageYears = wholeYearsBetween(basisDate, input.asOf);
    return buildInquiryResult({
      propertyId: input.propertyId,
      feature: 'roof_age',
      value: {
        mode: 'building_age_proxy',
        classification: 'none_observed',
        basisDate,
        ageYears,
        minimumAgeYears,
        olderThanMinimum: ageYears > minimumAgeYears,
        selectedPermitId: null,
        actualRoofAgeProven: false,
      },
      supportClass: 'proxy',
      confidence: 0.2,
      observations,
      calculation,
      asOf: input.asOf,
      coverage: input.permitCoverage,
      limitations: [
        'Building or effective building age is not roof age and cannot prove a roof installation date.',
        'This proxy must not be presented as actual roof age.',
      ],
    });
  }

  return buildInquiryResult({
    propertyId: input.propertyId,
    feature: 'roof_age',
    value: null,
    supportClass: 'unknown',
    confidence: 0,
    observations,
    calculation,
    asOf: input.asOf,
    coverage: input.permitCoverage,
    limitations: [
      'No conclusive finalized roof-work evidence or supported proxy evidence is available.',
      'Missing evidence must not be converted into a positive old-roof claim.',
    ],
  });
}
