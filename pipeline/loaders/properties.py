"""Property records: California statewide parcels filtered to Santa Clara County cities.

Source: CA_State_Parcels FeatureServer (public ArcGIS). Includes parcel APN, situs
address/city and polygon geometry (converted to centroid coordinates).
Note: the county's own parcel service (mapservices.sccgov.org) is offline and
gis.sccgov.org is Cloudflare-protected, so this statewide mirror is used.
"""
import pandas as pd

from .base import arcgis_paginate, provenance, save_parquet
from ..config import SCC_CITIES
from .. import state

SOURCE_NAME = "properties"
LAYER_URL = ("https://services2.arcgis.com/zr3KAIbsRSUyARHG/ArcGIS/rest/services/"
             "CA_State_Parcels/FeatureServer/0")


def run():
    state.update(SOURCE_NAME, status="running", url=LAYER_URL,
                 message="pulling parcels for Santa Clara County cities")
    cities = ",".join(f"'{c}'" for c in SCC_CITIES)
    where = f"SITE_CITY IN ({cities})"
    rows = list(arcgis_paginate(
        LAYER_URL, where=where,
        out_fields="PARCEL_APN,SITE_ADDR,SITE_CITY",
        return_geometry=True, geometry_centroid=True,
        source_key=SOURCE_NAME,
    ))
    df = pd.DataFrame(rows).rename(columns={
        "PARCEL_APN": "apn", "SITE_ADDR": "situs_address", "SITE_CITY": "situs_city",
    })
    df = provenance(df, SOURCE_NAME, LAYER_URL)
    path = save_parquet(df, SOURCE_NAME)
    state.update(SOURCE_NAME, status="done", records=len(df),
                 message=f"{len(df)} parcel records", file=path)
    return path
