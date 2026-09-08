// Tidy data/geo.json: drop sliver polygons, drop thin spikes, drop pin-hole
// enclaves, and simplify the postal-code stair-stepping.
// Run: npm run clean-geo   (also run automatically by update-data)
//
// The upstream vnb-monitoring geometry is rasterised from postal-code / municipality
// grids, so each large rural territory (Avacon, Westnetz, Netze BW …) arrives as a
// MultiPolygon of 100s–1000s of fragments with jagged, stair-stepped edges — noise
// that only became visible with the hover outline. We:
//   1. drop sub-polygons whose outer ring is smaller than MIN_KM2
//   2. drop long thin "tendril" sub-polygons (compact score high AND small)
//   3. drop pin-hole enclaves (inner rings smaller than MIN_KM2)
//   4. Douglas–Peucker simplify every surviving ring by SIMPLIFY_TOL degrees
// A territory that is nothing but slivers keeps its single largest sub-polygon so
// it never disappears from the map.
'use strict';
const fs = require('fs');
const path = require('path');

const MIN_KM2 = 0.3;        // sub-polygon / hole area floor
const SPIKE_COMPACT = 14;   // perimeter² / (4π·area): 1 = circle, big = thin snake
const SPIKE_MAX_KM2 = 15;   // only treat a shape as a spike if it is also this small
const SIMPLIFY_TOL = 0.0025; // ~200 m — collapses postal-code stair-steps

// shoelace area of a ring, in deg²
function ringDeg2(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return Math.abs(a / 2);
}
// deg² -> km² at the ring's latitude (good enough for Germany)
function ringKm2(r) {
  const latRad = (r[0] ? r[0][1] : 51) * Math.PI / 180;
  return ringDeg2(r) * 111.32 * (111.32 * Math.cos(latRad));
}
function ringPerimDeg(r) {
  let p = 0;
  for (let i = 1; i < r.length; i++)
    p += Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1]);
  return p;
}
// 1 for a circle, grows without bound for a long thin sliver
function compactness(r) {
  const a = ringDeg2(r);
  return a ? ringPerimDeg(r) ** 2 / (4 * Math.PI * a) : Infinity;
}
function isSpike(outer) {
  return compactness(outer) > SPIKE_COMPACT && ringKm2(outer) < SPIKE_MAX_KM2;
}

// perpendicular distance from p to segment a–b (planar, in degrees)
function segDist(p, a, b) {
  let x = a[0], y = a[1], dx = b[0] - x, dy = b[1] - y;
  if (dx || dy) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = b[0]; y = b[1]; }
    else if (t > 0) { x += dx * t; y += dy * t; }
  }
  return Math.hypot(p[0] - x, p[1] - y);
}
function simplifyRing(ring, tol) {
  if (ring.length <= 5) return ring;
  const line = ring.slice(0, -1);                 // drop the duplicated closing point
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(line[i], line[a], line[b]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx !== -1 && maxD > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  const out = [];
  for (let i = 0; i < line.length; i++) if (keep[i]) out.push(line[i]);
  out.push(out[0].slice());                        // re-close
  return out.length >= 4 ? out : ring;             // never degenerate
}

function cleanRings(poly) {
  // poly = [outer, ...holes]; drop pin-hole enclaves, then simplify what's left
  const outer = simplifyRing(poly[0], SIMPLIFY_TOL);
  const holes = poly.slice(1)
    .filter(h => ringKm2(h) >= MIN_KM2)
    .map(h => simplifyRing(h, SIMPLIFY_TOL));
  return [outer, ...holes];
}

function cleanFeature(f, stat) {
  const g = f.geometry;
  if (!g) return;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  stat.ringsIn += polys.length;
  polys.forEach(p => { stat.vertsIn += p.reduce((n, r) => n + r.length, 0); });

  let kept = polys.filter(p => ringKm2(p[0]) >= MIN_KM2 && !isSpike(p[0]));
  stat.slivers += polys.filter(p => ringKm2(p[0]) < MIN_KM2).length;
  stat.spikes += polys.filter(p => ringKm2(p[0]) >= MIN_KM2 && isSpike(p[0])).length;
  if (!kept.length) {
    let big = polys[0];
    for (const p of polys) if (ringKm2(p[0]) > ringKm2(big[0])) big = p;
    kept = [big];
  }
  kept = kept.map(cleanRings);
  stat.ringsOut += kept.length;
  kept.forEach(p => { stat.vertsOut += p.reduce((n, r) => n + r.length, 0); });

  f.geometry = kept.length === 1
    ? { type: 'Polygon', coordinates: kept[0] }
    : { type: 'MultiPolygon', coordinates: kept };
}

function clean(geo) {
  const stat = { ringsIn: 0, ringsOut: 0, vertsIn: 0, vertsOut: 0, slivers: 0, spikes: 0 };
  for (const f of geo.features) cleanFeature(f, stat);
  return stat;
}

module.exports = { clean, MIN_KM2 };

if (require.main === module) {
  const file = path.join(__dirname, '..', 'data', 'geo.json');
  const geo = JSON.parse(fs.readFileSync(file, 'utf8'));
  const s = clean(geo);
  fs.writeFileSync(file, JSON.stringify(geo));
  console.log(`clean-geo: ${geo.features.length} territories · rings ${s.ringsIn}→${s.ringsOut} `
    + `(−${s.slivers} slivers, −${s.spikes} spikes) · verts ${s.vertsIn}→${s.vertsOut}`);
}
