import pc from "https://cdn.jsdelivr.net/npm/polygon-clipping@0.15.7/+esm";
import { Delaunay } from "https://cdn.jsdelivr.net/npm/d3-delaunay@6.0.4/+esm";
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

const STYLE_URL = "https://tiles.openfreemap.org/styles/bright";
const KEY = "worldbuilder:snapshot:v1";

const statusText = document.getElementById("statusText");
const featCount = document.getElementById("featCount");
const modeText = document.getElementById("modeText");
const selStatus = document.getElementById("selStatus");
const propName = document.getElementById("propName");
const propType = document.getElementById("propType");
const toolbar = document.getElementById("toolbar");

let selectedId = null;

function setStatus(s){ statusText.textContent = s; }
function setModeUI(mode){
  modeText.textContent = mode;
  [...toolbar.querySelectorAll("button")].forEach(b => b.dataset.active = (b.dataset.mode === mode));
}

function downloadText(filename, text, mime="application/geo+json"){
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function loadSnapshot(){
  try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; }
}
function saveSnapshot(snap){
  try { localStorage.setItem(KEY, JSON.stringify(snap)); } catch {}
}
function clearSnapshot(){
  try { localStorage.removeItem(KEY); } catch {}
}

const map = new maplibregl.Map({
  container: "map",
  style: STYLE_URL,
  center: [-91.874, 42.76],
  zoom: 12
});

map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "bottom-right");

// ✅ Wait until the map style is fully loaded
map.on("load", () => {
  const adapter = new TerraDrawMapLibreGLAdapter({ map, lib: maplibregl });

  const draw = new TerraDraw({
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

  // 👇 move ALL code that references `draw` (toolbar clicks, draw.on(...), exports, autosave)
  // inside this block, so draw is defined and ready.
});

  ]
});

draw.start();

// Toolbar
const tools = [
  { mode:"select", label:"⟡" },
  { mode:"point", label:"•" },
  { mode:"marker", label:"⌁" },
  { mode:"linestring", label:"／" },
  { mode:"polygon", label:"▱" },
  { mode:"rectangle", label:"▭" },
  { mode:"circle", label:"○" },
  { mode:"freehand", label:"✎" }
];

for (const t of tools){
  const btn = document.createElement("button");
  btn.className = "icon-btn";
  btn.textContent = t.label;
  btn.dataset.mode = t.mode;
  btn.onclick = () => { draw.setMode(t.mode); setModeUI(t.mode); setStatus(`Mode: ${t.mode}`); };
  toolbar.appendChild(btn);
}
draw.setMode("select");
setModeUI("select");

// Restore autosave
const stored = loadSnapshot();
if (stored){
  try {
    draw.setSnapshot(stored);
    setStatus("Loaded autosave");
  } catch {
    setStatus("Autosave found but could not be loaded");
  }
}

function refreshCounts(){
  const snap = draw.getSnapshot();
  const features = snap?.store?.features ?? [];
  featCount.textContent = String(features.length);
  return { snap, features };
}

draw.on("change", () => {
  const { snap } = refreshCounts();
  saveSnapshot(snap);
});

draw.on("select", (id) => {
  selectedId = id;
  selStatus.textContent = "Selected";
  const { features } = refreshCounts();
  const f = features.find(x => x.id === selectedId);
  propName.value = f?.properties?.name ?? "";
  propType.value = f?.properties?.type ?? "";
});

draw.on("deselect", () => {
  selectedId = null;
  selStatus.textContent = "Nothing selected";
  propName.value = "";
  propType.value = "";
});

function updateSelectedProps(patch){
  if (!selectedId) return;
  // Some TerraDraw builds include updateFeatureProperties; use if available
  if (typeof draw.updateFeatureProperties === "function"){
    draw.updateFeatureProperties(selectedId, patch);
    return;
  }
  // Fallback: rewrite snapshot
  const snap = draw.getSnapshot();
  const features = (snap?.store?.features ?? []).map(f =>
    f.id === selectedId ? { ...f, properties: { ...(f.properties||{}), ...patch } } : f
  );
  const next = { ...snap, store: { ...(snap.store||{}), features } };
  draw.setSnapshot(next);
  saveSnapshot(next);
}

propName.addEventListener("input", (e) => updateSelectedProps({ name: e.target.value }));
propType.addEventListener("input", (e) => updateSelectedProps({ type: e.target.value }));

document.getElementById("btnGeo").onclick = () => {
  const { snap, features } = refreshCounts();
  const geojson = { type:"FeatureCollection", features };
  downloadText(`worldbuilder-${new Date().toISOString().slice(0,19).replace(/[:T]/g,"-")}.geojson`, JSON.stringify(geojson, null, 2));
  setStatus("Exported GeoJSON");
};

document.getElementById("btnPng").onclick = () => {
  const dataUrl = map.getCanvas().toDataURL("image/png");
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = `worldbuilder-${new Date().toISOString().slice(0,19).replace(/[:T]/g,"-")}.png`;
  document.body.appendChild(a); a.click(); a.remove();
  setStatus("Exported PNG (viewport)");
};

document.getElementById("btnClear").onclick = () => {
  const snap = draw.getSnapshot();
  const ids = (snap?.store?.features ?? []).map(f => f.id).filter(Boolean);
  if (ids.length) draw.removeFeatures(ids);
  clearSnapshot();
  refreshCounts();
  selStatus.textContent = "Nothing selected";
  setStatus("Cleared canvas + autosave");
};

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    document.getElementById("search")?.focus();
    e.preventDefault();
  }
  if (e.key === "Escape") {
    draw.setMode("select");
    setModeUI("select");
  }
  if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
    draw.removeFeatures([selectedId]);
    selectedId = null;
    selStatus.textContent = "Nothing selected";
    propName.value = ""; propType.value = "";
    setStatus("Deleted selected feature");
  }
});

refreshCounts();
setStatus("Ready");
