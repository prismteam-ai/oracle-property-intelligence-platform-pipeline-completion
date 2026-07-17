export const CA_SOS_BUSINESS_FIXTURE_PROVENANCE = Object.freeze({
  authority: 'California Secretary of State, Business Programs Division',
  sourceRoute: 'bizfile Online public business search',
  sourceUrl: 'https://bizfileonline.sos.ca.gov/api/Records/businesssearch',
  sourceObservedAt: '2026-05-16T00:00:00.000Z',
  fixtureCreatedAt: '2026-07-17T00:00:00.000Z',
  fixturePath: 'official-bizfile-safe-excerpt.csv',
  fixtureSha256: 'dc2076f6c0c4df261c74d471cf1a620c3b6ab9901dac271e074fbd631da5bc6d',
  extractionMethod:
    'Selected one real public search result and retained only entity number, legal name, entity type, status, initial filing date, and jurisdiction; agent and all address fields were deliberately omitted.',
  sourceSemantics:
    'The excerpt is entity-registration evidence. It is not a beneficial-ownership record and does not establish a property or permit relationship.',
  bulkRoute: Object.freeze({
    recordsPage:
      'https://www.sos.ca.gov/administration/public-records-act-requests/business-entity-records',
    portalManual: 'https://bpd.cdn.sos.ca.gov/ucc/ucc-online-help.pdf',
    recordsPageRetrievedAt: '2026-07-17T00:00:00.000Z',
    recordsPageByteSize: 57_286,
    recordsPageSha256: '112766f8e79387c920de93678f2b1f92dd196358acf9ee2d156242f7fbf6e86e',
    process:
      'Order BE master or weekly bulk data in authenticated bizfile Online, then download the generated ZIP. The adapter consumes a source-locked immutable artifact rather than scraping public search.',
  }),
  legal: Object.freeze({
    redistribution: 'unknown',
    containsPersonalData: true,
    visibility: 'prohibited_public',
    rationale:
      'Public availability does not establish unrestricted bulk redistribution; all normalized output remains prohibited_public until release-specific legal review.',
  }),
});
