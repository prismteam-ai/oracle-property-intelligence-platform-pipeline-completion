# VTA, Caltrain, and 511 GTFS source family

Status: implemented as an unregistered lane-local source family for ORA-040.

Captured: 2026-07-17. Production refreshes must deliberately replace the
snapshot configuration, hashes, service window, terms capture, and fixtures;
an unexpected byte change fails acquisition instead of silently becoming a new
release.

## Authority and precedence

The source family requires both direct feeds:

1. Santa Clara Valley Transportation Authority (VTA) static GTFS is the
   authoritative VTA source.
2. Peninsula Corridor Joint Powers Board (Caltrain) static GTFS, linked from
   Caltrain's developer page and hosted by Trillium, is the authoritative
   Caltrain source.
3. 511 Bay Area may be injected per operator only as a fallback and parity
   cross-check. It never replaces the required direct-feed configuration and
   never wins a disagreement while the direct feed is available.

The family factory rejects configurations without both operator-authoritative
feeds. It also rejects a 511 fallback that does not use injected authorization,
exceeds 60 requests per 3,600 seconds, or ignores `Retry-After`. No API key,
credential header, or credential-derived URL enters adapter configuration,
request metadata, fixtures, logs, or artifacts.

## Frozen direct snapshots

| Operator | Exact download                                                                                                                      | Retrieval observation                                                          | Feed/service window                                                                            | Exact ZIP                                                                                   |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| VTA      | `https://gtfs.vta.org/gtfs_vta.zip`                                                                                                 | HTTP 200; `Last-Modified: 2026-07-15T18:03:46Z`; observed 2026-07-17T13:00:00Z | feed version `2026-07-14_12:57`; 2026-04-27 through 2026-08-09; selected date 2026-07-17       | 5,072,907 bytes; SHA-256 `0920434ae18e204a7d5bd66ef7a7b02feec786c2f57ddaa081dcea4b20aa1af9` |
| Caltrain | `https://data.trilliumtransit.com/gtfs/caltrain-ca-us/caltrain-ca-us.zip`, linked by `https://www.caltrain.com/developer-resources` | HTTP 200; `Last-Modified: 2026-06-10T22:21:13Z`; observed 2026-07-17T13:00:00Z | feed version `UTC: 10-Jun-2026 22:25`; 2026-01-31 through 2027-01-31; selected date 2026-07-17 | 178,695 bytes; SHA-256 `786de3fea43ef033dbc9977d1617032a0ecff706e1621a6c9d5816a65e6d862a`   |

The VTA ZIP identifies agency `VTA` and publisher Santa Clara Valley
Transportation Authority. The Caltrain ZIP identifies agency `1000`, name
Caltrain, and feed ID `caltrain-ca-us`. Snapshot acquisition records HTTP
status, ETag/Last-Modified when supplied, byte count, SHA-256, source-as-of,
schema fingerprint, immutable raw URI, visibility, and license snapshot.

## Terms, visibility, and attribution

The exact captured VTA developer-page response was 1,779 bytes with SHA-256
`042407dfa3823555cb7103eb28a3d424ae453b353e73debed37c8e663aec33c7`.
It makes the static feed available for transit-application development but did
not state an explicit redistribution license in the captured page. The adapter
therefore marks redistribution `unknown` and visibility `authenticated` until
legal review approves a public derivative. Attribute VTA as “Santa Clara
Valley Transportation Authority (VTA).”

The exact captured Caltrain developer/license-page response was 631,107 bytes
with SHA-256
`1474de29630c438447748270015bfb9993b684517fa1da03d7165b3322951290`.
The Developer License Agreement grants limited, revocable rights to use,
reproduce, and redistribute the data. It prohibits unapproved association of
Caltrain/PCJPB trademarks and copyrighted materials, and separately prohibits
use of the Caltrain logo or System Map without permission. The adapter marks
the data public under those captured conditions and attributes Peninsula
Corridor Joint Powers Board (Caltrain).

The exact captured 511 transit-page response was 106,566 bytes with SHA-256
`26dd40ef1fcb7ccb42adf69678d82f8bc15d2f7f55e0c582528f3ac8d4e71eac`.
The page states that `api_key` is mandatory for GTFS downloads and that the
default limit is 60 requests per 3,600 seconds. No 511 data was downloaded for
this lane because no authorized snapshot provenance was available without
credential access. Consequently, no fixture is labeled or presented as a real
511 snapshot.

## Safe real excerpts

`packages/testkit/src/sources/vta-caltrain-511-gtfs/official-excerpts.json`
contains only selected text rows from the two direct official ZIPs. The
extraction ran entirely in memory:

1. download the exact ZIP bytes;
2. verify the full byte count and SHA-256 above;
3. decode the named GTFS text members;
4. select the documented agency, feed, route, trip, service, exception, stop,
   stop-time, parent/entrance/platform, and transfer rows;
5. normalize CRLF/CR to LF without changing selected field values;
6. hash member name, NUL, content, NUL in sorted member-path order.

| Excerpt  | Included semantics                                                                                                                                | Deterministic excerpt SHA-256                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| VTA      | agency/feed identity, Blue route/trip, weekday calendar and removals, Santa Teresa boardable platform, Virginia parent station/elevator/platforms | `6eabea72ef4c4a1fa71706b3dc1328a8d03a9a2fe982332c56abd18a50d1fd13` |
| Caltrain | agency/feed identity, Local Weekday route/trip/calendar/removal, Palo Alto and San Jose Diridon parents/platforms, self-transfer rows             | `b434c8ad51b572a72915409746305f07caf1fd0e988e63963dad6298ff3d66e1` |

These are test excerpts, not a county production dataset. They contain no
personal data, logo, map, credential, full ZIP, or generated county artifact.

## Decode and normalization semantics

Transport exists only in discovery/acquisition. The decoder receives already
stored immutable ZIP bytes, rejects path traversal and duplicate member names,
then parses CSV as a separate deterministic step. Required members are
`agency.txt`, `stops.txt`, `routes.txt`, `trips.txt`, and `stop_times.txt`; at
least one of `calendar.txt` or `calendar_dates.txt` must exist, and both are
preserved when supplied. `transfers.txt` is optional because the captured VTA
feed does not provide it.

Normalization retains sorted snapshots of stops, routes, trips, calendars,
calendar exceptions, and transfers. Active service is computed for the pinned
selected date, including type-1 additions and type-2 removals. Stops retain
location type, parent station, platform, route/service links, and coordinates.
An eligible routing destination must:

- be a boardable stop/platform or boarding area;
- be served by an active trip on the selected date;
- permit passenger pickup (drop-off-only stops are retained but are not
  boardable destinations);
- have valid coordinates; and
- not reference a missing parent station.

Every other stop remains in the snapshot with one or more stable exclusion
reasons such as `not_boardable_location_type`,
`inactive_on_selected_service_date`, `pickup_forbidden`,
`missing_or_invalid_coordinates`, or `orphan_parent_station`. Parent stations,
entrances/elevators, and platforms are therefore not conflated or silently
dropped.

Canonical stop/service mutations carry deterministic IDs, exact source/
snapshot/artifact lineage, transformation hashes, and source visibility. The
lane's richer normalized snapshot remains the authoritative input for later
routing because the frozen canonical entities intentionally do not contain
every GTFS trip/calendar/transfer field.

## Direct/511 discrepancy behavior

Parity compares agency identity plus stop coordinates/parent identity and
complete selected route, trip, calendar, calendar-date, and transfer records.
Both normalized snapshots are retained. Discrepancies are deterministically
sorted and returned with both values. Selection rules are:

- direct present: select direct, preserve the fallback and discrepancies;
- direct absent and authorized fallback present: select fallback with an
  explicit limitation;
- neither present: fail;
- operator identities differ: fail.

Tests exercise parity, injected disagreement, and failover with in-memory
mutations of a direct official excerpt. Those mutations are never stored or
labeled as authentic 511 records. Separate injected-transport tests prove the
511 authorization/rate boundary and HTTP 429 classification.

## Verification coverage

Focused tests cover full/excerpt byte integrity, malformed CSV, missing ZIP
members, duplicate IDs, service exceptions, parents, entrances/platforms,
transfer stops, deterministic ordering, direct/fallback parity and
disagreement, direct precedence, fallback-only selection, 429 plus
`Retry-After`, credential-free request metadata, checkpoint resume, abort,
canonical lineage, source visibility, exclusion accounting, and balanced run
summaries.

The provider exposes lane-local factories and snapshot constants only. It is
not statically imported by the package registry and is not composed into an
application or pipeline by this task.
