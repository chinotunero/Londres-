// Assemble the deployable site in OUT_DIR from the app sources, libraries, map assets and data pack.
// Usage: node scripts/assemble.mjs DATA_DIR TILES.pmtiles BASEMAPS_ASSETS_DIR OUT_DIR
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const [dataDir, tilesFile, assetsDir, out] = process.argv.slice(2);
if (!out) {
  console.error("Uso: node scripts/assemble.mjs CARPETA_DATOS MAPA.pmtiles CARPETA_BASEMAPS_ASSETS CARPETA_SALIDA");
  process.exit(1);
}
const PART = 90 * 1024 * 1024; // keeps every file well under GitHub's 100 MB limit
const root = fileURLToPath(new URL("..", import.meta.url));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, "web"), out, { recursive: true });

// libraries
const vendor = join(out, "vendor");
mkdirSync(vendor, { recursive: true });
const nm = join(root, "node_modules");
for (const [from, to, optional] of [
  ["maplibre-gl/dist/maplibre-gl.js", "maplibre-gl.js"], ["maplibre-gl/dist/maplibre-gl.css", "maplibre-gl.css"],
  ["maplibre-gl/LICENSE.txt", "LICENSE-maplibre.txt", true],
  ["pmtiles/dist/pmtiles.js", "pmtiles.js"], ["@protomaps/basemaps/dist/basemaps.js", "basemaps.js"],
]) {
  const src = join(nm, from);
  if (existsSync(src)) cpSync(src, join(vendor, to));
  else if (!optional) throw new Error("Falta " + src + " (ejecuta npm ci)");
}

// map fonts and sprites
const FONTS = ["Noto Sans Regular", "Noto Sans Medium", "Noto Sans Italic"];
const PRECACHE_RANGES = ["0-255", "256-511", "512-767", "768-1023", "1024-1279", "8192-8447", "8448-8703"];
for (const f of FONTS) cpSync(join(assetsDir, "fonts", f), join(out, "assets", "fonts", f), { recursive: true });
if (existsSync(join(assetsDir, "fonts", "OFL.txt"))) cpSync(join(assetsDir, "fonts", "OFL.txt"), join(out, "assets", "fonts", "OFL.txt"));
mkdirSync(join(out, "assets", "sprites", "v4"), { recursive: true });
for (const f of readdirSync(join(assetsDir, "sprites", "v4"))) {
  if (/^(light|dark)(@2x)?\.(json|png)$/.test(f)) cpSync(join(assetsDir, "sprites", "v4", f), join(out, "assets", "sprites", "v4", f));
}

// data pack, split into parts
const dataOut = join(out, "data");
mkdirSync(dataOut, { recursive: true });
const hash = createHash("sha256");
function addFile(key, src, name) {
  const size = statSync(src).size;
  const parts = [];
  const fd = openSync(src, "r");
  const buf = Buffer.alloc(16 * 1024 * 1024);
  try {
    for (let off = 0, i = 0; off < size; off += PART, i++) {
      const partName = `data/${name}.${String(i).padStart(3, "0")}`;
      const n = Math.min(PART, size - off);
      const chunks = [];
      let read = 0;
      while (read < n) {
        const r = readSync(fd, buf, 0, Math.min(buf.length, n - read), off + read);
        chunks.push(Buffer.from(buf.subarray(0, r)));
        read += r;
      }
      const data = Buffer.concat(chunks);
      writeFileSync(join(out, partName), data);
      hash.update(data);
      parts.push(partName);
    }
  } finally { closeSync(fd); }
  return [key, { name, size, partSize: PART, parts }];
}
const files = Object.fromEntries([
  tilesFile && existsSync(tilesFile) ? addFile("tiles", tilesFile, "londres.pmtiles") : null,
  addFile("graph", join(dataDir, "graph.bin"), "graph.bin"),
  addFile("transit", join(dataDir, "transit.json"), "transit.json"),
  addFile("search", join(dataDir, "search.json"), "search.json"),
  addFile("addr", join(dataDir, "addr.json"), "addr.json"),
].filter(Boolean));
const stats = JSON.parse(readFileSync(join(dataDir, "stats.json"), "utf8"));
const g = readFileSync(join(dataDir, "graph.bin"));
const N = g.readUInt32LE(8);
let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
for (let i = 0; i < N; i++) {
  const a = g.readInt32LE(28 + 4 * i), b = g.readInt32LE(28 + 4 * N + 4 * i);
  if (a < a0) a0 = a; if (a > a1) a1 = a; if (b < b0) b0 = b; if (b > b1) b1 = b;
}
const bbox = [b0 / 1e6, a0 / 1e6, b1 / 1e6, a1 / 1e6];
const london = bbox[0] < -0.13 && bbox[2] > -0.12 && bbox[1] < 51.5 && bbox[3] > 51.51;
const center = london ? [-0.1276, 51.5072] : [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
const version = `${stats.built}-${hash.digest("hex").slice(0, 8)}`;
writeFileSync(join(dataOut, "manifest.json"), JSON.stringify({ version, built: stats.built, bbox, center, partSize: PART, files, stats }, null, 1));

// service worker: app shell + latin glyphs + sprites
function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const rel = (p) => relative(out, p).split(sep).join("/");
const shell = walk(out).map(rel).filter((p) => !p.startsWith("data/") && !p.startsWith("assets/fonts/") && p !== "sw.js"
  && p !== ".nojekyll" && !p.endsWith(".map") && !p.endsWith(".txt"));
const glyphs = FONTS.flatMap((f) => PRECACHE_RANGES.map((r) => `assets/fonts/${encodeURIComponent(f)}/${r}.pbf`))
  .filter((p) => existsSync(join(out, decodeURIComponent(p))));
const appHash = createHash("sha256");
for (const p of shell) appHash.update(p).update(readFileSync(join(out, p)));
const appVersion = appHash.digest("hex").slice(0, 10);
const precache = ["./", ...shell, ...glyphs];
const sw = readFileSync(join(out, "sw.js"), "utf8").replace("__VERSION__", appVersion).replace("__PRECACHE__", JSON.stringify(precache));
writeFileSync(join(out, "sw.js"), sw);
writeFileSync(join(out, ".nojekyll"), "");

const total = Object.values(files).reduce((s, f) => s + f.size, 0);
console.log(`Sitio listo en ${out}`);
console.log(`  versión de datos ${version}, versión de app ${appVersion}`);
for (const [k, f] of Object.entries(files)) console.log(`  ${k.padEnd(8)} ${(f.size / 1e6).toFixed(1).padStart(7)} MB en ${f.parts.length} parte(s)`);
console.log(`  descarga sin conexión: ${(total / 1e6).toFixed(0)} MB; precarga de la app: ${precache.length} archivos`);
