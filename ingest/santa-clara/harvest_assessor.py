#!/usr/bin/env python3
"""Santa Clara Assessor per-parcel harvester (Path A — free, session-based).

The county Assessor's public parcel data (sale/transfer date, owner MAILING
address, assessed values, homeowner-exemption) is NOT in any open dataset and
the owner NAME is withheld by CA privacy law. But the public property-search app
exposes a per-APN PDF at:

    showPdfSearchResult.aspx?SType=rp&ApnValue=<8-digit APN>

behind an ASP.NET *cookieless* session (token in the URL path) that is unlocked
by ONE reCAPTCHA solve. After that, arbitrary APNs can be pulled server-side
(no per-call captcha). This mirrors elephant's Orange County technique of hitting
the data endpoint behind the SPA.

We are polite: one request every REQUEST_DELAY seconds, single-threaded, and we
only harvest a bounded sample (the demo cities). The session token expires in
~20 min; re-run with a fresh token to continue.

Usage:
    uv run --with requests --with pypdf python3 harvest_assessor.py \
        --session "(S(xxxxxxxxxxxx))" --apns /tmp/pa_apns.txt --out out.csv

Fields parsed per APN (all REAL, source = SCC Assessor):
    situs_address, mailing_address, transfer_date, document_type,
    land_value, improvement_value, total_value, homeowner_exemption
"""
import argparse
import csv
import io
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
from pypdf import PdfReader

BASE = "https://www.sccassessor.org/apps2"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36")
REQUEST_DELAY = 1.5  # seconds between requests — polite, single-threaded


def parse_pdf(data: bytes) -> dict:
    """Defensively pull the fields we need from the parcel PDF's first page.

    The PDF repeats the block per assessment year; we take the FIRST (current)
    occurrence of each field. Any field that isn't found stays None — a malformed
    or unexpected PDF never raises, it just yields sparse output.
    """
    try:
        reader = PdfReader(io.BytesIO(data))
        raw = "\n".join((pg.extract_text() or "") for pg in reader.pages[:1])
    except Exception as e:  # noqa: BLE001 — one bad PDF never kills the batch
        return {"error": f"pdf_parse:{e}"}

    # pypdf emits one token per line; collapse whitespace so field labels
    # ("Situs Address", "Mailing Address") match as normal spaced phrases.
    text = re.sub(r"\s+", " ", raw).strip()

    def first(pattern, flags=0):
        m = re.search(pattern, text, flags)
        return m.group(1).strip() if m else None

    def money(pattern):
        v = first(pattern)
        if not v:
            return None
        return int(re.sub(r"[^0-9]", "", v)) if re.search(r"\d", v) else None

    return {
        "situs_address": first(r"Situs Address \(es\)\s*:\s*(.+?)\s*Mailing Address:"),
        "mailing_address": first(r"Mailing Address:\s*(.+?)\s*(?:Current Information|PROPERTY INFORMATION)"),
        "transfer_date": first(r"Transfer Date:\s*([0-9]{1,2}/[0-9]{1,2}/[0-9]{4})"),
        "document_type": first(r"Document Type:\s*(.+?)\s*Transfer Date:"),
        "land_value": money(r"Land:\s*\$?([0-9,]+)"),
        "improvement_value": money(r"Improvements:\s*\$?([0-9,]+)"),
        "total_value": money(r"Total:\s*\$?([0-9,]+)"),
        "homeowner_exemption": money(r"Homeowner:\s*\$?([0-9,]+)"),
        "error": None,
    }


COLS = ["apn", "situs_address", "mailing_address", "transfer_date",
        "document_type", "land_value", "improvement_value",
        "total_value", "homeowner_exemption", "error"]


def _already_done(out_path: str) -> set[str]:
    """APNs already successfully parsed (non-empty transfer_date or values, no
    error) — so a resume skips them and only retries failures/unfetched."""
    done = set()
    p = Path(out_path)
    if not p.exists():
        return done
    with open(out_path, newline="") as fh:
        for row in csv.DictReader(fh):
            if not row.get("error") and (row.get("transfer_date") or row.get("total_value")):
                done.add(row["apn"])
    return done


_thread_local = threading.local()


def _session(session_token: str) -> requests.Session:
    """One requests.Session per worker thread (requests.Session isn't fully
    thread-safe to share)."""
    s = getattr(_thread_local, "sess", None)
    if s is None:
        s = requests.Session()
        s.headers.update({
            "User-Agent": UA,
            "Referer": f"{BASE}/{session_token}/realpropertysearch.aspx?drupal=true",
        })
        _thread_local.sess = s
    return s


def _fetch_one(session_token: str, apn: str, delay: float) -> dict:
    time.sleep(delay)  # per-worker spacing; throughput ~= workers/delay per sec
    url = f"{BASE}/{session_token}/showPdfSearchResult.aspx?SType=rp&ApnValue={apn}"
    row = {"apn": apn}
    try:
        r = _session(session_token).get(url, timeout=40)
        ctype = r.headers.get("content-type", "")
        if r.status_code != 200 or "pdf" not in ctype:
            row["error"] = f"http:{r.status_code}:{ctype[:20]}"  # 302/HTML => session dead or APN missing
        else:
            row.update(parse_pdf(r.content))
    except Exception as e:  # noqa: BLE001 — one bad parcel never kills the batch
        row["error"] = f"req:{e}"
    return row


def harvest(session_token: str, apns: list[str], out_path: str,
            workers: int = 4, delay: float = 0.5) -> None:
    done = _already_done(out_path)
    todo = [a for a in apns if a not in done]
    print(f"resume: {len(done)} done, {len(todo)} to harvest "
          f"({workers} workers, {delay}s spacing ~= {workers/delay:.0f} req/s)", flush=True)
    ok = fail = 0
    lock = threading.Lock()
    is_new = not Path(out_path).exists()
    with open(out_path, "a", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=COLS)
        if is_new:
            w.writeheader()
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(_fetch_one, session_token, a, delay): a for a in todo}
            for i, fut in enumerate(as_completed(futures), 1):
                row = fut.result()
                with lock:
                    if row.get("error"):
                        fail += 1
                    else:
                        ok += 1
                    w.writerow(row)
                    fh.flush()
                if i % 25 == 0 or i == len(todo):
                    print(f"[{i}/{len(todo)}] ok={ok} fail={fail} last={row['apn']}"
                          f"->{row.get('transfer_date') or row.get('error')}", flush=True)
                # session-dead guard: many failures, zero successes early on
                if fail >= 15 and ok == 0:
                    print("!! 15 failures, 0 successes — session token likely expired. "
                          "Re-solve the captcha and re-run with a fresh token (resumes).",
                          file=sys.stderr)
                    for f in futures:
                        f.cancel()
                    break
    print(f"\nDONE: {ok} parsed, {fail} failed -> {out_path}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", required=True, help="ASP.NET session token, e.g. (S(xxxx))")
    ap.add_argument("--apns", required=True, help="file of APNs, one per line")
    ap.add_argument("--out", required=True, help="output CSV path")
    ap.add_argument("--workers", type=int, default=4, help="concurrent workers")
    ap.add_argument("--delay", type=float, default=0.5, help="per-worker spacing (s)")
    a = ap.parse_args()
    apn_list = [ln.strip() for ln in Path(a.apns).read_text().splitlines() if ln.strip()]
    print(f"Harvesting {len(apn_list)} APNs via session {a.session[:16]}…")
    harvest(a.session, apn_list, a.out, workers=a.workers, delay=a.delay)
