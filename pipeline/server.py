"""Minimal UI: one "Pull Data" button, live per-source progress and record counts."""
import threading
import time

from flask import Flask, jsonify, request, send_from_directory

from . import state
from .agent import answer, filter_options, filtered
from .build_db import query
from .etl import load_etl_summary
from .ipfs_publish import ensure_pinned, load_manifest, pinned_cids
from .run_pipeline import run_all

SOURCE_INFO = {
    "properties": {
        "label": "Property records (parcels)",
        "provider": "California statewide parcel layer (ArcGIS), filtered to Santa Clara County cities",
        "limitations": "County's own GIS endpoints are offline/Cloudflare-blocked, so a statewide "
                       "mirror is used. Condo units can share one APN. No assessed-value roll "
                       "(restricted by the county assessor).",
    },
    "permits": {
        "label": "Building permits",
        "provider": "City of San José open data portal (CKAN) — active, expired and under-inspection sets",
        "limitations": "San José only: other SCC cities publish no machine-readable permit feed. "
                       "Issue dates arrive as text and are parsed at build time.",
    },
    "ownership": {
        "label": "Ownership records",
        "provider": "SCC assessor GIS parcel layer with owner fields (ArcGIS)",
        "limitations": "Only ~231 parcels expose owner fields publicly — the bulk assessor roll and "
                       "recorded deeds are not open data. Parcel centroids are matched to the "
                       "nearest address point (≤250 m) for cross-source joins; ownership tenure "
                       "is inferred from permit history, not deeds.",
    },
    "contractors": {
        "label": "Licensed contractors",
        "provider": "CSLB data portal, licenses listed by county (Santa Clara = 43)",
        "limitations": "Scraped via an ASP.NET form postback that returns XLSX; fragile if CSLB "
                       "changes the page. Reflects license mailing county, not job locations.",
    },
    "businesses": {
        "label": "Businesses & transit stops",
        "provider": "OpenStreetMap via Overpass API (county relation 396501)",
        "limitations": "No SCC city publishes an open business-license registry, so coverage is "
                       "community-mapped OSM data: completeness varies and mirrors rate-limit.",
    },
    "locations": {
        "label": "Address points / coordinates",
        "provider": "City of San José address point layer (ArcGIS)",
        "limitations": "San José only (~395k points, capped pull). The layer's APN field is null "
                       "server-side, so cross-source matching uses normalized street addresses.",
    },
}

app = Flask(__name__, static_folder="ui/static", static_url_path="")
_worker = {"thread": None}
_pins_cache = {"at": 0.0, "pins": set()}


def _pins():
    if time.time() - _pins_cache["at"] > 30:
        pins = pinned_cids()
        manifest_cids = {a.get("cid") for a in load_manifest().get("artifacts", {}).values()}
        if manifest_cids - {None} - pins:
            pins = ensure_pinned()  # self-heal: repo is ephemeral in hosted deploys
        _pins_cache["pins"] = pins
        _pins_cache["at"] = time.time()
    return _pins_cache["pins"]


@app.get("/")
@app.get("/pipeline")
def index():
    return send_from_directory(app.static_folder, "pipeline.html")


@app.get("/data")
def data_page():
    return send_from_directory(app.static_folder, "data.html")


@app.get("/chat")
def chat_page():
    return send_from_directory(app.static_folder, "chat.html")


@app.get("/api/filter/options")
def filter_options_api():
    return jsonify(filter_options())


@app.get("/api/filter")
def filter_api():
    filters = [f for f in request.args.get("f", "").split(",") if f]
    try:
        limit = min(int(request.args.get("limit", 100)), 500)
        offset = max(int(request.args.get("offset", 0)), 0)
    except ValueError:
        return jsonify({"error": "bad limit/offset"}), 400
    params = {f: request.args[f"p_{f}"] for f in filters if f"p_{f}" in request.args}
    return jsonify(filtered(
        filters, limit=limit, offset=offset, params=params,
        city=request.args.get("city") or None,
        q=request.args.get("q") or None,
        sort=request.args.get("sort") or None,
        order="desc" if request.args.get("order") == "desc" else "asc"))


@app.post("/api/chat")
def chat_api():
    from flask import request as req
    message = (req.get_json(silent=True) or {}).get("message", "")
    if not message.strip():
        return jsonify({"error": "empty message"}), 400
    return jsonify(answer(message))


@app.post("/api/pull")
def pull():
    if _worker["thread"] and _worker["thread"].is_alive():
        return jsonify({"ok": False, "error": "pipeline already running"}), 409
    t = threading.Thread(target=run_all, daemon=True)
    t.start()
    _worker["thread"] = t
    return jsonify({"ok": True})


@app.get("/api/status")
def status():
    s = state.get_state()
    # trust the worker thread, not a possibly-stale state file
    s["running"] = bool(_worker["thread"] and _worker["thread"].is_alive())
    manifest = load_manifest()
    pins = _pins()
    for art in manifest.get("artifacts", {}).values():
        art["pinned"] = bool(art.get("cid")) and art["cid"] in pins
    s["manifest"] = manifest
    s["etl"] = load_etl_summary()
    s["source_info"] = SOURCE_INFO
    from .config import MAX_RECORDS
    s["max_records"] = MAX_RECORDS
    return jsonify(s)


@app.get("/api/tables")
def tables():
    return jsonify(sorted(load_manifest().get("artifacts", {}).keys()))


@app.get("/api/data")
def data():
    table = request.args.get("table", "")
    if table not in load_manifest().get("artifacts", {}):
        return jsonify({"error": "unknown table"}), 400
    try:
        limit = min(int(request.args.get("limit", 50)), 500)
        offset = max(int(request.args.get("offset", 0)), 0)
    except ValueError:
        return jsonify({"error": "bad limit/offset"}), 400
    total = query(f"SELECT COUNT(*) FROM {table}")["rows"][0][0]
    res = query(f"SELECT * FROM {table} LIMIT {limit} OFFSET {offset}")
    res.update(total=total, offset=offset, limit=limit, table=table)
    return jsonify(res)


if __name__ == "__main__":
    import os
    app.run(host=os.environ.get("HOST", "127.0.0.1"),
            port=int(os.environ.get("PORT", "5050")), debug=False)
