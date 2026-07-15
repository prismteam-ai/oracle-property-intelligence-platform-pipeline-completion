"""Unit tests for ETL dedup and APN normalization."""
import pandas as pd

from pipeline.etl import _dedupe, _norm_apn


def test_norm_apn_strips_punctuation_and_nulls():
    s = pd.Series(["123-45-678", "123 45 678", None, "nan", ""])
    out = _norm_apn(s)
    assert out.iloc[0] == "12345678"
    assert out.iloc[1] == "12345678"
    assert out.iloc[2] is None or pd.isna(out.iloc[2])
    assert out.iloc[3] is None or pd.isna(out.iloc[3])


def test_dedupe_by_key_keeps_first():
    df = pd.DataFrame({"apn": ["1", "1", "2"], "x": ["a", "b", "c"]})
    clean, removed, method = _dedupe(df, "properties")
    assert removed == 1
    assert list(clean["x"]) == ["a", "c"]
    assert method == "key (apn)"


def test_dedupe_key_ignores_null_keys():
    df = pd.DataFrame({"apn": [None, None, "2"], "x": ["a", "b", "c"]})
    clean, removed, _ = _dedupe(df, "properties")
    assert removed == 0
    assert len(clean) == 3


def test_dedupe_contractors_detects_license_column():
    df = pd.DataFrame({"LicenseNumber": ["L1", "L1", "L2"], "name": ["a", "b", "c"]})
    clean, removed, method = _dedupe(df, "contractors")
    assert removed == 1
    assert "LicenseNumber" in method


def test_dedupe_full_row_fallback():
    df = pd.DataFrame({"a": [1, 1, 2], "b": ["x", "x", "y"]})
    clean, removed, method = _dedupe(df, "permits")
    assert removed == 1
    assert method == "full row"
