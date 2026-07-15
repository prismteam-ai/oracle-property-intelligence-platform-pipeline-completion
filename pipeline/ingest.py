"""Orchestrate county open-data + Elephant seed ingest."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from pipeline.connectors.overpass import fetch_pois
from pipeline.connectors.socrata import fetch_parcels
from pipeline.sources import fetch_permit_seed, fetch_property_seed


@dataclass
class IngestArtifacts:
    property_seed: Path
    permit_seed: Path
    socrata_parcels: Path
    osm_pois: Path


def run_ingest(data_dir: Path) -> IngestArtifacts:
    data_dir.mkdir(parents=True, exist_ok=True)
    print("Ingest: Elephant Santa Clara property seed (county backbone)...")
    property_seed = fetch_property_seed(data_dir)
    print("Ingest: Elephant Santa Clara permit table...")
    permit_seed = fetch_permit_seed(data_dir)
    print("Ingest: SCC Socrata parcels (real geometry + coordinates)...")
    socrata_parcels = fetch_parcels(
        data_dir,
        app_token=os.environ.get("SOCRATA_APP_TOKEN"),
    )
    print("Ingest: OSM POIs (transit, Starbucks, water)...")
    osm_pois = fetch_pois(data_dir)
    return IngestArtifacts(
        property_seed=property_seed,
        permit_seed=permit_seed,
        socrata_parcels=socrata_parcels,
        osm_pois=osm_pois,
    )
