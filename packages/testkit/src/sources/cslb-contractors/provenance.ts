export const CSLB_SAFE_FIXTURE_PROVENANCE = Object.freeze({
  authority: 'California Contractors State License Board',
  portalUrl: 'https://web.cslb.ca.gov/onlineservices/dataportal/ContractorList',
  snapshotAsOf: '2026-07-17',
  boundedPrefixRetrievalStartedAt: '2026-07-17T14:47:56.001Z',
  lastVerifiedAt: '2026-07-17T14:48:01.014Z',
  boundedPrefixBytes: 1_048_576,
  boundedPrefixSha256: '85aee63a6f2de0d9be3a37316fb94d90f84f26192e4beb5399e1d5bbfad8da3e',
  fixtureFile: 'official-master-safe-excerpt.json',
  fixtureSha256: 'f5b0afa90ebb5803407b860dc1aded3ad4de3306aa544307f7c69299673b51b4',
  fullSnapshotDownloadedForFixture: false,
  visibility: 'authenticated',
  derivation:
    'Safe-field projection of two real corporate records from a bounded prefix of the official no-cost License Master CSV.',
  limitations: Object.freeze([
    'The fixture is not a completeness sample.',
    'Street, phone, policy-number, bond-number, and personnel-like fields were omitted.',
    'The source does not state an open redistribution license.',
  ]),
});
