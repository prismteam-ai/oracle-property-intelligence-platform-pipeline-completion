# Santa Clara ownership and recorded-transfer capability

Status: `blocked` as measured 2026-07-17.

## Outcome

The strongest official reproducible route currently identified is the County of Santa Clara
Clerk-Recorder's paid grantor/grantee index subscription. This lane does not have an approved
subscribed snapshot, a measured coverage interval, or an explicit redistribution grant. The adapter
therefore emits a typed blocked capability and no ownership, party, interest, or transfer mutations.

This is deliberately non-functional for the assignment's strict ownership-age and regional-owner
questions. Missing index rows are never treated as evidence that a property did not exchange
ownership in ten years.

## Official source identity and measured limits

Authority: County of Santa Clara Office of the Clerk-Recorder.

Product: Grantor and grantee index for recorded official documents.

Official evidence:

- [Data-sales description](https://clerkrecorder.santaclaracounty.gov/official-records/subscribe-data-sales-reports/additional-information-related-data-sales)
  states that the product is locator-index text data offered on daily, weekly, monthly, quarterly,
  and yearly subscriptions. It identifies party name, document number, recording date, and document
  type as source fields.
- [Official index order form](https://files.santaclaracounty.gov/exjcpb1411/2026-06/official-records-form_05192026.pdf)
  describes delivery through secure file transfer, a setup fee, recurring subscriptions, and
  verified versus unverified delivery intervals.
- [Research and purchasing guidance](https://clerkrecorder.santaclaracounty.gov/official-records/researching-real-estate-documents/request-and-purchase-copies-recorded-documents/additional-information-related-to-purchasing)
  says addresses are not in the index. APN/address-assisted research is an in-person workstation
  workflow, not a field in the standard purchased index.
- [Current fee schedule](https://clerkrecorder.santaclaracounty.gov/resources/fee-schedule)
  lists recurring grantor/grantee index prices. Pricing is evidence of an available paid product,
  not acquisition authority for this no-effects lane.

The index provides a party's grantor/grantee role only as indexed for a particular recorded
document. A document may be a deed, lien, judgment, mortgage, notice, or another record type. A
grantor/grantee index row is therefore transfer-related evidence that requires document-type
qualification; it is not necessarily a title transfer, a complete current ownership chain, or a
title opinion. Permit owner text is not consumed by this capability and is never treated as current
ownership.

## Capability contract

`createSantaClaraOwnershipTransferCapabilityAdapter()` implements the frozen ORA-011 source-adapter
SPI:

- `describe()` declares the official authority, manual paid-snapshot route, personal-data presence,
  unknown redistribution rights, and `restricted` default visibility.
- `discover()` fetches only the three public official capability pages through an injected transport,
  validates required facts/media type/UTF-8, records byte hashes and source version, and reports
  `complete: false` with no fabricated denominator.
- `plan()` rejects with typed `TERMS_ACCESS` because no approved subscribed snapshot exists.
- `acquire()` rejects even when supplied a checkpoint; checkpoint/resume cannot bypass source access
  or rights.
- `decode()` and `normalize()` reject owner-bearing input. `validate()` returns a fatal blocked-source
  issue if invoked unexpectedly.
- `summarize()` cannot report success and rejects any run that somehow contains accepted records or
  canonical mutations.

The provider-local `OwnershipTransferCapability` preserves:

- authority and product identity;
- a content-derived `sourceVersion` over exact official-page hashes;
- actual advertised index fields;
- null coverage interval, null expected-record denominator, and zero observed rows;
- paid SFTP/manual access state;
- missing standard-index APN/address fields;
- restrictions, source-page lineage, and restricted visibility.

No owner-bearing rows are committed. The committed test excerpts contain only minimal official
product/access statements and are pinned by SHA-256 in
`packages/testkit/src/sources/santa-clara-ownership-transfers/provenance.ts`.

## Evidence semantics

`assessNoRecordedExchange()` returns:

- `unsupported` for the selected blocked capability;
- `unknown` for partial coverage, candidate address linkage, incomplete document-type coverage,
  incomplete chains, or an interval that does not span the query;
- `supported` only for a future `complete` capability whose measured interval spans the query, whose
  title-transfer coverage is complete, whose property linkage is authoritative APN evidence, and
  whose chain completeness is verified. The acquired snapshot count must balance to a measured
  denominator, and only explicitly verified title-transfer document IDs count as exchange evidence.
  Every input row must also match the capability's official source identity and immutable source version;
  cross-source or cross-snapshot lineage returns `unknown`.

Only that final state can interpret absence inside a complete interval as “no recorded exchange.”
Even then, the result is explicitly limited to the declared recorded-transfer source and is not a
title opinion.

The row validator is future-ready for an approved subscribed snapshot. It preserves instrument
number, recording date, document type, grantor/grantee role, restricted party name, source version,
artifact identity, raw pointer, and row hash. It rejects malformed identifiers/dates/roles and rejects
APN/address values falsely attributed to the standard index. Deterministic duplicate handling removes
only repeated instrument-party-role rows; it does not merge distinct parties or roles on one document.

`projectOwnershipRows()` denies both public and generic authenticated projection. Owner-bearing bytes
remain restricted until a separate explicit access policy is approved. They are never eligible for
public IPFS publication.

## Promotion requirements

Changing the selected state from `blocked` requires all of the following:

1. an approved and lawfully acquired subscribed snapshot;
2. exact source bytes, delivery interval, expected/observed counts, schema, and content hash;
3. source terms covering private use, retention, derivatives, and disposal;
4. a lawful APN/address linkage source and measured linkage quality;
5. document-type rules that isolate title transfers from mixed recorded documents;
6. verified temporal/chain completeness sufficient for the intended query interval;
7. restricted storage and evaluator access controls;
8. an independent public-projection decision. Owner-bearing raw data remains non-public by default.

Until those gates are satisfied, ORA-039/046 remains blocked and ORA-047's typed unsupported branch is
the truthful release behavior.

## Verification

Run with the pinned Node runtime:

```powershell
$env:Path = 'E:\nvm\v22.18.0;' + $env:Path
pnpm --filter @oracle/source-adapters test
pnpm --filter @oracle/source-adapters lint
pnpm --filter @oracle/source-adapters typecheck
pnpm --filter @oracle/source-adapters build
pnpm --filter @oracle/testkit test
```

Coverage includes official-page integrity/schema drift, bounded retry and `Retry-After`, abort,
checkpoint bypass denial, deterministic capability/source version, complete/partial/blocked inquiry
semantics, ten-year interval sufficiency, duplicate instruments, role/APN/date failures, lineage, and
public/authenticated visibility denial.
