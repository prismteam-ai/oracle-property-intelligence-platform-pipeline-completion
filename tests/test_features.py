"""Unit tests for shared feature-mart SQL fragments (run against in-memory DuckDB)."""
import duckdb
import pytest

from pipeline.features import HAVERSINE, WATER_BODIES, addr_key


@pytest.fixture()
def con():
    return duckdb.connect(":memory:")


def test_addr_key_normalizes_case_spacing_and_city_suffix(con):
    sql = addr_key("'123  Main   st, San Jose CA'")
    assert con.execute(f"SELECT {sql}").fetchone()[0] == "123 MAIN ST"


def test_addr_key_matches_across_sources(con):
    a = addr_key("'1217 SPENCER AV , SAN JOSE CA 95125'")
    b = addr_key("'1217  spencer av'")
    ra, rb = con.execute(f"SELECT {a}, {b}").fetchone()
    assert ra == rb == "1217 SPENCER AV"


def test_haversine_known_distance(con):
    # San Jose City Hall -> Diridon Station: ~1.7 km straight-line
    expr = HAVERSINE.format(alat="37.3382", alon="(-121.8863)", blat="37.3297", blon="(-121.9026)")
    d = con.execute(f"SELECT {expr}").fetchone()[0]
    assert 1500 < d < 2000


def test_water_bodies_are_in_scc_bounding_box():
    for name, lat, lon in WATER_BODIES:
        assert 36.9 < lat < 37.6, name
        assert -122.3 < lon < -121.2, name
