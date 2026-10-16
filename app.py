import glob
import json
import math
import os
import time
from datetime import datetime, timezone

import requests
from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__, static_folder="../frontend", static_url_path="")

HERE = os.path.dirname(os.path.abspath(__file__))
FALLBACK_GEOJSON = os.path.join(HERE, "data", "fallback.geojson")

ARCGIS_URL = (
    "https://services.arcgis.com/XG15cJAlne2vxtgt/ArcGIS/rest/services/"
    "Critical_Infrastructure_Map_Service/FeatureServer/0/query"
)
CMS_HOSPITALS_URL = "https://data.cms.gov/provider-data/api/1/datastore/query/xubh-q36u/0"
HIFLD_HOSPITALS_URL = (
    "https://services.arcgis.com/XG15cJAlne2vxtgt/ArcGIS/rest/services/"
    "Hospitals_hifld/FeatureServer/0/query"
)
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
RELIEFWEB_URL = "https://api.reliefweb.int/v1/disasters"
OSRM_URL = "https://router.project-osrm.org/route/v1/{profile}/{coords}"
OSRM_USER_AGENT = "SafeReach/2.0 (personal, non-commercial)"
OSRM_MIN_INTERVAL_SEC = 1.1
ZIPPOPOTAM_URL = "http://api.zippopotam.us/us/{zip_code}"

TIMEOUT_PRIMARY = 12
TIMEOUT_FALLBACK = 15
MILES_PER_METER = 0.000621371

HOSPITAL_KEYWORDS = ["hospital", "medical center", "medical centre", "health center", "clinic"]



def haversine_miles(lat1, lon1, lat2, lon2):
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def parse_capacity(value):
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return int(value) if value > 0 else None
    digits = "".join(ch for ch in str(value) if ch.isdigit())
    if not digits:
        return None
    n = int(digits)
    return n if n > 0 else None


def capacity_level(capacity):
    if capacity is None:
        return "unknown"
    if capacity > 100:
        return "ample"
    if capacity >= 10:
        return "limited"
    return "critical"


def classify_by_name(name):
    n = (name or "").lower()
    return "hospital" if any(k in n for k in HOSPITAL_KEYWORDS) else "shelter"


def classify_osm_tags(tags):
    if (
        tags.get("amenity") == "hospital"
        or tags.get("healthcare") == "hospital"
        or tags.get("building") == "hospital"
    ):
        return "hospital"
    return classify_by_name(tags.get("name", ""))


def make_record(**kw):
    cap = parse_capacity(kw.get("capacity"))
    return {
        "id": kw["id"],
        "source": kw["source"],
        "name": kw.get("name") or "Unnamed facility",
        "address": kw.get("address", ""),
        "city": kw.get("city", ""),
        "state": kw.get("state", ""),
        "zip": kw.get("zip", ""),
        "phone": kw.get("phone", ""),
        "capacity": cap,
        "capacity_level": capacity_level(cap),
        "pet_friendly": kw.get("pet_friendly"),
        "category": "hospital" if kw.get("category") == "hospital" else "shelter",
        "type": (
            "Hospital" if kw.get("category") == "hospital"
            else ("Emergency shelter" if "bunker" in str(kw.get("type", "")).lower()
                  else kw.get("type", ""))
        ),
        "lat": kw["lat"],
        "lon": kw["lon"],
        "distance_miles": kw["distance_miles"],
    }


def fetch_fema(lat, lon, radius_miles):
    params = {
        "f": "json",
        "outFields": "OBJECTID,NAME,ADDRESS,ADDRESS2,CITY,STATE,ZIP,TELEPHONE,"
        "EVAC_CAP,POSTIM_CAP,PETFACILIT,S_TYPE",
        "geometry": f"{lon},{lat}",
        "geometryType": "esriGeometryPoint",
        "inSR": 4326,
        "outSR": 4326,
        "spatialRel": "esriSpatialRelIntersects",
        "distance": radius_miles,
        "units": "esriSRUnit_StatuteMile",
        "returnGeometry": "true",
    }
    resp = requests.get(ARCGIS_URL, params=params, timeout=TIMEOUT_PRIMARY)
    resp.raise_for_status()
    data = resp.json()
    if "error" in data:
        raise RuntimeError(data["error"].get("message", "ArcGIS error"))

    out = []
    for feat in data.get("features", []):
        a = feat.get("attributes", {})
        g = feat.get("geometry") or {}
        if g.get("y") is None or g.get("x") is None:
            continue
        name = (a.get("NAME") or "Unnamed shelter").title()
        out.append(
            make_record(
                id=f"nss-{a.get('OBJECTID', name)}",
                source="FEMA / Red Cross",
                name=name,
                address=", ".join(p.title() for p in [a.get("ADDRESS"), a.get("ADDRESS2")] if p),
                city=(a.get("CITY") or "").title(),
                state=a.get("STATE") or "",
                zip=a.get("ZIP") or "",
                phone=a.get("TELEPHONE") or "",
                capacity=a.get("EVAC_CAP") or a.get("POSTIM_CAP"),
                pet_friendly=(a.get("PETFACILIT") or "").strip().upper() in ("Y", "YES", "TRUE"),
                category=classify_by_name(name),
                type=(a.get("S_TYPE") or "Shelter").title(),
                lat=g["y"],
                lon=g["x"],
                distance_miles=round(haversine_miles(lat, lon, g["y"], g["x"]), 2),
            )
        )
    return out


_ZIP_CACHE = {}


def zip_centroid(zip_code):
    if zip_code in _ZIP_CACHE:
        return _ZIP_CACHE[zip_code]
    try:
        r = requests.get(ZIPPOPOTAM_URL.format(zip_code=zip_code), timeout=6)
        if not r.ok:
            _ZIP_CACHE[zip_code] = None
            return None
        place = (r.json().get("places") or [{}])[0]
        coords = (float(place["latitude"]), float(place["longitude"]))
    except Exception:  # noqa: BLE001
        coords = None
    _ZIP_CACHE[zip_code] = coords
    return coords


def fetch_cms_hospitals(lat, lon, radius_miles, state_hint=None):
    if not state_hint:
        return []
    params = {
        "limit": 500,
        "conditions[0][property]": "state",
        "conditions[0][value]": state_hint,
        "conditions[0][operator]": "=",
    }
    resp = requests.get(CMS_HOSPITALS_URL, params=params, timeout=TIMEOUT_FALLBACK)
    resp.raise_for_status()
    rows = resp.json().get("results", [])

    out = []
    for row in rows[:200]:
        zip_code = (row.get("zip_code") or "").strip()[:5]
        if not zip_code:
            continue
        coords = zip_centroid(zip_code)
        if not coords:
            continue
        h_lat, h_lon = coords
        dist = haversine_miles(lat, lon, h_lat, h_lon)
        if dist > radius_miles:
            continue
        name = (row.get("facility_name") or "Hospital").title()
        out.append(
            make_record(
                id=f"cms-{row.get('facility_id', name)}",
                source="HHS / CMS",
                name=name,
                address=(row.get("address") or "").title(),
                city=(row.get("citytown") or row.get("city") or "").title(),
                state=row.get("state") or "",
                zip=zip_code,
                phone=row.get("telephone_number") or "",
                capacity=None,
                category="hospital",
                type="Hospital",
                lat=h_lat,
                lon=h_lon,
                distance_miles=round(dist, 2),
            )
        )
    return out


def fetch_osm(lat, lon, radius_miles):
    radius_m = int(radius_miles * 1609.34)
    query = f"""
    [out:json][timeout:25];
    (
      node["emergency"="shelter"](around:{radius_m},{lat},{lon});
      way["emergency"="shelter"](around:{radius_m},{lat},{lon});
      node["amenity"="shelter"]["shelter_type"!="public_transport"](around:{radius_m},{lat},{lon});
      way["amenity"="shelter"]["shelter_type"!="public_transport"](around:{radius_m},{lat},{lon});
      node["amenity"="hospital"](around:{radius_m},{lat},{lon});
      way["amenity"="hospital"](around:{radius_m},{lat},{lon});
      node["healthcare"="hospital"](around:{radius_m},{lat},{lon});
      way["healthcare"="hospital"](around:{radius_m},{lat},{lon});
      node["building"="hospital"](around:{radius_m},{lat},{lon});
      way["building"="hospital"](around:{radius_m},{lat},{lon});
    );
    out center tags;
    """
    last_err = None
    data = None
    for url in OVERPASS_URLS:
        try:
            resp = requests.post(url, data={"data": query}, timeout=30)
            resp.raise_for_status()
            data = resp.json()
            break
        except Exception as exc: 
            last_err = exc
    if data is None:
        raise RuntimeError(f"all Overpass mirrors failed: {last_err}")

    out = []
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        if "lat" in el and "lon" in el:
            e_lat, e_lon = el["lat"], el["lon"]
        else:
            c = el.get("center") or {}
            e_lat, e_lon = c.get("lat"), c.get("lon")
        if e_lat is None or e_lon is None:
            continue
        category = classify_osm_tags(tags)
        type_label = "Hospital" if category == "hospital" else "Emergency shelter"
        default_name = type_label
        out.append(
            make_record(
                id=f"osm-{el.get('type')}-{el.get('id')}",
                source="OpenStreetMap",
                name=tags.get("name") or default_name,
                address=" ".join(
                    b for b in [tags.get("addr:housenumber"), tags.get("addr:street")] if b
                ),
                city=tags.get("addr:city", ""),
                state=tags.get("addr:state", ""),
                zip=tags.get("addr:postcode", ""),
                phone=tags.get("phone") or tags.get("contact:phone") or "",
                capacity=tags.get("capacity") or tags.get("beds"),
                category=category,
                type=type_label,
                lat=e_lat,
                lon=e_lon,
                distance_miles=round(haversine_miles(lat, lon, e_lat, e_lon), 2),
            )
        )
    return out


def fetch_hifld_hospitals(lat, lon, radius_miles):
    params = {
        "f": "json",
        "where": "1=1",
        "outFields": "OBJECTID_1,OBJECTID,NAME,ADDRESS,CITY,STATE,ZIP,TELEPHONE,TYPE,STATUS,COUNTRY,BEDS,WEBSITE,TRAUMA,LATITUDE,LONGITUDE",
        "geometry": f"{lon},{lat}",
        "geometryType": "esriGeometryPoint",
        "inSR": 4326,
        "outSR": 4326,
        "spatialRel": "esriSpatialRelIntersects",
        "distance": radius_miles,
        "units": "esriSRUnit_StatuteMile",
        "returnGeometry": "true",
        "resultRecordCount": 2000,
    }
    resp = requests.get(HIFLD_HOSPITALS_URL, params=params, timeout=TIMEOUT_FALLBACK)
    resp.raise_for_status()
    data = resp.json()
    if "error" in data:
        raise RuntimeError(data["error"].get("message", "HIFLD ArcGIS error"))

    out = []
    for feat in data.get("features", []):
        attrs = feat.get("attributes") or {}
        geom = feat.get("geometry") or {}
        try:
            h_lat = float(geom.get("y", attrs.get("LATITUDE")))
            h_lon = float(geom.get("x", attrs.get("LONGITUDE")))
        except (TypeError, ValueError):
            continue
        if not (-90 <= h_lat <= 90 and -180 <= h_lon <= 180):
            continue
        distance = haversine_miles(lat, lon, h_lat, h_lon)
        if distance > radius_miles:
            continue
        name = (attrs.get("NAME") or attrs.get("ALT_NAME") or "Hospital").strip()
        status = str(attrs.get("STATUS") or "").strip().lower()
        if status and status not in {"open", "active", "operational", "in service", ""}:
            if any(term in status for term in ("closed", "inactive", "out of service", "decommissioned")):
                continue
        out.append(
            make_record(
                id=f"hifld-{attrs.get('OBJECTID_1', attrs.get('OBJECTID', name))}",
                source="HIFLD / ArcGIS Hospitals",
                name=name,
                address=(attrs.get("ADDRESS") or "").strip(),
                city=(attrs.get("CITY") or "").strip(),
                state=(attrs.get("STATE") or "").strip(),
                zip=(attrs.get("ZIP") or "").strip(),
                phone=(attrs.get("TELEPHONE") or "").strip(),
                capacity=attrs.get("BEDS"),
                category="hospital",
                type=(attrs.get("TYPE") or "Hospital").strip(),
                lat=h_lat,
                lon=h_lon,
                distance_miles=round(distance, 2),
            )
        )
    return out


def fetch_active_disasters():
    try:
        resp = requests.get(
            RELIEFWEB_URL,
            params={
                "appname": "safereach",
                "filter[field]": "status",
                "filter[value]": "current",
                "limit": 5,
                "profile": "list",
            },
            timeout=8,
        )
        resp.raise_for_status()
        return [
            {"name": d.get("fields", {}).get("name", ""), "id": d.get("id")}
            for d in resp.json().get("data", [])
        ]
    except Exception: 
        return []


def fetch_local_snapshot(lat, lon, radius_miles):
    if not os.path.exists(FALLBACK_GEOJSON):
        return []
    with open(FALLBACK_GEOJSON) as fh:
        gj = json.load(fh)
    out = []
    for feat in gj.get("features", []):
        props = feat.get("properties", {})
        coords = (feat.get("geometry") or {}).get("coordinates") or []
        if len(coords) < 2:
            continue
        f_lon, f_lat = coords[0], coords[1]
        dist = haversine_miles(lat, lon, f_lat, f_lon)
        if dist > radius_miles:
            continue
        out.append(
            make_record(
                id=props.get("id", f"local-{f_lat}-{f_lon}"),
                source="Offline snapshot",
                name=props.get("name", "Facility"),
                address=props.get("address", ""),
                city=props.get("city", ""),
                state=props.get("state", ""),
                zip=props.get("zip", ""),
                phone=props.get("phone", ""),
                capacity=props.get("capacity"),
                category=props.get("category", "shelter"),
                type=props.get("type", "Shelter"),
                lat=f_lat,
                lon=f_lon,
                distance_miles=round(dist, 2),
            )
        )
    return out


def dedupe(records, threshold_miles=0.06):
    kept = []
    for record in records:
        duplicate = any(
            record.get("category") == prior.get("category")
            and haversine_miles(record["lat"], record["lon"], prior["lat"], prior["lon"])
            < threshold_miles
            for prior in kept
        )
        if not duplicate:
            kept.append(record)
    return kept


def gather_facilities(lat, lon, radius, state_hint=None):
    records, used, failed = [], [], []

    def attempt(label, fn, *args):
        start = time.time()
        try:
            got = fn(*args)
            used.append(
                {"source": label, "count": len(got), "ms": int((time.time() - start) * 1000)}
            )
            records.extend(got)
            return True
        except Exception as exc: 
            failed.append({"source": label, "error": str(exc)[:160]})
            print(f"[{label}] failed: {exc}")
            return False

    fema_ok = attempt("FEMA / Red Cross", fetch_fema, lat, lon, radius)
    hifld_ok = attempt("HIFLD / ArcGIS Hospitals", fetch_hifld_hospitals, lat, lon, radius)
    osm_ok = attempt("OpenStreetMap", fetch_osm, lat, lon, radius)

    if not any(r["category"] == "hospital" for r in records) and state_hint:
        attempt("HHS / CMS", fetch_cms_hospitals, lat, lon, radius, state_hint)

    if not records or (not fema_ok and not osm_ok):
        attempt("Offline snapshot", fetch_local_snapshot, lat, lon, radius)

    records = dedupe(records)
    records.sort(key=lambda r: r["distance_miles"])
    return records, used, failed


def fetch_route(from_lat, from_lon, to_lat, to_lon, profile="driving"):
    url = OSRM_URL.format(profile=profile, coords=f"{from_lon},{from_lat};{to_lon},{to_lat}")
    try:
        resp = requests.get(
            url,
            params={"overview": "full", "geometries": "geojson", "steps": "true"},
            headers={"User-Agent": OSRM_USER_AGENT},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:  
        print(f"[osrm] {exc}")
        return None
    if data.get("code") != "Ok" or not data.get("routes"):
        return None

    route = data["routes"][0]
    steps = []
    for leg in route.get("legs", []):
        for step in leg.get("steps", []):
            m = step.get("maneuver", {})
            text = (m.get("type") or "continue").replace("_", " ")
            if m.get("modifier"):
                text += f" {m['modifier']}"
            if step.get("name"):
                text += f" on {step['name']}"
            steps.append(
                {
                    "instruction": text,
                    "distance_miles": round(step.get("distance", 0) * MILES_PER_METER, 2),
                }
            )
    return {
        "distance_miles": round(route.get("distance", 0) * MILES_PER_METER, 2),
        "duration_minutes": round(route.get("duration", 0) / 60, 1),
        "geometry": route.get("geometry"),
        "steps": steps,
    }


@app.route("/api/geocode-zip")
def api_geocode_zip():
    zip_code = request.args.get("zip", "").strip()
    if not (zip_code.isdigit() and len(zip_code) == 5):
        return jsonify({"error": "invalid_zip"}), 400
    try:
        resp = requests.get(ZIPPOPOTAM_URL.format(zip_code=zip_code), timeout=10)
    except Exception: 
        return jsonify({"error": "lookup_unreachable"}), 502
    if resp.status_code == 404:
        return jsonify({"error": "zip_not_found"}), 404
    if not resp.ok:
        return jsonify({"error": "lookup_failed"}), 502
    place = (resp.json().get("places") or [{}])[0]
    try:
        return jsonify(
            {
                "zip": zip_code,
                "lat": float(place["latitude"]),
                "lon": float(place["longitude"]),
                "city": place.get("place name", ""),
                "state": place.get("state abbreviation", ""),
            }
        )
    except (KeyError, ValueError):
        return jsonify({"error": "lookup_failed"}), 502


@app.route("/api/route")
def api_route():
    route = fetch_route(
        float(request.args["from_lat"]),
        float(request.args["from_lon"]),
        float(request.args["to_lat"]),
        float(request.args["to_lon"]),
    )
    if route is None:
        return jsonify({"error": "no_route"}), 502
    return jsonify(route)


@app.route("/api/bundle")
def api_bundle():
    lat = float(request.args["lat"])
    lon = float(request.args["lon"])
    radius = float(request.args.get("radius", 50))
    limit = int(request.args.get("limit", 15))
    state_hint = request.args.get("state")

    facilities, used, failed = gather_facilities(lat, lon, radius, state_hint)

    for i, f in enumerate(facilities):
        if i < limit:
            f["route"] = fetch_route(lat, lon, f["lat"], f["lon"])
            time.sleep(OSRM_MIN_INTERVAL_SEC)
        else:
            f["route"] = None

    return jsonify(
        {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "origin": {"lat": lat, "lon": lon},
            "radius_miles": radius,
            "sources_used": used,
            "sources_failed": failed,
            "active_disasters": fetch_active_disasters(),
            "facilities": facilities,
        }
    )


def has_certs():
    certs = glob.glob(os.path.join(HERE, "*.pem"))
    key = next((f for f in certs if f.endswith("-key.pem")), None)
    cert = next((f for f in certs if f != key), None)
    return (cert, key) if (cert and key) else None


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


if __name__ == "__main__":
    pair = has_certs()
    if pair:
        cert, key = pair
        print(f"HTTPS  https://localhost:5001   cert={os.path.basename(cert)}")
        app.run(host="0.0.0.0", port=5001, debug=True, ssl_context=(cert, key))
    else:
        print("HTTP   http://localhost:5001   (no certs - install/offline need HTTPS)")
        app.run(host="0.0.0.0", port=5001, debug=True)
