// Rahmen (Wanne) zum Einlegen der Platte: Rückwand + Rand, in Kacheln teilbar,
// Schwalbenschwanz-Verbinder an den Schnittkanten, Schlüsselloch-Aufhängung in der Rückwand.
import * as G from './geom.js';
import { extrudePolygon, extrudeStrip, trisBBox } from './model3d.js';
import { bedSize } from './state.js';

const SEGS = 8;
const TAB = { neck: 10, head: 14, depth: 6, clearance: 0.25 };
const KEY = { r: 4.0, slotW: 4.5, slotL: 8, margin: 1.5 };

export function frameLayout(plan, plateW, plateH) {
  const s = plan.settings, f = s.frame;
  const off = f.clearance + f.rimW;
  const x0 = -off, y0 = -off;
  const W = plateW + 2 * off, H = plateH + 2 * off;
  const rI = Math.max(0.5, s.plate.cornerRadius + f.clearance);
  const rO = rI + f.rimW;
  const bed = bedSize(s);
  let cols = Math.round(f.cols) || 1, rows = Math.round(f.rows) || 1;
  if (f.split !== 'manual') {
    const uw = Math.max(20, bed.w - 2), uh = Math.max(20, bed.h - 2);
    const a = { cols: Math.ceil(W / uw), rows: Math.ceil(H / uh) };
    const b = { cols: Math.ceil(W / uh), rows: Math.ceil(H / uw) };
    const pick = a.cols * a.rows <= b.cols * b.rows ? a : b;
    cols = pick.cols; rows = pick.rows;
  }
  cols = Math.max(1, Math.min(6, cols)); rows = Math.max(1, Math.min(6, rows));
  const tileW = W / cols, tileH = H / rows;
  const tiles = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    tiles.push({ col: c, row: r, x0: x0 + c * tileW, x1: x0 + (c + 1) * tileW, y0: y0 + r * tileH, y1: y0 + (r + 1) * tileH });
  }
  const fitsBed = (tileW <= bed.w && tileH <= bed.h) || (tileW <= bed.h && tileH <= bed.w);
  return {
    x0, y0, W, H, rimW: f.rimW, backT: f.backT, rimH: Math.max(0.8, s.plate.thickness + f.rimOver),
    clearance: f.clearance, rI, rO, cols, rows, tiles, tileW, tileH, bed, fitsBed,
    joint: f.joint, keyholes: f.keyholes,
  };
}

/** Schwalbenschwanz-Profile entlang einer Schnittkante einfügen. axis 'x': Kante bei x=value; axis 'y': bei y=value. */
function addJoint(poly, axis, value, outward, shape, centers) {
  const n = poly.length;
  const on = (p) => Math.abs((axis === 'x' ? p.x : p.y) - value) < 1e-6;
  for (let i = 0; i < n; i++) {
    const P = poly[i], Q = poly[(i + 1) % n];
    if (!on(P) || !on(Q)) continue;
    const t = G.norm(G.sub(Q, P));
    const nrm = axis === 'x' ? { x: outward, y: 0 } : { x: 0, y: outward };
    const L = G.dist(P, Q);
    const c = TAB.clearance;
    const neck = shape === 'tab' ? TAB.neck : TAB.neck + 2 * c;
    const head = shape === 'tab' ? TAB.head : TAB.head + 2 * c;
    const depth = shape === 'tab' ? TAB.depth : -(TAB.depth + c);
    const insert = [];
    const ss = centers.map(v => G.dot(G.sub(axis === 'x' ? { x: value, y: v } : { x: v, y: value }, P), t)).filter(sv => sv > head / 2 + 1 && sv < L - head / 2 - 1).sort((a, b) => a - b);
    for (const sv of ss) {
      for (const [ds, dd] of [[-neck / 2, 0], [-head / 2, depth], [head / 2, depth], [neck / 2, 0]]) {
        insert.push(G.add(G.add(P, G.mul(t, sv + ds)), G.mul(nrm, dd)));
      }
    }
    if (!insert.length) return poly;
    return [...poly.slice(0, i + 1), ...insert, ...poly.slice(i + 1)];
  }
  return poly;
}

function tabCenters(a, b, margin) {
  const usable = (b - a) - 2 * margin;
  if (usable < TAB.head + 2) return [];
  const count = Math.max(1, Math.floor(usable / 70));
  const out = [];
  for (let k = 0; k < count; k++) out.push(a + margin + usable * ((k + 0.5) / count));
  return out;
}

/** Schlüsselloch als Ring (Box → Lochkontur) mit 1:1-Punktzuordnung, Loch nach oben geschlitzt. */
function keyholeRing(cx, cy) {
  const { r: R, slotW, slotL, margin: m } = KEY;
  const bx = R + m, byLo = R + m, byHi = slotL + m;
  const angles = new Set();
  const K = 40;
  for (let k = 0; k < K; k++) angles.add((k / K) * Math.PI * 2);
  for (const [x, y] of [[bx, byHi], [-bx, byHi], [-bx, -byLo], [bx, -byLo]]) angles.add((Math.atan2(y, x) + Math.PI * 2) % (Math.PI * 2));
  const list = [...angles].sort((a, b) => a - b);
  const outer = [], inner = [];
  for (const th of list) {
    const c = Math.cos(th), sn = Math.sin(th);
    let rIn = R;
    if (sn > 1e-9) rIn = Math.max(R, Math.min((slotW / 2) / Math.max(Math.abs(c), 1e-9), slotL / sn));
    let rOut = Infinity;
    if (c > 1e-9) rOut = Math.min(rOut, bx / c);
    if (c < -1e-9) rOut = Math.min(rOut, bx / -c);
    if (sn > 1e-9) rOut = Math.min(rOut, byHi / sn);
    if (sn < -1e-9) rOut = Math.min(rOut, byLo / -sn);
    outer.push({ x: cx + rOut * c, y: cy + rOut * sn });
    inner.push({ x: cx + rIn * c, y: cy + rIn * sn });
  }
  return { outer, inner, box: { x0: cx - bx, x1: cx + bx, y0: cy - byLo, y1: cy + byHi } };
}

function keyholeCenters(L, tile) {
  const wt = tile.x1 - tile.x0;
  const cy = (L.y0 + L.H) - L.rimW - 5 - KEY.slotL;
  if (cy - KEY.r - KEY.margin < tile.y0 + TAB.depth + 4) return [];
  if (wt >= 110) {
    const d = Math.max(22, 0.22 * wt);
    return [{ x: tile.x0 + d, y: cy }, { x: tile.x1 - d, y: cy }];
  }
  if (wt >= 2 * (KEY.r + KEY.margin) + 2 * (TAB.depth + 4)) return [{ x: (tile.x0 + tile.x1) / 2, y: cy }];
  return [];
}

/**
 * Rahmen bauen.
 * @returns {{pieces: object[], layout: object, warnings: string[]}}
 */
export function buildFrame(plan, plateW, plateH) {
  const s = plan.settings;
  const L = frameLayout(plan, plateW, plateH);
  const warnings = [];
  const color = s.colors.frame || '#cfc8bb';
  if (!L.fitsBed) warnings.push(`Rahmenkacheln (${Math.round(L.tileW)} × ${Math.round(L.tileH)} mm) sind größer als das Druckbett – Teilung erhöhen.`);
  if (Math.min(L.tileW, L.tileH) < 2 * L.rO + 12) warnings.push('Rahmenkacheln sind sehr klein; Teilung verringern.');

  const outline = G.roundedRectLoop(L.x0, L.y0, L.W, L.H, L.rO, SEGS);
  const pieces = [];
  const inf = Infinity;

  for (const tile of L.tiles) {
    const tris = [];
    // Rückwand-Polygon der Kachel
    let panel = G.clipPolygonRect(outline, tile.x0, tile.y0, tile.x1, tile.y1);
    if (L.joint === 'dovetail') {
      const my = L.rimW + L.clearance + 10;
      if (tile.col < L.cols - 1) panel = addJoint(panel, 'x', tile.x1, +1, 'tab', tabCenters(tile.y0, tile.y1, my));
      if (tile.col > 0) panel = addJoint(panel, 'x', tile.x0, -1, 'notch', tabCenters(tile.y0, tile.y1, my));
      if (tile.row < L.rows - 1) panel = addJoint(panel, 'y', tile.y1, +1, 'tab', tabCenters(tile.x0, tile.x1, my));
      if (tile.row > 0) panel = addJoint(panel, 'y', tile.y0, -1, 'notch', tabCenters(tile.x0, tile.x1, my));
    }

    // Schlüssellöcher (oberste Reihe) als Taschen von der Rückseite
    const depth = Math.min(L.backT - 1.2, 3.2);
    const holes = L.keyholes && tile.row === L.rows - 1 && depth >= 1.2 ? keyholeCenters(L, tile) : [];
    if (L.keyholes && depth < 1.2 && tile.row === L.rows - 1 && tile.col === 0) warnings.push('Rückwand zu dünn für Schlüssellöcher (mindestens 2,5 mm).');
    if (!holes.length) {
      extrudePolygon(tris, panel, 0, L.backT);
    } else {
      extrudePolygon(tris, panel, depth, L.backT);
      const rings = holes.sort((a, b) => a.x - b.x).map(h => keyholeRing(h.x, h.y));
      let prevX = -inf;
      for (const ring of rings) {
        const b = ring.box;
        const left = G.clipPolygonRect(panel, prevX, -inf, b.x0, inf);
        if (left.length >= 3) extrudePolygon(tris, left, 0, depth);
        const below = G.clipPolygonRect(panel, b.x0, -inf, b.x1, b.y0);
        if (below.length >= 3) extrudePolygon(tris, below, 0, depth);
        const above = G.clipPolygonRect(panel, b.x0, b.y1, b.x1, inf);
        if (above.length >= 3) extrudePolygon(tris, above, 0, depth);
        extrudeStrip(tris, ring.outer, ring.inner, true, 0, depth);
        prevX = b.x1;
      }
      const right = G.clipPolygonRect(panel, prevX, -inf, inf, inf);
      if (right.length >= 3) extrudePolygon(tris, right, 0, depth);
    }

    // Rand: vier Bänder + vier Viertelringe, jeweils auf die Kachel beschnitten
    const z0 = L.backT, z1 = L.backT + L.rimH;
    const X1 = L.x0 + L.W, Y1 = L.y0 + L.H;
    const bands = [
      [L.x0 + L.rO, Y1 - L.rimW, X1 - L.rO, Y1],
      [L.x0 + L.rO, L.y0, X1 - L.rO, L.y0 + L.rimW],
      [L.x0, L.y0 + L.rO, L.x0 + L.rimW, Y1 - L.rO],
      [X1 - L.rimW, L.y0 + L.rO, X1, Y1 - L.rO],
    ];
    for (const [bx0, by0, bx1, by1] of bands) {
      const cx0 = Math.max(bx0, tile.x0), cx1 = Math.min(bx1, tile.x1), cy0 = Math.max(by0, tile.y0), cy1 = Math.min(by1, tile.y1);
      if (cx1 - cx0 > 1e-6 && cy1 - cy0 > 1e-6) extrudePolygon(tris, [{ x: cx0, y: cy0 }, { x: cx1, y: cy0 }, { x: cx1, y: cy1 }, { x: cx0, y: cy1 }], z0, z1);
    }
    const corners = [
      [X1 - L.rO, Y1 - L.rO, 0],
      [L.x0 + L.rO, Y1 - L.rO, Math.PI / 2],
      [L.x0 + L.rO, L.y0 + L.rO, Math.PI],
      [X1 - L.rO, L.y0 + L.rO, -Math.PI / 2],
    ];
    for (const [cx, cy, a0] of corners) {
      const outer = G.arcPoints(cx, cy, L.rO, a0, a0 + Math.PI / 2, SEGS);
      const inner = G.arcPoints(cx, cy, L.rI, a0 + Math.PI / 2, a0, SEGS);
      const poly = G.clipPolygonRect([...outer, ...inner], tile.x0, tile.y0, tile.x1, tile.y1);
      if (poly.length >= 3) extrudePolygon(tris, poly, z0, z1);
    }

    const arr = Float32Array.from(tris);
    const name = L.tiles.length === 1 ? 'Rahmen' : `Rahmen ${L.rows - tile.row}-${tile.col + 1}`; // Reihe 1 = oben
    pieces.push({ id: `frame-${tile.row}-${tile.col}`, name, color, parts: [{ kind: 'frame', roomId: null, color, tris: arr }], bbox: trisBBox(arr), triangles: arr.length / 9 });
  }
  return { pieces, layout: L, warnings };
}

/** Teile eines Modells um dz anheben (für die Vorschau in der Wanne). */
export function liftPieces(pieces, dz) {
  return pieces.map(p => ({
    ...p,
    parts: p.parts.map(part => {
      const t = new Float32Array(part.tris.length);
      for (let i = 0; i < t.length; i += 3) { t[i] = part.tris[i]; t[i + 1] = part.tris[i + 1]; t[i + 2] = part.tris[i + 2] + dz; }
      return { ...part, tris: t };
    }),
  }));
}
