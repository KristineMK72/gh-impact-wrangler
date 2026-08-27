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
   - Live map preview (MapLibre) — coming next
   - Download clean **GeoJSON** or **Shapefile**
   - Copy as FeatureCollection
   - Optional: H3 indexing, simple spatial joins later

4. **Audit & reproducibility**
   - Show exactly what was changed
   - One-click “wrangle recipe” for reuse

## Tech Stack

- **Frontend**: Next.js + Tailwind + MapLibre GL + react-dropzone
- **Backend**: FastAPI + GeoPandas / Shapely / pyproj
- **Storage**: Temporary for processing; no long-term storage in MVP
- **Deploy target**: Vercel (frontend) + Railway / Fly.io / Render (API)

## Local Development

### 1. Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

API docs: http://localhost:8000/docs

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:3000 and drop a CSV or GeoJSON.

### Example CSV

```csv
name,latitude,longitude
Park A,37.7749,-122.4194
Park B,34.0522,-118.2437
```

The tool will auto-detect the lat/lon columns, create points, clean, and return GeoJSON.

## Status

✅ Repo scaffolded  
✅ FastAPI `/clean` endpoint (CSV + GeoJSON → cleaned GeoJSON + audit)  
✅ Minimal Next.js dropzone UI  
🚧 Map preview  
🚧 Shapefile upload/export  
🚧 Better CRS detection & UI controls  

Part of the broader **gh-impact** vision: zero-friction geographic data infrastructure for impact analysis, climate, urban planning, and more.

---

Built with ❤️ for every analyst who has ever cursed a messed-up CRS at 2 a.m.
