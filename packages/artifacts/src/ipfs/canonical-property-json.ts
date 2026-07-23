import { createHash } from 'node:crypto';

export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

export type PropertyRecord = Readonly<Record<string, unknown>>;

export type CanonicalPropertyJson = Readonly<{
  propertyId: string;
  path: string;
  bytes: Uint8Array;
  byteLength: number;
  sha256: string;
}>;

export type PublicProjectionPolicy = Readonly<{
  propertyIdField: string;
  approvedFields: readonly string[];
  prohibitedFields?: readonly string[];
  pathHashPrefixLength?: number;
}>;

const ALWAYS_PROHIBITED_FIELDS = Object.freeze([
  'email',
  'mailingAddress',
  'ownerName',
  'phone',
  'rawOwnerName',
  'streetAddress',
]);

const PROHIBITED_NORMALIZED_FIELD_NAMES = new Set([
  'applicant',
  'applicantaddress',
  'applicantemail',
  'applicantname',
  'applicantphone',
  'birthdate',
  'contact',
  'contactdetails',
  'dateofbirth',
  'dob',
  'email',
  'fbnpartyaddress',
  'fbnpartyidentifier',
  'fbnregistrant',
  'fbnregistrantaddress',
  'fbnregistrantname',
  'fbnregistrantresidence',
  'grantee',
  'granteeaddress',
  'grantor',
  'grantoraddress',
  'mailingaddress',
  'mailingstreet',
  'owneraddress',
  'owneremail',
  'owneridentity',
  'ownername',
  'ownerphone',
  'owners',
  'ownerstext',
  'partyaddress',
  'partyidentifier',
  'phone',
  'prohibitedpublic',
  'protectedaddress',
  'rawownername',
  'restricted',
  'socialsecuritynumber',
  'sosagentresidentialaddress',
  'sosofficerresidentialaddress',
  'ssn',
  'streetaddress',
]);

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function normalizedFieldName(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/gu, '');
}

function assertPublicFieldName(field: string, path: string, prohibited: ReadonlySet<string>): void {
  const normalized = normalizedFieldName(field);
  const containsSensitiveOwnerDetail =
    normalized.includes('owner') &&
    ['address', 'email', 'identity', 'mailing', 'name', 'phone', 'text'].some((token) =>
      normalized.includes(token),
    );
  const containsDirectContact = ['email', 'phone', 'contact'].some((token) =>
    normalized.includes(token),
  );
  const containsRestrictedPartyDetail =
    normalized.includes('party') &&
    ['address', 'identifier', 'identity'].some((token) => normalized.includes(token));
  const containsRestrictedBusinessIdentity =
    normalized.includes('registrant') ||
    (normalized.includes('residen') && normalized.includes('address')) ||
    ((normalized.includes('officer') || normalized.includes('agent')) &&
      normalized.includes('address'));
  const containsSensitiveIdentity =
    normalized.includes('socialsecurity') ||
    normalized.includes('dateofbirth') ||
    normalized.includes('birthdate');
  if (
    field === '__proto__' ||
    field === 'constructor' ||
    field === 'prototype' ||
    prohibited.has(normalized) ||
    PROHIBITED_NORMALIZED_FIELD_NAMES.has(normalized) ||
    containsSensitiveOwnerDetail ||
    containsDirectContact ||
    containsRestrictedPartyDetail ||
    containsRestrictedBusinessIdentity ||
    containsSensitiveIdentity ||
    normalized.includes('mailingaddress') ||
    normalized.includes('protectedaddress') ||
    normalized.includes('grantor') ||
    normalized.includes('grantee') ||
    normalized.includes('applicant')
  ) {
    throw new TypeError(`${path} contains prohibited public field: ${field}`);
  }
}

function assertPublicValue(value: unknown, path: string, prohibited: ReadonlySet<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPublicValue(item, `${path}[${index}]`, prohibited));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must contain only plain JSON objects`);
  }
  for (const [key, item] of Object.entries(value)) {
    assertPublicFieldName(key, `${path}.${key}`, prohibited);
    assertPublicValue(item, `${path}.${key}`, prohibited);
  }
}

function canonicalize(value: unknown, path: string): CanonicalJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item, index) => canonicalize(item, `${path}[${index}]`)));
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must be a plain JSON object`);
    }
    const output: Record<string, CanonicalJson> = Object.create(null) as Record<
      string,
      CanonicalJson
    >;
    for (const [key, item] of Object.entries(value).sort(([left], [right]) =>
      compareUtf8(left, right),
    )) {
      if (item === undefined) throw new TypeError(`${path}.${key} must not be undefined`);
      output[key] = canonicalize(item, `${path}.${key}`);
    }
    return Object.freeze(output);
  }
  throw new TypeError(`${path} is not canonical JSON data`);
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(canonicalize(value, 'value'))}\n`, 'utf8');
}

function assertPolicy(policy: PublicProjectionPolicy): Readonly<{
  approved: readonly string[];
  prohibited: ReadonlySet<string>;
  prefixLength: number;
}> {
  if (policy.propertyIdField.trim().length === 0)
    throw new TypeError('propertyIdField is required');
  const approved = [...new Set(policy.approvedFields)].sort(compareUtf8);
  if (approved.length === 0) throw new TypeError('At least one approved public field is required');
  if (!approved.includes(policy.propertyIdField)) {
    throw new TypeError('The property identifier must be included in the approved public fields');
  }
  const prohibited = new Set(
    [...ALWAYS_PROHIBITED_FIELDS, ...(policy.prohibitedFields ?? [])].map(normalizedFieldName),
  );
  const conflicting = approved.filter((field) => {
    try {
      assertPublicFieldName(field, `approvedFields.${field}`, prohibited);
      return false;
    } catch {
      return true;
    }
  });
  if (conflicting.length > 0) {
    throw new TypeError(`Prohibited fields cannot be public: ${conflicting.join(', ')}`);
  }
  const prefixLength = policy.pathHashPrefixLength ?? 2;
  if (!Number.isInteger(prefixLength) || prefixLength < 1 || prefixLength > 16) {
    throw new RangeError('pathHashPrefixLength must be an integer between 1 and 16');
  }
  return Object.freeze({ approved: Object.freeze(approved), prohibited, prefixLength });
}

function propertyPath(propertyId: string, prefixLength: number): string {
  const digest = sha256(propertyId);
  const name = Buffer.from(propertyId, 'utf8').toString('base64url');
  return `properties/${digest.slice(0, prefixLength)}/${name}.json`;
}

/**
 * Projects source records through an injected, approved top-level field allowlist.
 * Extra source fields are ignored; a prohibited field in the allowlist fails closed.
 */
export function buildCanonicalPropertyJson(
  records: readonly PropertyRecord[],
  policy: PublicProjectionPolicy,
): readonly CanonicalPropertyJson[] {
  const { approved, prohibited, prefixLength } = assertPolicy(policy);
  const seen = new Set<string>();
  const projected = records.map((record) => {
    const identifier = record[policy.propertyIdField];
    if (typeof identifier !== 'string' || identifier.trim().length === 0) {
      throw new TypeError(`Every record requires a non-empty ${policy.propertyIdField}`);
    }
    if (seen.has(identifier)) throw new TypeError(`Duplicate property identifier: ${identifier}`);
    seen.add(identifier);
    const value: Record<string, CanonicalJson> = {};
    for (const field of approved) {
      assertPublicFieldName(field, `record.${field}`, prohibited);
      if (!(field in record)) throw new TypeError(`Approved field is missing: ${field}`);
      assertPublicValue(record[field], `record.${field}`, prohibited);
      value[field] = canonicalize(record[field], `record.${field}`);
    }
    const bytes = canonicalJsonBytes(value);
    return Object.freeze({
      propertyId: identifier,
      path: propertyPath(identifier, prefixLength),
      bytes,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    });
  });
  projected.sort((left, right) => compareUtf8(left.propertyId, right.propertyId));
  return Object.freeze(projected);
}
