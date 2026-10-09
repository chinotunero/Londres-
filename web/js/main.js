// Londres Sin Red: app shell, map, search, directions and navigation UI.
import { getInstalled, openFile, PackSource, estimate } from "./storage.js";
import { Navigator } from "./nav.js";

/* global maplibregl, pmtiles, basemaps */
const $ = (s, el = document) => el.querySelector(s);
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const LONDON = { lat: 51.5074, lon: -0.1278 };

// ------------------------------------------------------------------ worker RPC
const worker = new Worker(new URL("./router.worker.js", import.meta.url), { type: "module" });
let rpcId = 0;
const pending = new Map();
let progressCb = null;
worker.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === "progress") { if (progressCb) progressCb(m); return; }
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error));
};
const rpc = (cmd, args = {}) => new Promise((resolve, reject) => {
  const id = ++rpcId;
  pending.set(id, { resolve, reject });
  worker.postMessage({ id, cmd, ...args });
});

// ------------------------------------------------------------------ state
const S = {
  view: "home", me: null, place: null, from: null, to: null, mode: "transit", noBus: false,
  plans: null, sel: 0, nav: null, manifest: null, installed: null, ready: false, target: "place",
  picking: null, follow: false, voice: true, busy: false,
};
try { S.voice = localStorage.getItem("lsr-voice") !== "0"; } catch { /* storage blocked */ }
const BASE = new URL(".", location.href);

// ------------------------------------------------------------------ formatting
const fmtMin = (m) => { m = Math.max(1, Math.round(m)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`; };
const fmtDist = (d) => (d < 950 ? `${Math.max(10, Math.round(d / 10) * 10)} m` : `${(d / 1000).toFixed(1).replace(".", ",")} km`);
const fmtMB = (b) => `${Math.round(b / 1e6)} MB`;
const clock = (addMin = 0) => new Date(Date.now() + addMin * 60000).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
function distM(a, b) {
  const k = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180) * 111320;
  return Math.hypot((b.lon - a.lon) * k, (b.lat - a.lat) * 110574);
}
const MODE_COLOR = { bus: "#d42a1e", trolleybus: "#d42a1e", subway: "#24418f", train: "#5f6b78", light_rail: "#00a4a7",
  tram: "#4f9d1a", ferry: "#1e7fd0", aerialway: "#c2185b", monorail: "#7b5ea7" };
const legColor = (l) => (l.color && /^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(l.color) ? (l.color[0] === "#" ? l.color : "#" + l.color) : MODE_COLOR[l.mode] || "#5f6b78");
function textOn(hex) {
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
  const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 165 ? "#14202b" : "#ffffff";
}

// ------------------------------------------------------------------ icons (inline SVG)
const svg = (p) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${p}</svg>`;
const ICON = {
  walk: svg('<circle cx="13" cy="4" r="2"/><path d="M10.6 8.2 8 19.5h2.2l1.6-6.8 2.2 2.1v4.7h2v-5.6l-2.1-2.1.6-3 1.4 1.8H19v-2h-2.1l-2-2.6a2 2 0 0 0-1.6-.8c-.4 0-.7.1-1 .2L8 6.6V10h2V7.9l.6.3Z"/>'),
  bus: svg('<path d="M6 3h12a2 2 0 0 1 2 2v11a2 2 0 0 1-1 1.7V20h-2.5v-2h-9v2H5v-2.3A2 2 0 0 1 4 16V5a2 2 0 0 1 2-2Zm0 2v6h12V5Zm1.5 8.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Zm9 0a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Z"/>'),
  subway: svg('<path d="M12 2c4.4 0 8 .6 8 4.5V16a3 3 0 0 1-2 2.8l1.5 1.7V21h-2.2l-2-2h-6.6l-2 2H4.5v-.5L6 18.8A3 3 0 0 1 4 16V6.5C4 2.6 7.6 2 12 2Zm-6 5v4h5V7Zm7 0v4h5V7ZM7.5 13.3a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Zm9 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z"/>'),
  train: svg('<path d="M12 2c4 0 7 .5 7 4v9.5a3.5 3.5 0 0 1-2.4 3.3L18 20.5V22h-2l-2-2.5h-4L8 22H6v-1.5l1.4-1.7A3.5 3.5 0 0 1 5 15.5V6c0-3.5 3-4 7-4ZM7 6.5V11h10V6.5Zm1.5 7a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/>'),
  ferry: svg('<path d="M4 15.5 3 11h18l-1.4 4.6A4.6 4.6 0 0 1 16 14a4.6 4.6 0 0 1-4 2 4.6 4.6 0 0 1-4-2 4.6 4.6 0 0 1-4 1.5ZM6 9V6h4V4h4v2h4v3Zm-2 9c1.6 0 2.8-.6 4-1.6 1.2 1 2.4 1.6 4 1.6s2.8-.6 4-1.6c1.2 1 2.4 1.6 4 1.6v2c-1.5 0-2.8-.4-4-1.1a7.4 7.4 0 0 1-8 0A7.6 7.6 0 0 1 4 20Z"/>'),
  search: svg('<path d="M10 3a7 7 0 0 1 5.6 11.2l5.1 5.1-1.4 1.4-5.1-5.1A7 7 0 1 1 10 3Zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z"/>'),
  menu: svg('<path d="M3 6h18v2H3Zm0 5h18v2H3Zm0 5h18v2H3Z"/>'),
  back: svg('<path d="m11 4 1.4 1.4L7.8 10H21v2H7.8l4.6 4.6L11 18l-7-7Z"/>'),
  close: svg('<path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4Z"/>'),
  locate: svg('<path d="M11 2h2v2.1a8 8 0 0 1 6.9 6.9H22v2h-2.1a8 8 0 0 1-6.9 6.9V22h-2v-2.1A8 8 0 0 1 4.1 13H2v-2h2.1A8 8 0 0 1 11 4.1Zm1 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12Zm0 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z"/>'),
  swap: svg('<path d="M7 3 3 7l4 4V8h7V6H7Zm10 10v3h-7v2h7v3l4-4Z"/>'),
  pin: svg('<path d="M12 2a7 7 0 0 1 7 7c0 5-7 13-7 13S5 14 5 9a7 7 0 0 1 7-7Zm0 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z"/>'),
  street: svg('<path d="M9 2h2v4H9Zm0 6h2v4H9Zm0 6h2v4H9Zm0 6h2v2H9ZM4 2h2v20H4Zm14 0h2v20h-2Z"/>'),
  home: svg('<path d="m12 3 9 8h-3v9h-5v-6h-2v6H6v-9H3Z"/>'),
  download: svg('<path d="M11 3h2v9.2l3.6-3.6 1.4 1.4-6 6-6-6 1.4-1.4 3.6 3.6ZM4 18h16v2H4Z"/>'),
  voice: svg('<path d="M4 9h4l5-4v14l-5-4H4Zm12.5-1.5 1.4-1.4a8 8 0 0 1 0 11.8l-1.4-1.4a6 6 0 0 0 0-9Zm-2.1 2.1L15.8 8a5 5 0 0 1 0 8l-1.4-1.4a3 3 0 0 0 0-5Z"/>'),
  mute: svg('<path d="M4 9h4l5-4v14l-5-4H4Zm12.6.2 1.4-1.4 2 2 2-2 1.4 1.4-2 2 2 2-1.4 1.4-2-2-2 2-1.4-1.4 2-2Z"/>'),
  list: svg('<path d="M4 5h2v2H4Zm4 0h12v2H8Zm-4 6h2v2H4Zm4 0h12v2H8Zm-4 6h2v2H4Zm4 0h12v2H8Z"/>'),
};
ICON.trolleybus = ICON.bus; ICON.light_rail = ICON.train; ICON.tram = ICON.train; ICON.monorail = ICON.train; ICON.aerialway = ICON.train;
ICON.station = ICON.train;
const KIND_ICON = { station: ICON.station, stop: ICON.bus, street: ICON.street, place: ICON.home, address: ICON.pin, postcode: ICON.pin, poi: ICON.pin, me: ICON.locate, map: ICON.pin };
const ARROW = {
  depart: '<path d="M12 3 6 9.5h4V21h4V9.5h4Z"/>',
  straight: '<path d="M12 3 6 9.5h4V21h4V9.5h4Z"/>',
  left: '<path d="M14 21v-8a3 3 0 0 0-3-3H8v4L2 8.5 8 3v4h3a6 6 0 0 1 6 6v8Z"/>',
  right: '<path d="M10 21v-8a3 3 0 0 1 3-3h3v4l6-5.5L16 3v4h-3a6 6 0 0 0-6 6v8Z"/>',
  "slight-left": '<path d="M15 21v-6.2a4 4 0 0 0-1.2-2.8L8.6 6.8 6 9.4V3h6.4L9.8 5.6 15 10.8a6 6 0 0 1 1.8 4.2V21Z"/>',
  "slight-right": '<path d="M9 21v-6.2a4 4 0 0 1 1.2-2.8l5.2-5.2L18 9.4V3h-6.4l2.6 2.6L9 10.8A6 6 0 0 0 7.2 15V21Z"/>',
  uturn: '<path d="M6 21V9a6 6 0 0 1 12 0v4h3l-5 6-5-6h3V9a2 2 0 0 0-4 0v12Z"/>',
  cross: '<path d="M3 5h3v14H3Zm5 0h3v14H8Zm5 0h3v14h-3Zm5 0h3v14h-3Z"/>',
  steps: '<path d="M3 19h5v-4h4v-4h4V7h5v3h-2v3h-4v4h-4v4H3Z"/>',
  elevator: '<path d="M5 2h14v20H5Zm2 2v16h10V4Zm5 1 3 4H9Zm0 14-3-4h6Z"/>',
  arrive: '<path d="M5 2h2v1h11l-2.5 4.5L18 12H7v10H5Z"/>',
};
function pill(l) {
  const c = legColor(l);
  const bus = l.mode === "bus" || l.mode === "trolleybus";
  const label = bus ? (l.ref || l.label) : l.label;
  return `<span class="pill" style="background:${c};color:${textOn(c)}">${ICON[l.mode] || ICON.train}<b>${esc(label)}</b></span>`;
}

// ------------------------------------------------------------------ toast
let toastTimer;
function toast(msg, ms = 3200) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ------------------------------------------------------------------ map
let map, protocol, tilesSource;
const dark = () => matchMedia("(prefers-color-scheme: dark)").matches;
function style() {
  const hasTiles = !!(tilesSource && (tilesSource.file || tilesSource.remote));
  return {
    version: 8,
    glyphs: BASE.href + "assets/fonts/{fontstack}/{range}.pbf",
    sprite: BASE.href + `assets/sprites/v4/${dark() ? "dark" : "light"}`,
    sources: hasTiles ? { protomaps: { type: "vector", url: "pmtiles://londres", attribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>' } } : {},
    layers: hasTiles ? basemaps.layers("protomaps", basemaps.namedFlavor(dark() ? "dark" : "light"), { lang: "es" })
      : [{ id: "bg", type: "background", paint: { "background-color": dark() ? "#1c2229" : "#eceeec" } }],
  };
}
function addOverlay() {
  if (map.getSource("route")) return;
  const dk = dark();
  map.addSource("route", { type: "geojson", data: S.drawn || { type: "FeatureCollection", features: [] } });
  map.addSource("me", { type: "geojson", data: S.meFeature || { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "me-acc", type: "fill", source: "me", paint: { "fill-color": "#1a73e8", "fill-opacity": 0.12 } });
  map.addLayer({ id: "route-walk", type: "line", source: "route", filter: ["==", ["get", "k"], "walk"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": dk ? "#9cc4ff" : "#1a5fb4", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 3, 18, 7], "line-dasharray": [0.1, 1.8] } });
  map.addLayer({ id: "route-ride-case", type: "line", source: "route", filter: ["==", ["get", "k"], "ride"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": dk ? "#0d1117" : "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 6, 18, 13] } });
  map.addLayer({ id: "route-ride", type: "line", source: "route", filter: ["==", ["get", "k"], "ride"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["get", "c"], "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3.5, 18, 9] } });
  map.addLayer({ id: "route-stops", type: "circle", source: "route", filter: ["==", ["get", "k"], "stop"],
    paint: { "circle-radius": ["case", ["get", "end"], 6, 3.5], "circle-color": "#ffffff", "circle-stroke-color": ["get", "c"], "circle-stroke-width": ["case", ["get", "end"], 3, 2] } });
  map.addLayer({ id: "route-stop-labels", type: "symbol", source: "route", filter: ["all", ["==", ["get", "k"], "stop"], ["get", "end"]],
    layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Medium"], "text-size": 12, "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true },
    paint: { "text-color": dk ? "#e8eef4" : "#13202c", "text-halo-color": dk ? "#0d1117" : "#ffffff", "text-halo-width": 1.6 } });
}
async function initMap() {
  protocol = new pmtiles.Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);
  tilesSource = new PackSource("londres");
  await refreshTilesSource();
  const ctr = (S.installed && S.installed.center) || (S.manifest && S.manifest.center) || [LONDON.lon, LONDON.lat];
  map = new maplibregl.Map({
    container: "map", style: style(), center: ctr, zoom: 12, minZoom: 8, maxZoom: 19,
    attributionControl: { compact: true }, pitchWithRotate: false, fadeDuration: 100,
  });
  map.touchZoomRotate.disableRotation();
  map.on("style.load", addOverlay);
  map.on("click", onMapClick);
  map.on("dragstart", () => { if (S.follow) { S.follow = false; renderFabs(); } });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => map.setStyle(style()));
}
async function refreshTilesSource() {
  tilesSource.file = null; tilesSource.remote = null;
  if (S.installed && S.installed.files.tiles) {
    try { tilesSource.setFile(await openFile("tiles", S.installed)); } catch (e) { console.warn(e); }
  }
  if (!tilesSource.file && S.manifest && S.manifest.files.tiles && navigator.onLine) tilesSource.setRemote(S.manifest.files.tiles, BASE);
  protocol.add(new pmtiles.PMTiles(tilesSource));
}

const markers = {};
function marker(key, ll, cls, html = "") {
  if (!ll) { if (markers[key]) { markers[key].remove(); delete markers[key]; } return null; }
  if (!markers[key]) {
    const el = document.createElement("div");
    el.className = "mk " + cls;
    el.innerHTML = html;
    markers[key] = new maplibregl.Marker({ element: el, anchor: cls.includes("pinmk") ? "bottom" : "center" }).setLngLat([ll.lon, ll.lat]).addTo(map);
  } else markers[key].setLngLat([ll.lon, ll.lat]);
  return markers[key];
}
function setRouteData(fc) {
  S.drawn = fc;
  const src = map && map.getSource("route");
  if (src) src.setData(fc);
}
function drawJourney(j) {
  const features = [];
  if (j) {
    for (const l of j.legs) {
      if (l.type === "walk") features.push({ type: "Feature", properties: { k: "walk" }, geometry: { type: "LineString", coordinates: l.coords } });
      else {
        const c = legColor(l);
        features.push({ type: "Feature", properties: { k: "ride", c }, geometry: { type: "LineString", coordinates: l.coords } });
        l.stops.forEach((s, i) => features.push({ type: "Feature", properties: { k: "stop", c, end: i === 0 || i === l.stops.length - 1, name: s.name },
          geometry: { type: "Point", coordinates: [s.lon, s.lat] } }));
      }
    }
  }
  setRouteData({ type: "FeatureCollection", features });
  marker("A", j && S.from && S.from.kind !== "me" ? S.from : null, "dotmk origin");
  marker("B", j ? S.to : null, "pinmk dest", ICON.pin);
}
function fitTo(points) {
  if (!map || !points.length) return;
  let a0 = 90, a1 = -90, b0 = 180, b1 = -180;
  for (const [lon, lat] of points) { a0 = Math.min(a0, lat); a1 = Math.max(a1, lat); b0 = Math.min(b0, lon); b1 = Math.max(b1, lon); }
  const wide = innerWidth >= 860;
  const sheetH = Math.min($("#sheet").offsetHeight || 0, innerHeight * 0.55);
  const topH = ($("#top").offsetHeight || 0) + 24;
  map.fitBounds([[b0, a0], [b1, a1]], { padding: wide ? { top: 60, bottom: 60, left: 470, right: 70 } : { top: topH, bottom: sheetH + 24, left: 36, right: 36 }, maxZoom: 17, duration: 600 });
}
const fitJourney = (j) => fitTo(j.legs.flatMap((l) => l.coords));

// ------------------------------------------------------------------ location
let watchId = null, wakeLock = null;
const firstFix = [];
function startLocation(onFirst) {
  if (S.me && onFirst) { onFirst(S.me); onFirst = null; }
  if (onFirst) firstFix.push(onFirst);
  if (watchId !== null) return;
  if (!("geolocation" in navigator)) { toast("Este dispositivo no permite la ubicación."); return; }
  watchId = navigator.geolocation.watchPosition((p) => {
    const me = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, speed: p.coords.speed, heading: p.coords.heading, t: p.timestamp, kind: "me", name: "Tu ubicación" };
    S.me = me;
    drawMe();
    while (firstFix.length) firstFix.shift()(me);
    if (S.nav) S.nav.position(me);
    if (S.follow && map) map.easeTo({ center: [me.lon, me.lat], zoom: Math.max(map.getZoom(), S.nav ? 17 : 15), duration: 500 });
  }, (err) => {
    if (err.code === 1) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
      firstFix.length = 0;
      toast("Permiso de ubicación denegado. Actívalo en los ajustes del navegador.", 6000);
      S.follow = false; renderFabs();
      return;
    }
    // weak signal (indoors, underground): keep listening and say so once in a while
    const now = Date.now();
    if (!S.lastGpsWarn || now - S.lastGpsWarn > 60000) {
      S.lastGpsWarn = now;
      toast(S.nav ? "Señal GPS débil. Sigue las indicaciones; la posición se actualizará sola." : "Buscando tu ubicación…", 4000);
    }
  }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 });
}
function drawMe() {
  const me = S.me;
  if (!me || !map) return;
  const mk = marker("me", me, "memk", '<i class="me-cone"></i><i class="me-dot"></i>');
  const el = mk.getElement();
  const h = me.heading;
  el.classList.toggle("has-heading", h !== null && h !== undefined && !Number.isNaN(h) && (me.speed || 0) > 0.6);
  if (h !== null && h !== undefined && !Number.isNaN(h)) el.style.setProperty("--hd", `${h}deg`);
  const r = Math.min(me.acc || 0, 300);
  const k = Math.cos(me.lat * Math.PI / 180) * 111320;
  const pts = [];
  for (let i = 0; i <= 40; i++) { const a = (i / 40) * 2 * Math.PI; pts.push([me.lon + (Math.cos(a) * r) / k, me.lat + (Math.sin(a) * r) / 110574]); }
  S.meFeature = { type: "FeatureCollection", features: r > 8 ? [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [pts] } }] : [] };
  const src = map.getSource("me");
  if (src) src.setData(S.meFeature);
}
async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => { wakeLock = null; }); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not allowed */ }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.nav) keepAwake(true); });

// ------------------------------------------------------------------ voice
let esVoice = null;
function pickVoice() {
  try {
    const vs = speechSynthesis.getVoices();
    esVoice = vs.find((v) => v.lang === "es-ES") || vs.find((v) => v.lang && v.lang.startsWith("es")) || null;
  } catch { esVoice = null; }
}
if ("speechSynthesis" in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function speak(text, urgent) {
  if (!S.voice || !("speechSynthesis" in window)) return;
  try {
    if (urgent) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "es-ES"; if (esVoice) u.voice = esVoice; u.rate = 1.02;
    speechSynthesis.speak(u);
  } catch { /* no voice */ }
}

// ------------------------------------------------------------------ data readiness
let readyPromise = null;
function ensureData() {
  if (S.ready) return Promise.resolve(true);
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    try {
      if (S.installed) {
        progressUI("Preparando datos");
        const r = await rpc("init");
        S.ready = !!(r.ready && r.ready.graph);
      } else if (S.manifest && navigator.onLine) {
        progressUI("Descargando datos de rutas");
        await rpc("loadNet", { manifest: S.manifest, base: BASE.href });
        S.ready = true;
        toast("Para usarla sin conexión, descarga el mapa desde el menú ☰.", 5000);
      } else {
        toast("Sin conexión y sin mapa descargado. Conéctate una vez para descargarlo.", 6000);
      }
    } catch (e) { toast("Error al cargar los datos: " + e.message, 6000); }
    progressUI(null);
    readyPromise = null;
    return S.ready;
  })();
  return readyPromise;
}
function progressUI(label) {
  const el = $("#progress");
  if (!label) { el.hidden = true; progressCb = null; return; }
  el.hidden = false;
  el.querySelector("span").textContent = label;
  const bar = el.querySelector("i");
  bar.style.width = "4%";
  progressCb = (m) => {
    S.lastProgress = m;
    el.querySelector("span").textContent = m.stage;
    bar.style.width = `${Math.max(4, Math.round((m.done / Math.max(1, m.total)) * 100))}%`;
    if (S.view === "pack") renderSheet();
  };
}

// ------------------------------------------------------------------ search
let searchTimer = null, searchSeq = 0, resultItems = [];
function openSearch(target) {
  S.target = target;
  $("#search-panel").hidden = false;
  document.body.classList.add("searching");
  const input = $("#q");
  input.value = "";
  input.placeholder = target === "from" ? "Elige el origen" : target === "to" ? "¿A dónde vas?" : "Calle, dirección, código postal o lugar";
  input.focus();
  renderResults([]);
  ensureData();
}
function closeSearch() {
  $("#search-panel").hidden = true;
  document.body.classList.remove("searching");
  $("#q").blur();
}
function runSearch() {
  const q = $("#q").value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    if (!q.trim()) { renderResults([]); return; }
    if (!S.ready && !(await ensureData())) return;
    const near = S.me || (map ? { lat: map.getCenter().lat, lon: map.getCenter().lng } : LONDON);
    try {
      const res = await rpc("search", { q, near });
      if (seq === searchSeq) renderResults(res);
    } catch (e) { toast(e.message); }
  }, 140);
}
function recents() { try { return JSON.parse(localStorage.getItem("lsr-recent") || "[]"); } catch { return []; } }
function addRecent(p) {
  if (!p || p.kind === "me" || p.kind === "map") return;
  const list = [{ name: p.name, sub: p.sub || "", lat: p.lat, lon: p.lon, kind: p.kind }, ...recents().filter((x) => x.name !== p.name)].slice(0, 8);
  try { localStorage.setItem("lsr-recent", JSON.stringify(list)); } catch { /* storage blocked */ }
}
function renderResults(res) {
  const q = $("#q").value.trim();
  const items = [];
  if (S.target !== "place" && !q) {
    items.push({ kind: "me", name: "Tu ubicación", sub: "Usar el GPS del móvil" });
    items.push({ kind: "map", name: "Elegir en el mapa", sub: "Toca un punto del mapa" });
  }
  const list = q ? res : recents();
  if (!q && list.length) items.push({ header: "Recientes" });
  items.push(...list);
  if (q && !res.length && S.ready) items.push({ empty: true });
  resultItems = items;
  $("#results").innerHTML = items.map((r, i) => {
    if (r.header) return `<li class="hdr">${esc(r.header)}</li>`;
    if (r.empty) return `<li class="empty">No encuentro “${esc(q)}”. Prueba con una calle, un número y calle (221B Baker Street), un código postal (SW1A 1AA) o una estación.</li>`;
    const d = S.me && r.lat ? fmtDist(distM(S.me, r)) : "";
    return `<li><button data-i="${i}"><span class="ri">${KIND_ICON[r.kind] || ICON.pin}</span><span class="rt"><b>${esc(r.name)}</b><small>${esc(r.sub || "")}</small></span><span class="rd">${d}</span></button></li>`;
  }).join("");
}
$("#results").addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-i]");
  if (b) choose(resultItems[+b.dataset.i]);
});
function choose(r) {
  closeSearch();
  if (r.kind === "map") { S.picking = S.target; toast("Toca el mapa para elegir el punto.", 4000); return; }
  if (r.kind === "me") { const t = S.target; startLocation((me) => assign(t, { ...me })); return; }
  addRecent(r);
  assign(S.target, r);
}
function assign(target, p) {
  if (target === "from") { S.from = p; planNow(); }
  else if (target === "to") { S.to = p; planNow(); }
  else showPlace(p);
}

// ------------------------------------------------------------------ map clicks
async function onMapClick(ev) {
  if (S.nav) return;
  const ll = { lat: ev.lngLat.lat, lon: ev.lngLat.lng };
  let info = { name: "Punto en el mapa", sub: `${ll.lat.toFixed(5)}, ${ll.lon.toFixed(5)}` };
  if (S.ready) { try { info = await rpc("describe", ll); } catch { /* keep default */ } }
  const p = { ...ll, ...info, kind: "map" };
  if (S.picking) { const t = S.picking; S.picking = null; assign(t, p); return; }
  if (S.view === "dirs" || S.view === "itin") return;
  showPlace(p);
}

// ------------------------------------------------------------------ views
function setView(v) {
  S.view = v;
  document.body.dataset.view = v;
  $("#sheet").classList.remove("min");
  renderTop(); renderSheet(); renderFabs();
}
function showPlace(p) {
  S.place = p;
  marker("place", p, "pinmk place", ICON.pin);
  setView("place");
  if (map) map.easeTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 15.5), duration: 500,
    padding: innerWidth >= 860 ? { left: 440, top: 0, right: 0, bottom: 0 } : { bottom: 200, top: 0, left: 0, right: 0 } });
}
function startDirections(to) {
  marker("place", null);
  S.to = to;
  if (!S.from && S.me) S.from = { ...S.me };
  setView("dirs");
  if (!S.from) startLocation((me) => { if (!S.from) { S.from = { ...me }; planNow(); } });
  planNow();
}
async function planNow() {
  if (S.view !== "dirs") setView("dirs");
  S.plans = null; S.planError = null; S.sel = 0;
  drawJourney(null);
  renderTop(); renderSheet();
  if (!S.from || !S.to) return;
  if (!(await ensureData())) return;
  S.busy = true; renderSheet();
  const now = new Date(), d = now.getDay(), h = now.getHours();
  const opts = { hour: h + now.getMinutes() / 60, weekendNight: (d === 6 || d === 0) && h < 6, walkOnly: S.mode === "walk", noBus: S.noBus };
  try {
    const r = await rpc("plan", { a: S.from, b: S.to, opts });
    if (r.error) S.planError = r.error; else S.plans = r.journeys;
  } catch (e) { S.planError = e.message; }
  S.busy = false;
  renderSheet();
  if (S.plans && S.plans.length) { drawJourney(S.plans[0]); fitJourney(S.plans[0]); }
}

function renderTop() {
  const top = $("#top");
  if (S.view === "dirs" || S.view === "itin") {
    const from = S.from ? (S.from.kind === "me" ? "Tu ubicación" : S.from.name) : "";
    top.innerHTML = `<div class="card dirs">
      <button class="icon" data-act="back" aria-label="Volver">${ICON.back}</button>
      <div class="fields">
        <button class="field" data-act="pick-from"><i class="dot a"></i><span class="${from ? "" : "ph"}">${esc(from || "Elige el origen")}</span></button>
        <button class="field" data-act="pick-to"><i class="dot b"></i><span class="${S.to ? "" : "ph"}">${esc(S.to ? S.to.name : "Elige el destino")}</span></button>
      </div>
      <button class="icon" data-act="swap" aria-label="Intercambiar origen y destino">${ICON.swap}</button>
      <div class="modes" role="group" aria-label="Forma de viajar">
        <button class="chip" aria-pressed="${S.mode === "transit"}" data-act="mode-transit">${ICON.train}Transporte</button>
        <button class="chip" aria-pressed="${S.mode === "walk"}" data-act="mode-walk">${ICON.walk}A pie</button>
        ${S.mode === "transit" ? `<button class="chip" aria-pressed="${S.noBus}" data-act="nobus">Sin autobús</button>` : ""}
      </div>
    </div>`;
    return;
  }
  if (S.view === "nav") { top.innerHTML = ""; return; }
  const upd = S.installed && S.manifest && S.manifest.version !== S.installed.version;
  top.innerHTML = `<div class="card searchbar">
    <button class="icon" data-act="menu" aria-label="Mapa sin conexión">${ICON.menu}${(!S.installed || upd) ? '<i class="badge"></i>' : ""}</button>
    <button class="sb" data-act="search">${ICON.search}<span>${esc(S.view === "place" && S.place ? S.place.name : "Buscar en Londres")}</span></button>
    ${S.view === "place" || S.view === "pack" ? `<button class="icon" data-act="close" aria-label="Cerrar">${ICON.close}</button>` : ""}
  </div>`;
}

function journeyStrip(j) {
  return j.legs.map((l) => (l.type === "walk" ? (l.min >= 1 ? `<span class="wk">${ICON.walk}<small>${Math.round(l.min)}</small></span>` : "") : pill(l)))
    .filter(Boolean).join('<span class="sep" aria-hidden="true">›</span>');
}
function firstRideNote(j) {
  const r = j.legs.find((l) => l.type === "ride");
  return r ? ` · ${r.mode === "bus" || r.mode === "trolleybus" ? "pasa" : "sale"} cada ~${r.headway} min` : "";
}
function renderSheet() {
  const sh = $("#sheet");
  const v = S.view;
  sh.classList.toggle("hidden", v === "nav" && !S.showSteps);
  let html = "";
  if (v === "home") {
    const rec = recents().slice(0, 4);
    html = `<div class="sheet-h"><h2>Londres</h2>${packChip()}</div>
      ${rec.length ? `<p class="lab">Recientes</p><ul class="list">${rec.map((r, i) => `<li><button data-act="recent" data-i="${i}"><span class="ri">${KIND_ICON[r.kind] || ICON.pin}</span><span class="rt"><b>${esc(r.name)}</b><small>${esc(r.sub || "")}</small></span></button></li>`).join("")}</ul>`
        : `<p class="muted">Busca una calle, una dirección, un código postal o un lugar, o toca el mapa.</p>`}`;
  } else if (v === "place") {
    const p = S.place;
    const d = S.me ? `<span class="muted nowrap">${fmtDist(distM(S.me, p))} de ti</span>` : "";
    html = `<div class="sheet-h"><div class="grow"><h2>${esc(p.name)}</h2><p class="muted">${esc(p.sub || "")}</p></div>${d}</div>
      <div class="actions"><button class="btn pri" data-act="go">Cómo llegar</button><button class="btn" data-act="from-here">Salir desde aquí</button></div>`;
  } else if (v === "dirs") {
    if (!S.from || !S.to) html = `<p class="muted">${!S.from ? "Elige el origen o activa tu ubicación." : "Elige el destino."}</p>`;
    else if (S.busy) html = `<p class="muted loading">Calculando rutas en tu móvil…</p>`;
    else if (S.planError) html = `<p class="err">${esc(S.planError)}</p>`;
    else if (S.plans) {
      html = `<ul class="plans">${S.plans.map((j, i) => `<li><button class="plan ${i === S.sel ? "on" : ""}" data-act="plan" data-i="${i}">
        <span class="ptop"><b class="pmin">${fmtMin(j.min)}</b><span class="muted small">${clock(0)}–${clock(j.min)}</span>${j.tag ? `<span class="tag">${esc(j.tag)}</span>` : ""}</span>
        <span class="strip">${journeyStrip(j)}</span>
        <span class="muted small">${j.transfers ? `${j.transfers} transbordo${j.transfers > 1 ? "s" : ""} · ` : ""}${fmtDist(j.walkM)} a pie${firstRideNote(j)}</span>
      </button></li>`).join("")}</ul>
      <p class="note">Toca una ruta dos veces para ver los pasos. Tiempos estimados con frecuencias habituales, sin horarios en tiempo real.</p>`;
    }
  } else if (v === "itin") {
    const j = S.plans[S.sel];
    html = `<div class="sheet-h"><div class="grow"><h2>${fmtMin(j.min)}</h2><p class="muted">Llegada aprox. ${clock(j.min)} · ${fmtDist(j.walkM)} a pie</p></div>
      <button class="btn pri" data-act="start">Iniciar</button></div>${itinerary(j)}`;
  } else if (v === "nav") {
    const j = S.nav && S.nav.j;
    html = j ? `<div class="sheet-h"><h2>Pasos</h2><button class="btn" data-act="steps-close">Cerrar</button></div>${itinerary(j, S.nav.i)}` : "";
  } else if (v === "pack") html = packView();
  sh.querySelector(".content").innerHTML = html;
}
function itinerary(j, current = -1) {
  const rows = [`<li class="it-end"><i class="dot a"></i><div><b>${esc(S.from ? (S.from.kind === "me" ? "Tu ubicación" : S.from.name) : "Salida")}</b><small>${clock(0)}</small></div></li>`];
  let t = 0;
  j.legs.forEach((l, i) => {
    const cls = i === current ? " now" : i < current ? " past" : "";
    if (l.type === "walk") {
      const steps = l.maneuvers.filter((m) => m.type !== "arrive").map((m, k, arr) => {
        const next = arr[k + 1] ? arr[k + 1].d : l.dist;
        return `<li><i class="arrow">${svg(ARROW[m.type] || ARROW.straight)}</i><span>${esc(m.text)}</span><small>${fmtDist(Math.max(0, next - m.d))}</small></li>`;
      }).join("");
      const n = l.maneuvers.filter((m) => m.type !== "arrive").length;
      rows.push(`<li class="it-walk${cls}"><i class="ico">${ICON.walk}</i><div>
        <b>${l.transfer ? "Transbordo a pie" : "Camina"} ${fmtDist(l.dist)}</b><small>${fmtMin(l.min)}${l.entrance ? " · por la " + esc(l.entrance) : ""}${l.to ? " · hasta " + esc(l.to) : ""}</small>
        ${steps ? `<details ${i === current ? "open" : ""}><summary>${n} ${n === 1 ? "indicación" : "indicaciones"}</summary><ol class="turns">${steps}</ol></details>` : ""}</div></li>`);
    } else {
      const c = legColor(l);
      rows.push(`<li class="it-ride${cls}" style="--c:${c}"><i class="ico" style="background:${c};color:${textOn(c)}">${ICON[l.mode] || ICON.train}</i><div>
        <b>${pill(l)} <span>hacia ${esc(l.headsign)}</span></b>
        <small>Sube en <b>${esc(l.from.name)}</b>${l.from.ref ? ` (parada ${esc(l.from.ref)})` : ""} · espera ~${Math.round(l.wait)} min, pasa cada ~${l.headway} min</small>
        <details><summary>${l.nStops} ${l.nStops === 1 ? "parada" : "paradas"} · ${fmtMin(l.ride)}</summary><ol class="stops">${l.stops.map((s) => `<li>${esc(s.name)}</li>`).join("")}</ol></details>
        <small>Baja en <b>${esc(l.to.name)}</b></small></div></li>`);
    }
    t += l.min;
  });
  rows.push(`<li class="it-end"><i class="dot b"></i><div><b>${esc(S.to ? S.to.name : "Destino")}</b><small>${clock(t)}</small></div></li>`);
  return `<ol class="itin">${rows.join("")}</ol>`;
}

// ------------------------------------------------------------------ offline pack
function packChip() {
  if (S.installed) {
    const upd = S.manifest && S.manifest.version !== S.installed.version;
    return `<button class="chip ${upd ? "warn" : "ok"}" data-act="menu">${upd ? "Actualización del mapa" : "Listo sin conexión"}</button>`;
  }
  return `<button class="chip warn" data-act="menu">${ICON.download}Descargar mapa</button>`;
}
function packView() {
  const m = S.manifest, inst = S.installed;
  const size = m ? Object.values(m.files).reduce((s, f) => s + f.size, 0) : inst ? inst.size : 0;
  const st = S.storageInfo;
  const lp = S.lastProgress;
  const prog = S.installing && lp ? `<div class="bar"><i style="width:${Math.round((lp.done / Math.max(1, lp.total)) * 100)}%"></i></div>
    <p class="muted small">${esc(lp.stage)} · ${fmtMB(lp.done)} de ${fmtMB(lp.total)}. No cierres la app.</p>` : "";
  const upd = inst && m && m.version !== inst.version;
  const stats = (m && m.stats) || null;
  const n = (x) => Number(x || 0).toLocaleString("es-ES");
  return `<div class="sheet-h"><h2>Mapa sin conexión</h2></div>
    <p>${inst ? `Tienes descargado el Gran Londres (datos del ${esc(inst.built)}). El mapa, el buscador, las rutas y la navegación funcionan sin internet.`
      : "Descarga el Gran Londres para usar el mapa, el buscador, las rutas y la navegación sin internet."}</p>
    ${stats ? `<p class="muted small">Incluye ${n(stats.edges)} tramos de calles y caminos, ${n(stats.stops)} paradas y estaciones, ${n(stats.routes)} recorridos de metro, tren, autobús y barco, y ${n(stats.addresses)} direcciones.</p>` : ""}
    ${prog}
    <div class="actions">
      ${!inst || upd ? `<button class="btn pri" data-act="install" ${S.installing || !m || !navigator.onLine ? "disabled" : ""}>${ICON.download}${upd ? "Actualizar" : "Descargar"} · ${fmtMB(size)}</button>` : ""}
      ${inst ? `<button class="btn" data-act="uninstall" ${S.installing ? "disabled" : ""}>Borrar del móvil</button>` : ""}
    </div>
    ${!m && !inst ? `<p class="err">Necesitas conexión a internet para descargar el mapa la primera vez.</p>` : ""}
    ${st && st.usage ? `<p class="muted small">Espacio usado por la app: ${fmtMB(st.usage)}${st.quota ? ` (disponible: ${fmtMB(st.quota)})` : ""}.</p>` : ""}
    <p class="muted small">Usa Wi-Fi para la descarga. En iPhone, instala primero la app en la pantalla de inicio (Safari › Compartir › Añadir a pantalla de inicio) y descarga el mapa desde ahí.</p>
    <p class="muted small">Datos © colaboradores de OpenStreetMap (licencia ODbL). Mapa base de Protomaps.</p>`;
}
async function doInstall() {
  if (!S.manifest) return;
  S.installing = true;
  S.lastProgress = { stage: "Preparando la descarga", done: 0, total: 1 };
  progressUI("Descargando el mapa");
  renderSheet();
  keepAwake(true);
  try {
    const r = await rpc("install", { manifest: S.manifest, base: BASE.href });
    S.installed = r.installed; S.storageInfo = r.storage; S.ready = !!(r.ready && r.ready.graph);
    await refreshTilesSource();
    if (map) map.setStyle(style());
    toast("Mapa descargado. Ya puedes usar la app sin conexión.", 5000);
  } catch (e) { toast("La descarga falló: " + e.message, 7000); }
  S.installing = false;
  progressUI(null);
  keepAwake(false);
  renderTop(); renderSheet();
}

// ------------------------------------------------------------------ navigation
function startNav() {
  const j = JSON.parse(JSON.stringify(S.plans[S.sel]));
  setView("nav");
  drawJourney(j);
  S.follow = true;
  renderFabs();
  keepAwake(true);
  S.nav = new Navigator(j, {
    update: renderNav,
    speak,
    reroute: async (index, pos) => {
      const leg = S.nav.j.legs[index];
      const end = leg.coords[leg.coords.length - 1];
      try {
        const r = await rpc("walk", { a: { lat: pos.lat, lon: pos.lon, name: "" }, b: { lat: end[1], lon: end[0], name: leg.to } });
        if (r.leg && S.nav) { r.leg.transfer = leg.transfer; r.leg.entrance = leg.entrance; S.nav.replaceLeg(index, r.leg); drawJourney(S.nav.j); }
        else if (S.nav) S.nav.rerouting = false;
      } catch { if (S.nav) S.nav.rerouting = false; }
    },
    done: () => {},
  });
  startLocation();
  S.nav.start();
  if (S.me) S.nav.position(S.me);
  if (map) map.easeTo({ center: S.me ? [S.me.lon, S.me.lat] : j.legs[0].coords[0], zoom: 17, duration: 600 });
}
function stopNav() {
  if (S.nav) S.nav.stop();
  S.nav = null; S.follow = false; S.showSteps = false; S.lastLegIndex = -1;
  keepAwake(false);
  try { speechSynthesis.cancel(); } catch { /* none */ }
  $("#navbanner").hidden = true; $("#navbar").hidden = true;
  setView("itin");
  if (S.plans) { drawJourney(S.plans[S.sel]); fitJourney(S.plans[S.sel]); }
}
function renderNav(s) {
  const b = $("#navbanner"), bar = $("#navbar");
  b.hidden = false; bar.hidden = false;
  if (s.finished) {
    b.className = "navbanner done";
    b.innerHTML = `<i class="big">${svg(ARROW.arrive)}</i><div class="nb-t"><b>Has llegado</b><small>${esc(S.to ? S.to.name : "")}</small></div>`;
    bar.innerHTML = `<div class="eta"><b>${clock(0)}</b><small>Fin del viaje</small></div><button class="btn pri" data-act="nav-exit">Terminar</button>`;
    return;
  }
  const leg = s.leg;
  const c = leg.type === "ride" ? legColor(leg) : null;
  b.className = "navbanner" + (leg.type === "ride" ? " ride" : "") + (s.offRoute ? " off" : "");
  if (c) { b.style.setProperty("--c", c); b.style.setProperty("--cf", textOn(c)); } else { b.style.removeProperty("--c"); b.style.removeProperty("--cf"); }
  const icon = leg.type === "ride" ? (ICON[leg.mode] || ICON.train) : svg(ARROW[s.icon] || ARROW.straight);
  b.innerHTML = `<i class="big">${icon}</i><div class="nb-t">
      ${leg.type === "walk" ? `<span class="nb-d">${fmtDist(s.dist)}</span>` : `<span class="nb-d">${s.kind === "ride" ? `${s.stopsLeft} ${s.stopsLeft === 1 ? "parada" : "paradas"}` : "Espera"}</span>`}
      <b>${esc(s.rerouting ? "Recalculando la ruta…" : s.text)}</b><small>${esc(s.sub || "")}</small></div>`;
  const nextBtn = leg.type === "ride" ? `<button class="btn" data-act="nav-next">${s.kind === "wait" ? "Ya he subido" : "He bajado"}</button>` : "";
  bar.innerHTML = `<div class="eta"><b>${clock(s.min)}</b><small>${fmtMin(s.min)} · ${fmtDist(s.m)}</small></div>
    ${nextBtn}
    <button class="icon" data-act="nav-steps" aria-label="Ver pasos">${ICON.list}</button>
    <button class="icon" data-act="voice" aria-label="${S.voice ? "Silenciar la voz" : "Activar la voz"}">${S.voice ? ICON.voice : ICON.mute}</button>
    <button class="icon danger" data-act="nav-exit" aria-label="Salir de la navegación">${ICON.close}</button>`;
  if (S.lastLegIndex !== s.index) { S.lastLegIndex = s.index; if (S.showSteps) renderSheet(); }
}
function renderFabs() {
  $("#fabs").innerHTML = `<button class="fab ${S.follow ? "on" : ""}" data-act="locate" aria-label="Centrar en mi ubicación">${ICON.locate}</button>`;
}

// ------------------------------------------------------------------ actions
document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-act]");
  if (!el) return;
  switch (el.dataset.act) {
    case "search": openSearch("place"); break;
    case "search-close": closeSearch(); break;
    case "close": marker("place", null); S.place = null; setView("home"); break;
    case "menu":
      setView("pack");
      estimate().then((s) => { S.storageInfo = s; if (S.view === "pack") renderSheet(); });
      break;
    case "go": startDirections(S.place); break;
    case "from-here": S.from = S.place; marker("place", null); setView("dirs"); planNow(); break;
    case "recent": { const r = recents()[+el.dataset.i]; if (r) showPlace(r); break; }
    case "back":
      if (S.view === "itin") { setView("dirs"); if (S.plans) drawJourney(S.plans[S.sel]); }
      else { drawJourney(null); S.plans = null; if (S.place) showPlace(S.place); else setView("home"); }
      break;
    case "pick-from": openSearch("from"); break;
    case "pick-to": openSearch("to"); break;
    case "swap": [S.from, S.to] = [S.to, S.from]; planNow(); break;
    case "mode-transit": S.mode = "transit"; planNow(); break;
    case "mode-walk": S.mode = "walk"; planNow(); break;
    case "nobus": S.noBus = !S.noBus; planNow(); break;
    case "plan": {
      const i = +el.dataset.i;
      if (i === S.sel) { setView("itin"); break; }
      S.sel = i;
      drawJourney(S.plans[i]); fitJourney(S.plans[i]);
      renderSheet();
      break;
    }
    case "start": startNav(); break;
    case "nav-exit": stopNav(); break;
    case "nav-next": if (S.nav) S.nav.next(); break;
    case "nav-steps": S.showSteps = true; renderSheet(); break;
    case "steps-close": S.showSteps = false; renderSheet(); break;
    case "voice":
      S.voice = !S.voice;
      try { localStorage.setItem("lsr-voice", S.voice ? "1" : "0"); } catch { /* blocked */ }
      if (!S.voice) { try { speechSynthesis.cancel(); } catch { /* none */ } } else speak("Voz activada.");
      if (S.nav) renderNav(S.nav.state());
      break;
    case "locate":
      S.follow = true; renderFabs();
      startLocation((me) => { if (map) map.easeTo({ center: [me.lon, me.lat], zoom: Math.max(map.getZoom(), 16), duration: 600 }); });
      break;
    case "install": doInstall(); break;
    case "uninstall":
      if (el.dataset.confirm !== "1") { el.dataset.confirm = "1"; el.textContent = "Pulsa otra vez para borrar"; break; }
      rpc("remove").then(async (r) => {
        S.installed = null; S.storageInfo = r.storage; S.ready = false;
        await refreshTilesSource(); if (map) map.setStyle(style());
        toast("Mapa borrado del móvil."); renderTop(); renderSheet();
      });
      break;
    default: break;
  }
});
$("#q").addEventListener("input", runSearch);
$("#q").addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeSearch();
  if (e.key === "Enter") { const b = $("#results button[data-i]"); if (b) b.click(); }
});
$("#sheet .grab").addEventListener("click", () => $("#sheet").classList.toggle("min"));

// ------------------------------------------------------------------ boot
async function boot() {
  document.body.dataset.view = "home";
  renderFabs();
  try { S.installed = await getInstalled(); } catch { S.installed = null; }
  try {
    const r = await fetch("data/manifest.json", { cache: "no-cache" });
    if (r.ok) S.manifest = await r.json();
  } catch { S.manifest = null; }
  await initMap();
  renderTop(); renderSheet();
  if (S.installed) ensureData();
  else if (S.manifest) {
    let seen = false;
    try { seen = localStorage.getItem("lsr-seen-pack") === "1"; localStorage.setItem("lsr-seen-pack", "1"); } catch { /* blocked */ }
    if (!seen) setView("pack");
  }
  addEventListener("online", () => {
    if (S.manifest) return;
    fetch("data/manifest.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).then(async (m) => {
      if (m) { S.manifest = m; await refreshTilesSource(); if (map) map.setStyle(style()); renderTop(); renderSheet(); }
    }).catch(() => {});
  });
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").then((reg) => {
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        if (w) w.addEventListener("statechange", () => {
          if (w.state === "installed" && navigator.serviceWorker.controller) toast("Hay una versión nueva de la app. Se aplicará la próxima vez que la abras.", 6000);
        });
      });
    }).catch(() => { /* service worker unavailable */ });
  }
}
boot();
window.__lsr = { S, rpc, planNow, startNav, stopNav, get map() { return map; } };
