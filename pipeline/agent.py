"""Property intelligence agent over the DuckDB/IPFS dataset.

Translates natural-language questions into DuckDB SQL over precomputed
feature marts (see features.py — parsing, normalization and spatial joins
happen once at build time, not per question). Returns matching rows plus the
reasoning basis, assumptions and source provenance. Raw SELECT statements
pass through; Claude handles narration and off-bank questions when a key is
configured.
"""
import re

from . import llm
from .build_db import query
from .features import WALK_M


def _run(sql, max_rows=500):
    return query(sql, max_rows=max_rows)


# Parameterized filter definitions: mart table, WHERE-clause template,
# parameter name, default (= chat behavior), allowed choices, sort column.
FILTER_DEFS = {
    "roof": {
        "table": "feat_roof", "where": "roof_age_years >= {v}",
        "param": "min_years", "default": 15, "choices": [5, 10, 15, 20, 25, 30],
        "order": "roof_age_years DESC", "unit": "years",
        "label": "Roof age ≥",
    },
    "stable_owner": {
        "table": "feat_stable_owner", "where": "years_of_history >= {v}",
        "param": "min_years", "default": 10, "choices": [5, 10, 15, 20, 25],
        "order": "years_of_history DESC", "unit": "years",
        "label": "Same owner ≥",
    },
    "regional": {
        "table": "feat_regional", "where": "owner_state = '{v}'",
        "param": "state", "default": "CA", "choices": ["CA"],
        "order": "land_value DESC NULLS LAST", "unit": "",
        "label": "Owner state =",
    },
    "water": {
        "table": "feat_water", "where": "meters_to_water <= {v}",
        "param": "max_m", "default": 1200, "choices": [500, 800, 1200, 2000, 3000],
        "order": "meters_to_water", "unit": "m",
        "label": "Water within",
    },
    "transit": {
        "table": "feat_transit", "where": "distance_m <= {v}",
        "param": "max_m", "default": WALK_M, "choices": [200, 400, 800, 1200, 1600],
        "order": "distance_m", "unit": "m",
        "label": "Transit within",
    },
    "starbucks": {
        "table": "feat_starbucks", "where": "distance_m <= {v}",
        "param": "max_m", "default": WALK_M, "choices": [200, 400, 800, 1200, 1600],
        "order": "distance_m", "unit": "m",
        "label": "Starbucks within",
    },
}


def _sanitize(v, default):
    """Coerce a filter parameter to a safe value (int, or whitelisted string)."""
    if isinstance(default, int):
        try:
            return int(v)
        except (TypeError, ValueError):
            return default
    v = str(v)
    return v if re.fullmatch(r"[A-Za-z ]{1,30}", v) else default


def _filter_sql(name, value=None, limit=25):
    d = FILTER_DEFS[name]
    v = _sanitize(value, d["default"]) if value is not None else d["default"]
    return (f"SELECT * FROM {d['table']} WHERE {d['where'].format(v=v)} "
            f"ORDER BY {d['order']} LIMIT {limit}")


def _mart_sql(name):
    def fn(limit=25):
        return _filter_sql(name, limit=limit)
    return fn


_roof_sql = _mart_sql("roof")
_stable_owner_sql = _mart_sql("stable_owner")
_regional_owner_sql = _mart_sql("regional")
_water_sql = _mart_sql("water")


INTENTS = {
    "roof": (re.compile(r"roof", re.I), _roof_sql,
             "Roof age inferred from the most recent roofing permit (San Jose "
             "building permits). Properties whose last roof permit was issued "
             "more than 15 years ago."),
    "stable_owner": (re.compile(r"(not exchanged|no.{0,20}(exchange|transfer|sale)|"
                                r"same owner|ownership.{0,30}(10|ten) year|"
                                r"owner(ship)? (age|history))", re.I),
                     _stable_owner_sql,
                     "No recorded-deed feed is open data, so ownership stability is "
                     "inferred from permit history: parcels whose permits span 10+ "
                     "years under a single owner name (assumption: an ownership "
                     "change would surface a different owner on later permits)."),
    "regional": (re.compile(r"regional owner", re.I), _regional_owner_sql,
                 "Regional owners = owner mailing address in California per the "
                 "county assessor GIS ownership layer."),
    "water": (re.compile(r"water", re.I), _water_sql,
              "Water view proxied by geography: parcel centroid within 1,200 m of "
              "a named water body (SF Bay, county reservoirs/lakes). Assumption: "
              "proximity ≈ potential view; no line-of-sight analysis."),
    "transit": (re.compile(r"(transit|transportation|bus|train|caltrain|vta)", re.I),
                _mart_sql("transit"),
                f"Walking distance = ≤{WALK_M} m haversine from property coordinate "
                "(San Jose address points) to an OSM transit stop (bus/rail)."),
    "starbucks": (re.compile(r"starbucks|coffee", re.I),
                  _mart_sql("starbucks"),
                  f"Walking distance = ≤{WALK_M} m haversine from property coordinate "
                  "to an OSM-mapped Starbucks location."),
}

CANDIDATE_RE = re.compile(r"(strong candidate|further review|rank|score|best propert)", re.I)


def _key_index(res):
    cols = res["columns"]
    return cols.index("match_key") if "match_key" in cols else cols.index("apn")


def _candidates():
    """Rank parcels by combined signals: roof age, owner stability, transit access."""
    roof = _run(_roof_sql(limit=500))
    stable = _run(_stable_owner_sql(limit=500))
    transit = _run(INTENTS["transit"][1](limit=500))
    scores = {}
    info = {}
    for res, signal in ((roof, "roof>15y"), (stable, "owner-stable>10y"), (transit, "near-transit")):
        ki = _key_index(res)
        addr_col = next((c for c in ("address", "full_address") if c in res["columns"]), None)
        for row in res["rows"]:
            key = row[ki]
            if not key:
                continue
            sigs = scores.setdefault(key, [])
            if signal not in sigs:
                sigs.append(signal)
            if addr_col and key not in info:
                info[key] = row[res["columns"].index(addr_col)]
    ranked = sorted(scores.items(), key=lambda kv: -len(kv[1]))[:25]
    rows = [[info.get(key, key), len(sig), ", ".join(sig)] for key, sig in ranked]
    return {
        "columns": ["address", "score", "signals"],
        "rows": rows,
        "basis": ("Ranked by count of positive signals: roof permit >15 years old, "
                  "single owner across 10+ years of permits, and within walking "
                  "distance of transit. Missing data (e.g., no permit history) "
                  "lowers a parcel's visibility — absence of a signal is not "
                  "evidence of absence."),
        "sql": "-- composite of roof/stable-owner/transit queries, scored in the agent",
    }


_schema_cache = {}


def _schema():
    if "s" not in _schema_cache:
        res = _run("SELECT table_name, string_agg(column_name, ', ') cols "
                   "FROM information_schema.columns "
                   "WHERE table_schema = 'main' AND table_name NOT LIKE '%\\_ipfs' ESCAPE '\\' "
                   "GROUP BY table_name")
        _schema_cache["s"] = "\n".join(f"{t}({c})" for t, c in res["rows"])
    return _schema_cache["s"]


def _finish(msg, res):
    """Attach a Claude-generated narrative when the LLM is configured."""
    if not res.get("error"):
        narrative = llm.narrate(msg, res)
        if narrative:
            res["narrative"] = narrative
    return res


def answer(message: str) -> dict:
    msg = message.strip()
    if re.match(r"^\s*(select|with)\b", msg, re.I):
        try:
            res = _run(msg)
            res["basis"] = "Raw SQL executed against DuckDB (read-only)."
            res["sql"] = msg
            return res
        except Exception as exc:
            return {"error": str(exc)}

    if CANDIDATE_RE.search(msg):
        return _finish(msg, _candidates())

    matched = [(name, sql_fn, basis) for name, (rx, sql_fn, basis) in INTENTS.items()
               if rx.search(msg)]
    if not matched:
        if llm.available():
            sql = llm.generate_sql(msg, _schema())
            if sql:
                try:
                    res = _run(sql)
                    res["basis"] = ("No rule-based intent matched; Claude generated "
                                    "this DuckDB SQL from the question and schema.")
                    res["sql"] = sql
                    return _finish(msg, res)
                except Exception:
                    pass
        return {
            "columns": [], "rows": [],
            "basis": ("I can answer questions about: roofs older than 15 years, "
                      "properties with a water view, ownership unchanged for 10+ "
                      "years, regional owners, walking distance to public "
                      "transportation or Starbucks, strong candidates for review — "
                      "or run any raw SELECT against tables: properties, permits, "
                      "ownership, contractors, businesses, locations."),
            "sql": "",
        }

    if len(matched) == 1:
        name, sql_fn, basis = matched[0]
        sql = sql_fn()
        try:
            res = _run(sql)
        except Exception as exc:
            return {"error": str(exc), "sql": sql}
        res["basis"] = basis
        res["sql"] = sql
        return _finish(msg, res)

    # multiple intents: intersect by normalized address (match_key)
    parts = []
    bases = []
    for name, sql_fn, basis in matched:
        sql = sql_fn(limit=200000) if callable(sql_fn) else sql_fn
        try:
            parts.append(_run(sql, max_rows=200000))
            bases.append(f"[{name}] {basis}")
        except Exception as exc:
            return {"error": str(exc), "sql": sql}
    keysets = []
    for r in parts:
        ki = _key_index(r)
        keysets.append({row[ki] for row in r["rows"] if row[ki]})
    common = set.intersection(*keysets) if keysets else set()
    first = parts[0]
    ki = _key_index(first)
    rows = [r for r in first["rows"] if r[ki] in common][:25]
    return _finish(msg, {
        "columns": first["columns"],
        "rows": rows,
        "basis": ("Intersection of criteria by normalized property address. " +
                  " ".join(bases) +
                  f" {len(common)} properties satisfy all criteria."),
        "sql": "-- intersection of intent queries by normalized address",
    })


ADDRESS_COLS = ("address", "full_address", "situs_address")
SKIP_COLS = {"apn", "match_key", "source", "property_source", "poi_source",
             "evidence"} | set(ADDRESS_COLS)


def filter_options():
    """Filter metadata + distinct city list for the Data Exploration page."""
    cities = _run("""
        SELECT DISTINCT city FROM (
          SELECT city FROM feat_transit
          UNION ALL SELECT city FROM feat_water
          UNION ALL SELECT city FROM locations)
        WHERE city IS NOT NULL AND trim(city) != '' ORDER BY 1""", max_rows=200)
    return {
        "filters": {name: {"label": d["label"], "param": d["param"],
                           "default": d["default"], "choices": d["choices"],
                           "unit": d["unit"], "basis": INTENTS[name][2]}
                    for name, d in FILTER_DEFS.items()},
        "cities": [r[0].title() for r in cities["rows"]],
    }


def filtered(filters, limit=100, offset=0, params=None, city=None, q=None,
             sort=None, order="asc"):
    """Dynamic filter API for the Data Exploration page: run each parameterized
    filter, intersect by normalized address, merge evidence columns, then apply
    city/address search and sorting."""
    params = params or {}
    filters = [f for f in filters if f in FILTER_DEFS]
    if not filters:
        return {"error": "no valid filters", "available": list(FILTER_DEFS)}
    per_filter = {}
    bases = []
    for name in filters:
        d = FILTER_DEFS[name]
        value = _sanitize(params.get(name, d["default"]), d["default"])
        sql = _filter_sql(name, value, limit=200000)
        res = _run(sql, max_rows=200000)
        bases.append(f"[{name} {d['label'].lower()} {value}{d['unit']}] {INTENTS[name][2]}")
        ki = _key_index(res)
        addr_i = next((res["columns"].index(c) for c in ADDRESS_COLS
                       if c in res["columns"]), None)
        city_i = res["columns"].index("city") if "city" in res["columns"] else None
        keep = [(i, c) for i, c in enumerate(res["columns"])
                if c not in SKIP_COLS and c != "city"]
        rows = {}
        for row in res["rows"]:
            key = row[ki]
            if not key:
                continue
            rows[key] = {
                "address": row[addr_i] if addr_i is not None else None,
                "city": row[city_i] if city_i is not None else None,
                "cols": {c: row[i] for i, c in keep},
            }
        per_filter[name] = rows
    common = set.intersection(*(set(v) for v in per_filter.values()))
    columns = ["address", "city"]
    for name in filters:
        sample = next(iter(per_filter[name].values()), {"cols": {}})
        columns += [f"{name}: {c}" for c in sample["cols"]]
    out = []
    q_up = (q or "").strip().upper()
    city_up = (city or "").strip().upper()
    for key in common:
        address = next((per_filter[n][key]["address"] for n in filters
                        if per_filter[n][key]["address"]), key)
        row_city = next((per_filter[n][key]["city"] for n in filters
                         if per_filter[n][key]["city"]), None)
        hay = f"{address or ''} {key}".upper()
        if q_up and q_up not in hay:
            continue
        if city_up and city_up not in f"{row_city or ''} {hay}".upper():
            continue
        row = [address, (row_city or "").title() or None]
        for name in filters:
            row += list(per_filter[name][key]["cols"].values())
        out.append(row)
    # sort by requested column (numbers before strings, None last)
    if sort in columns:
        si = columns.index(sort)
        def keyf(r):
            v = r[si]
            return (v is None, not isinstance(v, (int, float)), v)
        out.sort(key=keyf, reverse=(order == "desc"))
    else:
        out.sort(key=lambda r: (r[0] is None, r[0]))
    total = len(out)
    return {
        "columns": columns,
        "rows": out[offset:offset + limit],
        "total": total, "offset": offset, "limit": limit,
        "basis": " ".join(bases) +
                 f" — {total} properties satisfy all selected filters"
                 + (f", city~'{city}'" if city else "")
                 + (f", address~'{q}'" if q else "")
                 + " (matched on normalized address).",
    }
