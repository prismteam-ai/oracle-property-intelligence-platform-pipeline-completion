import { describe, expect, it } from 'vitest';

import { normalizeSantaClaraApn, santaClaraPropertyId } from './apn.js';

describe('Santa Clara APN normalization', () => {
  it('normalizes punctuation variants and preserves leading zeroes', () => {
    for (const variant of ['001-02-003', '00102003', '001 02 003', '001.02.003', '001/02/003']) {
      expect(normalizeSantaClaraApn(variant)).toBe('001-02-003');
      expect(santaClaraPropertyId(variant)).toBe(santaClaraPropertyId('001-02-003'));
    }
  });

  it('uses the frozen county-scoped property identity seed', () => {
    expect(santaClaraPropertyId('123-45-678')).toBe(
      'sc:entity:property:3dee1d84e721c00d26ac5df2963f8bc116d62a32b11fb3c6e73453b8a2e83c31',
    );
  });

  it.each(['', '123-45-67', '123-45-6789', '123-AB-678'])('rejects malformed APN %j', (value) => {
    expect(() => normalizeSantaClaraApn(value)).toThrow(/eight digits|empty/u);
  });
});
