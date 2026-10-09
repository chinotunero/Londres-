// Offline storage for the London data pack.
// Files live in the Origin Private File System (OPFS) when available, with Cache Storage as a fallback.
// Used by the main thread (to read the map tiles) and by the routing worker (to download and read data).

const DIR = "lsr";
const META_CACHE = "lsr-meta";
const DATA_CACHE = "lsr-data";
export const FILE_KEYS = ["tiles", "graph", "transit", "search", "addr"];

async function root() {
  try {
    if (!navigator.storage || !navigator.storage.getDirectory) return null;
    return await navigator.storage.getDirectory();
  } catch { return null; }
}
async function lsrDir(create = false) {
  const r = await root();
  if (!r) return null;
  try { return await r.getDirectoryHandle(DIR, { create }); } catch { return null; }
}

export async function getInstalled() {
  try {
    const d = await lsrDir(false);
    if (d) {
      const fh = await d.getFileHandle("installed.json");
      return JSON.parse(await (await fh.getFile()).text());
    }
  } catch { /* not in OPFS */ }
  try {
    const c = await caches.open(META_CACHE);
    const r = await c.match("installed.json");
    if (r) return await r.json();
  } catch { /* no cache */ }
  return null;
}

async function writeText(dir, name, text) {
  const fh = await dir.getFileHandle(name, { create: true });
  if (fh.createSyncAccessHandle) {
    const h = await fh.createSyncAccessHandle();
    const bytes = new TextEncoder().encode(text);
    h.truncate(0); h.write(bytes, { at: 0 }); h.flush(); h.close();
  } else {
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
  }
}

// Open a stored file as a Blob/File (the data stays on disk until read)
export async function openFile(key, installed) {
  installed = installed || await getInstalled();
  if (!installed) return null;
  const f = installed.files[key];
  if (!f) return null;
  if (installed.storage === "opfs") {
    const d = await lsrDir(false);
    const vd = await d.getDirectoryHandle(installed.dir);
    const fh = await vd.getFileHandle(f.name);
    return await fh.getFile();
  }
  const c = await caches.open(DATA_CACHE);
  const blobs = [];
  for (const p of f.parts) {
    const r = await c.match(p);
    if (!r) throw new Error(`Falta un fragmento de ${f.name}. Vuelve a descargar el mapa.`);
    blobs.push(await r.blob());
  }
  return new Blob(blobs);
}

export async function estimate() {
  try {
    const e = await navigator.storage.estimate();
    return { usage: e.usage || 0, quota: e.quota || 0 };
  } catch { return { usage: 0, quota: 0 }; }
}
export async function persist() {
  try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch { return false; }
}

// Download every file in the manifest. onProgress(bytesDone, bytesTotal, fileName)
export async function install(manifest, base, onProgress, signal) {
  const total = FILE_KEYS.reduce((s, k) => s + (manifest.files[k] ? manifest.files[k].size : 0), 0);
  let done = 0;
  const dir = await lsrDir(true);
  const useOpfs = !!dir;
  const vname = "v-" + String(manifest.version).replace(/[^a-zA-Z0-9_-]/g, "");
  let vdir = null;
  if (useOpfs) {
    try { await dir.removeEntry(vname, { recursive: true }); } catch { /* fresh install */ }
    vdir = await dir.getDirectoryHandle(vname, { create: true });
  }
  const cache = useOpfs ? null : await caches.open(DATA_CACHE);
  for (const key of FILE_KEYS) {
    const f = manifest.files[key];
    if (!f) continue;
    let handle = null, writable = null, at = 0;
    if (useOpfs) {
      const fh = await vdir.getFileHandle(f.name, { create: true });
      if (fh.createSyncAccessHandle) { handle = await fh.createSyncAccessHandle(); handle.truncate(0); }
      else writable = await fh.createWritable();
    }
    try {
      for (const part of f.parts) {
        const res = await fetch(new URL(part, base), { cache: "no-store", signal });
        if (!res.ok) throw new Error(`No se pudo descargar ${part} (error ${res.status})`);
        if (cache) {
          const blob = await res.blob();
          await cache.put(part, new Response(blob));
          done += blob.size;
          if (onProgress) onProgress(done, total, f.name);
          continue;
        }
        const reader = res.body.getReader();
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          if (handle) handle.write(value, { at });
          else await writable.write(value);
          at += value.byteLength;
          done += value.byteLength;
          if (onProgress) onProgress(done, total, f.name);
        }
      }
    } finally {
      if (handle) { handle.flush(); handle.close(); }
      if (writable) await writable.close();
    }
  }
  const installed = {
    version: manifest.version, built: manifest.built, size: total, storage: useOpfs ? "opfs" : "cache", dir: vname,
    files: Object.fromEntries(FILE_KEYS.filter((k) => manifest.files[k]).map((k) => [k, { name: manifest.files[k].name, size: manifest.files[k].size, parts: manifest.files[k].parts }])),
    bbox: manifest.bbox, center: manifest.center,
  };
  if (useOpfs) {
    await writeText(dir, "installed.json", JSON.stringify(installed));
    const old = [];
    for await (const [name] of dir.entries()) if (name.startsWith("v-") && name !== vname) old.push(name);
    for (const name of old) { try { await dir.removeEntry(name, { recursive: true }); } catch { /* in use */ } }
  } else {
    const meta = await caches.open(META_CACHE);
    await meta.put("installed.json", new Response(JSON.stringify(installed), { headers: { "content-type": "application/json" } }));
  }
  return installed;
}

export async function removeAll() {
  const r = await root();
  if (r) { try { await r.removeEntry(DIR, { recursive: true }); } catch { /* nothing stored */ } }
  try { await caches.delete(DATA_CACHE); await caches.delete(META_CACHE); } catch { /* no cache */ }
}

// Read a whole file from the network (parts joined), for use before the pack is downloaded.
export async function fetchFile(f, base, onProgress) {
  const chunks = [];
  let done = 0;
  for (const part of f.parts) {
    const res = await fetch(new URL(part, base));
    if (!res.ok) throw new Error(`No se pudo descargar ${part} (error ${res.status})`);
    const reader = res.body.getReader();
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      chunks.push(value);
      done += value.byteLength;
      if (onProgress) onProgress(done, f.size);
    }
  }
  return new Blob(chunks);
}

// PMTiles source that reads the local file or, before download, byte ranges across the remote parts.
export class PackSource {
  constructor(key) { this.key = key; this.file = null; this.remote = null; }
  setFile(file) { this.file = file; }
  setRemote(f, base) { this.remote = { parts: f.parts.map((p) => new URL(p, base).href), partSize: f.partSize, size: f.size }; }
  getKey() { return this.key; }
  async getBytes(offset, length, signal) {
    if (this.file) return { data: await this.file.slice(offset, offset + length).arrayBuffer() };
    if (!this.remote) throw new Error("El mapa no está disponible");
    const { parts, partSize, size } = this.remote;
    length = Math.max(0, Math.min(length, size - offset));
    const out = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const pos = offset + filled;
      const pi = Math.floor(pos / partSize);
      const inPart = pos - pi * partSize;
      const n = Math.min(length - filled, partSize - inPart);
      const res = await fetch(parts[pi], { headers: { range: `bytes=${inPart}-${inPart + n - 1}` }, signal });
      if (res.status !== 206 && res.status !== 200) throw new Error(`Error ${res.status} al leer el mapa`);
      let buf = new Uint8Array(await res.arrayBuffer());
      if (res.status === 200) buf = buf.subarray(inPart, inPart + n); // the server ignored the range
      out.set(buf.subarray(0, n), filled);
      filled += n;
    }
    return { data: out.buffer };
  }
}
