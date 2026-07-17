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

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
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
    const output: Record<string, CanonicalJson> = {};
    for (const [key, item] of Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
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
  const approved = [...new Set(policy.approvedFields)].sort();
  if (approved.length === 0) throw new TypeError('At least one approved public field is required');
  if (!approved.includes(policy.propertyIdField)) {
    throw new TypeError('The property identifier must be included in the approved public fields');
  }
  const prohibited = new Set([...ALWAYS_PROHIBITED_FIELDS, ...(policy.prohibitedFields ?? [])]);
  const conflicting = approved.filter((field) => prohibited.has(field));
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
      if (prohibited.has(field)) throw new TypeError(`Prohibited public field: ${field}`);
      if (!(field in record)) throw new TypeError(`Approved field is missing: ${field}`);
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
  projected.sort((left, right) => left.propertyId.localeCompare(right.propertyId));
  return Object.freeze(projected);
}
