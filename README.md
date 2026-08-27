# gh-impact-wrangler

**Zero-friction geographic data wrangling**

Data cleaning and formatting remain the biggest bottlenecks in spatial analysis — industry surveys show practitioners spend up to 80% of their time just wrangling and formatting spatial files before any actual mapping happens.

## The Idea

A micro-tool specifically designed to take messy CSVs, local property records, or raw coordinate lists and **instantly validate, re-project, and output clean GeoJSON or shapefiles** ready for web mapping.

**Why it shines**: Turns a universally tedious manual task into a 5-second drag-and-drop web utility.

## Core Features (MVP)

1. **Drag-and-drop upload**
   - CSV with lat/lon or address columns
   - Raw coordinate lists
   - Simple property records / parcel data
   - GeoJSON, GeoPackage, Shapefile (zip)

2. **Instant cleaning pipeline**
   - Detect coordinate columns (lat/lon, x/y, easting/northing)
   - Validate geometries / coordinates
   - Auto-detect or let user choose source CRS
   - Reproject to WGS84 (EPSG:4326) or Web Mercator
   - Repair invalid points, drop nulls, deduplicate
   - Basic attribute type coercion & cleaning

3. **Preview + Export**
   - Live map preview (MapLibre)
   - Download clean **GeoJSON** or **Shapefile**
   - Copy as FeatureCollection
   - Optional: H3 indexing, simple spatial joins later

4. **Audit & reproducibility**
   - Show exactly what was changed
   - One-click “wrangle recipe” for reuse

## Tech Stack (planned)

- **Frontend**: Next.js + Tailwind + MapLibre GL + react-dropzone
- **Backend**: FastAPI + GeoPandas / Shapely / pyproj + DuckDB Spatial
- **Storage**: Temporary (S3 or local) for processing; no long-term storage in MVP
- **Deploy**: Vercel (frontend) + Railway / Fly.io / Render (API)

## Quick Start (coming soon)

```bash
git clone https://github.com/KristineMK72/gh-impact-wrangler.git
cd gh-impact-wrangler
# ... setup instructions will land here
```

## Status

🚧 Early scaffolding — building the drag-and-drop → clean GeoJSON path first.

Part of the broader **gh-impact** vision: zero-friction geographic data infrastructure for impact analysis, climate, urban planning, and more.

---

Built with ❤️ for every analyst who has ever cursed a messed-up CRS at 2 a.m.
