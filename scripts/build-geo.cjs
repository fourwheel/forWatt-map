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
const os = require('os');
const https = require('https');
const { openRemoteZip } = require('./lib/mastr-zip.cjs');
const { simplifyGeometry } = require('./lib/simplify.cjs');
const MsbMatch = require('../lib/match.js');

// VG250 is generalised for 1:250 000 already; this thins Gemeinde rings further
// for a country-wide choropleth (~0.0012deg ~= 80-130m at German latitudes).
const SIMPLIFY_TOLERANCE_DEG = 0.0012;
const COORD_DECIMALS = 4;

const CACHE_DIR = path.join(os.tmpdir(), 'forwatt-mastr-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });
const cachePath = name => path.join(CACHE_DIR, name);

const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const mem = () => `${Math.round(process.memoryUsage().rss / 1e6)}MB`;

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

// ---------- generic flat-XML record scanning ----------
function* iterRecords(xml, tag) {
  const open = `<${tag}>`, close = `</${tag}>`;
  let i = 0;
  while (true) {
    const start = xml.indexOf(open, i);
    if (start === -1) break;
    const end = xml.indexOf(close, start + open.length);
    if (end === -1) break;
    yield xml.slice(start + open.length, end);
    i = end + close.length;
  }
}
function field(rec, name) {
  const open = `<${name}>`;
  const i = rec.indexOf(open);
  if (i === -1) return null;
  const j = rec.indexOf('<', i + open.length);
  return rec.slice(i + open.length, j);
}
// MaStR-Nummern are TYPE + digits (e.g. "SAN921662892546"); within one table the
// type is constant, so the digit part alone is a safe, cheap numeric map key.
function idNum(s) {
  if (!s) return null;
  const m = /(\d+)\s*$/.exec(s);
  return m ? Number(m[1]) : null;
}

// ---------- 1. VG250 Gemeinde boundaries (BKG WFS, public, dl-de/by-2-0) ----------
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

// ---------- 2. MaStR: Gemeinde -> Netzbetreiber votes ----------
async function getLatestExportUrl() {
  const html = await fetchText('https://www.marktstammdatenregister.de/MaStR/Datendownload');
  const m = html.match(/https:\/\/download\.marktstammdatenregister\.de\/Gesamtdatenexport_\d+_[\d.]+\.zip/);
  if (!m) throw new Error('Gesamtdatenexport URL not found on download page');
  return m[0];
}

const EINHEIT_TABLES = [
  { tag: 'EinheitSolar', match: /^EinheitenSolar_\d+\.xml$/ },
  { tag: 'EinheitWind', match: /^EinheitenWind\.xml$/ },
  { tag: 'EinheitBiomasse', match: /^EinheitenBiomasse\.xml$/ },
  { tag: 'EinheitWasser', match: /^EinheitenWasser\.xml$/ },
];

async function buildGemeindeVotes(zip) {
  const votesFile = cachePath('gemeinde_votes.json');
  const namesFile = cachePath('netzbetreiber_names.json');
  if (fs.existsSync(votesFile) && fs.existsSync(namesFile)) {
    log('mastr votes: cache hit');
    return {
      votes: new Map(Object.entries(JSON.parse(fs.readFileSync(votesFile, 'utf8')))
        .map(([g, m]) => [g, new Map(Object.entries(m).map(([k, v]) => [Number(k), v]))])),
      names: JSON.parse(fs.readFileSync(namesFile, 'utf8')),
    };
  }

  // --- pass 1: Einheiten -> lokationId -> gemeindeschluessel ---
  const lokationToGemeinde = new Map();
  let unitCount = 0;
  // MASTR_SOLAR_LIMIT caps how many EinheitenSolar_*.xml shards are read — for a
  // quick smoke test of the whole pipeline before committing to the full ~1GB pull.
  const solarLimit = process.env.MASTR_SOLAR_LIMIT ? Number(process.env.MASTR_SOLAR_LIMIT) : Infinity;
  for (const { tag, match } of EINHEIT_TABLES) {
    let shards = [...zip.entries.keys()].filter(n => match.test(n)).sort();
    if (tag === 'EinheitSolar') shards = shards.slice(0, solarLimit);
    for (const shard of shards) {
      const xml = await zip.readEntry(shard);
      let n = 0;
      for (const rec of iterRecords(xml, tag)) {
        const lok = idNum(field(rec, 'LokationMaStRNummer'));
        const gk = field(rec, 'Gemeindeschluessel');
        if (lok != null && gk) { lokationToGemeinde.set(lok, gk); n++; }
      }
      unitCount += n;
      log(`einheiten: ${shard} (+${n}, total ${unitCount}, lokationen ${lokationToGemeinde.size}) ${mem()}`);
    }
  }

  // --- pass 2: Lokationen -> napId -> gemeindeschluessel (filtered, freeing as we go) ---
  const napToGemeinde = new Map();
  const lokShards = [...zip.entries.keys()].filter(n => /^Lokationen_\d+\.xml$/.test(n)).sort();
  for (const shard of lokShards) {
    const xml = await zip.readEntry(shard);
    let n = 0;
    for (const rec of iterRecords(xml, 'Lokation')) {
      const id = idNum(field(rec, 'MastrNummer'));
      if (id == null || !lokationToGemeinde.has(id)) continue;
      const gk = lokationToGemeinde.get(id);
      lokationToGemeinde.delete(id);
      const napField = field(rec, 'NetzanschlusspunkteMaStRNummern');
      const nap = idNum(napField && napField.split(',')[0]);
      if (nap != null) { napToGemeinde.set(nap, gk); n++; }
    }
    log(`lokationen: ${shard} (+${n}, naps ${napToGemeinde.size}, remaining lokationen ${lokationToGemeinde.size}) ${mem()}`);
  }
  lokationToGemeinde.clear();

  // --- pass 3: Netzanschlusspunkte -> tally votes per gemeinde+netzbetreiber ---
  const votes = new Map(); // gemeindeschluessel -> Map(netzbetreiberId -> count)
  const netzbetreiberIds = new Set();
  const napShards = [...zip.entries.keys()].filter(n => /^Netzanschlusspunkte_\d+\.xml$/.test(n)).sort();
  for (const shard of napShards) {
    const xml = await zip.readEntry(shard);
    let n = 0;
    for (const rec of iterRecords(xml, 'Netzanschlusspunkt')) {
      const id = idNum(field(rec, 'NetzanschlusspunktMastrNummer'));
      if (id == null || !napToGemeinde.has(id)) continue;
      const gk = napToGemeinde.get(id);
      napToGemeinde.delete(id);
      const nb = idNum(field(rec, 'NetzbetreiberMaStRNummer'));
      if (nb == null) continue;
      netzbetreiberIds.add(nb);
      let m = votes.get(gk); if (!m) votes.set(gk, m = new Map());
      m.set(nb, (m.get(nb) || 0) + 1);
      n++;
    }
    log(`netzanschlusspunkte: ${shard} (+${n}, gemeinden with votes ${votes.size}) ${mem()}`);
  }
  napToGemeinde.clear();

  // --- pass 4: Marktakteure -> netzbetreiberId -> Firmenname (only wanted ids) ---
  const names = {};
  const maShards = [...zip.entries.keys()].filter(n => /^Marktakteure_\d+\.xml$/.test(n)).sort();
  let remaining = new Set(netzbetreiberIds);
  for (const shard of maShards) {
    if (!remaining.size) break;
    const xml = await zip.readEntry(shard);
    let n = 0;
    for (const rec of iterRecords(xml, 'Marktakteur')) {
      const id = idNum(field(rec, 'MastrNummer'));
      if (id == null || !remaining.has(id)) continue;
      names[id] = field(rec, 'Firmenname');
      remaining.delete(id);
      n++;
    }
    log(`marktakteure: ${shard} (+${n}, still missing ${remaining.size}) ${mem()}`);
  }

  fs.writeFileSync(votesFile, JSON.stringify(Object.fromEntries(
    [...votes].map(([g, m]) => [g, Object.fromEntries(m)]))));
  fs.writeFileSync(namesFile, JSON.stringify(names));
  return { votes, names };
}

// ---------- 3. merge: majority operator per Gemeinde, matched to dso.json ----------
function main() {
  return (async () => {
    const dsoPath = path.join(__dirname, '..', 'data', 'dso.json');
    const dso = JSON.parse(fs.readFileSync(dsoPath, 'utf8'));

    const [gemeindenRaw, exportUrl] = await Promise.all([
      fetchGemeindenBoundaries(),
      getLatestExportUrl(),
    ]);
    const gemeinden = simplifyBoundaries(gemeindenRaw);
    log('using export', exportUrl);
    const zip = await openRemoteZip(exportUrl);
    log('zip opened,', zip.entries.size, 'entries,', Math.round(zip.size / 1e9 * 100) / 100, 'GB');

    const { votes, names } = await buildGemeindeVotes(zip);

    // match every distinct MaStR Netzbetreiber name to a dso.json VNB, once
    const distinctNames = [...new Set(Object.values(names))];
    const resolved = MsbMatch.resolve(distinctNames, dso);
    const nameToVnbId = new Map(resolved.partners.filter(p => p.vnbId).map(p => [p.name, p.vnbId]));

    let matched = 0, unmatched = 0;
    const gemeindeToVnb = new Map(); // gemeindeschluessel -> vnb_id
    for (const [gk, opCounts] of votes) {
      let bestId = null, bestCount = -1;
      for (const [opId, c] of opCounts) if (c > bestCount) { bestCount = c; bestId = opId; }
      const name = names[bestId];
      const vnbId = name && nameToVnbId.get(name);
      if (vnbId) { gemeindeToVnb.set(gk, vnbId); matched++; } else unmatched++;
    }
    log(`gemeinden matched to a VNB: ${matched}, unmatched (dropped): ${unmatched}`);

    const dsoById = new Map(dso.map(d => [d.id, d]));
    const features = [];
    for (const f of gemeinden) {
      const ags = f.properties.ags;
      const vnbId = gemeindeToVnb.get(ags);
      if (!vnbId) continue; // no MaStR-derived data for this Gemeinde — leave it out rather than guess
      const d = dsoById.get(vnbId);
      features.push({
        type: 'Feature',
        properties: {
          vnb_id: vnbId, name: d.name, city: d.city, color: d.color, types: d.types,
          ags, gemeinde: f.properties.gen,
        },
        geometry: f.geometry,
      });
    }
    const geo = { type: 'FeatureCollection', features };
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'geo.json'), JSON.stringify(geo));
    log(`wrote data/geo.json: ${features.length} Gemeinde-Kacheln across ${new Set(features.map(f => f.properties.vnb_id)).size} VNB`);
  })();
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
