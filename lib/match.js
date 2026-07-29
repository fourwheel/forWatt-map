// Resolve Messstellenbetreiber names to VNB territories — by NAME ONLY.
// City is never used for matching (that is what caused "Stadtwerke Erfurt -> TEN").
// UMD: usable from the browser (window.MsbMatch) and from Node (require).
(function (root) {
  'use strict';

  // legal forms + connectors — removed before comparing
  const STOP = new Set(['gmbh','ag','mbh','kg','kgaa','co','se','eg','ku','aoer','ohg',
    'und','an','der','am','fur','für','the','de']);
  // words that are common across many operators and therefore not place-distinctive
  const GENERIC = new Set(['stadtwerke','stadtwerk','stadt','stadtische','staedtische','werke','werk',
    'netz','netze','netzgesellschaft','verteilnetz','energie','energienetze','energienetz',
    'energieversorgung','elektroenergieversorgung','versorgung','stromversorgung','strom','gas',
    'gasnetz','wasser','licht','kraft','kraftwerke','betriebswerke','dienstleistungsgesellschaft',
    'dienstleistungs','gesellschaft','messdienstleistungen','transmission','smart','metering','net',
    'quartier','energy','germany']);

  const norm = s => String(s).toLowerCase()
    .replace(/ä/g,'a').replace(/ö/g,'o').replace(/ü/g,'u').replace(/ß/g,'ss')
    .replace(/[^a-z0-9]+/g,' ').trim();
  const sig = s => norm(s).split(' ').filter(t => t && !STOP.has(t));                 // significant tokens
  const key = s => sig(s).slice().sort().join(' ');                                    // order-independent identity
  const distinctive = s => sig(s).filter(t => !GENERIC.has(t) && t.length >= 3);       // place/brand tokens

  function buildIndex(dso) {
    return dso.map(d => {
      const S = sig(d.name);
      return { d, sigSet: new Set(S), key: S.slice().sort().join(' '), dist: new Set(distinctive(d.name)) };
    });
  }

  function jaccard(aSet, bSet) {
    let inter = 0;
    aSet.forEach(t => { if (bSet.has(t)) inter++; });
    const uni = aSet.size + bSet.size - inter;
    return uni ? inter / uni : 0;
  }

  // Returns { d, shared } or null. shared = distinctive name tokens both sides agree on.
  function matchOne(name, index, aliasTarget) {
    if (aliasTarget) {
      const ak = key(aliasTarget);
      const hit = index.find(e => e.key === ak);
      return hit ? { d: hit.d, shared: [...hit.dist] } : null;
    }
    const k = key(name);
    const exact = index.find(e => e.key === k);
    const nDist = new Set(distinctive(name));
    if (exact) {
      const shared = [...nDist].filter(t => exact.dist.has(t));
      // an exact signature match with no shared distinctive token = a purely generic
      // collision (e.g. two bare "Netz GmbH"): reject rather than misattribute.
      return nDist.size === 0 || shared.length ? { d: exact.d, shared } : null;
    }
    if (!nDist.size) return null;                         // nothing distinctive to anchor on
    const nSig = new Set(sig(name));
    let best = null, bestScore = 0;
    for (const e of index) {
      const shared = [...nDist].filter(t => e.dist.has(t));
      if (!shared.length) continue;                       // must share a distinctive NAME token
      const score = jaccard(nSig, e.sigSet) + shared.length * 0.01; // tie-break toward more shared tokens
      if (score > bestScore) { bestScore = score; best = { d: e.d, shared }; }
    }
    return best && bestScore >= 0.34 ? best : null;
  }

  // operators: string[]; dso: [{id,name,city,...}]; aliases: {name: exactVnbName}
  function resolve(operators, dso, aliases) {
    aliases = aliases || {};
    const index = buildIndex(dso);
    const partners = operators.map(name => {
      const m = matchOne(name, index, aliases[name]);
      return m
        ? { name, vnbId: m.d.id, vnbName: m.d.name, city: m.d.city, shared: m.shared }
        : { name, vnbId: null, vnbName: null, city: null };
    });
    const matchedVnbIds = [...new Set(partners.filter(p => p.vnbId).map(p => p.vnbId))];
    return { partners, matchedVnbIds };
  }

  const api = { resolve, matchOne, buildIndex, sig, distinctive, norm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MsbMatch = api;
})(typeof window !== 'undefined' ? window : globalThis);
