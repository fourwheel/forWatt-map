// Refresh the VNB / smart-meter snapshot from vnb-monitoring.org.
// Run: npm run update-data   (then commit data/*.json)
//
// vnb-monitoring serves the public Bundesnetzagentur figures obfuscated as
// base64( xor( gzip( json ) ) ) with short keys. We reverse that and expand the
// keys to the same plain JSON the app reads (data/geo.json, dso.json, sm.json).
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const XK = Buffer.from([118,110,98,50,48,50,53,100,115,111]); // "vnb2025dso"
const GM = {T:'type',F:'features',G:'geometry',C:'coordinates',P:'properties',FC:'FeatureCollection',FT:'Feature',PG:'Polygon',MP:'MultiPolygon',v:'vnb_id',n:'name',c:'city',cl:'color',t:'types'};
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
  const [g, d, s] = await Promise.all([get(base + '/g'), get(base + '/d'), get(base + '/s')]);
  const geo = decode(g, GM), dso = decode(d, DM), sm = decode(s, SM);
  if (!geo.features?.length || !dso.length || !sm.periods?.length) throw new Error('decoded data looks empty — aborting');
  fs.writeFileSync(path.join(dir, 'geo.json'), JSON.stringify(geo));
  fs.writeFileSync(path.join(dir, 'dso.json'), JSON.stringify(dso));
  fs.writeFileSync(path.join(dir, 'sm.json'), JSON.stringify(sm));
  const p = sm.periods[sm.periods.length - 1];
  console.log(`updated: ${dso.length} VNB · ${geo.features.length} territories · period ${p.label} (${p.date})`);
})().catch(e => { console.error(e.message || e); process.exit(1); });
