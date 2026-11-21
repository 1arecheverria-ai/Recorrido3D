/* Huella 3D — GPX -> video 3D del recorrido. Todo corre en el navegador. */
(() => {
  'use strict';

  const BASE_W = 1280, BASE_H = 720, FPS = 30;
  const SAT_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  const ATTRIB = 'Imágenes © Esri, Maxar, Earthstar Geographics · Relieve © Mapzen/AWS';
  const nf1 = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf0 = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
  const $ = (id) => document.getElementById(id);

  const ui = {
    gpx: $('gpx'), drop: $('drop'), sample: $('sample'), facts: $('facts'),
    title: $('title'), subtitle: $('subtitle'), duration: $('duration'), quality: $('quality'),
    exag: $('exag'), exagOut: $('exag-out'), swatches: $('swatches'),
    preview: $('preview'), render: $('render'), progress: $('progress'), bar: $('bar'),
    status: $('status'), cancel: $('cancel'), result: $('result'), video: $('video'),
    download: $('download'), share: $('share'), resultNote: $('result-note'), msg: $('msg'),
    frame: $('frame'), viewport: $('viewport'), overlay: $('overlay'), empty: $('empty'),
  };

  const S = {
    track: null,          // {pts, total, stats, headings}
    color: '#ffd23f',
    outH: 720,
    busy: false,
    cancel: false,
    previewRaf: 0,
    lastDone: -1,
    cams: null,
    videoUrl: null,
    videoBlob: null,
  };

  /* ---------- utilidades geográficas ---------- */
  const R = 6371008.8, rad = Math.PI / 180;
  function hav(a, b) {
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  const smooth = (k) => k * k * (3 - 2 * k);
  function lerpAngle(a, b, k) {
    let d = ((b - a) % 360 + 540) % 360 - 180;
    return a + d * k;
  }

  /* ---------- lectura del GPX ---------- */
  function parseGPX(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('El archivo no es un GPX válido.');
    let nodes = [...doc.getElementsByTagName('trkpt')];
    if (!nodes.length) nodes = [...doc.getElementsByTagName('rtept')];
    if (nodes.length < 2) throw new Error('El GPX no tiene puntos de recorrido.');
    const pts = nodes.map((n) => {
      const e = n.getElementsByTagName('ele')[0], t = n.getElementsByTagName('time')[0];
      return {
        lat: parseFloat(n.getAttribute('lat')),
        lon: parseFloat(n.getAttribute('lon')),
        ele: e ? parseFloat(e.textContent) : NaN,
        time: t ? Date.parse(t.textContent) : NaN,
      };
    }).filter((p) => isFinite(p.lat) && isFinite(p.lon));
    const nameNode = doc.querySelector('trk > name, metadata > name, rte > name');
    return { pts, name: nameNode ? nameNode.textContent.trim() : '' };
  }

  /* Altura desde el modelo de terreno cuando el GPX no la trae. */
  async function fillElevation(pts) {
    const z = 13, cache = new Map();
    const getTile = (x, y) => {
      const key = x + '/' + y;
      if (!cache.has(key)) {
        cache.set(key, (async () => {
          const url = DEM_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
          const res = await fetch(url);
          if (!res.ok) throw new Error('dem');
          const bmp = await createImageBitmap(await res.blob());
          const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
          const cx = c.getContext('2d', { willReadFrequently: true }); cx.drawImage(bmp, 0, 0);
          return cx.getImageData(0, 0, c.width, c.height);
        })());
      }
      return cache.get(key);
    };
    const n = 2 ** z;
    for (const p of pts) {
      const fx = (p.lon + 180) / 360 * n;
      const fy = (1 - Math.log(Math.tan(p.lat * rad) + 1 / Math.cos(p.lat * rad)) / Math.PI) / 2 * n;
      const x = Math.floor(fx), y = Math.floor(fy);
      try {
        const img = await getTile(x, y);
        const px = clamp(Math.floor((fx - x) * img.width), 0, img.width - 1);
        const py = clamp(Math.floor((fy - y) * img.height), 0, img.height - 1);
        const i = (py * img.width + px) * 4, d = img.data;
        p.ele = d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768;
      } catch { p.ele = 0; }
    }
  }

  async function prepareTrack(raw) {
    // limpiar duplicados y saltos absurdos
    let pts = [];
    for (const p of raw) {
      const last = pts[pts.length - 1];
      if (last && hav(last, p) < 0.5) continue;
      pts.push({ ...p });
    }
    if (pts.length < 2) throw new Error('El recorrido es demasiado corto.');
    const withEle = pts.filter((p) => isFinite(p.ele)).length;
    if (withEle < pts.length * 0.6) await fillElevation(pts);
    else { // completar huecos aislados
      let lastE = pts.find((p) => isFinite(p.ele)).ele;
      for (const p of pts) { if (isFinite(p.ele)) lastE = p.ele; else p.ele = lastE; }
    }
    // distancias acumuladas
    pts[0].d = 0;
    for (let i = 1; i < pts.length; i++) pts[i].d = pts[i - 1].d + hav(pts[i - 1], pts[i]);
    const total = pts[pts.length - 1].d;
    if (total < 200) throw new Error('El recorrido tiene menos de 200 m.');
    // reducir puntos (un punto cada ~total/3000 m)
    const step = total / 3000;
    if (pts.length > 3000) {
      const out = [pts[0]];
      for (const p of pts) if (p.d - out[out.length - 1].d >= step) out.push(p);
      if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
      pts = out;
    }
    // suavizar altura (ruido de GPS)
    const W = Math.max(2, Math.round(pts.length / 400));
    const es = pts.map((_, i) => {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - W); j <= Math.min(pts.length - 1, i + W); j++) { s += pts[j].ele; c++; }
      return s / c;
    });
    pts.forEach((p, i) => { p.es = es[i]; });
    // estadísticas
    let up = 0, ref = es[0];
    for (const e of es) {
      if (e > ref + 3) { up += e - ref; ref = e; } else if (e < ref - 3) ref = e;
    }
    const maxE = Math.max(...es), minE = Math.min(...es);
    const t0 = pts[0].time, t1 = pts[pts.length - 1].time;
    const dur = isFinite(t0) && isFinite(t1) && t1 > t0 ? (t1 - t0) / 1000 : NaN;
    const track = { pts, total, stats: { up, maxE, minE, dur, t0 } };
    track.headings = computeHeadings(track);
    return track;
  }

  function idxAt(pts, d) {
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].d <= d) lo = m; else hi = m; }
    return lo;
  }
  function posAt(track, d) {
    const pts = track.pts; d = clamp(d, 0, track.total);
    const i = idxAt(pts, d), a = pts[i], b = pts[Math.min(i + 1, pts.length - 1)];
    const k = b.d > a.d ? (d - a.d) / (b.d - a.d) : 0;
    return { lon: lerp(a.lon, b.lon, k), lat: lerp(a.lat, b.lat, k), ele: lerp(a.es, b.es, k), i, k };
  }

  /* Rumbo de cámara suavizado a lo largo del recorrido. */
  function computeHeadings(track) {
    const K = 1200, w = clamp(track.total * 0.025, 80, 450);
    let vx = new Float64Array(K), vy = new Float64Array(K);
    for (let k = 0; k < K; k++) {
      const s = track.total * k / (K - 1);
      const a = posAt(track, s - w), b = posAt(track, s + w);
      const ex = (b.lon - a.lon) * Math.cos(a.lat * rad), ny = b.lat - a.lat;
      const len = Math.hypot(ex, ny) || 1;
      vx[k] = ex / len; vy[k] = ny / len;
    }
    const box = (arr, r) => {
      const out = new Float64Array(arr.length);
      for (let i = 0; i < arr.length; i++) {
        let s = 0, c = 0;
        for (let j = Math.max(0, i - r); j <= Math.min(arr.length - 1, i + r); j++) { s += arr[j]; c++; }
        out[i] = s / c;
      }
      return out;
    };
    for (let pass = 0; pass < 3; pass++) { vx = box(vx, 30); vy = box(vy, 30); }
    return { K, vx, vy };
  }
  function bearingAt(track, d) {
    const h = track.headings, f = clamp(d / track.total, 0, 1) * (h.K - 1);
    const i = Math.floor(f), j = Math.min(i + 1, h.K - 1), k = f - i;
    const x = lerp(h.vx[i], h.vx[j], k), y = lerp(h.vy[i], h.vy[j], k);
    return Math.atan2(x, y) / rad;
  }

  /* ---------- mapa ---------- */
  const map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        sat: { type: 'raster', tiles: [SAT_URL], tileSize: 256, maxzoom: 18 },
        dem: { type: 'raster-dem', tiles: [DEM_URL], encoding: 'terrarium', tileSize: 256, maxzoom: 14 },
        demh: { type: 'raster-dem', tiles: [DEM_URL], encoding: 'terrarium', tileSize: 256, maxzoom: 14 },
        done: { type: 'geojson', data: emptyFC() },
        full: { type: 'geojson', data: emptyFC() },
        head: { type: 'geojson', data: emptyFC() },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#8d8574' } },
        { id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-fade-duration': 0 } },
        { id: 'shade', type: 'hillshade', source: 'demh', paint: { 'hillshade-exaggeration': 0.25, 'hillshade-shadow-color': '#2a2016', 'hillshade-highlight-color': '#ffffff' } },
        { id: 'full', type: 'line', source: 'full', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-opacity': 0.45, 'line-width': 2.5 } },
        { id: 'done-casing', type: 'line', source: 'done', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#1b1406', 'line-opacity': 0.55, 'line-width': 8 } },
        { id: 'done', type: 'line', source: 'done', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': S.color, 'line-width': 5 } },
        { id: 'head', type: 'circle', source: 'head', paint: { 'circle-radius': 8, 'circle-color': '#ffffff', 'circle-stroke-color': S.color, 'circle-stroke-width': 4, 'circle-pitch-alignment': 'map' } },
      ],
      terrain: { source: 'dem', exaggeration: 1.5 },
      sky: {
        'sky-color': '#7fa9d6', 'horizon-color': '#dce6ee', 'fog-color': '#e4e8ea',
        'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.85,
      },
    },
    center: [-68.1, -38.9], zoom: 10, pitch: 0,
    interactive: false, attributionControl: false, preserveDrawingBuffer: true,
    fadeDuration: 0, maxPitch: 75, pixelRatio: 1, maxTileCacheSize: 800,
  });
  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }
  const mapReady = new Promise((res) => map.on('load', res));
  map.on('error', (e) => console.warn('map', e && e.error && e.error.message));

  /* ---------- escalado del visor ---------- */
  function fitViewport() {
    const w = ui.frame.clientWidth;
    ui.viewport.style.transform = `scale(${w / BASE_W})`;
  }
  new ResizeObserver(fitViewport).observe(ui.frame);
  fitViewport();

  function setQuality(h) {
    S.outH = h;
    const pr = h / BASE_H;
    map.setPixelRatio(pr);
    ui.overlay.width = Math.round(BASE_W * pr);
    ui.overlay.height = Math.round(BASE_H * pr);
  }
  setQuality(720);

  /* ---------- guion de cámara ---------- */
  function timeline(T) {
    const intro = 3.5, flyIn = 2.5, flyOut = 2.5, hold = 3.5;
    const follow = Math.max(8, T - intro - flyIn - flyOut - hold);
    return { intro, flyIn, follow, flyOut, hold, T: intro + flyIn + follow + flyOut + hold };
  }

  function computeCams(track) {
    const b = new maplibregl.LngLatBounds();
    for (const p of track.pts) b.extend([p.lon, p.lat]);
    const ov = map.cameraForBounds(b, { padding: { top: 90, bottom: 150, left: 110, right: 110 }, bearing: -15 });
    const km = track.total / 1000;
    const followZoom = clamp(15.4 - Math.log2(Math.max(km, 1) / 4) * 0.55, 13.2, 15.4);
    const center = ov.center;
    return {
      over: { center: [center.lng, center.lat], zoom: ov.zoom - 0.25, pitch: 45, bearing: -15 },
      followZoom,
    };
  }

  function followCam(track, d, cams) {
    const p = posAt(track, d);
    return { center: [p.lon, p.lat], zoom: cams.followZoom, pitch: 62, bearing: bearingAt(track, d) };
  }
  function mixCam(a, b, k) {
    return {
      center: [lerp(a.center[0], b.center[0], k), lerp(a.center[1], b.center[1], k)],
      zoom: lerp(a.zoom, b.zoom, k), pitch: lerp(a.pitch, b.pitch, k), bearing: lerpAngle(a.bearing, b.bearing, k),
    };
  }

  /* Devuelve el estado de la escena en el segundo t. */
  function sceneAt(t, tl) {
    const tr = S.track, c = S.cams, ov = c.over;
    const a1 = tl.intro, a2 = a1 + tl.flyIn, a3 = a2 + tl.follow, a4 = a3 + tl.flyOut;
    let cam, d, phase, k;
    if (t < a1) {
      k = t / tl.intro; phase = 'intro'; d = 0;
      cam = { ...ov, bearing: ov.bearing + 12 * k };
    } else if (t < a2) {
      k = (t - a1) / tl.flyIn; phase = 'flyin'; d = 0;
      cam = mixCam({ ...ov, bearing: ov.bearing + 12 }, followCam(tr, 0, c), ease(k));
    } else if (t < a3) {
      k = (t - a2) / tl.follow; phase = 'follow';
      d = tr.total * (0.75 * k + 0.25 * smooth(k));
      cam = followCam(tr, d, c);
    } else if (t < a4) {
      k = (t - a3) / tl.flyOut; phase = 'flyout'; d = tr.total;
      cam = mixCam(followCam(tr, tr.total, c), { ...ov, bearing: ov.bearing + 30 }, ease(k));
    } else {
      k = clamp((t - a4) / tl.hold, 0, 1); phase = 'hold'; d = tr.total;
      cam = { ...ov, bearing: ov.bearing + 30 + 8 * k };
    }
    return { cam, d, phase, k };
  }

  function setDone(d) {
    if (Math.abs(d - S.lastDone) < 0.01) return;
    S.lastDone = d;
    const tr = S.track, p = posAt(tr, d);
    const coords = tr.pts.slice(0, p.i + 1).map((q) => [q.lon, q.lat]);
    coords.push([p.lon, p.lat]);
    map.getSource('done').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords.length > 1 ? coords : [coords[0], coords[0]] } });
    map.getSource('head').setData({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] } });
  }

  /* ---------- gráficos superpuestos ---------- */
  const ctx = ui.overlay.getContext('2d');
  function texts() {
    return {
      title: ui.title.value.trim() || ui.title.placeholder,
      subtitle: ui.subtitle.value.trim(),
    };
  }
  function fmtDur(s) {
    if (!isFinite(s)) return '–';
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
  }
  function roundRect(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }

  function drawOverlay(t, tl, sc) {
    const W = ui.overlay.width, H = ui.overlay.height, s = W / BASE_W, c = ctx, tr = S.track;
    c.clearRect(0, 0, W, H);
    const { title, subtitle } = texts();
    const fade = (x, a, b) => clamp((x - a) / (b - a), 0, 1);

    // Portada
    const aTitle = fade(t, 0.2, 0.9) * (1 - fade(t, tl.intro + 0.2, tl.intro + 1.2));
    if (aTitle > 0) {
      c.save(); c.globalAlpha = aTitle;
      const g = c.createLinearGradient(0, H * 0.45, 0, H);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.6)');
      c.fillStyle = g; c.fillRect(0, H * 0.45, W, H * 0.55);
      c.fillStyle = '#fff'; c.textBaseline = 'alphabetic';
      c.font = `700 ${86 * s}px "Barlow Condensed", "Arial Narrow", sans-serif`;
      const slide = (1 - smooth(fade(t, 0.2, 0.9))) * 30 * s;
      c.fillText(title.toUpperCase(), 64 * s - slide, H - 128 * s);
      if (subtitle) {
        c.font = `600 ${26 * s}px "Barlow", sans-serif`;
        const tw = c.measureText(subtitle.toUpperCase()).width;
        c.fillStyle = S.color; c.fillRect(64 * s, H - 108 * s, tw + 28 * s, 42 * s);
        c.fillStyle = '#16130a'; c.fillText(subtitle.toUpperCase(), 78 * s, H - 78 * s);
      }
      c.restore();
    }

    // Datos durante el recorrido
    const aData = sc.phase === 'flyin' ? smooth(sc.k) : sc.phase === 'follow' ? 1 : sc.phase === 'flyout' ? 1 - smooth(sc.k) : 0;
    if (aData > 0) {
      c.save(); c.globalAlpha = aData;
      const p = posAt(tr, sc.d);
      // panel de datos
      const km = nf1.format(sc.d / 1000), alt = nf0.format(p.ele);
      const big = `700 ${50 * s}px "Barlow Condensed", sans-serif`, small = `600 ${22 * s}px "Barlow", sans-serif`;
      c.font = big; const wKm = c.measureText(km).width, wAlt = c.measureText(alt).width;
      c.font = small; const wU = c.measureText('km').width;
      const x1 = 52 * s, x2 = x1 + wKm + 6 * s + wU + 28 * s;
      c.font = small; const wM = c.measureText('m').width;
      roundRect(c, 32 * s, 28 * s, x2 + wAlt + 6 * s + wM + 20 * s - 32 * s, 96 * s, 10 * s);
      c.fillStyle = 'rgba(12,14,12,0.55)'; c.fill();
      c.fillStyle = '#fff'; c.font = big;
      c.fillText(km, x1, 92 * s); c.fillText(alt, x2, 92 * s);
      c.font = small; c.fillStyle = 'rgba(255,255,255,0.75)';
      c.fillText('km', x1 + wKm + 6 * s, 92 * s); c.fillText('m', x2 + wAlt + 6 * s, 92 * s);
      c.font = `500 ${13 * s}px "Barlow", sans-serif`;
      c.fillText('DISTANCIA', x1, 112 * s); c.fillText('ALTURA', x2, 112 * s);

      // perfil de altura
      const px = 32 * s, pw = W - 64 * s, ph = 74 * s, py = H - 40 * s - ph;
      const g = c.createLinearGradient(0, H - 190 * s, 0, H);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.55)');
      c.fillStyle = g; c.fillRect(0, H - 190 * s, W, 190 * s);
      const minE = tr.stats.minE, rng = Math.max(tr.stats.maxE - minE, 20);
      const X = (d) => px + (d / tr.total) * pw;
      const Y = (e) => py + ph - ((e - minE) / rng) * ph;
      const prof = new Path2D();
      prof.moveTo(px, py + ph);
      const n = 400;
      for (let i = 0; i <= n; i++) { const d = tr.total * i / n; prof.lineTo(X(d), Y(posAt(tr, d).ele)); }
      prof.lineTo(px + pw, py + ph); prof.closePath();
      c.fillStyle = 'rgba(255,255,255,0.28)'; c.fill(prof);
      c.save(); c.beginPath(); c.rect(px, py - 10 * s, X(sc.d) - px, ph + 20 * s); c.clip();
      c.fillStyle = S.color; c.globalAlpha = aData * 0.95; c.fill(prof); c.restore();
      c.fillStyle = '#fff'; c.beginPath(); c.arc(X(sc.d), Y(p.ele), 6 * s, 0, Math.PI * 2); c.fill();
      c.strokeStyle = S.color; c.lineWidth = 3 * s; c.stroke();
      c.font = `500 ${13 * s}px "Barlow", sans-serif`; c.fillStyle = 'rgba(255,255,255,0.8)';
      c.fillText(`${nf0.format(tr.stats.maxE)} m`, px, py - 8 * s);
      c.restore();
    }

    // Cierre con resumen
    const aEnd = sc.phase === 'flyout' ? fade(sc.k, 0.55, 1) : sc.phase === 'hold' ? 1 : 0;
    if (aEnd > 0) {
      c.save(); c.globalAlpha = aEnd;
      const st = tr.stats;
      const items = [
        ['DISTANCIA', nf1.format(tr.total / 1000), 'km'],
        ['DESNIVEL +', nf0.format(st.up), 'm'],
        ['ALTURA MÁX.', nf0.format(st.maxE), 'm'],
        isFinite(st.dur) ? ['DURACIÓN', fmtDur(st.dur), ''] : ['ALTURA MÍN.', nf0.format(st.minE), 'm'],
      ];
      const bw = 1000 * s, bh = 150 * s, bx = (W - bw) / 2, by = H - bh - 44 * s;
      roundRect(c, bx, by, bw, bh, 12 * s); c.fillStyle = 'rgba(12,14,12,0.62)'; c.fill();
      c.fillStyle = S.color; c.fillRect(bx, by, bw, 5 * s);
      c.fillStyle = '#fff'; c.font = `700 ${34 * s}px "Barlow Condensed", sans-serif`;
      c.fillText(title.toUpperCase(), bx + 32 * s, by + 52 * s);
      if (subtitle) {
        const tw = c.measureText(title.toUpperCase()).width;
        c.font = `500 ${18 * s}px "Barlow", sans-serif`; c.fillStyle = 'rgba(255,255,255,0.7)';
        c.fillText(subtitle, bx + 48 * s + tw, by + 50 * s);
      }
      const cw = (bw - 64 * s) / 4;
      items.forEach(([lab, val, unit], i) => {
        const x = bx + 32 * s + i * cw;
        c.fillStyle = 'rgba(255,255,255,0.7)'; c.font = `500 ${14 * s}px "Barlow", sans-serif`;
        c.fillText(lab, x, by + 84 * s);
        c.fillStyle = '#fff'; c.font = `700 ${42 * s}px "Barlow Condensed", sans-serif`;
        c.fillText(val, x, by + 128 * s);
        if (unit) {
          const w2 = c.measureText(val).width;
          c.font = `600 ${20 * s}px "Barlow", sans-serif`; c.fillStyle = 'rgba(255,255,255,0.75)';
          c.fillText(unit, x + w2 + 6 * s, by + 128 * s);
        }
      });
      c.restore();
    }

    // Atribución obligatoria de los mapas
    c.save();
    c.font = `500 ${11 * s}px "Barlow", sans-serif`; c.textAlign = 'right';
    c.fillStyle = 'rgba(255,255,255,0.7)'; c.shadowColor = 'rgba(0,0,0,0.6)'; c.shadowBlur = 3 * s;
    c.fillText(ATTRIB, W - 12 * s, H - 10 * s);
    c.restore();
  }

  function applyFrame(t, tl) {
    const sc = sceneAt(t, tl);
    map.jumpTo(sc.cam);
    setDone(sc.d);
    drawOverlay(t, tl, sc);
    return sc;
  }

  /* ---------- carga del recorrido ---------- */
  async function loadTrack(raw, name) {
    setMsg('Procesando el recorrido…');
    lockUI(true);
    try {
      const track = await prepareTrack(raw);
      await mapReady;
      S.track = track;
      S.lastDone = -1;
      map.getSource('full').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: track.pts.map((p) => [p.lon, p.lat]) } });
      S.cams = computeCams(track);
      if (!ui.title.value && name) ui.title.value = name.slice(0, 40);
      if (!ui.subtitle.value && isFinite(track.stats.t0)) {
        ui.subtitle.value = new Date(track.stats.t0).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' });
      }
      $('f-dist').textContent = `${nf1.format(track.total / 1000)} km`;
      $('f-up').textContent = `${nf0.format(track.stats.up)} m`;
      $('f-max').textContent = `${nf0.format(track.stats.maxE)} m`;
      $('f-time').textContent = fmtDur(track.stats.dur);
      ui.facts.hidden = false;
      ui.empty.hidden = true;
      ui.drop.classList.add('loaded');
      ui.result.hidden = true;
      applyFrame(0, timeline(+ui.duration.value));
      setMsg('');
    } catch (e) {
      setMsg(e.message || 'No se pudo leer el recorrido.', true);
    } finally {
      lockUI(false);
    }
  }

  async function onFile(file) {
    if (!file) return;
    try {
      const { pts, name } = parseGPX(await file.text());
      await loadTrack(pts, name || file.name.replace(/\.gpx$/i, ''));
    } catch (e) { setMsg(e.message, true); }
  }

  function sampleTrack() {
    // Circuito ficticio de ~9 km alrededor del cerro Otto (Bariloche), a 4 km/h.
    const c = { lat: -41.148, lon: -71.355 }, pts = [], n = 600;
    let t = Date.parse('2025-10-10T09:00:00-03:00'), prev = null;
    for (let i = 0; i <= n; i++) {
      const th = (i / n) * Math.PI * 2;
      const r = 1250 * (1 + 0.22 * Math.sin(3 * th + 0.6) + 0.08 * Math.sin(7 * th));
      const p = { lat: c.lat + (r * Math.cos(th)) / 111320, lon: c.lon + (r * Math.sin(th) * 1.25) / (111320 * Math.cos(c.lat * rad)), ele: NaN };
      if (prev) t += (hav(prev, p) / (4000 / 3600)) * 1000;
      p.time = t; pts.push(p); prev = p;
    }
    return pts;
  }

  /* ---------- vista previa ---------- */
  function stopPreview() {
    cancelAnimationFrame(S.previewRaf); S.previewRaf = 0;
    ui.preview.textContent = 'Vista previa';
  }
  function togglePreview() {
    if (S.previewRaf) { stopPreview(); return; }
    const tl = timeline(+ui.duration.value), t0 = performance.now();
    ui.preview.textContent = 'Detener';
    const loop = (now) => {
      const t = (now - t0) / 1000;
      if (t > tl.T) { stopPreview(); return; }
      applyFrame(t, tl);
      S.previewRaf = requestAnimationFrame(loop);
    };
    S.previewRaf = requestAnimationFrame(loop);
  }

  /* ---------- generación del video ---------- */
  function waitIdle(timeoutMs = 15000) {
    return new Promise((res) => {
      let done = false;
      const fin = () => { if (!done) { done = true; clearTimeout(to); res(); } };
      const to = setTimeout(fin, timeoutMs);
      map.once('idle', fin);
      map.triggerRepaint();
    });
  }

  async function pickCodec(w, h) {
    const base = { width: w, height: h, framerate: FPS, bitrate: h >= 1080 ? 14e6 : 7e6, latencyMode: 'quality' };
    const cands = [
      { codec: 'avc1.640028', mux: 'avc', avc: { format: 'avc' } },
      { codec: 'avc1.4d0028', mux: 'avc', avc: { format: 'avc' } },
      { codec: 'avc1.420028', mux: 'avc', avc: { format: 'avc' } },
      { codec: 'vp09.00.40.08', mux: 'vp9' },
    ];
    for (const c of cands) {
      for (const hw of ['prefer-hardware', 'no-preference']) {
        const cfg = { ...base, codec: c.codec, hardwareAcceleration: hw };
        if (c.avc) cfg.avc = c.avc;
        try {
          const r = await VideoEncoder.isConfigSupported(cfg);
          if (r.supported) return { cfg, mux: c.mux };
        } catch { /* sigue probando */ }
      }
    }
    return null;
  }

  async function renderVideo() {
    if (!('VideoEncoder' in window)) {
      setMsg('Este navegador no puede generar video. Usá Chrome o Edge actualizados (también Safari 17+).', true);
      return;
    }
    stopPreview();
    const W = ui.overlay.width, H = ui.overlay.height;
    const codec = await pickCodec(W, H);
    if (!codec) { setMsg('El navegador no tiene un codificador de video compatible. Probá con Chrome.', true); return; }

    S.busy = true; S.cancel = false; lockUI(true);
    ui.progress.hidden = false; ui.result.hidden = true; setMsg('');
    const tl = timeline(+ui.duration.value), N = Math.round(tl.T * FPS);
    const out = document.createElement('canvas'); out.width = W; out.height = H;
    const octx = out.getContext('2d');
    const mapCanvas = map.getCanvas();

    const muxer = new Mp4Muxer.Muxer({
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: { codec: codec.mux, width: W, height: H, frameRate: FPS },
      fastStart: 'in-memory',
    });
    let encErr = null;
    const enc = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { encErr = e; },
    });
    enc.configure(codec.cfg);

    const started = performance.now();
    try {
      await document.fonts.ready;
      for (let f = 0; f < N; f++) {
        if (S.cancel) throw new Error('cancelado');
        if (encErr) throw encErr;
        applyFrame(f / FPS, tl);
        await waitIdle();
        octx.drawImage(mapCanvas, 0, 0, W, H);
        octx.drawImage(ui.overlay, 0, 0);
        const vf = new VideoFrame(out, { timestamp: Math.round(f * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
        enc.encode(vf, { keyFrame: f % (FPS * 2) === 0 });
        vf.close();
        while (enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 5));
        const pct = (f + 1) / N, el = (performance.now() - started) / 1000;
        const left = el / pct - el;
        ui.bar.style.width = `${(pct * 100).toFixed(1)}%`;
        ui.status.textContent = `Generando ${Math.round(pct * 100)} % · faltan ${left > 90 ? Math.round(left / 60) + ' min' : Math.round(left) + ' s'}`;
      }
      await enc.flush();
      muxer.finalize();
      const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
      showResult(blob, codec.mux);
    } catch (e) {
      if (e.message === 'cancelado') setMsg('Generación cancelada.');
      else { console.error(e); setMsg('No se pudo generar el video: ' + (e.message || e), true); }
    } finally {
      try { enc.close(); } catch { /* ya cerrado */ }
      S.busy = false; lockUI(false); ui.progress.hidden = true; ui.bar.style.width = '0';
    }
  }

  function fileName() {
    const base = (ui.title.value.trim() || 'recorrido').toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return (base || 'recorrido') + '.mp4';
  }

  function showResult(blob, mux) {
    if (S.videoUrl) URL.revokeObjectURL(S.videoUrl);
    S.videoUrl = URL.createObjectURL(blob); S.videoBlob = blob;
    ui.video.src = S.videoUrl;
    ui.download.href = S.videoUrl; ui.download.download = fileName();
    const mb = (blob.size / 1048576).toFixed(1).replace('.', ',');
    ui.resultNote.textContent = `${ui.download.download} · ${mb} MB` +
      (mux === 'vp9' ? ' · Formato VP9: algunos celulares no lo reproducen; si pasa, generalo desde Chrome en una PC.' : '');
    const file = new File([blob], ui.download.download, { type: 'video/mp4' });
    ui.share.hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
    ui.result.hidden = false;
  }

  /* ---------- interfaz ---------- */
  function setMsg(text, err) { ui.msg.textContent = text; ui.msg.classList.toggle('error', !!err); }
  function lockUI(lock) {
    const has = !!S.track;
    ui.render.disabled = lock || !has;
    ui.preview.disabled = lock || !has;
    [ui.gpx, ui.sample, ui.duration, ui.quality, ui.exag].forEach((el) => { el.disabled = lock && S.busy; });
  }

  ui.gpx.addEventListener('change', () => onFile(ui.gpx.files[0]));
  ['dragenter', 'dragover'].forEach((ev) => ui.drop.addEventListener(ev, (e) => { e.preventDefault(); ui.drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => ui.drop.addEventListener(ev, () => ui.drop.classList.remove('over')));
  ui.drop.addEventListener('drop', (e) => { e.preventDefault(); onFile(e.dataTransfer.files[0]); });
  ui.sample.addEventListener('click', () => {
    if (!ui.title.value) ui.title.value = 'Recorrido de ejemplo';
    loadTrack(sampleTrack(), '');
  });
  ui.preview.addEventListener('click', togglePreview);
  ui.render.addEventListener('click', renderVideo);
  ui.cancel.addEventListener('click', () => { S.cancel = true; });
  ui.quality.addEventListener('change', () => {
    setQuality(+ui.quality.value);
    if (S.track) { S.lastDone = -1; applyFrame(0, timeline(+ui.duration.value)); }
  });
  ui.exag.addEventListener('input', () => {
    const v = +ui.exag.value;
    ui.exagOut.textContent = '×' + nf1.format(v);
    map.setTerrain({ source: 'dem', exaggeration: v });
  });
  ui.swatches.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-color]'); if (!b) return;
    S.color = b.dataset.color;
    ui.swatches.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    mapReady.then(() => {
      map.setPaintProperty('done', 'line-color', S.color);
      map.setPaintProperty('head', 'circle-stroke-color', S.color);
      if (S.track && !S.previewRaf) applyFrame(0, timeline(+ui.duration.value));
    });
  });
  [ui.title, ui.subtitle].forEach((el) => el.addEventListener('input', () => {
    if (S.track && !S.previewRaf && !S.busy) applyFrame(0.9, timeline(+ui.duration.value));
  }));
  ui.share.addEventListener('click', async () => {
    try {
      const file = new File([S.videoBlob], ui.download.download, { type: 'video/mp4' });
      await navigator.share({ files: [file], title: ui.title.value || 'Recorrido' });
    } catch { /* el usuario canceló */ }
  });

  // Para pruebas automáticas
  window.__huella = { map, S, timeline, applyFrame, loadTrack, sampleTrack };
})();
