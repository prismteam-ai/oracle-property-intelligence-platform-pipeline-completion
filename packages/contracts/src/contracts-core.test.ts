import { describe, expect, it } from 'vitest';

import { oracleErrorSchema } from './errors.js';
import {
  artifactIdSchema,
  entityIdSchema,
  runIdSchema,
  snapshotIdSchema,
  sourceIdSchema,
} from './ids.js';
import { visibilitySchema } from './visibility.js';

const hash = 'a'.repeat(64);

describe('deterministic identifiers and visibility', () => {
  it('accepts namespaced deterministic Santa Clara identifiers', () => {
    expect(sourceIdSchema.parse('sc:source:scc-parcels')).toBe('sc:source:scc-parcels');
    expect(snapshotIdSchema.parse(`sc:snapshot:scc-parcels:${hash}`)).toContain(hash);
    expect(runIdSchema.parse(`sc:run:${hash}`)).toContain(hash);
    expect(artifactIdSchema.parse(`sc:artifact:sha256:${hash}`)).toContain(hash);
    expect(entityIdSchema.parse('sc:entity:property:apn-123')).toBe('sc:entity:property:apn-123');
  });

  it.each([
    'SC:source:scc-parcels',
    'sc:source:SCC-PARCELS',
    'sc:snapshot:scc-parcels:not-a-hash',
    'sc:run:1234',
    `sc:artifact:sha256:${'A'.repeat(64)}`,
    'sc:entity:unknown:123',
    'sc:entity:property:has spaces',
  ])('rejects malformed deterministic identifier %s', (value) => {
    expect(
      sourceIdSchema.safeParse(value).success ||
        snapshotIdSchema.safeParse(value).success ||
        runIdSchema.safeParse(value).success ||
        artifactIdSchema.safeParse(value).success ||
        entityIdSchema.safeParse(value).success,
    ).toBe(false);
  });

  it('freezes all four visibility classes and rejects additions', () => {
    expect(visibilitySchema.options).toEqual([
      'public',
      'authenticated',
      'restricted',
      'prohibited_public',
    ]);
    expect(visibilitySchema.safeParse('internal').success).toBe(false);
  });
});

describe('Oracle error taxonomy', () => {
  it('enforces retry classification for transient and policy errors', () => {
    expect(
      oracleErrorSchema.parse({
        code: 'TRANSIENT_SOURCE',
        retryable: true,
        message: 'upstream throttled',
      }).retryable,
    ).toBe(true);

    expect(
      oracleErrorSchema.safeParse({
        code: 'RESTRICTED_DATA_LEAK',
        retryable: true,
        message: 'restricted field reached public bytes',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown taxonomy members and extra object keys', () => {
    expect(
      oracleErrorSchema.safeParse({
        code: 'NETWORK_ERROR',
        retryable: true,
        message: 'generic',
      }).success,
    ).toBe(false);
    expect(
      oracleErrorSchema.safeParse({
        code: 'AUTHENTICATION',
        retryable: false,
        message: 'denied',
        secret: 'must not pass through',
      }).success,
    ).toBe(false);
  });
});
