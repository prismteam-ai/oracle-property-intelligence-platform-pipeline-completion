"""Contractor records: CSLB "List by Classification and County" data portal.

CSLB offers no bulk download or JSON API — the portal is a legacy ASP.NET form
(VIEWSTATE postback to ./ListByCounty) that returns an XLSX per query.
Documented constraint: slow legacy source, max 10 classifications per request,
fresh VIEWSTATE needed per query.
"""
import io
import re
import time

import pandas as pd

from .base import provenance, save_parquet, session
from ..config import MAX_RECORDS
from .. import state

SOURCE_NAME = "contractors"
BASE = "https://www.cslb.ca.gov/onlineservices/dataportal/"
FORM_URL = BASE + "ListByCounty.aspx"
POST_URL = BASE + "ListByCounty"  # the form's real action
SANTA_CLARA = "43"

# Batches of <=10 classifications (portal limit per request)
CLASSIFICATION_BATCHES = [
    ["A", "B", "B-2", "C-2", "C-4", "C-5", "C-6", "C-7", "C-8", "C-9"],
    ["C-10", "C-11", "C-12", "C-13", "C-15", "C-16", "C-17", "C-20", "C-21", "C-22"],
    ["C-23", "C-27", "C-28", "C-29", "C-31", "C-32", "C-33", "C-34", "C-35", "C-36"],
    ["C-38", "C-39", "C-42", "C-43", "C-45", "C-46", "C-47", "C-49", "C-50", "C-51"],
    ["C-53", "C-54", "C-55", "C-57", "C-60", "C-61"],
]


def _fetch_batch(classifications):
    page = session.get(FORM_URL, timeout=60)
    page.raise_for_status()
    hidden = re.findall(
        r'<input[^>]+type="hidden"[^>]+name="([^"]+)"[^>]*value="([^"]*)"', page.text)
    payload = list(hidden)
    payload += [("ctl00$MainContent$lbClassification", c) for c in classifications]
    payload += [
        ("ctl00$MainContent$lbCounty", SANTA_CLARA),
        ("__EVENTTARGET", "ctl00$MainContent$btnSearch"),
        ("__EVENTARGUMENT", ""),
    ]
    r = session.post(POST_URL, data=payload, timeout=300)
    r.raise_for_status()
    ctype = r.headers.get("Content-Type", "")
    if "spreadsheet" not in ctype and "excel" not in ctype:
        raise RuntimeError(f"expected XLSX, got {ctype}")
    return pd.read_excel(io.BytesIO(r.content))


def run():
    state.update(SOURCE_NAME, status="running", url=FORM_URL,
                 message="replaying CSLB postbacks (slow legacy source)")
    frames = []
    total = 0
    for batch in CLASSIFICATION_BATCHES:
        try:
            df = _fetch_batch(batch)
            frames.append(df)
            total += len(df)
            state.update(SOURCE_NAME, records=total,
                         message=f"batch {batch[0]}..{batch[-1]}: {len(df)} licenses")
        except Exception as exc:  # keep going: source is known-flaky
            state.update(SOURCE_NAME, message=f"batch {batch[0]}.. failed: {exc}")
        if MAX_RECORDS and total >= MAX_RECORDS:
            break
        time.sleep(1.5)  # be polite to the legacy portal
    if not frames:
        state.update(SOURCE_NAME, status="error",
                     message="CSLB portal returned no data (constrained source)")
        return None
    merged = pd.concat(frames, ignore_index=True)
    dedupe_col = next((c for c in merged.columns if "License" in str(c)), None)
    if dedupe_col:
        merged = merged.drop_duplicates(subset=[dedupe_col])
    if MAX_RECORDS:
        merged = merged.head(MAX_RECORDS)
    merged = provenance(merged, SOURCE_NAME, FORM_URL)
    path = save_parquet(merged, SOURCE_NAME)
    state.update(SOURCE_NAME, status="done", records=len(merged),
                 message=f"{len(merged)} contractor licenses", file=path)
    return path
