// Wandverläufe: Polygon + Türen → Wandstreifen (außen/innen) mit Lücken.
// Wird vom 2D-Editor (Meter) und vom 3D-Generator (Millimeter) gleich genutzt.
import { sub, add, mul, norm, left, dist, miterPoint, ensureCCW } from './geom.js';

/**
 * Richtet das Polygon gegen den Uhrzeigersinn aus und rechnet die Tür-Kanten mit um.
 * @returns {{pts: {x:number,y:number}[], doors: {edge:number,t:number,half:number,threshold:boolean,id?:string}[]}}
 */
export function normalizeRoom(points, doors, unitScale = 1) {
  const n = points.length;
  const { pts, reversed } = ensureCCW(points);
  const out = [];
  for (const d of doors || []) {
    let edge = d.edge, t = d.t;
    if (reversed) { edge = (n - 2 - d.edge + n) % n; t = 1 - d.t; }
    out.push({ edge, t, half: (d.width * unitScale) / 2, threshold: d.threshold !== false, id: d.id });
  }
  return { pts, doors: out };
}

/** Türintervalle je Kante in Längeneinheiten (geklemmt, sortiert, zusammengeführt). */
export function doorIntervals(pts, doors) {
  const n = pts.length;
  const per = Array.from({ length: n }, () => []);
  for (const d of doors) {
    const A = pts[d.edge], B = pts[(d.edge + 1) % n];
    const L = dist(A, B);
    if (L < 1e-9) continue;
    const half = Math.min(d.half, L / 2);
    const c = Math.max(half, Math.min(L - half, d.t * L));
    per[d.edge].push({ s0: c - half, s1: c + half, threshold: d.threshold, id: d.id });
  }
  for (let i = 0; i < n; i++) {
    const list = per[i].sort((a, b) => a.s0 - b.s0);
    const merged = [];
    for (const iv of list) {
      const last = merged[merged.length - 1];
      if (last && iv.s0 <= last.s1 + 1e-9) { last.s1 = Math.max(last.s1, iv.s1); last.threshold = last.threshold && iv.threshold; }
      else merged.push({ ...iv });
    }
    per[i] = merged;
  }
  return per;
}

/**
 * Wandstreifen berechnen.
 * @param pts CCW-Polygon
 * @param doors normalisierte Türen ({edge,t,half})
 * @param thickness Wanddicke (nach innen)
 * @returns {{runs: {outer:[], inner:[], closed:boolean}[], gaps: {a,b,ia,ib,edge,threshold,id}[]}}
 */
export function wallRuns(pts, doors, thickness) {
  const n = pts.length;
  const per = doorIntervals(pts, doors);
  const edgeInfo = pts.map((A, i) => {
    const B = pts[(i + 1) % n];
    const d = norm(sub(B, A));
    return { A, B, L: dist(A, B), dir: d, nrm: left(d) };
  });
  const at = (i, s) => add(edgeInfo[i].A, mul(edgeInfo[i].dir, s));
  const inner = (i, s) => add(at(i, s), mul(edgeInfo[i].nrm, thickness));
  const miters = pts.map((_, i) => miterPoint(pts, i, thickness));

  const gaps = [];
  for (let i = 0; i < n; i++) for (const iv of per[i]) {
    gaps.push({ a: at(i, iv.s0), b: at(i, iv.s1), ia: inner(i, iv.s0), ib: inner(i, iv.s1), edge: i, threshold: iv.threshold, id: iv.id });
  }

  const flat = [];
  for (let i = 0; i < n; i++) for (const iv of per[i]) flat.push({ edge: i, ...iv });
  if (flat.length === 0) {
    return { runs: [{ outer: pts.slice(), inner: miters.slice(), closed: true }], gaps };
  }

  // Jeder Lauf verbindet das Ende einer Tür mit dem Anfang der nächsten (in Ringreihenfolge).
  const m = flat.length;
  const runs = [];
  for (let k = 0; k < m; k++) {
    const from = flat[k], to = flat[(k + 1) % m];
    const run = { outer: [at(from.edge, from.s1)], inner: [inner(from.edge, from.s1)], closed: false };
    if (k + 1 < m && from.edge === to.edge) {
      pushPoint(run, at(to.edge, to.s0), inner(to.edge, to.s0));
    } else {
      let cur = from.edge;
      for (let guard = 0; guard <= n; guard++) {
        cur = (cur + 1) % n;
        pushPoint(run, pts[cur], miters[cur]);
        if (cur === to.edge) { pushPoint(run, at(to.edge, to.s0), inner(to.edge, to.s0)); break; }
      }
    }
    if (run.outer.length >= 2) runs.push(run);
  }
  return { runs, gaps };

  function pushPoint(r, o, i) {
    const lo = r.outer[r.outer.length - 1];
    if (!lo || dist(lo, o) > 1e-7) { r.outer.push(o); r.inner.push(i); }
  }
}

/** Gestrichelte Linien entlang des Polygons als offene Streifen (für Bereiche). */
export function dashedRuns(pts, thickness, dash, gap) {
  const n = pts.length;
  const runs = [];
  for (let i = 0; i < n; i++) {
    const A = pts[i], B = pts[(i + 1) % n];
    const L = dist(A, B);
    if (L < 1e-9) continue;
    const dir = norm(sub(B, A)), nrm = left(dir);
    const period = dash + gap;
    // Muster zentrieren, damit Ecken sauber aussehen
    const count = Math.max(1, Math.floor((L + gap) / period));
    const used = count * period - gap;
    let s = Math.max(0, (L - used) / 2);
    for (let k = 0; k < count; k++) {
      const s0 = s + k * period, s1 = Math.min(L, s0 + dash);
      if (s1 - s0 < 0.3) continue;
      const a = add(A, mul(dir, s0)), b = add(A, mul(dir, s1));
      runs.push({ outer: [a, b], inner: [add(a, mul(nrm, thickness)), add(b, mul(nrm, thickness))], closed: false });
    }
  }
  return runs;
}

/** Türsegment (Außenkante) in Originalkoordinaten. */
export function doorSegment(points, door) {
  const n = points.length;
  const A = points[door.edge], B = points[(door.edge + 1) % n];
  const L = dist(A, B);
  const dir = L > 1e-9 ? norm(sub(B, A)) : { x: 1, y: 0 };
  const half = Math.min(door.width / 2, L / 2);
  const c = Math.max(half, Math.min(L - half, door.t * L));
  return { a: add(A, mul(dir, c - half)), b: add(A, mul(dir, c + half)), center: add(A, mul(dir, c)), dir, L, half };
}
