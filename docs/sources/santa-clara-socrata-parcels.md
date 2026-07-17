# Santa Clara County Socrata parcels

- Source ID: `sc:source:santa-clara-socrata-parcels`
- Official dataset: `ubcd-cewv`
- Authority: County of Santa Clara
- Adapter contract: `1.0.0`

## Purpose and grain

This adapter acquires the County's official parcel inventory and cadastral
geometry from the Socrata SODA API. It is the county parcel-row denominator and
an input to APN reconciliation. It is not an assessor-roll denominator, a
building inventory, or a property-unit inventory.

The raw row key is `objectid`. APN is deliberately not used as the raw key:
the official source contains repeated APNs with distinct objectids and
geometries. Every source row is decoded, validated, and normalized. Repeated
APNs create separate lineage and geometry observations for later
classification; there is no first-row deduplication.

The `the_geom` value is a cadastral parcel boundary in CRS84. It is not a
rooftop, building centroid, entrance, geocode, or proof of an addressable unit.

## Official endpoints

- Catalog:
  `https://data.sccgov.org/Government/Parcels/ubcd-cewv/about_data`
- Metadata/schema:
  `https://data.sccgov.org/api/views/ubcd-cewv`
- GeoJSON pages:
  `https://data.sccgov.org/resource/ubcd-cewv.geojson`
- Backing ArcGIS identity reported by Socrata:
  `https://maps.santaclaracounty.gov/server/rest/services/property/SCCProperty/MapServer/0`

Anonymous discovery performs the following exact count queries independently:

| Denominator                   | SoQL                                             | Observed 2026-07-17 |
| ----------------------------- | ------------------------------------------------ | ------------------: |
| County rows                   | `count(*)`                                       |             502,789 |
| County distinct non-null APNs | `count(distinct apn)`                            |             495,188 |
| Palo Alto rows                | `count(*) where upper(jurisdiction)='PALO ALTO'` |              21,028 |
| Palo Alto distinct APNs       | `count(distinct apn)` with the same filter       |              21,007 |

These are discovery observations, not hard-coded success criteria. Each run
remeasures them. Palo Alto is always labeled a subset and never substitutes
for county completion. The County Assessor roll, existing Elephant rows, GIS
rows, and distinct APNs count different entities and must not be presented as
interchangeable.

## Acquisition and checkpoint contract

1. Fetch the official metadata and compare the ordered 23-column declaration
   against fingerprint
   `6d571cb415e68fa7e323faac9fd9202505f9b3b14be019c85a0d8684142206a1`.
2. Remeasure all four denominators above.
3. Build as many pages as the measured county row count requires. No source cap
   exists. Every page explicitly uses `$order=objectid ASC`, `$limit`, and
   `$offset`; the final page's `$limit` is the exact remaining row count. The
   immutable plan therefore carries its denominator as the validated sum of
   contiguous page limits, so a restarted adapter can enforce the count gate
   without process memory.
4. Retry only transient transport, HTTP 429, and HTTP 5xx failures within the
   injected rate policy. Authentication/access failures fail immediately.
5. Store the received bytes through the injected immutable artifact store and
   bind request/response metadata, SHA-256, byte size, media type, ETag,
   Last-Modified, source/snapshot IDs, schema fingerprint, raw URI, license
   snapshot, and visibility.
6. Commit the page checkpoint before yielding the acquired artifact. Resume
   skips committed request keys and rejects gaps or conflicting checkpoints.
7. Decode only from the acquired immutable bytes. Transport is unavailable in
   decode/validate/normalize phases.
8. A completed run whose decoded count differs from the discovered county row
   count is failed, not reported complete.

Source mutation during a long offset-paginated run remains detectable through
the count gate and immutable per-page metadata. A future source-supported
cursor or export snapshot can replace the pagination strategy behind the same
adapter phase contract.

## Validation and normalization

Required row checks are:

- positive numeric `objectid` within the safe integer range needed to derive
  deterministic mutation sequences;
- APN normalizable to exactly eight digits (spaces and hyphens are accepted as
  formatting inputs, but malformed values are quarantined);
- non-empty jurisdiction;
- `MultiPolygon` geometry in
  `urn:ogc:def:crs:OGC:1.3:CRS84`;
- finite longitude/latitude bounds and closed rings.

The canonical property ID is deterministic from
`santa-clara-ca|apn|<normalized-apn>`. Because multiple raw rows may resolve to
that property, the adapter also emits a separate field observation for every
row geometry and every source property. Each observation includes:

- source, snapshot, artifact, `objectid`, raw feature SHA-256, and raw pointer;
- transform name/version, deterministic input/output hashes, and application
  instant bound to acquisition metadata;
- authority rank, source-as-of, confidence, and unchanged visibility.

This preserves competing geometries and source values for downstream conflict
classification rather than choosing whichever row arrived first.

Although the source includes `shape_area`, the captured metadata does not prove
that field's unit is square metres. The adapter retains the raw value and its
lineage at `/source/shape_area` but leaves canonical
`landAreaSquareMeters: null` until an authoritative unit definition is frozen.

## Visibility and rights

The source is publicly readable and source records/mutations preserve
`public` visibility. The metadata snapshot inspected on 2026-07-17 did not
declare an explicit redistribution license and contains the County's GIS
accuracy/completeness disclaimer. Therefore public read visibility is not, by
itself, permission to publish a derived aggregate to IPFS. Release-level legal
classification and publication eligibility remain separate fail-closed gates.

The adapter contains no owner names, credentials, or secret access path.

## Committed official fixture

The testkit contains the complete official two-feature response for APN
`12769001`, ordered by objectid (`10649`, `10650`). The rows are real Palo Alto
records with distinct geometries.

- Exact request:
  `https://data.sccgov.org/resource/ubcd-cewv.geojson?%24where=apn%3D%2712769001%27&%24order=objectid&%24limit=2`
- Retrieval time: `2026-07-17T12:59:10.000Z`
- Source as-of / Last-Modified: `2026-03-23T07:08:59.000Z`
- Original response: 2,536 bytes, SHA-256
  `83a182ad224c9ac67b034cec242f22aca8d4ff73f9d3d103f34a102c910444b8`
- Committed file: the same JSON values and key/feature/coordinate order,
  deterministically pretty-printed, 3,699 bytes, SHA-256
  `5a6579c59fbe93034334ed8f4ff16b75851369b31b2bada7fcdebd7b3b2de433`
- Media type: `application/vnd.geo+json; charset=UTF-8`

`fixture-provenance.json` records the authority, catalog/backing source,
exact URL and query, anonymous access, retrieval/source-as-of instants,
original and committed hashes/sizes, extraction method, media type/ETag, and
source semantics. Tests verify both the bytes and duplicate-row meaning.

## Test coverage

Focused tests cover live-shape discovery, all four denominators, schema drift,
malformed count responses, uncapped stable ordering, pagination, checkpoint
resume, artifact immutability, transient retry, abort propagation, real
duplicate APNs, malformed objectid/APN/jurisdiction/CRS/coordinates/rings,
deterministic mutations, complete lineage, public visibility preservation, and
count mismatch failure.
