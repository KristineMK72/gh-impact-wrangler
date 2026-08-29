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
import {
  cleanFileInBrowser,
  omittedToastLine,
  summarizeOmitted,
} from "../lib/clientClean";

type Tab = "clean" | "map" | "features";

const SAMPLE_CSV = `name,latitude,longitude,city
Golden Gate Park,37.7694,-122.4862,San Francisco
Central Park,40.7829,-73.9654,New York
Griffith Park,34.1367,-118.2942,Los Angeles
Millennium Park,41.8826,-87.6226,Chicago
Balboa Park,32.7341,-117.1446,San Diego
Mystery Park,, ,Nowhere
Bad Coords,999,999,Atlantis
Central Park again,40.7829,-73.9654,New York`;

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

function applyResult(data: any) {
  const omitted = summarizeOmitted(data);
  return {
    ...data,
    omitted,
    feature_count: data.feature_count ?? data.geojson?.features?.length ?? 0,
  };
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
    window.setTimeout(() => setToast(null), 8000);
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

  const finishOk = (data: any, extra = "") => {
    const packed = applyResult(data);
    setResult(packed);
    const msg = omittedToastLine(packed.feature_count, packed.omitted) + extra;
    setStatus(msg);
    showToast("ok", msg);
    setTab("map");
  };

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
        finishOk(data);
        return;
      } catch (err: any) {
        try {
          const local = await cleanFileInBrowser(file);
          finishOk(local, " (browser)");
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
      showToast("err", "Paste addresses first (one per line)");
      return;
    }
    setLoading(true);
    setStatus("Geocoding addresses (Nominatim, ~1/sec)...");
    setResult(null);
    const formData = new FormData();
    formData.append("addresses", text);
    appendExtras(formData);
    try {
      const res = await fetch("/api/geocode", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) {
        showToast("err", data.detail || "Geocoding failed");
        return;
      }
      finishOk(data);
    } catch (err: any) {
      showToast("err", err.message || "Geocoding failed");
    } finally {
      setLoading(false);
    }
  }, [pasteText, appendExtras]);

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      if (acceptedFiles[0]) await runClean(acceptedFiles[0]);
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
      showToast("err", e.message || "Could not parse pasted data");
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

  const omitted = result ? summarizeOmitted(result) : null;

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
            {(["clean", "map", "features"] as Tab[]).map((id) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium capitalize transition ${
                  tab === id ? "bg-emerald-600 text-white" : "text-slate-400 hover:text-white hover:bg-slate-800"
                }`}
              >
                {id === "features" ? "Roadmap" : id}
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
              <p className="text-slate-400">Drop · paste · geocode → kept features + omitted report</p>
            </div>
            <div className="flex justify-center">
              <button
                onClick={loadSample}
                disabled={loading}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm font-medium"
              >
                {loading ? "Working…" : "Try sample parks data"}
              </button>
            </div>
            <div className="flex justify-center gap-1 p-1 bg-slate-900 rounded-xl border border-slate-800 w-fit mx-auto">
              <button onClick={() => setInputMode("drop")} className={`px-4 py-1.5 rounded-lg text-sm ${inputMode === "drop" ? "bg-emerald-600" : "text-slate-400"}`}>Drop file</button>
              <button onClick={() => setInputMode("paste")} className={`px-4 py-1.5 rounded-lg text-sm ${inputMode === "paste" ? "bg-emerald-600" : "text-slate-400"}`}>Paste data</button>
            </div>
            {inputMode === "drop" ? (
              <div {...getRootProps()} className={`border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer ${isDragActive ? "border-emerald-400" : "border-slate-700"} ${loading ? "opacity-60 pointer-events-none" : ""}`}>
                <input {...getInputProps()} />
                <p className="text-lg">Drag & drop CSV, GeoJSON, or Shapefile (.zip)</p>
              </div>
            ) : (
              <div className="space-y-3">
                <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} rows={10} className="w-full bg-slate-900 border border-slate-700 rounded-2xl p-4 text-sm font-mono" disabled={loading} />
                <div className="flex flex-wrap gap-2 justify-center">
                  <button onClick={runPaste} disabled={loading || !pasteText.trim()} className="px-5 py-2.5 bg-emerald-600 rounded-lg text-sm">Clean pasted data</button>
                  <button onClick={runGeocode} disabled={loading || !pasteText.trim()} className="px-5 py-2.5 bg-sky-600 rounded-lg text-sm">Geocode addresses</button>
                  <button onClick={() => setPasteText(SAMPLE_CSV)} className="px-4 py-2.5 bg-slate-800 rounded-lg text-sm border border-slate-700">Sample CSV</button>
                </div>
              </div>
            )}
            <div className="text-center text-sm text-emerald-300">{loading ? "Working…" : status}</div>
          </div>
        )}

        {tab === "map" && (
          <div className="space-y-4">
            {result && (
              <div className="rounded-xl border border-emerald-500/40 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-100">
                Kept {result.feature_count} features
                {omitted && omitted.count > 0 ? ` · omitted ${omitted.count}` : " · none omitted"}.
              </div>
            )}
            {omitted && omitted.count > 0 && (
              <div className="rounded-xl border border-amber-500/40 bg-amber-950/30 px-4 py-3 text-sm text-amber-100 space-y-2">
                <p className="font-medium">Omitted {omitted.count}</p>
                <ul className="list-disc pl-5 text-amber-200/90 space-y-0.5">
                  {Object.entries(omitted.reasons).map(([reason, n]) => (
                    <li key={reason}>
                      {n} × {reason}
                    </li>
                  ))}
                </ul>
                {omitted.samples?.length > 0 && (
                  <div className="text-xs text-amber-200/80 space-y-1 pt-1">
                    {omitted.samples.map((s: any, i: number) => (
                      <div key={i}>
                        <span className="text-amber-400">{s.reason}:</span> {s.preview}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <h2 className="text-xl font-semibold">Map preview</h2>
              {result && (
                <button onClick={downloadGeoJSON} className="px-3 py-2 bg-emerald-600 rounded-lg text-sm">GeoJSON</button>
              )}
            </div>
            <div className="h-[420px] sm:h-[520px] rounded-2xl overflow-hidden border border-slate-800">
              <Map initialViewState={mapView} key={result ? String(result.feature_count) : "empty"} style={{ width: "100%", height: "100%" }} mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json" interactiveLayerIds={result ? ["points", "polygons-fill", "lines"] : []} onClick={(e: MapLayerMouseEvent) => {
                const feature = e.features?.[0];
                if (!feature) return setPopupInfo(null);
                setPopupInfo({ longitude: e.lngLat.lng, latitude: e.lngLat.lat, properties: (feature.properties || {}) as Record<string, unknown> });
              }}>
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
                  <Popup longitude={popupInfo.longitude} latitude={popupInfo.latitude} anchor="bottom" onClose={() => setPopupInfo(null)} className="text-slate-900">
                    <div className="text-xs space-y-1 max-w-[240px]">
                      {Object.entries(popupInfo.properties).map(([k, v]) => (
                        <div key={k}><span className="font-semibold">{k}:</span> {String(v)}</div>
                      ))}
                    </div>
                  </Popup>
                )}
              </Map>
            </div>
          </div>
        )}

        {tab === "features" && (
          <p className="text-slate-400 text-sm">Omitted rows now show reason + a preview snippet (blank coords, non-numeric, out of range, duplicates, missing geometry).</p>
        )}
      </main>
    </div>
  );
}
