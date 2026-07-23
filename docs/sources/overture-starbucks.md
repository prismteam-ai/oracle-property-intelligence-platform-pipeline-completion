# Overture Places Starbucks candidates

Status: pinned source adapter for ORA-043.

## Scope and semantics

This adapter produces Santa Clara County Starbucks **candidates** from the immutable Overture
Places release `2026-06-17.0` (schema `v1.17.0`). It does not claim that a candidate is a
currently open Starbucks merely because a name, brand, category, or Overture operating signal
matches.

Candidate evidence retains:

- release, theme/type, GERS ID, feature version, Point geometry, names, categories, and address;
- Starbucks Wikidata (`Q37158`), brand-name, primary-name, and coffee-category match evidence;
- Overture confidence and operating-status evidence;
- every contributing dataset, record ID, confidence, license, update time, attribution, and
  applicable notice;
- immutable source/snapshot/artifact identity and field-level canonical lineage; and
- a separate manual Starbucks-locator sample state.

The default locator state is `not_sampled`. A bounded operator action can record only
`sampled_open`, `sampled_closed`, `sampled_conflict`, or `sampled_unknown`, the check time, GERS
ID, and a concise outcome note. The adapter rejects locator URLs/content so it cannot become a
Starbucks scraper or restricted-content store. Google Places is not called or persisted.

## Frozen official source

| Item                        | Frozen value                                                                 |
| --------------------------- | ---------------------------------------------------------------------------- |
| Release                     | `2026-06-17.0`                                                               |
| Schema                      | `v1.17.0`                                                                    |
| Official release URI        | `s3://overturemaps-us-west-2/release/2026-06-17.0/theme=places/type=place/*` |
| Santa Clara source fragment | `part-00002-85d36905-50d8-5942-afcd-d2023ce6f0f4-c000.zstd.parquet`          |
| HTTPS object size           | `775230908` bytes                                                            |
| HTTPS object SHA-256        | `565c44c3900d7700998d38962d70c2d53acece8446e0dd23aa54878a80d0c659`           |
| S3 ETag                     | `"e20962729cacc7f146943e0a566d5d91-12"`                                      |
| S3 composite SHA-256        | `mBV5FIPCcDuz30R/7xdzfjUgmlZm0FKMtfqoVkebBGw=-12`                            |
| Last-Modified               | `2026-06-17T17:24:40.000Z`                                                   |

The full SHA-256 was computed from one complete anonymous HTTPS stream on 2026-07-17. The
775 MB object was never saved to the repository or retained locally. Discovery uses injected
`HEAD`; acquisition uses injected `GET`, validates size/ETag/Last-Modified/SHA-256, stores the
exact immutable bytes through `ArtifactStore`, and commits an optimistic checkpoint. A changed
release object fails as schema drift; it never silently advances to `latest`.

The fixed provider-owned analytical query is exported as `OVERTURE_STARBUCKS_QUERY`. It binds the
immutable artifact URI and Santa Clara bounds as values, filters by `Q37158` or Starbucks
brand/primary name, orders by GERS ID, and runs with explicit timeout, scan, row, and abort bounds
through the injected `AnalyticalRuntime`. No caller-authored SQL is accepted.

## Tiny official fixture

The committed fixture is
`packages/testkit/src/sources/overture-starbucks/official-overture-2026-06-17-excerpt.geojson`.
It contains three source-shaped real records (two AllThePlaces/CC0 records and one
Foursquare/Apache-2.0 record) and is `4878` bytes with SHA-256:

```text
6b91c2c2aaf6f407b3aa9e965794a7cfef4ad4889286b917e174b4bd6a2092d1
```

Exact extraction procedure:

1. Use Node `22.18.0` and `@duckdb/node-api 1.4.5-r.1` with anonymous S3 access in `us-west-2`.
2. Query the pinned release URI using the fixed adapter columns and Santa Clara bounds.
3. Select these exact GERS IDs and order by `id`:

   ```sql
   WHERE id IN (
     '08a87f75-fe95-455d-ab8f-42f37424a70a',
     '346ea5cb-3d37-4661-9001-7d0b0ea36a5a',
     '8fce41a2-c2b5-40f4-b90d-c39f2fa2ec7d'
   )
   ORDER BY id
   ```

4. Convert `bbox.xmin`/`bbox.ymin` to GeoJSON Point coordinates, retain the listed source fields,
   normalize nullable Overture collections to empty JSON collections, and serialize UTF-8 JSON
   with Prettier `3.9.5` and LF.
5. Verify both fixture and full source-fragment hashes above.

The provenance module and tests pin the extraction identity, record IDs, byte count, hash,
licenses, and notices. The fixture includes no owner data, credentials, contacts, Starbucks
locator content, Google content, database, or generated corpus.

## Matching, deduplication, and conflict policy

Match modes are deterministic and ordered:

1. exact Starbucks Wikidata ID;
2. exact normalized brand name;
3. exact normalized primary name plus coffee category;
4. exact normalized primary name alone; or
5. no match (rejected).

Deduplication never merges merely because two places are named Starbucks. It records pairwise
decisions and deduplicates only when explicit address normalization and a distance of at most
15 meters agree. A shared GERS ID with conflicting address/location evidence is retained as a
conflict rather than silently collapsed. Across different GERS IDs, spatial **and** address
evidence are both required. Selection among proven duplicates is deterministic by version,
confidence, then GERS ID.

Low-confidence and Overture-closed records remain visible, labeled
`low_confidence_candidate` or `closed_candidate`. Unknown Overture operating status remains
unknown. Unknown contributor licenses downgrade visibility to `prohibited_public`; no later
normalization step upgrades it.

## Attribution and licensing

Primary documentation:

- [Overture Places guide](https://docs.overturemaps.org/guides/places/)
- [Overture release calendar and 60-day retention](https://docs.overturemaps.org/release-calendar/)
- [Overture attribution and per-source licenses](https://docs.overturemaps.org/attribution/)
- [Overture Place schema](https://docs.overturemaps.org/schema/reference/places/place/)

Notices retained by the adapter include:

- Overture Maps Foundation, overturemaps.org;
- AllThePlaces under CC0-1.0;
- Meta, Microsoft, PinMeTo, Krick, RenderSEO, DAC, BrightQuery, and Overture-derived data under
  CDLA-Permissive-2.0 where present; and
- Foursquare data © 2024 Foursquare Labs, Inc., Apache-2.0, transformed to the Overture schema,
  with the Overture NOTICE reference.

Tradeoff: the production path downloads the one pinned 775 MB spatially ordered fragment before
querying it. This costs more transfer than querying the live public wildcard directly, but it
preserves the frozen SPI rule that acquisition yields checksummed immutable bytes and allows
replay after Overture's 60-day public-retention window. It also avoids a hidden third-party query
service and keeps decoding/querying separate from transport.
