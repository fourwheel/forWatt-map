'use strict';

const state = {
  smMetric: 'mit',       // 'mit' | 'ohne'
  forwatt: true,
  smRange: [0, 1],       // ratio
  coverage: null,        // { partners, matchedVnbIds }
  matched: new Set(),
  selected: null,
  hovered: null,         // vnb_id currently under the cursor
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
function smColor(r) {
  if (r == null) return '#475569';
  return `hsl(${Math.round(r * 120)}, 68%, 46%)`;          // red -> yellow -> green
}
const smValue = id => { const e = smData[id]; return e ? e[state.smMetric] : null; };
const smMit = id => { const e = smData[id]; return e ? e.mit : null; };        // fixed metric for partner figures
const pct = r => r == null ? 'k. A.' : (r * 100).toFixed(1) + ' %';

// ---------- filtering ----------
function passes(id) {
  const sm = smValue(id);
  return sm == null || (sm >= state.smRange[0] && sm <= state.smRange[1]);
}

// ---------- map styling ----------
function styleFor(feature) {
  const id = feature.properties.vnb_id;
  const ok = passes(id);
  const fill = smColor(smValue(id));
  const covered = state.forwatt && state.matched.has(id);

  if (!ok) return { fillColor: fill, weight: 0.5, color: '#ffffff', opacity: .5, fillOpacity: .05 };
  if (state.forwatt) {
    // covered: keep the region's choropleth colour, mark coverage with the for.Watt orange outline
    if (covered) return { fillColor: fill, weight: 2.5, color: '#E75420', opacity: 1, fillOpacity: .85 };
    // non-covered: light grey wash so the country shape stays visible
    return { fillColor: '#B8C0C4', weight: 0.5, color: '#ffffff', opacity: .6, fillOpacity: .45 };
  }
  if (state.selected === id) return { fillColor: fill, weight: 3, color: '#1D1D1D', opacity: 1, fillOpacity: .9 };
  return { fillColor: fill, weight: 1, color: '#ffffff', opacity: .8, fillOpacity: smValue(id) != null ? .72 : .3 };
}
// hover: keep the region's own colours; lean on a fill lift so the territory
// reads as one solid block, with just a thin outline on top
function hoverStyleFor(feature) {
  const base = styleFor(feature);
  return { ...base, weight: 1.6, color: '#1D1D1D', opacity: .9, dashArray: null,
    fillOpacity: Math.min(Math.max(base.fillOpacity, .5) + .22, .95) };
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
    <div class="kv"><span>Smart Meter (Pflichteinbaufälle)</span><b>${sm != null ? (sm * 100).toFixed(1) + ' %' : 'k. A.'}</b></div>
    ${cov ? `<div class="fw">✓ Abgedeckt durch for.Watt</div>` : ''}
  </div>`;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- init ----------
async function init() {
  const [geo, dso, sm] = await Promise.all([
    fetch('data/geo.json').then(r => r.json()),
    fetch('data/dso.json').then(r => r.json()),
    fetch('data/sm.json').then(r => r.json()),
  ]);

  dsoList = dso;
  dso.forEach(d => { dsoById[d.id] = d; });
  const period = sm.periods[sm.periods.length - 1];
  smData = period.data;
  document.getElementById('period-label').textContent = period.label;

  map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([51.2, 10.4], 6);
  L.tileLayer(
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }
  ).addTo(map);


  geoLayer = L.geoJSON(geo, {
    style: styleFor,
    onEachFeature: (f, layer) => {
      const id = f.properties.vnb_id;
      (layersByVnb[id] || (layersByVnb[id] = [])).push(layer);
      layer.bindTooltip(() => tooltipHtml(f), { className: 'vnb-tt', sticky: true, direction: 'top' });
      layer.on('click', () => { state.selected = id; restyle(); });
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

  document.getElementById('loading').style.display = 'none';
  wireControls();
  // renderLegend();  // Kartenmodus-Panel (inkl. #legend) ist im HTML auskommentiert
  renderList();
  updateCount();
  loadForwatt();  // auto-refresh coverage on every page open
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

  const forwattListEl = document.getElementById('forwatt-list');
  if (forwattListEl) forwattListEl.onscroll = updateForwattFade;
  window.addEventListener('resize', updateForwattFade);

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

// ---------- legend ----------
function renderLegend() {
  const el = document.getElementById('legend');
  const ids = Object.keys(dsoById).filter(passes);
  const grad = 'linear-gradient(90deg, hsl(0,68%,46%), hsl(60,68%,46%), hsl(120,68%,46%))';
  const ticks = ['0 %', '25 %', '50 %', '75 %', '100 %'];
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
  state.selected = id; restyle();
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
  const matched = parts.filter(p => p.vnbId).sort((a, b) => (smMit(b.vnbId) ?? -1) - (smMit(a.vnbId) ?? -1));
  const other = parts.filter(p => !p.vnbId).sort((a, b) => a.name.localeCompare(b.name));
  const matchedItem = p => `
    <div class="fw-item matched" data-id="${p.vnbId}">
      <div class="fw-row1"><span class="check">✓</span><span class="who">${esc(p.vnbName)}</span><span class="where">${esc(p.city || '')}</span></div>
      <div class="fw-metrics">
        <span title="Smart-Meter-Quote (mit opt. Einbaufällen)">${pct(smMit(p.vnbId))} Pflichteinbaufälle mit iMSys</span>
      </div>
    </div>`;
  const otherItem = p => `
    <div class="fw-item unmatched">
      <div class="fw-row1"><span class="check">✓</span><span class="who">${esc(p.name)}</span><span class="where">wMSB</span></div>
    </div>`;
  el.innerHTML =
    `<div class="fw-group">Grundzuständige MSB · mit Netzgebiet · ${matched.length}</div>` +
    matched.map(matchedItem).join('') +
    `<div class="fw-group">Wettbewerbliche / überregionale MSB (wMSB) · ${other.length}</div>` +
    other.map(otherItem).join('');
  el.querySelectorAll('.fw-item.matched').forEach(it => it.onclick = () => focusVnb(it.dataset.id));
  updateForwattFade();
}

// shows a bottom fade on the list while there's more content to scroll to
// (e.g. the wMSB group below the matched VNBs), hides it once fully scrolled
function updateForwattFade() {
  const list = document.getElementById('forwatt-list');
  const fade = document.getElementById('forwatt-list-fade');
  if (!list || !fade) return;
  const hasMore = list.scrollHeight - list.scrollTop - list.clientHeight > 2;
  fade.classList.toggle('visible', hasMore);
}

init();
