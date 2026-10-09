#!/usr/bin/env bash
# Downloads everything needed to build the Greater London data pack into OUT (default: build/).
#   - OpenStreetMap extract of Greater London (Geofabrik)
#   - Vector basemap tiles for the same area (latest Protomaps daily build, cut with `pmtiles extract`)
#   - Basemap fonts and sprites (protomaps/basemaps-assets)
# Environment: MAXZOOM (default 15; 14 makes the map download about half the size)
set -euo pipefail

OUT="${1:-build}"
MAXZOOM="${MAXZOOM:-15}"
BBOX="-0.5103,51.2868,0.3340,51.6919" # Greater London: west,south,east,north
mkdir -p "$OUT"

echo "==> 1/3 Extracto de OpenStreetMap del Gran Londres"
curl -fL --retry 4 --retry-delay 10 -o "$OUT/greater-london-latest.osm.pbf" \
  https://download.geofabrik.de/europe/united-kingdom/england/greater-london-latest.osm.pbf
ls -lh "$OUT/greater-london-latest.osm.pbf"

echo "==> 2/3 Mapa base vectorial (Protomaps)"
PMTILES="$(command -v pmtiles || true)"
if [ -z "$PMTILES" ]; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) PAT='Linux_x86_64\.tar\.gz$' ;;
    Linux-aarch64) PAT='Linux_arm64\.tar\.gz$' ;;
    Darwin-arm64) PAT='Darwin_arm64\.zip$' ;;
    Darwin-x86_64) PAT='Darwin_x86_64\.zip$' ;;
    *) echo "Instala la herramienta pmtiles: https://github.com/protomaps/go-pmtiles/releases" >&2; exit 1 ;;
  esac
  AUTH=()
  if [ -n "${GITHUB_TOKEN:-}" ]; then AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN"); fi
  URL="$(curl -fsSL ${AUTH[@]+"${AUTH[@]}"} https://api.github.com/repos/protomaps/go-pmtiles/releases/latest \
    | PAT="$PAT" python3 -c "import json,os,re,sys; a=json.load(sys.stdin)['assets']; print(next(x['browser_download_url'] for x in a if re.search(os.environ['PAT'], x['name'])))")"
  echo "    descargando $URL"
  mkdir -p "$OUT/bin"
  if [[ "$URL" == *.zip ]]; then
    curl -fsSL -o "$OUT/bin/pmtiles.zip" "$URL" && unzip -o -q "$OUT/bin/pmtiles.zip" -d "$OUT/bin"
  else
    curl -fsSL "$URL" | tar xz -C "$OUT/bin"
  fi
  PMTILES="$OUT/bin/pmtiles"
  chmod +x "$PMTILES"
fi

SRC=""
for d in $(seq 0 14); do
  if day="$(date -u -d "-$d day" +%Y%m%d 2>/dev/null)"; then :; else day="$(date -u -v-"$d"d +%Y%m%d)"; fi
  if curl -fsIL "https://build.protomaps.com/$day.pmtiles" >/dev/null 2>&1; then SRC="https://build.protomaps.com/$day.pmtiles"; break; fi
done
if [ -z "$SRC" ]; then echo "No encuentro ninguna compilación reciente en build.protomaps.com" >&2; exit 1; fi
echo "    origen: $SRC (zoom máximo $MAXZOOM)"
"$PMTILES" extract "$SRC" "$OUT/londres.pmtiles" --bbox="$BBOX" --maxzoom="$MAXZOOM" --download-threads=4
ls -lh "$OUT/londres.pmtiles"

echo "==> 3/3 Fuentes y símbolos del mapa"
if [ ! -d "$OUT/basemaps-assets/.git" ]; then
  git clone --depth 1 https://github.com/protomaps/basemaps-assets "$OUT/basemaps-assets"
else
  git -C "$OUT/basemaps-assets" pull --ff-only
fi
echo "Listo."
