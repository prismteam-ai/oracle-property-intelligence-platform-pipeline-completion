# Property-intelligence evidence semantics

This module implements ORA-060 through ORA-063 as deterministic, evidence-first feature
derivations. It consumes frozen canonical observations and produces immutable feature evidence; it
does not acquire sources, reconcile entities, query remote providers, or make publication decisions.

## Common result contract

Every roof, water, tenure, and regional-owner result contains:

- the canonical property and feature identifiers;
- `supportClass`: `supported`, `proxy`, `unknown`, or `unsupported`;
- the typed value, or `null` when evidence cannot support one;
- deterministically ordered source observations and merged source-record references;
- calculation name, semantic version, and parameters;
- as-of timestamp and jurisdiction/time-window coverage;
- explicit limitations and the strictest input visibility;
- an immutable `FeatureEvidence` envelope with a content-derived evidence ID.

Input order does not select evidence. Duplicate observation IDs fail validation, contradictory
domain identities return `unknown`, and source-record references are merged without discarding field
lineage. Restricted and `prohibited_public` inputs can only preserve or increase result restriction;
they are never downgraded to public.

## Roof age (ORA-060)

`deriveRoofAge` applies the frozen evidence order:

1. the latest conclusive replacement/installation permit with an explicit completion date and
   terminal status;
2. an issued-only conclusive roof-work permit as `issued_roof_permit_proxy`;
3. absence of a conclusive recent permit in a complete bounded permit window as
   `no_recent_roof_permit` proxy;
4. building/effective-building year as `building_age_proxy`;
5. otherwise `unknown`.

A finalized permit supports strict age only when the permit coverage window runs from that
completion through the result as-of date. This prevents an older observed permit from being called
the latest roof work while a newer interval is missing. Repair-only, generic roof, rooftop solar,
HVAC, skylight, gutter, and antenna wording do not become replacement evidence. Issuance does not
prove that work occurred. Building age and missing permits never prove actual roof age.

Age is calculated in whole UTC anniversary years. “Older than 15 years” is strict inequality: a
completion exactly 15 years before as-of is not older than 15.

## Potential water view (ORA-061)

`deriveWaterViewCandidate` computes mapped-water proximity from WGS 84 or Web Mercator coordinates,
selects geometry deterministically, and evaluates a supplied bare-earth terrain profile against a
straight terrain line-of-sight. The supported output is named `water_view_candidate`, never
`has_water_view`.

A positive candidate requires both:

- mapped hydrography/shoreline within the configured distance; and
- a valid terrain profile spanning the property-to-water distance, with property/water endpoints,
  at least one interior sample, and gaps bounded by the declared horizontal resolution, whose
  sampled bare-earth elevations do not obstruct the modeled line.

Proximity without valid terrain remains a proxy and sets `isWaterViewCandidate: false`. Missing
property coordinates or mapped-water observations returns `unknown`; source absence is not treated
as proof of no view. Truncated, two-point, materially out-of-range, or overly sparse profiles cannot
be promoted. Partial source coverage keeps an otherwise clear signal proxy-labeled.

Every result states that the model excludes buildings, trees, window placement, observer floor,
orientation, and site observation. `actualViewProven` is always `false`. The distance is a local
projected geometry distance, not a walking distance and not a hidden view assertion.

## Ownership tenure (ORA-062)

`deriveOwnershipTenure` requires all of the following for a strict result:

- overall ownership coverage is complete for the requested interval;
- current-owner and transfer-history substates are both complete;
- every supplied current interest and transfer is directly `supported` and temporally valid;
- a latest verified transfer exists;
- its grantee party set exactly matches the effective current-owner party set; and
- current interests do not begin after that transfer.

Partial, blocked, unknown, contradictory, future-dated, invalid, proxy, missing-transfer, or
owner/transfer-mismatch evidence returns `unknown`. Missing transfer rows can never produce a
positive “no exchange” answer. Tenure uses whole UTC anniversary years and the threshold is strict,
so exactly ten years does not satisfy “more than ten years.”

## Regional owner (ORA-063)

The frozen policy is `bay-area-nine-counties-v1`:

| Policy field              | Value                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| Basis                     | Verified current-owner mailing county                                                     |
| Meaning of regional owner | At least one current owner mails from outside the included counties                       |
| Included counties         | Alameda, Contra Costa, Marin, Napa, San Francisco, San Mateo, Santa Clara, Solano, Sonoma |
| Unknown handling          | Exclude and report                                                                        |

Regional-owner classification uses the same complete supported transfer/current-owner proof as
tenure. An address in adjacent Santa Cruz County is outside the policy; Santa Clara County is
inside. Out-of-state and non-US verified locations are outside. A PO box, unresolved geocode,
missing county, contradictory current-owner record, or partial/blocked transfer history returns
`unknown`.

The typed value exposes only counts and coarse classification. It never contains owner names or raw
mailing addresses. Source visibility still propagates, so evidence derived from
`prohibited_public` observations remains `prohibited_public` even though the value is redacted.

## Reproducible checks

With the required Node runtime on `PATH`:

```powershell
$env:PATH = 'E:\nvm\v22.18.0;' + $env:PATH
pnpm --filter @oracle/features test
pnpm --filter @oracle/features lint
pnpm --filter @oracle/features typecheck
pnpm --filter @oracle/features build
pnpm --filter @oracle/testkit test
pnpm --filter @oracle/testkit lint
pnpm --filter @oracle/testkit typecheck
pnpm --filter @oracle/testkit build
```

The safe golden registry is under
`packages/testkit/src/features/property-intelligence/goldens.json`. It freezes strict, proxy,
unknown, blocked-ownership, no-actual-view, and public-owner-redaction expectations without carrying
real owner data.
