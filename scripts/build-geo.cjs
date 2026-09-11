'use strict';
// Build data/geo.json from public sources only:
//  - Marktstammdatenregister (MaStR) Gesamtdatenexport — public bulk export,
//    updated daily by the Bundesnetzagentur. We derive, per Gemeinde (municipality),
//    which Netzbetreiber (grid operator) it most likely belongs to, via the chain
//    Einheit (renewable generation unit, carries Gemeindeschluessel)
//      -> Lokation (LokationMaStRNummer)
//      -> Netzanschlusspunkt (NetzanschlusspunkteMaStRNummern)
//      -> Netzbetreiber (NetzbetreiberMaStRNummer, resolved to a name via Marktakteure)
//    This is a majority-vote proxy, not an exact franchise boundary: a Gemeinde
//    genuinely split between two grid operators is assigned to whichever has more
//    registered units there.
//  - BKG VG250 (amtliche Verwaltungsgebiete), fetched live from the BKG WFS —
//    Gemeinde polygons in WGS84, licensed "Datenlizenz Deutschland - Namensnennung 2.0".
//
// Run: node scripts/build-geo.cjs   (then commit data/geo.json)
// Downloads a couple GB from marktstammdatenregister.de over HTTP range requests
// (never the full multi-GB archive) and takes a while — expect several minutes.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { openRemoteZip } = require('./lib/mastr-zip.cjs');
const { simplifyGeometry } = require('./lib/simplify.cjs');
const { scanMastr, log, cachePath } = require('./lib/mastr-scan.cjs');

// VG250 is generalised for 1:250 000 already; this thins Gemeinde rings further
// for a country-wide choropleth (~0.0012deg ~= 80-130m at German latitudes).
const SIMPLIFY_TOLERANCE_DEG = 0.0012;
const COORD_DECIMALS = 4;

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return resolve(fetchText(res.headers.location));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${url} -> HTTP ${res.statusCode}`)); }
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c); res.on('end', () => resolve(d)); res.on('error', reject);
    }).on('error', reject);
  });
}

// ---------- VG250 Gemeinde boundaries (BKG WFS, public, dl-de/by-2-0) ----------
async function fetchGemeindenBoundaries() {
  const file = cachePath('vg250_gem.json');
  if (fs.existsSync(file)) { log('vg250: cache hit'); return JSON.parse(fs.readFileSync(file, 'utf8')); }
  const base = 'https://sgx.geodatenzentrum.de/wfs_vg250?SERVICE=WFS&REQUEST=GetFeature&VERSION=2.0.0' +
    '&TYPENAMES=vg250:vg250_gem&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326';
  const pageSize = 1000;
  let start = 0, all = [], total = Infinity;
  while (start < total) {
    const data = JSON.parse(await fetchText(`${base}&COUNT=${pageSize}&STARTINDEX=${start}`));
    total = data.numberMatched;
    all.push(...data.features);
    log(`vg250: ${all.length}/${total}`);
    if (!data.features.length) break;
    start += pageSize;
  }
  fs.writeFileSync(file, JSON.stringify(all));
  return all;
}

function simplifyBoundaries(gemeinden) {
  const file = cachePath(`vg250_gem_simplified_${SIMPLIFY_TOLERANCE_DEG}.json`);
  if (fs.existsSync(file)) { log('simplify: cache hit'); return JSON.parse(fs.readFileSync(file, 'utf8')); }
  const before = gemeinden.reduce((n, f) => n + JSON.stringify(f.geometry).length, 0);
  const out = gemeinden.map(f => ({ ...f, geometry: simplifyGeometry(f.geometry, SIMPLIFY_TOLERANCE_DEG, COORD_DECIMALS) }));
  const after = out.reduce((n, f) => n + JSON.stringify(f.geometry).length, 0);
  log(`simplify: geometry bytes ${before} -> ${after} (${Math.round(after / before * 100)}%)`);
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

async function getLatestExportUrl() {
  const html = await fetchText('https://www.marktstammdatenregister.de/MaStR/Datendownload');
  const m = html.match(/https:\/\/download\.marktstammdatenregister\.de\/Gesamtdatenexport_\d+_[\d.]+\.zip/);
  if (!m) throw new Error('Gesamtdatenexport URL not found on download page');
  return m[0];
}

function bboxOf(geometry) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = coords => {
    if (typeof coords[0] === 'number') {
      const [x, y] = coords;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    } else coords.forEach(walk);
  };
  walk(geometry.coordinates);
  return [minX, minY, maxX, maxY];
}

async function main() {
  const [gemeindenRaw, exportUrl] = await Promise.all([
    fetchGemeindenBoundaries(),
    getLatestExportUrl(),
  ]);
  const gemeinden = simplifyBoundaries(gemeindenRaw);
  log('using export', exportUrl);
  const zip = await openRemoteZip(exportUrl);
  log('zip opened,', zip.entries.size, 'entries,', Math.round(zip.size / 1e9 * 100) / 100, 'GB');

  const { votes, netzbetreiber } = await scanMastr(zip);

  const gemeindeToVnb = new Map(); // gemeindeschluessel -> vnb_id (string)
  for (const [gk, opCounts] of votes) {
    let bestId = null, bestCount = -1;
    for (const [opId, c] of opCounts) if (c > bestCount) { bestCount = c; bestId = opId; }
    if (netzbetreiber.has(bestId)) gemeindeToVnb.set(gk, String(bestId));
  }
  log(`gemeinden with a resolvable VNB: ${gemeindeToVnb.size} / ${votes.size}`);

  const bboxByVnb = new Map();
  const features = [];
  for (const f of gemeinden) {
    const ags = f.properties.ags;
    const vnbId = gemeindeToVnb.get(ags);
    if (!vnbId) continue; // no MaStR-derived data for this Gemeinde — leave it out rather than guess
    const op = netzbetreiber.get(Number(vnbId));
    features.push({
      type: 'Feature',
      properties: { vnb_id: vnbId, name: op.name, city: op.city, types: op.types, ags, gemeinde: f.properties.gen },
      geometry: f.geometry,
    });
    const [minX, minY, maxX, maxY] = bboxOf(f.geometry);
    const b = bboxByVnb.get(vnbId);
    bboxByVnb.set(vnbId, b
      ? [Math.min(b[0], minX), Math.min(b[1], minY), Math.max(b[2], maxX), Math.max(b[3], maxY)]
      : [minX, minY, maxX, maxY]);
  }
  const geo = { type: 'FeatureCollection', features };
  const dataDir = path.join(__dirname, '..', 'data');
  fs.writeFileSync(path.join(dataDir, 'geo.json'), JSON.stringify(geo));
  log(`wrote data/geo.json: ${features.length} Gemeinde-Kacheln across ${new Set(features.map(f => f.properties.vnb_id)).size} VNB`);

  // patch bbox into dso.json, if it exists (run scripts/build-dso.cjs first)
  const dsoPath = path.join(dataDir, 'dso.json');
  if (fs.existsSync(dsoPath)) {
    const dso = JSON.parse(fs.readFileSync(dsoPath, 'utf8'));
    let patched = 0;
    for (const d of dso) { const b = bboxByVnb.get(d.id); if (b) { d.bbox = b; patched++; } }
    fs.writeFileSync(dsoPath, JSON.stringify(dso));
    log(`patched bbox into data/dso.json for ${patched} / ${dso.length} Netzbetreiber`);
  } else {
    log('data/dso.json not found — skipping bbox patch (run scripts/build-dso.cjs first)');
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
