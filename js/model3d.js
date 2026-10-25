// 3D-Generator: Plan (Meter) → Dreiecksnetze (Millimeter, Z nach oben).
import * as G from './geom.js';
import { normalizeRoom, wallRuns, dashedRuns } from './walls.js';
import { layoutLabel, displayText } from './labels.js';
import { plateInfo } from './state.js';
import polygonClipping from './vendor/polygon-clipping.js';
import earcut from './vendor/earcut.js';

let textProvider = null;

/** 3D-Schrift einhängen: (text, size, depth) → Float32Array Dreieckspositionen (Grundlinie y=0, Start x=0, z 0..depth). */
export function setTextProvider(fn) { textProvider = fn; }
export function hasTextProvider() { return !!textProvider; }

/* ---------- Primitive ---------- */
function tri(out, a, b, c) { out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); }

export function extrudePolygon(out, pts, z0, z1) {
  const poly = G.cleanPolygon(G.ensureCCW(pts).pts);
  if (poly.length < 3) return;
  const tris = G.triangulate(poly);
  for (const [a, b, c] of tris) {
    const A = poly[a], B = poly[b], C = poly[c];
    tri(out, [A.x, A.y, z1], [B.x, B.y, z1], [C.x, C.y, z1]);
    tri(out, [A.x, A.y, z0], [C.x, C.y, z0], [B.x, B.y, z0]);
  }
  for (let i = 0; i < poly.length; i++) {
    const A = poly[i], B = poly[(i + 1) % poly.length];
    tri(out, [A.x, A.y, z0], [B.x, B.y, z0], [B.x, B.y, z1]);
    tri(out, [A.x, A.y, z0], [B.x, B.y, z1], [A.x, A.y, z1]);
  }
}

export function extrudeStrip(out, outer, inner, closed, z0, z1) {
  const m = outer.length;
  if (m < 2) return;
  const segs = closed ? m : m - 1;
  for (let k = 0; k < segs; k++) {
    const o0 = outer[k], o1 = outer[(k + 1) % m], i0 = inner[k], i1 = inner[(k + 1) % m];
    // oben
    tri(out, [o0.x, o0.y, z1], [o1.x, o1.y, z1], [i1.x, i1.y, z1]);
    tri(out, [o0.x, o0.y, z1], [i1.x, i1.y, z1], [i0.x, i0.y, z1]);
    // unten
    tri(out, [o0.x, o0.y, z0], [i1.x, i1.y, z0], [o1.x, o1.y, z0]);
    tri(out, [o0.x, o0.y, z0], [i0.x, i0.y, z0], [i1.x, i1.y, z0]);
    // außen
    tri(out, [o0.x, o0.y, z0], [o1.x, o1.y, z0], [o1.x, o1.y, z1]);
    tri(out, [o0.x, o0.y, z0], [o1.x, o1.y, z1], [o0.x, o0.y, z1]);
    // innen
    tri(out, [i1.x, i1.y, z0], [i0.x, i0.y, z0], [i0.x, i0.y, z1]);
    tri(out, [i1.x, i1.y, z0], [i0.x, i0.y, z1], [i1.x, i1.y, z1]);
  }
  if (!closed) {
    const o0 = outer[0], i0 = inner[0], oN = outer[m - 1], iN = inner[m - 1];
    tri(out, [i0.x, i0.y, z0], [o0.x, o0.y, z0], [o0.x, o0.y, z1]);
    tri(out, [i0.x, i0.y, z0], [o0.x, o0.y, z1], [i0.x, i0.y, z1]);
    tri(out, [oN.x, oN.y, z0], [iN.x, iN.y, z0], [iN.x, iN.y, z1]);
    tri(out, [oN.x, oN.y, z0], [iN.x, iN.y, z1], [oN.x, oN.y, z1]);
  }
}

/** Polygon mit Löchern extrudieren. rings[0] außen (CCW), weitere Ringe Löcher (CW). */
export function extrudeRings(out, rings, z0, z1) {
  const data = [];
  const holeIdx = [];
  rings.forEach((ring, i) => {
    if (i > 0) holeIdx.push(data.length / 2);
    for (const p of ring) data.push(p.x, p.y);
  });
  const pt = (i) => ({ x: data[i * 2], y: data[i * 2 + 1] });
  const idx = earcut(data, holeIdx.length ? holeIdx : null, 2);
  for (let k = 0; k < idx.length; k += 3) {
    const a = pt(idx[k]), b = pt(idx[k + 1]), c = pt(idx[k + 2]);
    const ar = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(ar) < 1e-9) continue;
    const [A, B, C] = ar > 0 ? [a, b, c] : [a, c, b];
    tri(out, [A.x, A.y, z1], [B.x, B.y, z1], [C.x, C.y, z1]);
    tri(out, [A.x, A.y, z0], [C.x, C.y, z0], [B.x, B.y, z0]);
  }
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const A = ring[i], B = ring[(i + 1) % ring.length];
      tri(out, [A.x, A.y, z0], [B.x, B.y, z0], [B.x, B.y, z1]);
      tri(out, [A.x, A.y, z0], [B.x, B.y, z1], [A.x, A.y, z1]);
    }
  }
}

/** Geschlossene Kuppel (Kugelkalotte mit Bodenscheibe). */
export function dome(out, cx, cy, z0, r, h, segs = 16, rings = 5) {
  const R = (r * r + h * h) / (2 * h);
  const zc = z0 + h - R;
  const ringPts = [];
  for (let j = 0; j < rings; j++) {
    const f = Math.sin((j / rings) * Math.PI / 2); // dichter zur Spitze
    const z = z0 + h * f;
    const rho = Math.sqrt(Math.max(0, R * R - (z - zc) * (z - zc)));
    const ring = [];
    for (let k = 0; k < segs; k++) {
      const a = (k / segs) * Math.PI * 2;
      ring.push([cx + rho * Math.cos(a), cy + rho * Math.sin(a), z]);
    }
    ringPts.push(ring);
  }
  const apex = [cx, cy, z0 + h];
  for (let j = 0; j < rings; j++) {
    const lo = ringPts[j], hi = j + 1 < rings ? ringPts[j + 1] : null;
    for (let k = 0; k < segs; k++) {
      const k1 = (k + 1) % segs;
      if (hi) {
        tri(out, lo[k], lo[k1], hi[k1]);
        tri(out, lo[k], hi[k1], hi[k]);
      } else {
        tri(out, lo[k], lo[k1], apex);
      }
    }
  }
  const base = ringPts[0];
  const c = [cx, cy, z0];
  for (let k = 0; k < segs; k++) tri(out, c, base[(k + 1) % segs], base[k]);
}

function translateTris(arr, dx, dy, dz) {
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i += 3) { out[i] = arr[i] + dx; out[i + 1] = arr[i + 1] + dy; out[i + 2] = arr[i + 2] + dz; }
  return out;
}

export function trisBBox(tris) {
  const b = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i], y = tris[i + 1], z = tris[i + 2];
    if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y;
    if (z < b.minZ) b.minZ = z; if (z > b.maxZ) b.maxZ = z;
  }
  return b;
}

export function mergeBBox(a, b) {
  if (!a) return b; if (!b) return a;
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), minZ: Math.min(a.minZ, b.minZ), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY), maxZ: Math.max(a.maxZ, b.maxZ) };
}

/* ---------- Modellaufbau ---------- */

class PieceBuilder {
  constructor(id, name, color) { this.id = id; this.name = name; this.color = color; this.parts = []; this.current = new Map(); }
  part(kind, roomId, color) {
    const key = `${kind}|${roomId ?? ''}`;
    if (!this.current.has(key)) {
      const p = { kind, roomId: roomId ?? null, color, tris: [] };
      this.current.set(key, p); this.parts.push(p);
    }
    return this.current.get(key).tris;
  }
  finish() {
    const parts = this.parts.filter(p => p.tris.length).map(p => ({ ...p, tris: p.tris instanceof Float32Array ? p.tris : Float32Array.from(p.tris) }));
    let bbox = null;
    for (const p of parts) bbox = mergeBBox(bbox, trisBBox(p.tris));
    const triangles = parts.reduce((n, p) => n + p.tris.length / 9, 0);
    return { id: this.id, name: this.name, color: this.color, parts, bbox, triangles };
  }
}

/**
 * Baut das Modell.
 * @param plan
 * @param {{scope?: 'whole'|'rooms', roomIds?: string[], overlap?: number, legend?: boolean, legendOnly?: boolean, surround?: boolean}} opts
 *   surround: bei 'rooms' die restliche Grundplatte (Rand und Zwischenräume) als eigenes Teil „Umgebung“ erzeugen.
 */
export function buildModel(plan, opts = {}) {
  const s = plan.settings;
  const scope = opts.scope === 'rooms' ? 'rooms' : 'whole';
  const overlap = Math.max(0, opts.overlap ?? 0);
  const warnings = [];
  const info = plateInfo(plan);
  const baseTop = s.plate.thickness;
  const zRaised0 = baseTop - overlap;
  const toMM = info.toMM;
  const pieces = [];

  const roomsMM = plan.rooms.map(r => ({ room: r, pts: G.cleanPolygon(G.ensureCCW(r.points.map(toMM)).pts) }));
  const minWall = Math.max(1.2, s.wall.thickness * 2.5);
  for (const { room, pts } of roomsMM) {
    if (room.type !== 'room') continue;
    const b = G.bbox(pts);
    if (Math.min(b.width, b.height) < minWall) warnings.push(`„${room.name}“ ist im Modell nur ${Math.min(b.width, b.height).toFixed(1)} mm breit – zu klein für Wände dieser Dicke.`);
  }

  const addRoomFeatures = (pb, room, color) => {
    if (room.type === 'room') {
      const { pts, doors } = normalizeRoom(room.points.map(toMM), room.doors, s.scale);
      const { runs, gaps } = wallRuns(pts, doors, s.wall.thickness);
      const out = pb.part('raised', room.id, color);
      for (const run of runs) extrudeStrip(out, run.outer, run.inner, run.closed, zRaised0, baseTop + s.wall.height);
      for (const g of gaps) {
        if (!g.threshold || s.door.thresholdHeight <= 0.05) continue;
        // Schwelle etwas in die Wandenden hinein verlängern, damit die Körper sauber verschmelzen
        const dir = G.norm(G.sub(g.b, g.a));
        const ext = Math.min(0.4, s.wall.thickness / 2);
        const a = G.sub(g.a, G.mul(dir, ext)), b = G.add(g.b, G.mul(dir, ext));
        const ia = G.sub(g.ia, G.mul(dir, ext)), ib = G.add(g.ib, G.mul(dir, ext));
        extrudeStrip(out, [a, b], [ia, ib], false, zRaised0, baseTop + s.door.thresholdHeight);
      }
    } else {
      const { pts } = normalizeRoom(room.points.map(toMM), [], 1);
      const out = pb.part('raised', room.id, color);
      if (s.zone.dashed) {
        for (const run of dashedRuns(pts, s.zone.thickness, s.zone.dash, s.zone.gap)) extrudeStrip(out, run.outer, run.inner, false, zRaised0, baseTop + s.zone.height);
      } else {
        extrudeStrip(out, pts, G.insetPolygon(pts, s.zone.thickness), true, zRaised0, baseTop + s.zone.height);
      }
    }
    if (room.label.visible !== false) addLabel(pb, room.label.x, room.label.y, room, color, room.id);
  };

  const addLabel = (pb, x, y, el, color, roomId) => {
    const lay = layoutLabel(el, s);
    if (!lay) return;
    const c = toMM({ x, y });
    const out = pb.part('raised', roomId ?? null, color);
    const r = s.braille.dotDiameter / 2;
    for (const d of lay.dots) dome(out, c.x + d.x, c.y + d.y, zRaised0, r, s.braille.dotHeight + overlap);
    if (lay.textItems.length) {
      if (!textProvider) { if (!warnings.includes('3D-Schrift nicht verfügbar – Profilschrift wurde weggelassen.')) warnings.push('3D-Schrift nicht verfügbar – Profilschrift wurde weggelassen.'); }
      else {
        for (const ti of lay.textItems) {
          try {
            const tris = textProvider(ti.text, ti.size, s.text.height + overlap);
            const moved = translateTris(tris, c.x + ti.x, c.y + ti.baseline, zRaised0);
            for (let i = 0; i < moved.length; i++) out.push(moved[i]);
          } catch (e) { warnings.push(`Schrift „${ti.text}“ konnte nicht erzeugt werden.`); }
        }
      }
    }
  };

  if (!opts.legendOnly) {
    if (scope === 'whole') {
      const pb = new PieceBuilder('plan', plan.name || 'Plan', s.colors.base);
      if (info.ext) {
        const plate = G.roundedRect(0, 0, info.width, info.height, s.plate.cornerRadius);
        extrudePolygon(pb.part('base', null, s.colors.base), plate, 0, baseTop);
      }
      for (const r of plan.rooms) addRoomFeatures(pb, r, r.type === 'room' ? r.color : '#6f6a62');
      for (const l of plan.labels) addLabel(pb, l.x, l.y, l, '#6f6a62', null);
      pieces.push(pb.finish());
    } else {
      const roomList = plan.rooms.filter(r => r.type === 'room' && (!opts.roomIds || opts.roomIds.includes(r.id)));
      const zoneList = plan.rooms.filter(r => r.type === 'zone');
      const assigned = new Set();
      for (const room of roomList) {
        const pb = new PieceBuilder(room.id, room.name || 'Raum', room.color);
        const pts = room.points.map(toMM);
        extrudePolygon(pb.part('base', room.id, room.color), pts, 0, baseTop);
        addRoomFeatures(pb, room, room.color);
        for (const z of zoneList) {
          if (!assigned.has(z.id) && G.pointInPolygon(G.labelPoint(z.points), room.points)) { assigned.add(z.id); addRoomFeatures(pb, z, room.color); }
        }
        for (const l of plan.labels) {
          if (!assigned.has(l.id) && G.pointInPolygon({ x: l.x, y: l.y }, room.points)) { assigned.add(l.id); addLabel(pb, l.x, l.y, l, room.color, room.id); }
        }
        pieces.push(pb.finish());
      }
      if (!opts.roomIds) {
        for (const z of zoneList) {
          if (assigned.has(z.id)) continue;
          const pb = new PieceBuilder(z.id, z.name || 'Bereich', '#8f8a86');
          extrudePolygon(pb.part('base', z.id, '#8f8a86'), z.points.map(toMM), 0, baseTop);
          addRoomFeatures(pb, z, '#8f8a86');
          pieces.push(pb.finish());
        }
        if (opts.surround !== false && info.ext) {
          const cutters = plan.rooms
            .filter(r => r.type === 'room' || !assigned.has(r.id))
            .map(r => G.cleanPolygon(G.ensureCCW(r.points.map(toMM)).pts))
            .filter(p => p.length >= 3 && G.area(p) > 1)
            .map(p => [closeRing(p)]);
          const plate = [closeRing(G.roundedRect(0, 0, info.width, info.height, s.plate.cornerRadius))];
          let diff = [];
          try {
            const uni = cutters.length ? polygonClipping.union(...cutters) : [];
            diff = uni.length ? polygonClipping.difference(plate, uni) : [plate];
          } catch (e) {
            warnings.push(`Umgebungsplatte konnte nicht berechnet werden (${e.message}).`);
          }
          let k = 0;
          const total = diff.filter(poly => ringArea(poly[0]) >= 15).length;
          for (const poly of diff) {
            const rings = poly.map(r => G.cleanPolygon(r.slice(0, -1).map(([x, y]) => ({ x, y })), 1e-6)).filter(r => r.length >= 3);
            if (!rings.length || G.area(rings[0]) < 15) continue;
            const outer = G.ensureCCW(rings[0]).pts;
            const holes = rings.slice(1).filter(h => G.area(h) >= 4).map(h => G.ensureCCW(h).pts.reverse());
            const pb = new PieceBuilder(`surround-${k}`, total > 1 ? `Umgebung ${k + 1}` : 'Umgebung', s.colors.base);
            k++;
            extrudeRings(pb.part('base', null, s.colors.base), [outer, ...holes], 0, baseTop);
            for (const l of plan.labels) {
              if (assigned.has(l.id)) continue;
              const pm = toMM({ x: l.x, y: l.y });
              if (G.pointInPolygon(pm, outer) && !holes.some(h => G.pointInPolygon(pm, h))) { assigned.add(l.id); addLabel(pb, l.x, l.y, l, '#6f6a62', null); }
            }
            pieces.push(pb.finish());
          }
        }
        for (const l of plan.labels) if (!assigned.has(l.id)) warnings.push(`Beschriftung „${displayText(l)}“ liegt außerhalb aller Räume und fehlt bei „Räume einzeln“.`);
      }
    }
  }

  if (opts.legend || opts.legendOnly) {
    const legend = buildLegend(plan, { overlap, offsetX: (info.width || 0) + 12, addLabel, warnings });
    if (legend) pieces.push(legend);
  }

  const triangles = pieces.reduce((n, p) => n + p.triangles, 0);
  return { pieces, warnings, info: { plateWidth: info.width, plateHeight: info.height, baseTop, triangles } };
}

function closeRing(pts) {
  const r = pts.map(p => [p.x, p.y]);
  r.push([pts[0].x, pts[0].y]);
  return r;
}

function ringArea(ring) {
  let s = 0;
  for (let i = 0; i + 1 < ring.length; i++) s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(s / 2);
}

export function legendEntries(plan) {
  const entries = [];
  for (const el of [...plan.rooms, ...plan.labels]) {
    const short = (el.short ?? '').trim(), name = (el.name ?? '').trim();
    if (short && name && short.toLowerCase() !== name.toLowerCase()) entries.push({ short, name });
  }
  const seen = new Set();
  return entries.filter(e => { const k = `${e.short}|${e.name}`.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

function buildLegend(plan, { overlap, offsetX, addLabel, warnings }) {
  const s = plan.settings;
  const entries = legendEntries(plan);
  if (!entries.length) { warnings.push('Legende leer: keine Kurzbezeichnungen vergeben, die vom Namen abweichen.'); return null; }
  const margin = 7;
  const rowGap = 3;
  const rows = [{ el: { name: 'Legende', short: '', showBraille: true, showText: true } }, ...entries.map(e => ({ el: { name: `${e.short} – ${e.name}`, short: '', showBraille: true, showText: true } }))];
  for (const r of rows) r.lay = layoutLabel(r.el, s);
  const width = Math.max(...rows.map(r => r.lay?.width ?? 0)) + 2 * margin;
  const height = rows.reduce((h, r) => h + (r.lay?.height ?? 0) + rowGap, 0) - rowGap + 2 * margin;
  const pb = new PieceBuilder('legend', 'Legende', s.colors.base);
  // Platte unterhalb bzw. rechts neben dem Plan
  const plate = G.roundedRect(offsetX, 0, width, height, s.plate.cornerRadius);
  extrudePolygon(pb.part('base', null, s.colors.base), plate, 0, s.plate.thickness);
  // Zeilen von oben nach unten
  let yTop = height - margin;
  const toPlan = (xmm, ymm) => ({ xmm, ymm });
  const base = plateInfo(plan);
  for (const r of rows) {
    if (!r.lay) continue;
    const cxmm = offsetX + margin + r.lay.width / 2;
    const cymm = yTop - r.lay.height / 2;
    // addLabel erwartet Planmeter → rückrechnen über die Plattenabbildung
    const inv = invertToMM(base, { x: cxmm, y: cymm }, s);
    addLabel(pb, inv.x, inv.y, r.el, '#6f6a62', null);
    yTop -= r.lay.height + rowGap;
  }
  return pb.finish();
}

function invertToMM(info, pmm, s) {
  if (!info.ext) return { x: (pmm.x - s.plate.margin) / s.scale, y: -(pmm.y - s.plate.margin) / s.scale };
  const m = s.plate.margin;
  return { x: (pmm.x - m) / s.scale + info.ext.minX, y: info.ext.maxY - (pmm.y - m) / s.scale };
}
