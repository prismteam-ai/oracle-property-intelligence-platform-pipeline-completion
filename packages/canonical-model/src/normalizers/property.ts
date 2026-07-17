import type { CanonicalMutation } from '@oracle/contracts/canonical/mutation';
import { geoGeometrySchema, geoPointSchema } from '@oracle/contracts/canonical/geospatial';
import type { GeoGeometry, GeoPoint } from '@oracle/contracts/canonical/geospatial';
import type { EntityId } from '@oracle/contracts/ids';

import type { CanonicalValue } from '../precedence.js';
import { normalizeSantaClaraApn, santaClaraPropertyId } from './apn.js';
import {
  assertExactKeys,
  deterministicEntityId,
  emitCanonicalEntity,
  normalizeNullableText,
  normalizeText,
} from './core.js';
import type { AdditionalObservation, CanonicalNormalizationContext } from './core.js';

export type SourceAddress = Readonly<{
  line1: string;
  line2?: string | null;
  locality: string;
  postalCode: string;
  location?: GeoPoint | null;
}>;

export type SourcePropertyUnit = Readonly<{
  unitIdentifier: string;
  assessmentIdentifier?: string | null;
}>;

export type PropertySourceRecord = Readonly<{
  apn: string;
  jurisdiction: string;
  address?: SourceAddress | null;
  unit?: SourcePropertyUnit | null;
  parcelGeometry?: GeoGeometry | null;
  landAreaSquareMeters?: number | null;
  yearBuilt?: number | null;
  effectiveYearBuilt?: number | null;
}>;

function normalizeBuildingYear(value: number | null | undefined, fieldName: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isInteger(value) || value < 1000 || value > 9999) {
    throw new RangeError(`${fieldName} must be a four-digit year`);
  }
  return value;
}

function normalizedAddressKey(address: SourceAddress): string {
  return [address.line1, address.line2 ?? '', address.locality, 'CA', address.postalCode, 'US']
    .map((part) =>
      part
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/gu, ' ')
        .trim(),
    )
    .join('|');
}

export function santaClaraAddressId(address: SourceAddress): EntityId {
  return deterministicEntityId('address', ['santa-clara-ca', normalizedAddressKey(address)]);
}

export function santaClaraPropertyUnitId(
  propertyId: EntityId,
  unit: SourcePropertyUnit,
  addressId: EntityId | null,
): EntityId {
  const unitIdentifier = normalizeText(unit.unitIdentifier, 'unitIdentifier').toUpperCase();
  const assessmentIdentifier = normalizeNullableText(
    unit.assessmentIdentifier,
    'assessmentIdentifier',
  )?.toUpperCase();
  return deterministicEntityId('property-unit', [
    propertyId,
    assessmentIdentifier === undefined
      ? ['unit', unitIdentifier, addressId]
      : ['assessment', assessmentIdentifier],
  ]);
}

function addressFields(address: SourceAddress): Readonly<Record<string, CanonicalValue>> {
  const line1 = normalizeText(address.line1, 'address.line1');
  const line2 = normalizeNullableText(address.line2, 'address.line2');
  const locality = normalizeText(address.locality, 'address.locality');
  const postalCode = normalizeText(address.postalCode, 'address.postalCode');
  if (!/^\d{5}(?:-\d{4})?$/u.test(postalCode)) {
    throw new TypeError('address.postalCode must be a five-digit or ZIP+4 code');
  }
  return {
    line1,
    line2,
    locality,
    region: 'CA',
    postalCode,
    country: 'US',
    normalized: normalizedAddressKey({ ...address, line1, line2, locality, postalCode }),
    location:
      address.location === null || address.location === undefined
        ? null
        : geoPointSchema.parse(address.location),
  };
}

export function normalizePropertyRecord(
  record: PropertySourceRecord,
  context: CanonicalNormalizationContext,
): readonly CanonicalMutation[] {
  assertExactKeys(
    record,
    [
      'apn',
      'jurisdiction',
      'address',
      'unit',
      'parcelGeometry',
      'landAreaSquareMeters',
      'yearBuilt',
      'effectiveYearBuilt',
    ],
    'Property source record',
  );
  if (record.address !== null && record.address !== undefined) {
    assertExactKeys(
      record.address,
      ['line1', 'line2', 'locality', 'postalCode', 'location'],
      'Address source record',
    );
  }
  if (record.unit !== null && record.unit !== undefined) {
    assertExactKeys(
      record.unit,
      ['unitIdentifier', 'assessmentIdentifier'],
      'Property-unit source record',
    );
  }
  const apn = normalizeSantaClaraApn(record.apn);
  const propertyId = santaClaraPropertyId(apn);
  const addressId =
    record.address === null || record.address === undefined
      ? null
      : santaClaraAddressId(record.address);
  const unitId =
    record.unit === null || record.unit === undefined
      ? null
      : santaClaraPropertyUnitId(propertyId, record.unit, addressId);
  const geometry =
    record.parcelGeometry === null || record.parcelGeometry === undefined
      ? null
      : geoGeometrySchema.parse(record.parcelGeometry);
  const landArea = record.landAreaSquareMeters ?? null;
  if (landArea !== null && (!Number.isFinite(landArea) || landArea < 0)) {
    throw new RangeError('landAreaSquareMeters must be a finite non-negative number');
  }

  const mutations: CanonicalMutation[] = [];
  let sequenceStart = context.sequenceStart ?? 0;
  const append = (
    kind: Parameters<typeof emitCanonicalEntity>[0],
    id: EntityId,
    fields: Readonly<Record<string, CanonicalValue>>,
    additionalObservations: readonly AdditionalObservation[] = [],
  ): void => {
    const emitted = emitCanonicalEntity(
      kind,
      id,
      fields,
      { ...context, sequenceStart },
      additionalObservations,
    );
    mutations.push(...emitted);
    sequenceStart += emitted.length;
  };

  if (record.address !== null && record.address !== undefined && addressId !== null) {
    append('address', addressId, addressFields(record.address));
  }
  append(
    'property',
    propertyId,
    {
      county: 'Santa Clara',
      state: 'CA',
      apn,
      jurisdiction: normalizeText(record.jurisdiction, 'jurisdiction'),
      primaryAddressId: addressId,
      unitIds: unitId === null ? [] : [unitId],
      parcelGeometry: geometry,
      landAreaSquareMeters: landArea,
    },
    [
      {
        fieldPath: '/yearBuilt',
        value: normalizeBuildingYear(record.yearBuilt, 'yearBuilt'),
      },
      {
        fieldPath: '/effectiveYearBuilt',
        value: normalizeBuildingYear(record.effectiveYearBuilt, 'effectiveYearBuilt'),
      },
    ],
  );
  if (record.unit !== null && record.unit !== undefined && unitId !== null) {
    append('property-unit', unitId, {
      propertyId,
      unitIdentifier: normalizeText(record.unit.unitIdentifier, 'unitIdentifier'),
      assessmentIdentifier: normalizeNullableText(
        record.unit.assessmentIdentifier,
        'assessmentIdentifier',
      ),
      addressId,
    });
  }
  return Object.freeze(mutations);
}
