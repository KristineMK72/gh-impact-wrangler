"""
gh-impact-wrangler backend
Zero-friction geographic data cleaning API
"""

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import geopandas as gpd
import pandas as pd
from shapely.geometry import Point
from shapely.validation import make_valid
from io import BytesIO
import json
from typing import Optional

app = FastAPI(
    title="gh-impact-wrangler",
    description="Zero-friction geographic data wrangling: messy CSV/coords → clean GeoJSON",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def detect_lat_lon_columns(df: pd.DataFrame) -> tuple[Optional[str], Optional[str]]:
    """Heuristic to find latitude and longitude columns."""
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
    """Validate, repair, reproject, and return cleaned GDF + audit log."""
    audit = {
        "original_rows": len(gdf),
        "original_crs": str(gdf.crs) if gdf.crs else None,
        "actions": [],
    }

    # Drop null geometries
    null_geom = gdf.geometry.isna().sum()
    if null_geom > 0:
        gdf = gdf.dropna(subset=["geometry"])
        audit["actions"].append(f"Dropped {null_geom} rows with null geometry")

    # Repair invalid geometries
    invalid = ~gdf.geometry.is_valid
    if invalid.any():
        gdf.loc[invalid, "geometry"] = gdf.loc[invalid, "geometry"].apply(make_valid)
        audit["actions"].append(f"Repaired {invalid.sum()} invalid geometries")

    # Reproject
    if gdf.crs is None:
        gdf = gdf.set_crs("EPSG:4326")
        audit["actions"].append("Assumed source CRS = EPSG:4326 (no CRS detected)")
    elif str(gdf.crs) != target_crs:
        gdf = gdf.to_crs(target_crs)
        audit["actions"].append(f"Reprojected from {audit['original_crs']} → {target_crs}")

    if drop_invalid:
        still_invalid = ~gdf.geometry.is_valid
        if still_invalid.any():
            gdf = gdf[~still_invalid]
            audit["actions"].append(f"Dropped {still_invalid.sum()} still-invalid geometries")

    before = len(gdf)
    gdf = gdf.drop_duplicates(subset=["geometry"])
    if len(gdf) < before:
        audit["actions"].append(f"Removed {before - len(gdf)} duplicate geometries")

    audit["final_rows"] = len(gdf)
    audit["final_crs"] = str(gdf.crs)
    return gdf, audit


@app.get("/")
@app.get("/api")
def root():
    return {
        "service": "gh-impact-wrangler",
        "status": "ready",
        "message": "Upload messy spatial data → get clean GeoJSON in seconds",
        "endpoints": ["/clean", "/api/clean", "/docs"],
    }


@app.post("/clean")
@app.post("/api/clean")
async def clean_data(
    file: UploadFile = File(...),
    target_crs: str = Form("EPSG:4326"),
    lat_col: Optional[str] = Form(None),
    lon_col: Optional[str] = Form(None),
    source_crs: Optional[str] = Form(None),
):
    """
    Accept CSV (with lat/lon) or GeoJSON → return cleaned GeoJSON + audit.
    Works at both /clean and /api/clean (for Vercel multi-service routing).
    """
    content = await file.read()
    filename = file.filename or "upload"

    try:
        if filename.lower().endswith(".csv") or file.content_type == "text/csv":
            df = pd.read_csv(BytesIO(content))

            if not lat_col or not lon_col:
                detected_lat, detected_lon = detect_lat_lon_columns(df)
                lat_col = lat_col or detected_lat
                lon_col = lon_col or detected_lon

            if not lat_col or not lon_col:
                raise HTTPException(
                    status_code=400,
                    detail="Could not detect latitude/longitude columns. "
                           "Please specify lat_col and lon_col.",
                )

            geometry = [
                Point(xy) for xy in zip(df[lon_col].astype(float), df[lat_col].astype(float))
            ]
            gdf = gpd.GeoDataFrame(df, geometry=geometry)

            if source_crs:
                gdf = gdf.set_crs(source_crs)
            else:
                gdf = gdf.set_crs("EPSG:4326")

        elif filename.lower().endswith((".geojson", ".json")) or "geojson" in (file.content_type or ""):
            gdf = gpd.read_file(BytesIO(content))

        else:
            raise HTTPException(
                status_code=400,
                detail="Supported formats for MVP: CSV (with lat/lon) and GeoJSON. "
                       "Shapefile support coming next.",
            )

        cleaned, audit = clean_geodataframe(gdf, target_crs=target_crs)
        geojson = json.loads(cleaned.to_json())

        return JSONResponse(
            {
                "success": True,
                "audit": audit,
                "feature_count": len(cleaned),
                "geojson": geojson,
            }
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
