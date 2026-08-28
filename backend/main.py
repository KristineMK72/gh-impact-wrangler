"""
gh-impact-wrangler backend
Zero-friction geographic data cleaning API
"""

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import geopandas as gpd
import pandas as pd
from shapely.geometry import Point, mapping
from shapely.validation import make_valid
from shapely.ops import transform
from io import BytesIO
from pathlib import Path
import zipfile
import tempfile
import json
import asyncio
from typing import Optional
import httpx

try:
    import h3
except ImportError:
    h3 = None

app = FastAPI(
    title="gh-impact-wrangler",
    description="Zero-friction geographic data wrangling",
    version="0.3.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def detect_lat_lon_columns(df: pd.DataFrame) -> tuple[Optional[str], Optional[str]]:
    cols = {c.lower(): c for c in df.columns}
    lat_candidates = ["lat", "latitude", "y", "northing", "lat_dd", "lat_deg"]
    lon_candidates = ["lon", "lng", "long", "longitude", "x", "easting", "lon_dd", "lon_deg"]
    lat_col = next((cols[c] for c in lat_candidates if c in cols), None)
    lon_col = next((cols[c] for c in lon_candidates if c in cols), None)
    return lat_col, lon_col


def clean_geodataframe(
    gdf: gpd.GeoDataFrame,
    target_crs: str = "EPSG:4326",
    drop_invalid: bool = True,
) -> tuple[gpd.GeoDataFrame, dict]:
    audit = {
        "original_rows": len(gdf),
        "original_crs": str(gdf.crs) if gdf.crs else None,
        "actions": [],
    }

    null_geom = gdf.geometry.isna().sum()
    if null_geom > 0:
        gdf = gdf.dropna(subset=["geometry"])
        audit["actions"].append(f"Dropped {null_geom} rows with null geometry")

    invalid = ~gdf.geometry.is_valid
    if invalid.any():
        gdf.loc[invalid, "geometry"] = gdf.loc[invalid, "geometry"].apply(make_valid)
        audit["actions"].append(f"Repaired {invalid.sum()} invalid geometries")

    if gdf.crs is None:
        gdf = gdf.set_crs("EPSG:4326")
        audit["actions"].append("Assumed source CRS = EPSG:4326 (no CRS detected)")
    elif str(gdf.crs) != target_crs:
        try:
            gdf = gdf.to_crs(target_crs)
            audit["actions"].append(f"Reprojected from {audit['original_crs']} → {target_crs}")
        except Exception as e:
            audit["actions"].append(f"Reproject failed ({e}); kept original CRS")

    if drop_invalid:
        still_invalid = ~gdf.geometry.is_valid
        if still_invalid.any():
            gdf = gdf[~still_invalid]
            audit["actions"].append(f"Dropped {still_invalid.sum()} still-invalid geometries")

    before = len(gdf)
    gdf = gdf.drop_duplicates(subset=["geometry"])
    if len(gdf) < before:
        audit["actions"].append(f"Removed {before - len(gdf)} duplicate geometries")

    if not gdf.empty and gdf.geometry.geom_type.str.startswith("Multi").any():
        before_exp = len(gdf)
        gdf = gdf.explode(index_parts=False).reset_index(drop=True)
        audit["actions"].append(f"Exploded multi-geometries ({before_exp} → {len(gdf)} features)")

    audit["final_rows"] = len(gdf)
    audit["final_crs"] = str(gdf.crs)
    audit["geometry_types"] = (
        gdf.geometry.geom_type.value_counts().to_dict() if len(gdf) else {}
    )
    return gdf, audit


def apply_buffer(gdf: gpd.GeoDataFrame, meters: float, audit: dict) -> gpd.GeoDataFrame:
    if meters <= 0 or gdf.empty:
        return gdf
    # Buffer in a metric CRS then back
    working = gdf.copy()
    if working.crs is None:
        working = working.set_crs("EPSG:4326")
    # Use Web Mercator for approximate metric buffer (good enough for MVP)
    projected = working.to_crs("EPSG:3857")
    projected["geometry"] = projected.geometry.buffer(meters)
    result = projected.to_crs(working.crs)
    audit["actions"].append(f"Buffered geometries by {meters} meters")
    audit["geometry_types"] = result.geometry.geom_type.value_counts().to_dict()
    return result


def apply_h3(gdf: gpd.GeoDataFrame, resolution: int, audit: dict) -> gpd.GeoDataFrame:
    if h3 is None:
        audit["actions"].append("H3 not available (library missing)")
        return gdf
    if resolution < 0 or resolution > 15:
        audit["actions"].append(f"Invalid H3 resolution {resolution}; skipped")
        return gdf

    gdf = gdf.copy()
    # Work in WGS84 for lat/lon
    wgs = gdf.to_crs("EPSG:4326") if gdf.crs and str(gdf.crs) != "EPSG:4326" else gdf

    def cell_for(geom):
        try:
            if geom is None or geom.is_empty:
                return None
            if geom.geom_type == "Point":
                lat, lon = geom.y, geom.x
            else:
                c = geom.centroid
                lat, lon = c.y, c.x
            return h3.latlng_to_cell(lat, lon, resolution)
        except Exception:
            try:
                # h3 v3 API fallback
                if geom.geom_type == "Point":
                    return h3.geo_to_h3(geom.y, geom.x, resolution)
                c = geom.centroid
                return h3.geo_to_h3(c.y, c.x, resolution)
            except Exception:
                return None

    gdf["h3"] = wgs.geometry.apply(cell_for)
    audit["actions"].append(f"Added H3 index at resolution {resolution}")
    return gdf


def read_shapefile_zip(content: bytes) -> gpd.GeoDataFrame:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        with zipfile.ZipFile(BytesIO(content)) as zf:
            zf.extractall(tmp_path)
        shp_files = list(tmp_path.rglob("*.shp"))
        if not shp_files:
            raise ValueError("No .shp file found inside the zip archive")
        return gpd.read_file(shp_files[0])


def gdf_to_response(gdf: gpd.GeoDataFrame, audit: dict) -> dict:
    for col in gdf.columns:
        if col == "geometry":
            continue
        if gdf[col].dtype == object:
            gdf[col] = gdf[col].astype(str)
    geojson = json.loads(gdf.to_json())
    return {
        "success": True,
        "audit": audit,
        "feature_count": len(gdf),
        "geojson": geojson,
    }


@app.get("/")
@app.get("/api")
def root():
    return {
        "service": "gh-impact-wrangler",
        "status": "ready",
        "version": "0.3.0",
        "endpoints": ["/clean", "/api/clean", "/geocode", "/api/geocode", "/docs"],
        "formats": ["csv", "geojson", "shapefile zip", "addresses"],
        "extras": ["buffer_meters", "h3_resolution", "geocode"],
    }


@app.post("/clean")
@app.post("/api/clean")
async def clean_data(
    file: UploadFile = File(...),
    target_crs: str = Form("EPSG:4326"),
    lat_col: Optional[str] = Form(None),
    lon_col: Optional[str] = Form(None),
    source_crs: Optional[str] = Form(None),
    buffer_meters: Optional[float] = Form(0),
    h3_resolution: Optional[int] = Form(-1),
):
    content = await file.read()
    filename = (file.filename or "upload").lower()
    content_type = (file.content_type or "").lower()

    try:
        if filename.endswith(".csv") or content_type == "text/csv":
            df = pd.read_csv(BytesIO(content))
            if not lat_col or not lon_col:
                detected_lat, detected_lon = detect_lat_lon_columns(df)
                lat_col = lat_col or detected_lat
                lon_col = lon_col or detected_lon
            if not lat_col or not lon_col:
                raise HTTPException(
                    status_code=400,
                    detail="Could not detect latitude/longitude columns. "
                    "Please specify lat_col and lon_col, or use /geocode for addresses.",
                )
            geometry = [
                Point(xy)
                for xy in zip(df[lon_col].astype(float), df[lat_col].astype(float))
            ]
            gdf = gpd.GeoDataFrame(df, geometry=geometry)
            if source_crs:
                gdf = gdf.set_crs(source_crs)
            else:
                gdf = gdf.set_crs("EPSG:4326")

        elif filename.endswith((".geojson", ".json")) or "geojson" in content_type:
            gdf = gpd.read_file(BytesIO(content))
            if source_crs and gdf.crs is None:
                gdf = gdf.set_crs(source_crs)

        elif filename.endswith(".zip") or "zip" in content_type:
            gdf = read_shapefile_zip(content)
            if source_crs and gdf.crs is None:
                gdf = gdf.set_crs(source_crs)

        else:
            raise HTTPException(
                status_code=400,
                detail="Supported formats: CSV (lat/lon), GeoJSON, or Shapefile (.zip).",
            )

        if gdf.empty:
            raise HTTPException(status_code=400, detail="No features found in the file.")

        cleaned, audit = clean_geodataframe(gdf, target_crs=target_crs)

        buf = float(buffer_meters or 0)
        if buf > 0:
            cleaned = apply_buffer(cleaned, buf, audit)

        h3res = int(h3_resolution if h3_resolution is not None else -1)
        if h3res >= 0:
            cleaned = apply_h3(cleaned, h3res, audit)

        return JSONResponse(gdf_to_response(cleaned, audit))

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


async def geocode_one(client: httpx.AsyncClient, address: str) -> Optional[dict]:
    try:
        r = await client.get(
            "https://nominatim.openstreetmap.org/search",
            params={"q": address, "format": "json", "limit": 1},
        )
        r.raise_for_status()
        data = r.json()
        if not data:
            return None
        hit = data[0]
        return {
            "address": address,
            "display_name": hit.get("display_name"),
            "latitude": float(hit["lat"]),
            "longitude": float(hit["lon"]),
        }
    except Exception:
        return None


@app.post("/geocode")
@app.post("/api/geocode")
async def geocode_addresses(
    addresses: str = Form(...),
    target_crs: str = Form("EPSG:4326"),
    buffer_meters: Optional[float] = Form(0),
    h3_resolution: Optional[int] = Form(-1),
):
    """Geocode newline-separated addresses via OpenStreetMap Nominatim."""
    lines = [ln.strip() for ln in addresses.splitlines() if ln.strip()]
    # Cap to be polite to Nominatim
    lines = lines[:25]
    if not lines:
        raise HTTPException(status_code=400, detail="No addresses provided")

    audit = {"original_rows": len(lines), "actions": [], "original_crs": None}
    results = []

    async with httpx.AsyncClient(
        headers={"User-Agent": "gh-impact-wrangler/0.3 (geo data cleaning tool)"},
        timeout=20.0,
    ) as client:
        for i, addr in enumerate(lines):
            hit = await geocode_one(client, addr)
            if hit:
                results.append(hit)
            # Nominatim usage policy: max ~1 req/sec
            if i < len(lines) - 1:
                await asyncio.sleep(1.05)

    audit["actions"].append(
        f"Geocoded {len(results)} of {len(lines)} addresses (Nominatim)"
    )

    if not results:
        raise HTTPException(
            status_code=404,
            detail="No addresses could be geocoded. Try more specific place names.",
        )

    df = pd.DataFrame(results)
    geometry = [Point(xy) for xy in zip(df["longitude"], df["latitude"])]
    gdf = gpd.GeoDataFrame(df, geometry=geometry, crs="EPSG:4326")

    cleaned, clean_audit = clean_geodataframe(gdf, target_crs=target_crs)
    audit["actions"].extend(clean_audit["actions"])
    audit["final_rows"] = clean_audit["final_rows"]
    audit["final_crs"] = clean_audit["final_crs"]
    audit["geometry_types"] = clean_audit.get("geometry_types", {})

    buf = float(buffer_meters or 0)
    if buf > 0:
        cleaned = apply_buffer(cleaned, buf, audit)

    h3res = int(h3_resolution if h3_resolution is not None else -1)
    if h3res >= 0:
        cleaned = apply_h3(cleaned, h3res, audit)

    return JSONResponse(gdf_to_response(cleaned, audit))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
