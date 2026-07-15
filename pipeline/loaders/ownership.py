"""Ownership records: Santa Clara County parcels layer that exposes owner fields.

The full assessor ownership roll is not published as open data (bulk access
requires a paid/records request — documented constraint). This county GIS layer
exposes owner name/address fields for the parcels it covers.
"""
import pandas as pd

from .base import arcgis_paginate, provenance, save_parquet
from .. import state

SOURCE_NAME = "ownership"
LAYER_URL = ("https://services.arcgis.com/NkcnS0qk4w2wasOJ/arcgis/rest/services/"
             "RAPParcels_DEDUP20130607_F/FeatureServer/0")


def run():
    state.update(SOURCE_NAME, status="running", url=LAYER_URL,
                 message="pulling county parcel ownership fields")
    rows = list(arcgis_paginate(
        LAYER_URL,
        out_fields=("APN,PROPERTY_O,PROPERTY_1,OWNERS_ADD,OWNERS_CIT,OWNERS_STA,"
                    "OWNERS_ZIP,OWNERS_COU,ADDRESS,CITY_ST_ZI,USE_CODE_E,"
                    "LAND_VALUE,IMPROVEMEN"),
        return_geometry=True, geometry_centroid=True,
        source_key=SOURCE_NAME,
    ))
    df = pd.DataFrame(rows).rename(columns={
        "APN": "apn",
        "PROPERTY_O": "owner_name",
        "PROPERTY_1": "owner_name_2",
        "OWNERS_ADD": "owner_address",
        "OWNERS_CIT": "owner_city",
        "OWNERS_STA": "owner_state",
        "OWNERS_ZIP": "owner_zip",
        "OWNERS_COU": "owner_country",
        "ADDRESS": "situs_address",
        "CITY_ST_ZI": "situs_city_st_zip",
        "USE_CODE_E": "use_code",
        "LAND_VALUE": "land_value",
        "IMPROVEMEN": "improvement_value",
    })
    df = provenance(df, SOURCE_NAME, LAYER_URL)
    path = save_parquet(df, SOURCE_NAME)
    state.update(SOURCE_NAME, status="done", records=len(df),
                 message=f"{len(df)} ownership records (bulk assessor roll restricted)",
                 file=path)
    return path
