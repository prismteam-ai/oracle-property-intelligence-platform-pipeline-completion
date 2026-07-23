import { licenseSnapshotSchema, type RatePolicy } from '@oracle/contracts/source';
import { sourceIdSchema } from '@oracle/contracts/ids';

import type { TransitFeedSnapshotConfig } from './types.js';

const DIRECT_RATE_POLICY: RatePolicy = Object.freeze({
  maxRequestsPerWindow: 1,
  windowMs: 60_000,
  maxConcurrency: 1,
  maxAttempts: 3,
  initialBackoffMs: 1_000,
  maxBackoffMs: 30_000,
  jitter: 'full',
  respectRetryAfter: true,
});

const VTA_SOURCE_ID = sourceIdSchema.parse('sc:source:vta-static-gtfs');
const CALTRAIN_SOURCE_ID = sourceIdSchema.parse('sc:source:caltrain-static-gtfs');

export const VTA_2026_07_15_SNAPSHOT: TransitFeedSnapshotConfig = Object.freeze({
  operator: 'vta',
  role: 'operator_primary',
  sourceId: VTA_SOURCE_ID,
  sourceName: 'VTA operator static GTFS',
  agencyId: 'VTA',
  agencyName: 'Santa Clara Valley Transportation Authority',
  url: 'https://gtfs.vta.org/gtfs_vta.zip',
  expectedZipSha256: '0920434ae18e204a7d5bd66ef7a7b02feec786c2f57ddaa081dcea4b20aa1af9',
  expectedZipBytes: 5_072_907,
  retrievedAt: '2026-07-17T13:00:00.000Z',
  sourceAsOf: { state: 'reported' as const, at: '2026-07-15T18:03:46.000Z' },
  feedStartDate: '2026-04-27',
  feedEndDate: '2026-08-09',
  selectedServiceDate: '2026-07-17',
  visibility: 'authenticated',
  license: licenseSnapshotSchema.parse({
    licenseSnapshotId:
      'sc:license:vta-static-gtfs:042407dfa3823555cb7103eb28a3d424ae453b353e73debed37c8e663aec33c7',
    capturedAt: '2026-07-17T13:00:00.000Z',
    title: 'VTA GTFS developer page (no explicit redistribution license observed)',
    canonicalUrl: 'https://gtfs.vta.org/',
    termsSha256: '042407dfa3823555cb7103eb28a3d424ae453b353e73debed37c8e663aec33c7',
    redistribution: 'unknown',
    containsPersonalData: false,
    attribution: ['Santa Clara Valley Transportation Authority (VTA)'],
    limitations: [
      'The official page publishes the feed for application development but did not state an explicit redistribution license when captured.',
      'Keep derived/public release authenticated or pending legal review until redistribution terms are approved.',
    ],
  }),
  ratePolicy: DIRECT_RATE_POLICY,
  requiresInjectedAuthorization: false,
});

export const CALTRAIN_2026_06_10_SNAPSHOT: TransitFeedSnapshotConfig = Object.freeze({
  operator: 'caltrain',
  role: 'operator_primary',
  sourceId: CALTRAIN_SOURCE_ID,
  sourceName: 'Caltrain operator static GTFS',
  agencyId: '1000',
  agencyName: 'Caltrain',
  url: 'https://data.trilliumtransit.com/gtfs/caltrain-ca-us/caltrain-ca-us.zip',
  expectedZipSha256: '786de3fea43ef033dbc9977d1617032a0ecff706e1621a6c9d5816a65e6d862a',
  expectedZipBytes: 178_695,
  retrievedAt: '2026-07-17T13:00:00.000Z',
  sourceAsOf: { state: 'reported' as const, at: '2026-06-10T22:21:13.000Z' },
  feedStartDate: '2026-01-31',
  feedEndDate: '2027-01-31',
  selectedServiceDate: '2026-07-17',
  visibility: 'public',
  license: licenseSnapshotSchema.parse({
    licenseSnapshotId:
      'sc:license:caltrain-static-gtfs:1474de29630c438447748270015bfb9993b684517fa1da03d7165b3322951290',
    capturedAt: '2026-07-17T13:00:00.000Z',
    title: 'Caltrain Developer License Agreement',
    canonicalUrl: 'https://www.caltrain.com/developer-resources',
    termsSha256: '1474de29630c438447748270015bfb9993b684517fa1da03d7165b3322951290',
    redistribution: 'approved',
    containsPersonalData: false,
    attribution: ['Peninsula Corridor Joint Powers Board (Caltrain)'],
    limitations: [
      'Do not use Caltrain trademarks, logo, System Map, or confusingly similar variants without approval.',
      'Data is provided as-is and the license is limited and revocable.',
    ],
  }),
  ratePolicy: DIRECT_RATE_POLICY,
  requiresInjectedAuthorization: false,
});
