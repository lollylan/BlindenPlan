// 2D-Geometrie: Vektoren, Polygone, Offsets, Triangulation.

export const EPS = 1e-9;

export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const mul = (a, s) => ({ x: a.x * s, y: a.y * s });
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const cross = (a, b) => a.x * b.y - a.y * b.x;
export const len = (a) => Math.hypot(a.x, a.y);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const norm = (a) => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };
export const left = (a) => ({ x: -a.y, y: a.x }); // 90° gegen den Uhrzeigersinn (math. Koordinaten, y nach oben)
export const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export function signedArea(pts) {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export function area(pts) { return Math.abs(signedArea(pts)); }

export function centroid(pts) {
  const A = signedArea(pts);
  if (Math.abs(A) < EPS) {
    const b = bbox(pts);
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  }
  let cx = 0, cy = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const f = a.x * b.y - b.x * a.y;
    cx += (a.x + b.x) * f;
    cy += (a.y + b.y) * f;
  }
  return { x: cx / (6 * A), y: cy / (6 * A) };
}

export function bbox(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function pointInPolygon(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if (((a.y > p.y) !== (b.y > p.y)) && (p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x)) inside = !inside;
  }
  return inside;
}

/** Nächster Punkt auf der Strecke a–b. */
export function closestOnSegment(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  let t = l2 > EPS ? dot(sub(p, a), ab) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const point = add(a, mul(ab, t));
  return { point, t, dist: dist(p, point) };
}

/** Ein gut lesbarer Punkt im Polygon für die Beschriftung: Schwerpunkt, sonst Mitte des längsten Innenabschnitts. */
export function labelPoint(pts) {
  const c = centroid(pts);
  if (pointInPolygon(c, pts)) return c;
  const b = bbox(pts);
  let best = null;
  for (let k = 1; k < 10; k++) {
    const y = b.minY + (b.height * k) / 10;
    const xs = [];
    for (let i = 0, n = pts.length; i < n; i++) {
      const a = pts[i], d = pts[(i + 1) % n];
      if ((a.y > y) !== (d.y > y)) xs.push(a.x + (y - a.y) * (d.x - a.x) / (d.y - a.y));
    }
    xs.sort((u, v) => u - v);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const w = xs[i + 1] - xs[i];
      if (!best || w > best.w) best = { w, x: (xs[i] + xs[i + 1]) / 2, y };
    }
  }
  return best ? { x: best.x, y: best.y } : c;
}

/** Polygon in math. Koordinaten (y nach oben) gegen den Uhrzeigersinn ausrichten. Liefert {pts, reversed}. */
export function ensureCCW(pts) {
  if (signedArea(pts) < 0) return { pts: [...pts].reverse(), reversed: true };
  return { pts: [...pts], reversed: false };
}

/** Innenpunkt an Ecke i (Gehrung) für ein CCW-Polygon, Offset d nach innen (links). */
export function miterPoint(pts, i, d, maxFactor = 3) {
  const n = pts.length;
  const p = pts[i], prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
  const d0 = norm(sub(p, prev)), d1 = norm(sub(next, p));
  const n0 = left(d0), n1 = left(d1);
  let m = add(n0, n1);
  const ml = len(m);
  if (ml < 1e-6) { // 180°-Umkehr: einfach senkrecht
    return add(p, mul(n0, d));
  }
  m = mul(m, 1 / ml);
  let l = d / Math.max(dot(m, n0), 1 / maxFactor);
  return add(p, mul(m, l));
}

export function insetPolygon(pts, d) {
  return pts.map((_, i) => miterPoint(pts, i, d));
}

/** Entfernt doppelte/kollineare Punkte. */
export function cleanPolygon(pts, eps = 1e-6) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || dist(last, p) > eps) out.push({ x: p.x, y: p.y });
  }
  while (out.length > 1 && dist(out[0], out[out.length - 1]) <= eps) out.pop();
  // kollineare Mittelpunkte entfernen
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
      if (Math.abs(cross(sub(b, a), sub(c, b))) < eps * Math.max(1, dist(a, c))) { out.splice(i, 1); changed = true; break; }
    }
  }
  return out;
}

/** Ear-Clipping-Triangulation eines einfachen Polygons (CCW). Liefert Indizes-Tripel. */
export function triangulate(pts) {
  const n = pts.length;
  if (n < 3) return [];
  const idx = [];
  for (let i = 0; i < n; i++) idx.push(i);
  if (signedArea(pts) < 0) idx.reverse();
  const tris = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let earFound = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k - 1 + idx.length) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length];
      const a = pts[i0], b = pts[i1], c = pts[i2];
      const cr = cross(sub(b, a), sub(c, b));
      if (cr <= EPS) continue; // reflex oder degeneriert
      let inside = false;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (pointInTriangle(pts[j], a, b, c)) { inside = true; break; }
      }
      if (inside) continue;
      tris.push([i0, i1, i2]);
      idx.splice(k, 1);
      earFound = true;
      break;
    }
    if (!earFound) {
      // Degeneriertes Polygon: verbleibenden Rest als Fächer abschließen
      for (let k = 1; k + 1 < idx.length; k++) tris.push([idx[0], idx[k], idx[k + 1]]);
      return tris;
    }
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

function pointInTriangle(p, a, b, c) {
  const d1 = cross(sub(b, a), sub(p, a));
  const d2 = cross(sub(c, b), sub(p, b));
  const d3 = cross(sub(a, c), sub(p, c));
  const hasNeg = d1 < -EPS || d2 < -EPS || d3 < -EPS;
  const hasPos = d1 > EPS || d2 > EPS || d3 > EPS;
  return !(hasNeg && hasPos);
}

/** Abgerundetes Rechteck als Polygon (CCW in math. Koordinaten). */
export function roundedRect(x, y, w, h, r, segs = 6) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (r < 1e-6) return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  const pts = [];
  const corners = [
    [x + w - r, y + r, -Math.PI / 2],
    [x + w - r, y + h - r, 0],
    [x + r, y + h - r, Math.PI / 2],
    [x + r, y + r, Math.PI],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let s = 0; s <= segs; s++) {
      const a = a0 + (Math.PI / 2) * (s / segs);
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
  }
  return cleanPolygon(pts);
}

/** Schnitt zweier Rechtecke (bbox-Objekte)? */
export function bboxOverlap(a, b) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

/** Abgerundetes Rechteck als Schleife mit fester Punktzahl (segs je Ecke), ohne Bereinigung – für 1:1-Zuordnung zweier Schleifen. */
export function roundedRectLoop(x, y, w, h, r, segs = 8) {
  r = Math.max(1e-4, Math.min(r, w / 2, h / 2));
  const pts = [];
  const corners = [
    [x + w - r, y + r, -Math.PI / 2],
    [x + w - r, y + h - r, 0],
    [x + r, y + h - r, Math.PI / 2],
    [x + r, y + r, Math.PI],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let s = 0; s <= segs; s++) {
      const a = a0 + (Math.PI / 2) * (s / segs);
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
  }
  return pts;
}

/** Kreisbogenpunkte von a0 bis a1 (Bogenmaß), inklusive Endpunkte. */
export function arcPoints(cx, cy, r, a0, a1, segs = 8) {
  const pts = [];
  for (let s = 0; s <= segs; s++) {
    const a = a0 + (a1 - a0) * (s / segs);
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

/** Sutherland–Hodgman: Polygon an einem achsenparallelen Rechteck beschneiden. */
export function clipPolygonRect(poly, x0, y0, x1, y1) {
  const clipEdge = (pts, inside, intersect) => {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i], prev = pts[(i - 1 + pts.length) % pts.length];
      const ci = inside(cur), pi = inside(prev);
      if (ci) {
        if (!pi) out.push(intersect(prev, cur));
        out.push(cur);
      } else if (pi) out.push(intersect(prev, cur));
    }
    return out;
  };
  const ix = (a, b, x) => ({ x, y: a.y + (b.y - a.y) * ((x - a.x) / (b.x - a.x || 1e-12)) });
  const iy = (a, b, y) => ({ x: a.x + (b.x - a.x) * ((y - a.y) / (b.y - a.y || 1e-12)), y });
  let p = poly;
  if (isFinite(x0)) p = clipEdge(p, q => q.x >= x0, (a, b) => ix(a, b, x0));
  if (isFinite(x1)) p = clipEdge(p, q => q.x <= x1, (a, b) => ix(a, b, x1));
  if (isFinite(y0)) p = clipEdge(p, q => q.y >= y0, (a, b) => iy(a, b, y0));
  if (isFinite(y1)) p = clipEdge(p, q => q.y <= y1, (a, b) => iy(a, b, y1));
  return cleanPolygon(p, 1e-6);
}
