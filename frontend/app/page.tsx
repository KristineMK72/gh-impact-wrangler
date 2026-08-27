"use client";

import { useCallback, useMemo, useState } from "react";
import { useDropzone } from "react-dropzone";
import Map, { Source, Layer, NavigationControl } from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";

type Tab = "clean" | "map" | "features";

export default function Home() {
  const [tab, setTab] = useState<Tab>("clean");
  const [status, setStatus] = useState<string>("Drop a CSV or GeoJSON to clean it");
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    const file = acceptedFiles[0];
    if (!file) return;

    setLoading(true);
    setStatus(`Processing ${file.name}...`);
    setResult(null);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("target_crs", "EPSG:4326");

    try {
      const res = await fetch("/api/clean", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        setStatus(`Error: ${data.detail || "Something went wrong"}`);
        return;
      }

      setResult(data);
      setStatus(`Done! ${data.feature_count} features cleaned.`);
      setTab("map"); // auto-switch to map after success
    } catch (err: any) {
      setStatus(`Failed to reach API: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "text/csv": [".csv"],
      "application/geo+json": [".geojson", ".json"],
      "application/json": [".json"],
    },
    multiple: false,
  });

  const mapView = useMemo(() => {
    if (!result?.geojson?.features?.length) {
      return { longitude: -98.5, latitude: 39.8, zoom: 3 };
    }
    const coords = result.geojson.features
      .map((f: any) => f.geometry?.coordinates)
      .filter(Boolean);
    if (!coords.length) return { longitude: -98.5, latitude: 39.8, zoom: 3 };

    const lons = coords.map((c: number[]) => c[0]);
    const lats = coords.map((c: number[]) => c[1]);
    const longitude = (Math.min(...lons) + Math.max(...lons)) / 2;
    const latitude = (Math.min(...lats) + Math.max(...lats)) / 2;
    const zoom = coords.length === 1 ? 11 : 4;
    return { longitude, latitude, zoom };
  }, [result]);

  const downloadGeoJSON = () => {
    if (!result?.geojson) return;
    const blob = new Blob([JSON.stringify(result.geojson, null, 2)], {
      type: "application/geo+json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "cleaned.geojson";
    a.click();
    URL.revokeObjectURL(url);
  };

  const navItems: { id: Tab; label: string }[] = [
    { id: "clean", label: "Clean" },
    { id: "map", label: "Map" },
    { id: "features", label: "Roadmap" },
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top nav / menu */}
      <header className="border-b border-slate-800 bg-slate-950/80 backdrop-blur sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="text-emerald-400 font-bold text-lg tracking-tight">
              gh-impact
            </span>
            <span className="text-slate-500 text-sm hidden sm:inline">wrangler</span>
          </div>
          <nav className="flex gap-1">
            {navItems.map((item) => (
              <button
                key={item.id}
                onClick={() => setTab(item.id)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                  tab === item.id
                    ? "bg-emerald-600 text-white"
                    : "text-slate-400 hover:text-white hover:bg-slate-800"
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-8 space-y-6">
        {/* CLEAN TAB */}
        {tab === "clean" && (
          <div className="space-y-6">
            <div className="text-center space-y-2">
              <h1 className="text-3xl font-bold tracking-tight">Zero-friction geo cleaning</h1>
              <p className="text-slate-400">
                Messy CSV or GeoJSON → validated, reprojected, ready for the web
              </p>
            </div>

            <div
              {...getRootProps()}
              className={`border-2 border-dashed rounded-2xl p-12 sm:p-16 text-center cursor-pointer transition
                ${
                  isDragActive
                    ? "border-emerald-400 bg-emerald-950/30"
                    : "border-slate-700 hover:border-slate-500"
                }
                ${loading ? "opacity-60 pointer-events-none" : ""}`}
            >
              <input {...getInputProps()} />
              <p className="text-lg">
                {isDragActive ? "Drop it!" : "Drag & drop a CSV or GeoJSON here"}
              </p>
              <p className="text-sm text-slate-500 mt-2">or click to browse</p>
            </div>

            <div className="text-center text-sm text-slate-400">{status}</div>

            {result && (
              <div className="bg-slate-900 rounded-xl p-6 space-y-4 border border-slate-800">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <h2 className="font-semibold text-emerald-400">Audit log</h2>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setTab("map")}
                      className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm font-medium transition"
                    >
                      View on map
                    </button>
                    <button
                      onClick={downloadGeoJSON}
                      className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm font-medium transition"
                    >
                      Download GeoJSON
                    </button>
                  </div>
                </div>
                <pre className="text-xs overflow-auto max-h-48 bg-slate-950 p-4 rounded border border-slate-800">
                  {JSON.stringify(result.audit, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}

        {/* MAP TAB */}
        {tab === "map" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <h2 className="text-xl font-semibold">Map preview</h2>
                <p className="text-sm text-slate-400">
                  {result
                    ? `${result.feature_count} cleaned features`
                    : "Clean some data first to see it here"}
                </p>
              </div>
              {result && (
                <button
                  onClick={downloadGeoJSON}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm font-medium transition"
                >
                  Download GeoJSON
                </button>
              )}
            </div>

            <div className="h-[420px] sm:h-[520px] rounded-2xl overflow-hidden border border-slate-800">
              <Map
                initialViewState={mapView}
                key={result ? result.feature_count : "empty"}
                style={{ width: "100%", height: "100%" }}
                mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
              >
                <NavigationControl position="top-right" />
                {result?.geojson && (
                  <Source id="cleaned" type="geojson" data={result.geojson}>
                    <Layer
                      id="points"
                      type="circle"
                      paint={{
                        "circle-radius": 7,
                        "circle-color": "#34d399",
                        "circle-stroke-width": 2,
                        "circle-stroke-color": "#064e3b",
                      }}
                    />
                  </Source>
                )}
              </Map>
            </div>

            {!result && (
              <p className="text-center text-slate-500 text-sm">
                Go to the <button onClick={() => setTab("clean")} className="text-emerald-400 underline">Clean</button> tab and drop a file to see points here.
              </p>
            )}
          </div>
        )}

        {/* FEATURES / ROADMAP TAB */}
        {tab === "features" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold">What else can it do?</h2>
              <p className="text-slate-400 text-sm mt-1">
                Current capabilities + the next things we can ship for gh-impact.
              </p>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <FeatureCard
                title="Already live"
                items={[
                  "CSV + GeoJSON upload",
                  "Auto lat/lon detection",
                  "Geometry validation & repair",
                  "Reproject to WGS84",
                  "Deduplicate points",
                  "Audit log of every change",
                  "Download clean GeoJSON",
                  "Live map preview",
                ]}
                accent="emerald"
              />
              <FeatureCard
                title="Next up"
                items={[
                  "Shapefile (zip) upload & export",
                  "Choose source / target CRS in UI",
                  "Address geocoding",
                  "Buffer, clip, spatial join",
                  "H3 / geohash indexing",
                  "Attribute cleaning rules",
                  "Save & share wrangle recipes",
                  "Batch / API key access",
                ]}
                accent="sky"
              />
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h3 className="font-medium text-slate-200 mb-2">Bigger vision (gh-impact)</h3>
              <ul className="text-sm text-slate-400 space-y-1 list-disc list-inside">
                <li>Zero-friction geographic data infrastructure for impact, climate & urban work</li>
                <li>Reusable pipelines instead of one-off scripts</li>
                <li>Connect cleaned layers to analysis & storytelling tools</li>
                <li>Team workspaces and versioned datasets</li>
              </ul>
            </div>
          </div>
        )}
      </main>

      <footer className="border-t border-slate-800 py-4 text-center text-xs text-slate-600">
        gh-impact wrangler · zero-friction geographic data
      </footer>
    </div>
  );
}

function FeatureCard({
  title,
  items,
  accent,
}: {
  title: string;
  items: string[];
  accent: "emerald" | "sky";
}) {
  const color = accent === "emerald" ? "text-emerald-400" : "text-sky-400";
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
      <h3 className={`font-medium mb-3 ${color}`}>{title}</h3>
      <ul className="text-sm text-slate-300 space-y-1.5">
        {items.map((item) => (
          <li key={item} className="flex gap-2">
            <span className={color}>•</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
