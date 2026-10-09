// Londres Sin Red: offline routing and search engine.
// Pure module (no DOM) so it runs in a Web Worker and in Node for tests.

const RAD = Math.PI / 180;
export const WALK_MPM = 78; // metres per minute (~4.7 km/h)

export function distM(lat1, lon1, lat2, lon2) {
  const x = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * RAD) * 111320;
  const y = (lat2 - lat1) * 110574;
  return Math.hypot(x, y);
}
export function bearing(lat1, lon1, lat2, lon2) {
  const y = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * RAD);
  const x = lat2 - lat1;
  return (Math.atan2(y, x) / RAD + 360) % 360;
}
const CARD = ["norte", "noreste", "este", "sureste", "sur", "suroeste", "oeste", "noroeste"];
const cardinal = (b) => CARD[Math.round(b / 45) % 8];

export function norm(s) {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/['’`.]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

// ------------------------------------------------------------------ binary min-heap on typed arrays
class Heap {
  constructor(cap = 1024) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; this.topKey = 0; }
  clear() { this.n = 0; }
  push(key, val) {
    if (this.n === this.k.length) {
      const k = new Float64Array(this.n * 2); k.set(this.k); this.k = k;
      const v = new Int32Array(this.n * 2); v.set(this.v); this.v = v;
    }
    let i = this.n++;
    const K = this.k, V = this.v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= key) break;
      K[i] = K[p]; V[i] = V[p]; i = p;
    }
    K[i] = key; V[i] = val;
  }
  pop() { // returns the value; its key is left in this.topKey
    const K = this.k, V = this.v;
    const val = V[0]; this.topKey = K[0];
    const n = --this.n;
    if (n > 0) {
      const key = K[n], v = V[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && K[c + 1] < K[c]) c++;
        if (K[c] >= key) break;
        K[i] = K[c]; V[i] = V[c]; i = c;
      }
      K[i] = key; V[i] = v;
    }
    return val;
  }
}

// edge kinds (must match build_data.py)
const K_ROAD = 0, K_PATH = 1, K_STEPS = 2, K_PED = 3, K_CROSS = 4, K_SIDEWALK = 5, K_ELEV = 6, K_TRACK = 7;
const KIND_FACTOR = [1.0, 1.0, 1.5, 1.0, 1.0, 1.0, 1.0, 1.1];
const KIND_EXTRA = [0, 0, 5, 0, 12, 0, 40, 0]; // crossings: wait for the lights; lifts: wait for the lift

// Spanish names for landmarks people search for in Spanish (attached to the OSM object of the same name).
const ES_ALIASES = [
  ["Big Ben", "Big Ben"], ["Elizabeth Tower", "Big Ben"], ["Palace of Westminster", "Parlamento de Westminster"],
  ["Tower of London", "Torre de Londres"], ["Buckingham Palace", "Palacio de Buckingham"],
  ["British Museum", "Museo Británico"], ["St Paul's Cathedral", "Catedral de San Pablo"],
  ["Westminster Abbey", "Abadía de Westminster"], ["Natural History Museum", "Museo de Historia Natural"],
  ["Science Museum", "Museo de Ciencias"], ["Kensington Palace", "Palacio de Kensington"],
  ["ZSL London Zoo", "Zoo de Londres"], ["London Zoo", "Zoo de Londres"],
  ["Royal Observatory", "Observatorio de Greenwich"], ["Wembley Stadium", "Estadio de Wembley"],
  ["Royal Botanic Gardens, Kew", "Jardines de Kew"], ["Kew Gardens", "Jardines de Kew"],
  ["National Gallery", "Galería Nacional"], ["Trafalgar Square", "Plaza de Trafalgar"],
  ["Tower Bridge", "Puente de la Torre"], ["Heathrow Airport", "Aeropuerto de Heathrow"],
  ["London City Airport", "Aeropuerto London City"], ["Victoria and Albert Museum", "Museo Victoria y Alberto"],
  ["Hampton Court Palace", "Palacio de Hampton Court"], ["London Eye", "Noria London Eye"],
];

// ------------------------------------------------------------------ Engine
export class Engine {
  constructor() { this.ready = { graph: false, transit: false, search: false, addr: false }; }

  // ---------------------------------------------------------------- graph
  loadGraph(buf) {
    const dv = new DataView(buf);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== "LSRG") throw new Error("graph.bin no es válido");
    const N = dv.getUint32(8, true), E = dv.getUint32(12, true), G = dv.getUint32(16, true);
    const NB = dv.getUint32(20, true);
    let o = 28;
    const take = (Ctor, n) => { const a = new Ctor(buf, o, n); o += n * Ctor.BYTES_PER_ELEMENT; return a; };
    this.lat = take(Int32Array, N); this.lon = take(Int32Array, N);
    this.from = take(Uint32Array, E); this.to = take(Uint32Array, E);
    this.len = take(Float32Array, E); this.name = take(Int32Array, E); this.gs = take(Uint32Array, E + 1);
    this.kind = new Uint8Array(buf, o, E); o += E + ((4 - (E % 4)) % 4);
    this.geom = take(Int16Array, 2 * G);
    this.names = NB ? new TextDecoder().decode(new Uint8Array(buf, o, NB)).split("\n") : [];
    this.N = N; this.E = E;
    this.cost = new Float32Array(E);
    for (let e = 0; e < E; e++) this.cost[e] = this.len[e] * KIND_FACTOR[this.kind[e]] + KIND_EXTRA[this.kind[e]];
    // CSR adjacency in both directions; entries are edge*2 + (1 if traversed to->from)
    const deg = new Uint32Array(N + 1);
    for (let e = 0; e < E; e++) { deg[this.from[e] + 1]++; deg[this.to[e] + 1]++; }
    for (let i = 0; i < N; i++) deg[i + 1] += deg[i];
    const adj = new Int32Array(2 * E), fill = deg.slice(0, N);
    for (let e = 0; e < E; e++) { adj[fill[this.from[e]]++] = e * 2; adj[fill[this.to[e]]++] = e * 2 + 1; }
    this.adjStart = deg; this.adj = adj;
    // bounding box and an edge grid for snapping
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (let i = 0; i < N; i++) {
      const a = this.lat[i], b = this.lon[i];
      if (a < a0) a0 = a; if (a > a1) a1 = a; if (b < b0) b0 = b; if (b > b1) b1 = b;
    }
    this.bbox = [a0 / 1e6, b0 / 1e6, a1 / 1e6, b1 / 1e6];
    this.cellA = 1500; this.cellB = 2400; // in 1e-6 degrees, about 165 m
    this.gA0 = a0; this.gB0 = b0;
    this.gW = Math.floor((b1 - b0) / this.cellB) + 1; this.gH = Math.floor((a1 - a0) / this.cellA) + 1;
    const cells = this.gW * this.gH;
    const cnt = new Uint32Array(cells + 1);
    const span = (e, cb) => {
      let ma = Infinity, xa = -Infinity, mb = Infinity, xb = -Infinity;
      this.eachPoint(e, (a, b) => { if (a < ma) ma = a; if (a > xa) xa = a; if (b < mb) mb = b; if (b > xb) xb = b; });
      const r0 = Math.floor((ma - a0) / this.cellA), r1 = Math.floor((xa - a0) / this.cellA);
      const c0 = Math.floor((mb - b0) / this.cellB), c1 = Math.floor((xb - b0) / this.cellB);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cb(r * this.gW + c);
    };
    for (let e = 0; e < E; e++) span(e, (cell) => { cnt[cell + 1]++; });
    for (let i = 0; i < cells; i++) cnt[i + 1] += cnt[i];
    const items = new Int32Array(cnt[cells]), pos = cnt.slice(0, cells);
    for (let e = 0; e < E; e++) span(e, (cell) => { items[pos[cell]++] = e; });
    this.gridStart = cnt; this.gridItems = items;
    this.dist = new Float64Array(N); this.prev = new Int32Array(N);
    this.stamp = new Uint32Array(N); this.done = new Uint32Array(N); this.curStamp = 0;
    this.heap = new Heap(4096);
    this.ready.graph = true;
  }

  // iterate the points of edge e (1e-6 degrees) from its `from` node to its `to` node
  eachPoint(e, cb) {
    let a = this.lat[this.from[e]], b = this.lon[this.from[e]];
    cb(a, b);
    for (let g = this.gs[e]; g < this.gs[e + 1]; g++) { a += this.geom[2 * g]; b += this.geom[2 * g + 1]; cb(a, b); }
    cb(this.lat[this.to[e]], this.lon[this.to[e]]);
  }
  edgePts(e) { const p = []; this.eachPoint(e, (a, b) => p.push([a / 1e6, b / 1e6])); return p; }

  // nearest point on the walking network: {e, t (0..1 along the edge), d (metres), lat, lon}
  snap(lat, lon, maxM = 600, filter = null) {
    if (!this.ready.graph) return null;
    const A = Math.round(lat * 1e6), B = Math.round(lon * 1e6);
    const r0 = Math.floor((A - this.gA0) / this.cellA), c0 = Math.floor((B - this.gB0) / this.cellB);
    const kx = Math.cos(lat * RAD) * 0.11132, ky = 0.110574; // metres per 1e-6 degree
    let best = null, bd = maxM;
    const seen = new Set();
    const pts = [];
    for (let ring = 0; ring <= 40; ring++) {
      if ((ring - 1) * 160 > bd) break;
      for (let r = r0 - ring; r <= r0 + ring; r++) {
        for (let c = c0 - ring; c <= c0 + ring; c++) {
          if (Math.max(Math.abs(r - r0), Math.abs(c - c0)) !== ring) continue;
          if (r < 0 || c < 0 || r >= this.gH || c >= this.gW) continue;
          const cell = r * this.gW + c;
          for (let i = this.gridStart[cell]; i < this.gridStart[cell + 1]; i++) {
            const e = this.gridItems[i];
            if (seen.has(e)) continue;
            seen.add(e);
            if (filter && !filter(e)) continue;
            pts.length = 0;
            this.eachPoint(e, (a, b) => { pts.push(a, b); });
            let total = 0;
            for (let j = 2; j < pts.length; j += 2) total += Math.hypot((pts[j + 1] - pts[j - 1]) * kx, (pts[j] - pts[j - 2]) * ky);
            let acc = 0;
            for (let j = 2; j < pts.length; j += 2) {
              const ax = (pts[j - 1] - B) * kx, ay = (pts[j - 2] - A) * ky;
              const bx = (pts[j + 1] - B) * kx, by = (pts[j] - A) * ky;
              const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
              const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
              const d = Math.hypot(ax + t * dx, ay + t * dy);
              const sl = Math.sqrt(L2);
              if (d < bd) {
                bd = d;
                best = { e, t: total ? (acc + t * sl) / total : 0, d,
                  lat: (pts[j - 2] + t * (pts[j] - pts[j - 2])) / 1e6, lon: (pts[j - 1] + t * (pts[j + 1] - pts[j - 1])) / 1e6 };
              }
              acc += sl;
            }
          }
        }
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- shortest walking paths
  _begin() {
    this.curStamp++;
    if (this.curStamp >= 0xfffffff0) { this.stamp.fill(0); this.done.fill(0); this.curStamp = 1; }
    this.heap.clear();
  }
  _set(node, d, prev) {
    if (this.stamp[node] !== this.curStamp || d < this.dist[node]) {
      this.stamp[node] = this.curStamp; this.dist[node] = d; this.prev[node] = prev;
      return true;
    }
    return false;
  }

  // A* between two snapped points. Returns {cost, trav} or null.
  walkPath(sa, sb, maxCost = 40000) {
    this._begin();
    const H = this.heap;
    const tLat = sb.lat, tLon = sb.lon;
    const h = (n) => distM(this.lat[n] / 1e6, this.lon[n] / 1e6, tLat, tLon) * 0.98;
    const ca = this.cost[sa.e];
    if (this._set(this.from[sa.e], sa.t * ca, -1)) H.push(this.dist[this.from[sa.e]] + h(this.from[sa.e]), this.from[sa.e]);
    if (this._set(this.to[sa.e], (1 - sa.t) * ca, -2)) H.push(this.dist[this.to[sa.e]] + h(this.to[sa.e]), this.to[sa.e]);
    const ec = this.cost[sb.e], ub = this.from[sb.e], vb = this.to[sb.e];
    let best = Infinity, bestEnd = null;
    if (sa.e === sb.e) { best = Math.abs(sa.t - sb.t) * ec; bestEnd = "same"; }
    while (H.n) {
      const u = H.pop();
      const f = H.topKey;
      if (f >= best || f > maxCost) break;
      if (this.done[u] === this.curStamp) continue;
      this.done[u] = this.curStamp;
      const du = this.dist[u];
      if (u === ub && du + sb.t * ec < best) { best = du + sb.t * ec; bestEnd = "from"; }
      if (u === vb && du + (1 - sb.t) * ec < best) { best = du + (1 - sb.t) * ec; bestEnd = "to"; }
      for (let i = this.adjStart[u]; i < this.adjStart[u + 1]; i++) {
        const ed = this.adj[i], e = ed >> 1, rev = ed & 1;
        const v = rev ? this.from[e] : this.to[e];
        if (this.done[v] === this.curStamp) continue;
        if (this._set(v, du + this.cost[e], ed)) H.push(this.dist[v] + h(v), v);
      }
    }
    if (!bestEnd) return null;
    return { cost: best, trav: this._trace(sa, sb, bestEnd) };
  }

  // traversals [{e, t0, t1}] where t is the position along the edge (0 = from node, 1 = to node)
  _trace(sa, sb, end) {
    if (end === "same") return [{ e: sa.e, t0: sa.t, t1: sb.t }];
    const out = [{ e: sb.e, t0: end === "from" ? 0 : 1, t1: sb.t }];
    let node = end === "from" ? this.from[sb.e] : this.to[sb.e];
    for (let guard = 0; guard < 5e6; guard++) {
      const p = this.prev[node];
      if (p === -1) { out.push({ e: sa.e, t0: sa.t, t1: 0 }); break; }
      if (p === -2) { out.push({ e: sa.e, t0: sa.t, t1: 1 }); break; }
      const e = p >> 1, rev = p & 1;
      out.push(rev ? { e, t0: 1, t1: 0 } : { e, t0: 0, t1: 1 });
      node = rev ? this.to[e] : this.from[e];
    }
    out.reverse();
    return out.filter((s) => Math.abs(s.t1 - s.t0) * this.len[s.e] > 0.05);
  }

  // Dijkstra tree from a snapped point, limited to maxCost (metres). Returns a detached snapshot.
  walkTree(sa, maxCost) {
    this._begin();
    const H = this.heap;
    const ca = this.cost[sa.e];
    if (this._set(this.from[sa.e], sa.t * ca, -1)) H.push(this.dist[this.from[sa.e]], this.from[sa.e]);
    if (this._set(this.to[sa.e], (1 - sa.t) * ca, -2)) H.push(this.dist[this.to[sa.e]], this.to[sa.e]);
    const dist = new Map(), prev = new Map();
    while (H.n) {
      const u = H.pop();
      const du = H.topKey;
      if (du > this.dist[u] || this.done[u] === this.curStamp) continue;
      if (du > maxCost) break;
      this.done[u] = this.curStamp;
      dist.set(u, du); prev.set(u, this.prev[u]);
      for (let i = this.adjStart[u]; i < this.adjStart[u + 1]; i++) {
        const ed = this.adj[i], e = ed >> 1, rev = ed & 1;
        const v = rev ? this.from[e] : this.to[e];
        if (this.done[v] === this.curStamp) continue;
        if (this._set(v, du + this.cost[e], ed)) H.push(this.dist[v], v);
      }
    }
    return { snap: sa, dist, prev };
  }
  treeCost(tree, s) {
    const c = this.cost[s.e];
    let best = Infinity;
    if (tree.snap.e === s.e) best = Math.abs(tree.snap.t - s.t) * c;
    const a = tree.dist.get(this.from[s.e]), b = tree.dist.get(this.to[s.e]);
    if (a !== undefined) best = Math.min(best, a + s.t * c);
    if (b !== undefined) best = Math.min(best, b + (1 - s.t) * c);
    return best;
  }
  treeTrace(tree, s) { // traversals from the tree root to snapped point s
    const sa = tree.snap, c = this.cost[s.e];
    const a = tree.dist.get(this.from[s.e]), b = tree.dist.get(this.to[s.e]);
    const viaA = a === undefined ? Infinity : a + s.t * c, viaB = b === undefined ? Infinity : b + (1 - s.t) * c;
    if (sa.e === s.e && Math.abs(sa.t - s.t) * c <= Math.min(viaA, viaB)) return [{ e: s.e, t0: sa.t, t1: s.t }];
    const viaFrom = viaA <= viaB;
    const out = [{ e: s.e, t0: viaFrom ? 0 : 1, t1: s.t }];
    let node = viaFrom ? this.from[s.e] : this.to[s.e];
    for (let guard = 0; guard < 5e6; guard++) {
      const p = tree.prev.get(node);
      if (p === undefined) break;
      if (p === -1) { out.push({ e: sa.e, t0: sa.t, t1: 0 }); break; }
      if (p === -2) { out.push({ e: sa.e, t0: sa.t, t1: 1 }); break; }
      const e = p >> 1, rev = p & 1;
      out.push(rev ? { e, t0: 1, t1: 0 } : { e, t0: 0, t1: 1 });
      node = rev ? this.to[e] : this.from[e];
    }
    out.reverse();
    return out.filter((x) => Math.abs(x.t1 - x.t0) * this.len[x.e] > 0.05);
  }
  reverseTrav(trav) { return trav.slice().reverse().map((x) => ({ e: x.e, t0: x.t1, t1: x.t0 })); }

  // ---------------------------------------------------------------- walking leg: geometry and directions
  _slice(e, t0, t1) {
    const pts = this.edgePts(e);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
    const L = cum[cum.length - 1] || 1;
    const at = (t) => {
      const d = t * L;
      let i = 1;
      while (i < cum.length - 1 && cum[i] < d) i++;
      const seg = cum[i] - cum[i - 1] || 1, f = Math.max(0, Math.min(1, (d - cum[i - 1]) / seg));
      return { i, p: [pts[i - 1][0] + f * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + f * (pts[i][1] - pts[i - 1][1])] };
    };
    const lo = at(Math.min(t0, t1)), hi = at(Math.max(t0, t1));
    const out = [lo.p];
    for (let i = lo.i; i < hi.i; i++) out.push(pts[i]);
    out.push(hi.p);
    if (t1 < t0) out.reverse();
    return out;
  }

  _streetNear(lat, lon) {
    const s = this.snap(lat, lon, 25, (e) => this.name[e] >= 0 && this.kind[e] === K_ROAD);
    return s ? this.names[this.name[s.e]] : "";
  }

  // Coordinates ([lon, lat]) and turn-by-turn directions for a list of traversals.
  walkLeg(trav, fromName, toName) {
    if (!trav || !trav.length) return null;
    const segs = [];
    for (const x of trav) {
      const pts = this._slice(x.e, x.t0, x.t1);
      let L = 0;
      for (let i = 1; i < pts.length; i++) L += distM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
      const k = this.kind[x.e];
      segs.push({ pts, L, k, name: this.name[x.e] >= 0 ? this.names[this.name[x.e]] : "" });
    }
    // unnamed pavements take the name of the street they run along
    for (const s of segs) {
      if (!s.name && (s.k === K_SIDEWALK || s.k === K_PATH) && s.L > 15) {
        const m = s.pts[Math.floor(s.pts.length / 2)];
        const n = this._streetNear(m[0], m[1]);
        if (n) s.name = n;
      }
    }
    const label = (s) => s.k === K_STEPS ? "steps" : s.k === K_ELEV ? "elev" : s.k === K_CROSS ? "cross"
      : s.name ? "n:" + s.name : s.k === K_PED ? "ped" : s.k === K_SIDEWALK ? "side" : s.k === K_TRACK ? "track"
      : s.k === K_ROAD ? "road" : "path";
    const runs = [];
    for (const s of segs) {
      const lb = label(s);
      const last = runs[runs.length - 1];
      if (last && last.lb === lb) { last.pts.push(...s.pts.slice(1)); last.L += s.L; }
      else runs.push({ lb, k: s.k, name: s.name, pts: s.pts.slice(), L: s.L });
    }
    const merged = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && (last.lb === r.lb || (r.L < 10 && !["cross", "steps", "elev"].includes(r.lb)))) {
        last.pts.push(...r.pts.slice(1)); last.L += r.L;
      } else merged.push(r);
    }
    const coords = [], cum = [];
    const add = (p) => {
      const last = coords[coords.length - 1];
      const q = [+p[1].toFixed(6), +p[0].toFixed(6)];
      if (last && last[0] === q[0] && last[1] === q[1]) return;
      const d = last ? distM(last[1], last[0], q[1], q[0]) : 0;
      coords.push(q);
      cum.push((cum.length ? cum[cum.length - 1] : 0) + d);
    };
    const where = (r) => r.lb === "steps" ? "las escaleras" : r.lb === "elev" ? "el ascensor" : r.lb === "ped" ? "la zona peatonal"
      : r.lb === "side" ? "la acera" : r.lb === "track" ? "el camino" : r.lb === "road" ? "la calle"
      : r.lb === "cross" ? "el paso de peatones" : r.name ? r.name : "el camino peatonal";
    const bearAt = (pts, fromEnd) => { // bearing over ~15 m at the start or end of a run
      if (fromEnd) {
        const b = pts[pts.length - 1];
        let i = pts.length - 2;
        while (i > 0 && distM(pts[i][0], pts[i][1], b[0], b[1]) < 15) i--;
        return bearing(pts[Math.max(0, i)][0], pts[Math.max(0, i)][1], b[0], b[1]);
      }
      const a = pts[0];
      let i = 1;
      while (i < pts.length - 1 && distM(a[0], a[1], pts[i][0], pts[i][1]) < 15) i++;
      return bearing(a[0], a[1], pts[Math.min(i, pts.length - 1)][0], pts[Math.min(i, pts.length - 1)][1]);
    };
    const man = [];
    merged.forEach((r, idx) => {
      const startIdx = coords.length ? coords.length - 1 : 0;
      r.pts.forEach(add);
      if (idx === 0) {
        man.push({ type: "depart", at: 0, text: `Sal hacia el ${cardinal(bearAt(r.pts, false))} por ${where(r)}`, street: r.name });
        return;
      }
      const prev = merged[idx - 1];
      let a = bearAt(r.pts, false) - bearAt(prev.pts, true);
      a = ((a + 540) % 360) - 180;
      const side = a < 0 ? "izquierda" : "derecha";
      let type = null, text = "";
      if (r.lb === "cross") { type = "cross"; text = "Cruza la calle por el paso de peatones"; }
      else if (r.lb === "steps") { type = "steps"; text = "Toma las escaleras"; }
      else if (r.lb === "elev") { type = "elevator"; text = "Toma el ascensor"; }
      else if (Math.abs(a) < 25) {
        if (["cross", "steps", "elev"].includes(prev.lb)) { type = "straight"; text = `Sigue recto por ${where(r)}`; }
        else if (r.name && r.name !== prev.name) { type = "straight"; text = `Continúa por ${where(r)}`; }
      } else if (Math.abs(a) < 60) { type = a < 0 ? "slight-left" : "slight-right"; text = `Gira ligeramente a la ${side} hacia ${where(r)}`; }
      else if (Math.abs(a) < 150) { type = a < 0 ? "left" : "right"; text = `Gira a la ${side} ${r.name ? "en" : "hacia"} ${where(r)}`; }
      else { type = "uturn"; text = `Da la vuelta y sigue por ${where(r)}`; }
      if (type) man.push({ type, at: startIdx, text, street: r.name });
    });
    if (!coords.length) return null;
    man.push({ type: "arrive", at: coords.length - 1, text: toName ? `Has llegado a ${toName}` : "Has llegado", street: "" });
    for (const m of man) m.d = cum[m.at];
    const dist = cum[cum.length - 1];
    return { type: "walk", coords, cum, maneuvers: man, dist, min: dist / WALK_MPM, from: fromName || "", to: toName || "" };
  }

  // ---------------------------------------------------------------- transit
  loadTransit(data) {
    const S = data.stops.length;
    this.stops = data.stops.map((s) => ({ name: s[0], lat: s[1] / 1e6, lon: s[2] / 1e6, ref: s[3], ents: s[4] || [] }));
    this.entrances = (data.entrances || []).map((e) => ({ lat: e[0] / 1e6, lon: e[1] / 1e6, name: e[2] }));
    this.routes = data.routes.map((r) => {
      const g = []; let a = 0, b = 0;
      for (let i = 0; i < r.g.length; i += 2) { a += r.g[i]; b += r.g[i + 1]; g.push([a / 1e6, b / 1e6]); }
      return { ...r, g: undefined, geom: g };
    });
    this.base = new Int32Array(this.routes.length + 1);
    this.routes.forEach((r, i) => { this.base[i + 1] = this.base[i] + r.s.length; });
    this.posRoute = new Int32Array(this.base[this.routes.length]);
    this.routes.forEach((r, i) => { for (let j = 0; j < r.s.length; j++) this.posRoute[this.base[i] + j] = i; });
    this.stopRoutes = Array.from({ length: S }, () => []);
    this.routes.forEach((r, i) => r.s.forEach((s, j) => { if (j < r.s.length - 1) this.stopRoutes[s].push(i, j); }));
    this.sGrid = new Map();
    this.stops.forEach((s, i) => {
      const k = Math.floor(s.lat / 0.0027) * 100000 + Math.floor(s.lon / 0.0043);
      if (!this.sGrid.has(k)) this.sGrid.set(k, []);
      this.sGrid.get(k).push(i);
    });
    this.accessCache = new Map();
    this.transferCache = new Map();
    this.ready.transit = true;
  }
  stopsNear(lat, lon, radius) {
    const out = [];
    const r0 = Math.floor(lat / 0.0027), c0 = Math.floor(lon / 0.0043);
    const R = Math.ceil(radius / 290);
    for (let r = r0 - R; r <= r0 + R; r++) for (let c = c0 - R; c <= c0 + R; c++) {
      const l = this.sGrid.get(r * 100000 + c);
      if (!l) continue;
      for (const i of l) { const d = distM(lat, lon, this.stops[i].lat, this.stops[i].lon); if (d <= radius) out.push([i, d]); }
    }
    return out;
  }
  // ways to reach a stop from the street: [{snap, extra (minutes), label}]
  access(s) {
    let a = this.accessCache.get(s);
    if (a) return a;
    a = [];
    const st = this.stops[s];
    for (const ei of st.ents) {
      const en = this.entrances[ei];
      const sn = en && this.snap(en.lat, en.lon, 120);
      if (sn) a.push({ snap: sn, extra: 1.5 + distM(en.lat, en.lon, st.lat, st.lon) * 1.3 / WALK_MPM, label: en.name ? `entrada ${en.name}` : "entrada de la estación" });
    }
    const sn = this.snap(st.lat, st.lon, 250);
    if (sn) a.push({ snap: sn, extra: st.ents.length ? 1.5 : sn.d / WALK_MPM, label: "" });
    this.accessCache.set(s, a);
    return a;
  }
  transfers(s) {
    let t = this.transferCache.get(s);
    if (t) return t;
    const st = this.stops[s];
    t = [];
    for (const [j, d] of this.stopsNear(st.lat, st.lon, 320)) if (j !== s) t.push(j, 1.5 + d * 1.35 / WALK_MPM);
    this.transferCache.set(s, t);
    return t;
  }
  routeAllowed(r, o) {
    const bus = r.m === "bus" || r.m === "trolleybus";
    if (o.noBus && bus) return false;
    if (o.onlyBus && !bus) return false;
    const h = o.hour ?? -1;
    if (h < 0) return !r.night;
    if (r.night) return h >= 23 || h < 5;
    if (h >= 1 && h < 5 && !bus) {
      // only some Tube lines run all night, on Friday and Saturday nights
      return r.m === "subway" && !!o.weekendNight && /victoria|jubilee|central|northern|piccadilly/i.test(r.l);
    }
    return true;
  }

  // Plan journeys from a to b ({lat, lon, name}). Returns {journeys} or {error}.
  plan(a, b, opts = {}) {
    if (!this.ready.graph) return { error: "Todavía no se han cargado los datos de calles." };
    const sa = this.snap(a.lat, a.lon), sb = this.snap(b.lat, b.lon);
    if (!sa) return { error: "El origen está fuera de la zona del mapa." };
    if (!sb) return { error: "El destino está fuera de la zona del mapa." };
    const maxWalk = (opts.maxWalkMin || 15) * WALK_MPM;
    const out = [];
    const direct = distM(a.lat, a.lon, b.lat, b.lon);
    if (direct < 12000 || opts.walkOnly) {
      const w = this.walkPath(sa, sb, 30000);
      if (w) {
        const leg = this.walkLeg(w.trav, a.name, b.name);
        if (leg) out.push(this._journey([leg], "A pie"));
      }
    }
    if (this.ready.transit && direct > 350 && !opts.walkOnly) {
      const ta = this.walkTree(sa, maxWalk);
      const tb = this.walkTree(sb, maxWalk);
      const variants = [
        { tag: "Más rápida", pen: 2 },
        { tag: "Menos transbordos", pen: 10 },
        { tag: "Sin autobús", pen: 3, noBus: true },
        { tag: "Solo autobús", pen: 3, onlyBus: true },
      ];
      const seen = new Set(out.map((j) => j.sig));
      for (const v of variants) {
        if (opts.noBus && v.onlyBus) continue;
        const j = this._transit(a, b, ta, tb, { ...opts, ...v, noBus: opts.noBus || v.noBus });
        if (j && !seen.has(j.sig)) { seen.add(j.sig); out.push(j); }
      }
    }
    if (!out.length) return { error: "No encuentro ninguna ruta entre esos dos puntos." };
    out.sort((x, y) => x.min - y.min);
    // drop alternatives that are much slower than the best, but keep walking if it is reasonable
    const best = out[0].min;
    const keep = out.filter((j, i) => i === 0 || j.min <= best * 1.8 + 10 || (j.tag === "A pie" && j.min < 45));
    if (keep[0].tag !== "A pie") keep[0].tag = "Más rápida";
    return { journeys: keep.slice(0, opts.max || 4) };
  }

  _journey(legs, tag) {
    const min = legs.reduce((s, l) => s + l.min, 0);
    const walks = legs.filter((l) => l.type === "walk");
    const rides = legs.filter((l) => l.type === "ride");
    return { legs, min, tag, walkMin: walks.reduce((s, l) => s + l.min, 0), walkM: walks.reduce((s, l) => s + l.dist, 0),
      transfers: Math.max(0, rides.length - 1), sig: rides.length ? rides.map((r) => r.routeId).join(">") : "walk" };
  }

  _transit(a, b, ta, tb, o) {
    const S = this.stops.length, P = this.base[this.routes.length], NS = S + P;
    const dist = new Float64Array(NS).fill(Infinity);
    const prev = new Int32Array(NS).fill(-1);
    const how = new Int8Array(NS); // 1 from origin, 2 board, 3 ride, 4 alight, 5 transfer walk
    const acc = new Int32Array(S).fill(-1);
    const H = new Heap(4096);
    const maxWalk = (o.maxWalkMin || 15) * WALK_MPM;
    for (const [s] of this.stopsNear(a.lat, a.lon, maxWalk)) {
      let best = Infinity, bi = -1;
      this.access(s).forEach((ap, i) => { const c = this.treeCost(ta, ap.snap) / WALK_MPM + ap.extra; if (c < best) { best = c; bi = i; } });
      if (best < Infinity && best < dist[s]) { dist[s] = best; how[s] = 1; acc[s] = bi; H.push(best, s); }
    }
    const dest = new Map();
    for (const [s] of this.stopsNear(b.lat, b.lon, maxWalk)) {
      let best = Infinity, bi = -1;
      this.access(s).forEach((ap, i) => { const c = this.treeCost(tb, ap.snap) / WALK_MPM + ap.extra; if (c < best) { best = c; bi = i; } });
      if (best < Infinity) dest.set(s, [best, bi]);
    }
    if (!dest.size || !H.n) return null;
    let best = Infinity, bestStop = -1;
    const routes = this.routes;
    while (H.n) {
      const x = H.pop();
      const c = H.topKey;
      if (c > dist[x]) continue;
      if (c >= best) break;
      if (x < S) {
        const dd = dest.get(x);
        if (dd && how[x] !== 1 && c + dd[0] < best) { best = c + dd[0]; bestStop = x; }
        const sr = this.stopRoutes[x];
        for (let k = 0; k < sr.length; k += 2) {
          const ri = sr[k], j = sr[k + 1], r = routes[ri];
          if (!this.routeAllowed(r, o)) continue;
          const st = S + this.base[ri] + j;
          const nc = c + Math.min(r.h / 2, 12) + 0.5 + o.pen;
          if (nc < dist[st]) { dist[st] = nc; prev[st] = x; how[st] = 2; H.push(nc, st); }
        }
        if (how[x] !== 5) {
          const tr = this.transfers(x);
          for (let k = 0; k < tr.length; k += 2) {
            const y = tr[k], nc = c + tr[k + 1];
            if (nc < dist[y]) { dist[y] = nc; prev[y] = x; how[y] = 5; H.push(nc, y); }
          }
        }
      } else {
        const p = x - S, ri = this.posRoute[p], j = p - this.base[ri], r = routes[ri];
        if (j + 1 < r.s.length) {
          const nx = x + 1, nc = c + r.seg[j] / (r.v * 1000 / 60);
          if (nc < dist[nx]) { dist[nx] = nc; prev[nx] = x; how[nx] = 3; H.push(nc, nx); }
        }
        if (how[x] === 3) {
          const s = r.s[j];
          if (c < dist[s]) { dist[s] = c; prev[s] = x; how[s] = 4; H.push(c, s); }
        }
      }
    }
    if (bestStop < 0) return null;
    const chain = [];
    for (let x = bestStop; x >= 0; x = prev[x]) { chain.push(x); if (how[x] === 1) break; }
    chain.reverse();
    const stopObj = (s) => ({ name: this.stops[s].name || "Parada", lat: this.stops[s].lat, lon: this.stops[s].lon, ref: this.stops[s].ref });
    const legs = [];
    const s0 = chain[0];
    const ap0 = this.access(s0)[acc[s0]];
    const w0 = this.walkLeg(this.treeTrace(ta, ap0.snap), a.name, this.stops[s0].name);
    if (w0) { w0.min += ap0.extra; w0.entrance = ap0.label; legs.push(w0); }
    for (let i = 0; i < chain.length; i++) {
      const x = chain[i];
      if (x >= S && how[x] === 2) {
        const ri = this.posRoute[x - S], r = routes[ri];
        const j0 = x - S - this.base[ri];
        let k = i;
        while (k + 1 < chain.length && chain[k + 1] >= S && how[chain[k + 1]] === 3) k++;
        const j1 = chain[k] - S - this.base[ri];
        legs.push(this._rideLeg(r, j0, j1, stopObj));
        i = k;
      } else if (x < S && how[x] === 5) {
        const from = chain[i - 1];
        const fa = this.access(from), tA = this.access(x);
        const w = fa.length && tA.length ? this.walkPath(fa[fa.length - 1].snap, tA[tA.length - 1].snap, 3000) : null;
        const leg = w && this.walkLeg(w.trav, this.stops[from].name, this.stops[x].name);
        const m = dist[x] - dist[from];
        if (leg) { leg.min = m; leg.transfer = true; legs.push(leg); }
        else {
          const A = this.stops[from], B = this.stops[x], d = distM(A.lat, A.lon, B.lat, B.lon);
          legs.push({ type: "walk", transfer: true, coords: [[A.lon, A.lat], [B.lon, B.lat]], cum: [0, d], dist: d, min: m,
            maneuvers: [{ type: "depart", at: 0, d: 0, text: `Camina hasta ${B.name || "la otra parada"}`, street: "" },
              { type: "arrive", at: 1, d, text: `Has llegado a ${B.name || "la parada"}`, street: "" }], from: A.name, to: B.name });
        }
      }
    }
    const dd = dest.get(bestStop);
    const apN = this.access(bestStop)[dd[1]];
    const wN = this.walkLeg(this.reverseTrav(this.treeTrace(tb, apN.snap)), this.stops[bestStop].name, b.name);
    if (wN) { wN.min += apN.extra; wN.entrance = apN.label; legs.push(wN); }
    return this._journey(legs.filter((l) => l.type === "ride" || l.dist > 8 || l.transfer), o.tag);
  }

  _rideLeg(r, j0, j1, stopObj) {
    let ride = 0;
    for (let j = j0; j < j1; j++) ride += r.seg[j] / (r.v * 1000 / 60);
    const wait = Math.min(r.h / 2, 12) + 0.5;
    const g0 = r.gi[j0], g1 = r.gi[j1];
    const sA = this.stops[r.s[j0]], sB = this.stops[r.s[j1]];
    let pts = [[sA.lat, sA.lon]];
    if (g1 > g0) pts = pts.concat(r.geom.slice(g0 + 1, g1 + 1));
    pts.push([sB.lat, sB.lon]);
    const stops = [];
    for (let j = j0; j <= j1; j++) stops.push(stopObj(r.s[j]));
    let dist = 0;
    for (let k = 1; k < pts.length; k++) dist += distM(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1]);
    return {
      type: "ride", mode: r.m, label: r.l, ref: r.r, color: r.c, network: r.n, headsign: r.to, headway: r.h,
      routeId: r.id, from: stops[0], to: stops[stops.length - 1], stops, nStops: j1 - j0,
      coords: pts.map((p) => [+p[1].toFixed(6), +p[0].toFixed(6)]), dist, wait, ride, min: wait + ride,
    };
  }

  // ---------------------------------------------------------------- search
  loadSearch(data) {
    this.items = data.items.map((x) => ({ name: x[0], kind: x[1], lat: x[2] / 1e6, lon: x[3] / 1e6, sub: x[4], alt: x[5] || "" }));
    const idx = new Map();
    this.items.forEach((it) => { if (it.kind !== "stop" && it.kind !== "street") { const k = norm(it.name); if (!idx.has(k)) idx.set(k, it); } });
    for (const [en, es] of ES_ALIASES) { const it = idx.get(norm(en)); if (it) it.alt = (it.alt ? it.alt + " " : "") + es; }
    for (const it of this.items) it.key = " " + norm(it.name + " " + it.alt) + " ";
    this.places = data.places.map((p) => ({ name: p[0], lat: p[1] / 1e6, lon: p[2] / 1e6, rank: p[3] }));
    this.ready.search = true;
  }
  loadAddr(data) {
    this.addrStreets = data.streets.map((s) => ({ name: s[0], key: " " + norm(s[0]) + " ", flat: s[1] }));
    this.postcodes = new Map(data.postcodes.map((p) => [p[0].replace(/\s+/g, ""), { code: p[0], lat: p[1] / 1e6, lon: p[2] / 1e6 }]));
    this.ready.addr = true;
  }
  area(lat, lon) {
    if (!this.places) return "";
    let best = "", bd = 2500;
    for (const p of this.places) {
      if (p.rank < 2) continue;
      if (Math.abs(p.lat - lat) > 0.03 || Math.abs(p.lon - lon) > 0.05) continue;
      const d = distM(lat, lon, p.lat, p.lon) * (p.rank >= 4 ? 1.4 : 1);
      if (d < bd) { bd = d; best = p.name; }
    }
    return best;
  }
  search(q, near, limit = 12) {
    const out = [];
    const raw = (q || "").trim();
    if (!raw) return out;
    const nq = norm(raw);
    const pc = raw.toUpperCase().replace(/\s+/g, "");
    if (this.postcodes && /^[A-Z]{1,2}\d[A-Z\d]?(\d[A-Z]{2})?$/.test(pc)) {
      const p = this.postcodes.get(pc);
      if (p) out.push({ name: p.code, sub: ["Código postal", this.area(p.lat, p.lon)].filter(Boolean).join(" · "), kind: "postcode", lat: p.lat, lon: p.lon, score: -100 });
    }
    const m = nq.match(/^(\d+[a-z]?)\s+(.+)$/);
    if (m && this.addrStreets) {
      const hn = m[1], sq = " " + m[2];
      for (const s of this.addrStreets) {
        if (!s.key.includes(sq)) continue;
        const f = s.flat;
        let a = 0, b = 0;
        for (let i = 0; i < f.length; i += 3) {
          a += f[i + 1]; b += f[i + 2];
          if (norm(String(f[i])) === hn) {
            const lat = a / 1e6, lon = b / 1e6;
            out.push({ name: `${f[i]} ${s.name}`, sub: ["Dirección", this.area(lat, lon)].filter(Boolean).join(" · "), kind: "address", lat, lon,
              score: -50 + (near ? Math.log1p(distM(near.lat, near.lon, lat, lon) / 1000) : 0) });
          }
        }
      }
    }
    if (this.items) {
      const toks = nq.split(" ").filter(Boolean);
      const KIND_W = { station: -6, place: -3, poi: -2, street: -1, stop: 3 };
      const cand = [];
      for (const it of this.items) {
        let sc = 0, ok = true;
        for (const t of toks) {
          const i = it.key.indexOf(" " + t);
          if (i < 0) { if (t.length > 2 && it.key.includes(t)) { sc += 4; continue; } ok = false; break; }
          sc += i === 0 ? 0 : 1;
        }
        if (!ok) continue;
        if (it.key.startsWith(" " + nq + " ")) sc -= 6; else if (it.key.startsWith(" " + nq)) sc -= 3;
        sc += (KIND_W[it.kind] || 0) + it.key.length / 40;
        if (near) sc += Math.log1p(distM(near.lat, near.lon, it.lat, it.lon) / 1000) * 1.6;
        cand.push([sc, it]);
      }
      cand.sort((x, y) => x[0] - y[0]);
      for (const [sc, it] of cand.slice(0, limit * 3)) {
        out.push({ name: it.name, sub: [it.sub, it.kind === "place" ? "" : this.area(it.lat, it.lon)].filter(Boolean).join(" · "),
          kind: it.kind, lat: it.lat, lon: it.lon, score: sc, alt: it.alt });
      }
    }
    out.sort((x, y) => x.score - y.score);
    const res = [];
    for (const r of out) {
      if (res.some((x) => norm(x.name) === norm(r.name) && distM(x.lat, x.lon, r.lat, r.lon) < 150)) continue;
      res.push(r);
      if (res.length >= limit) break;
    }
    return res;
  }

  // short human description of a point (for map taps and "my location")
  describe(lat, lon) {
    let name = "";
    if (this.items) {
      let bd = 35;
      for (const it of this.items) {
        if (it.kind === "street" || it.kind === "place") continue;
        if (Math.abs(it.lat - lat) > 0.0005 || Math.abs(it.lon - lon) > 0.0008) continue;
        const d = distM(lat, lon, it.lat, it.lon);
        if (d < bd) { bd = d; name = it.name; }
      }
    }
    let street = "";
    if (this.ready.graph) {
      const s = this.snap(lat, lon, 80, (e) => this.name[e] >= 0);
      if (s) street = this.names[this.name[s.e]];
    }
    const area = this.area(lat, lon);
    return { name: name || street || "Punto en el mapa", sub: [name ? street : "", area].filter(Boolean).join(" · ") };
  }
}
