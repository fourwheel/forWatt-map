'use strict';

const state = {
  mode: 'sm',            // 'sm' | 'mc'
  smMetric: 'mit',       // 'mit' | 'ohne'
  forwatt: false,
  smRange: [0, 1],       // ratio
  mcRange: [0, 4000000],
  coverage: null,        // { partners, matchedVnbIds }
  matched: new Set(),
  selected: null,
};

let map, geoLayer, dsoById = {}, smData = {}, meterCounts = {}, layersByVnb = {};

// ---------- color scales ----------
function smColor(r) {
  if (r == null) return '#475569';
  return `hsl(${Math.round(r * 120)}, 68%, 46%)`;          // red -> yellow -> green
}
function mcColor(c) {
  if (c == null) return '#475569';
  const t = Math.min(Math.max((Math.log10(Math.max(c, 1000)) - 3) / (Math.log10(4000000) - 3), 0), 1);
  return `hsl(${Math.round(220 + t * 100)}, 70%, ${Math.round(38 + t * 14)}%)`; // blue -> pink
}
const smValue = id => { const e = smData[id]; return e ? e[state.smMetric] : null; };
const mcValue = id => (id in meterCounts ? meterCounts[id] : null);
const smMit = id => { const e = smData[id]; return e ? e.mit : null; };        // fixed metric for partner figures
const smartMeters = id => { const r = smMit(id), mc = mcValue(id); return r != null && mc != null ? Math.round(r * mc) : null; };
const fmtK = n => n == null ? '–' : n >= 1e6 ? (n / 1e6).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' Mio.'
  : n >= 1e3 ? Math.round(n / 1e3).toLocaleString('de-DE') + 'k' : String(Math.round(n));
const pct = r => r == null ? 'k. A.' : (r * 100).toFixed(1) + ' %';

// ---------- filtering ----------
function passes(id) {
  const sm = smValue(id);
  if (sm != null && (sm < state.smRange[0] || sm > state.smRange[1])) return false;
  const mc = mcValue(id);
  if (mc != null && (mc < state.mcRange[0] || mc > state.mcRange[1])) return false;
  return true;
}

// ---------- map styling ----------
function styleFor(feature) {
  const id = feature.properties.vnb_id;
  const ok = passes(id);
  const fill = state.mode === 'sm' ? smColor(smValue(id)) : mcColor(mcValue(id));
  const covered = state.forwatt && state.matched.has(id);

  if (!ok) return { fillColor: fill, weight: 0.5, color: '#0f172a', opacity: .5, fillOpacity: .06 };
  if (state.forwatt) {
    if (covered) return { fillColor: '#E75420', weight: 2, color: '#ffb08a', opacity: 1, fillOpacity: .85 };
    // non-covered: muted grey so the country shape stays visible (never blacked out)
    return { fillColor: '#64748b', weight: 0.5, color: '#0f172a', opacity: .4, fillOpacity: .3 };
  }
  if (state.selected === id) return { fillColor: fill, weight: 2.5, color: '#38bdf8', opacity: 1, fillOpacity: .85 };
  return { fillColor: fill, weight: 1, color: '#0f172a', opacity: .8, fillOpacity: smValue(id) != null || mcValue(id) != null ? .7 : .35 };
}
function restyle() { if (geoLayer) geoLayer.setStyle(styleFor); }

// ---------- tooltip ----------
function tooltipHtml(f) {
  const p = f.properties, id = p.vnb_id;
  const sm = smValue(id), mc = mcValue(id);
  const cov = state.matched.has(id);
  const partner = cov && state.coverage
    ? state.coverage.partners.find(x => x.vnbId === id) : null;
  return `<div class="vnb-tt">
    <h3>${esc(p.name)}</h3>
    <div class="c">${esc(p.city || '')} · ${(p.types || []).length} Spannungsebenen</div>
    <div class="kv"><span>Smart-Meter-Quote</span><b>${sm != null ? (sm * 100).toFixed(1) + ' %' : 'k. A.'}</b></div>
    <div class="kv"><span>Zähler</span><b>${mc != null ? mc.toLocaleString('de-DE') : 'k. A.'}</b></div>
    ${cov ? `<div class="fw">● for.watt-Abdeckung${partner ? ' · ' + esc(partner.name) : ''}</div>` : ''}
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

  dso.forEach(d => { dsoById[d.id] = d; });
  const period = sm.periods[sm.periods.length - 1];
  smData = period.data;
  document.getElementById('period-label').textContent = period.label;
  for (const [k, v] of Object.entries(sm.meter_counts || {})) meterCounts[k] = typeof v === 'object' ? v.total : v;

  map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([51.2, 10.4], 6);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap © CARTO', subdomains: 'abcd', maxZoom: 19,
  }).addTo(map);

  geoLayer = L.geoJSON(geo, {
    style: styleFor,
    onEachFeature: (f, layer) => {
      const id = f.properties.vnb_id;
      layersByVnb[id] = layer;
      layer.bindTooltip(() => tooltipHtml(f), { className: 'vnb-tt', sticky: true, direction: 'top' });
      layer.on('click', () => { state.selected = id; restyle(); });
    },
  }).addTo(map);

  document.getElementById('loading').style.display = 'none';
  wireControls();
  renderLegend();
  renderList();
  updateCount();
  loadForwatt();  // auto-refresh coverage on every page open
}

// ---------- controls ----------
function wireControls() {
  document.querySelectorAll('#mode-seg button').forEach(b =>
    b.onclick = () => {
      document.querySelectorAll('#mode-seg button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      state.mode = b.dataset.mode;
      document.getElementById('sm-metric-row').classList.toggle('hidden', state.mode !== 'sm');
      restyle(); renderLegend(); renderList();
    });

  document.querySelectorAll('input[name=smmetric]').forEach(r =>
    r.onchange = () => { state.smMetric = r.value; restyle(); renderLegend(); renderList(); });

  document.getElementById('forwatt-toggle').onchange = e => {
    state.forwatt = e.target.checked;
    if (state.forwatt && !state.coverage) loadForwatt(); // in case it hasn't landed yet
    restyle();
  };

  document.getElementById('sidebar-toggle').onclick = e => {
    document.getElementById('sidebar').classList.toggle('collapsed');
    e.target.classList.toggle('collapsed');
    e.target.textContent = e.target.classList.contains('collapsed') ? '▶' : '◀';
    setTimeout(() => map.invalidateSize(), 320);
  };

  document.getElementById('reset-btn').onclick = () => {
    state.smRange = [0, 1]; state.mcRange = [0, 4000000]; state.selected = null;
    buildSliders(); applyFilterUi(); restyle();
  };

  buildSliders();
}

// dual range sliders
function buildSliders() {
  makeDual('sm-slider', 0, 100, state.smRange[0] * 100, state.smRange[1] * 100, (lo, hi) => {
    state.smRange = [lo / 100, hi / 100];
    document.getElementById('sm-range-label').textContent = `${lo} – ${hi} %`;
    onFilterChange();
  });
  makeDual('mc-slider', 0, 4000000, state.mcRange[0], state.mcRange[1], (lo, hi) => {
    state.mcRange = [lo, hi];
    const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + ' Mio.' : n.toLocaleString('de-DE');
    document.getElementById('mc-range-label').textContent = `${fmt(lo)} – ${fmt(hi)}`;
    onFilterChange();
  });
}
function makeDual(elId, min, max, valLo, valHi, cb) {
  const el = document.getElementById(elId);
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
  const total = Object.keys(dsoById).length;
  const n = Object.keys(dsoById).filter(passes).length;
  document.getElementById('vnb-count').textContent = `${n} / ${total} VNB`;
}

// ---------- legend ----------
function renderLegend() {
  const el = document.getElementById('legend');
  const ids = Object.keys(dsoById).filter(passes);
  let grad, ticks, vals;
  if (state.mode === 'sm') {
    grad = 'linear-gradient(90deg, hsl(0,68%,46%), hsl(60,68%,46%), hsl(120,68%,46%))';
    ticks = ['0 %', '25 %', '50 %', '75 %', '100 %'];
    vals = ids.map(smValue).filter(v => v != null);
    const kA = ids.length - vals.length;
    el.innerHTML = legendBody(grad, ticks, vals.map(v => v * 100), '%', kA);
  } else {
    grad = 'linear-gradient(90deg, hsl(220,70%,38%), hsl(270,70%,45%), hsl(320,70%,52%))';
    ticks = ['1k', '10k', '100k', '1M', '4M+'];
    vals = ids.map(mcValue).filter(v => v != null);
    const kA = ids.length - vals.length;
    el.innerHTML = legendBody(grad, ticks, vals, '', kA, true);
  }
}
function legendBody(grad, ticks, vals, unit, kA, isCount) {
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  const min = vals.length ? Math.min(...vals) : null, max = vals.length ? Math.max(...vals) : null;
  const f = n => n == null ? '-' : isCount ? Math.round(n).toLocaleString('de-DE') : n.toFixed(1) + unit;
  return `<div class="bar" style="background:${grad}"></div>
    <div class="ticks">${ticks.map(t => `<span>${t}</span>`).join('')}</div>
    <div class="stats"><span>Mittel <b>${f(mean)}</b></span><span>Min <b>${f(min)}</b></span><span>Max <b>${f(max)}</b></span><span>k. A. <b>${kA}</b></span></div>`;
}

// ---------- ranking list ----------
function renderList() {
  const el = document.getElementById('vnb-list');
  const title = document.getElementById('list-title');
  const ids = Object.keys(dsoById).filter(passes);
  const valFn = state.mode === 'sm' ? smValue : mcValue;
  title.textContent = state.mode === 'sm' ? 'Ranking Smart-Meter-Quote' : 'Ranking Anzahl Zähler';
  ids.sort((a, b) => (valFn(b) ?? -1) - (valFn(a) ?? -1));
  el.innerHTML = ids.slice(0, 200).map((id, i) => {
    const d = dsoById[id], v = valFn(id);
    const label = v == null ? 'k. A.' : state.mode === 'sm' ? (v * 100).toFixed(1) + ' %' : v.toLocaleString('de-DE');
    const bg = state.mode === 'sm' ? smColor(smValue(id)) : mcColor(mcValue(id));
    const cov = state.matched.has(id);
    return `<div class="vnb-row" data-id="${id}">
      <span class="rank">${i + 1}</span>
      <span class="name">${esc(d.name)}</span>
      ${cov ? '<span class="fwtag" title="for.watt-Abdeckung">●</span>' : ''}
      <span class="badge" style="background:${bg}">${label}</span>
    </div>`;
  }).join('');
  el.querySelectorAll('.vnb-row').forEach(row => row.onclick = () => focusVnb(row.dataset.id));
}

function focusVnb(id) {
  state.selected = id; restyle();
  const d = dsoById[id];
  if (d && d.bbox) map.fitBounds([[d.bbox[1], d.bbox[0]], [d.bbox[3], d.bbox[2]]], { maxZoom: 10, padding: [40, 40] });
  const layer = layersByVnb[id];
  if (layer) layer.openTooltip();
}

// ---------- for.watt coverage (auto-refresh each load) ----------
async function loadForwatt() {
  const status = document.getElementById('forwatt-status');
  status.className = 'forwatt-status'; status.textContent = 'Abdeckung wird abgerufen…';
  try {
    // cache-bust so each page open gets the latest committed coverage
    const cov = await fetch('data/forwatt-coverage.json?t=' + Date.now()).then(r => r.json());
    if (cov.error && !cov.partners.length) throw new Error(cov.error);
    state.coverage = cov;
    state.matched = new Set(cov.matchedVnbIds);
    const nMatched = cov.matchedVnbIds.length, nTotal = cov.partners.length;
    status.className = 'forwatt-status ok';
    status.textContent = `${nMatched} von ${nTotal} Partnern auf VNB-Gebiete abgebildet` +
      (cov.stale ? ' (zwischengespeichert)' : '');
    renderForwattSummary();
    renderForwattList();
    renderList();
    restyle();
  } catch (e) {
    status.className = 'forwatt-status err';
    status.textContent = 'for.watt-Abdeckung nicht verfügbar: ' + e.message;
  }
}
// Germany-wide estimate: share of metering points / smart meters that sit in a
// for.watt-supported grid territory. Only territory-based (grundzuständige) MSBs
// can be located geographically, so this is a lower bound — noted in the UI.
function forwattStats() {
  let totalMeters = 0, coveredMeters = 0, totalSmart = 0, coveredSmart = 0;
  for (const id in meterCounts) {
    const mc = meterCounts[id];
    if (mc == null) continue;
    const smart = smartMeters(id) || 0;
    totalMeters += mc; totalSmart += smart;
    if (state.matched.has(id)) { coveredMeters += mc; coveredSmart += smart; }
  }
  return { totalMeters, coveredMeters, totalSmart, coveredSmart,
    meterPct: totalMeters ? coveredMeters / totalMeters : 0,
    smartPct: totalSmart ? coveredSmart / totalSmart : 0 };
}

function renderForwattSummary() {
  const s = forwattStats();
  document.getElementById('forwatt-summary').innerHTML = `
    <div class="fw-sum-head">Deutschlandweite for.watt-Abdeckung*</div>
    <div class="fw-sum-grid">
      <div><b>${pct(s.meterPct)}</b><span>der Zählpunkte<br>${fmtK(s.coveredMeters)} / ${fmtK(s.totalMeters)}</span></div>
      <div><b>${pct(s.smartPct)}</b><span>der Smart Meter<br>${fmtK(s.coveredSmart)} / ${fmtK(s.totalSmart)}</span></div>
    </div>
    <div class="fw-foot">* über grundzuständige Netzgebiete; überregionale Messstellenbetreiber sind nicht enthalten.</div>`;
}

function renderForwattList() {
  const el = document.getElementById('forwatt-list');
  const parts = state.coverage.partners;
  const matched = parts.filter(p => p.vnbId).sort((a, b) => (smartMeters(b.vnbId) ?? -1) - (smartMeters(a.vnbId) ?? -1));
  const other = parts.filter(p => !p.vnbId).sort((a, b) => a.name.localeCompare(b.name));
  const matchedItem = p => `
    <div class="fw-item matched" data-id="${p.vnbId}">
      <div class="fw-row1"><span class="dot"></span><span class="who">${esc(p.vnbName)}</span><span class="where">${esc(p.city || '')}</span></div>
      <div class="fw-metrics">
        <span title="Smart-Meter-Quote (mit opt. Einbaufällen)">${pct(smMit(p.vnbId))} Quote</span>
        <span title="Anzahl Smart Meter">${fmtK(smartMeters(p.vnbId))} Smart Meter</span>
        <span title="Zählpunkte gesamt">${fmtK(mcValue(p.vnbId))} Zähler</span>
      </div>
    </div>`;
  const otherItem = p => `
    <div class="fw-item unmatched">
      <div class="fw-row1"><span class="dot"></span><span class="who">${esc(p.name)}</span><span class="where">überregional / ESA</span></div>
    </div>`;
  el.innerHTML =
    `<div class="fw-group">Messstellenbetreiber auf der Karte · ${matched.length}</div>` +
    matched.map(matchedItem).join('') +
    `<div class="fw-group">Weitere for.watt-Partner · ${other.length}</div>` +
    other.map(otherItem).join('');
  el.querySelectorAll('.fw-item.matched').forEach(it => it.onclick = () => focusVnb(it.dataset.id));
}

init();
