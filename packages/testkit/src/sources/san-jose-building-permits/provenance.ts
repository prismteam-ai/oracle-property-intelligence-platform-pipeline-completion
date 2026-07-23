export const SAN_JOSE_BUILDING_PERMIT_FIXTURE_PROVENANCE = Object.freeze({
  authority: 'City of San Jose Open Data',
  license: Object.freeze({
    id: 'cc-zero',
    title: 'Creative Commons CCZero',
    metadataUrl: 'https://data.sanjoseca.gov/api/3/action/package_show',
    legalCodeUrl: 'https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt',
    legalCodeSha256: 'a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499',
  }),
  extraction: Object.freeze({
    method:
      'Decode the complete official UTF-8 CSV with csv-parse 7.0.1, select the stated FOLDERRSN without altering field values, retain the official header order, serialize the two source lines with LF endings, and SHA-256 the committed excerpt.',
    mediaType: 'text/csv; charset=utf-8',
    sourceSemantics:
      'Each file is an independently modified City of San Jose permit-status snapshot. Matching permit identifiers across files remain separate feed observations; the excerpts do not establish a lifecycle or current ownership.',
  }),
  feeds: Object.freeze({
    active: Object.freeze({
      datasetId: 'fd9ceb0c-75e0-402e-9fe3-3f6e04f2c23f',
      resourceId: '761b7ae8-3be1-4ad6-923d-c7af6404a904',
      exactUrl:
        'https://data.sanjoseca.gov/dataset/fd9ceb0c-75e0-402e-9fe3-3f6e04f2c23f/resource/761b7ae8-3be1-4ad6-923d-c7af6404a904/download/buildingpermitsactive.csv',
      retrievedAt: '2026-07-17T13:13:15.215Z',
      sourceAsOf: '2026-07-17T11:02:50.000Z',
      originalArtifactSha256: 'f6254f86470703795ecc37588af81a56c622359f95c33b8e10cf671ca6f194db',
      originalByteSize: 5_874_191,
      originalRecordCount: 17_724,
      selectedSourceRowId: '2172720',
      excerptFile: 'active.csv',
      excerptByteSize: 570,
      excerptSha256: '798239cdbf1d9cce9fe4a7b97ee702411ff3721a7831ec3524004fffe2c3f83a',
    }),
    expired: Object.freeze({
      datasetId: '3b40d486-bd19-44c5-b854-5f0638c2afc3',
      resourceId: 'df4b8461-0c7a-4d16-b85d-ff7f71c5fed5',
      exactUrl:
        'https://data.sanjoseca.gov/dataset/3b40d486-bd19-44c5-b854-5f0638c2afc3/resource/df4b8461-0c7a-4d16-b85d-ff7f71c5fed5/download/buildingpermitsexpired.csv',
      retrievedAt: '2026-07-17T13:13:21.040Z',
      sourceAsOf: '2026-07-17T11:02:47.000Z',
      originalArtifactSha256: 'cbcb8f08d2ffe2e2dcdc197ec73e4fcf6c411d4f917cb7e6a1fb54d54d7ab933',
      originalByteSize: 25_140_269,
      originalRecordCount: 74_727,
      selectedSourceRowId: '1364088',
      excerptFile: 'expired.csv',
      excerptByteSize: 541,
      excerptSha256: '82db218cb2164e1c3ae510efb0144244a0bfe5faa6656285a7464b58a092b7d5',
    }),
    under_inspection: Object.freeze({
      datasetId: 'ca355e55-c651-4e00-9bde-2c014f229486',
      resourceId: '89ccdad9-7309-4826-a5f3-2fcf1fcb20fa',
      exactUrl:
        'https://data.sanjoseca.gov/dataset/ca355e55-c651-4e00-9bde-2c014f229486/resource/89ccdad9-7309-4826-a5f3-2fcf1fcb20fa/download/buildingpermitsunderinspection.csv',
      retrievedAt: '2026-07-17T13:13:54.147Z',
      sourceAsOf: '2026-07-17T11:02:43.000Z',
      originalArtifactSha256: '64392fabc3b520622c059ecf0894723740ef400cfef49deb31a71914ccdc1f68',
      originalByteSize: 3_945_282,
      originalRecordCount: 10_899,
      selectedSourceRowId: '2172720',
      excerptFile: 'under-inspection.csv',
      excerptByteSize: 579,
      excerptSha256: 'b8ee5206882e7822257ae14dd2dbbd1a77e9291094a0cc2a7bdb8467f4144e82',
    }),
  }),
});

export type SanJoseBuildingPermitFixtureFeed =
  keyof typeof SAN_JOSE_BUILDING_PERMIT_FIXTURE_PROVENANCE.feeds;
