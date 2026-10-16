(function () {
"use strict";

const { t, setLang, getLang, detectLang, translateDOM, LANGS } = window.I18N;
const STALE_MS = 6 * 60 * 60 * 1000;

const state = {
  facilities: [],
  origin: null,
  updatedAt: null,
  sources: [],
  failed: [],
  filter: { shelter: true, hospital: true },
  busy: false
};

const $ = (id) => document.getElementById(id);
const el = {
  sync: $("sync"),
  syncText: $("sync-text"),
  feedback: $("feedback"),
  results: $("results"),
  empty: $("empty"),
  provenance: $("provenance"),
  radius: $("radius"),
  nearMe: $("near-me"),
  byZip: $("by-zip"),
  refresh: $("refresh"),
  filters: $("filters"),
  loadingIndicator: $("loading-indicator"),
  loadingText: $("loading-text"),
  pages: document.querySelectorAll("[data-page-panel]"),
  nav: document.querySelector(".app-nav")
};

let map, originMarker, pins, routeLine;


function fmtTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString(getLang(), {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
  });
}

function setSync(stateName, text) {
  el.sync.dataset.state = stateName;
  el.syncText.textContent = text;
}

function refreshSyncLabel() {
  if (state.busy) return setSync("syncing", t("status.syncing"));
  if (!navigator.onLine) return setSync("offline", t("status.offline"));
  if (state.updatedAt) {
    return setSync("online", t("status.updated", { time: fmtTime(state.updatedAt) }));
  }
  setSync("online", t("status.never"));
}

function say(msg) {
  el.feedback.textContent = msg || "";
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[ch]);
}

function normalizeFacility(f) {
  const typeAndName = `${f.type || ""} ${f.name || ""}`.toLowerCase();
  const isHospital = f.category === "hospital" ||
    /\b(hospital|medical center|medical centre|health center|clinic)\b/.test(typeAndName);
  const category = isHospital ? "hospital" : "shelter";
  return {
    ...f,
    category,
    id: String(f.id || `${category}-${f.lat}-${f.lon}-${f.name || "location"}`),
    name: String(f.name || (category === "hospital" ? "Hospital" : "Emergency shelter")),
    source: String(f.source || "Imported emergency data"),
    type: category === "hospital" ? "Hospital" : (/\bbunker\b/i.test(String(f.type || "")) ? "Emergency shelter" : String(f.type || "Emergency shelter")),
    lat: Number(f.lat),
    lon: Number(f.lon)
  };
}

function normalizeFacilities(records) {
  return (Array.isArray(records) ? records : [])
    .filter((f) => f && Number.isFinite(Number(f.lat)) && Number.isFinite(Number(f.lon)) &&
      Number(f.lat) >= -90 && Number(f.lat) <= 90 && Number(f.lon) >= -180 && Number(f.lon) <= 180)
    .map(normalizeFacility);
}

function setPage(page) {
  const allowed = ["find", "locations", "settings"];
  const active = allowed.includes(page) ? page : "find";
  el.pages.forEach((panel) => { panel.hidden = panel.dataset.pagePanel !== active; });
  el.nav.querySelectorAll("[data-page]").forEach((button) => {
    button.setAttribute("aria-current", String(button.dataset.page === active));
  });
  localStorage.setItem("active-page", active);
  if (active === "find" && map) setTimeout(() => map.invalidateSize(), 80);
  if (active === "locations") renderList();
  if (active === "settings") renderSettingsMeta();
}


async function requestBundle(origin, radius) {
  const q = new URLSearchParams({
    lat: origin.lat, lon: origin.lon, radius, limit: 15
  });
  if (origin.state) q.set("state", origin.state);
  const resp = await fetch(`/api/bundle?${q}`);
  if (!resp.ok) throw new Error("bundle_failed");
  return resp.json();
}

async function load(origin) {
  const radius = Number(el.radius.value) || 50;
  state.busy = true;
  state.origin = origin;
  refreshSyncLabel();
  setBusy(true);
  say(t("search.working", { n: radius }));

  try {
    const data = await requestBundle(origin, radius);
    state.facilities = normalizeFacilities(data.facilities);
    state.updatedAt = data.generated_at;
    state.sources = data.sources_used || [];
    state.failed = data.sources_failed || [];

    await Store.putAll(state.facilities);
    await Store.setMeta("origin", origin);
    await Store.setMeta("updatedAt", data.generated_at);
    await Store.setMeta("radius", radius);
    await Store.setMeta("sources", state.sources);
    await Store.setMeta("failed", state.failed);

    say(t("search.found", { n: data.facilities.length }));
    render();
  } catch (err) {
    const saved = normalizeFacilities(await Store.getAll());
    if (saved.length) {
      state.facilities = saved;
      state.updatedAt = await Store.getMeta("updatedAt");
      await Store.putAll(state.facilities);
      render();
    }
    say(navigator.onLine ? t("search.failed") : t("status.offline"));
  } finally {
    state.busy = false;
    state.loadingPhase = null;
    setBusy(false);
    refreshSyncLabel();
  }
}

function setBusy(busy) {
  el.nearMe.disabled = busy;
  el.nearMe.setAttribute("aria-busy", String(busy));
  const buttonSpinner = el.nearMe.querySelector(".button-spinner");
  if (buttonSpinner) buttonSpinner.hidden = !busy;
  el.byZip.disabled = busy;
  el.refresh.disabled = busy || !state.origin;
  if (el.loadingIndicator) el.loadingIndicator.hidden = !busy;
  if (el.loadingText) {
    const phase = state.loadingPhase === "locating" ? "search.locating" : "search.loading";
    el.loadingText.textContent = t(phase);
  }
  if (!busy && el.results) renderList();
}

function locate() {
  return new Promise((resolve, reject) => {
    if (!window.isSecureContext && !["localhost", "127.0.0.1"].includes(location.hostname)) {
      return reject(Object.assign(new Error("secure_context_required"), { code: "secure_context_required" }));
    }
    if (!navigator.geolocation) return reject(Object.assign(new Error("unsupported"), { code: "unsupported" }));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      reject,
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 120000 }
    );
  });
}

function promptZipFallback() {
  const input = prompt(t("search.zip_prompt"));
  if (input === null || !input.trim()) return;
  const zip = input.trim();
  if (!/^\d{5}$/.test(zip)) return say(t("search.zip_invalid"));
  return searchByZip(zip);
}

async function searchByZip(zip) {
  try {
    const resp = await fetch(`/api/geocode-zip?zip=${encodeURIComponent(zip)}`);
    const data = await resp.json();
    if (!resp.ok) return say(data.error === "zip_not_found" ? t("search.zip_notfound") : t("search.zip_failed"));
    say(t("search.located", { city: data.city, state: data.state }));
    await load({ lat: data.lat, lon: data.lon, state: data.state });
  } catch {
    say(t("search.zip_failed"));
  }
}

function locationErrorMessage(err) {
  if (err?.code === "secure_context_required") return t("search.location_secure");
  if (err?.code === "unsupported") return t("search.location_unsupported");
  if (err?.code === 1) return t("search.location_denied");
  if (err?.code === 2) return t("search.location_unavailable");
  if (err?.code === 3) return t("search.location_timeout");
  return t("search.location_unavailable");
}


function visible() {
  return state.facilities.filter((f) => state.filter[f.category] !== false &&
    (f.category === "shelter" || f.category === "hospital"));
}

function capText(f) {
  if (f.capacity == null) return t("cap.unknown");
  return t(`cap.${f.capacity_level}`, { n: f.capacity.toLocaleString(getLang()) });
}

function render() {
  renderCounts();
  renderList();
  renderMap();
  renderProvenance();
  renderSettingsMeta();
}

function renderCounts() {
  el.filters.querySelectorAll(".chip").forEach((chip) => {
    const cat = chip.dataset.cat;
    const n = state.facilities.filter((f) => f.category === cat).length;
    chip.querySelector(".count").textContent = n ? n : "";
    chip.setAttribute("aria-pressed", String(state.filter[cat] !== false));
  });
}

function renderList() {
  const list = visible();
  el.results.innerHTML = "";

  if (!list.length) {
    el.empty.hidden = state.busy;
    el.empty.textContent = state.facilities.length ? t("empty.filtered") : t("empty.none");
    return;
  }
  el.empty.hidden = true;

  const frag = document.createDocumentFragment();
  list.forEach((f) => frag.appendChild(facilityRow(f)));
  el.results.appendChild(frag);
}

function facilityRow(f) {
  const row = document.createElement("article");
  row.className = "facility";
  const capLevel = ["ample", "limited", "critical"].includes(f.capacity_level)
    ? f.capacity_level : "unknown";
  row.dataset.cap = capLevel;
  row.id = `map-location-${encodeURIComponent(f.id)}`;

  const where = [f.address, f.city, f.state, f.zip].filter(Boolean).join(", ");
  const distance = f.route
    ? t("card.drive", { miles: f.route.distance_miles, min: Math.round(f.route.duration_minutes) })
    : t("card.straight", { miles: f.distance_miles });

  row.innerHTML = `
    <div class="rail"></div>
    <div>
      <h3></h3>
      <p class="line"></p>
      <p class="line num"></p>
      <div class="tags">
        <span class="pill" data-cap="${capLevel}"></span>
        ${f.type ? `<span class="pill">${escapeHTML(f.type)}</span>` : ""}
        ${f.pet_friendly ? `<span class="pill">${t("card.pets")}</span>` : ""}
      </div>
      <p class="meta"></p>
      <div class="row-actions">
        <button class="show-map"></button>
        <button class="route-btn"></button>
        <button class="share-route-btn"></button>
      </div>
      <ol class="steps" hidden></ol>
    </div>`;

  row.querySelector("h3").textContent = f.name;
  row.querySelector(".line").textContent = [where, f.phone].filter(Boolean).join(" · ");
  row.querySelector(".line.num").textContent = distance;
  row.querySelector(".pill").textContent = capText(f);
  row.querySelector(".meta").textContent = t("card.source", { name: f.source });
  row.querySelector(".show-map").textContent = t("card.show_map");
  const shareRouteBtn = row.querySelector(".share-route-btn");
  shareRouteBtn.textContent = t("card.share_route_map");
  shareRouteBtn.addEventListener("click", async () => {
    shareRouteBtn.disabled = true;
    const previousLabel = shareRouteBtn.textContent;
    shareRouteBtn.textContent = t("route.preparing");
    try {
      await openRouteImageShare(f);
    } catch (err) {
      say(err && err.message ? err.message : t("route.image_failed"));
    } finally {
      shareRouteBtn.disabled = false;
      shareRouteBtn.textContent = previousLabel;
    }
  });

  const routeBtn = row.querySelector(".route-btn");
  const steps = row.querySelector(".steps");

  row.querySelector(".show-map").addEventListener("click", () => focusFacility(f));

  if (f.route) {
    routeBtn.textContent = t("card.directions");
    routeBtn.addEventListener("click", () => {
      const open = steps.hidden;
      if (open && !steps.dataset.filled) {
        steps.dataset.filled = "1";
        f.route.steps.forEach((s) => {
          const li = document.createElement("li");
          li.innerHTML = `${escapeHTML(s.instruction)} <span class="num">${escapeHTML(s.distance_miles)} mi</span>`;
          steps.appendChild(li);
        });
      }
      steps.hidden = !open;
      routeBtn.textContent = open ? t("card.hide_directions") : t("card.directions");
      if (open) drawRoute(f);
    });
  } else {
    routeBtn.textContent = t("card.get_route");
    routeBtn.addEventListener("click", async () => {
      routeBtn.disabled = true;
      routeBtn.textContent = t("card.saving");
      try {
        const q = new URLSearchParams({
          from_lat: state.origin.lat, from_lon: state.origin.lon,
          to_lat: f.lat, to_lon: f.lon
        });
        const resp = await fetch(`/api/route?${q}`);
        if (!resp.ok) throw new Error("route");
        f.route = await resp.json();
        await Store.putOne(f);
        renderList();
      } catch {
        routeBtn.disabled = false;
        routeBtn.textContent = t("card.route_failed");
      }
    });
  }

  return row;
}

function renderProvenance() {
  const bits = [];
  if (state.sources.length) {
    bits.push(t("status.sources", { list: state.sources.map((s) => s.source).join(", ") }));
  }
  if (state.failed.length) {
    const key = state.failed.length === 1 ? "status.degraded" : "status.degraded_plural";
    bits.push(t(key, { n: state.failed.length }));
  }
  if (state.updatedAt) bits.push(t("status.updated", { time: fmtTime(state.updatedAt) }));
  el.provenance.textContent = bits.join(" · ");
}


function initMap() {
  map = L.map("map", { zoomControl: true }).setView([39.5, -98.35], 4);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap"
  }).addTo(map);
  pins = L.layerGroup().addTo(map);
  routeLine = L.layerGroup().addTo(map);
}

function capColor(level) {
  const name = ["ample", "limited", "critical"].includes(level) ? level : "unknown";
  return getComputedStyle(document.documentElement)
    .getPropertyValue(`--cap-${name}`)
    .trim();
}

function renderMap() {
  pins.clearLayers();
  const list = visible();

  if (state.origin) {
    if (originMarker) map.removeLayer(originMarker);
    const brandAccent = getComputedStyle(document.documentElement)
      .getPropertyValue("--accent").trim() || "#f15b32";
    originMarker = L.circleMarker([state.origin.lat, state.origin.lon], {
      radius: 6, weight: 3, color: brandAccent, fillColor: brandAccent, fillOpacity: 1
    }).addTo(map);
    map.setView([state.origin.lat, state.origin.lon], 9);
  }

  list.forEach((f) => {
    const isHospital = f.category === "hospital";
    const popupId = `map-location-${encodeURIComponent(f.id)}`;
    const popup = `<strong>${escapeHTML(f.name)}</strong><br>${escapeHTML(isHospital ? t("filter.hospital") : t("filter.shelter"))}<br>${escapeHTML(capText(f))}<br><a href="#${popupId}" class="map-location-link" data-location-id="${escapeHTML(f.id)}">View in Locations →</a>`;
    L.circleMarker([f.lat, f.lon], {
      radius: isHospital ? 7 : 5,
      weight: isHospital ? 2.5 : 1.5,
      dashArray: isHospital ? "3 2" : null,
      color: capColor(f.capacity_level),
      fillColor: capColor(f.capacity_level),
      fillOpacity: 0.75
    })
      .bindPopup(popup)
      .addTo(pins);
  });
}

function focusFacility(f) {
  setPage("find");
  setTimeout(() => {
    map.invalidateSize();
    map.setView([f.lat, f.lon], 14);
    drawRoute(f);
  }, 100);
}

function drawRoute(f) {
  routeLine.clearLayers();
  if (!f.route || !f.route.geometry) return;
  const pts = f.route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
  const line = L.polyline(pts, {
    color: getComputedStyle(document.documentElement).getPropertyValue("--route").trim(),
    weight: 3,
    opacity: 0.85
  }).addTo(routeLine);
  map.fitBounds(line.getBounds(), { padding: [30, 30] });
}

let routeImageBlob = null;
let routeImageFacility = null;
let routeImageObjectUrl = null;

function routeWorldPoint(lon, lat, zoom) {
  const size = 256 * (2 ** zoom);
  const safeLat = Math.max(-85.05112878, Math.min(85.05112878, Number(lat)));
  const sin = Math.sin(safeLat * Math.PI / 180);
  return {
    x: (Number(lon) + 180) / 360 * size,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size
  };
}

function drawFallbackMap(ctx, rect) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  ctx.fillStyle = "#edf1e9";
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.fillStyle = "#dcebd6";
  [[0.08,0.10,0.19,0.17],[0.68,0.12,0.20,0.12],[0.15,0.68,0.22,0.18],[0.72,0.66,0.18,0.20]].forEach(([x,y,w,h]) => {
    ctx.fillRect(rect.x + x*rect.w, rect.y + y*rect.h, w*rect.w, h*rect.h);
  });
  ctx.lineCap = "round";
  for (let i = -2; i < 9; i++) {
    ctx.beginPath(); ctx.lineWidth = i % 3 === 0 ? 5 : 2;
    ctx.strokeStyle = i % 3 === 0 ? "#ffffff" : "#d6dcd8";
    ctx.moveTo(rect.x + i*190, rect.y - 30);
    ctx.bezierCurveTo(rect.x + i*190 + 90, rect.y + rect.h*0.25, rect.x + i*190 - 70, rect.y + rect.h*0.65, rect.x + i*190 + 30, rect.y + rect.h + 30);
    ctx.stroke();
  }
  for (let i = -1; i < 7; i++) {
    ctx.beginPath(); ctx.lineWidth = i % 2 ? 2 : 4;
    ctx.strokeStyle = "#ffffff";
    ctx.moveTo(rect.x - 20, rect.y + i*150);
    ctx.bezierCurveTo(rect.x + rect.w*0.25, rect.y + i*150 - 35, rect.x + rect.w*0.65, rect.y + i*150 + 45, rect.x + rect.w + 20, rect.y + i*150 - 10);
    ctx.stroke();
  }
  ctx.restore();
}

function drawOsmTiles(ctx, rect, zoom, centerWorld) {
  return new Promise((resolve) => {
    const tileCount = 2 ** zoom;
    const left = centerWorld.x - rect.w / 2;
    const top = centerWorld.y - rect.h / 2;
    const firstX = Math.floor(left / 256);
    const lastX = Math.floor((left + rect.w) / 256);
    const firstY = Math.floor(top / 256);
    const lastY = Math.floor((top + rect.h) / 256);
    const jobs = [];
    for (let ty = firstY; ty <= lastY; ty++) {
      if (ty < 0 || ty >= tileCount) continue;
      for (let tx = firstX; tx <= lastX; tx++) {
        if (jobs.length >= 28) continue;
        const wrappedX = ((tx % tileCount) + tileCount) % tileCount;
        jobs.push(new Promise((finish) => {
          const img = new Image();
          let done = false;
          const settle = (ok) => {
            if (done) return;
            done = true;
            if (ok) {
              try {
                ctx.save();
                ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.w, rect.h); ctx.clip();
                const dx = rect.x + tx * 256 - left;
                const dy = rect.y + ty * 256 - top;
                ctx.drawImage(img, dx, dy, 256, 256);
                ctx.restore();
              } catch { try { ctx.restore(); } catch {} /* Keep the route diagram if a tile can't be drawn. */ }
            }
            finish(ok);
          };
          const timer = setTimeout(() => settle(false), 1800);
          img.onload = () => { clearTimeout(timer); settle(true); };
          img.onerror = () => { clearTimeout(timer); settle(false); };
          img.crossOrigin = "anonymous";
          img.referrerPolicy = "strict-origin-when-cross-origin";
          img.src = `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${ty}.png`;
        }));
      }
    }
    Promise.all(jobs).then((results) => resolve(results.some(Boolean))).catch(() => resolve(false));
  });
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawMapPin(ctx, x, y, color, label, align = "left") {
  ctx.save();
  ctx.shadowColor = "rgba(15,23,42,0.22)";
  ctx.shadowBlur = 8;
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 4; ctx.strokeStyle = "#ffffff";
  ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
  ctx.font = "bold 20px system-ui, -apple-system, sans-serif";
  const textWidth = ctx.measureText(label).width;
  const pillW = textWidth + 26;
  const px = align === "right" ? x - pillW - 22 : x + 22;
  const py = y - 18;
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  roundRect(ctx, px, py, pillW, 36, 12); ctx.fill();
  ctx.strokeStyle = "rgba(15,23,42,0.12)"; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = "#17202c"; ctx.fillText(label, px + 13, py + 24);
  ctx.restore();
}

async function createRouteMapImage(f) {
  const coordinates = f.route?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) throw new Error(t("route.need_route"));
  const routeCoords = coordinates.filter((point) => Array.isArray(point) && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])));
  if (routeCoords.length < 2) throw new Error(t("route.image_failed"));

  const origin = state.origin && Number.isFinite(Number(state.origin.lat)) && Number.isFinite(Number(state.origin.lon))
    ? [Number(state.origin.lon), Number(state.origin.lat)] : routeCoords[0];
  const destination = [Number(f.lon), Number(f.lat)];
  const boundsCoords = [origin, destination, ...routeCoords];
  const allSteps = Array.isArray(f.route?.steps) ? f.route.steps : [];
  const shownSteps = allSteps.slice(0, 12);
  const remainingSteps = Math.max(0, allSteps.length - shownSteps.length);
  const stepLineHeight = 34;
  const stepsStartY = 1150;
  const footerY = stepsStartY + shownSteps.length * stepLineHeight + (remainingSteps ? 28 : 0) + 30;
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = footerY + 34;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(t("route.image_failed"));

  ctx.fillStyle = "#f7f8fa"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#111827";
  ctx.font = "bold 38px system-ui, -apple-system, sans-serif";
  ctx.fillText(t("route.image_title"), 48, 65);
  ctx.fillStyle = "#536170"; ctx.font = "24px system-ui, -apple-system, sans-serif";
  ctx.fillText(String(f.name || t("filter.shelter")).slice(0, 55), 48, 105);

  const rect = { x: 40, y: 150, w: 1120, h: 760 };
  drawFallbackMap(ctx, rect);

  let zoom = 12;
  let chosen = null;
  for (let z = 17; z >= 3; z--) {
    const projected = boundsCoords.map(([lon, lat]) => routeWorldPoint(lon, lat, z));
    const xs = projected.map((p) => p.x), ys = projected.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    if ((maxX - minX) <= rect.w * 0.70 && (maxY - minY) <= rect.h * 0.70) {
      zoom = z;
      chosen = { projected, minX, maxX, minY, maxY };
      break;
    }
  }
  if (!chosen) {
    const projected = boundsCoords.map(([lon, lat]) => routeWorldPoint(lon, lat, zoom));
    const xs = projected.map((p) => p.x), ys = projected.map((p) => p.y);
    chosen = { projected, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }
  const center = { x: (chosen.minX + chosen.maxX) / 2, y: (chosen.minY + chosen.maxY) / 2 };
  await drawOsmTiles(ctx, rect, zoom, center);

  ctx.save(); ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.w, rect.h); ctx.clip();
  const left = center.x - rect.w / 2, top = center.y - rect.h / 2;
  const toCanvas = ([lon, lat]) => {
    const p = routeWorldPoint(lon, lat, zoom);
    return [rect.x + p.x - left, rect.y + p.y - top];
  };
  const pathPoints = routeCoords.map(toCanvas);
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.beginPath(); pathPoints.forEach(([x,y], index) => index ? ctx.lineTo(x,y) : ctx.moveTo(x,y));
  ctx.strokeStyle = "rgba(255,255,255,0.95)"; ctx.lineWidth = 14; ctx.stroke();
  ctx.beginPath(); pathPoints.forEach(([x,y], index) => index ? ctx.lineTo(x,y) : ctx.moveTo(x,y));
  ctx.strokeStyle = "#2463eb"; ctx.lineWidth = 8; ctx.stroke();
  const startXY = toCanvas(origin);
  const destXY = toCanvas(destination);
  drawMapPin(ctx, startXY[0], startXY[1], "#167b55", t("route.start"), "left");
  drawMapPin(ctx, destXY[0], destXY[1], "#c0392b", t("route.destination"), "right");
  ctx.restore();

  ctx.fillStyle = "#ffffff"; roundRect(ctx, 40, 934, 1120, 126, 18); ctx.fill();
  ctx.strokeStyle = "#e2e7ed"; ctx.lineWidth = 2; ctx.stroke();
  const distance = Number(f.route.distance_miles);
  const minutes = Number(f.route.duration_minutes);
  ctx.fillStyle = "#111827"; ctx.font = "bold 29px system-ui, -apple-system, sans-serif";
  const routeSummary = Number.isFinite(distance) && Number.isFinite(minutes)
    ? `${distance.toFixed(1)} mi  ·  ${Math.round(minutes)} min drive` : t("route.summary");
  ctx.fillText(routeSummary, 64, 979);
  ctx.fillStyle = "#536170"; ctx.font = "21px system-ui, -apple-system, sans-serif";
  const address = [f.address, f.city, f.state, f.zip].filter(Boolean).join(", ") || `${Number(f.lat).toFixed(5)}, ${Number(f.lon).toFixed(5)}`;
  ctx.fillText(address.slice(0, 92), 64, 1017);
  ctx.fillStyle = "#ffffff"; roundRect(ctx, 40, 1075, 1120, footerY - 1088, 18); ctx.fill();
  ctx.strokeStyle = "#e2e7ed"; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = "#111827"; ctx.font = "bold 25px system-ui, -apple-system, sans-serif";
  ctx.fillText(t("route.steps_heading"), 64, 1118);
  if (!shownSteps.length) {
    ctx.fillStyle = "#536170"; ctx.font = "19px system-ui, -apple-system, sans-serif";
    ctx.fillText(t("route.no_steps"), 64, 1150);
  } else {
    shownSteps.forEach((step, index) => {
      const y = stepsStartY + index * stepLineHeight;
      ctx.fillStyle = "#e9542b";
      ctx.beginPath(); ctx.arc(76, y - 6, 12, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#ffffff"; ctx.font = "bold 14px system-ui, -apple-system, sans-serif";
      ctx.textAlign = "center"; ctx.fillText(String(index + 1), 76, y - 1); ctx.textAlign = "left";
      ctx.fillStyle = "#283548"; ctx.font = "18px system-ui, -apple-system, sans-serif";
      const instruction = String(step.instruction || t("route.continue"));
      ctx.fillText(instruction, 100, y, 850);
      const distanceText = Number.isFinite(Number(step.distance_miles))
        ? `${Number(step.distance_miles).toFixed(2)} mi` : "";
      ctx.fillStyle = "#657182"; ctx.font = "17px system-ui, -apple-system, sans-serif";
      ctx.textAlign = "right"; ctx.fillText(distanceText, 1126, y); ctx.textAlign = "left";
    });
    if (remainingSteps) {
      const y = stepsStartY + shownSteps.length * stepLineHeight;
      ctx.fillStyle = "#657182"; ctx.font = "italic 17px system-ui, -apple-system, sans-serif";
      ctx.fillText(t("route.more_steps", { n: remainingSteps }), 100, y);
    }
  }
  ctx.fillStyle = "#657182"; ctx.font = "16px system-ui, -apple-system, sans-serif";
  ctx.fillText("Map data © OpenStreetMap contributors", 48, footerY);
  ctx.textAlign = "right"; ctx.fillText("SafeReach", 1152, footerY); ctx.textAlign = "left";

  return await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error(t("route.image_failed"))), "image/png");
  });
}

async function ensureRouteForSharing(f) {
  if (Array.isArray(f.route?.geometry?.coordinates) && f.route.geometry.coordinates.length >= 2) return;
  if (!state.origin) throw new Error(t("route.need_origin"));
  const q = new URLSearchParams({
    from_lat: state.origin.lat, from_lon: state.origin.lon,
    to_lat: f.lat, to_lon: f.lon
  });
  const resp = await fetch(`/api/route?${q}`);
  if (!resp.ok) throw new Error(t("route.need_route"));
  f.route = await resp.json();
  if (!Array.isArray(f.route?.geometry?.coordinates) || f.route.geometry.coordinates.length < 2) {
    throw new Error(t("route.need_route"));
  }
  await Store.putOne(f);
}

async function openRouteImageShare(f) {
  say(t("route.preparing"));
  await ensureRouteForSharing(f);
  routeImageBlob = await createRouteMapImage(f);
  routeImageFacility = f;
  if (routeImageObjectUrl) URL.revokeObjectURL(routeImageObjectUrl);
  routeImageObjectUrl = URL.createObjectURL(routeImageBlob);
  $("route-image-preview").src = routeImageObjectUrl;
  $("route-image-caption").textContent = t("route.share_hint");
  $("route-image-sheet").hidden = false;
  say("");
}

function routeImageFilename() {
  const safeName = String(routeImageFacility?.name || "shelter-route")
    .normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 52) || "shelter-route";
  return `${safeName}-route-map.png`;
}

function downloadRouteImage() {
  if (!routeImageBlob) return;
  const url = URL.createObjectURL(routeImageBlob);
  const a = document.createElement("a");
  a.href = url; a.download = routeImageFilename();
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

$("route-share-image").addEventListener("click", async () => {
  if (!routeImageBlob) return;
  if (typeof File !== "undefined" && typeof navigator.share === "function") {
    const file = new File([routeImageBlob], routeImageFilename(), { type: "image/png" });
    try {
      if (typeof navigator.canShare !== "function" || navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: routeImageFacility?.name || "SafeReach route map" });
        return;
      }
    } catch (err) {
      if (err?.name === "AbortError") return;
    }
  }
  downloadRouteImage();
  $("route-image-caption").textContent = t("route.share_fallback");
});

$("route-download-image").addEventListener("click", downloadRouteImage);
$("route-image-close").addEventListener("click", () => {
  $("route-image-sheet").hidden = true;
  if (routeImageObjectUrl) URL.revokeObjectURL(routeImageObjectUrl);
  routeImageObjectUrl = null;
});
$("route-image-sheet").addEventListener("click", (event) => {
  if (event.target === $("route-image-sheet")) $("route-image-close").click();
});


el.nearMe.addEventListener("click", async () => {
  if (state.busy) return;
  state.busy = true;
  state.loadingPhase = "locating";
  setBusy(true);
  refreshSyncLabel();
  say(t("search.locating"));
  try {
    const origin = await locate();
    state.loadingPhase = "loading";
    await load(origin);
  } catch (err) {
    state.busy = false;
    state.loadingPhase = null;
    setBusy(false);
    refreshSyncLabel();
    if (err?.code === "secure_context_required" || err?.code === "unsupported") {
      say("GPS is blocked by this browser here. Enter a ZIP code to find nearby locations instead.");
      promptZipFallback();
      return;
    }
    if (err?.code === 1) {
      say(locationErrorMessage(err) + " You can also search by ZIP code.");
      return;
    }
    say(locationErrorMessage(err));
  }
});

el.byZip.addEventListener("click", async () => {
  const input = prompt(t("search.zip_prompt"));
  if (input === null || !input.trim()) return;
  const zip = input.trim();
  if (!/^\d{5}$/.test(zip)) return say(t("search.zip_invalid"));
  await searchByZip(zip);
});

el.refresh.addEventListener("click", () => state.origin && load(state.origin));

el.filters.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const cat = chip.dataset.cat;
  state.filter[cat] = !state.filter[cat];
  chip.setAttribute("aria-pressed", String(state.filter[cat]));
  renderCounts();
  renderList();
  renderMap();
});

el.radius.addEventListener("change", () => {
  const v = Number(el.radius.value);
  if (v < 5) el.radius.value = 5;
  if (v > 200) el.radius.value = 200;
});

window.addEventListener("online", refreshSyncLabel);
window.addEventListener("offline", refreshSyncLabel);


function applyTheme(choice) {
  localStorage.setItem("theme", choice);
  const dark =
    choice === "dark" ||
    (choice === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document
    .querySelector('meta[name="theme-color"]')
    .setAttribute("content", dark ? "#061326" : "#f6f1ea");
}

$("theme-picker").value = localStorage.getItem("theme") || "dark";
$("theme-picker").addEventListener("change", (e) => {
  applyTheme(e.target.value);
  if (map) renderMap();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (($("theme-picker").value || "system") === "system") applyTheme("system");
});

function initLanguage() {
  const picker = $("lang-picker");
  LANGS.forEach(({ code, label }) => {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = label;
    picker.appendChild(opt);
  });
  setLang(detectLang());
  picker.value = getLang();
  picker.addEventListener("change", (e) => {
    setLang(e.target.value);
    translateDOM();
    refreshSyncLabel();
    render();
  });
  translateDOM();
}


el.nav.addEventListener("click", (event) => {
  const button = event.target.closest("[data-page]");
  if (button) setPage(button.dataset.page);
});

document.addEventListener("click", (event) => {
  const link = event.target.closest(".map-location-link");
  if (!link) return;
  event.preventDefault();
  const id = link.dataset.locationId;
  setPage("locations");
  requestAnimationFrame(() => {
    const row = document.getElementById(`map-location-${encodeURIComponent(id)}`);
    if (!row) return;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.classList.add("location-highlight");
    setTimeout(() => row.classList.remove("location-highlight"), 2200);
  });
});

function renderSettingsMeta() {
  const node = $("settings-last-updated");
  if (!node) return;
  node.textContent = state.updatedAt
    ? t("settings.last_saved", { time: fmtTime(state.updatedAt) })
    : t("settings.no_saved");
}


async function initServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.register("service-worker.js");

  navigator.serviceWorker.addEventListener("message", async (e) => {
    if (e.data?.type === "SYNC_START") {
      state.busy = true;
      refreshSyncLabel();
    }
    if (e.data?.type === "SYNC_DONE") {
      state.busy = false;
      state.facilities = normalizeFacilities(await Store.getAll());
      await Store.putAll(state.facilities);
      state.updatedAt = await Store.getMeta("updatedAt");
      state.sources = (await Store.getMeta("sources")) || [];
      state.failed = (await Store.getMeta("failed")) || [];
      refreshSyncLabel();
      render();
    }
  });

  
  if ("periodicSync" in reg) {
    try {
      const status = await navigator.permissions.query({ name: "periodic-background-sync" });
      if (status.state === "granted") {
        await reg.periodicSync.register("refresh", { minInterval: STALE_MS });
      }
    } catch {  }
  }
}

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !navigator.onLine) return;
  const stale = !state.updatedAt || Date.now() - new Date(state.updatedAt).getTime() > STALE_MS;
  if (stale && state.origin) load(state.origin);
});


async function boot() {
  initLanguage();
  initMap();

  state.facilities = normalizeFacilities(await Store.getAll());
  await Store.putAll(state.facilities);
  state.origin = await Store.getMeta("origin");
  state.updatedAt = await Store.getMeta("updatedAt");
  state.sources = (await Store.getMeta("sources")) || [];
  state.failed = (await Store.getMeta("failed")) || [];
  const savedRadius = await Store.getMeta("radius");
  if (savedRadius) el.radius.value = savedRadius;

  setBusy(false);
  refreshSyncLabel();
  render();
  setPage(localStorage.getItem("active-page") || "find");

  initServiceWorker();
}

window.__shelter = { state, render, load };

boot();
})();
