# OpenStreetMap pedestrian graph source

Status: ORA-041 lane-local adapter and deterministic graph input implemented.

## Purpose and semantic boundary

This provider acquires one immutable regional OpenStreetMap PBF and turns decoded
OSM elements into deterministic pedestrian graph input. It is not a routing
engine. In particular:

- an edge is routable only when pedestrian access, pedestrian direction, and
  endpoint-barrier semantics are all resolved as allowed and the way has a
  highway class supported by the versioned routing profile;
- explicit `foot=yes|designated|permissive|destination` records permission but
  does not by itself turn arbitrary way geometry into pedestrian topology;
- forbidden and unknown access remain non-routable with explicit reasons;
- `oneway:foot` is preserved as the pedestrian direction. Generic vehicle
  `oneway` is retained in source tags but is not silently promoted to a foot
  restriction;
- crossings, barriers, entrances, levels, source tags, turn restrictions, and
  disconnected components remain visible;
- edge geometry is only the two endpoint coordinates. The graph emits no
  distance field and never presents straight-line length as walking distance;
- later ORA-064 routing must calculate network distance over this graph and
  retain the exact graph/reference version.

This is intentionally fail-closed. A richer country-specific OSM access profile
can be added as a new routing-profile version, not as an unrecorded behavior
change.

## Production source lock

The initial fixed distributor identity is:

| Field                                  | Frozen value                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| Authority                              | OpenStreetMap contributors                                                        |
| Distributor                            | Geofabrik GmbH                                                                    |
| Extract                                | `geofabrik-norcal-260715`                                                         |
| Artifact URL                           | `https://download.geofabrik.de/north-america/us/california/norcal-260715.osm.pbf` |
| Distributor page                       | `https://download.geofabrik.de/north-america/us/california/norcal.html`           |
| Observed size                          | `646,753,595` bytes                                                               |
| Observed ETag                          | `"268cad3b-656af935b1984"`                                                        |
| Observed Last-Modified                 | `2026-07-16T00:32:31.000Z`                                                        |
| Geofabrik MD5 sidecar                  | `e30b21d7c7cfd4c9e6f4f11cae3bfaa0`                                                |
| Approximate distributor polygon bounds | `[-125.8935, 35.79231, -115.6468, 42.01618]`                                      |

The repository does **not** claim a SHA-256 for that 646 MB archive. A
no-disk stream did not finish within the bounded tool window, and the prohibited
full-PBF temporary download was stopped and removed. The exported distributor
identity therefore has
`sha256State: runtime_required_unavailable_in_repository` and deliberately does
not contain `expectedSha256`.

Production composition must acquire the approved dated artifact, verify the
Geofabrik sidecar/HTTP identity, compute SHA-256, then create a
`PinnedOsmExtract` with that exact hash. The adapter refuses `latest` URLs,
missing/malformed SHA-256, invalid bounds, mismatched snapshot IDs, changed HEAD
identity, byte-size drift, and byte-hash drift. The deterministic snapshot ID is
`sc:snapshot:osm-pedestrian-graph:<sha256>`.

This approach pins a recognized regional bulk extract and avoids a county-scale
dependency on public Overpass. The OpenStreetMap API is used only to produce the
small committed test excerpt described below.

## Frozen phase architecture

The lane follows the repository source SPI without global composition:

1. `discover` performs an injected `HEAD` and verifies size, ETag, and
   Last-Modified.
2. `plan` accepts exactly one dated PBF whose snapshot ID matches the configured
   SHA-256.
3. `acquire` performs an injected, retry-aware `GET`, verifies exact bytes,
   writes through the immutable artifact-store port, and commits the checkpoint.
4. `decode` passes only immutable acquired bytes to an injected `OsmPbfDecoder`.
   The decoder has no HTTP/Overpass authority.
5. `validate` rejects malformed IDs, versions, timestamps, coordinates, tags,
   way node references, and relation members.
6. `normalize` emits deterministic raw artifact-reference mutations for valid
   elements. `normalizeOsmPedestrianGraph` builds stable nodes, directed edges,
   components, exclusions, and restriction inputs.
7. `createPedestrianGraphReferenceMutation` emits the canonical
   `pedestrian-graph-ref` with immutable lineage and graph counts.
8. `summarize` reconciles artifact, record, mutation, issue, and visibility
   counts.

The PBF parser is an injected application concern because the shared-freeze
manifest intentionally contains no OSM parser dependency. Transport, PBF
decoding, validation, and graph semantics therefore remain separately testable.
No provider is registered or composed globally in this lane.

## Access, direction, and barrier policy (`1.0.0`)

- Explicit `foot=yes|designated|permissive|destination` is allowed.
- Explicit `foot=no|private` is forbidden.
- Without `foot`, explicit `access=no|private` is forbidden and allowed access
  values are allowed.
- Without access tags, only `footway`, `path`, `pedestrian`, `steps`, and
  `living_street` receive the profile's documented pedestrian default.
  Other highway classes remain unknown/non-routable.
- This profile recognizes `footway`, `path`, `pedestrian`, `steps`,
  `living_street`, `cycleway`, `residential`, `service`, `track`, and
  `unclassified` as pedestrian-capable topology classes. Classes outside that
  set, or ways without `highway`, remain non-routable with
  `missing_or_unsupported_highway` even when an explicit `foot` tag allows
  access. A future profile version may expand the set with corresponding tests.
- `oneway:foot=yes|1|true` is forward-only; `-1|reverse` is reverse-only;
  `no|0|false` or absence is bidirectional. Unknown values are preserved as
  non-routable direction.
- An explicitly foot-allowed gate/lift gate remains traversable and retains its
  barrier tag. Wall/fence/hedge/block barriers are forbidden. Other unresolved
  barriers are non-routable.
- OSM restriction relations retain `from`, `via`, and `to` members. A
  `restriction:foot` is pedestrian-specific; generic restrictions honor
  `except=foot`.

Every graph node, edge, restriction, and exclusion retains its OSM element key.
The graph provenance retains source/snapshot/artifact IDs, extract identity,
timestamp, bounds, byte hash, distributor, attribution, notice, and ODbL
share-alike state.

## Tiny real fixture

Committed fixture:
`packages/testkit/src/sources/osm-pedestrian-graph/official-osm-api-excerpt.json`.

Provenance:

- official endpoint:
  `https://api.openstreetmap.org/api/0.6/map.json?bbox=-122.0775,37.3935,-122.0755,37.3950`;
- retrieved/response date: `2026-07-17T13:01:50.000Z`;
- original response: `827,449` bytes, SHA-256
  `189d07439c1becfd99729c94eff937fbda2360dd94834c8e768a44d274bd9ab8`;
- selected real ways: `133164448`, `152943929`, and `152945039`, plus exactly
  their referenced nodes;
- deterministic extraction: allowlist element fields, remove contributor
  `user`, `uid`, and `changeset`, sort elements by type/numeric ID, recursively
  sort object keys, compact UTF-8 JSON;
- canonical excerpt: `3,097` bytes, SHA-256
  `249ce822d0e91bdd2ed81d4432c9ecc7fee1a9c7cd935889f0e7b91ac5b6425d`;
- content: 15 nodes and three ways with real footways, crossings, lift gates,
  and gates explicitly accessible on foot;
- scope: test-only and never production/county data.

`provenance.test.ts` independently canonicalizes the committed JSON and verifies
the exact byte length/hash, ODbL links, attribution, and absence of contributor
identifiers. Provider tests inject these real decoded records after an opaque
PBF transport sentinel; this proves the frozen PBF/decoded-record boundary
without fabricating 511-style source records or committing a county PBF.

## License, NOTICE, and share-alike

OpenStreetMap data is available under the Open Database License 1.0. Required
attribution is `© OpenStreetMap contributors`, linked to
<https://www.openstreetmap.org/copyright>. The ODbL text is at
<https://opendatacommons.org/licenses/odbl/1-0/>. OpenStreetMap Foundation
guidance explains that public derivative databases must preserve attribution
and satisfy applicable share-alike obligations:
<https://osmfoundation.org/wiki/Licence/Licence_and_Legal_FAQ>.

The graph output carries the frozen NOTICE and `shareAlike: true`. A downstream
artifact/publication lane must keep the attribution and NOTICE, classify whether
its joined output is a derivative database or produced work, and apply the
appropriate ODbL obligations. This adapter does not make that later legal
classification disappear.

## Verification coverage

Automated tests cover:

- immutable URL/hash configuration, HEAD identity, byte integrity, 429 with
  `Retry-After`, checkpoint resume, and abort propagation;
- injected PBF bytes versus decoded-record separation;
- exact duplicate deduplication and conflicting duplicate rejection;
- malformed coordinates/tags/way references/relation members;
- foot access, forbidden and unknown access, `oneway:foot`, crossings,
  pedestrian-passable and impassable barriers, levels, entrances, turn
  restrictions, disconnected components, and explicit foot permission on ways
  with missing or unsupported highway classifications;
- stable node/edge/component IDs and ordering under reversed input;
- exclusion reasons, deterministic graph normalization, and strict no-distance
  claims;
- canonical graph-reference lineage, visibility, ODbL provenance, attribution,
  and source-run summary accounting.

Focused commands:

```powershell
$env:PATH = 'E:\nvm\v22.18.0;' + $env:PATH
pnpm exec eslint packages/source-adapters/src/providers/osm-pedestrian-graph packages/testkit/src/sources/osm-pedestrian-graph
pnpm exec prettier --check "packages/source-adapters/src/providers/osm-pedestrian-graph/**/*.{ts,json}" "packages/testkit/src/sources/osm-pedestrian-graph/**/*.{ts,json}" docs/sources/osm-pedestrian-graph.md
pnpm --filter @oracle/source-adapters test
pnpm --filter @oracle/testkit test
```

## Tradeoffs

- The parser is injected instead of adding a package dependency during the
  shared freeze. This keeps acquisition and PBF parsing separable and lets a
  later composition select a streaming parser without changing the provider
  contract.
- The profile deliberately under-routes ambiguous OSM data. This can reduce
  reachability, but it avoids claiming a route through private/unknown access or
  unresolved barriers.
- The canonical reference currently points at the immutable source artifact
  while the deterministic graph snapshot remains an input/reference object.
  ORA-064 can store the normalized graph as its own immutable artifact and emit
  a successor reference without changing source acquisition.
