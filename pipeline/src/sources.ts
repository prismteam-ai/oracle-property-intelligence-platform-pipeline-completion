/**
 * Concrete source registry for Santa Clara County / Palo Alto.
 *
 * Each entry is a configured `Connector`. Adding a county/source = adding an
 * entry here; the engines (socrata/arcgis/overpass) and the loader are generic.
 *
 * Verified live (2026-07-10):
 *   - SCC parcels via Socrata: 20,933 Palo Alto parcels, geometry + APN.
 *   - Overpass POIs: transit + Starbucks + water in the Palo Alto bbox.
 *
 * Pending (upstream outage): City of Palo Alto permits. The catalog at
 * https://data.paloalto.gov/data.json advertises the permit datastreams, but
 * every download URL points at host `api.data.paloalto.gov`, which currently
 * returns authoritative NXDOMAIN globally (confirmed via Google + Cloudflare
 * DoH). See PERMITS_PENDING below — the connector config is staged so it
 * activates the moment the city restores the API host.
 */

import { fileURLToPath } from "node:url";
import type { Connector } from "./connectors/types.js";
import { socrataConnector } from "./connectors/socrata.js";
import { overpassConnector } from "./connectors/overpass.js";
import { csvFileConnector, csvFileAvailable } from "./connectors/csv.js";
import { junarCsvConnector } from "./connectors/junar.js";

/** Palo Alto bounding box [south, west, north, east], padded for edge POIs. */
export const PALO_ALTO_BBOX: [number, number, number, number] = [
  37.35, -122.22, 37.48, -122.08,
];

/** Optional Socrata app token from env for higher throughput on big pulls. */
const SOCRATA_TOKEN = process.env.SOCRATA_APP_TOKEN;

/**
 * SCC assessor parcels (Socrata). Geometry + APN + situs address.
 * APN is the universal join key for permits and assessor enrichment.
 */
const sccParcels: Connector = socrataConnector({
  name: "scc-parcels",
  entity: "property",
  source: "Santa Clara County Parcels (data.sccgov.org)",
  domain: "data.sccgov.org",
  datasetId: "ubcd-cewv",
  idField: "apn",
  where: "situs_city_name='PALO ALTO'",
  appToken: SOCRATA_TOKEN,
  license: "Public domain (Santa Clara County Open Data)",
  pageSize: 5000,
});

/** OSM transit stops — bus stops, platforms, rail/light-rail stations. */
const osmTransit: Connector = overpassConnector({
  name: "osm-transit",
  source: "OpenStreetMap (Overpass API)",
  poiKind: "transit",
  defaultBbox: PALO_ALTO_BBOX,
  query: `
    node["highway"="bus_stop"]({{bbox}});
    node["public_transport"="platform"]({{bbox}});
    node["railway"="station"]({{bbox}});
    node["railway"="tram_stop"]({{bbox}});
  `,
});

/** OSM Starbucks locations (brand tag + name fallback). */
const osmStarbucks: Connector = overpassConnector({
  name: "osm-starbucks",
  source: "OpenStreetMap (Overpass API)",
  poiKind: "starbucks",
  defaultBbox: PALO_ALTO_BBOX,
  query: `
    node["brand"="Starbucks"]({{bbox}});
    node["name"="Starbucks"]({{bbox}});
    way["brand"="Starbucks"]({{bbox}});
  `,
});

/** OSM water bodies/coastline for the water-view heuristic. */
const osmWater: Connector = overpassConnector({
  name: "osm-water",
  source: "OpenStreetMap (Overpass API)",
  poiKind: "water",
  defaultBbox: PALO_ALTO_BBOX,
  query: `
    way["natural"="water"]({{bbox}});
    relation["natural"="water"]({{bbox}});
    way["waterway"="riverbank"]({{bbox}});
    node["natural"="water"]({{bbox}});
  `,
});

/**
 * Operator-supplied Palo Alto permit CSV (downloaded from the browsable
 * dataview, since the Junar API host is down). Drop the file at
 * data/input/pa-permits.csv and it joins the run automatically.
 *
 * NOTE: `idField` is set once the real header is known — the Palo Alto permit
 * export keys on the record/permit number column. Until then rows fall back to
 * synthetic ids (no data lost), but set this to the real permit-number column
 * for correct dedup.
 */
export const PA_PERMITS_CSV_PATH = fileURLToPath(
  new URL("../data/input/pa-permits.csv", import.meta.url),
);

const paPermitsCsv: Connector = csvFileConnector({
  name: "pa-permits-csv",
  entity: "permit",
  source: "City of Palo Alto Development Center Permits (operator CSV)",
  filePath: PA_PERMITS_CSV_PATH,
  idField: "Record ID", // adjust to real permit-number header on file arrival
  license: "Public (City of Palo Alto Open Data)",
});

/**
 * City of Palo Alto Development Center permits, via the LIVE Junar CSV export.
 *
 * The catalog's advertised host (api.data.paloalto.gov) is dead, but every
 * datastream serves its full export at
 * data.paloalto.gov/rest/datastreams/<numericId>/data.csv/. Numeric ids were
 * discovered from each dataview's own network calls (browser-sniffed 2026-07-10).
 * Split into date-range chunks; concatenating them gives permit history back to
 * 2013. Each row carries APN (direct join to parcels), DATE OPENED, DESCRIPTION,
 * RECORD MODULE, JOB VALUE, plus BUSINESS NAME + LICENSE NBR (contractor signal).
 */
const PA_PERMIT_DATASTREAMS: Array<{ id: number; range: string }> = [
  { id: 296815, range: "2013-01_2015-05" },
  { id: 296813, range: "2015-06_2017-11" },
  { id: 296812, range: "2017-12_2020-04" },
  { id: 296811, range: "2020-05_2022-11" },
  { id: 296814, range: "2022-12_2025-02" },
  { id: 297909, range: "2025-03_2026-07" }, // current, updated weekly
];

const paPermits: Connector[] = PA_PERMIT_DATASTREAMS.map((ds) =>
  junarCsvConnector({
    name: `pa-permits-${ds.range}`,
    entity: "permit",
    source: "City of Palo Alto Development Center Permits (data.paloalto.gov)",
    domain: "data.paloalto.gov",
    datastreamId: ds.id,
    idField: "RECORD ID",
    license: "Public (City of Palo Alto Open Data)",
  }),
);

/** Connectors that are verified working and safe to run now. */
export const ACTIVE_CONNECTORS: Connector[] = [
  sccParcels,
  ...paPermits,
  osmTransit,
  osmStarbucks,
  osmWater,
  // Generic file connector: joins the run only if an operator drops a CSV.
  ...(csvFileAvailable({ filePath: PA_PERMITS_CSV_PATH }) ? [paPermitsCsv] : []),
];

export const CONNECTORS_BY_NAME: Record<string, Connector> = Object.fromEntries(
  ACTIVE_CONNECTORS.map((c) => [c.name, c]),
);
