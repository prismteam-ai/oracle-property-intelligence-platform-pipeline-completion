"use client";

import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

export interface MapPoint {
  latitude: number;
  longitude: number;
  label?: string;
}

const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

const PALO_ALTO: [number, number] = [-122.143, 37.442];

export default function PropertyMap({ points }: { points: MapPoint[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!ref.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: ref.current,
      style: OSM_STYLE,
      center: PALO_ALTO,
      zoom: 12,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const data: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: points
        .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
        .map((p) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [p.longitude, p.latitude] },
          properties: { label: p.label ?? "" },
        })),
    };

    const apply = () => {
      const src = map.getSource("results") as maplibregl.GeoJSONSource | undefined;
      if (src) {
        src.setData(data);
      } else {
        map.addSource("results", { type: "geojson", data });
        map.addLayer({
          id: "results-pts",
          type: "circle",
          source: "results",
          paint: {
            "circle-radius": 4,
            "circle-color": "#7c8cff",
            "circle-opacity": 0.75,
            "circle-stroke-width": 1,
            "circle-stroke-color": "#0b0f17",
          },
        });
      }
      // fit to points
      if (data.features.length) {
        const b = new maplibregl.LngLatBounds();
        for (const f of data.features) {
          b.extend((f.geometry as GeoJSON.Point).coordinates as [number, number]);
        }
        map.fitBounds(b, { padding: 40, maxZoom: 15, duration: 300 });
      }
    };

    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [points]);

  return <div ref={ref} className="w-full h-[420px] rounded-lg overflow-hidden" />;
}
