import { createHmac, timingSafeEqual } from 'node:crypto';

import { API_LIMITS, type ApplicationOperation } from './contract.js';
import { ApiFailure } from './errors.js';

type CursorPayload = Readonly<{
  version: 1;
  operation: ApplicationOperation;
  releaseId: string;
  continuation: readonly (number | string)[];
}>;

export class ApiCursorCodec {
  readonly #secret: Uint8Array;

  public constructor(secret: Uint8Array) {
    if (secret.byteLength < 32)
      throw new RangeError('Cursor integrity secret must be at least 32 bytes.');
    this.#secret = new Uint8Array(secret);
  }

  public encode(payload: Omit<CursorPayload, 'version'>): string {
    const body = Buffer.from(JSON.stringify({ version: 1, ...payload }), 'utf8').toString(
      'base64url',
    );
    const signature = createHmac('sha256', this.#secret).update(body).digest('base64url');
    const cursor = `${body}.${signature}`;
    if (Buffer.byteLength(cursor, 'utf8') > API_LIMITS.cursorBytes)
      throw new ApiFailure('DATA_CORRUPTION');
    return cursor;
  }

  public decode(
    cursor: string,
    operation: ApplicationOperation,
    releaseId: string,
  ): readonly (number | string)[] {
    if (Buffer.byteLength(cursor, 'utf8') > API_LIMITS.cursorBytes)
      throw new ApiFailure('STALE_CURSOR');
    const [body, signature, extra] = cursor.split('.');
    if (body === undefined || signature === undefined || extra !== undefined)
      throw new ApiFailure('STALE_CURSOR');
    const expected = createHmac('sha256', this.#secret).update(body).digest();
    const received = Buffer.from(signature, 'base64url');
    if (received.byteLength !== expected.byteLength || !timingSafeEqual(received, expected))
      throw new ApiFailure('STALE_CURSOR');
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown;
    } catch {
      throw new ApiFailure('STALE_CURSOR');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new ApiFailure('STALE_CURSOR');
    const payload = value as Readonly<Record<string, unknown>>;
    if (
      payload.version !== 1 ||
      payload.operation !== operation ||
      payload.releaseId !== releaseId ||
      !Array.isArray(payload.continuation) ||
      !payload.continuation.every(
        (item) => typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item)),
      )
    )
      throw new ApiFailure('STALE_CURSOR');
    return Object.freeze(payload.continuation.map((item) => item as number | string));
  }
}
