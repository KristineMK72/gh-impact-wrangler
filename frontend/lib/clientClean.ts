const LAT_KEYS = ["lat", "latitude", "y", "northing", "lat_dd", "lat_deg"];
const LON_KEYS = ["lon", "lng", "long", "longitude", "x", "easting", "lon_dd", "lon_deg"];

export type OmittedRow = {
  reason: string;
  preview: string;
};

export type Omitted = {
  count: number;
  reasons: Record<string, number>;
  samples: OmittedRow[];
};

export type CleanResult = {
  success: true;
  feature_count: number;
  omitted: Omitted;
  audit: {
    original_rows: number;
    actions: string[];
    final_rows: number;
    final_crs: string;
    geometry_types: Record<string, number>;
    original_crs: string | null;
    omitted: Omitted;
  };
  geojson: {
    type: "FeatureCollection";
    features: Array<{
      type: "Feature";
      properties: Record<string, unknown>;
      geometry: { type: string; coordinates: number[] | number[][] | number[][][] };
    }>;
  };
};

export function emptyOmitted(): Omitted {
  return { count: 0, reasons: {}, samples: [] };
}

export function summarizeOmitted(result: any): Omitted {
  if (result?.omitted?.count != null) return result.omitted;
  if (result?.audit?.omitted?.count != null) return result.audit.omitted;
  const actions: string[] = result?.audit?.actions || [];
  const reasons: Record<string, number> = {};
  for (const a of actions) {
    const m = a.match(/Dropped (\d+)/i) || a.match(/Removed (\d+)/i);
    if (m) {
      const n = Number(m[1]);
      const label = a.replace(/^\s+/, "");
      reasons[label] = (reasons[label] || 0) + n;
    }
  }
  const count = Object.values(reasons).reduce((s, n) => s + n, 0);
  return { count, reasons, samples: [] };
}

export function omittedToastLine(kept: number, omitted: Omitted) {
  if (!omitted.count) return `Done! ${kept} features kept. None omitted.`;
  const bits = Object.entries(omitted.reasons)
    .map(([k, n]) => `${n} ${k}`)
    .slice(0, 3);
  return `Done! ${kept} kept, ${omitted.count} omitted (${bits.join("; ")}).`;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error("CSV needs a header row and at least one data row");
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] ?? "";
    });
    return row;
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function detectLatLon(headers: string[]): { lat?: string; lon?: string } {
  const map = Object.fromEntries(headers.map((h) => [h.toLowerCase(), h]));
  const lat = LAT_KEYS.map((k) => map[k]).find(Boolean);
  const lon = LON_KEYS.map((k) => map[k]).find(Boolean);
  return { lat, lon };
}

function addOmit(omitted: Omitted, reason: string, preview: string) {
  omitted.count += 1;
  omitted.reasons[reason] = (omitted.reasons[reason] || 0) + 1;
  if (omitted.samples.length < 12) omitted.samples.push({ reason, preview });
}

function pack(
  features: CleanResult["geojson"]["features"],
  actions: string[],
  originalRows: number,
  omitted: Omitted
): CleanResult {
  const types: Record<string, number> = {};
  features.forEach((f) => {
    const t = f.geometry.type;
    types[t] = (types[t] || 0) + 1;
  });
  if (omitted.count) {
    actions.push(`Omitted ${omitted.count} rows`);
    Object.entries(omitted.reasons).forEach(([reason, n]) => {
      actions.push(`${n} omitted: ${reason}`);
    });
  }
  return {
    success: true,
    feature_count: features.length,
    omitted,
    audit: {
      original_rows: originalRows,
      actions,
      final_rows: features.length,
      final_crs: "EPSG:4326",
      geometry_types: types,
      original_crs: "EPSG:4326",
      omitted,
    },
    geojson: { type: "FeatureCollection", features },
  };
}

function rowPreview(row: Record<string, string>) {
  return Object.values(row).slice(0, 4).join(", ").slice(0, 80);
}

export async function cleanFileInBrowser(file: File): Promise<CleanResult> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".zip")) {
    throw new Error("Shapefile zips need the server cleaner. Try CSV or GeoJSON, or wait for the API.");
  }
  const text = await file.text();
  const actions = [`Cleaned in browser (${file.name})`];
  const omitted = emptyOmitted();

  if (name.endsWith(".geojson") || name.endsWith(".json") || text.trim().startsWith("{") || text.trim().startsWith("[")) {
    const parsed = JSON.parse(text);
    const raw = Array.isArray(parsed)
      ? parsed
      : parsed.features || parsed.geometry
        ? parsed.type === "FeatureCollection"
          ? parsed.features
          : [parsed]
        : [];
    const features: CleanResult["geojson"]["features"] = [];
    raw.forEach((f: any, i: number) => {
      if (!f?.geometry) {
        addOmit(omitted, "missing geometry", `feature ${i + 1}`);
        return;
      }
      features.push({
        type: "Feature",
        properties: f.properties || {},
        geometry: f.geometry,
      });
    });
    if (!features.length) throw new Error("No features found in GeoJSON");
    actions.push(`Parsed ${features.length} GeoJSON features`);
    return pack(features, actions, raw.length, omitted);
  }

  const rows = parseCsv(text);
  const { lat, lon } = detectLatLon(Object.keys(rows[0] || {}));
  if (!lat || !lon) {
    throw new Error("Could not detect latitude/longitude columns. Rename them lat/lon or latitude/longitude.");
  }
  actions.push(`Detected columns ${lat} / ${lon}`);
  const features: CleanResult["geojson"]["features"] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const preview = rowPreview(row);
    const rawLat = row[lat];
    const rawLon = row[lon];
    if (rawLat === "" || rawLon === "" || rawLat == null || rawLon == null) {
      addOmit(omitted, "blank coordinates", preview);
      continue;
    }
    const la = Number(rawLat);
    const lo = Number(rawLon);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) {
      addOmit(omitted, "non-numeric coordinates", preview);
      continue;
    }
    if (Math.abs(la) > 90 || Math.abs(lo) > 180) {
      addOmit(omitted, "out of range lat/lon", preview);
      continue;
    }
    const key = `${lo},${la}`;
    if (seen.has(key)) {
      addOmit(omitted, "duplicate location", preview);
      continue;
    }
    seen.add(key);
    features.push({
      type: "Feature",
      properties: { ...row },
      geometry: { type: "Point", coordinates: [lo, la] },
    });
  }
  if (!features.length) throw new Error("No valid coordinate rows found");
  return pack(features, actions, rows.length, omitted);
}
