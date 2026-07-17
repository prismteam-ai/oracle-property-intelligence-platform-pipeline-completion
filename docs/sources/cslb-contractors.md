# California CSLB contractor license master

## Capability

`cslb-contractors` implements the current official, no-cost California
Contractors State License Board statewide **License Master CSV** route behind
the frozen ORA-011 source-adapter SPI. The public portal is a stateful ASP.NET
WebForms page: the adapter opens the portal, selects `License Master`, captures
the displayed `Updated as of` date, and posts the official CSV download event.
It does not automate Instant License Check, scrape a CAPTCHA, or use a
reputation site.

Official surfaces verified 2026-07-17:

- Portal: <https://web.cslb.ca.gov/onlineservices/dataportal/ContractorList>
- Documented `GetMasterFile` operation:
  <https://www.cslb.ca.gov/onlineservices/DataPortalAPI/GetbyClassification.asmx?op=GetMasterFile>
- Classification definitions:
  <https://www.cslb.ca.gov/About_Us/Library/Licensing_Classifications/>

The portal described the files as free and reported the selected master as
`Updated as of 7/17/2026`. The master CSV header was pinned as schema
fingerprint
`99f2e300a1c0f0c76ee202f81a334d264b91dd46dd97ec352bd13fdb14895369`.
The exact first 1,048,576 response bytes fetched from
`2026-07-17T14:47:56.001Z` through `2026-07-17T14:48:01.014Z` hashed to
`85aee63a6f2de0d9be3a37316fb94d90f84f26192e4beb5399e1d5bbfad8da3e`.
The stream was closed at that boundary; the remainder was not downloaded.

## Scope and semantics

The master contains licenses that are currently renewed or expired but still
renewable. It excludes cancelled, revoked, and expired non-renewable licenses.
It is therefore a current/renewable master, not complete historical CSLB
licensure. CSLB states that status can change after the download date and
directs users to Instant License Check for current verification.

Normalized output preserves:

- license number as the only authoritative contractor key;
- official business/legal name and business type;
- primary/secondary status and issue, reissue, expiration, inactivation, and
  reactivation dates;
- current classification tokens and their observed date;
- contractor, workers, and disciplinary bond facts supplied by the row;
- workers-compensation coverage, carrier, policy, and date facts;
- city, state, county, postal code, and country as mailing-locality evidence;
- source snapshot/artifact/row identity, hashes, transformations, and field
  lineage.

Duplicate license rows intentionally produce the same deterministic contractor
ID while retaining distinct row lineage and status/classification observations.
This preserves possible source history or drift for later conflict resolution;
the adapter does not silently choose a row. A permit-to-contractor match by
license number may be authoritative. A name/address match is only candidate
evidence and does not prove that the contractor performed permit work.

No BBB-style score, complaint score, work-quality signal, or permit-performance
claim is created.

## Visibility and rights

CSLB labels the portal data publicly disclosable, but the inspected portal does
not state an open redistribution license. It can also contain sole-proprietor
names, street addresses, phone numbers, policy numbers, and other public-record
personal data. Raw artifacts, contractor entities, source facts, and mailing
locality therefore default to `authenticated`. They are not eligible for public
IPFS merely because the source page is public. A later legal/field-allowlist
decision may publish a minimized derivative, but this adapter does not make
that decision.

## Fixture provenance

`packages/testkit/src/sources/cslb-contractors/official-master-safe-excerpt.json`
is a safe-field projection of two real corporation records selected from a
bounded 1 MiB prefix of the 2026-07-17 official master response. No full dataset
was downloaded to create it. Street, phone, policy-number, bond-number, and
personnel-like fields were removed. The fixture records the portal, official
snapshot date, retrieval time, selection rule, removed fields, row-projection
hashes, and exact fixture hash.

The excerpt proves real source shape and representative normalization only. It
is not a denominator, coverage sample, or substitute for a complete acquisition
run. Full-run integrity is established at runtime from the complete acquired
byte count/SHA-256, immutable-store verification, exact CSV header, optional
source-lock row count, and balanced accepted/rejected accounting.

## Operational constraints

- The official route is one full CSV rather than pages; discovery emits exactly
  one resource with a terminal `null` continuation token.
- The portal publishes no row-count denominator. `expectedRecords` is `null`
  unless a separately frozen source lock supplies one.
- The frozen byte-artifact SPI returns immutable bytes to the decoder, so the
  adapter applies a 512 MiB fail-closed ceiling by default. It streams the HTTP
  body into bounded memory, verifies the hash after storage, and checkpoints
  only after that verification.
- WebForms state/schema changes, non-UTF-8 input, header/count drift, malformed
  CSV, malformed license IDs, classifications, or dates fail explicitly.
- Anonymous session cookies are used only to carry the public portal flow and
  are never persisted in artifact metadata.
- Transient transport/408/429/5xx failures use bounded deterministic retry and
  `Retry-After`; authentication, access, schema, record, and abort failures are
  not retried as transient success.
