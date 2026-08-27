"use client";

import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";

export default function Home() {
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
      // On Vercel this hits the backend service via the /api rewrite.
      // Locally you can either:
      //   1. Run `vercel dev` (recommended), or
      //   2. Run the FastAPI server on :8000 and temporarily change this to http://localhost:8000/clean
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

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-8">
      <div className="max-w-2xl w-full space-y-8">
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-bold tracking-tight">gh-impact wrangler</h1>
          <p className="text-slate-400">
            Messy CSV / coords → clean GeoJSON in seconds
          </p>
        </div>

        <div
          {...getRootProps()}
          className={`border-2 border-dashed rounded-2xl p-16 text-center cursor-pointer transition
            ${isDragActive ? "border-emerald-400 bg-emerald-950/30" : "border-slate-700 hover:border-slate-500"}
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
          <div className="bg-slate-900 rounded-xl p-6 space-y-4">
            <h2 className="font-semibold text-emerald-400">Audit log</h2>
            <pre className="text-xs overflow-auto max-h-48 bg-slate-950 p-4 rounded">
              {JSON.stringify(result.audit, null, 2)}
            </pre>
            <button
              onClick={() => {
                const blob = new Blob([JSON.stringify(result.geojson, null, 2)], {
                  type: "application/geo+json",
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "cleaned.geojson";
                a.click();
                URL.revokeObjectURL(url);
              }}
              className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 rounded-lg font-medium transition"
            >
              Download cleaned GeoJSON
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
