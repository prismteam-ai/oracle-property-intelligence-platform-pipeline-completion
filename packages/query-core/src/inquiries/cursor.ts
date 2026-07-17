import { createHmac, timingSafeEqual } from 'node:crypto';

import type { InquiryName } from './contracts.js';

type CursorPayload = Readonly<{
  version: 1;
  inquiry: InquiryName;
  releaseId: string;
  queryFingerprint: string;
  keys: readonly (number | string)[];
}>;

function parsePayload(value: unknown): CursorPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Cursor payload must be an object');
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  if (
    candidate.version !== 1 ||
    typeof candidate.inquiry !== 'string' ||
    typeof candidate.releaseId !== 'string' ||
    typeof candidate.queryFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(candidate.queryFingerprint) ||
    !Array.isArray(candidate.keys) ||
    !candidate.keys.every(
      (key) => typeof key === 'string' || (typeof key === 'number' && Number.isFinite(key)),
    )
  ) {
    throw new TypeError('Cursor payload is invalid');
  }
  return candidate as CursorPayload;
}

export class InquiryCursorCodec {
  readonly #secret: Uint8Array;

  public constructor(secret: Uint8Array) {
    if (secret.byteLength < 32)
      throw new RangeError('Cursor integrity secret must be at least 32 bytes');
    this.#secret = new Uint8Array(secret);
  }

  public encode(payload: Omit<CursorPayload, 'version'>): string {
    const body = Buffer.from(JSON.stringify({ version: 1, ...payload }), 'utf8').toString(
      'base64url',
    );
    const signature = createHmac('sha256', this.#secret).update(body).digest('base64url');
    const cursor = `${body}.${signature}`;
    if (Buffer.byteLength(cursor, 'utf8') > 512) throw new RangeError('Cursor exceeds 512 bytes');
    return cursor;
  }

  public decode(
    cursor: string,
    expected: Readonly<{ inquiry: InquiryName; releaseId: string; queryFingerprint: string }>,
  ): readonly (number | string)[] {
    if (Buffer.byteLength(cursor, 'utf8') > 512) throw new RangeError('Cursor exceeds 512 bytes');
    const segments = cursor.split('.');
    if (segments.length !== 2) throw new TypeError('Cursor format is invalid');
    const body = segments[0];
    const signature = segments[1];
    if (body === undefined || signature === undefined)
      throw new TypeError('Cursor format is invalid');
    const expectedSignature = createHmac('sha256', this.#secret).update(body).digest();
    let received: Buffer;
    try {
      received = Buffer.from(signature, 'base64url');
    } catch (error) {
      throw new TypeError('Cursor signature is invalid', { cause: error });
    }
    if (
      received.byteLength !== expectedSignature.byteLength ||
      !timingSafeEqual(received, expectedSignature)
    ) {
      throw new TypeError('Cursor signature is invalid');
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown;
    } catch (error) {
      throw new TypeError('Cursor payload is invalid', { cause: error });
    }
    const payload = parsePayload(decoded);
    if (payload.inquiry !== expected.inquiry || payload.releaseId !== expected.releaseId) {
      throw new TypeError('Cursor is stale or belongs to another inquiry');
    }
    if (payload.queryFingerprint !== expected.queryFingerprint) {
      throw new TypeError('Cursor belongs to a different normalized query');
    }
    return Object.freeze([...payload.keys]);
  }
}
