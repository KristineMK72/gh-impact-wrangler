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
import { cleanFileInBrowser } from "../lib/clientClean";

type Tab = "clean" | "map" | "features";

const SAMPLE_CSV = `name,latitude,longitude,city
Golden Gate Park,37.7694,-122.4862,San Francisco
Central Park,40.7829,-73.9654,New York
Griffith Park,34.1367,-118.2942,Los Angeles
Millennium Park,41.8826,-87.6226,Chicago
Balboa Park,32.7341,-117.1446,San Diego`;

const SAMPLE_ADDRESSES = `Golden Gate Park, San Francisco, CA
Central Park, New York, NY
Griffith Observatory, Los Angeles, CA
Millennium Park, Chicago, IL
Balboa Park, San Diego, CA`;

const CRS_OPTIONS = [
  { value: "EPSG:4326", label: "WGS84 (EPSG:4326) — web maps" },
  { value: "EPSG:3857", label: "Web Mercator (EPSG:3857)" },
  { value: "EPSG:4269", label: "NAD83 (EPSG:4269)" },
];

const PASTE_PLACEHOLDER = `Paste anything:

• CSV with headers (name,lat,lon,...)
• GeoJSON FeatureCollection
• Bare coordinates, one per line
• Or addresses (use Geocode button):
  Golden Gate Park, San Francisco, CA`;

function pasteToFile(raw: string): File {
  const text = raw.trim();
  if (!text) throw new Error("Nothing to paste");

  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      JSON.parse(text);
      return new File([text], "pasted.geojson", { type: "application/geo+json" });
    } catch {
      /* fall through */
    }
  }

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const coordOnly = lines.every((line) => {
    const parts = line.split(/[,\s\t]+/).filter(Boolean);
    if (parts.length < 2) return false;
    return Number.isFinite(Number(parts[0])) && Number.isFinite(Number(parts[1]));
  });

  if (coordOnly && lines.length > 0) {
    const first = Number(lines[0].split(/[,\s\t]+/)[0]);
    const lonFirst = Math.abs(first) > 90;
    const header = lonFirst ? "longitude,latitude" : "latitude,longitude";
    const body = lines
      .map((line) => {
        const parts = line.split(/[,\s\t]+/).filter(Boolean);
        return `${parts[0]},${parts[1]}`;
      })
      .join("\n");
    return new File([`${header}\n${body}`], "pasted-coords.csv", { type: "text/csv" });
  }

  return new File([text], "pasted.csv", { type: "text/csv" });
}

export default function Home() {
  const [tab, setTab] = useState<Tab>("clean");
  const [status, setStatus] = useState("Drop, paste, geocode, or try the sample");
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [targetCrs, setTargetCrs] = useState("EPSG:4326");
  const [sourceCrs, setSourceCrs] = useState("");
  const [bufferMeters, setBufferMeters] = useState("");
  const [h3Resolution, setH3Resolution] = useState("");
  const [copied, setCopied] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [inputMode, setInputMode] = useState<"drop" | "paste">("drop");
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [popupInfo, setPopupInfo] = useState<{
    longitude: number;
    latitude: number;
    properties: Record<string, unknown>;
  } | null>(null);

  function showToast(kind: "ok" | "err", text: string) {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 6000);
  }

  const appendExtras = useCallback(
    (formData: FormData) => {
      formData.append("target_crs", targetCrs);
      if (sourceCrs.trim()) formData.append("source_crs", sourceCrs.trim());
      const buf = parseFloat(bufferMeters);
      if (!Number.isNaN(buf) && buf > 0) formData.append("buffer_meters", String(buf));
      const h3 = parseInt(h3Resolution, 10);
      if (!Number.isNaN(h3) && h3 >= 0) formData.append("h3_resolution", String(h3));
    },
    [targetCrs, sourceCrs, bufferMeters, h3Resolution]
  );

  const runClean = useCallback(
    async (file: File) => {
      setLoading(true);
      setStatus(`Processing ${file.name}...`);
      setResult(null);
      setPopupInfo(null);
      setCopied(false);

      const formData = new FormData();
      formData.append("file", file);
      appendExtras(formData);

      try {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 20000);
        const res = await fetch("/api/clean", {
          method: "POST",
          body: formData,
          signal: controller.signal,
        });
        window.clearTimeout(timer);
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Server clean failed");
        setResult(data);
        const msg = `Done! ${data.feature_count} features cleaned.`;
        setStatus(msg);
        showToast("ok", msg);
        setTab("map");
        return;
      } catch (err: any) {
        try {
          const local = await cleanFileInBrowser(file);
          setResult(local);
          const msg = `Done! ${local.feature_count} features cleaned (browser).`;
          setStatus(msg);
          showToast("ok", msg);
          setTab("map");
        } catch (localErr: any) {
          const msg = localErr?.message || err?.message || "Could not clean file";
          setStatus(`Error: ${msg}`);
          showToast("err", msg);
        }
      } finally {
        setLoading(false);
      }
    },
    [appendExtras]
  );

  const runGeocode = useCallback(async () => {
    const text = pasteText.trim();
    if (!text) {
      setStatus("Paste addresses first (one per line)");
      showToast("err", "Paste addresses first (one per line)");
      return;
    }
    setLoading(true);
    setStatus("Geocoding addresses (Nominatim, ~1/sec)...");
    setResult(null);
    setPopupInfo(null);

    const formData = new FormData();
    formData.append("addresses", text);
    appendExtras(formData);

    try {
      const res = await fetch("/api/geocode", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) {
        const msg = data.detail || "Geocoding failed";
        setStatus(`Error: ${msg}`);
        showToast("err", msg);
        return;
      }
      setResult(data);
      const msg = `Done! Geocoded ${data.feature_count} addresses.`;
      setStatus(msg);
      showToast("ok", msg);
      setTab("map");
    } catch (err: any) {
      const msg = err.message || "Geocoding failed";
      setStatus(`Failed: ${msg}`);
      showToast("err", msg);
    } finally {
      setLoading(false);
    }
  }, [pasteText, appendExtras]);

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      const file = acceptedFiles[0];
      if (file) await runClean(file);
    },
    [runClean]
  );

  const loadSample = useCallback(async () => {
    await runClean(new File([SAMPLE_CSV], "parks-demo.csv", { type: "text/csv" }));
  }, [runClean]);

  const runPaste = useCallback(async () => {
    try {
      await runClean(pasteToFile(pasteText));
    } catch (e: any) {
      const msg = e.message || "Could not parse pasted data";
      setStatus(msg);
      showToast("err", msg);
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
    setPopupInfo({
      longitude: e.lngLat.lng,
      latitude: e.lngLat.lat,
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
      {toast && (
        <div
          className={`fixed top-16 right-4 z-50 max-w-sm rounded-xl px-4 py-3 text-sm shadow-lg border ${
            toast.kind === "ok"
              ? "bg-emerald-900/95 border-emerald-500 text-emerald-50"
              : "bg-rose-900/95 border-rose-500 text-rose-50"
          }`}
        >
          {toast.text}
        </div>
      )}
      <header className="border-b border-slate-800 bg-slate-950/80 backdrop-blur sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="text-emerald-400 font-bold text-lg tracking-tight">gh-impact</span>
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
                Drop · paste · geocode · buffer · H3 → ready for the web
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
                    placeholder="auto"
                    value={sourceCrs}
                    onChange={(e) => setSourceCrs(e.target.value)}
                    className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm w-36 text-slate-100"
                  />
                </label>
                <label className="text-sm text-slate-400 flex items-center gap-2">
                  Buffer (m)
                  <input
                    type="number"
                    min={0}
                    placeholder="0"
                    value={bufferMeters}
                    onChange={(e) => setBufferMeters(e.target.value)}
                    className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm w-24 text-slate-100"
                  />
                </label>
                <label className="text-sm text-slate-400 flex items-center gap-2">
                  H3 res
                  <input
                    type="number"
                    min={0}
                    max={15}
                    placeholder="off"
                    value={h3Resolution}
                    onChange={(e) => setH3Resolution(e.target.value)}
                    className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm w-20 text-slate-100"
                  />
                </label>
              </div>
              <button
                onClick={loadSample}
                disabled={loading}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm font-medium transition"
              >
                {loading ? "Working…" : "Try sample parks data"}
              </button>
            </div>

            <div className="flex justify-center gap-1 p-1 bg-slate-900 rounded-xl border border-slate-800 w-fit mx-auto">
              <button
                onClick={() => setInputMode("drop")}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition ${
                  inputMode === "drop" ? "bg-emerald-600 text-white" : "text-slate-400 hover:text-white"
                }`}
              >
                Drop file
              </button>
              <button
                onClick={() => setInputMode("paste")}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition ${
                  inputMode === "paste" ? "bg-emerald-600 text-white" : "text-slate-400 hover:text-white"
                }`}
              >
                Paste data
              </button>
            </div>

            {inputMode === "drop" ? (
              <div
                {...getRootProps()}
                className={`border-2 border-dashed rounded-2xl p-12 sm:p-16 text-center cursor-pointer transition
                  ${isDragActive ? "border-emerald-400 bg-emerald-950/30" : "border-slate-700 hover:border-slate-500"}
                  ${loading ? "opacity-60 pointer-events-none" : ""}`}
              >
                <input {...getInputProps()} />
                <p className="text-lg">
                  {isDragActive ? "Drop it!" : "Drag & drop CSV, GeoJSON, or Shapefile (.zip)"}
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
                    className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded-lg text-sm font-medium transition"
                  >
                    Clean pasted data
                  </button>
                  <button
                    onClick={runGeocode}
                    disabled={loading || !pasteText.trim()}
                    className="px-5 py-2.5 bg-sky-600 hover:bg-sky-500 disabled:opacity-40 rounded-lg text-sm font-medium transition"
                  >
                    Geocode addresses
                  </button>
                  <button
                    onClick={() => setPasteText(SAMPLE_CSV)}
                    disabled={loading}
                    className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm font-medium transition border border-slate-700"
                  >
                    Sample CSV
                  </button>
                  <button
                    onClick={() => setPasteText(SAMPLE_ADDRESSES)}
                    disabled={loading}
                    className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm font-medium transition border border-slate-700"
                  >
                    Sample addresses
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

            <div className={`text-center text-sm font-medium ${status.startsWith("Error") || status.startsWith("Failed") ? "text-rose-400" : "text-emerald-300"}`}>
              {loading ? "Working… first run can take ~20 seconds." : status}
            </div>
          </div>
        )}

        {tab === "map" && (
          <div className="space-y-4">
            {result && (
              <div className="rounded-xl border border-emerald-500/40 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-100">
                Cleaned {result.feature_count} features. Export with GeoJSON / CSV, or click a point for attributes.
              </div>
            )}
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <h2 className="text-xl font-semibold">Map preview</h2>
                <p className="text-sm text-slate-400">
                  {result
                    ? `${result.feature_count} features · click for details`
                    : "Clean or geocode data first"}
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
                key={result ? `${result.feature_count}-${targetCrs}-${bufferMeters}` : "empty"}
                style={{ width: "100%", height: "100%" }}
                mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
                interactiveLayerIds={result ? ["points", "polygons-fill", "lines"] : []}
                onClick={onMapClick}
                cursor={result ? "pointer" : "grab"}
              >
                <NavigationControl position="top-right" />
                {result?.geojson && (
                  <Source id="cleaned" type="geojson" data={result.geojson}>
                    <Layer id="polygons-fill" type="fill" filter={["==", ["geometry-type"], "Polygon"]} paint={{ "fill-color": "#34d399", "fill-opacity": 0.35 }} />
                    <Layer id="polygons-outline" type="line" filter={["==", ["geometry-type"], "Polygon"]} paint={{ "line-color": "#059669", "line-width": 2 }} />
                    <Layer id="lines" type="line" filter={["==", ["geometry-type"], "LineString"]} paint={{ "line-color": "#34d399", "line-width": 3 }} />
                    <Layer id="points" type="circle" filter={["==", ["geometry-type"], "Point"]} paint={{ "circle-radius": 8, "circle-color": "#34d399", "circle-stroke-width": 2, "circle-stroke-color": "#064e3b" }} />
                  </Source>
                )}
                {popupInfo && (
                  <Popup longitude={popupInfo.longitude} latitude={popupInfo.latitude} anchor="bottom" onClose={() => setPopupInfo(null)} closeOnClick={false} className="text-slate-900">
                    <div className="text-xs space-y-1 max-w-[240px]">
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
          </div>
        )}

        {tab === "features" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold">What it can do</h2>
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <FeatureCard title="Already live" accent="emerald" items={["Drop CSV / GeoJSON / Shapefile (.zip)", "Browser fallback if API is slow", "Paste CSV, GeoJSON, or lat/lon lines", "Geocode addresses", "Map + export"]} />
              <FeatureCard title="Needs server" accent="sky" items={["Shapefile zip", "Buffer / H3", "CRS reprojection", "Geometry repair"]} />
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
