# Londres Sin Red

App web instalable (PWA) con el mapa del Gran Londres que funciona **sin conexión**:

- **Navegación calle a calle a pie** con GPS, indicaciones por voz en español («En 30 metros, gira a la derecha en Oxford Street») y recálculo automático si te sales de la ruta.
- **Rutas combinadas** a pie + Metro, Elizabeth line, Overground, DLR, tranvía, tren, autobús y barco, con alternativas (más rápida, menos transbordos, sin autobús, solo autobús, solo a pie).
- **Buscador sin conexión**: lugares, estaciones, paradas, calles, direcciones con número (221B Baker Street) y códigos postales (SW1A 1AA). Nombres en español para los sitios más conocidos (Torre de Londres, Museo Británico…).
- Mapa vectorial nítido a cualquier zoom, modo claro y oscuro.

Todo el cálculo se hace en el móvil. Los datos salen de OpenStreetMap y se actualizan solos cada semana.

## Cómo publicarla (una vez, unos 15 minutos)

Necesitas una cuenta gratuita de GitHub. Se puede hacer desde el navegador del móvil, aunque es más cómodo desde un ordenador.

1. Crea un repositorio nuevo en GitHub (por ejemplo `londres`).
2. Sube todos los archivos de esta carpeta al repositorio (botón **Add file › Upload files**, arrastrando el contenido de la carpeta, incluida la carpeta oculta `.github`). Si usas git: `git push` a la rama `main`.
3. En el repositorio, ve a **Settings › Pages** y en **Source** elige **GitHub Actions**.
4. Ve a **Actions › Construir y publicar › Run workflow**. La primera vez tarda entre 30 y 60 minutos: descarga OpenStreetMap del Gran Londres, construye la red de calles y de transporte, prueba una ruta y publica la web.
5. Cuando termine, la app estará en `https://TU_USUARIO.github.io/NOMBRE_DEL_REPOSITORIO/`.

El proceso se repite solo cada lunes con datos nuevos. La app avisa en el menú ☰ cuando hay una actualización del mapa.

## Cómo instalarla en el móvil

- **Android (Chrome):** abre la dirección y pulsa **Instalar app** (o menú ⋮ › Añadir a pantalla de inicio).
- **iPhone (Safari):** abre la dirección, pulsa **Compartir › Añadir a pantalla de inicio** y abre la app desde el icono. Descarga el mapa desde la app instalada, no desde Safari, para que iOS no borre los datos.

Después, en la app: menú ☰ › **Descargar** (unos 200–300 MB; usa Wi-Fi). A partir de ahí todo funciona en modo avión.

Sin descargar, la app también funciona en línea: el mapa se carga a trozos y los datos de rutas se descargan al primer uso.

## Cómo se usa

- **Buscar:** toca la barra de búsqueda y escribe un lugar, una estación, una calle, «número + calle» o un código postal.
- **Ir a un sitio:** elige el resultado › **Cómo llegar**. El origen es tu ubicación; puedes cambiarlo o elegir un punto tocando el mapa.
- **Elegir ruta:** toca una opción para verla en el mapa y otra vez para ver los pasos. **Iniciar** arranca la navegación.
- **Durante la navegación:** el cartel de arriba muestra la próxima maniobra y la distancia. En los tramos de transporte dice qué línea tomar, hacia dónde y dónde bajar, y avisa una parada antes. Bajo tierra no hay GPS: usa **Ya he subido** / **He bajado**, o la app avanzará sola al recuperar la señal cerca de la estación.

## Limitaciones

- **Horarios:** sin conexión no hay horarios en tiempo real. Las esperas y los tiempos de viaje son estimaciones con frecuencias habituales por tipo de línea (por ejemplo, metro cada 3–5 min, autobús cada ~10 min, nocturno cada ~20 min). De madrugada solo se usan autobuses nocturnos y, los viernes y sábados, las líneas de metro con servicio nocturno.
- **Incidencias:** no conoce obras, cierres de estaciones ni huelgas.
- **Datos:** la calidad depende de OpenStreetMap, que en Londres es muy completo. Los recorridos de transporte salen de las relaciones de rutas de OpenStreetMap.
- **Modos:** solo a pie y transporte público; no hay rutas en coche ni en bicicleta.

## Probar en un ordenador

Requisitos: Node 20+, Python 3.10+, git y unos 4 GB de RAM libres.

```bash
npm ci
pip install -r scripts/requirements.txt
npm run datos     # descarga y procesa Londres (tarda)
npm run probar    # prueba la ruta Westminster → Torre de Londres
npm run montar    # genera la web en dist/
npm run servir    # abre http://localhost:8080
```

`MAXZOOM=14 npm run datos` genera un mapa base de la mitad de tamaño, con algo menos de detalle al acercar mucho.

## Cómo está hecha

| Pieza | Qué hace |
|---|---|
| `scripts/fetch_data.sh` | Descarga el extracto de OpenStreetMap del Gran Londres (Geofabrik), recorta el mapa base vectorial de Protomaps y baja las fuentes del mapa. |
| `scripts/build_data.py` | Convierte OpenStreetMap en la red peatonal (`graph.bin`), la red de transporte con paradas, entradas de estación y recorridos (`transit.json`), el buscador (`search.json`) y las direcciones (`addr.json`). |
| `scripts/assemble.mjs` | Monta la web en `dist/`, trocea los archivos grandes en partes de 90 MB y genera `data/manifest.json` y el service worker. |
| `web/js/engine.js` | Motor de rutas: A* peatonal, búsqueda multimodal por frecuencias, indicaciones giro a giro y buscador. Corre en un Web Worker. |
| `web/js/nav.js` | Navegación: sigue el GPS, anuncia maniobras y paradas, detecta desvíos. |
| `web/js/storage.js` | Guarda el paquete de Londres en el almacenamiento privado del navegador (OPFS) y lee el mapa desde ahí. |
| `web/sw.js` | Hace que la app abra sin conexión. |
| `scripts/make_test_tiles.py` | Solo para pruebas: crea un mapa base pequeño a partir de cualquier extracto OSM. |

Créditos: datos © colaboradores de OpenStreetMap (ODbL), mapa base [Protomaps](https://protomaps.com), visor [MapLibre GL JS](https://maplibre.org), fuentes Noto Sans (OFL).
