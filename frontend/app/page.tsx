"use client";

import { useCallback, useMemo, useState } from "react";
import { useDropzone } from "react-dropzone";
import Map, {
  Source,
  Layer,
  NavigationControl,
  Popup,
  MapLayerMouseEvent,
} from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";

type Tab = "clean" | "map" | "features";

const SAMPLE_CSV = `name,latitude,longitude,city
Golden Gate Park,37.7694,-122.4862,San Francisco
Central Park,40.7829,-73.9654,New York
Griffith Park,34.1367,-118.2942,Los Angeles
Millennium Park,41.8826,-87.6226,Chicago
Balboa Park,32.7341,-117.1446,San Diego`;

const CRS_OPTIONS = [
  { value: "EPSG:4326", label: "WGS84 (EPSG:4326) — web maps" },
  { value: "EPSG:3857", label: "Web Mercator (EPSG:3857)" },
  { value: "EPSG:4269", label: "NAD83 (EPSG:4269)" },
];

const PASTE_PLACEHOLDER = `Paste anything:

• CSV with headers (name,lat,lon,...)
• GeoJSON FeatureCollection
• Bare coordinates, one per line:
  37.7749, -122.4194
  40.7128, -74.0060`;

/** Turn pasted text into a File the /clean API understands. */
function pasteToFile(raw: string): File {
  const text = raw.trim();
  if (!text) throw new Error("Nothing to paste");

  // GeoJSON
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      JSON.parse(text);
      return new File([text], "pasted.geojson", { type: "application/geo+json" });
    } catch {
      // fall through — might be weird CSV that starts with {
    }
  }

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // Bare lat,lon (or lon,lat) lines without a header
  const coordOnly = lines.every((line) => {
    const parts = line.split(/[,\s\t]+/).filter(Boolean);
    if (parts.length < 2) return false;
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    return Number.isFinite(a) && Number.isFinite(b);
  });

  if (coordOnly && lines.length > 0) {
    // Heuristic: if |first| > 90 treat as lon,lat else lat,lon
    const first = Number(lines[0].split(/[,\s\t]+/)[0]);
    const lonFirst = Math.abs(first) > 90;
    const header = lonFirst ? "longitude,latitude" : "latitude,longitude";
    const body = lines
      .map((line) => {
        const parts = line.split(/[,\s\t]+/).filter(Boolean);
        return `${parts[0]},${parts[1]}`;
      })
      .join("\n");
    const csv = `${header}\n${body}`;
    return new File([csv], "pasted-coords.csv", { type: "text/csv" });
  }

  // Default: treat as CSV
  return new File([text], "pasted.csv", { type: "text/csv" });
}

export default function Home() {
  const [tab, setTab] = useState<Tab>("clean");
  const [status, setStatus] = useState<string>(
    "Drop a file, paste raw data, or try the sample"
  );
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [targetCrs, setTargetCrs] = useState("EPSG:4326");
  const [sourceCrs, setSourceCrs] = useState("");
  const [copied, setCopied] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [inputMode, setInputMode] = useState<"drop" | "paste">("drop");
  const [popupInfo, setPopupInfo] = useState<{
    longitude: number;
    latitude: number;
    properties: Record<string, unknown>;
  } | null>(null);

  const runClean = useCallback(
    async (file: File) => {
      setLoading(true);
      setStatus(`Processing ${file.name}...`);
      setResult(null);
      setPopupInfo(null);
      setCopied(false);

      const formData = new FormData();
      formData.append("file", file);
      formData.append("target_crs", targetCrs);
      if (sourceCrs.trim()) formData.append("source_crs", sourceCrs.trim());

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
        setTab("map");
      } catch (err: any) {
        setStatus(`Failed to reach API: ${err.message}`);
      } finally {
        setLoading(false);
      }
    },
    [targetCrs, sourceCrs]
  );

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      const file = acceptedFiles[0];
      if (!file) return;
      await runClean(file);
    },
    [runClean]
  );

  const loadSample = useCallback(async () => {
    const file = new File([SAMPLE_CSV], "parks-demo.csv", { type: "text/csv" });
    await runClean(file);
  }, [runClean]);

  const runPaste = useCallback(async () => {
    try {
      const file = pasteToFile(pasteText);
      await runClean(file);
    } catch (e: any) {
      setStatus(e.message || "Could not parse pasted data");
    }
  }, [pasteText, runClean]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "text/csv": [".csv"],
      "application/geo+json": [".geojson", ".json"],
      "application/json": [".json"],
      "application/zip": [".zip"],
      "application/x-zip-compressed": [".zip"],
    },
    multiple: false,
  });

  const mapView = useMemo(() => {
    if (!result?.geojson?.features?.length) {
      return { longitude: -98.5, latitude: 39.8, zoom: 3 };
    }
    const all: number[][] = [];
    for (const f of result.geojson.features) {
      const g = f.geometry;
      if (!g) continue;
      if (g.type === "Point") all.push(g.coordinates);
      else if (g.type === "LineString") all.push(...g.coordinates);
      else if (g.type === "Polygon") all.push(...(g.coordinates[0] || []));
      else if (g.type === "MultiPoint") all.push(...g.coordinates);
    }
    if (!all.length) return { longitude: -98.5, latitude: 39.8, zoom: 3 };

    const lons = all.map((c) => c[0]);
    const lats = all.map((c) => c[1]);
    const longitude = (Math.min(...lons) + Math.max(...lons)) / 2;
    const latitude = (Math.min(...lats) + Math.max(...lats)) / 2;
    const span = Math.max(
      Math.max(...lons) - Math.min(...lons),
      Math.max(...lats) - Math.min(...lats)
    );
    let zoom = 4;
    if (span < 0.5) zoom = 10;
    else if (span < 2) zoom = 7;
    else if (span < 10) zoom = 5;
    if (all.length === 1) zoom = 11;
    return { longitude, latitude, zoom };
  }, [result]);

  const attributeRows = useMemo(() => {
    if (!result?.geojson?.features) return [];
    return result.geojson.features.slice(0, 50).map((f: any, i: number) => ({
      id: i,
      ...(f.properties || {}),
    }));
  }, [result]);

  const attributeColumns = useMemo(() => {
    if (!attributeRows.length) return [];
    const keys = new Set<string>();
    attributeRows.forEach((row: any) => Object.keys(row).forEach((k) => keys.add(k)));
    return Array.from(keys).filter((k) => k !== "id");
  }, [attributeRows]);

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

  const downloadCSV = () => {
    if (!result?.geojson?.features?.length) return;
    const features = result.geojson.features;
    const propsKeys = new Set<string>();
    features.forEach((f: any) =>
      Object.keys(f.properties || {}).forEach((k) => propsKeys.add(k))
    );
    const cols = ["longitude", "latitude", ...Array.from(propsKeys)];
    const lines = [cols.join(",")];
    for (const f of features) {
      let lon = "";
      let lat = "";
      if (f.geometry?.type === "Point") {
        lon = String(f.geometry.coordinates[0]);
        lat = String(f.geometry.coordinates[1]);
      }
      const row = cols.map((c) => {
        if (c === "longitude") return lon;
        if (c === "latitude") return lat;
        const v = f.properties?.[c];
        if (v == null) return "";
        const s = String(v).replace(/"/g, '""');
        return s.includes(",") || s.includes('"') ? `"${s}"` : s;
      });
      lines.push(row.join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "cleaned.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyGeoJSON = async () => {
    if (!result?.geojson) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(result.geojson, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setStatus("Could not copy to clipboard");
    }
  };

  const onMapClick = (e: MapLayerMouseEvent) => {
    const feature = e.features?.[0];
    if (!feature) {
      setPopupInfo(null);
      return;
    }
    const lngLat = e.lngLat;
    setPopupInfo({
      longitude: lngLat.lng,
      latitude: lngLat.lat,
      properties: (feature.properties || {}) as Record<string, unknown>,
    });
  };

  const navItems: { id: Tab; label: string }[] = [
    { id: "clean", label: "Clean" },
    { id: "map", label: "Map" },
    { id: "features", label: "Roadmap" },
  ];

  const exportButtons = result && (
    <div className="flex flex-wrap gap-2">
      <button
        onClick={downloadGeoJSON}
        className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm font-medium transition"
      >
        GeoJSON
      </button>
      <button
        onClick={downloadCSV}
        className="px-3 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm font-medium transition border border-slate-700"
      >
        CSV
      </button>
      <button
        onClick={copyGeoJSON}
        className="px-3 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm font-medium transition border border-slate-700"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
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
        {tab === "clean" && (
          <div className="space-y-6">
            <div className="text-center space-y-2">
              <h1 className="text-3xl font-bold tracking-tight">Zero-friction geo cleaning</h1>
              <p className="text-slate-400">
                Drop · paste · sample → validated, reprojected, ready for the web
              </p>
            </div>

            <div className="flex flex-col gap-3 items-center">
              <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center justify-center gap-3">
                <label className="text-sm text-slate-400 flex items-center gap-2">
                  Target CRS
                  <select
                    value={targetCrs}
                    onChange={(e) => setTargetCrs(e.target.value)}
                    className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                  >
                    {CRS_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm text-slate-400 flex items-center gap-2">
                  Source CRS
                  <input
                    type="text"
                    placeholder="auto / e.g. EPSG:26915"
                    value={sourceCrs}
                    onChange={(e) => setSourceCrs(e.target.value)}
                    className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 w-44"
                  />
                </label>
              </div>
              <button
                onClick={loadSample}
                disabled={loading}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 rounded-lg text-sm font-medium transition border border-slate-700"
              >
                Try sample parks data
              </button>
            </div>

            {/* Drop vs Paste toggle */}
            <div className="flex justify-center gap-1 p-1 bg-slate-900 rounded-xl border border-slate-800 w-fit mx-auto">
              <button
                onClick={() => setInputMode("drop")}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition ${
                  inputMode === "drop"
                    ? "bg-emerald-600 text-white"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                Drop file
              </button>
              <button
                onClick={() => setInputMode("paste")}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition ${
                  inputMode === "paste"
                    ? "bg-emerald-600 text-white"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                Paste data
              </button>
            </div>

            {inputMode === "drop" ? (
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
                  {isDragActive
                    ? "Drop it!"
                    : "Drag & drop CSV, GeoJSON, or Shapefile (.zip)"}
                </p>
                <p className="text-sm text-slate-500 mt-2">or click to browse</p>
              </div>
            ) : (
              <div className="space-y-3">
                <textarea
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder={PASTE_PLACEHOLDER}
                  rows={10}
                  className="w-full bg-slate-900 border border-slate-700 rounded-2xl p-4 text-sm text-slate-100 font-mono placeholder:text-slate-600 focus:outline-none focus:border-emerald-600 resize-y min-h-[180px]"
                  disabled={loading}
                />
                <div className="flex flex-wrap gap-2 justify-center">
                  <button
                    onClick={runPaste}
                    disabled={loading || !pasteText.trim()}
                    className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded-lg text-sm font-medium transition"
                  >
                    Clean pasted data
                  </button>
                  <button
                    onClick={() => setPasteText(SAMPLE_CSV)}
                    disabled={loading}
                    className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm font-medium transition border border-slate-700"
                  >
                    Fill sample CSV
                  </button>
                  <button
                    onClick={() => setPasteText("")}
                    disabled={loading || !pasteText}
                    className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 rounded-lg text-sm font-medium transition border border-slate-700"
                  >
                    Clear
                  </button>
                </div>
              </div>
            )}

            <div className="text-center text-sm text-slate-400">{status}</div>

            {result && (
              <div className="bg-slate-900 rounded-xl p-6 space-y-4 border border-slate-800">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <h2 className="font-semibold text-emerald-400">Audit log</h2>
                  <div className="flex flex-wrap gap-2 items-center">
                    <button
                      onClick={() => setTab("map")}
                      className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm font-medium transition"
                    >
                      View on map
                    </button>
                    {exportButtons}
                  </div>
                </div>
                <pre className="text-xs overflow-auto max-h-48 bg-slate-950 p-4 rounded border border-slate-800">
                  {JSON.stringify(result.audit, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}

        {tab === "map" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <h2 className="text-xl font-semibold">Map preview</h2>
                <p className="text-sm text-slate-400">
                  {result
                    ? `${result.feature_count} cleaned features · click for details`
                    : "Clean some data first to see it here"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {!result && (
                  <button
                    onClick={loadSample}
                    disabled={loading}
                    className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm font-medium transition"
                  >
                    Load sample
                  </button>
                )}
                {exportButtons}
              </div>
            </div>

            <div className="h-[420px] sm:h-[520px] rounded-2xl overflow-hidden border border-slate-800">
              <Map
                initialViewState={mapView}
                key={result ? `${result.feature_count}-${targetCrs}` : "empty"}
                style={{ width: "100%", height: "100%" }}
                mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
                interactiveLayerIds={result ? ["points", "polygons-fill", "lines"] : []}
                onClick={onMapClick}
                cursor={result ? "pointer" : "grab"}
              >
                <NavigationControl position="top-right" />
                {result?.geojson && (
                  <Source id="cleaned" type="geojson" data={result.geojson}>
                    <Layer
                      id="polygons-fill"
                      type="fill"
                      filter={["==", ["geometry-type"], "Polygon"]}
                      paint={{
                        "fill-color": "#34d399",
                        "fill-opacity": 0.35,
                      }}
                    />
                    <Layer
                      id="polygons-outline"
                      type="line"
                      filter={["==", ["geometry-type"], "Polygon"]}
                      paint={{
                        "line-color": "#059669",
                        "line-width": 2,
                      }}
                    />
                    <Layer
                      id="lines"
                      type="line"
                      filter={["==", ["geometry-type"], "LineString"]}
                      paint={{
                        "line-color": "#34d399",
                        "line-width": 3,
                      }}
                    />
                    <Layer
                      id="points"
                      type="circle"
                      filter={["==", ["geometry-type"], "Point"]}
                      paint={{
                        "circle-radius": 8,
                        "circle-color": "#34d399",
                        "circle-stroke-width": 2,
                        "circle-stroke-color": "#064e3b",
                      }}
                    />
                  </Source>
                )}
                {popupInfo && (
                  <Popup
                    longitude={popupInfo.longitude}
                    latitude={popupInfo.latitude}
                    anchor="bottom"
                    onClose={() => setPopupInfo(null)}
                    closeOnClick={false}
                    className="text-slate-900"
                  >
                    <div className="text-xs space-y-1 max-w-[220px]">
                      {Object.entries(popupInfo.properties).map(([k, v]) => (
                        <div key={k}>
                          <span className="font-semibold">{k}:</span> {String(v)}
                        </div>
                      ))}
                      {!Object.keys(popupInfo.properties).length && (
                        <span className="text-slate-500">No attributes</span>
                      )}
                    </div>
                  </Popup>
                )}
              </Map>
            </div>

            {attributeRows.length > 0 && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
                  <h3 className="text-sm font-medium text-slate-300">Attributes</h3>
                  <span className="text-xs text-slate-500">
                    showing {attributeRows.length}
                    {result.feature_count > 50 ? ` of ${result.feature_count}` : ""}
                  </span>
                </div>
                <div className="overflow-x-auto max-h-56">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-950 sticky top-0">
                      <tr>
                        {attributeColumns.map((col) => (
                          <th
                            key={col}
                            className="px-3 py-2 font-medium text-slate-400 whitespace-nowrap"
                          >
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {attributeRows.map((row: any) => (
                        <tr key={row.id} className="border-t border-slate-800/80">
                          {attributeColumns.map((col) => (
                            <td key={col} className="px-3 py-2 text-slate-300 whitespace-nowrap">
                              {row[col] != null ? String(row[col]) : "—"}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {!result && (
              <p className="text-center text-slate-500 text-sm">
                Go to the{" "}
                <button onClick={() => setTab("clean")} className="text-emerald-400 underline">
                  Clean
                </button>{" "}
                tab or load the sample.
              </p>
            )}
          </div>
        )}

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
                  "Drop CSV / GeoJSON / Shapefile (.zip)",
                  "Paste raw CSV, GeoJSON, or lat/lon lines",
                  "One-click sample parks dataset",
                  "Auto lat/lon detection",
                  "Geometry validation & repair",
                  "Source + target CRS controls",
                  "Export GeoJSON · CSV · Copy",
                  "Map: points, lines & polygons",
                  "Click popups + attribute table",
                ]}
                accent="emerald"
              />
              <FeatureCard
                title="Next up"
                items={[
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
