import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { NamedQueryName } from '@oracle/contracts/query';

import type { InquiryName } from '../inquiries/contracts.js';
import { InquiryCursorCodec } from '../inquiries/cursor.js';
import { ProductionServingError } from './contracts.js';

type ServingCursorPayload = Readonly<{
  version: 1;
  operation: NamedQueryName;
  releaseId: string;
  queryFingerprint: string;
  keys: readonly (number | string)[];
}>;

const inquiryByOperation: Readonly<Partial<Record<NamedQueryName, InquiryName>>> = Object.freeze({
  find_roof_age_candidates: 'roof_age',
  find_water_view_candidates: 'water_view_candidate',
  find_ownership_age_candidates: 'ownership_age',
  find_regional_owner_properties: 'regional_owner',
  find_transit_walkable_properties: 'transit_walkability',
  find_starbucks_walkable_properties: 'starbucks_walkability',
  rank_review_candidates: 'combined_review',
});

export class ProductionCursorCodec {
  readonly #secret: Uint8Array;
  readonly #inquiry: InquiryCursorCodec;

  public constructor(secret: Uint8Array) {
    if (secret.byteLength < 32) {
      throw new ProductionServingError(
        'RELEASE_INVALID',
        'Cursor integrity secret must be at least 32 bytes.',
      );
    }
    this.#secret = new Uint8Array(secret);
    this.#inquiry = new InquiryCursorCodec(this.#secret);
  }

  public fingerprint(value: unknown): string {
    return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
  }

  public encode(payload: Omit<ServingCursorPayload, 'version'>): string {
    const body = Buffer.from(JSON.stringify({ version: 1, ...payload }), 'utf8').toString(
      'base64url',
    );
    const signature = createHmac('sha256', this.#secret).update(body).digest('base64url');
    const cursor = `${body}.${signature}`;
    if (Buffer.byteLength(cursor, 'utf8') > 512) {
      throw new ProductionServingError('RESULT_TOO_LARGE', 'Cursor exceeds 512 bytes.');
    }
    return cursor;
  }

  public decode(
    cursor: string,
    expected: Readonly<{
      operation: NamedQueryName;
      releaseId: string;
      queryFingerprint: string;
    }>,
  ): readonly (number | string)[] {
    const payload = this.#decodeServing(cursor, expected.operation, expected.releaseId);
    if (payload.queryFingerprint !== expected.queryFingerprint) {
      throw staleCursor(expected.releaseId);
    }
    return payload.keys;
  }

  public validate(operation: NamedQueryName, releaseId: string, cursor: string): void {
    if (Buffer.byteLength(cursor, 'utf8') > 512) throw staleCursor(releaseId);
    const inquiry = inquiryByOperation[operation];
    if (inquiry !== undefined) {
      const untrusted = decodeUntrusted(cursor);
      const fingerprint = untrusted.queryFingerprint;
      if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(fingerprint)) {
        throw staleCursor(releaseId);
      }
      try {
        this.#inquiry.decode(cursor, { inquiry, releaseId, queryFingerprint: fingerprint });
      } catch (error) {
        throw staleCursor(releaseId, error);
      }
      return;
    }
    this.#decodeServing(cursor, operation, releaseId);
  }

  #decodeServing(
    cursor: string,
    operation: NamedQueryName,
    releaseId: string,
  ): ServingCursorPayload {
    if (Buffer.byteLength(cursor, 'utf8') > 512) throw staleCursor(releaseId);
    const [body, signature, extra] = cursor.split('.');
    if (body === undefined || signature === undefined || extra !== undefined) {
      throw staleCursor(releaseId);
    }
    const expectedSignature = createHmac('sha256', this.#secret).update(body).digest();
    const received = Buffer.from(signature, 'base64url');
    if (
      received.byteLength !== expectedSignature.byteLength ||
      !timingSafeEqual(received, expectedSignature)
    ) {
      throw staleCursor(releaseId);
    }
    const value = decodeUntrusted(cursor);
    if (
      value.version !== 1 ||
      value.operation !== operation ||
      value.releaseId !== releaseId ||
      typeof value.queryFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.queryFingerprint) ||
      !Array.isArray(value.keys) ||
      !(value.keys as unknown[]).every(
        (key) => typeof key === 'string' || (typeof key === 'number' && Number.isFinite(key)),
      )
    ) {
      throw staleCursor(releaseId);
    }
    const keys = (value.keys as unknown[]).map((key) => {
      if (typeof key === 'string') return key;
      if (typeof key === 'number' && Number.isFinite(key)) return key;
      throw staleCursor(releaseId);
    });
    return Object.freeze({
      version: 1,
      operation,
      releaseId,
      queryFingerprint: value.queryFingerprint,
      keys: Object.freeze(keys),
    });
  }
}

function decodeUntrusted(cursor: string): Readonly<Record<string, unknown>> {
  const [body] = cursor.split('.');
  if (body === undefined) throw staleCursor();
  try {
    const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError();
    return value as Readonly<Record<string, unknown>>;
  } catch (error) {
    throw staleCursor(undefined, error);
  }
}

function staleCursor(releaseId?: string, cause?: unknown): ProductionServingError {
  return new ProductionServingError(
    'STALE_OR_TAMPERED_CURSOR',
    'The cursor is invalid, stale, or belongs to another release or operation.',
    {
      ...(releaseId === undefined ? {} : { releaseId }),
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  throw new ProductionServingError('INVALID_REQUEST', 'Cursor input is not canonical JSON.');
}
