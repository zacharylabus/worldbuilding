import maplibregl from "https://cdn.jsdelivr.net/npm/maplibre-gl@5.17.0/dist/maplibre-gl.esm.js";
import {
  TerraDraw,
  TerraDrawCircleMode,
  TerraDrawFreehandMode,
  TerraDrawLineStringMode,
  TerraDrawMarkerMode,
  TerraDrawPointMode,
  TerraDrawPolygonMode,
  TerraDrawRectangleMode,
  TerraDrawRenderMode,
  TerraDrawSelectMode
} from "https://cdn.jsdelivr.net/npm/terra-draw@1.21.2/dist/terra-draw.esm.js";
import { TerraDrawMapLibreGLAdapter } from "https://cdn.jsdelivr.net/npm/terra-draw-maplibre-gl-adapter@1.3.0/dist/terra-draw-maplibre-gl-adapter.esm.js";

// NEW libs for boolean ops + Voronoi
import pc from "https://cdn.jsdelivr.net/npm/polygon-clipping@0.15.7/+esm";
import { Delaunay } from "https://cdn.jsdelivr.net/npm/d3-delaunay@6.0.4/+esm";

const STYLE_URL = "https://tiles.openfreemap.org/styles/bright";
const KEY = "worldbuilder:snapshot:v2";

const statusText = document.getElementById("statusText");
const featCount = document.getElementById("featCount");
const modeText = document.getElementById("modeText");
const selStatus = document.getElementById("selStatus");
const propName = document.getElementById("propName");
const propType = document.getElementById("propType");
const toolbar = document.getElementById("toolbar");

const btnGeo = document.getElementById("btnGeo");
const btnPng = document.getElementById("btnPng");
const btnClear = document.getElementById("btnClear");
const btnGenLand = document.getElementById("btnGenLand");
const btnGenRegions = document.getElementById("btnGenRegions");
const btnEraseToggle = document.getElementById("btnEraseToggle");
const btnCommitLand = document.getElementById("btnCommitLand");

let selectedId = null;
let eraseActive = false;

// TerraDraw instance (created after map loads)
let draw = null;

function setStatus(s) {
  statusText.textContent = s;
}
function setModeUI(mode) {
  modeText.textContent = mode;
  [...toolbar.querySelectorAll("button")].forEach((b) => (b.dataset.active = b.dataset.mode === mode ? "true" : "false"));
}

function downloadText(filename, text, mime = "application/geo+json") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function loadSnapshot() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {
    return null;
  }
}
function saveSnapshot(snap) {
  try {
    localStorage.setItem(KEY, JSON.stringify(snap));
  } catch {}
}
function clearSnapshot() {
  try {
    localStorage.removeItem(KEY);
  } catch {}
}

function nowStamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

/* ---------------------------
   Geometry helpers (GeoJSON)
--------------------------- */

function isPolygonalFeature(f) {
  const t = f?.geometry?.type;
  return t === "Polygon" || t === "MultiPolygon";
}

function toMultiPolyCoords(feature) {
  const g = feature.geometry;
  if (g.type === "Polygon") return [g.coordinates];
  if (g.type === "MultiPolygon") return g.coordinates;
  throw new Error("Not polygonal");
}

function fromMultiPolyCoords(coords, properties) {
  if (!coords || coords.length === 0) return null;
  return {
    type: "Feature",
    properties: properties ?? {},
    geometry: coords.length === 1 ? { type: "Polygon", coordinates: coords[0] } : { type: "MultiPolygon", coordinates: coords }
  };
}

// Simple bbox for Polygon/MultiPolygon
function bboxOfMultiPoly(coords) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  for (const poly of coords) {
    for (const ring of poly) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return [minX, minY, maxX, maxY];
}

// Point in polygon (ray casting) for a ring; assumes ring is closed
function pointInRing(pt, ring) {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 0.0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// Point in Polygon with holes
function pointInPolygon(pt, polyCoords) {
  // polyCoords: [outerRing, hole1, hole2...]
  if (!pointInRing(pt, polyCoords[0])) return false;
  for (let i = 1; i < polyCoords.length; i++) {
    if (pointInRing(pt, polyCoords[i])) return false;
  }
  return true;
}

function pointInMultiPolygon(pt, multi) {
  for (const poly of multi) {
    if (pointInPolygon(pt, poly)) return true;
  }
  return false;
}

// Circle polygon (approx) in degrees — good enough for editor blobs/brush
function circlePolygonFeature(lng, lat, radiusMeters, steps = 48, props = {}) {
  const dLat = radiusMeters / 111320;
  const dLng = radiusMeters / (111320 * Math.cos((lat * Math.PI) / 180));
  const coords = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    coords.push([lng + Math.cos(a) * dLng, lat + Math.sin(a) * dLat]);
  }
  return {
    type: "Feature",
    properties: props,
    geometry: { type: "Polygon", coordinates: [coords] }
  };
}

/* ---------------------------
   Snapshot helpers
--------------------------- */

function getAllFeatures() {
  const snap = draw.getSnapshot();
  return snap?.store?.features ?? [];
}

function setAllFeatures(features) {
  const snap = draw.getSnapshot();
  const next = { ...snap, store: { ...(snap.store || {}), features } };
  draw.setSnapshot(next);
  saveSnapshot(next);
  refreshCounts();
}

function refreshCounts() {
  const snap = draw?.getSnapshot?.();
  const features = snap?.store?.features ?? [];
  featCount.textContent = String(features.length);
  return { snap, features };
}

function findLandFeature(features) {
  return features.find((f) => f?.properties?.layer === "land") || null;
}

function removeByLayer(features, layerName) {
  return features.filter((f) => f?.properties?.layer !== layerName);
}

function pastel(i) {
  // stable pastel-ish set without external deps
  const hues = [18, 40, 80, 140, 190, 220, 260, 300, 330];
  const h = hues[i % hues.length];
  return `hsl(${h} 70% 75%)`;
}

/* ---------------------------
   Land ops (union / erase)
--------------------------- */

function unionIntoLand(newPolyFeature) {
  const features = getAllFeatures();
  const land = findLandFeature(features);

  const newMP = toMultiPolyCoords(newPolyFeature);

  let merged;
  if (land) {
    const landMP = toMultiPolyCoords(land);
    merged = pc.union(landMP, newMP);
  } else {
    merged = newMP;
  }

  const nextLand = fromMultiPolyCoords(merged, { layer: "land", name: "Land" });
  const cleaned = features.filter((f) => f !== land && f?.id !== land?.id); // remove old land feature if any
  // keep everything else
  cleaned.push(nextLand);
  setAllFeatures(cleaned);
}

function eraseFromLand(erasePolyFeature) {
  const features = getAllFeatures();
  const land = findLandFeature(features);
  if (!land) return;

  const landMP = toMultiPolyCoords(land);
  const eraseMP = toMultiPolyCoords(erasePolyFeature);

  const diff = pc.difference(landMP, eraseMP);
  const cleaned = features.filter((f) => f !== land && f?.id !== land?.id);

  if (!diff || diff.length === 0) {
    // land erased completely
    setAllFeatures(cleaned);
    return;
  }

  const nextLand = fromMultiPolyCoords(diff, { layer: "land", name: "Land" });
  cleaned.push(nextLand);
  setAllFeatures(cleaned);
}

/* ---------------------------
   Procedural generation
--------------------------- */

function generateLandBlobs() {
  // Create a few large “continent” blobs by unioning circles within current viewport bounds
  const b = map.getBounds();
  const minX = b.getWest(),
    maxX = b.getEast(),
    minY = b.getSouth(),
    maxY = b.getNorth();

  const continents = 3; // tweakable later
  const circlesPer = 18;
  const baseRadius = 55000; // meters

  let acc = null; // MultiPolygon coords
  for (let c = 0; c < continents; c++) {
    const cx = minX + Math.random() * (maxX - minX);
    const cy = minY + Math.random() * (maxY - minY);

    for (let k = 0; k < circlesPer; k++) {
      const jitterLng = (Math.random() - 0.5) * (maxX - minX) * 0.20;
      const jitterLat = (Math.random() - 0.5) * (maxY - minY) * 0.20;
      const r = baseRadius * (0.55 + Math.random() * 0.9);

      const circle = circlePolygonFeature(cx + jitterLng, cy + jitterLat, r, 56, { layer: "land" });
      const mp = toMultiPolyCoords(circle);

      acc = acc ? pc.union(acc, mp) : mp;
    }
  }

  const land = fromMultiPolyCoords(acc, { layer: "land", name: "Land" });

  // Remove existing land + regions, keep everything else (markers, labels, etc.)
  let features = getAllFeatures();
  features = removeByLayer(features, "land");
  features = removeByLayer(features, "regions");
  features.push(land);

  setAllFeatures(features);
  setStatus("Generated land");
}

function generateRegionsVoronoi() {
  const features = getAllFeatures();
  const land = findLandFeature(features);
  if (!land) {
    setStatus("No land found. Generate land or draw land first.");
    return;
  }

  const landMP = toMultiPolyCoords(land);
  const [minX, minY, maxX, maxY] = bboxOfMultiPoly(landMP);

  const REGION_COUNT = 90; // tweakable
  const seeds = [];

  // Rejection-sample points inside land bbox
  let tries = 0;
  while (seeds.length < REGION_COUNT && tries < REGION_COUNT * 2000) {
    tries++;
    const x = minX + Math.random() * (maxX - minX);
    const y = minY + Math.random() * (maxY - minY);
    if (pointInMultiPolygon([x, y], landMP)) seeds.push([x, y]);
  }

  if (seeds.length < 10) {
    setStatus("Could not place region seeds inside land (try generating land again).");
    return;
  }

  const delaunay = Delaunay.from(seeds);
  const vor = delaunay.voronoi([minX, minY, maxX, maxY]);

  // Clear old regions, then add new ones
  let next = removeByLayer(features, "regions");

  let added = 0;
  for (let i = 0; i < seeds.length; i++) {
    const poly = vor.cellPolygon(i);
    if (!poly || poly.length < 4) continue;

    // Voronoi returns [x,y] points; ensure closed ring
    const ring = poly.map(([x, y]) => [x, y]);
    if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
      ring.push(ring[0]);
    }

    const cellFeature = {
      type: "Feature",
      properties: { layer: "regions" },
      geometry: { type: "Polygon", coordinates: [ring] }
    };

    // Clip region to land
    const clipped = pc.intersection(landMP, toMultiPolyCoords(cellFeature));
    if (!clipped || clipped.length === 0) continue;

    const region = fromMultiPolyCoords(clipped, {
      layer: "regions",
      name: `Region ${i + 1}`,
      fill: pastel(i),
      stroke: "rgba(0,0,0,.45)"
    });

    next.push(region);
    added++;
  }

  setAllFeatures(next);
  setStatus(`Generated regions (${added})`);
}

/* ---------------------------
   Map init
--------------------------- */

const map = new maplibregl.Map({
  container: "map",
  style: STYLE_URL,
  center: [-91.874, 42.76],
  zoom: 12
});

map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "bottom-right");

// Build toolbar buttons (UI only — handlers set after draw init)
const tools = [
  { mode: "select", label: "⟡" },
  { mode: "point", label: "•" },
  { mode: "marker", label: "⌁" },
  { mode: "linestring", label: "／" },
  { mode: "polygon", label: "▱" },
  { mode: "rectangle", label: "▭" },
  { mode: "circle", label: "○" },
  { mode: "freehand", label: "✎" }
];

for (const t of tools) {
  const btn = document.createElement("button");
  btn.className = "icon-btn";
  btn.textContent = t.label;
  btn.dataset.mode = t.mode;
  btn.onclick = () => {
    if (!draw) return;
    eraseActive = false;
    btnEraseToggle?.dataset && (btnEraseToggle.dataset.active = "false");
    draw.setMode(t.mode);
    setModeUI(t.mode);
    setStatus(`Mode: ${t.mode}`);
  };
  toolbar.appendChild(btn);
}

setModeUI("select");
setStatus("Loading map…");

// IMPORTANT: init TerraDraw AFTER map style loads (fixes “won’t draw” on Pages)
map.on("load", () => {
  const adapter = new TerraDrawMapLibreGLAdapter({ map, lib: maplibregl });

  draw = new TerraDraw({
    adapter,
    modes: [
      new TerraDrawRenderMode(),
      new TerraDrawSelectMode(),
      new TerraDrawPointMode(),
      new TerraDrawMarkerMode(),
      new TerraDrawLineStringMode(),
      new TerraDrawPolygonMode(),
      new TerraDrawRectangleMode(),
      new TerraDrawCircleMode(),
      new TerraDrawFreehandMode()
    ]
  });

  draw.start();
  draw.setMode("select");
  setModeUI("select");

  // Restore autosave
  const stored = loadSnapshot();
  if (stored) {
    try {
      draw.setSnapshot(stored);
      setStatus("Loaded autosave");
    } catch {
      setStatus("Autosave found but could not be loaded");
    }
  } else {
    setStatus("Ready");
  }

  refreshCounts();

  // TerraDraw events
  draw.on("change", () => {
    const { snap } = refreshCounts();
    saveSnapshot(snap);
  });

  draw.on("select", (id) => {
    selectedId = id;
    selStatus.textContent = "Selected";
    const { features } = refreshCounts();
    const f = features.find((x) => x.id === selectedId);
    propName.value = f?.properties?.name ?? "";
    propType.value = f?.properties?.type ?? "";
  });

  draw.on("deselect", () => {
    selectedId = null;
    selStatus.textContent = "Nothing selected";
    propName.value = "";
    propType.value = "";
  });

  // Property updates
  function updateSelectedProps(patch) {
    if (!selectedId) return;

    if (typeof draw.updateFeatureProperties === "function") {
      draw.updateFeatureProperties(selectedId, patch);
      return;
    }

    // Fallback snapshot rewrite
    const snap = draw.getSnapshot();
    const features = (snap?.store?.features ?? []).map((f) =>
      f.id === selectedId ? { ...f, properties: { ...(f.properties || {}), ...patch } } : f
    );
    const next = { ...snap, store: { ...(snap.store || {}), features } };
    draw.setSnapshot(next);
    saveSnapshot(next);
  }

  propName.addEventListener("input", (e) => updateSelectedProps({ name: e.target.value }));
  propType.addEventListener("input", (e) => updateSelectedProps({ type: e.target.value }));

  // Buttons
  btnGeo.onclick = () => {
    const { features } = refreshCounts();
    const geojson = { type: "FeatureCollection", features };
    downloadText(`worldbuilder-${nowStamp()}.geojson`, JSON.stringify(geojson, null, 2));
    setStatus("Exported GeoJSON");
  };

  btnPng.onclick = () => {
    const dataUrl = map.getCanvas().toDataURL("image/png");
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `worldbuilder-${nowStamp()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus("Exported PNG (viewport)");
  };

  btnClear.onclick = () => {
    const snap = draw.getSnapshot();
    const ids = (snap?.store?.features ?? []).map((f) => f.id).filter(Boolean);
    if (ids.length) draw.removeFeatures(ids);
    clearSnapshot();
    refreshCounts();
    selectedId = null;
    selStatus.textContent = "Nothing selected";
    propName.value = "";
    propType.value = "";
    setStatus("Cleared canvas + autosave");
  };

  btnGenLand && (btnGenLand.onclick = () => generateLandBlobs());
  btnGenRegions && (btnGenRegions.onclick = () => generateRegionsVoronoi());

  // Commit selected polygon into Land (manual add land)
  btnCommitLand &&
    (btnCommitLand.onclick = () => {
      if (!selectedId) {
        setStatus("Select a polygon first (draw one, then select it).");
        return;
      }
      const features = getAllFeatures();
      const f = features.find((x) => x.id === selectedId);
      if (!f || !isPolygonalFeature(f)) {
        setStatus("Selected feature is not a polygon.");
        return;
      }
      unionIntoLand(f);

      // remove the original polygon feature (so land stays merged)
      const after = getAllFeatures().filter((x) => x.id !== selectedId);
      setAllFeatures(after);

      selectedId = null;
      selStatus.textContent = "Nothing selected";
      propName.value = "";
      propType.value = "";
      setStatus("Added selected polygon to Land");
    });

  // Erase Land brush (click/drag)
  const ERASE_RADIUS_M = 20000; // tweak: 20km-ish
  let erasing = false;
  let lastEraseAt = 0;

  function eraseAt(lngLat) {
    const now = Date.now();
    if (now - lastEraseAt < 80) return; // throttle
    lastEraseAt = now;

    const erase = circlePolygonFeature(lngLat.lng, lngLat.lat, ERASE_RADIUS_M, 48, { layer: "erase" });
    eraseFromLand(erase);
  }

  btnEraseToggle &&
    (btnEraseToggle.onclick = () => {
      eraseActive = !eraseActive;
      btnEraseToggle.dataset.active = eraseActive ? "true" : "false";
      if (eraseActive) {
        draw.setMode("render"); // prevent drawing modes from capturing clicks
        setModeUI("render");
        setStatus("Erase Land: click + drag on land");
      } else {
        draw.setMode("select");
        setModeUI("select");
        setStatus("Ready");
      }
    });

  map.on("mousedown", (e) => {
    if (!eraseActive) return;
    erasing = true;
    eraseAt(e.lngLat);
  });

  map.on("mousemove", (e) => {
    if (!eraseActive || !erasing) return;
    eraseAt(e.lngLat);
  });

  window.addEventListener("mouseup", () => {
    erasing = false;
  });

  // Keyboard shortcuts
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      document.getElementById("search")?.focus();
      e.preventDefault();
    }
    if (e.key === "Escape") {
      eraseActive = false;
      if (btnEraseToggle) btnEraseToggle.dataset.active = "false";
      draw.setMode("select");
      setModeUI("select");
      setStatus("Mode: select");
    }
    if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
      draw.removeFeatures([selectedId]);
      selectedId = null;
      selStatus.textContent = "Nothing selected";
      propName.value = "";
      propType.value = "";
      setStatus("Deleted selected feature");
    }
  });
});
