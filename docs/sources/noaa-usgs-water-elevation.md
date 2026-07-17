# NOAA/USGS water and terrain source family

This provider implements ORA-042 as three independently identified, immutable source snapshots behind one lane-local adapter family:

1. the current NOAA Continually Updated Shoreline Product (CUSP) West regional archive resolved from the National Shoreline Data Explorer catalog;
2. the current USGS 3D Hydrography Program (3DHP) Flowline and Waterbody service layers; and
3. the current USGS 3D Elevation Program (3DEP) bare-earth dynamic elevation service.

The factories are intentionally lane-local. They are not registered or composed by this change.

## Semantic boundary

These sources provide reference inputs, not final property assertions.

- NOAA shoreline is a surveyed or interpreted land-water interface. It is not a parcel, jurisdictional, setback, or other legal boundary.
- A hydrographic feature, shoreline, or proximity to either does not prove that a property has a water view.
- The 3DEP service is a bare-earth terrain mosaic. Terrain line-of-sight does not model buildings, trees, windows, observer height, orientation, weather, or local obstructions.
- The adapter can emit only a `candidate` water-view input. `verified_view` is rejected at the source boundary.
- Straight-line proximity and terrain references must not be presented as a walking route or visible-view determination.

Every accepted record carries these limitations, its authority and product version, exact artifact lineage, source-as-of time, attribution, and the immutable acquired-byte hash.

## Sources and pinned product identity

### NOAA CUSP / National Shoreline

- Catalog: <https://nsde.ngs.noaa.gov/>
- Resolved current West archive: <https://geodesy.noaa.gov/dist_shoreline/West.zip>
- Observed `Last-Modified`: `2026-03-24T17:25:55.000Z`
- Observed ETag: `"28897d9-64dc8719a4ec0"`
- Observed byte length: `42,506,201`
- Observed SHA-256: `d07277208ab4399b2e62ed6e86d86bbb5cbc7d92cc0bfa499cf156712693b1d6`
- Archive CRS: EPSG:4269 NAD83 / decimal degrees, verified from `West.prj`; normalized to EPSG:4326 using EPSG:1188 with its stated 4 m accuracy
- Accuracy and vintage: per-record `HOR_ACC`, `SRC_DATE`, source, creator, and region fields; no archive-wide accuracy claim

The catalog-resolved archive is used instead of the retired/legacy shoreline landing page. The archive is mutable, so a production run must preserve the response bytes, SHA-256, ETag, Last-Modified value, retrieval time, and record-level survey/source metadata. The archive incorporates NOAA and non-NOAA records. Its descriptor therefore uses redistribution `unknown`; downstream publication must retain record-level source credit and complete any required rights review.

The current production configuration freezes the exact West archive identity listed above. Both discovery HEAD metadata and acquired GET headers/bytes must match its length, ETag, Last-Modified value, and SHA-256 or the run fails closed. Because archive-wide redistribution remains unknown, shoreline artifacts and mutations default to `authenticated`, never `public`.

### USGS 3DHP hydrography

- Catalog: <https://www.usgs.gov/3d-hydrography-program/access-3dhp-data-products>
- Current service: <https://3dhp.nationalmap.gov/arcgis/rest/services/usgs_3dhp_all/FeatureServer>
- Layers: Flowline `50` and Waterbody `60`
- Observed service version: ArcGIS `11.3`; data refreshed `2026-06-26`
- Query CRS: EPSG:4326 output, with the service's native Web Mercator coordinates never silently relabeled
- License state: USGS open/non-proprietary data; USGS acknowledgment retained

The adapter queries both layers with a deterministic envelope, `OBJECTID` ordering, explicit page size, and immutable response hashes. Legacy NHD/NHDPlus products are not selected as the current source. A current 3DHP feature may still declare a supplemented legacy work-unit source; that provenance is preserved and is not treated as selecting a retired product.

### USGS 3DEP elevation

- Catalog: <https://www.usgs.gov/the-national-map-data-delivery/gis-data-download>
- Current dynamic service: <https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer>
- Observed holdings date: `2026-06-23`; observed service credit date: `2026-06-24`
- Export: Float32 GeoTIFF, explicit bounds, output CRS, dimensions, bilinear interpolation, and LZW compression
- Horizontal CRS: EPSG:4326 for the requested export
- Vertical datum/units: NAVD88/meters is typical for CONUS; the contributing source-project metadata remains authoritative
- Accuracy/nodata: decoded per export/source tile; no blanket dynamic-mosaic accuracy or nodata assertion
- License state: USGS-authored products are public domain; USGS acknowledgment retained

The normalized entity is an `elevation-raster-ref`, not an inlined county raster. It preserves bounds, approximate horizontal resolution, vertical datum, immutable artifact identity, and lineage. The underlying exact GeoTIFF remains the authoritative raster artifact.

## Acquisition and reproducibility

The provider keeps transport separate from ZIP/DBF/SHP, GeoJSON, and GeoTIFF decoding. Discovery and acquisition receive the injected HTTP transport; decoding receives only immutable acquired bytes. Anonymous official-source reads are sufficient and no provider credentials are read.

For each product the run performs:

1. discover the exact current artifact or deterministic API resources;
2. validate that discovery contains exactly the adapter-generated keys and deterministic URLs, then plan ordered, replayable requests;
3. acquire bytes with bounded retries for HTTP 429/5xx and `Retry-After` support;
4. verify non-empty bytes (plus the frozen NOAA archive identity), store them immutably by SHA-256, verify the returned stored descriptor, and persist its immutable URI as `rawUri`;
5. commit a checkpoint after each artifact so a replay skips completed request keys;
6. decode and validate geometry, bounds, schema, CRS, raster dimensions, and nodata accounting;
7. emit deterministic canonical mutations with source-record and transformation hashes while preserving source visibility; and
8. summarize artifact, byte, record, visibility, warning, and error counts.

Abort signals are checked before I/O and while collecting, decoding, and normalizing. Authentication/authorization and malformed-data failures are not retried as transient failures. Checkpoint conflicts fail closed.

The default Santa Clara clipping envelope is `[-122.25, 36.85, -121.15, 37.55]`. Operators may inject a tighter valid WGS 84 envelope and bounded hydro page/elevation image sizes. Full county artifacts must remain in the immutable artifact store; they must not be committed to Git.

## Minimal official fixtures

Only tiny, provenance-recorded excerpts are committed. They prove format boundaries and semantic behavior; they are not production county data.

| Fixture                                | Derivation                                                                                                                                                                                                                                                    | Pinned hash                                                                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `noaa-cusp-west-record-8.geojson`      | From exact `West.zip` bytes above: pair `West.shp` record 8 with `West.dbf` row 8 (zero-based index 7), decode the polyline and fields, and serialize one deterministic Prettier 3.9.5-formatted GeoJSON feature. The selected record says `DAT_SET_CR=NOAA`. | Excerpt SHA-256 `6a478ce433972351d56bf0e39beb96087e56dd6e1ff6f07c64f3623b4baf4e83`                                                                                                          |
| `usgs-3dhp-flowline-11jsf.geojson`     | Parse the exact official 672-byte layer-50 response for the documented Santa Clara envelope, EPSG:4326 output, and `OBJECTID` order; serialize the unchanged JSON value with Prettier 3.9.5 and an LF ending.                                                 | Original SHA-256 `17686813a1437c7f0e8a30ec0d61609f304b7196af6dcd22274a1e0c3631eb80`; committed 917-byte SHA-256 `a28f691a9577375406483093259b0947a33dd666cde0d18a71bc651e1038a837`          |
| `usgs-3dep-alviso-8x8.tiff.base64.txt` | Exact official 8×8 Float32 GeoTIFF export for `[-121.9500,37.4200,-121.9496,37.4204]`, stored as base64 text to avoid committing a TIFF binary.                                                                                                               | Decoded 1,523-byte TIFF SHA-256 `3883f1e08b8b86bab89f771c9f7c04465e3c94acf1b44aac8bfff9201b951ea7`; encoded file SHA-256 `5947a698e55dfd51bf7a49105afbea68236d0af4483c73bce1c6dfc7a6906302` |

Machine-readable retrieval and deterministic extraction details live next to the fixtures in `packages/testkit/src/sources/noaa-usgs-water-elevation/provenance.ts`. Tests verify those byte sizes and hashes before using the excerpts.

## Verification

From the repository root, with Node 22 first on `PATH`:

```powershell
$env:PATH='E:\nvm\v22.18.0;' + $env:PATH
pnpm --filter @oracle/source-adapters exec vitest run src/providers/noaa-usgs-water-elevation
pnpm --filter @oracle/testkit exec vitest run src/sources/noaa-usgs-water-elevation
pnpm --filter @oracle/source-adapters typecheck
pnpm --filter @oracle/testkit typecheck
```

The focused tests cover official fixture integrity, malformed/missing archive members, schema drift, duplicate elements, supported geometry and validity, WGS 84/Web Mercator conversion, clipping, raster dimensions and nodata windows, current-versus-retired product rejection, retry classification, 429 handling, checkpoint resume, abort, deterministic mutations, lineage, attribution, visibility, summary accounting, and the strict no-view-claim rule.
