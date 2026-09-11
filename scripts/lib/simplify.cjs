'use strict';
// Douglas-Peucker line simplification, applied per-ring. VG250 is already
// generalised for 1:250 000 display; a Gemeinde choropleth rendered at
// country-wide zoom doesn't need every one of its vertices, so we thin rings
// out before shipping the GeoJSON to the browser.

function sqDistToSegment(p, a, b) {
  let [x, y] = p, [x1, y1] = a, [x2, y2] = b;
  const dx = x2 - x1, dy = y2 - y1;
  let t = dx || dy ? ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy) : -1;
  if (t < 0) { x1 = x1; y1 = y1; } else if (t > 1) { x1 = x2; y1 = y2; } else { x1 += t * dx; y1 += t * dy; }
  const ddx = x - x1, ddy = y - y1;
  return ddx * ddx + ddy * ddy;
}

function simplifyRing(points, tolSq) {
  if (points.length <= 4) return points; // keep tiny rings intact (incl. closing point)
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    let maxDist = 0, idx = -1;
    for (let i = start + 1; i < end; i++) {
      const d = sqDistToSegment(points[i], points[start], points[end]);
      if (d > maxDist) { maxDist = d; idx = i; }
    }
    if (maxDist > tolSq) {
      keep[idx] = 1;
      stack.push([start, idx], [idx, end]);
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

const round = (n, dp) => Math.round(n * 10 ** dp) / 10 ** dp;

// tolerance in degrees; roundDp: decimal places to round coordinates to afterwards
function simplifyGeometry(geom, tolerance, roundDp) {
  const tolSq = tolerance * tolerance;
  const simplifyPoly = poly => poly.map(ring => {
    const simplified = simplifyRing(ring, tolSq);
    return simplified.length >= 4 ? simplified : ring; // never collapse below a valid ring
  }).map(ring => ring.map(([x, y]) => [round(x, roundDp), round(y, roundDp)]));

  if (geom.type === 'Polygon') return { type: 'Polygon', coordinates: simplifyPoly(geom.coordinates) };
  if (geom.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: geom.coordinates.map(simplifyPoly) };
  return geom;
}

module.exports = { simplifyGeometry, simplifyRing };
