// Refresh the VNB / smart-meter snapshot from vnb-monitoring.org.
// Run: npm run update-data   (then commit data/dso.json data/sm.json)
//
// vnb-monitoring serves the public Bundesnetzagentur figures obfuscated as
// base64( xor( gzip( json ) ) ) with short keys. We reverse that and expand the
// keys to the same plain JSON the app reads (data/dso.json, data/sm.json).
//
// data/geo.json is NOT touched here — its territory shapes used to come from
// vnb-monitoring too, but that geometry's own origin/licence was undocumented.
// It's now built independently from public sources (BKG VG250 + the
// Marktstammdatenregister); regenerate it with `npm run build-geo` instead.
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const XK = Buffer.from([118,110,98,50,48,50,53,100,115,111]); // "vnb2025dso"
const DM = {i:'id',n:'name',c:'city',t:'types',cl:'color',b:'bbox',f:'features'};
const SM = {p:'periods',l:'label',d:'date',dt:'data',o:'ohne',m:'mit',mc:'meter_counts',tt:'total',h:'hs',ms:'ms',ns:'ns'};

function expand(o, m) {
  if (Array.isArray(o)) return o.map(x => expand(x, m));
  if (o && typeof o === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(o)) out[m[k] || k] = (typeof v === 'string' && m[v] !== undefined) ? m[v] : expand(v, m);
    return out;
  }
  return (typeof o === 'string' && m[o] !== undefined) ? m[o] : o;
}
function decode(b64, map) {
  const b = Buffer.from(b64.trim(), 'base64');
  for (let i = 0; i < b.length; i++) b[i] ^= XK[i % XK.length];
  return expand(JSON.parse(zlib.gunzipSync(b).toString('utf8')), map);
}
const get = url => new Promise((resolve, reject) => {
  https.get(url, res => {
    if (res.statusCode !== 200) { reject(new Error(`${url} -> HTTP ${res.statusCode}`)); res.resume(); return; }
    let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
  }).on('error', reject);
});

(async () => {
  const dir = path.join(__dirname, '..', 'data');
  const base = 'https://vnb-monitoring.org/api';
  const [d, s] = await Promise.all([get(base + '/d'), get(base + '/s')]);
  const dso = decode(d, DM), sm = decode(s, SM);
  if (!dso.length || !sm.periods?.length) throw new Error('decoded data looks empty — aborting');
  fs.writeFileSync(path.join(dir, 'dso.json'), JSON.stringify(dso));
  fs.writeFileSync(path.join(dir, 'sm.json'), JSON.stringify(sm));
  const p = sm.periods[sm.periods.length - 1];
  console.log(`updated: ${dso.length} VNB · period ${p.label} (${p.date}). ` +
    `Note: data/geo.json is separate now — run "npm run build-geo" if VNB names/ids changed enough to need it re-matched.`);
})().catch(e => { console.error(e.message || e); process.exit(1); });
