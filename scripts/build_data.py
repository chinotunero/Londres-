#!/usr/bin/env python3
"""Convierte un extracto de OpenStreetMap (.osm.pbf) en los datos offline de Londres Sin Red.

Uso:  python3 scripts/build_data.py ENTRADA.osm.pbf CARPETA_SALIDA

Genera:
  graph.bin    red peatonal (calles, aceras, caminos, escaleras) para la navegación calle a calle
  transit.json paradas y recorridos de Metro, Overground, Elizabeth line, DLR, tranvía, tren, autobús y barco
  search.json  lugares, estaciones, paradas, calles y barrios para el buscador
  addr.json    direcciones (número + calle) y códigos postales
  stats.json   recuento de todo lo anterior
"""
import json
import math
import os
import re
import struct
import sys
import time
from array import array
from collections import defaultdict

import osmium

T0 = time.time()


def log(msg):
    print(f"[{time.time() - T0:7.1f}s] {msg}", flush=True)


# ---------------------------------------------------------------- geometry helpers
def dist_m(lat1, lon1, lat2, lon2):
    """Distance in metres between two points (equirectangular, fine at city scale)."""
    x = (lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2)) * 111320.0
    y = (lat2 - lat1) * 110574.0
    return math.hypot(x, y)


def simplify(pts, tol_m):
    """Douglas-Peucker on [(lat, lon), ...] with a tolerance in metres."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    k = math.cos(math.radians(pts[0][0])) * 111320.0
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a][1] * k, pts[a][0] * 110574.0
        bx, by = pts[b][1] * k, pts[b][0] * 110574.0
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i][1] * k, pts[i][0] * 110574.0
            if L2 == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
                d = math.hypot(px - ax - t * dx, py - ay - t * dy)
            if d > best:
                best, idx = d, i
        if best > tol_m:
            keep[idx] = True
            stack.append((a, idx))
            stack.append((idx, b))
    return [p for p, kp in zip(pts, keep) if kp]


def i6(v):
    return int(round(v * 1e6))


def enc_line(pts):
    """Delta-encode [(lat, lon)] as a flat list of 1e-6 degree integers."""
    out, plat, plon = [], 0, 0
    for lat, lon in pts:
        a, b = i6(lat), i6(lon)
        out += [a - plat, b - plon]
        plat, plon = a, b
    return out


# ---------------------------------------------------------------- tag rules
WALK_SKIP = {"motorway", "motorway_link", "construction", "proposed", "raceway", "bus_guideway",
             "escape", "abandoned", "platform", "corridor", "rest_area", "services", "disused"}
ROAD_KINDS = {"trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link", "tertiary",
              "tertiary_link", "unclassified", "residential", "living_street", "service", "road", "busway"}
K_ROAD, K_PATH, K_STEPS, K_PED, K_CROSS, K_SIDEWALK, K_ELEV, K_TRACK = range(8)


def walk_kind(t):
    hw = t.get("highway")
    if not hw or hw in WALK_SKIP:
        return None
    if t.get("area") == "yes" and hw != "pedestrian":
        return None
    foot = t.get("foot")
    if foot in ("no", "private", "use_sidepath"):
        return None
    if t.get("access") in ("no", "private") and foot not in ("yes", "designated", "permissive"):
        return None
    if hw == "steps":
        return K_STEPS
    if hw == "elevator":
        return K_ELEV
    if hw == "pedestrian":
        return K_PED
    if hw == "footway":
        fw = t.get("footway")
        if fw == "crossing":
            return K_CROSS
        if fw == "sidewalk":
            return K_SIDEWALK
        return K_PATH
    if hw in ("path", "bridleway", "cycleway"):
        return K_PATH
    if hw == "track":
        return K_TRACK
    if hw in ROAD_KINDS:
        if hw.startswith("trunk") and t.get("sidewalk") == "no" and foot != "yes":
            return None
        return K_ROAD
    return None


TRANSIT_ROUTES = {"bus", "trolleybus", "subway", "light_rail", "tram", "train", "ferry", "aerialway", "monorail"}
STOP_TAGS = (("public_transport", {"stop_position", "platform", "station", "stop_area"}),
             ("highway", {"bus_stop"}),
             ("railway", {"station", "halt", "stop", "tram_stop", "platform", "subway_entrance"}),
             ("amenity", {"ferry_terminal", "bus_station"}),
             ("aerialway", {"station"}))

CATS = {
    ("amenity", "restaurant"): "Restaurante", ("amenity", "cafe"): "Cafetería", ("amenity", "pub"): "Pub",
    ("amenity", "bar"): "Bar", ("amenity", "fast_food"): "Comida rápida", ("amenity", "hospital"): "Hospital",
    ("amenity", "pharmacy"): "Farmacia", ("amenity", "theatre"): "Teatro", ("amenity", "cinema"): "Cine",
    ("amenity", "place_of_worship"): "Lugar de culto", ("amenity", "school"): "Colegio",
    ("amenity", "university"): "Universidad", ("amenity", "college"): "Escuela", ("amenity", "library"): "Biblioteca",
    ("amenity", "bank"): "Banco", ("amenity", "police"): "Policía", ("amenity", "post_office"): "Correos",
    ("amenity", "marketplace"): "Mercado", ("amenity", "arts_centre"): "Centro de arte",
    ("amenity", "nightclub"): "Discoteca", ("amenity", "clinic"): "Clínica", ("amenity", "doctors"): "Médico",
    ("amenity", "dentist"): "Dentista", ("amenity", "townhall"): "Ayuntamiento", ("amenity", "toilets"): "Aseos",
    ("amenity", "community_centre"): "Centro cívico", ("amenity", "fuel"): "Gasolinera",
    ("amenity", "bus_station"): "Estación de autobuses", ("amenity", "ferry_terminal"): "Muelle",
    ("amenity", "concert_hall"): "Sala de conciertos", ("amenity", "embassy"): "Embajada",
    ("office", "diplomatic"): "Embajada",
    ("tourism", "museum"): "Museo", ("tourism", "attraction"): "Atracción", ("tourism", "hotel"): "Hotel",
    ("tourism", "hostel"): "Albergue", ("tourism", "gallery"): "Galería", ("tourism", "viewpoint"): "Mirador",
    ("tourism", "zoo"): "Zoo", ("tourism", "aquarium"): "Acuario", ("tourism", "theme_park"): "Parque temático",
    ("tourism", "guest_house"): "Pensión", ("tourism", "apartment"): "Apartamentos",
    ("tourism", "artwork"): "Obra de arte", ("tourism", "information"): "Información turística",
    ("leisure", "park"): "Parque", ("leisure", "garden"): "Jardín", ("leisure", "stadium"): "Estadio",
    ("leisure", "sports_centre"): "Polideportivo", ("leisure", "playground"): "Parque infantil",
    ("leisure", "nature_reserve"): "Reserva natural", ("leisure", "common"): "Parque",
    ("leisure", "fitness_centre"): "Gimnasio", ("leisure", "swimming_pool"): "Piscina",
    ("historic", "monument"): "Monumento", ("historic", "memorial"): "Monumento", ("historic", "castle"): "Castillo",
    ("historic", "building"): "Edificio histórico", ("historic", "church"): "Iglesia",
    ("shop", "supermarket"): "Supermercado", ("shop", "convenience"): "Tienda", ("shop", "mall"): "Centro comercial",
    ("shop", "department_store"): "Grandes almacenes", ("shop", "books"): "Librería", ("shop", "clothes"): "Ropa",
    ("shop", "bakery"): "Panadería", ("building", "cathedral"): "Catedral", ("building", "church"): "Iglesia",
}
CAT_KEYS = ("amenity", "tourism", "leisure", "historic", "shop", "office", "building")
PLACE_KINDS = {"city", "borough", "town", "suburb", "quarter", "neighbourhood", "village", "hamlet", "locality"}
SKIP_VALUES = {"yes", "parking", "bench", "waste_basket", "bicycle_parking", "telephone", "parking_space",
               "vending_machine", "post_box", "recycling", "charging_station", "motorcycle_parking", "grit_bin"}


def category(t):
    for k in CAT_KEYS:
        v = t.get(k)
        if v is None:
            continue
        c = CATS.get((k, v))
        if c:
            return c
        if k == "shop":
            return "Tienda"
        if k in ("amenity", "tourism", "historic", "leisure") and v not in SKIP_VALUES:
            return v.replace("_", " ").capitalize()
    return None


def is_stop(t):
    for k, vals in STOP_TAGS:
        if t.get(k) in vals:
            return True
    return False


# ---------------------------------------------------------------- pass 1: relations
class RelPass(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.routes = []
        self.need_ways = set()
        self.need_nodes = set()

    def relation(self, r):
        t = dict(r.tags)
        if t.get("type") != "route" or t.get("route") not in TRANSIT_ROUTES:
            return
        if t.get("disused") == "yes" or "disused:route" in t:
            return
        mem = []
        for m in r.members:
            mem.append((m.type, m.ref, m.role))
            if m.type == "w":
                self.need_ways.add(m.ref)
            elif m.type == "n":
                self.need_nodes.add(m.ref)
        self.routes.append({"id": r.id, "tags": t, "members": mem})


# ---------------------------------------------------------------- pass 2: nodes and ways
class MainPass(osmium.SimpleHandler):
    def __init__(self, need_nodes, need_ways):
        super().__init__()
        self.need_nodes, self.need_ways = need_nodes, need_ways
        self.stop_nodes = {}
        self.entrances = []
        self.walk_ways = []
        self.coords = {}
        self.member_ways = {}
        self.member_way_tags = {}
        self.search = []
        self.places = []
        self.addr = defaultdict(list)
        self.postcodes = defaultdict(lambda: [0.0, 0.0, 0])
        self.street_pts = defaultdict(list)

    def _things(self, t, lat, lon):
        name = t.get("name")
        hn, street = t.get("addr:housenumber"), t.get("addr:street")
        if hn and street:
            self.addr[street].append((hn, lat, lon))
        pc = t.get("addr:postcode")
        if pc:
            pc = re.sub(r"\s+", " ", pc.upper().strip())
            acc = self.postcodes[pc]
            acc[0] += lat
            acc[1] += lon
            acc[2] += 1
        if not name:
            return
        alt = t.get("name:es") or ""
        if t.get("place") in PLACE_KINDS:
            rank = {"city": 0, "borough": 1, "town": 2, "suburb": 2, "quarter": 3, "neighbourhood": 4,
                    "village": 3, "hamlet": 5, "locality": 5}[t["place"]]
            self.places.append((name, lat, lon, rank))
            self.search.append([name, "place", lat, lon, "Barrio" if rank > 1 else "Zona", alt])
            return
        if t.get("railway") in ("station", "halt") or t.get("public_transport") == "station":
            sub = "Estación"
            if t.get("station") == "subway" or t.get("subway") == "yes":
                sub = "Estación de metro"
            elif t.get("station") == "light_rail" or t.get("light_rail") == "yes":
                sub = "Estación de DLR"
            self.search.append([name, "station", lat, lon, sub, alt])
            return
        if t.get("railway") == "tram_stop":
            self.search.append([name, "station", lat, lon, "Parada de tranvía", alt])
            return
        if t.get("amenity") == "ferry_terminal":
            self.search.append([name, "station", lat, lon, "Muelle de barco", alt])
            return
        if t.get("highway") == "bus_stop":
            ref = t.get("local_ref") or t.get("naptan:Indicator") or ""
            self.search.append([name, "stop", lat, lon, ("Parada " + ref).strip(), alt])
            return
        cat = category(t)
        if cat:
            self.search.append([name, "poi", lat, lon, cat, alt])

    def node(self, n):
        if not n.location.valid():
            return
        t = n.tags
        nid = n.id
        lat, lon = n.location.lat, n.location.lon
        if nid in self.need_nodes or (len(t) and is_stop(t)):
            keep = {k: t.get(k) for k in ("name", "public_transport", "highway", "railway", "local_ref",
                                           "naptan:Indicator", "ref", "amenity", "platform_ref") if t.get(k)}
            self.stop_nodes[nid] = (lat, lon, keep)
        if len(t) == 0:
            return
        if t.get("railway") in ("subway_entrance", "train_station_entrance") or t.get("entrance") == "station":
            self.entrances.append((lat, lon, t.get("name") or t.get("ref") or ""))
        self._things(t, lat, lon)

    def way(self, w):
        t = w.tags
        wid = w.id
        need = wid in self.need_ways
        kind = walk_kind(t) if t.get("highway") else None
        named = len(t) and (t.get("name") or t.get("addr:housenumber") or t.get("addr:postcode"))
        if kind is None and not need and not named:
            return
        nodes = []
        for nd in w.nodes:
            if nd.location.valid():
                nodes.append((nd.ref, nd.location.lat, nd.location.lon))
        if len(nodes) < 2:
            return
        if need:
            self.member_ways[wid] = [(a, b) for _, a, b in nodes]
            if t.get("name") or t.get("ref"):
                self.member_way_tags[wid] = {"name": t.get("name") or "",
                                             "ref": t.get("ref") or t.get("local_ref") or ""}
        if kind is not None:
            ids = array("q")
            for ref, lat, lon in nodes:
                ids.append(ref)
                if ref not in self.coords:
                    self.coords[ref] = (i6(lat), i6(lon))
            name = t.get("name") or ""
            if not name and kind == K_ROAD and t.get("ref"):
                name = t.get("ref")
            self.walk_ways.append((kind, name, ids))
            if t.get("name") and kind in (K_ROAD, K_PED, K_PATH):
                mid = nodes[len(nodes) // 2]
                self.street_pts[t["name"]].append((mid[1], mid[2]))
        elif named and not t.get("highway") and not t.get("route") and not t.get("railway"):
            la = sum(p[1] for p in nodes) / len(nodes)
            lo = sum(p[2] for p in nodes) / len(nodes)
            self._things(t, la, lo)


# ---------------------------------------------------------------- graph building
def build_graph(mp, out_dir):
    log(f"vías peatonales: {len(mp.walk_ways):,}  nodos: {len(mp.coords):,}")
    use = defaultdict(int)
    for _, _, ids in mp.walk_ways:
        for r in ids:
            use[r] += 1
        use[ids[0]] += 2
        use[ids[-1]] += 2
    vid = {}

    def vertex(r):
        v = vid.get(r)
        if v is None:
            v = vid[r] = len(vid)
        return v

    names, name_idx = [], {}

    def nidx(s):
        if not s:
            return -1
        i = name_idx.get(s)
        if i is None:
            i = name_idx[s] = len(names)
            names.append(s)
        return i

    edges = []
    for kind, name, ids in mp.walk_ways:
        ni = nidx(name)
        start = 0
        for i in range(1, len(ids)):
            if use[ids[i]] >= 2 or i == len(ids) - 1:
                seg = ids[start:i + 1]
                pts = [mp.coords[r] for r in seg]
                L = 0.0
                for (a1, b1), (a2, b2) in zip(pts, pts[1:]):
                    L += dist_m(a1 / 1e6, b1 / 1e6, a2 / 1e6, b2 / 1e6)
                if L > 0.05 and (seg[0] != seg[-1] or L > 1):
                    edges.append((vertex(seg[0]), vertex(seg[-1]), L, ni, kind, pts))
                start = i
    n = len(vid)
    log(f"grafo bruto: {n:,} vértices, {len(edges):,} tramos")

    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for u, v, *_ in edges:
        ru, rv = find(u), find(v)
        if ru != rv:
            parent[ru] = rv
    size = defaultdict(int)
    for x in range(n):
        size[find(x)] += 1
    main = max(size, key=size.get) if size else 0
    keepv = [find(x) == main for x in range(n)]
    rev = [0] * n
    for r, v in vid.items():
        rev[v] = r
    # order vertices on a coarse grid so neighbours sit close in memory
    order = sorted((v for v in range(n) if keepv[v]),
                   key=lambda v: (mp.coords[rev[v]][0] // 2000, mp.coords[rev[v]][1] // 3000))
    newid = [-1] * n
    nodes_lat, nodes_lon = array("i"), array("i")
    for v in order:
        newid[v] = len(nodes_lat)
        la, lo = mp.coords[rev[v]]
        nodes_lat.append(la)
        nodes_lon.append(lo)
    edges = [(newid[u], newid[v], L, ni, k, pts) for u, v, L, ni, k, pts in edges if keepv[u]]
    log(f"componente principal: {len(nodes_lat):,} vértices, {len(edges):,} tramos")

    e_from, e_to, e_len, e_name, e_kind = array("I"), array("I"), array("f"), array("i"), bytearray()
    g_start, geom = array("I"), array("h")
    for u, v, L, ni, k, pts in edges:
        e_from.append(u)
        e_to.append(v)
        e_len.append(L)
        e_name.append(ni)
        e_kind.append(k)
        g_start.append(len(geom) // 2)
        mid = simplify([(a / 1e6, b / 1e6) for a, b in pts], 1.0)[1:-1]
        pa, pb = pts[0]
        for la, lo in mid:
            a, b = i6(la), i6(lo)
            while abs(a - pa) > 32000 or abs(b - pb) > 32000:
                sa, sb = pa + max(-32000, min(32000, a - pa)), pb + max(-32000, min(32000, b - pb))
                geom.append(sa - pa)
                geom.append(sb - pb)
                pa, pb = sa, sb
            geom.append(a - pa)
            geom.append(b - pb)
            pa, pb = a, b
    g_start.append(len(geom) // 2)

    nb = "\n".join(names).encode("utf-8")
    E = len(e_from)
    path = os.path.join(out_dir, "graph.bin")
    with open(path, "wb") as f:
        f.write(b"LSRG")
        f.write(struct.pack("<6I", 1, len(nodes_lat), E, len(geom) // 2, len(nb), len(names)))
        for arr in (nodes_lat, nodes_lon, e_from, e_to, e_len, e_name, g_start):
            f.write(arr.tobytes())
        f.write(bytes(e_kind))
        f.write(b"\0" * ((4 - E % 4) % 4))
        f.write(geom.tobytes())
        if (len(geom) * 2) % 4:
            f.write(b"\0\0")
        f.write(nb)
    log(f"graph.bin: {os.path.getsize(path) / 1e6:.1f} MB, {len(names):,} nombres")
    return len(nodes_lat), E


# ---------------------------------------------------------------- transit
DEFAULTS = {  # mode: (km/h including stops, headway minutes)
    "subway": (32, 4), "light_rail": (28, 5), "tram": (20, 8), "train": (45, 15), "ferry": (22, 20),
    "bus": (12, 10), "trolleybus": (12, 10), "aerialway": (15, 5), "monorail": (25, 8)}
MODE_LABEL = {"subway": "Metro", "light_rail": "DLR", "tram": "Tranvía", "train": "Tren", "ferry": "Barco",
              "bus": "Autobús", "trolleybus": "Autobús", "aerialway": "Teleférico", "monorail": "Monorraíl"}


def parse_interval(v):
    if not v:
        return None
    v = v.strip()
    m = re.match(r"^(\d{1,2}):(\d{2})(?::\d{2})?", v)
    if m:
        mins = int(m.group(1)) * 60 + int(m.group(2))
        return mins if 0 < mins <= 120 else None
    m = re.match(r"^(\d{1,3})", v)
    if m:
        mins = int(m.group(1))
        return mins if 0 < mins <= 120 else None
    return None


def chain_ways(way_lists):
    """Join ordered member ways into one polyline, flipping ways as needed."""
    line, first_len = [], 0
    for pts in way_lists:
        if not line:
            line = list(pts)
            first_len = len(line)
            continue
        if line[-1] == pts[0]:
            line += pts[1:]
        elif line[-1] == pts[-1]:
            line += pts[::-1][1:]
        elif len(line) == first_len and line[0] == pts[0]:
            line = line[::-1] + pts[1:]
        elif len(line) == first_len and line[0] == pts[-1]:
            line = line[::-1] + pts[::-1][1:]
        else:
            d0 = dist_m(*line[-1], *pts[0])
            d1 = dist_m(*line[-1], *pts[-1])
            line += pts if d0 <= d1 else pts[::-1]
    return line


def cumlen(line):
    cum = [0.0]
    for a, b in zip(line, line[1:]):
        cum.append(cum[-1] + dist_m(*a, *b))
    return cum


def project(line, cum, lat, lon, start):
    """(segment index, distance along, offset) of the closest point to (lat, lon) at or after `start`."""
    best, bi, bd = 1e18, start, 0.0
    k = math.cos(math.radians(lat)) * 111320.0
    px, py = lon * k, lat * 110574.0
    for i in range(start, len(line) - 1):
        ax, ay = line[i][1] * k, line[i][0] * 110574.0
        bx, by = line[i + 1][1] * k, line[i + 1][0] * 110574.0
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
        d = math.hypot(px - ax - t * dx, py - ay - t * dy)
        if d < best:
            best, bi, bd = d, i, cum[i] + t * (cum[i + 1] - cum[i])
    return bi, bd, best


def build_transit(rp, mp, out_dir):
    stops, stop_key = [], {}

    def platform_way_info(ref):
        pts = mp.member_ways.get(ref)
        if not pts:
            return None
        la = sum(p[0] for p in pts) / len(pts)
        lo = sum(p[1] for p in pts) / len(pts)
        return (la, lo, mp.member_way_tags.get(ref, {}))

    ent_grid = defaultdict(list)
    for i, (la, lo, nm) in enumerate(mp.entrances):
        ent_grid[(int(la / 0.004), int(lo / 0.004))].append(i)

    def near_entrances(la, lo, radius):
        out = []
        gx, gy = int(la / 0.004), int(lo / 0.004)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for i in ent_grid.get((gx + dx, gy + dy), ()):
                    e = mp.entrances[i]
                    if dist_m(la, lo, e[0], e[1]) <= radius:
                        out.append(i)
        return out

    def get_stop(key, la, lo, name, ref, rail):
        s = stop_key.get(key)
        if s is None:
            s = stop_key[key] = len(stops)
            ents = near_entrances(la, lo, 350) if rail else []
            stops.append([name or "", i6(la), i6(lo), ref or "", ents])
        elif name and not stops[s][0]:
            stops[s][0] = name
        return s

    routes, skipped = [], 0
    for r in rp.routes:
        t = r["tags"]
        mode = t["route"]
        rail = mode in ("subway", "light_rail", "train", "tram", "monorail")
        cand = []
        has_roles = any(m[2].startswith("stop") or m[2].startswith("platform") for m in r["members"])
        for typ, ref, role in r["members"]:
            kind = None
            if role.startswith("stop"):
                kind = "stop"
            elif role.startswith("platform"):
                kind = "platform"
            elif not has_roles and typ == "n" and role == "":
                info = mp.stop_nodes.get(ref)
                if info and is_stop(info[2]):
                    kind = "stop"
            if not kind:
                continue
            info = mp.stop_nodes.get(ref) if typ == "n" else platform_way_info(ref) if typ == "w" else None
            if not info:
                continue
            la, lo, tg = info
            name = tg.get("name") or ""
            sref = tg.get("local_ref") or tg.get("naptan:Indicator") or tg.get("ref") or ""
            cand.append((kind, f"{typ}{ref}", la, lo, name, sref))
        groups = []
        for c in cand:
            g = groups[-1] if groups else None
            if g and all(x[0] != c[0] for x in g) and dist_m(g[0][2], g[0][3], c[2], c[3]) < 90:
                g.append(c)
            else:
                groups.append([c])
        seq = []
        for g in groups:
            plat = next((x for x in g if x[0] == "platform"), None)
            stp = next((x for x in g if x[0] == "stop"), None)
            main = plat or stp
            pos = (stp or plat) if rail else main
            name = (plat and plat[4]) or (stp and stp[4]) or ""
            sref = (plat and plat[5]) or (stp and stp[5]) or ""
            key = (stp or plat)[1] if rail else main[1]
            s = get_stop(key, pos[2], pos[3], name, sref, rail)
            if not seq or seq[-1] != s:
                seq.append(s)
        if len(seq) < 2:
            skipped += 1
            continue
        wl = [mp.member_ways.get(ref) for typ, ref, role in r["members"]
              if typ == "w" and not role.startswith("platform") and not role.startswith("stop")]
        line = chain_ways([w for w in wl if w])
        stop_pts = [(stops[s][1] / 1e6, stops[s][2] / 1e6) for s in seq]
        ok = len(line) >= 2
        if ok:
            cum = cumlen(line)
            _, d_first, _ = project(line, cum, *stop_pts[0], 0)
            _, d_last, _ = project(line, cum, *stop_pts[-1], 0)
            if d_first > d_last:
                line = line[::-1]
            line = simplify(line, 4.0)
            cum = cumlen(line)
            gi, idx, bad = [], 0, 0
            for la, lo in stop_pts:
                i, d, off = project(line, cum, la, lo, idx)
                if off > 400:
                    bad += 1
                gi.append(i)
                idx = i
            if bad > len(stop_pts) // 3:
                ok = False
        if ok:
            geom = line
        else:
            geom = stop_pts
            gi = list(range(len(stop_pts)))
        seg = []
        for a in range(len(seq) - 1):
            ia, ib = gi[a], gi[a + 1]
            pts = [stop_pts[a]] + (geom[ia + 1:ib + 1] if ib > ia and ok else []) + [stop_pts[a + 1]]
            seg.append(int(round(sum(dist_m(*p, *q) for p, q in zip(pts, pts[1:])))))
        speed, head = DEFAULTS.get(mode, (20, 10))
        name = t.get("name") or ""
        net = t.get("network") or ""
        label = name.split(":")[0].strip() if ":" in name else ""
        ref = t.get("ref") or ""
        lname = (label or name or ref).lower() + " " + net.lower()
        if mode == "train":
            if any(w in lname for w in ("overground", "mildmay", "lioness", "windrush", "weaver", "suffragette",
                                        "liberty")):
                speed, head = 35, 10
            elif "elizabeth" in lname:
                speed, head = 45, 5
            elif "thameslink" in lname:
                head = 10
        night = (mode in ("bus", "trolleybus") and ref.upper().startswith("N")) or t.get("by_night") == "only"
        if night:
            head = 20
        hv = parse_interval(t.get("interval"))
        if hv:
            head = hv
        if not label:
            label = (ref and (MODE_LABEL.get(mode, "") + " " + ref).strip()) or name or MODE_LABEL.get(mode, mode)
        routes.append({
            "id": r["id"], "m": mode, "r": ref, "l": label, "c": t.get("colour") or "", "n": net,
            "to": t.get("to") or stops[seq[-1]][0], "h": head, "v": speed,
            "s": seq, "seg": seg, "g": enc_line(geom), "gi": gi, "night": 1 if night else 0,
        })
    ent = [[i6(la), i6(lo), nm] for la, lo, nm in mp.entrances]
    with open(os.path.join(out_dir, "transit.json"), "w") as f:
        json.dump({"stops": stops, "routes": routes, "entrances": ent}, f, separators=(",", ":"), ensure_ascii=False)
    by = defaultdict(int)
    for r in routes:
        by[r["m"]] += 1
    log(f"transporte: {len(stops):,} paradas, {len(routes):,} recorridos {dict(by)}, descartados {skipped}")
    return len(stops), len(routes), dict(by)


# ---------------------------------------------------------------- search + addresses
def build_search(mp, out_dir):
    for name, pts in mp.street_pts.items():
        clusters = []
        for la, lo in pts:
            for c in clusters:
                if dist_m(c[0] / c[2], c[1] / c[2], la, lo) < 1500:
                    c[0] += la
                    c[1] += lo
                    c[2] += 1
                    break
            else:
                clusters.append([la, lo, 1])
        for c in clusters:
            mp.search.append([name, "street", c[0] / c[2], c[1] / c[2], "Calle", ""])
    seen = defaultdict(list)
    out = []
    for name, kind, la, lo, sub, alt in mp.search:
        key = (name.lower(), kind)
        if any(dist_m(la, lo, a, b) < 250 for a, b in seen[key]):
            continue
        seen[key].append((la, lo))
        out.append([name, kind, i6(la), i6(lo), sub, alt] if alt else [name, kind, i6(la), i6(lo), sub])
    places = [[n, i6(a), i6(b), r] for n, a, b, r in mp.places]
    with open(os.path.join(out_dir, "search.json"), "w") as f:
        json.dump({"items": out, "places": places}, f, separators=(",", ":"), ensure_ascii=False)
    log(f"buscador: {len(out):,} entradas, {len(places):,} barrios")

    addr, count = [], 0
    for street, lst in mp.addr.items():
        flat, pa, pb, seen_hn = [], 0, 0, set()
        for hn, la, lo in sorted(lst, key=lambda x: (x[0], x[1])):
            k = (hn, round(la, 3), round(lo, 3))
            if k in seen_hn:
                continue
            seen_hn.add(k)
            a, b = i6(la), i6(lo)
            flat += [hn, a - pa, b - pb]
            pa, pb = a, b
            count += 1
        addr.append([street, flat])
    pcs = [[pc, i6(v[0] / v[2]), i6(v[1] / v[2])] for pc, v in mp.postcodes.items() if v[2]]
    outward = defaultdict(lambda: [0.0, 0.0, 0])
    for pc, v in mp.postcodes.items():
        o = pc.split(" ")[0]
        if 2 <= len(o) <= 4 and o != pc:
            acc = outward[o]
            acc[0] += v[0]
            acc[1] += v[1]
            acc[2] += v[2]
    pcs += [[o, i6(v[0] / v[2]), i6(v[1] / v[2])] for o, v in outward.items()]
    with open(os.path.join(out_dir, "addr.json"), "w") as f:
        json.dump({"streets": addr, "postcodes": pcs}, f, separators=(",", ":"), ensure_ascii=False)
    log(f"direcciones: {count:,} en {len(addr):,} calles, {len(pcs):,} códigos postales")
    return len(out), count, len(pcs)


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    src, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    log("paso 1/2: recorridos de transporte")
    rp = RelPass()
    rp.apply_file(src)
    log(f"recorridos: {len(rp.routes):,}")
    log("paso 2/2: nodos y vías")
    mp = MainPass(rp.need_nodes, rp.need_ways)
    mp.apply_file(src, locations=True, idx="flex_mem")
    log(f"leído: {len(mp.walk_ways):,} vías peatonales, {len(mp.search):,} lugares con nombre")
    nn, ne = build_graph(mp, out_dir)
    ns, nr, by = build_transit(rp, mp, out_dir)
    nsearch, naddr, npc = build_search(mp, out_dir)
    stats = {"nodes": nn, "edges": ne, "stops": ns, "routes": nr, "routesByMode": by, "search": nsearch,
             "addresses": naddr, "postcodes": npc, "built": time.strftime("%Y-%m-%d"),
             "source": os.path.basename(src)}
    with open(os.path.join(out_dir, "stats.json"), "w") as f:
        json.dump(stats, f, ensure_ascii=False, indent=1)
    log("listo")


if __name__ == "__main__":
    main()
