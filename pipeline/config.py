import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("DATA_DIR", ROOT / "data"))
RAW_DIR = DATA_DIR / "raw"
PARQUET_DIR = DATA_DIR / "parquet"
STATE_FILE = DATA_DIR / "pipeline_state.json"
MANIFEST_FILE = DATA_DIR / "manifest.json"
DUCKDB_FILE = DATA_DIR / "oracle.duckdb"

# Cap records per source; 0 = pull everything.
MAX_RECORDS = int(os.environ.get("MAX_RECORDS", "25000"))

IPFS_API = os.environ.get("IPFS_API", "http://127.0.0.1:5001")
IPFS_GATEWAY = os.environ.get("IPFS_GATEWAY", "http://127.0.0.1:8080")

USER_AGENT = "OraclePropertyIntel/1.0 (property research pipeline)"

# Cities in Santa Clara County (statewide parcel layer SITE_CITY values)
SCC_CITIES = [
    "PALO ALTO", "SAN JOSE", "SANTA CLARA", "SUNNYVALE", "MOUNTAIN VIEW",
    "CUPERTINO", "MILPITAS", "CAMPBELL", "LOS GATOS", "LOS ALTOS",
    "LOS ALTOS HILLS", "SARATOGA", "MORGAN HILL", "GILROY", "MONTE SERENO",
    "STANFORD", "SAN MARTIN",
]

for d in (RAW_DIR, PARQUET_DIR):
    d.mkdir(parents=True, exist_ok=True)
