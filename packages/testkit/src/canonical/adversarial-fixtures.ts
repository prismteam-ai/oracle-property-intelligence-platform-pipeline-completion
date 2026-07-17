import fc from 'fast-check';

export const santaClaraApnVariantArbitrary = fc
  .tuple(
    fc.integer({ min: 0, max: 999 }),
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 0, max: 999 }),
    fc.constantFrom('-', ' ', '.', '/'),
  )
  .map(([book, page, parcel, separator]) => {
    const segments = [
      book.toString().padStart(3, '0'),
      page.toString().padStart(2, '0'),
      parcel.toString().padStart(3, '0'),
    ] as const;
    return Object.freeze({
      raw: segments.join(separator),
      expected: segments.join('-'),
    });
  });

export const invalidSantaClaraCoordinateArbitrary = fc.oneof(
  fc.record({
    longitude: fc.double({ min: 180.000_001, noNaN: true }),
    latitude: fc.double({ min: -90, max: 90, noNaN: true }),
  }),
  fc.record({
    longitude: fc.double({ min: -180, max: 180, noNaN: true }),
    latitude: fc.double({ min: 90.000_001, noNaN: true }),
  }),
);
