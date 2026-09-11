'use strict';
// Shared MaStR scan: for every Gemeinde, which Netzbetreiber has the most
// registered connection points there (Einheit -> Lokation -> Netzanschlusspunkt
// -> Netzbetreiber), plus enough Marktakteur/Netzanschlusspunkt data to describe
// each Netzbetreiber that shows up (name, city, voltage levels it appears on).
// Used by both build-dso.cjs and build-geo.cjs so the MaStR pass only runs once
// per cache generation.
const fs = require('fs');
const path = require('path');
const os = require('os');

const CACHE_DIR = path.join(os.tmpdir(), 'forwatt-mastr-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });
const cachePath = name => path.join(CACHE_DIR, name);
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const mem = () => `${Math.round(process.memoryUsage().rss / 1e6)}MB`;

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
function idNum(s) {
  if (!s) return null;
  const m = /(\d+)\s*$/.exec(s);
  return m ? Number(m[1]) : null;
}
function decodeEntities(s) {
  return s == null ? s : s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

const EINHEIT_TABLES = [
  { tag: 'EinheitSolar', match: /^EinheitenSolar_\d+\.xml$/ },
  { tag: 'EinheitWind', match: /^EinheitenWind\.xml$/ },
  { tag: 'EinheitBiomasse', match: /^EinheitenBiomasse\.xml$/ },
  { tag: 'EinheitWasser', match: /^EinheitenWasser\.xml$/ },
];
const CACHE_VERSION = 2; // bump to invalidate stale caches when the extraction logic changes

async function scanMastr(zip) {
  const votesFile = cachePath(`gemeinde_votes_v${CACHE_VERSION}.json`);
  const opsFile = cachePath(`netzbetreiber_ops_v${CACHE_VERSION}.json`);
  if (fs.existsSync(votesFile) && fs.existsSync(opsFile)) {
    log('mastr scan: cache hit');
    return {
      votes: new Map(Object.entries(JSON.parse(fs.readFileSync(votesFile, 'utf8')))
        .map(([g, m]) => [g, new Map(Object.entries(m).map(([k, v]) => [Number(k), v]))])),
      netzbetreiber: new Map(Object.entries(JSON.parse(fs.readFileSync(opsFile, 'utf8')))
        .map(([k, v]) => [Number(k), v])),
    };
  }

  // --- pass 1: Einheiten -> lokationId -> gemeindeschluessel ---
  const lokationToGemeinde = new Map();
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
      log(`einheiten: ${shard} (+${n}, lokationen ${lokationToGemeinde.size}) ${mem()}`);
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
    log(`lokationen: ${shard} (+${n}, naps ${napToGemeinde.size}) ${mem()}`);
  }
  lokationToGemeinde.clear();

  // --- pass 3: Netzanschlusspunkte -> votes + per-Netzbetreiber Spannungsebene set ---
  const votes = new Map();           // gemeindeschluessel -> Map(netzbetreiberId -> count)
  const spannungsebenen = new Map(); // netzbetreiberId -> Set(katalogwertId)
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
      const se = field(rec, 'Spannungsebene');
      if (se) { let s = spannungsebenen.get(nb); if (!s) spannungsebenen.set(nb, s = new Set()); s.add(se); }
      n++;
    }
    log(`netzanschlusspunkte: ${shard} (+${n}, gemeinden with votes ${votes.size}) ${mem()}`);
  }
  napToGemeinde.clear();

  // --- pass 4: Katalogwerte -> decode Spannungsebene codes to labels ---
  const katalog = new Map();
  const katXml = await zip.readEntry('Katalogwerte.xml');
  for (const rec of iterRecords(katXml, 'Katalogwert')) {
    const id = field(rec, 'Id'), wert = field(rec, 'Wert');
    if (id != null && wert != null) katalog.set(id, decodeEntities(wert).split(' (')[0]);
  }

  // --- pass 5: Marktakteure -> netzbetreiberId -> { name, city } (only wanted ids) ---
  const netzbetreiber = new Map();
  const maShards = [...zip.entries.keys()].filter(n => /^Marktakteure_\d+\.xml$/.test(n)).sort();
  let remaining = new Set(netzbetreiberIds);
  for (const shard of maShards) {
    if (!remaining.size) break;
    const xml = await zip.readEntry(shard);
    let n = 0;
    for (const rec of iterRecords(xml, 'Marktakteur')) {
      const id = idNum(field(rec, 'MastrNummer'));
      if (id == null || !remaining.has(id)) continue;
      netzbetreiber.set(id, {
        name: decodeEntities(field(rec, 'Firmenname')),
        city: decodeEntities(field(rec, 'Ort')),
        types: [...(spannungsebenen.get(id) || [])].map(code => katalog.get(code)).filter(Boolean),
      });
      remaining.delete(id);
      n++;
    }
    log(`marktakteure: ${shard} (+${n}, still missing ${remaining.size}) ${mem()}`);
  }

  fs.writeFileSync(votesFile, JSON.stringify(Object.fromEntries(
    [...votes].map(([g, m]) => [g, Object.fromEntries(m)]))));
  fs.writeFileSync(opsFile, JSON.stringify(Object.fromEntries(netzbetreiber)));
  return { votes, netzbetreiber };
}

module.exports = { scanMastr, iterRecords, field, idNum, decodeEntities, log, mem, cachePath, CACHE_DIR };
