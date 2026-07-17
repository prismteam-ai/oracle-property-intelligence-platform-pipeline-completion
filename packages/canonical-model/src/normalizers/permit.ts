import type { CanonicalMutation } from '@oracle/contracts/canonical/mutation';
import { entityIdSchema } from '@oracle/contracts/ids';

import type { CanonicalValue } from '../precedence.js';
import { normalizeSantaClaraApn, santaClaraPropertyId } from './apn.js';
import {
  assertExactKeys,
  emitCanonicalEntity,
  normalizeNullableDateTime,
  normalizeNullableText,
  normalizeText,
  sha256Utf8,
} from './core.js';
import type { AdditionalObservation, CanonicalNormalizationContext } from './core.js';

export type PermitSourceRecord = Readonly<{
  permitNumber: string;
  jurisdiction: string;
  permitType: string;
  status: string;
  statusAsOf: string;
  description?: string | null;
  apn?: string | null;
  appliedAt?: string | null;
  issuedAt?: string | null;
  finaledAt?: string | null;
  expiredAt?: string | null;
  ownerText?: string | null;
  applicantText?: string | null;
}>;

export function normalizePermitRecord(
  record: PermitSourceRecord,
  context: CanonicalNormalizationContext,
): readonly CanonicalMutation[] {
  assertExactKeys(
    record,
    [
      'permitNumber',
      'jurisdiction',
      'permitType',
      'status',
      'statusAsOf',
      'description',
      'apn',
      'appliedAt',
      'issuedAt',
      'finaledAt',
      'expiredAt',
      'ownerText',
      'applicantText',
    ],
    'Permit source record',
  );
  const permitNumber = normalizeText(record.permitNumber, 'permitNumber');
  const jurisdiction = normalizeText(record.jurisdiction, 'jurisdiction');
  const normalizedApn =
    record.apn === null || record.apn === undefined ? null : normalizeSantaClaraApn(record.apn);
  const propertyId = normalizedApn === null ? null : santaClaraPropertyId(normalizedApn);
  const appliedAt = normalizeNullableDateTime(record.appliedAt, 'appliedAt');
  const issuedAt = normalizeNullableDateTime(record.issuedAt, 'issuedAt');
  const finaledAt = normalizeNullableDateTime(record.finaledAt, 'finaledAt');
  const expiredAt = normalizeNullableDateTime(record.expiredAt, 'expiredAt');
  const statusAsOf = normalizeNullableDateTime(record.statusAsOf, 'statusAsOf');
  if (statusAsOf === null) {
    throw new TypeError('statusAsOf is required');
  }
  const permitId = entityIdSchema.parse(
    `sc:entity:permit:${sha256Utf8(
      `${context.sourceId}|${permitNumber.toUpperCase()}|${jurisdiction.toUpperCase()}`,
    )}`,
  );
  const additionalObservations: readonly AdditionalObservation[] = [
    { fieldPath: '/appliedAt', value: appliedAt },
    { fieldPath: '/finaledAt', value: finaledAt },
    { fieldPath: '/expiredAt', value: expiredAt },
    { fieldPath: '/sourceApn', value: record.apn ?? null },
    {
      fieldPath: '/sourceOwnerText',
      value: normalizeNullableText(record.ownerText, 'ownerText'),
    },
    {
      fieldPath: '/sourceApplicantText',
      value: normalizeNullableText(record.applicantText, 'applicantText'),
    },
  ];
  return emitCanonicalEntity(
    'permit',
    permitId,
    {
      permitNumber,
      jurisdiction,
      permitType: normalizeText(record.permitType, 'permitType'),
      status: normalizeText(record.status, 'status'),
      statusAsOf,
      description: normalizeNullableText(record.description, 'description'),
      issuedAt,
      // The frozen Permit contract exposes completedAt. Only an explicit finaled
      // date populates it; an issued/status-only record never becomes completed.
      completedAt: finaledAt,
      propertyLinks:
        propertyId === null
          ? []
          : ([
              {
                propertyId,
                propertyUnitId: null,
                method: 'normalized_identifier',
                score: 1,
              },
            ] as CanonicalValue),
      contractorIds: [],
    },
    context,
    additionalObservations,
  );
}
