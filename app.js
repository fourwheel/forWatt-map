'use strict';

const state = {
  smMetric: 'mit',       // 'mit' | 'ohne'
  forwatt: true,
  smRange: [0, 1],       // ratio
  coverage: null,        // { partners, matchedVnbIds }
  matched: new Set(),
  selected: null,
  hovered: null,         // vnb_id currently under the cursor
  searchHit: null,       // vnb_id picked via search / list: stays highlighted
};

let map, geoLayer, dsoById = {}, dsoList = [], smData = {}, layersByVnb = {};

// ---------- sidebar (mobile overlay) ----------
const isMobile = () => window.matchMedia('(max-width: 768px)').matches;
function setSidebarOpen(open) {
  const sidebarEl = document.getElementById('sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle');
  const backdrop = document.getElementById('sidebar-backdrop');
  sidebarEl.classList.toggle('collapsed', !open);
  toggleBtn.classList.toggle('collapsed', !open);
  toggleBtn.textContent = open ? '◀' : '▶';
  if (backdrop) backdrop.classList.toggle('visible', open && isMobile());
  if (map) setTimeout(() => map.invalidateSize(), 320);
}

// ---------- color scale ----------
// for.Watt palette (forwatt.io): light yellow -> yellow -> amber -> dark
// orange. The stops span a wide range of lightness, so neighbouring quotas
// stay tellable apart (yellow -> orange alone are about equally light).
// Most quotas sit between 0 and 40 %, so the scale saturates at SM_SCALE_MAX
// instead of 100 % - otherwise nearly every region would look the same.
const SM_STOPS = [
  [0xFF, 0xE2, 0x86],   // yellow-200
  [0xFF, 0xC1, 0x00],   // yellow-500
  [0xF0, 0x80, 0x1A],   // amber-500
  [0xBF, 0x45, 0x1A],   // orange-600
];
const SM_SCALE_MAX = .5;
// partner without a published quota ("k. A."): for.Watt petrol - the palette's
// only cool colour, so it can't be mistaken for a point on the scale
const SM_NA = [0x25, 0x89, 0x98];
const rgb = (c, shade = 1) => `rgb(${c.map(v => Math.round(v * shade)).join(',')})`;
function smColor(r, shade = 1) {   // shade < 1 darkens (used for hover)
  if (r == null) return rgb(SM_NA, shade);
  const t = Math.min(Math.max(r / SM_SCALE_MAX, 0), 1) * (SM_STOPS.length - 1);
  const i = Math.min(Math.floor(t), SM_STOPS.length - 2), f = t - i;
  return rgb(SM_STOPS[i].map((a, k) => a + (SM_STOPS[i + 1][k] - a) * f), shade);
}
const smGradientCss = () => `linear-gradient(90deg, ${SM_STOPS.map(c => rgb(c)).join(', ')})`;
const smValue = id => { const e = smData[id]; return e ? e[state.smMetric] : null; };
const smMit = id => { const e = smData[id]; return e ? e.mit : null; };        // fixed metric for partner figures

// ---------- filtering ----------
function passes(id) {
  const sm = smValue(id);
  return sm == null || (sm >= state.smRange[0] && sm <= state.smRange[1]);
}

// ---------- map styling ----------
// a region picked via search keeps its hover look until the search is cleared
function styleFor(feature) {
  return feature.properties.vnb_id === state.searchHit ? hoverStyleFor(feature) : baseStyleFor(feature);
}
function baseStyleFor(feature) {
  const id = feature.properties.vnb_id;
  const ok = passes(id);
  const fill = smColor(smValue(id));
  const covered = state.forwatt && state.matched.has(id);

  // `stroke` is set explicitly everywhere: setStyle() merges, so a stroke:false
  // would otherwise stick when a feature switches to another state
  if (!ok) return { stroke: false, fillColor: fill, fillOpacity: .05 };
  if (state.forwatt) {
    // covered: each VNB is made of many Gemeinde polygons. Drawn opaque with a
    // 1px outline in the fill colour, so neither inner borders nor the hairline
    // anti-aliasing gaps between neighbouring polygons show. The see-through
    // look comes from the opacity of the whole regions pane (REGIONS_OPACITY),
    // which - unlike per-shape opacity - doesn't darken where shapes overlap.
    if (covered) return solidStyle(fill);
    // non-covered: not drawn at all (still hoverable for the tooltip)
    return { stroke: false, fillOpacity: 0 };
  }
  if (state.selected === id) return { stroke: true, fillColor: fill, weight: 3, color: '#1D1D1D', opacity: 1, fillOpacity: .9 };
  return { stroke: true, fillColor: fill, weight: 1, color: '#ffffff', opacity: .8, fillOpacity: smValue(id) != null ? .72 : .3 };
}
const REGIONS_OPACITY = .85;
const solidStyle = c => ({ stroke: true, color: c, weight: 1, opacity: 1, fillColor: c, fillOpacity: 1 });
// hover: covered regions turn a darker shade of their own colour; non-covered
// regions, invisible at rest, show up in neutral grey (for.Watt gray-300): colour = partner, grey = none
function hoverStyleFor(feature) {
  const base = baseStyleFor(feature);
  const id = feature.properties.vnb_id;
  if (state.forwatt) return solidStyle(state.matched.has(id) ? smColor(smValue(id), .78) : '#889499');
  const lift = Math.min(Math.max(base.fillOpacity, .5) + .22, .95);
  return { ...base, weight: 1.6, color: '#1D1D1D', opacity: .9, dashArray: null, fillOpacity: lift };
}
function restyle() {
  if (!geoLayer) return;
  geoLayer.setStyle(styleFor);
  const layers = state.hovered != null ? layersByVnb[state.hovered] : null;
  if (layers) layers.forEach(layer => layer.setStyle(hoverStyleFor(layer.feature)));
}

// ---------- tooltip ----------
function tooltipHtml(f) {
  const p = f.properties, id = p.vnb_id;
  const sm = smValue(id);
  const cov = state.matched.has(id);
  const partner = cov && state.coverage
    ? state.coverage.partners.find(x => x.vnbId === id) : null;
  return `<div class="vnb-tt">
    <h3>${esc(p.name)}</h3>
    <div class="c">${esc(p.city || '')} · ${(p.types || []).length} Spannungsebenen</div>
    ${p.gemeinde ? `<div class="gem">Ort <b>${esc(p.gemeinde)}</b></div>` : ''}
    <div class="kv"><span>Smart Meter (Pflichteinbaufälle)</span><b>${sm != null ? (sm * 100).toFixed(1) + ' %' : 'k. A.'}</b></div>
    ${cov ? `<div class="fw">✓ Abgedeckt durch for.Watt</div>` : ''}
  </div>`;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- init ----------
async function init() {
  const [geo, dso, sm, border] = await Promise.all([
    fetch('data/geo.json').then(r => r.json()),
    fetch('data/dso.json').then(r => r.json()),
    fetch('data/sm.json').then(r => r.json()),
    fetch('data/de-border.json').then(r => r.json()).catch(() => null),  // optional decoration
  ]);

  dsoList = dso;
  dso.forEach(d => { dsoById[d.id] = d; });
  const period = sm.periods[sm.periods.length - 1];
  smData = period.data;
  document.getElementById('period-label').textContent = period.label;

  map = L.map('map', {
    zoomControl: true, preferCanvas: true,
    // gentler mouse-wheel zoom: Leaflet's defaults (snap 1, 60 px/level) jump
    // ~2 levels per wheel notch; this gives ~0.75 levels per notch. The +/-
    // buttons keep zoomDelta 1.
    zoomSnap: 0.25,
    wheelPxPerZoomLevel: 120,
  }).setView([51.2, 10.4], 6);
  L.tileLayer(
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }
  ).addTo(map);


  if (border) addOutsideMask(border);

  // own pane + canvas for the regions, so their transparency is applied once
  // to the finished picture (see styleFor)
  const regionsPane = map.createPane('regions');
  regionsPane.style.opacity = REGIONS_OPACITY;
  regionsPane.style.zIndex = 400;
  geoLayer = L.geoJSON(geo, {
    renderer: L.canvas({ pane: 'regions' }),
    style: styleFor,
    onEachFeature: (f, layer) => {
      const id = f.properties.vnb_id;
      (layersByVnb[id] || (layersByVnb[id] = [])).push(layer);
      layer.bindTooltip(() => tooltipHtml(f), { className: 'vnb-tt', sticky: true, direction: 'top' });
      // click a region: it stays highlighted; a click on empty map clears that
      layer.on('click', e => { L.DomEvent.stopPropagation(e); state.selected = id; highlight(id); });
      layer.on('mouseover', () => {
        state.hovered = id;
        layersByVnb[id].forEach(l => {
          l.setStyle(hoverStyleFor(l.feature));
          if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) l.bringToFront();
        });
      });
      layer.on('mouseout', () => {
        if (state.hovered === id) state.hovered = null;
        layersByVnb[id].forEach(l => l.setStyle(styleFor(l.feature)));
      });
    },
  }).addTo(map);
  map.on('click', () => { if (state.searchHit != null) highlight(null); });
  initOutline();

  addMapLegend();
  addSearch(geoLayer);
  document.getElementById('loading').style.display = 'none';
  wireControls();
  // renderLegend();  // Kartenmodus-Panel (inkl. #legend) ist im HTML auskommentiert
  renderList();
  updateCount();
  loadForwatt();  // auto-refresh coverage on every page open
}

// ---------- search: Städte / Gemeinden / Netzbetreiber (Stadtwerke etc.) ----------
const LAENDER = { '01': 'SH', '02': 'HH', '03': 'NI', '04': 'HB', '05': 'NW', '06': 'HE', '07': 'RP', '08': 'BW',
  '09': 'BY', '10': 'SL', '11': 'BE', '12': 'BB', '13': 'MV', '14': 'SN', '15': 'ST', '16': 'TH' };
// lenient matching: case, accents, ß, and ä/ae spellings all compare equal
const norm = s => String(s).toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u')
  .replace(/[^a-z0-9]+/g, ' ').trim();
// 0: name starts with the query, 1: a word starts with it, 2: contains it
function matchScore(key, q) {
  if (key.startsWith(q)) return 0;
  if (key.includes(' ' + q)) return 1;
  return key.includes(q) ? 2 : -1;
}

function addSearch(layer) {
  // one entry per Gemeinde (some consist of several polygons)
  const gemByAgs = new Map();
  layer.eachLayer(l => {
    const p = l.feature.properties;
    let g = gemByAgs.get(p.ags);
    if (!g) gemByAgs.set(p.ags, g = { kind: 'gem', name: p.gemeinde, key: norm(p.gemeinde),
      land: LAENDER[String(p.ags).slice(0, 2)] || '', vnbId: p.vnb_id, layers: [] });
    g.layers.push(l);
  });
  const entries = [...gemByAgs.values(), ...dsoList.map(d => ({ kind: 'vnb', name: d.name.trim(),
    key: norm(d.name), cityKey: norm(d.city || ''), city: d.city || '', vnbId: d.id,
    hasGeo: !!(layersByVnb[d.id] && layersByVnb[d.id].length) }))];

  const ctl = L.control({ position: 'topright' });
  ctl.onAdd = () => {
    const el = L.DomUtil.create('div', 'map-search');
    el.innerHTML = `
      <div class="ms-box">
        <input type="search" placeholder="Stadt oder Netzbetreiber suchen…" aria-label="Suche" autocomplete="off" spellcheck="false">
        <button class="ms-clear" type="button" title="Suche leeren" hidden>✕</button>
      </div>
      <div class="ms-results" hidden></div>`;
    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.disableScrollPropagation(el);
    return el;
  };
  ctl.addTo(map);
  const root = ctl.getContainer();
  const input = root.querySelector('input'), clearBtn = root.querySelector('.ms-clear');
  const box = root.querySelector('.ms-results');
  let hits = [], active = 0;

  function search(qRaw) {
    const q = norm(qRaw);
    if (q.length < 2) return [];
    const scored = [];
    for (const e of entries) {
      let s = matchScore(e.key, q);
      if (s < 0 && e.kind === 'vnb') { s = matchScore(e.cityKey, q); if (s >= 0) s += 1; }  // VNB found via its seat
      if (s >= 0) scored.push([s, e]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length || a[1].name.localeCompare(b[1].name, 'de'));
    const pick = kind => scored.filter(x => x[1].kind === kind).slice(0, 6).map(x => x[1]);
    return [...pick('gem'), ...pick('vnb')];
  }

  function itemHtml(e, i) {
    const partner = state.matched.has(e.vnbId);
    const v = smMit(e.vnbId);
    const quote = partner ? ` · ${v == null ? 'k. A.' : Math.round(v * 100) + ' %'}` : '';
    const tag = partner ? `<span class="ms-tag">for.Watt${quote}</span>` : '';
    if (e.kind === 'gem') {
      const vnb = dsoById[e.vnbId];
      return `<div class="ms-item" data-i="${i}"><div class="ms-name">${esc(e.name)}${e.land ? ` <span class="ms-land">${e.land}</span>` : ''}</div>
        <div class="ms-sub">${esc(vnb ? vnb.name.trim() : '')} ${tag}</div></div>`;
    }
    return `<div class="ms-item${e.hasGeo ? '' : ' disabled'}" data-i="${i}"><div class="ms-name">${esc(e.name)}</div>
      <div class="ms-sub">${esc(e.city)}${e.hasGeo ? '' : ' · <i>nicht kartiert</i>'} ${tag}</div></div>`;
  }

  function render() {
    const q = input.value;
    clearBtn.hidden = !q;
    if (norm(q).length < 2) { box.hidden = true; return; }
    hits = search(q);
    active = hits.findIndex(isSelectable);
    if (!hits.length) { box.innerHTML = '<div class="ms-empty">Keine Treffer</div>'; box.hidden = false; return; }
    const nGem = hits.filter(e => e.kind === 'gem').length;
    box.innerHTML = hits.map((e, i) =>
      (i === 0 && nGem ? '<div class="ms-group">Städte</div>' : '') +
      (i === nGem ? '<div class="ms-group">Netzbetreiber</div>' : '') + itemHtml(e, i)).join('');
    box.querySelectorAll('.ms-item').forEach(it => {
      // pick on click, not mousedown: hiding the list on mousedown let the
      // following mouseup/click land on the map, whose click clears the
      // highlight again. preventDefault keeps the focus (no blur-close).
      it.onmousedown = ev => ev.preventDefault();
      it.onclick = () => choose(hits[+it.dataset.i]);
    });
    markActive();
    box.hidden = false;
  }
  const isSelectable = e => e.kind === 'gem' || e.hasGeo;
  function markActive() {
    box.querySelectorAll('.ms-item').forEach(it => it.classList.toggle('active', +it.dataset.i === active));
    const a = box.querySelector('.ms-item.active');
    if (a) a.scrollIntoView({ block: 'nearest' });
  }
  function move(dir) {
    if (!hits.length) return;
    let i = active;
    for (let n = 0; n < hits.length; n++) {
      i = (i + dir + hits.length) % hits.length;
      if (isSelectable(hits[i])) { active = i; break; }
    }
    markActive();
  }

  function choose(e) {
    if (!e || !isSelectable(e)) return;
    input.value = e.name;
    box.hidden = true;
    input.blur();
    if (e.kind === 'vnb') { focusVnb(e.vnbId); return; }
    const bounds = L.latLngBounds([]);
    e.layers.forEach(l => bounds.extend(l.getBounds()));
    highlight(e.vnbId, e.layers);
    map.fitBounds(bounds, { maxZoom: 11, padding: [40, 40] });
    e.layers[0].openTooltip(bounds.getCenter());
    if (isMobile()) setSidebarOpen(false);
  }
  function clear() {
    input.value = ''; box.hidden = true; clearBtn.hidden = true;
    (layersByVnb[state.searchHit] || []).forEach(l => l.closeTooltip());
    highlight(null);
  }

  input.addEventListener('input', render);
  input.addEventListener('focus', render);
  input.addEventListener('blur', () => setTimeout(() => { box.hidden = true; }, 120));
  input.addEventListener('keydown', ev => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); move(1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); move(-1); }
    else if (ev.key === 'Enter') { ev.preventDefault(); choose(hits[active]); }
    else if (ev.key === 'Escape') { if (!box.hidden) box.hidden = true; else clear(); }
  });
  clearBtn.onclick = () => { clear(); input.focus(); };
}

// keep one VNB's regions highlighted (search / list pick); null clears it.
// gemLayers: the searched Gemeinde's polygons, drawn with a dashed outline
function highlight(id, gemLayers = null) {
  state.searchHit = id;
  outline.gemLayers = id != null ? gemLayers : null;
  restyle();
  if (id != null && layersByVnb[id]) layersByVnb[id].forEach(l => l.bringToFront());
  drawOutline();
}

// ---------- outline of the highlighted VNB area ----------
// A VNB area is made of many Gemeinde polygons, so stroking them would also
// draw every inner border. Instead, on a canvas of its own: stroke all of them
// thickly, then erase their interiors (destination-out). What's left is just
// the outer edge of the whole area. The erase pass also strokes thinly, which
// closes hairline gaps between neighbouring Gemeinden that would otherwise
// leave specks of outline inside.
const OUTLINE = { color: '#394D55', width: 2.5, gemColor: '#1D1D1D' };
const outline = { canvas: null, gemLayers: null };

function initOutline() {
  const pane = map.createPane('outline');
  pane.style.zIndex = 410;              // above the regions (400), below tooltips
  pane.style.pointerEvents = 'none';
  outline.canvas = L.DomUtil.create('canvas', '', pane);
  // positions go stale while Leaflet animates a zoom - hide, redraw at the end
  map.on('zoomstart', () => { outline.canvas.style.visibility = 'hidden'; });
  map.on('moveend resize', drawOutline);
}

// polygons of a layer as [polygon][ring][LatLng], whatever its geometry type
function polygonsOf(layer) {
  const ll = layer.getLatLngs();
  if (L.LineUtil.isFlat(ll)) return [[ll]];
  if (L.LineUtil.isFlat(ll[0])) return [ll];
  return ll;
}

function drawOutline() {
  const canvas = outline.canvas;
  if (!canvas) return;
  const size = map.getSize(), pad = size.multiplyBy(.3).round();   // margin so short pans stay drawn
  const topLeft = map.containerPointToLayerPoint(pad.multiplyBy(-1)).round();
  const w = size.x + 2 * pad.x, h = size.y + 2 * pad.y, dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  L.DomUtil.setPosition(canvas, topLeft);
  canvas.style.visibility = 'visible';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const layers = state.searchHit != null ? layersByVnb[state.searchHit] : null;
  if (!layers || !layers.length) return;
  const polys = layers.flatMap(polygonsOf);
  const tracePoly = poly => poly.forEach(ring => {
    ring.forEach((ll, i) => {
      const p = map.latLngToLayerPoint(ll).subtract(topLeft);
      i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
    });
    ctx.closePath();
  });
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';

  // 1) thick stroke around every polygon (half of it lies outside the area)
  ctx.beginPath(); polys.forEach(tracePoly);
  ctx.strokeStyle = OUTLINE.color; ctx.lineWidth = 2 * (OUTLINE.width + 1); ctx.stroke();
  // 2) erase the inside (+1px, to close gaps between neighbours)
  ctx.globalCompositeOperation = 'destination-out';
  polys.forEach(poly => { ctx.beginPath(); tracePoly(poly); ctx.fill('evenodd'); });
  ctx.beginPath(); polys.forEach(tracePoly); ctx.lineWidth = 2; ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';

  // 3) the searched Gemeinde: thin dashed outline on top
  if (outline.gemLayers) {
    ctx.beginPath(); outline.gemLayers.flatMap(polygonsOf).forEach(tracePoly);
    ctx.setLineDash([5, 4]); ctx.strokeStyle = OUTLINE.gemColor; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ---------- outside Germany: a veil over foreign countries and the sea ----------
// One polygon: a world-sized ring with every German land polygon cut out as a
// hole (Leaflet fills even-odd), drawn between the base map and the regions.
function addOutsideMask(border) {
  const pane = map.createPane('outside');
  pane.style.zIndex = 390;
  pane.style.pointerEvents = 'none';
  const toLatLngs = ring => ring.map(([lng, lat]) => [lat, lng]);
  const world = [[-85, -180], [-85, 180], [85, 180], [85, -180]];
  const holes = border.geometry.coordinates.flatMap(poly => poly.map(toLatLngs));
  L.polygon([world, ...holes], {
    renderer: L.canvas({ pane: 'outside' }), interactive: false,
    stroke: true, color: '#394D55', weight: 1, opacity: .55,   // national border line
    fillColor: '#394D55', fillOpacity: .28, fillRule: 'evenodd',
  }).addTo(map);
}

// ---------- controls ----------
function wireControls() {
  document.querySelectorAll('input[name=smmetric]').forEach(r =>
    r.onchange = () => { state.smMetric = r.value; restyle(); renderLegend(); renderList(); });

  // Schalter deaktiviert: for.Watt-Abdeckung ist dauerhaft aktiv (state.forwatt bleibt true).
  // document.getElementById('forwatt-toggle').onchange = e => {
  //   state.forwatt = e.target.checked;
  //   if (state.forwatt && !state.coverage) loadForwatt(); // in case it hasn't landed yet
  //   restyle();
  // };

  const sidebarEl = document.getElementById('sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle');
  const backdrop = document.getElementById('sidebar-backdrop');
  toggleBtn.onclick = () => setSidebarOpen(sidebarEl.classList.contains('collapsed'));
  if (backdrop) backdrop.onclick = () => setSidebarOpen(false);
  // start with the map in view on phones; the sidebar opens as an overlay on demand
  if (isMobile()) setSidebarOpen(false);

  // Filter-Panel (inkl. #reset-btn) ist im HTML auskommentiert.
  const resetBtn = document.getElementById('reset-btn');
  if (resetBtn) resetBtn.onclick = () => {
    state.smRange = [0, 1]; state.selected = null;
    buildSliders(); applyFilterUi(); restyle();
  };

  buildSliders();
}

// dual range slider
function buildSliders() {
  makeDual('sm-slider', 0, 100, state.smRange[0] * 100, state.smRange[1] * 100, (lo, hi) => {
    state.smRange = [lo / 100, hi / 100];
    document.getElementById('sm-range-label').textContent = `${lo} – ${hi} %`;
    onFilterChange();
  });
}
function makeDual(elId, min, max, valLo, valHi, cb) {
  const el = document.getElementById(elId);
  if (!el) return;  // Filter-Panel ist im HTML auskommentiert
  el.innerHTML = `<div class="track"><div class="fill"></div></div>
    <input type="range" class="lo" min="${min}" max="${max}" value="${valLo}">
    <input type="range" class="hi" min="${min}" max="${max}" value="${valHi}">`;
  const lo = el.querySelector('.lo'), hi = el.querySelector('.hi'), fill = el.querySelector('.fill');
  const upd = () => {
    let a = +lo.value, b = +hi.value; if (a > b) [a, b] = [b, a];
    fill.style.left = ((a - min) / (max - min) * 100) + '%';
    fill.style.right = (100 - (b - min) / (max - min) * 100) + '%';
    cb(a, b);
  };
  lo.oninput = hi.oninput = upd; upd();
}
function applyFilterUi() { buildSliders(); }

let filterTimer;
function onFilterChange() { clearTimeout(filterTimer); filterTimer = setTimeout(() => { restyle(); renderList(); updateCount(); }, 60); }

function updateCount() {
  const el = document.getElementById('vnb-count');
  if (!el) return;  // Filter-Panel ist im HTML auskommentiert
  const total = Object.keys(dsoById).length;
  const n = Object.keys(dsoById).filter(passes).length;
  el.textContent = `${n} / ${total} VNB`;
}

// ---------- map legend (colour scale, bottom right of the map) ----------
function addMapLegend() {
  const legend = L.control({ position: 'bottomright' });
  legend.onAdd = () => {
    const el = L.DomUtil.create('div', 'map-legend');
    const max = SM_SCALE_MAX * 100;
    el.innerHTML = `
      <div class="ml-title">Smart Meter Quote</div>
      <div class="ml-sub">Pflichteinbaufälle mit iMSys</div>
      <div class="ml-bar" style="background:${smGradientCss()}; opacity:${REGIONS_OPACITY}"></div>
      <div class="ml-ticks"><span>0 %</span><span>${max / 2} %</span><span>≥ ${max} %</span></div>
      <div class="ml-na"><span class="ml-swatch" style="background:${smColor(null)}; opacity:${REGIONS_OPACITY}"></span>keine Angabe (k. A.)</div>`;
    L.DomEvent.disableClickPropagation(el);
    return el;
  };
  legend.addTo(map);
}

// ---------- legend (sidebar, currently commented out in the HTML) ----------
function renderLegend() {
  const el = document.getElementById('legend');
  const ids = Object.keys(dsoById).filter(passes);
  const grad = smGradientCss();
  const ticks = ['0 %', '25 %', `≥ ${SM_SCALE_MAX * 100} %`];
  const vals = ids.map(smValue).filter(v => v != null);
  const kA = ids.length - vals.length;
  el.innerHTML = legendBody(grad, ticks, vals.map(v => v * 100), '%', kA);
}
function legendBody(grad, ticks, vals, unit, kA) {
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  const min = vals.length ? Math.min(...vals) : null, max = vals.length ? Math.max(...vals) : null;
  const f = n => n == null ? '-' : n.toFixed(1) + unit;
  return `<div class="bar" style="background:${grad}"></div>
    <div class="ticks">${ticks.map(t => `<span>${t}</span>`).join('')}</div>
    <div class="stats"><span>Mittel <b>${f(mean)}</b></span><span>Min <b>${f(min)}</b></span><span>Max <b>${f(max)}</b></span><span>k. A. <b>${kA}</b></span></div>`;
}

// ---------- ranking list ----------
function renderList() {
  const el = document.getElementById('vnb-list');
  const title = document.getElementById('list-title');
  if (!el || !title) return;  // Ranking-Panel ist im HTML auskommentiert
  const ids = Object.keys(dsoById).filter(passes);
  title.textContent = 'Ranking Smart-Meter-Quote';
  ids.sort((a, b) => (smValue(b) ?? -1) - (smValue(a) ?? -1));
  el.innerHTML = ids.slice(0, 200).map((id, i) => {
    const d = dsoById[id], v = smValue(id);
    const label = v == null ? 'k. A.' : (v * 100).toFixed(1) + ' %';
    const bg = smColor(v);
    const cov = state.matched.has(id);
    return `<div class="vnb-row" data-id="${id}">
      <span class="rank">${i + 1}</span>
      <span class="name">${esc(d.name)}</span>
      ${cov ? '<span class="fwtag" title="for.Watt-Abdeckung">●</span>' : ''}
      <span class="badge" style="background:${bg}">${label}</span>
    </div>`;
  }).join('');
  el.querySelectorAll('.vnb-row').forEach(row => row.onclick = () => focusVnb(row.dataset.id));
}

function focusVnb(id) {
  state.selected = id; highlight(id);
  const d = dsoById[id];
  if (d && d.bbox) map.fitBounds([[d.bbox[1], d.bbox[0]], [d.bbox[3], d.bbox[2]]], { maxZoom: 10, padding: [40, 40] });
  const layers = layersByVnb[id];
  if (layers && layers.length) layers[0].openTooltip();
  if (isMobile()) setSidebarOpen(false);  // reveal the map after picking a VNB from the list
}

// ---------- for.Watt coverage (from the maintained list, resolved on each load) ----------
async function loadForwatt() {
  const status = document.getElementById('forwatt-status');
  status.className = 'forwatt-status'; status.textContent = 'Messstellenbetreiber werden geladen…';
  try {
    // cache-bust so each page open reflects the latest committed list
    const list = await fetch('data/messstellenbetreiber.json?t=' + Date.now()).then(r => r.json());
    const cov = MsbMatch.resolve(list.operators, dsoList, list.aliases);
    state.coverage = cov;
    state.matched = new Set(cov.matchedVnbIds);
    status.className = 'forwatt-status ok';
    status.textContent = `${cov.matchedVnbIds.length} von ${cov.partners.length} Messstellenbetreiber auf VNB-Gebiete abgebildet`;
    renderForwattList();
    renderList();
    restyle();
  } catch (e) {
    status.className = 'forwatt-status err';
    status.textContent = 'Messstellenbetreiber-Liste nicht verfügbar: ' + e.message;
  }
}
function renderForwattList() {
  const el = document.getElementById('forwatt-list');
  const parts = state.coverage.partners;
  const matched = parts.filter(p => p.vnbId).sort((a, b) => a.vnbName.localeCompare(b.vnbName));
  const other = parts.filter(p => !p.vnbId).sort((a, b) => a.name.localeCompare(b.name));
  const matchedItem = p => {
    const v = smMit(p.vnbId);
    const label = v == null ? 'k. A.' : Math.round(v * 100) + '%';
    // some VNBs from the registry have no mapped municipality polygon (no shape
    // to zoom to) - show them, but don't dress them up as clickable
    const hasGeo = !!(layersByVnb[p.vnbId] && layersByVnb[p.vnbId].length);
    const where = hasGeo ? esc(p.city || '') : '<span class="no-geo">nicht kartiert</span>';
    return `
    <div class="fw-item${hasGeo ? ' matched' : ''}" data-id="${p.vnbId}">
      <div class="fw-row1">
        <span class="check">✓</span>
        <span class="who">${esc(p.vnbName)} <span class="fw-pct" title="Smart-Meter-Quote: Pflichteinbaufälle mit iMSys">(${label})</span></span>
        <span class="where">${where}</span>
      </div>
    </div>`;
  };
  const otherItem = p => `
    <div class="fw-item unmatched">
      <div class="fw-row1"><span class="check">✓</span><span class="who">${esc(p.name)}</span></div>
    </div>`;
  // one scrolling list; the group headings are sticky so "wMSB" stays visible
  // once you scroll to it, while its items only appear as you scroll further
  el.innerHTML =
    `<div class="fw-group">
      <span>Grundzuständige MSB · mit Netzgebiet · ${matched.length}</span>
      <span class="fw-group-metric">Messstellenbetreiber (% Pflichteinbaufälle mit iMSys)</span>
    </div>` +
    matched.map(matchedItem).join('') +
    `<div class="fw-group fw-group-wmsb">Wettbewerbliche / überregionale MSB · ${other.length}</div>` +
    other.map(otherItem).join('');
  el.querySelectorAll('.fw-item.matched').forEach(it => it.onclick = () => focusVnb(it.dataset.id));
}

init();
