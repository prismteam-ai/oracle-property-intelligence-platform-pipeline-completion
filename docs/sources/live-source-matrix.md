# Live Santa Clara source matrix

Initial discovery audit completed at `2026-07-17T20:22:15.708Z` from repository
HEAD `a23561449b207af98794f9517768010782dd844a` with Node `22.18.0`; corrected
pilot `p2` completed at `2026-07-17T20:52:40.073Z`, and fresh pilot `p3`
completed at `2026-07-17T21:02:34.464Z`. Pilot `p4` acquired the previously
blocked NOAA archive and completed at `2026-07-17T21:14:49.093Z`; `p5` exposed a
fresh-download timeout, and bounded-timeout pilot `p6` completed at
`2026-07-17T21:26:37.471Z`. The audit called
each adapter's discovery phase where the live contract permits it. For
operator-locked, credentialed, or very large sources it performed only the
bounded official identity check allowed by that contract. It did not publish,
update a pointer, persist source payloads, or treat a fixture as county data.

This is a point-in-time source audit, not a full-county run summary. A source is
`live_verified` only for the checks named below. Full acquisition must still
create immutable artifacts, recompute hashes/counts, decode every row, and pass
the adapter's terminal accounting gates.

## Results

| Source or capability                | Source ID                                       | Live result                       | Redacted evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Production state                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | ----------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Santa Clara County parcels          | `sc:source:santa-clara-socrata-parcels`         | `live_verified`                   | 502,789 county rows; 495,188 distinct non-null APNs; 21,028 Palo Alto rows; 21,007 Palo Alto distinct APNs; schema `6d571cb415e68fa7e323faac9fd9202505f9b3b14be019c85a0d8684142206a1`                                                                                                                                                                                                                                                                                                                                                                                              | Anonymous discovery passed. Full acquisition is uncapped, ordered by `objectid`, and must reproduce the discovered county-row denominator.                                                                                                                                                                               |
| City of San Jose permits            | `sc:source:san-jose-building-permits`           | `live_verified`                   | Active: 17,724 rows, 5,874,191 bytes, `f6254f86470703795ecc37588af81a56c622359f95c33b8e10cf671ca6f194db`; expired: 74,727 rows, 25,140,269 bytes, `cbcb8f08d2ffe2e2dcdc197ec73e4fcf6c411d4f917cb7e6a1fb54d54d7ab933`; under inspection: 10,899 rows, 3,945,282 bytes, `64392fabc3b520622c059ecf0894723740ef400cfef49deb31a71914ccdc1f68`; all three schema `2b232748fbdba4ab6ee0331412232b77c73cf7529261a7ea66b45bf1bf352fe7`                                                                                                                                                      | All three complete CSVs matched the frozen contract. Coverage is San Jose only and is never a county permit denominator.                                                                                                                                                                                                 |
| MTC / Palo Alto assessor enrichment | `sc:source:mtc-palo-alto-year-built`            | `live_verified`                   | 25,503 rows; schema `39805297edf4d0ecb06ae93be45d84fc5c22f49c7eb06da58c12b56e0b198129`; source as-of `2026-07-06T12:46:40.000Z`                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Anonymous discovery passed. This is a Palo Alto subset enrichment with `prohibited_public` output, not county completion or proof of roof age/water view.                                                                                                                                                                |
| VTA direct static GTFS              | `sc:source:vta-static-gtfs`                     | `live_verified`                   | 5,072,907 bytes; `0920434ae18e204a7d5bd66ef7a7b02feec786c2f57ddaa081dcea4b20aa1af9`; last modified `2026-07-15T18:03:46Z`                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Exact direct ZIP matched. Redistribution remains `unknown`/authenticated under the captured terms.                                                                                                                                                                                                                       |
| Caltrain direct static GTFS         | `sc:source:caltrain-static-gtfs`                | `p3_verified`                     | 178,695 bytes; `786de3fea43ef033dbc9977d1617032a0ecff706e1621a6c9d5816a65e6d862a`; last modified `2026-06-10T22:21:13Z`; `p2` found 260 structurally valid `trips.txt` records plus one whitespace-only physical row at line 783. Fresh `p3`: terminal `complete`, 1 artifact, 1 decoded/accepted feed, 0 rejected feeds, 106 mutations.                                                                                                                                                                                                                                           | Exact direct ZIP matched. The adapter ignores only all-whitespace physical rows and still rejects nonblank column drift. Fresh `p3` confirmed end-to-end decode, validation, normalization, and terminal accounting.                                                                                                     |
| 511 Bay Area GTFS fallback          | `sc:capability:511-gtfs-fallback`               | `configured_blocked`              | Public capability page: 106,566 bytes; `26dd40ef1fcb7ccb42adf69678d82f8bc15d2f7f55e0c582528f3ac8d4e71eac`; no feed bytes acquired                                                                                                                                                                                                                                                                                                                                                                                                                                                  | An injected API credential and a frozen operator snapshot are required. 511 is fallback/parity only and cannot displace either direct feed.                                                                                                                                                                              |
| OpenStreetMap pedestrian graph      | `sc:source:osm-pedestrian-graph`                | `identity_verified_lock_required` | Dated Geofabrik PBF: 646,753,595 bytes; ETag `268cad3b-656af935b1984`; last modified `2026-07-16T00:32:31Z`; distributor MD5 `e30b21d7c7cfd4c9e6f4f11cae3bfaa0`                                                                                                                                                                                                                                                                                                                                                                                                                    | HEAD identity matched. The production adapter still requires the complete acquired-file SHA-256 before it can instantiate a truthful pinned snapshot. No full PBF was downloaded in this audit.                                                                                                                          |
| NOAA CUSP shoreline                 | `sc:source:noaa-cusp-shoreline`                 | `p6_verified`                     | Frozen contract: 42,506,201 bytes; SHA-256 `d07277208ab4399b2e62ed6e86d86bbb5cbc7d92cc0bfa499cf156712693b1d6`; source as-of `2026-03-24T17:25:55Z`. `p4` acquired and checkpointed those exact bytes, then failed decode with legacy error code `Error`. Its 167-byte `.prj` (SHA-256 `84cf5b9a3c1a444f83ac30ff76f8c5035990223027ba69b2f4d628388adcbd65`) identifies geographic EPSG:4269 NAD83/GRS80, Greenwich, decimal degrees. Fresh `p6`: terminal `complete`, 1 artifact, 50 decoded/accepted pilot records, 0 rejected, 50 mutations, 50 candidate-only warnings, 0 errors. | The adapter strictly recognizes EPSG:4269 and EPSG:4326, applies EPSG:1188's null NAD83-to-WGS84 operation with stated 4 m accuracy, and emits typed `SCHEMA_DRIFT` for every other CRS. The final built decoder independently found 1,880 unique Santa Clara-clipped features; bounded `p6` intentionally processed 50. |
| USGS 3DHP hydrography               | `sc:source:usgs-3dhp-hydrography`               | `live_verified`                   | 56,873 discovered records across 29 deterministic pages; source as-of `2026-06-26`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Both current flowline and waterbody layers passed discovery. Every response receives its own runtime artifact hash. These are candidate water inputs, not proof of a view.                                                                                                                                               |
| USGS 3DEP elevation                 | `sc:source:usgs-3dep-elevation`                 | `live_verified`                   | One terminal 256 by 256 export plan (65,536 cells); source as-of `2026-06-23`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Current dynamic export contract passed. Exact GeoTIFF bytes/hash are produced during acquisition. Bare-earth terrain cannot establish an actual view.                                                                                                                                                                    |
| Overture Starbucks candidates       | `sc:source:overture-starbucks`                  | `live_verified`                   | Pinned fragment 775,230,908 bytes; ETag `e20962729cacc7f146943e0a566d5d91-12`; last modified `2026-06-17T17:24:40Z`; frozen SHA-256 `565c44c3900d7700998d38962d70c2d53acece8446e0dd23aa54878a80d0c659`; schema `5316e71b1e98b714d1bdcc1087bda07906640af3cb2e456688b3c2b4f45d218f`                                                                                                                                                                                                                                                                                                  | HEAD identity passed. Full acquisition/query is still required. Results remain Starbucks candidates with contributor license evidence, not automatically current open stores.                                                                                                                                            |
| CSLB contractor master              | `sc:source:cslb-contractors`                    | `p3_discovery_verified`           | Independent adapter audit returned one terminal License Master resource; source as-of `2026-07-17`; schema `99f2e300a1c0f0c76ee202f81a334d264b91dd46dd97ec352bd13fdb14895369`; denominator unavailable. `p2` exposed duplicate-cookie loss in the pipeline bridge. Fresh `p3`: discovery-only terminal `partial`, no error codes.                                                                                                                                                                                                                                                  | The adapter and corrected production bridge preserve both anonymous `Set-Cookie` values. `p3` intentionally did not download the full master, so this is discovery verification, not contractor-row coverage. Output remains authenticated.                                                                              |
| California SOS businesses           | `sc:source:ca-sos-businesses`                   | `configured_lock_required`        | Public records page reachable: 57,288 bytes; audit hash `65d32522f6aa0cbd1919625b5e08455593fd8b453e072cab80512055e4ff6a20`; no bulk rows acquired                                                                                                                                                                                                                                                                                                                                                                                                                                  | The executable adapter requires an operator-generated bizfile bulk export with exact URL, raw header/mapping, count, byte size, SHA-256, source-as-of, and selected ZIP member. Public search is not a bulk substitute and SOS has no beneficial-ownership data.                                                         |
| Santa Clara ownership/transfers     | `sc:source:santa-clara-ownership-transfers`     | `blocked`                         | First official capability page returned HTTP 403; zero observed rows; denominator and coverage interval remain null                                                                                                                                                                                                                                                                                                                                                                                                                                                                | The paid subscribed snapshot, rights decision, APN/address linkage, document-type qualification, and complete interval are absent. The adapter fails discovery with `TERMS_ACCESS`; plan/acquire/normalize cannot turn this into ownership facts.                                                                        |
| Santa Clara FBN                     | `sc:capability:santa-clara-fbn-monthly-data-v1` | `blocked`                         | Both official capability pages returned HTTP 403; zero observed rows; denominator null; capability evidence `59a895ab38e35ebde749bb3b627d1b2429f49ddd6dd58217c90aacd8ad4aacaa`                                                                                                                                                                                                                                                                                                                                                                                                     | No approved purchased snapshot or private/public rights decision exists. The terminal projection is typed unknown, `prohibited_public`, and contains no FBN or owner-bearing row.                                                                                                                                        |

## Corrected pilot `p2`

The redacted manifest at `.cache/oracle-real-county/p2.manifest.json` records a
`pilot` run with 14 source/capability entries and terminal status `partial`.
For the three audited failures:

- `sc:source:caltrain-static-gtfs` acquired one immutable artifact at the exact
  178,695-byte hash above, then failed decode with
  `CSV_RECORD_INCONSISTENT_COLUMNS`. Structural inspection found only the
  whitespace-only physical row described above; no source row values were
  printed. The adapter fix supersedes `p2` and requires `p3`.
- `sc:source:cslb-contractors` ended `TRANSIENT_SOURCE` before any artifact or
  source checkpoint. The adapter cookie contract passed; Oracle corrected the
  production HTTP bridge outside this document owner's file allowlist.
- `sc:source:noaa-cusp-shoreline` ended `TERMS_ACCESS` before any artifact or
  source checkpoint. Independent bounded HEAD and GET checks reproduced HTTP
  403, so this remains an explicit external-source limitation.

The completed VTA, Caltrain acquisition, parcel, permit, MTC, USGS 3DHP, and
USGS 3DEP checkpoints remain under the ignored `p2` cache. They are not a
county-complete release and are not promoted by this matrix.

The fresh redacted manifest at
`.cache/oracle-real-county/p3.manifest.json` supersedes those two code-path
failures. It records Caltrain `complete` with 1 accepted and 0 rejected feed,
and CSLB `partial` in intentional `discover_only` mode with no error codes.
NOAA remains terminal `blocked` with `TERMS_ACCESS`. The overall `p3` status is
truthfully `partial`; it does not claim county completion.

Pilot `p4` later acquired and checkpointed the exact frozen NOAA archive, then
failed after acquisition because the adapter incorrectly required WGS 84 while
the archive truthfully declares EPSG:4269 NAD83. The manifest therefore records
NOAA terminal `failed`, no source summary, and legacy error code `Error`; the
artifact and resumable checkpoint remain preserved. The corrected decoder
recognizes only the frozen archive's NAD83/GRS80 geographic definition and the
existing WGS 84 contract, applies EPSG:1188 explicitly, and emits typed,
non-retryable `SCHEMA_DRIFT` errors during `decode` for every unsupported CRS.

Pilot `p5` did not reach NOAA decode: its fresh archive download exceeded the
request timeout after discovery and planning, so the manifest truthfully records
`TimeoutError` with no acquire artifact or source summary. Pilot `p6` used a
bounded timeout sufficient for the observed 92,057 ms download and confirmed
the final adapter end to end. NOAA is terminal `complete`, its source summary is
`succeeded`, the exact 42,506,201 bytes are checkpointed, and all 50 bounded
pilot records were accepted without quarantine. The warning on every record is
the intentional statement that mapped shoreline is only a candidate input and
does not prove a property view.

## Frozen contract verification

The source-adapter suite passed `148/148` tests in `18/18` files. It
proves the following without network or private payloads:

- schema and immutable-byte hash drift fail closed;
- parcel/MTC pagination is ordered and uncapped, while file sources terminate
  explicitly;
- transient exceptions, HTTP 408/429/5xx, bounded backoff, and `Retry-After`
  behavior are source-specific and tested;
- checkpoints commit only verified immutable artifacts and replay without
  duplicate effects;
- abort propagates before transport, during byte collection/decoding, and
  before mutation emission;
- ownership and FBN stay terminal blocked/unknown with null denominators, no
  fabricated rows, and no public owner-bearing projection.

One reproducible adapter defect was found and fixed: GTFS parsing now tolerates
only all-whitespace physical rows while retaining fail-closed behavior for
nonblank column-count drift. The separate CSLB production HTTP bridge defect
was fixed by its owner and confirmed by `p3`. A second adapter defect was exposed
by `p4`: the frozen NOAA archive uses EPSG:4269, not the incorrectly asserted
WGS 84 CRS. Strict NAD83 recognition, explicit EPSG:1188 normalization, and
typed terminal schema errors now cover that contract. The remaining states are
source locks, credentials, rights decisions, runtime-size work, or external
constraints; code cannot truthfully manufacture those inputs.

## Elephant baseline limitation

The native Donphan workflow requires the `elephant` MCP server and a successful
`getOracleDatasetInfo` gate before any Elephant/IPFS read. That tool was not
exposed in this execution session, so this audit did not bypass the gate and
does not claim a fresh Elephant baseline. A connected Donphan run remains
required for the independent pre-release Santa Clara MCP comparison.
