# Santa Clara County ingest

Produces `data/santa-clara/santa-clara-query-table.parquet` — the query-table Parquet
that lets the serving stack swap from Lee County FL to Santa Clara County CA (the county
containing Palo Alto). Schema matches Lee's 37 columns exactly, plus 3 permit-derived
extras appended (`last_permit_date`, `last_reroof_date`, `is_reroof`).

## Sources
1. **Parcels (backbone)** — SCC Socrata dataset `ubcd-cewv`, GeoJSON with geometry.
   502,789 features. Centroided (shapely) for lat/lon; `shape_area_stateplane` is the
   real lot square footage (verified against UTM-10N reprojected ground area — the raw
   `shape_area` field is NOT sqft).
2. **San Jose permits** — `data/santa-clara/sj-permits.csv`, 17,824 rows, joined by APN.

## Re-run
```bash
# 1. Fetch + cache all parcel pages (idempotent; skips pages already on disk)
uv run --with requests python3 ingest/santa-clara/fetch_parcels.py

# 2. Build the query-table Parquet + run-summary.json
uv run --with duckdb --with shapely --with pyarrow --with base58 \
    python3 ingest/santa-clara/build_parquet.py
```
Raw parcel pages cache to `data/santa-clara/parcels-raw/page-NNNNN.geojson` (~650 MB,
11 pages of 50k). Never re-fetched once present. Outputs land in `data/santa-clara/`.

## APN reconciliation
Both the parcel roll (`apn`) and the permits (`ASSESSORS_PARCEL_NUMBER`) use the same
8-digit no-dash APN form (e.g. `58110062`). Both are normalized with
`[^0-9A-Za-z] -> ''` before joining. 8,667 distinct permit APNs; 7,771 match a parcel.

## What is real vs NULL
- **Real**: parcel identifier, situs address, lat/lon centroid, lot area, permits
  (count, dates, contractor-on-record, owner-from-permit), a genuine IPFS CIDv0 per
  parcel (`property_cid` = base58btc sha2-256 multihash of the canonical parcel JSON).
- **NULL (honest paid-Assessor gaps)**: owner counts/occupancy, assessed/market/land/AVM
  values, year built, livable area, last sale — a paid offline Assessor bulk order.
  `has_sunbiz_tenant` NULL (CA SOS bizfile is paid). See `run-summary.json` constraints.

## CSLB contractors (optional, not joined)
The county-wide CSLB licensed-contractor list is a separate dataset; `has_bbb_contractor`
in v1 is derived from the permit's own CONTRACTOR field (a real on-record signal), which
is sufficient for the demo. CSLB join deferred.
