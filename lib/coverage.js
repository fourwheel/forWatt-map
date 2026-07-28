// Shared partner -> VNB matching. Used by scripts/update-coverage.cjs (CI/local).
'use strict';

const GENERIC = new Set(['stadtwerke','stadtwerk','stadt','werke','werk','strom','gas',
  'wasser','und','energie','energ','versorgung','netz','netze','netzgesellschaft',
  'verteilnetz','gmbh','co','kg','ag','mbh','se','eg','ku','kgaa','gruppe','group']);

function normTokens(s) {
  return String(s).toLowerCase()
    .replace(/ä/g,'a').replace(/ö/g,'o').replace(/ü/g,'u').replace(/ß/g,'ss')
    .replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/).filter(Boolean);
}
const coreTokens = toks => toks.filter(t => !GENERIC.has(t) && t.length >= 4);

function partnerNameFromSrc(src) {
  const f = src.split('/').pop().replace(/\.(png|jpe?g|svg)$/i, '');
  return f.replace(/[_-]?[Ll]ogo$/,'').replace(/[_-]+/g,' ').trim();
}

function buildIndex(dso) {
  return dso.map(d => ({ d, all: new Set([...normTokens(d.name), ...normTokens(d.city || '')]) }));
}

function matchVnb(partnerName, index) {
  const pc = coreTokens(normTokens(partnerName));
  if (!pc.length) return null;
  let best = null, bs = 0;
  for (const e of index) {
    const hits = pc.filter(t => e.all.has(t)).length;
    if (!hits) continue;
    const score = hits / pc.length;
    if (score > bs) { bs = score; best = e.d; }
  }
  return bs >= 0.5 ? { id: best.id, name: best.name, city: best.city, score: +bs.toFixed(2) } : null;
}

// srcs: array of logo src paths; dso: decoded operator list; sourceUrl: forwatt base.
function buildCoverage(srcs, dso, sourceUrl, nowIso) {
  const index = buildIndex(dso);
  const seen = new Set();
  const partners = [];
  for (const src of srcs) {
    if (!src || seen.has(src)) continue;
    seen.add(src);
    const name = partnerNameFromSrc(src);
    const vnb = matchVnb(name, index);
    partners.push({
      name, logo: sourceUrl + src, file: src.split('/').pop(),
      vnbId: vnb ? vnb.id : null, vnbName: vnb ? vnb.name : null, city: vnb ? vnb.city : null,
    });
  }
  const matchedVnbIds = [...new Set(partners.filter(p => p.vnbId).map(p => p.vnbId))];
  return { updated: nowIso || new Date().toISOString(), source: sourceUrl, partners, matchedVnbIds };
}

module.exports = { partnerNameFromSrc, buildIndex, matchVnb, buildCoverage };
