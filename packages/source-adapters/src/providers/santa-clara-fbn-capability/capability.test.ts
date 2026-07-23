import { describe, expect, it } from 'vitest';

import {
  materializeSantaClaraFbnCapability,
  projectUnknownFbn,
  SANTA_CLARA_FBN_BLOCKED_CAPABILITY,
} from './capability.js';

describe('Santa Clara FBN capability', () => {
  it('materializes one dated terminal blocked decision without fabricated coverage', () => {
    expect(SANTA_CLARA_FBN_BLOCKED_CAPABILITY).toMatchObject({
      decision: 'blocked',
      supportState: 'unsupported',
      asOf: '2026-07-17T00:00:00.000Z',
      expectedRecords: null,
      observedRecords: 0,
      coverageRatio: null,
      acquisitionPermission: false,
      privateUsePermission: false,
      publicProjectionPermission: false,
    });
    expect(SANTA_CLARA_FBN_BLOCKED_CAPABILITY.reason).toContain('paid monthly');
    expect(SANTA_CLARA_FBN_BLOCKED_CAPABILITY.reason).toContain('no purchased immutable snapshot');
    expect(SANTA_CLARA_FBN_BLOCKED_CAPABILITY.evidenceSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(materializeSantaClaraFbnCapability('blocked')).toBe(SANTA_CLARA_FBN_BLOCKED_CAPABILITY);
  });

  it('fails the unsupported branch closed instead of fabricating supported FBN rows', () => {
    expect(() => materializeSantaClaraFbnCapability('supported')).toThrow(
      'no approved immutable snapshot and rights profile',
    );
  });

  it('returns a deterministic typed unknown projection and denies public visibility', () => {
    const businessId = `sc:entity:business:${'a'.repeat(64)}`;
    const first = projectUnknownFbn(businessId);
    const second = projectUnknownFbn(businessId);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      capabilityType: 'fbn',
      supportState: 'unsupported',
      value: null,
      sourceRecordIds: [],
      publicVisibility: 'prohibited_public',
    });
  });

  it('rejects a projection without a canonical business identity', () => {
    expect(() => projectUnknownFbn('fake-business')).toThrow('canonical Santa Clara business ID');
  });
});
