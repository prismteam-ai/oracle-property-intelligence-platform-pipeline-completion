# MTC / Palo Alto assessor enrichment (`c252-zdg8`)

## Scope and authority

This adapter reads the official Bay Area Metro Socrata dataset
[`c252-zdg8`](https://data.bayareametro.gov/api/views/c252-zdg8). The Socrata
metadata retains the backing City of Palo Alto ArcGIS FeatureServer layer:

```text
https://services6.arcgis.com/evmyRZRrsopdeog7/ArcGIS/rest/services/AssessorsParcels/FeatureServer/0
```

It is a Palo Alto subset enrichment and cross-check. It is never the Santa
Clara County parcel or completion denominator. The live anonymous discovery on
2026-07-17 reported 25,503 rows; every run re-reads the official count and
binds it into an uncapped acquisition plan.

## Legal and product semantics

The inspected Socrata metadata grants public read access but states no explicit
redistribution license. Anonymous readability is not treated as publication
permission. The descriptor therefore records `redistribution: unknown`, and
the acquired records and every canonical mutation remain
`prohibited_public`. Publication eligibility stays pending until a later legal
decision; this adapter cannot upgrade it.

The fields retain their source meanings:

- `yearbuilt` is original building year evidence;
- `effectiveyearbuilt` is a distinct effective-year evidence field and never
  overwrites original year;
- either year is only a building-age proxy for roof age;
- `floodzone` and `nearcreekfeature` are planning/environmental signals, not
  proof of a water view;
- the Socrata `the_geom` value is WGS84 parcel geometry;
- `x` and `y` are retained as the ArcGIS EPSG:2227 `label_point`, not silently
  presented as longitude/latitude, a rooftop, or an entrance.

## Acquisition and drift controls

Discovery reads the exact metadata and `count(*)` endpoints. It verifies the
dataset ID, official provenance, required Socrata field names/types, and exact
backing ArcGIS layer identity before planning. The request must bind the exact
discovered `rowsUpdatedAt` source-as-of.

Planning creates every page up front with:

```text
$select=objectid,gid,apn,yearbuilt,effectiveyearbuilt,zonegis,floodzone,
        nearcreekfeature,x,y,the_geom,addressdescription,modifieddate
$order=objectid ASC
$limit=<page-size>
$offset=<ordered-offset>
```

No source cap is applied. Each immutable response is SHA-256 checked, written
through the artifact-store port, and the returned store receipt must match its
logical key, media type, byte size, and SHA-256 before metadata is emitted.
Missing or unexpected response media types fail closed. A checkpoint is
persisted before emission; a fresh adapter resumes directly from that persisted
payload, and any disagreeing caller-supplied checkpoint is rejected. Completed
request keys and artifact IDs are retained. Transient transport exceptions and
408/429/5xx responses use the injected bounded rate/retry policy and honor
numeric `Retry-After`. Abort is checked before requests, while streaming bytes,
and before records/mutations are emitted.

Decode rejects schema-fingerprint or per-page count mismatches. Summary also
reconciles total decoded rows and acquired artifacts against the full plan.
These checks expose changing snapshots and partial reads instead of reporting
false completion.

## Validation and normalization

Validation requires:

- numeric source `objectid`;
- an APN that deterministically normalizes to `NNN-NN-NNN`;
- a closed WGS84 MultiPolygon inside explicit Palo Alto subset bounds;
- native `x`/`y` inside the official ArcGIS EPSG:2227 layer extent;
- plausible original/effective years relative to the row observation date.

The source sentinel year `0` becomes an explicit unknown warning. If effective
year predates original year, both values remain distinct and a conflict warning
is emitted. Missing or invalid required fields are rejected with reason codes.

APN is not a raw row key. The source `objectid`, artifact hash, row ordinal,
record hash, raw pointer, and transformation lineage identify every observation.
Multiple rows with one APN therefore remain separately auditable even though
they target one deterministic canonical parcel ID. The page offset plus local
row index forms a safe global ordinal, so mutation sequences remain unique and
deterministic across pages while each raw pointer stays local to its immutable
page. There is no first-row deduplication.

Normalization emits a property upsert plus individual field observations for
APN input, original/effective year, zoning, flood zone, near-creek, EPSG:2227
source coordinates, WGS84 parcel geometry, source address text, and source
object ID. Mutation, observation, run, and property IDs are content-derived;
the same immutable input produces byte-equivalent mutations.

## Committed official excerpts

The testkit includes small real-source excerpts only. `provenance.ts` records
authority, exact URL/query, retrieval and source-as-of instants, original
artifact SHA-256/byte size, excerpt SHA-256/byte size, media type, extraction
method, source semantics, and legal state.

| Excerpt                                    | Original SHA-256                                                   | Excerpt SHA-256                                                    |
| ------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Two official rows sharing APN `132-38-069` | `83dd4d6d652be9762d69a679cc83472855d2db6a3fc8973c009c413ad7773daf` | `138c28392b77f05994a1990a157241e84d9ec8074ac1c77da1dc51319b3b4e4c` |
| Socrata metadata                           | `0e157ee43ad02b02d7fef03d286ada8a8b33df85faa855d5b3c1651e812c5f8a` | `b77cd2ab92abb0910be7f94447a314fde56d31e9a8f7102403f5669bd635bcc4` |
| ArcGIS layer metadata                      | `6cb3dfc7cbd19c4375cd4b28bc83e9145549ba03dfd4f19ec4637c5605b92c17` | `cfaa91a01b2f64df316e84adbf08030e971b004a498144df2c6abbe32555f975` |

Synthetic rows appear only inside negative tests for malformed inputs; they are
never used as source-success evidence.

## Verification

With Node `22.18.0` first on `PATH`:

```powershell
pnpm exec eslint packages/source-adapters/src/providers/mtc-palo-alto-year-built packages/testkit/src/sources/mtc-palo-alto-year-built
pnpm --filter @oracle/source-adapters test -- src/providers/mtc-palo-alto-year-built/adapter.test.ts
pnpm --filter @oracle/testkit test -- src/sources/mtc-palo-alto-year-built/provenance.test.ts
```

The provider tests cover ordered pagination, exact source-as-of binding,
checkpoint resume, duplicate APNs, subset/CRS bounds, malformed APN/geometry,
missing fields, invalid/conflicting years, schema and count drift, bounded
retry, abort propagation, deterministic mutations, full lineage, summary
accounting, and strict visibility preservation.
