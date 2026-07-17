# California SOS businesses and Santa Clara FBN capability

Status: CA SOS adapter implemented; Santa Clara FBN capability explicitly blocked.

Verified: 2026-07-17.

## California Secretary of State business entities

Authority: California Secretary of State, Business Programs Division.

Official routes:

- [Business Entity Records](https://www.sos.ca.gov/administration/public-records-act-requests/business-entity-records)
- [bizfile Online](https://bizfileonline.sos.ca.gov/)
- [bizfile Online portal manual](https://bpd.cdn.sos.ca.gov/ucc/ucc-online-help.pdf), pages 132–134
- [December 2025 entity-number update](https://www.sos.ca.gov/business-programs/bizfile)

The official bulk path is an account-gated bizfile data request. An operator
orders either the BE master unload or a weekly update, downloads the generated
ZIP, freezes its exact URL/version, source-as-of, byte count, SHA-256, and record
count, exact raw ordered header and schema fingerprint, selected CSV entry path,
and complete one-to-one field mapping, then passes that source lock to the
adapter. The adapter never searches or scrapes the CAPTCHA/anti-bot protected
public portal.

The official Business Entity Records page snapshot retrieved for this adapter
on 2026-07-17 was 57,286 bytes with SHA-256
`112766f8e79387c920de93678f2b1f92dd196358acf9ee2d156242f7fbf6e86e`;
that digest binds the descriptor's license/access snapshot.

### Input contract

| Input       | Contract                                                                                |
| ----------- | --------------------------------------------------------------------------------------- |
| Source      | Generated CA SOS bizfile BE bulk download                                               |
| Format      | ZIP with one explicitly source-locked CSV entry, or a directly source-locked CSV        |
| Volume      | Frozen per export; default hard byte ceiling 2 GiB, configurable downward               |
| Cadence     | One master snapshot followed by independently versioned weekly updates                  |
| Destination | Immutable raw artifact store, then provenance-bearing canonical mutations               |
| Limits      | One concurrent request, bounded retry, `Retry-After` honored, exact hash/count required |
| Visibility  | `prohibited_public` until release-specific rights and personal-data review              |

The adapter validates the exact raw ordered-export header and its U+001F-joined
SHA-256, then applies the source lock's complete one-to-one mapping into the
frozen lossless interchange header in `constants.ts`. The immutable downloaded
artifact remains unchanged and its raw row, including source columns outside
the interchange, remains bound into record lineage. A legitimately renamed or
reordered provider schema therefore requires an explicit reviewed source-lock
update; it is never guessed. Missing, unknown, duplicate, or unbound mapping
fields and any mismatch against the locked raw header fail closed.

The interchange preserves:

- legacy numeric and new 12-character `B`-prefixed entity numbers;
- a previous/superseded entity number when the source supplies one;
- legal name, entity type, status, initial filing date, jurisdiction;
- source street/mailing address and agent facts without publishing them;
- source update date, ordered-export version, snapshot and record lineage.

The canonical business entity uses the current entity number as its stable
identity. Multiple source rows for one number remain temporal/status
observations; they are not collapsed by name. A row that identifies a new
number and a previous number remains a distinct entity with explicit
`previousEntityNumber` evidence. A business-name or address match is candidate
reconciliation evidence, not proof of property ownership or permit work.

### Ownership boundary

The Secretary of State explicitly says it does not collect ownership
information for business entities. The adapter therefore emits a typed null
`/beneficialOwnership` observation and never creates an owner, ownership
interest, ownership event, or property link from SOS data. Officer, agent, and
address material is not treated as beneficial ownership.

### Integrity and recovery

- HTTPS only;
- exact source-locked SHA-256 before storage;
- media-type and immutable-store verification;
- bounded response bytes plus aggregate declared ZIP bytes;
- metadata-only ZIP inspection before decompression, traversal-path denial, and
  decompression of only the exact source-locked CSV entry;
- actual decoded selected-CSV byte-ceiling verification;
- strict UTF-8 and CSV structure;
- exact header and record-count reconciliation;
- immutable snapshot/version lineage on every canonical field;
- checkpoint commit after the one bulk artifact is durable;
- resume skips a completed artifact;
- abort is checked before transport, while reading bytes, while parsing rows,
  and while emitting mutations.

No acquisition or normalization step performs provider, cloud, publication, or
credential effects by itself. The adapter only uses the injected SPI transport,
artifact store, checkpoint store, clock, delay, and abort signal.

### Safe fixture

`packages/testkit/src/sources/ca-sos-businesses/official-bizfile-safe-excerpt.csv`
contains one minimized real CA SOS public-search result. It retains only public
entity identity, type, status, filing date, and jurisdiction; agent and address
fields are empty. Its exact SHA-256 and extraction semantics are bound in the
adjacent provenance module. It is test evidence, not a substitute for a
source-locked master or weekly bulk export.

## Santa Clara fictitious business names

Authority: County of Santa Clara, Office of the Clerk-Recorder.

Official routes:

- [Data-sales details](https://clerkrecorder.santaclaracounty.gov/official-records/subscribe-data-sales-reports/additional-information-related-data-sales)
- [Subscription overview](https://clerkrecorder.santaclaracounty.gov/official-records/subscribe-data-sales-reports)

### Terminal capability decision

Decision: `blocked` as of `2026-07-17T00:00:00.000Z`.

The official county route is a paid monthly data-sale subscription. The county
says the data includes fictitious business names, owner names, and business
addresses, and also warns that not every new business must file an FBN
statement. This lane has no purchased immutable snapshot and no approved
retention, private-use, or public-projection rights decision. Consequently:

- acquisition permission is `false`;
- private-use permission is `false`;
- public-projection permission is `false`;
- expected record count and coverage ratio are `null`, not zero or complete;
- observed FBN records are zero because none were acquired;
- every business receives a deterministic typed `unsupported`/unknown FBN
  projection with `value: null` and `prohibited_public` visibility;
- no FBN name, registrant, address, filing, or synthetic row is fabricated.

SOS entity coverage stays separately supported. It cannot silently fill the
county FBN gap, and a missing FBN record must never be interpreted as evidence
that a business has no fictitious name.

The committed FBN testkit artifact contains only the official access and
coverage limitation. It contains no owner, registrant, agent, or address row.

## Verification coverage

Focused Vitest coverage proves:

- old and new entity identifiers;
- schema and version binding;
- malformed identifiers and dates;
- duplicate/status-history and superseded-ID behavior;
- bounded retry, checkpoint resume, abort, hash and media-type integrity;
- ZIP path, selected-entry, aggregate-size, raw-schema, and count drift denial;
- deterministic canonical mutations and field lineage;
- public-visibility denial for all source fields;
- explicit null beneficial-ownership semantics;
- terminal FBN blocked state and deterministic unknown projection;
- exact safe-fixture provenance hashes.

Tradeoff: a provider-specific source-lock mapping is required when a new bulk
export schema arrives. No vendor header is claimed here because this lane did
not inspect a purchased master unload. Binding the actual raw header, selected
entry, fingerprint, and mapping at operator source-lock time is preferable to
guessing a vendor schema or transforming the immutable artifact out of band. It
keeps the adapter executable and deterministic across reviewed source versions,
makes schema drift reviewable, and preserves a clean path to support a purchased
FBN snapshot later without changing SOS business semantics.
