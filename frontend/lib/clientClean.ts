const LAT_KEYS = ["lat", "latitude", "y", "northing", "lat_dd", "lat_deg"];
const LON_KEYS = ["lon", "lng", "long", "longitude", "x", "easting", "lon_dd", "lon_deg"];

export type CleanResult = {
  success: true;
  feature_count: number;
  audit: {
    original_rows: number;
    actions: string[];
    final_rows: number;
    final_crs: string;
    geometry_types: Record<string, number>;
    original_crs: string | null;
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

function pack(
  features: CleanResult["geojson"]["features"],
  actions: string[],
  originalRows: number
): CleanResult {
  const types: Record<string, number> = {};
  features.forEach((f) => {
    const t = f.geometry.type;
    types[t] = (types[t] || 0) + 1;
  });
  return {
    success: true,
    feature_count: features.length,
    audit: {
      original_rows: originalRows,
      actions,
      final_rows: features.length,
      final_crs: "EPSG:4326",
      geometry_types: types,
      original_crs: "EPSG:4326",
    },
    geojson: { type: "FeatureCollection", features },
  };
}

export async function cleanFileInBrowser(file: File): Promise<CleanResult> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".zip")) {
    throw new Error("Shapefile zips need the server cleaner. Try CSV or GeoJSON, or wait for the API.");
  }
  const text = await file.text();
  const actions = [`Cleaned in browser (${file.name})`];

  if (name.endsWith(".geojson") || name.endsWith(".json") || text.trim().startsWith("{") || text.trim().startsWith("[")) {
    const parsed = JSON.parse(text);
    const raw = Array.isArray(parsed)
      ? parsed
      : parsed.features || parsed.geometry
        ? parsed.type === "FeatureCollection"
          ? parsed.features
          : [parsed]
        : [];
    const features = raw
      .filter((f: any) => f?.geometry)
      .map((f: any) => ({
        type: "Feature" as const,
        properties: f.properties || {},
        geometry: f.geometry,
      }));
    if (!features.length) throw new Error("No features found in GeoJSON");
    actions.push(`Parsed ${features.length} GeoJSON features`);
    return pack(features, actions, features.length);
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
    const la = Number(row[lat]);
    const lo = Number(row[lon]);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
    const key = `${lo},${la}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const properties: Record<string, unknown> = { ...row };
    features.push({
      type: "Feature",
      properties,
      geometry: { type: "Point", coordinates: [lo, la] },
    });
  }
  if (!features.length) throw new Error("No valid coordinate rows found");
  if (features.length < rows.length) {
    actions.push(`Kept ${features.length} of ${rows.length} rows`);
  }
  return pack(features, actions, rows.length);
}
