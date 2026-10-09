#!/usr/bin/env python3
"""Test helper: builds a small PMTiles basemap (Protomaps layer names) from an .osm.pbf extract.

Only for trying the app locally with a tiny area. The real London map comes from the Protomaps
daily build (see scripts/fetch_data.sh).
Usage: python3 scripts/make_test_tiles.py AREA.osm.pbf OUT.pmtiles
Needs: pip install osmium mapbox-vector-tile pmtiles mercantile shapely
"""
import gzip
import sys

import mapbox_vector_tile
import mercantile
import osmium
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer
from shapely.geometry import LineString, Polygon, box, mapping
from shapely.ops import transform

ROAD = {"motorway": "highway", "trunk": "major_road", "primary": "major_road", "secondary": "major_road",
        "tertiary": "medium_road", "residential": "minor_road", "unclassified": "minor_road", "living_street": "minor_road",
        "service": "minor_road", "pedestrian": "path", "footway": "path", "path": "path", "steps": "path", "cycleway": "path"}


class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.roads, self.buildings, self.parks, self.water = [], [], [], []

    def way(self, w):
        t = w.tags
        pts = [(n.location.lon, n.location.lat) for n in w.nodes if n.location.valid()]
        if len(pts) < 2:
            return
        hw = t.get("highway")
        if hw in ROAD:
            self.roads.append((LineString(pts), {"kind": ROAD[hw], "kind_detail": hw, "name": t.get("name", ""), "min_zoom": 12}))
        elif len(pts) >= 4 and pts[0] == pts[-1]:
            poly = Polygon(pts)
            if not poly.is_valid:
                poly = poly.buffer(0)
            if t.get("building"):
                self.buildings.append((poly, {"kind": "building"}))
            elif t.get("leisure") in ("park", "garden") or t.get("landuse") in ("grass", "recreation_ground"):
                self.parks.append((poly, {"kind": "park", "name": t.get("name", "")}))
            elif t.get("natural") == "water":
                self.water.append((poly, {"kind": "water"}))


def main():
    src, dst = sys.argv[1], sys.argv[2]
    h = H()
    h.apply_file(src, locations=True)
    feats = h.roads + h.buildings + h.parks + h.water
    xs = [c[0] for g, _ in h.roads for c in g.coords]
    ys = [c[1] for g, _ in h.roads for c in g.coords]
    bb = (min(xs), min(ys), max(xs), max(ys))
    tiles = []
    for z in range(10, 16):
        for tl in mercantile.tiles(*bb, zooms=z):
            b = mercantile.bounds(tl)
            tb = box(b.west, b.south, b.east, b.north)
            sx, sy = 4096 / (b.east - b.west), 4096 / (b.north - b.south)

            def to_tile(x, y, z=None, b=b, sx=sx, sy=sy):
                return ((x - b.west) * sx, (y - b.south) * sy)
            layers = {"earth": [{"geometry": mapping(transform(to_tile, tb)), "properties": {"kind": "earth"}}],
                      "roads": [], "buildings": [], "landuse": [], "water": []}
            for g, props in feats:
                if not g.intersects(tb):
                    continue
                if props["kind"] == "building" and z < 14:
                    continue
                if props.get("kind_detail") in ("footway", "path", "steps", "cycleway", "service") and z < 14:
                    continue
                cg = g.intersection(tb.buffer((b.east - b.west) * 0.02))
                if cg.is_empty:
                    continue
                layer = {"building": "buildings", "park": "landuse", "water": "water"}.get(props["kind"], "roads")
                layers[layer].append({"geometry": mapping(transform(to_tile, cg)), "properties": props})
            data = mapbox_vector_tile.encode([{"name": k, "features": v} for k, v in layers.items() if v],
                                             default_options={"y_coord_down": False})
            tiles.append((zxy_to_tileid(z, tl.x, tl.y), gzip.compress(data)))
    tiles.sort()
    with open(dst, "wb") as f:
        w = Writer(f)
        for tid, data in tiles:
            w.write_tile(tid, data)
        cx, cy = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2
        w.finalize({"tile_type": TileType.MVT, "tile_compression": Compression.GZIP, "min_zoom": 10, "max_zoom": 15,
                    "min_lon_e7": int(bb[0] * 1e7), "min_lat_e7": int(bb[1] * 1e7), "max_lon_e7": int(bb[2] * 1e7),
                    "max_lat_e7": int(bb[3] * 1e7), "center_zoom": 14, "center_lon_e7": int(cx * 1e7), "center_lat_e7": int(cy * 1e7)},
                   {"name": "test", "vector_layers": [{"id": k} for k in ("earth", "roads", "buildings", "landuse", "water")]})
    print(f"{dst}: {len(tiles)} teselas")


if __name__ == "__main__":
    main()
