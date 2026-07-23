export const MTC_PALO_ALTO_FIXTURE_PROVENANCE = Object.freeze({
  authority: 'Metropolitan Transportation Commission / Bay Area Metro',
  datasetId: 'c252-zdg8',
  backingAuthorityArtifact:
    'https://services6.arcgis.com/evmyRZRrsopdeog7/ArcGIS/rest/services/AssessorsParcels/FeatureServer/0',
  retrievedAt: '2026-07-17T13:01:18.800Z',
  sourceAsOf: '2026-07-06T12:46:40.000Z',
  artifacts: Object.freeze({
    rows: Object.freeze({
      exactUrl:
        'https://data.bayareametro.gov/resource/c252-zdg8.json?$select=objectid,gid,apn,yearbuilt,effectiveyearbuilt,zonegis,floodzone,nearcreekfeature,x,y,the_geom,addressdescription,modifieddate&$where=apn=%27132-38-069%27&$order=objectid%20ASC',
      originalArtifactSha256: '83dd4d6d652be9762d69a679cc83472855d2db6a3fc8973c009c413ad7773daf',
      originalByteSize: 1_137,
      excerptSha256: '138c28392b77f05994a1990a157241e84d9ec8074ac1c77da1dc51319b3b4e4c',
      excerptByteSize: 1_609,
      mediaType: 'application/json;charset=utf-8',
      extractionMethod:
        'Parsed the complete two-row query response and reserialized every selected field as a two-space-indented JSON excerpt.',
      sourceSemantics:
        'Two distinct source rows and addresses share one APN; both rows and their identical parcel geometry are intentionally retained.',
    }),
    socrataMetadata: Object.freeze({
      exactUrl: 'https://data.bayareametro.gov/api/views/c252-zdg8',
      originalArtifactSha256: '0e157ee43ad02b02d7fef03d286ada8a8b33df85faa855d5b3c1651e812c5f8a',
      originalByteSize: 14_561,
      excerptSha256: 'b77cd2ab92abb0910be7f94447a314fde56d31e9a8f7102403f5669bd635bcc4',
      excerptByteSize: 1_462,
      mediaType: 'application/json; charset=utf-8',
      extractionMethod:
        'Selected dataset identity, official provenance, update time, required field declarations, read grant, and the complete ArcGIS connection object.',
      sourceSemantics:
        'Socrata metadata identifies c252-zdg8 as official and retains the backing ArcGIS FeatureServer URL; it states no redistribution license.',
    }),
    arcgisMetadata: Object.freeze({
      exactUrl:
        'https://services6.arcgis.com/evmyRZRrsopdeog7/ArcGIS/rest/services/AssessorsParcels/FeatureServer/0?f=pjson',
      originalArtifactSha256: '6cb3dfc7cbd19c4375cd4b28bc83e9145549ba03dfd4f19ec4637c5605b92c17',
      originalByteSize: 25_838,
      excerptSha256: 'cfaa91a01b2f64df316e84adbf08030e971b004a498144df2c6abbe32555f975',
      excerptByteSize: 1_633,
      mediaType: 'application/json; charset=utf-8',
      extractionMethod:
        'Selected layer identity, object ID, geometry type, full extent/CRS, and fields consumed by this adapter.',
      sourceSemantics:
        'The ArcGIS layer declares EPSG:2227 for native X/Y and the Socrata projection supplies WGS84 GeoJSON geometry.',
    }),
  }),
  legal: Object.freeze({
    redistribution: 'unknown',
    publicVisibility: 'prohibited_public',
    rationale:
      'Anonymous public read access is not evidence of redistribution permission; eligibility remains pending.',
  }),
});
