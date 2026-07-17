# City of San Jose building permits

- Source ID: `sc:source:san-jose-building-permits`
- Authority: City of San Jose Open Data
- Jurisdiction: City of San Jose only; this source is not a Santa Clara County
  permit denominator.
- License: Creative Commons CCZero, as reported independently by every official
  CKAN dataset record.

## Official source family

The adapter treats the three official CSVs as one source family while retaining
the identity and status semantics of every feed:

| Feed             | Dataset                                | Resource                               | Official status   |
| ---------------- | -------------------------------------- | -------------------------------------- | ----------------- |
| Active           | `fd9ceb0c-75e0-402e-9fe3-3f6e04f2c23f` | `761b7ae8-3be1-4ad6-923d-c7af6404a904` | `Active`          |
| Expired          | `3b40d486-bd19-44c5-b854-5f0638c2afc3` | `df4b8461-0c7a-4d16-b85d-ff7f71c5fed5` | `Expired`         |
| Under inspection | `ca355e55-c651-4e00-9bde-2c014f229486` | `89ccdad9-7309-4826-a5f3-2fcf1fcb20fa` | `UnderInspection` |

Discovery reads each official CKAN `package_show` response anonymously and
verifies the dataset ID, resource ID, exact download URL, `cc-zero` license, and
resource modification timestamp. Acquisition then downloads all three complete
CSVs in the fixed order above. There is no source cap, first-row deduplication,
or status-history synthesis.

The publisher does not expose an independent CSV row-count endpoint. The
adapter therefore always computes the final decoded snapshot count, includes
that count in run evidence, and optionally compares it to a separately frozen
source-lock count before yielding any rows. A count mismatch is schema drift,
not an implicit incremental change.

## Phase behavior

- `discover`: validates current CKAN metadata for all three resources.
  Metadata calls use the injected rate policy between successful requests;
  discovery retry failures retain the discovery phase in error evidence.
- `plan`: emits exactly three ordered full-snapshot items.
- `acquire`: uses injected transport, clock, delay, artifact store, checkpoint
  store, abort signal, and rate policy. Bytes are content-addressed, SHA-256
  verified, stored immutably, and checkpointed after each successful feed. The
  returned store descriptor must match logical key, media type, byte size, and
  SHA-256 before an artifact can be emitted. Missing `Content-Type` fails
  closed. A fresh adapter resumes from the persisted checkpoint payload; a
  conflicting caller checkpoint is rejected.
- `decode`: validates strict UTF-8 and the exact 18-column schema, then streams
  RFC 4180 records through `csv-parse`. Quoted commas and embedded newlines are
  retained.
- `validate`: checks feed/status identity, permit/source-row identifiers, APN,
  City-local dates, and valuation. Rejected rows retain field-specific reason
  codes.
- `normalize`: emits one deterministic permit upsert plus lineage-bearing field
  observations. Source APN is retained for later property reconciliation; it is
  not treated as a raw row key.
- `summarize`: returns the frozen source-run summary. The lane-local composed
  summary adds per-feed artifact hashes, dates, bytes, and accepted/rejected
  snapshot counts plus an explicit San Jose-only scope. Missing feeds or an
  incomplete checkpoint produce `partial`; unbalanced decoded/accepted/rejected
  accounting fails explicitly.

The provider exposes only the lane-local factory
`createSanJoseBuildingPermitAdapter`. It is not registered or composed in a
shared registry by this lane.

## Permit identity and status semantics

`FOLDERNUMBER` identifies the permit and `FOLDERRSN` identifies the official
source row. The deterministic canonical permit ID is stable across feeds. Each
raw record key also contains feed identity, source row ID, and ordinal, so an
identical permit present in Active and Under Inspection remains two visible
source observations on one permit—not a duplicate discarded by first-row wins.

The adapter does not invent a lifecycle. In particular:

- `Active`, `Expired`, and `UnderInspection` remain official feed/status values;
- approval text such as `B-4. Complete` is retained verbatim but does not by
  itself prove completed roof work;
- `issuedAt` is not substituted for completion;
- canonical `completedAt` is populated only from a valid non-empty official
  `FINALDATE`;
- a downstream roof classifier must still apply the frozen conclusive-final-
  evidence rules.

## Retained evidence and lineage

Every accepted row retains, without description truncation:

- feed identity and official status;
- `FOLDERRSN` and `FOLDERNUMBER`;
- raw and normalized APN inputs;
- source location text;
- folder description/name/subtype;
- complete work description and permit approvals;
- issue/final dates and valuation;
- classified applicant, owner, and contractor text.

Every canonical entity and observation links to source ID, snapshot ID,
artifact ID, feed-scoped record key, row ordinal, raw-record SHA-256, transform
name/version, input/output hashes, and a lineage hash.

San Jose timestamps are source-local civil times. They are converted
deterministically with the IANA `America/Los_Angeles` time zone, including DST,
while raw strings remain in lineage-bearing observations.

## Visibility and limitations

The official CSV artifacts and non-personal permit facts are public under CC0.
Free-form text can contain personal names, so normalization applies a stricter
field policy:

- missing/placeholder text classifications are public;
- free-form contractor text is authenticated until CSLB reconciliation;
- free-form applicant and owner text is restricted;
- owner text is always labeled permit evidence only and never current
  ownership.

This conservative projection does not change the immutable raw artifact. It
prevents public serving marts from accidentally upgrading personal free-form
text while preserving field-level evidence for authorized reconciliation.

San Jose is one jurisdiction within Santa Clara County. The per-feed snapshot
counts must be displayed independently and must never be promoted to countywide
permit coverage.

## Official excerpt provenance

The committed testkit contains one small, real CC0 row from each snapshot. The
rows use placeholder owner text (`NONE`) and were selected to exercise official
roof/status semantics without committing a bulk download. Exact URL, dataset
and resource IDs, retrieval/source-as-of times, original full-artifact SHA-256,
original bytes and record count, selected `FOLDERRSN`, extraction method, media
type, excerpt bytes, and excerpt SHA-256 are frozen in
`packages/testkit/src/sources/san-jose-building-permits/provenance.ts`.

Snapshot observed on 2026-07-17:

| Feed             |   Rows | Full bytes | Full SHA-256                                                       |
| ---------------- | -----: | ---------: | ------------------------------------------------------------------ |
| Active           | 17,724 |  5,874,191 | `f6254f86470703795ecc37588af81a56c622359f95c33b8e10cf671ca6f194db` |
| Expired          | 74,727 | 25,140,269 | `cbcb8f08d2ffe2e2dcdc197ec73e4fcf6c411d4f917cb7e6a1fb54d54d7ab933` |
| Under inspection | 10,899 |  3,945,282 | `64392fabc3b520622c059ecf0894723740ef400cfef49deb31a71914ccdc1f68` |

These are snapshot facts, not permanent expected counts. A later run must
rediscover metadata, compute its own final counts and hashes, and make any drift
visible.
