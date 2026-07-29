// Verify the Messstellenbetreiber list resolves to VNB territories correctly.
// Run: npm run check   (or: node scripts/check-coverage.cjs)
// Prints every mapping and fails if any match is not anchored on a shared
// distinctive NAME token — the guard against "Stadtwerke Erfurt -> TEN"-style errors.
'use strict';
const fs = require('fs');
const path = require('path');
const M = require('../lib/match.js');

const dso = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'dso.json'), 'utf8'));
const list = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'messstellenbetreiber.json'), 'utf8'));

const { partners, matchedVnbIds } = M.resolve(list.operators, dso, list.aliases);

console.log(`\n${list.operators.length} Messstellenbetreiber · ${matchedVnbIds.length} auf VNB-Gebiete abgebildet\n`);
let bad = 0;
for (const p of partners) {
  if (p.vnbId) {
    const shared = (p.shared || []);
    const ok = shared.length > 0;
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✗'} ${p.name}\n        -> ${p.vnbName} (${p.city})  [${shared.join(', ')}]`);
  } else {
    console.log(`  ·  ${p.name}   (überregional / kein einzelnes Netzgebiet)`);
  }
}

// --- assertions (self-check) ---
const problems = [];
for (const p of partners) {
  if (p.vnbId && !(p.shared && p.shared.length)) {
    problems.push(`match without shared distinctive token: ${p.name} -> ${p.vnbName}`);
  }
}
// anchors that must stay correct
const byName = n => partners.find(p => p.name === n);
const anchor = (opName, mustContain) => {
  const p = byName(opName);
  if (p && p.vnbName && !M.norm(p.vnbName).includes(mustContain)) {
    problems.push(`${opName} resolved to unexpected "${p.vnbName}" (expected name containing "${mustContain}")`);
  }
};
anchor('Stromnetz Berlin GmbH', 'stromnetz berlin');
anchor('Netze Magdeburg GmbH', 'magdeburg');
anchor('SWE Netz GmbH', 'swe');   // Erfurt operator is SWE Netz, must NOT become TEN

if (problems.length) {
  console.error('\nFAIL:\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log(`\nOK — ${matchedVnbIds.length} matches, all anchored on a distinctive name token.`);
