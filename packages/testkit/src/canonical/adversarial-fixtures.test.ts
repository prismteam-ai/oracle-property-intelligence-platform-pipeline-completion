import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  invalidSantaClaraCoordinateArbitrary,
  santaClaraApnVariantArbitrary,
} from './adversarial-fixtures.js';

describe('canonical adversarial fixtures', () => {
  it('generates APN variants without losing leading zeroes', () => {
    fc.assert(
      fc.property(santaClaraApnVariantArbitrary, ({ raw, expected }) => {
        expect(raw.replace(/[- ./]/gu, '')).toBe(expected.replaceAll('-', ''));
        expect(expected).toMatch(/^\d{3}-\d{2}-\d{3}$/u);
      }),
    );
  });

  it('generates only out-of-bounds coordinate fixtures', () => {
    fc.assert(
      fc.property(invalidSantaClaraCoordinateArbitrary, ({ longitude, latitude }) => {
        expect(Math.abs(longitude) > 180 || Math.abs(latitude) > 90).toBe(true);
      }),
    );
  });
});
