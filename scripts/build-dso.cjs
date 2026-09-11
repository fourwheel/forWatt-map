'use strict';
// Build data/dso.json and data/sm.json from public sources only:
//  - Marktstammdatenregister (MaStR): which Netzbetreiber exist, their name/city
//    and the voltage levels they appear on (see scripts/lib/mastr-scan.cjs).
//  - Bundesnetzagentur's own published Smart-Meter-Rollout quota table
//    (an .xlsx on bundesnetzagentur.de, updated quarterly) — the "gMSB Quote"
//    for every grid operator, both with and without optional install cases.
//    Note: BNetzA does not publish absolute metering-point counts per operator
//    anywhere public, so — unlike the old vnb-monitoring snapshot — this data
//    has no "Anzahl Zähler" figure; the app's Smart-Meter-Quote view is unaffected.
//
// Run: node scripts/build-dso.cjs   (then commit data/dso.json data/sm.json)
// Run this BEFORE build-geo.cjs — it patches each dso.json entry's bbox in
// afterwards, once the Gemeinde tiles exist to compute it from.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { openRemoteZip } = require('./lib/mastr-zip.cjs');
const { scanMastr, log } = require('./lib/mastr-scan.cjs');
const { readXlsxSheet } = require('./lib/xlsx-mini.cjs');
const MsbMatch = require('../lib/match.js');

const ROLLOUT_XLSX_URL = 'https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/' +
  'NetzzugangMesswesen/Mess-undZaehlwesen/iMSys/_DL/Roll-out-Quoten_Q4_2025.xlsx?__blob=publicationFile&v=3';

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return resolve(fetchBuffer(res.headers.location));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${url} -> HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function getLatestExportUrl() {
  const html = await new Promise((resolve, reject) => {
    https.get('https://www.marktstammdatenregister.de/MaStR/Datendownload', res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c); res.on('end', () => resolve(d)); res.on('error', reject);
    }).on('error', reject);
  });
  const m = html.match(/https:\/\/download\.marktstammdatenregister\.de\/Gesamtdatenexport_\d+_[\d.]+\.zip/);
  if (!m) throw new Error('Gesamtdatenexport URL not found on download page');
  return m[0];
}

// deterministic, reasonably distinct colour per id — purely cosmetic (app.js
// computes its own choropleth fill from the quota; this is unused today but
// kept for a legend/ranking swatch, same as the old dso.json had)
function colorFor(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360}, 60%, 55%)`;
}

// "Roll-out-Quoten iMSys Q4 2025" -> "Q4 2025"; "Stand 31. Dezember 2025" -> "2025-12-31"
const MONTHS = { Januar: 1, Februar: 2, März: 3, April: 4, Mai: 5, Juni: 6, Juli: 7, August: 8,
  September: 9, Oktober: 10, November: 11, Dezember: 12 };
function parseTitle(title) {
  const label = (/(Q[1-4]\s*\d{4})/.exec(title) || [, title.trim()])[1];
  return label.replace(/\s+/g, ' ').trim();
}
function parseDate(stand) {
  const m = /(\d{1,2})\.\s*([A-Za-zäöüÄÖÜ]+)\s*(\d{4})/.exec(stand || '');
  if (!m) return null;
  const mo = MONTHS[m[2]];
  return mo ? `${m[3]}-${String(mo).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

async function main() {
  log('fetching BNetzA rollout quota table...');
  const xlsxBuf = await fetchBuffer(ROLLOUT_XLSX_URL);
  const { rows } = readXlsxSheet(xlsxBuf);
  const title = rows[0][0], stand = rows[0][5];
  const label = parseTitle(title), date = parseDate(stand);
  log(`period: ${label} (${date}) — "${title.trim()}" / "${stand}"`);

  const quotaRows = rows.slice(2).filter(r => r && r[0]).map(r => ({
    name: r[0],
    ohne: typeof r[2] === 'number' ? r[2] : null,
    mit: typeof r[4] === 'number' ? r[4] : null,
  }));
  log(`quota rows: ${quotaRows.length}`);

  const exportUrl = await getLatestExportUrl();
  log('using MaStR export', exportUrl);
  const zip = await openRemoteZip(exportUrl);
  const { netzbetreiber } = await scanMastr(zip);
  log(`Netzbetreiber found in MaStR (won at least one vote somewhere): ${netzbetreiber.size}`);

  const dso = [...netzbetreiber].map(([id, op]) => ({
    id: String(id),
    name: op.name,
    city: op.city,
    types: op.types,
    color: colorFor(id),
    bbox: null, // patched in by build-geo.cjs once the Gemeinde tiles exist
  })).sort((a, b) => a.name.localeCompare(b.name, 'de'));

  const resolved = MsbMatch.resolve(quotaRows.map(r => r.name), dso);
  const quotaByName = new Map(quotaRows.map(r => [r.name, r]));
  const data = {};
  let matched = 0;
  for (const p of resolved.partners) {
    if (!p.vnbId) continue;
    const q = quotaByName.get(p.name);
    if (q.mit == null && q.ohne == null) continue; // "n/a" rows (e.g. ÜNB) carry no quota
    data[p.vnbId] = { mit: q.mit, ohne: q.ohne };
    matched++;
  }
  log(`quota matched to a MaStR Netzbetreiber: ${matched} / ${quotaRows.length}`);

  const dataDir = path.join(__dirname, '..', 'data');
  fs.writeFileSync(path.join(dataDir, 'dso.json'), JSON.stringify(dso));
  fs.writeFileSync(path.join(dataDir, 'sm.json'), JSON.stringify({ periods: [{ label, date, data }] }));
  log(`wrote data/dso.json (${dso.length} Netzbetreiber) and data/sm.json (period ${label})`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { colorFor, parseTitle, parseDate };
