'use strict';
// List grundzuständige Messstellenbetreiber that are NOT yet a for.Watt partner.
//
// Uses only data already committed to this repo - no network access:
//  - data/sm.json: every VNB with a published BNetzA rollout quota IS, by
//    definition, a grundzuständiger MSB (see scripts/build-dso.cjs - rows
//    without a quota, e.g. wMSB/ÜNB, are dropped when sm.json is built).
//  - data/dso.json: name/city/bbox for each of those VNB ids.
//  - data/messstellenbetreiber.json: the for.Watt partner list (the subset
//    already onboarded) - resolved the same way app.js does, via lib/match.js.
//
// Output: a CSV with an empty "LinkedIn-Kontakt" column to fill in by hand -
// see the conversation this was built from for why that step stays manual.
//
// Run: node scripts/list-prospects.cjs [output.csv]   (default: prospects.csv)

const fs = require('fs');
const path = require('path');
const MsbMatch = require('../lib/match.js');

const dataDir = path.join(__dirname, '..', 'data');
const dso = JSON.parse(fs.readFileSync(path.join(dataDir, 'dso.json'), 'utf8'));
const sm = JSON.parse(fs.readFileSync(path.join(dataDir, 'sm.json'), 'utf8'));
const msb = JSON.parse(fs.readFileSync(path.join(dataDir, 'messstellenbetreiber.json'), 'utf8'));

const dsoById = new Map(dso.map(d => [d.id, d]));
const period = sm.periods[sm.periods.length - 1];

const cov = MsbMatch.resolve(msb.operators, dso, msb.aliases);
const partnerIds = new Set(cov.matchedVnbIds);

const csvField = v => {
  const s = v == null ? '' : String(v);
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const rows = Object.entries(period.data)
  .filter(([id]) => !partnerIds.has(id))
  .map(([id, q]) => {
    const d = dsoById.get(id);
    return {
      name: d ? d.name : '(unbekannt)',
      city: d ? d.city || '' : '',
      quoteMit: q.mit == null ? '' : (q.mit * 100).toFixed(1),
      quoteOhne: q.ohne == null ? '' : (q.ohne * 100).toFixed(1),
      hasBbox: d && d.bbox ? 'ja' : 'nein',
      id,
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name, 'de'));

const header = ['Unternehmen', 'Sitz', 'Quote mit Einbaufällen (%)', 'Quote ohne Einbaufälle (%)',
  'Auf Karte darstellbar', 'VNB-ID', 'LinkedIn-Kontakt'];
const lines = [header, ...rows.map(r =>
  [r.name, r.city, r.quoteMit, r.quoteOhne, r.hasBbox, r.id, ''])]
  .map(cols => cols.map(csvField).join(';'));

const outPath = path.resolve(process.argv[2] || 'prospects.csv');
fs.writeFileSync(outPath, '﻿' + lines.join('\r\n') + '\r\n', 'utf8'); // BOM: opens correctly in Excel

console.log(`${rows.length} von ${Object.keys(period.data).length} grundzuständigen MSB sind noch kein for.Watt-Partner (Periode ${period.label}).`);
console.log(`Geschrieben nach: ${outPath}`);
