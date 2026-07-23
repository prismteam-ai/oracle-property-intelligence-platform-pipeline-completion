export const SANTA_CLARA_OWNERSHIP_FIXTURE_PROVENANCE = Object.freeze({
  capturedAt: '2026-07-17T00:00:00.000Z',
  authority: 'County of Santa Clara Office of the Clerk-Recorder',
  fixtures: Object.freeze([
    Object.freeze({
      file: 'official-data-sales-excerpt.html',
      sourceUrl:
        'https://clerkrecorder.santaclaracounty.gov/official-records/subscribe-data-sales-reports/additional-information-related-data-sales',
      sha256: '121f3cf3441489de2d5088f28aaa91105a7cdc47643ab348ee7680d18f8a491f',
      classification: 'minimal_public_official_page_excerpt',
    }),
    Object.freeze({
      file: 'official-research-access-excerpt.html',
      sourceUrl:
        'https://clerkrecorder.santaclaracounty.gov/official-records/researching-real-estate-documents/request-and-purchase-copies-recorded-documents/additional-information-related-to-purchasing',
      sha256: '5418f66594360d3376853215ea217e03bd4eaf0a32c4a845af7a3add05ceb12c',
      classification: 'minimal_public_official_page_excerpt',
    }),
    Object.freeze({
      file: 'official-fee-schedule-excerpt.html',
      sourceUrl: 'https://clerkrecorder.santaclaracounty.gov/resources/fee-schedule',
      sha256: '216033000bc10489aacb1c55d79e470b5813a31bb1047c79e85058c22b26645a',
      classification: 'minimal_public_official_page_excerpt',
    }),
  ]),
  containsOwnerBearingRows: false,
  containsPersonalData: false,
  limitations: Object.freeze([
    'Excerpts prove only the official product, field, access, and fee capability statements.',
    'They contain no grantor/grantee names, instrument rows, APNs, addresses, or ownership claims.',
    'They are not a substitute for an approved full subscribed index snapshot.',
  ]),
});
