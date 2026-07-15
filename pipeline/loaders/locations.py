"""Location/coordinate records: City of San Jose master address points.

395K+ address points with lat/long and APN — links coordinates to parcels.
"""
import pandas as pd

from .base import arcgis_paginate, provenance, save_parquet
from .. import state

SOURCE_NAME = "locations"
LAYER_URL = ("https://geo.sanjoseca.gov/server/rest/services/OPN/"
             "OPN_OpenDataService/MapServer/36")


def run():
    state.update(SOURCE_NAME, status="running", url=LAYER_URL,
                 message="pulling San Jose address points")
    rows = list(arcgis_paginate(
        LAYER_URL,
        out_fields="APN,FullAddress,Inc_Muni,County,Post_Code,Lat,Long,Place_Type",
        source_key=SOURCE_NAME,
    ))
    df = pd.DataFrame(rows).rename(columns={
        "APN": "apn", "FullAddress": "full_address", "Inc_Muni": "city",
        "County": "county", "Post_Code": "postcode", "Lat": "lat",
        "Long": "lon", "Place_Type": "place_type",
    })
    df = provenance(df, SOURCE_NAME, LAYER_URL)
    path = save_parquet(df, SOURCE_NAME)
    state.update(SOURCE_NAME, status="done", records=len(df),
                 message=f"{len(df)} address/coordinate records", file=path)
    return path
