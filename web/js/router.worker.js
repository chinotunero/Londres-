// Routing worker: loads the London data pack and answers search, route and walking requests.
import { Engine } from "./engine.js";
import { getInstalled, openFile, install, removeAll, fetchFile, estimate, persist } from "./storage.js";

const eng = new Engine();
let loadedVersion = null;
let loading = null;

const post = (msg) => self.postMessage(msg);
const progress = (stage, done, total) => post({ type: "progress", stage, done, total });

async function loadFrom(getBlob) {
  progress("Cargando calles", 0, 4);
  eng.loadGraph(await (await getBlob("graph")).arrayBuffer());
  progress("Cargando transporte", 1, 4);
  eng.loadTransit(JSON.parse(await (await getBlob("transit")).text()));
  progress("Cargando lugares", 2, 4);
  eng.loadSearch(JSON.parse(await (await getBlob("search")).text()));
  progress("Cargando direcciones", 3, 4);
  try { eng.loadAddr(JSON.parse(await (await getBlob("addr")).text())); } catch { /* optional file */ }
  progress("Listo", 4, 4);
}

async function loadLocal() {
  const inst = await getInstalled();
  if (!inst) return null;
  if (loadedVersion === inst.version) return inst;
  await loadFrom((k) => openFile(k, inst));
  loadedVersion = inst.version;
  return inst;
}

async function loadNet(manifest, base) {
  if (loadedVersion === manifest.version) return;
  const keys = ["graph", "transit", "search", "addr"];
  const total = keys.reduce((s, k) => s + (manifest.files[k] ? manifest.files[k].size : 0), 0);
  let done = 0;
  const blobs = {};
  for (const k of keys) {
    const f = manifest.files[k];
    if (!f) continue;
    const before = done;
    blobs[k] = await fetchFile(f, base, (d) => progress("Descargando datos de rutas", before + d, total));
    done += f.size;
  }
  await loadFrom(async (k) => blobs[k]);
  loadedVersion = manifest.version;
}

const handlers = {
  async status() {
    return { installed: await getInstalled(), storage: await estimate(), loaded: loadedVersion, ready: eng.ready, bbox: eng.bbox || null };
  },
  async init() {
    if (!loading) loading = loadLocal().catch((e) => { loading = null; throw e; });
    const inst = await loading;
    return { installed: inst, ready: eng.ready, bbox: eng.bbox || null };
  },
  async loadNet({ manifest, base }) {
    await loadNet(manifest, base);
    return { ready: eng.ready, bbox: eng.bbox || null };
  },
  async install({ manifest, base }) {
    await persist();
    let last = 0;
    const inst = await install(manifest, base, (d, t, name) => {
      const now = Date.now();
      if (now - last > 250 || d === t) { last = now; progress("Descargando " + name, d, t); }
    });
    loadedVersion = null;
    loading = null;
    await loadLocal();
    return { installed: inst, storage: await estimate(), ready: eng.ready };
  },
  async remove() {
    await removeAll();
    return { storage: await estimate() };
  },
  async search({ q, near }) { return eng.search(q, near); },
  async describe({ lat, lon }) { return eng.describe(lat, lon); },
  async plan({ a, b, opts }) { return eng.plan(a, b, opts); },
  async walk({ a, b }) {
    const sa = eng.snap(a.lat, a.lon), sb = eng.snap(b.lat, b.lon);
    if (!sa || !sb) return { error: "Fuera de la zona del mapa" };
    const w = eng.walkPath(sa, sb, 30000);
    if (!w) return { error: "No encuentro un camino a pie" };
    return { leg: eng.walkLeg(w.trav, a.name, b.name) };
  },
};

self.onmessage = async (ev) => {
  const { id, cmd, ...args } = ev.data;
  const h = handlers[cmd];
  if (!h) { post({ id, ok: false, error: "Orden desconocida: " + cmd }); return; }
  try {
    post({ id, ok: true, result: await h(args) });
  } catch (e) {
    post({ id, ok: false, error: (e && e.message) || String(e) });
  }
};
