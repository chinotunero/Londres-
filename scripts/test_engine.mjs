// Smoke tests for the routing engine against a built data folder.
// Usage: node scripts/test_engine.mjs DATA_DIR [lat,lon lat,lon]
import { readFileSync } from "node:fs";
import { Engine, distM } from "../web/js/engine.js";

const dir = process.argv[2];
if (!dir) { console.error("Uso: node scripts/test_engine.mjs CARPETA_DATOS"); process.exit(1); }
const read = (f) => readFileSync(`${dir}/${f}`);
const eng = new Engine();
let t = Date.now();
const gb = read("graph.bin");
eng.loadGraph(gb.buffer.slice(gb.byteOffset, gb.byteOffset + gb.byteLength));
eng.loadTransit(JSON.parse(read("transit.json")));
eng.loadSearch(JSON.parse(read("search.json")));
eng.loadAddr(JSON.parse(read("addr.json")));
console.log(`cargado en ${Date.now() - t} ms: ${eng.N} nodos, ${eng.E} tramos, ${eng.stops.length} paradas, ${eng.routes.length} recorridos`);

let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "OK  " : "FALLO"} ${msg}`); if (!ok) fails++; };

let A, B;
if (process.argv[4]) {
  const p = (s) => { const [la, lo] = s.split(",").map(Number); return { lat: la, lon: lo }; };
  A = { ...p(process.argv[3]), name: "Origen" }; B = { ...p(process.argv[4]), name: "Destino" };
} else {
  const [b0, b1, b2, b3] = eng.bbox;
  A = { lat: b0 + (b2 - b0) * 0.3, lon: b1 + (b3 - b1) * 0.3, name: "Origen" };
  B = { lat: b0 + (b2 - b0) * 0.7, lon: b1 + (b3 - b1) * 0.7, name: "Destino" };
}
const sa = eng.snap(A.lat, A.lon);
check(sa && sa.d < 600, `snap origen a ${sa && sa.d.toFixed(1)} m`);

t = Date.now();
const w = eng.walkPath(eng.snap(A.lat, A.lon), eng.snap(B.lat, B.lon), 60000);
check(!!w, `ruta a pie en ${Date.now() - t} ms`);
if (w) {
  const leg = eng.walkLeg(w.trav, "Origen", "Destino");
  const straight = distM(A.lat, A.lon, B.lat, B.lon);
  check(leg.dist >= straight * 0.9 && leg.dist < straight * 3, `distancia ${leg.dist.toFixed(0)} m (línea recta ${straight.toFixed(0)} m)`);
  check(leg.maneuvers[0].type === "depart" && leg.maneuvers.at(-1).type === "arrive", `${leg.maneuvers.length} instrucciones`);
  let maxGap = 0;
  for (let i = 1; i < leg.coords.length; i++) maxGap = Math.max(maxGap, distM(leg.coords[i - 1][1], leg.coords[i - 1][0], leg.coords[i][1], leg.coords[i][0]));
  check(maxGap < 400, `geometría continua (salto máximo ${maxGap.toFixed(0)} m)`);
  check(leg.maneuvers.every((m, i, a) => i === 0 || m.at >= a[i - 1].at), "instrucciones en orden");
  leg.maneuvers.slice(0, 14).forEach((m) => console.log(`      ${m.d.toFixed(0).padStart(5)} m  ${m.text}`));
}

t = Date.now();
const plan = eng.plan(A, B, { hour: 12 });
check(!plan.error, `plan en ${Date.now() - t} ms ${plan.error || ""}`);
for (const j of plan.journeys || []) {
  console.log(`   [${j.tag}] ${j.min.toFixed(0)} min, ${j.transfers} transbordos, ${j.walkM.toFixed(0)} m a pie`);
  for (const l of j.legs) {
    if (l.type === "walk") console.log(`      a pie ${l.dist.toFixed(0)} m (${l.min.toFixed(1)} min) ${l.from} → ${l.to}${l.transfer ? " (transbordo)" : ""}`);
    else console.log(`      ${l.label} hacia ${l.headsign}: ${l.from.name} → ${l.to.name}, ${l.nStops} paradas, ${l.min.toFixed(1)} min`);
  }
  for (let i = 1; i < j.legs.length; i++) {
    const p = j.legs[i - 1].coords.at(-1), q = j.legs[i].coords[0];
    const gap = distM(p[1], p[0], q[1], q[0]);
    if (gap > 400) check(false, `salto de ${gap.toFixed(0)} m entre tramos ${i - 1} y ${i}`);
  }
}

const names = eng.items.filter((x) => x.kind === "poi").slice(0, 3).map((x) => x.name);
for (const n of names) {
  const r = eng.search(n.slice(0, Math.max(4, n.length - 2)), A);
  check(r.some((x) => x.name === n), `búsqueda "${n}" → ${r.slice(0, 3).map((x) => x.name).join(", ")}`);
}
const d = eng.describe(A.lat, A.lon);
check(!!d.name, `describe: ${d.name} (${d.sub})`);
console.log(fails ? `\n${fails} fallos` : "\nTodo correcto");
process.exit(fails ? 1 : 0);
