export const TEST_TIMESTAMPS = Object.freeze({
  discoveredAt: '2026-07-17T09:00:00.000Z',
  sourceAsOf: '2026-07-16T00:00:00.000Z',
  retrievedAt: '2026-07-17T09:01:00.000Z',
});

export const TEST_SOURCE_BYTES = Object.freeze({
  csv: 'apn,address\n123-45-678,250 Hamilton Ave\n',
  geojson:
    '{"type":"Feature","geometry":{"type":"Point","coordinates":[-122.143,37.442]},"properties":{"apn":"123-45-678"}}',
  zipEntry: 'stops.txt',
  pbfLayer: 'transportation',
  geotiffBand: 1,
});

export const TEST_VISIBILITIES = Object.freeze([
  'public',
  'authenticated',
  'restricted',
  'prohibited_public',
] as const);
