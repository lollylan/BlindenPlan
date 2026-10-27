// 2D-Editor: Zeichenfläche für Räume, Bereiche, Säulen, Türen und Beschriftungen (Einheit: Meter).
import * as G from './geom.js';
import { normalizeRoom, wallRuns, dashedRuns, doorSegment, foreignDoorIntervals, childrenOf } from './walls.js';
import { layoutLabel } from './labels.js';
import { makeRoom, makeLabel, makeMarker, rectPoints, ROOM_COLORS, PILLAR_COLOR, plateInfo, bedSize, planExtent, uid } from './state.js';
import { markerOutline } from './markers.js';
import { planLines, underlayCorners } from './underlay.js';

const HIT = 9;        // Trefferradius in px
const HANDLE = 5;     // halbe Griffgröße in px
const INK = '#1c1b18';
const INK2 = '#514c43';
const ACCENT = '#0e6b63';
const DANGER = '#b4281e';

const SNAP_PREVIEW_TOOLS = new Set(['rect', 'poly', 'zone', 'zonepoly', 'pillar']);

const fmtM = (v) => `${v.toFixed(2).replace('.', ',')} m`;
const fmtMM = (v) => `${Math.round(v)} mm`;

export class Editor {
  constructor(canvas, store, cb = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.store = store;
    this.cb = cb;
    this.view = { x: 90, y: 80, zoom: 60 }; // zoom = px pro Meter
    this.snapStep = 0.1;
    this.pointer = null;       // Planposition des Zeigers
    this.pointerScreen = null;
    this.hover = null;
    this.drag = null;
    this.draw = null;          // laufende Zeichnung (rect/poly)
    this.spaceDown = false;
    this.pointers = new Map();
    this.pinch = null;
    this.hatchCache = new Map();
    this.dpr = 1;
    this.needsRender = false;
    this.snapGuide = null;     // zuletzt gefangener Punkt samt Wandlinien der Vorlage
    this.measure = null;       // Messstrecke für den Maßstab der Vorlage {a, b, cur}

    this.bind();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement);
    this.resize();
  }

  /* ---------- Koordinaten ---------- */
  toPlan(sx, sy) { return { x: (sx - this.view.x) / this.view.zoom, y: (sy - this.view.y) / this.view.zoom }; }
  toScreen(p) { return { x: this.view.x + p.x * this.view.zoom, y: this.view.y + p.y * this.view.zoom }; }
  pxPerMm() { return this.view.zoom / this.store.plan.settings.scale; }

  snap(p, opts = {}) {
    let q = { x: p.x, y: p.y };
    if (this.snapStep > 0) {
      // auf 1e-6 runden, sonst stehen Werte wie 1,7000000000000002 im Panel
      const r = (v) => Math.round(Math.round(v / this.snapStep) * this.snapStep * 1e6) / 1e6;
      q = { x: r(p.x), y: r(p.y) };
    }
    this.snapGuide = null;
    if (opts.vertices !== false) {
      // Fang an Wänden der Vorlage, Ecken bestehender Räume haben Vorrang
      const w = this.wallSnap(p, q);
      if (w) { q = { x: Math.round(w.point.x * 1e6) / 1e6, y: Math.round(w.point.y * 1e6) / 1e6 }; this.snapGuide = { point: q, lines: w.lines }; }
      // Fang an bestehenden Ecken (Puzzle-Anschluss)
      const sp = this.toScreen(p);
      let best = null;
      for (const r of this.store.plan.rooms) {
        if (opts.excludeRoom && r.id === opts.excludeRoom) continue;
        for (const v of r.points) {
          const d = G.dist(this.toScreen(v), sp);
          if (d <= 8 && (!best || d < best.d)) best = { d, v };
        }
      }
      if (best) { q = { x: best.v.x, y: best.v.y }; this.snapGuide = { point: q, lines: [] }; }
    }
    return q;
  }

  /** Nächste erkannte Wandlinie der Vorlage; liegen zwei quer zueinander nah, ihr Schnittpunkt (Ecke). */
  wallSnap(p, q) {
    const u = this.store.underlay;
    if (!u || !u.visible || !u.snap || !u.lines.length) return null;
    const tol = 10 / this.view.zoom;
    const ext = tol * 1.5;
    const cands = [];
    for (const l of planLines(u)) {
      const ap = G.sub(p, l.a);
      const t = G.dot(ap, l.d);
      if (t < -ext || t > l.L + ext) continue;
      const d = Math.abs(G.cross(l.d, ap));
      if (d <= tol) cands.push({ l, d });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => a.d - b.d);
    const best = cands[0].l;
    const other = cands.find(c => Math.abs(G.cross(best.d, c.l.d)) > 0.5)?.l;
    if (other) {
      const den = G.cross(best.d, other.d);
      const s = G.cross(G.sub(other.a, best.a), other.d) / den;
      const x = G.add(best.a, G.mul(best.d, s));
      if (G.dist(x, p) <= tol * 1.5) return this.gridAlongWalls({ point: x, lines: [best, other] });
    }
    // entlang der Wand bleibt das Raster wirksam
    const point = G.add(best.a, G.mul(best.d, G.dot(G.sub(q, best.a), best.d)));
    return this.gridAlongWalls({ point, lines: [best] });
  }

  /** Achsparallele Wände aufs Raster legen: Skizzenstriche zittern, Nachbarräume sollen exakt anschließen. */
  gridAlongWalls(w) {
    if (!(this.snapStep > 0)) return w;
    const r = (v) => Math.round(v / this.snapStep) * this.snapStep;
    for (const l of w.lines) {
      if (Math.abs(l.d.y) < 1e-6) w.point.y = r(w.point.y);
      else if (Math.abs(l.d.x) < 1e-6) w.point.x = r(w.point.x);
    }
    return w;
  }

  underlayBounds() {
    const u = this.store.underlay;
    return u?.visible ? G.bbox(underlayCorners(u)) : null;
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.width = Math.max(1, Math.floor(rect.width));
    this.height = Math.max(1, Math.floor(rect.height));
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.render();
  }

  fit() {
    const plan = this.store.plan;
    let ext = planExtent(plan);
    const ub = this.underlayBounds();
    if (ub) ext = ext ? G.bbox([{ x: ext.minX, y: ext.minY }, { x: ext.maxX, y: ext.maxY }, { x: ub.minX, y: ub.minY }, { x: ub.maxX, y: ub.maxY }]) : ub;
    if (!ext) { this.view = { x: 90, y: 80, zoom: 60 }; this.render(); this.cb.onZoom?.(this.view.zoom); return; }
    const m = plan.settings.plate.margin / plan.settings.scale;
    const w = ext.width + 2 * m, h = ext.height + 2 * m;
    const zoom = Math.max(4, Math.min(3000, Math.min((this.width - 80) / w, (this.height - 80) / h)));
    this.view.zoom = zoom;
    this.view.x = (this.width - w * zoom) / 2 - (ext.minX - m) * zoom;
    this.view.y = (this.height - h * zoom) / 2 - (ext.minY - m) * zoom;
    this.render();
    this.cb.onZoom?.(zoom);
  }

  zoomAt(factor, sx = this.width / 2, sy = this.height / 2) {
    const before = this.toPlan(sx, sy);
    this.view.zoom = Math.max(4, Math.min(3000, this.view.zoom * factor));
    const after = this.toScreen(before);
    this.view.x += sx - after.x;
    this.view.y += sy - after.y;
    this.render();
    this.cb.onZoom?.(this.view.zoom);
  }

  setSnap(step) { this.snapStep = step; }

  /* ---------- Ereignisse ---------- */
  bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', (e) => this.onUp(e));
    c.addEventListener('pointerleave', () => { if (!this.drag) { this.pointer = null; this.hover = null; this.snapGuide = null; this.render(); } });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016));
      this.zoomAt(f, e.offsetX, e.offsetY);
    }, { passive: false });
    c.addEventListener('dblclick', (e) => {
      if (this.draw?.type === 'poly') { this.finishPolygon(); e.preventDefault(); }
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  localPos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  onDown(e) {
    this.canvas.focus({ preventScroll: true });
    const s = this.localPos(e);
    this.pointers.set(e.pointerId, s);
    if (this.pointers.size === 2) {
      // Pinch-Zoom beginnt, laufende Interaktion verwerfen
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: G.dist(a, b), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      this.drag = null;
      return;
    }
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.toPlan(s.x, s.y);
    const tool = this.store.tool;

    if (e.button === 1 || this.spaceDown || tool === 'pan' || e.button === 2) {
      this.drag = { type: 'pan', start: s, view: { ...this.view } };
      this.updateCursor();
      return;
    }
    if (e.button !== 0) return;

    if (tool === 'select') return this.downSelect(e, s, p);
    if (tool === 'underlay') {
      const u = this.store.underlay;
      if (u) { this.drag = { type: 'underlay', start: s, orig: { x: u.x, y: u.y } }; this.updateCursor(); }
      return;
    }
    if (tool === 'measure') {
      this.drag = { type: 'measureclick', start: s };
      return;
    }
    if (tool === 'rect' || tool === 'zone' || tool === 'pillar') {
      const sp = this.snap(p);
      this.draw = { type: 'rect', etype: tool === 'rect' ? 'room' : tool, start: sp, cur: sp, moved: false };
      return;
    }
    if (tool === 'poly' || tool === 'zonepoly') {
      this.drag = { type: 'polyclick', start: s };
      return;
    }
    if (tool === 'door') {
      const t = this.doorTarget(s);
      if (t) this.addDoor(t);
      return;
    }
    if (tool === 'label') {
      const sp = this.snap(p, { vertices: false });
      this.store.update(plan => plan.labels.push(makeLabel(sp.x, sp.y, 'Text', '')));
      const lab = this.store.plan.labels[this.store.plan.labels.length - 1];
      this.store.select({ type: 'label', id: lab.id });
      this.store.setTool('select');
      this.cb.onCreated?.('label');
    }
    if (tool === 'marker') {
      const sp = this.snap(p, { vertices: false });
      const mk = makeMarker(sp.x, sp.y, this.store.markerKind);
      this.store.update(plan => plan.markers.push(mk));
      this.store.select({ type: 'marker', id: mk.id });
      this.store.setTool('select');
      this.cb.onCreated?.('marker');
    }
  }

  downSelect(e, s, p) {
    const hit = this.hitTest(s, p);
    const st = this.store;
    if (e.altKey && hit?.type === 'edge') {
      this.insertVertex(hit.id, hit.edge, this.snap(p, { excludeRoom: hit.id }));
      return;
    }
    if (!hit) {
      if (st.selection) st.select(null);
      this.drag = { type: 'pan', start: s, view: { ...this.view }, maybe: true };
      this.updateCursor();
      return;
    }
    const snapshot = st.snapshot();
    switch (hit.type) {
      case 'vertex': {
        if (!(st.selection?.type === 'vertex' && st.selection.index === hit.index && st.selection.roomId === hit.roomId)) st.select({ type: 'vertex', roomId: hit.roomId, index: hit.index });
        this.drag = { type: 'vertex', roomId: hit.roomId, index: hit.index, snapshot, moved: false };
        break;
      }
      case 'door': {
        st.select({ type: 'door', roomId: hit.roomId, id: hit.id });
        this.drag = { type: 'door', roomId: hit.roomId, id: hit.id, snapshot, moved: false };
        break;
      }
      case 'roomlabel': {
        const room = st.room(hit.roomId);
        if (st.selection?.id !== hit.roomId) st.select({ type: 'room', id: hit.roomId });
        this.drag = { type: 'roomlabel', roomId: hit.roomId, snapshot, moved: false, offset: { x: room.label.x - p.x, y: room.label.y - p.y } };
        break;
      }
      case 'label': {
        const lab = st.label(hit.id);
        st.select({ type: 'label', id: hit.id });
        this.drag = { type: 'label', id: hit.id, snapshot, moved: false, offset: { x: lab.x - p.x, y: lab.y - p.y } };
        break;
      }
      case 'marker': {
        const mk = st.marker(hit.id);
        st.select({ type: 'marker', id: hit.id });
        this.drag = { type: 'marker', id: hit.id, snapshot, moved: false, offset: { x: mk.x - p.x, y: mk.y - p.y } };
        break;
      }
      case 'edge':
      case 'room': {
        const room = st.room(hit.id);
        if (!(st.selection?.type === 'room' && st.selection.id === hit.id)) st.select({ type: 'room', id: hit.id });
        this.drag = { type: 'room', id: hit.id, snapshot, moved: false, start: p, orig: room.points.map(q => ({ ...q })), origLabel: { ...room.label } };
        break;
      }
    }
    this.updateCursor();
  }

  onMove(e) {
    const s = this.localPos(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, s);
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = G.dist(a, b);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (this.pinch.dist > 0) this.zoomAt(d / this.pinch.dist, mid.x, mid.y);
      this.view.x += mid.x - this.pinch.mid.x;
      this.view.y += mid.y - this.pinch.mid.y;
      this.pinch = { dist: d, mid };
      this.render();
      return;
    }
    const p = this.toPlan(s.x, s.y);
    this.pointer = p;
    this.pointerScreen = s;
    this.cb.onCursor?.(p);

    if (this.drag) { this.dragMove(e, s, p); return; }

    this.snapGuide = null;
    if (this.draw?.type === 'rect') { this.draw.cur = this.snap(p); this.draw.moved = true; this.render(); return; }
    if (this.draw?.type === 'poly') { this.draw.cur = this.snap(p); this.render(); return; }

    const tool = this.store.tool;
    if (tool === 'measure') {
      const sp = this.snap(p);
      if (this.measure && !this.measure.b) this.measure.cur = sp;
      this.render();
      return;
    }
    if (SNAP_PREVIEW_TOOLS.has(tool) && this.store.underlay?.snap) {
      this.snap(p); // Fangpunkt schon vor dem ersten Klick zeigen
      this.render();
      return;
    }
    if (tool === 'select') {
      const h = this.hitTest(s, p);
      const changed = JSON.stringify(h) !== JSON.stringify(this.hover);
      this.hover = h;
      if (changed) { this.updateCursor(); this.render(); }
    } else if (tool === 'door') {
      this.hover = this.doorTarget(s);
      this.render();
    } else {
      this.render();
    }
  }

  dragMove(e, s, p) {
    const d = this.drag;
    const st = this.store;
    const movedPx = d.start ? G.dist(s, d.start) : 0;
    switch (d.type) {
      case 'pan': {
        if (d.maybe && movedPx < 3) return;
        d.maybe = false;
        this.view.x = d.view.x + (s.x - d.start.x);
        this.view.y = d.view.y + (s.y - d.start.y);
        this.render();
        return;
      }
      case 'polyclick': return;
      case 'measureclick': {
        const sp = this.snap(p);
        if (this.measure && !this.measure.b) this.measure.cur = sp;
        this.render();
        return;
      }
      case 'underlay': {
        const u = st.underlay;
        if (!u) return;
        u.x = d.orig.x + (s.x - d.start.x) / this.view.zoom;
        u.y = d.orig.y + (s.y - d.start.y) / this.view.zoom;
        u.version++; // Speichern und Panel erst beim Loslassen
        this.render();
        return;
      }
      case 'vertex': {
        const room = st.room(d.roomId);
        const np = this.snap(p, { excludeRoom: room.id });
        if (room.kind === 'rect') {
          const pts = room.points;
          const old = pts[d.index];
          const prev = pts[(d.index + 3) % 4], next = pts[(d.index + 1) % 4];
          const test = pts.map(q => ({ ...q }));
          if (Math.abs(prev.x - old.x) < 1e-9) { test[(d.index + 3) % 4].x = np.x; test[(d.index + 1) % 4].y = np.y; }
          else { test[(d.index + 3) % 4].y = np.y; test[(d.index + 1) % 4].x = np.x; }
          test[d.index] = np;
          const bb = G.bbox(test);
          const min = room.type === 'pillar' ? 0.1 : 0.2;
          if (bb.width < min || bb.height < min) return;
          room.points = test;
        } else {
          const test = room.points.map(q => ({ ...q }));
          test[d.index] = np;
          if (G.area(test) < 0.04) return;
          room.points = test;
        }
        this.keepLabelInside(room);
        d.moved = true;
        st.touch();
        return;
      }
      case 'door': {
        const room = st.room(d.roomId);
        const door = room.doors.find(x => x.id === d.id);
        if (!door) return;
        // nächste Kante dieses Raums
        let best = null;
        for (let i = 0; i < room.points.length; i++) {
          const a = room.points[i], b = room.points[(i + 1) % room.points.length];
          const c = G.closestOnSegment(p, a, b);
          if (!best || c.dist < best.dist) best = { ...c, edge: i, L: G.dist(a, b) };
        }
        const half = Math.min(door.width / 2, best.L / 2);
        let t = best.t;
        if (best.L > 0) t = Math.max(half / best.L, Math.min(1 - half / best.L, t));
        door.edge = best.edge; door.t = t;
        d.moved = true;
        st.touch();
        return;
      }
      case 'roomlabel': {
        const room = st.room(d.roomId);
        room.label.x = p.x + d.offset.x; room.label.y = p.y + d.offset.y;
        d.moved = true; st.touch();
        return;
      }
      case 'label': {
        const lab = st.label(d.id);
        lab.x = p.x + d.offset.x; lab.y = p.y + d.offset.y;
        d.moved = true; st.touch();
        return;
      }
      case 'marker': {
        const mk = st.marker(d.id);
        const sp = this.snap({ x: p.x + d.offset.x, y: p.y + d.offset.y }, { vertices: false });
        mk.x = sp.x; mk.y = sp.y;
        d.moved = true; st.touch();
        return;
      }
      case 'room': {
        const room = st.room(d.id);
        const first = d.orig[0];
        const target = this.snap({ x: first.x + (p.x - d.start.x), y: first.y + (p.y - d.start.y) }, { excludeRoom: room.id });
        const dx = target.x - first.x, dy = target.y - first.y;
        room.points = d.orig.map(q => ({ x: q.x + dx, y: q.y + dy }));
        room.label.x = d.origLabel.x + dx; room.label.y = d.origLabel.y + dy;
        d.moved = d.moved || Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9;
        st.touch();
        return;
      }
    }
  }

  onUp(e) {
    const s = this.localPos(e);
    this.pointers.delete(e.pointerId);
    if (this.pinch) { if (this.pointers.size < 2) this.pinch = null; this.drag = null; return; }
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    const p = this.toPlan(s.x, s.y);
    const st = this.store;

    if (this.draw?.type === 'rect') {
      const d = this.draw; this.draw = null;
      const x = Math.min(d.start.x, d.cur.x), y = Math.min(d.start.y, d.cur.y);
      const w = Math.abs(d.cur.x - d.start.x), h = Math.abs(d.cur.y - d.start.y);
      const min = d.etype === 'pillar' ? 0.1 : 0.2;
      if (w >= min && h >= min) {
        const type = d.etype;
        const room = makeRoom({ type, kind: 'rect', points: rectPoints(x, y, w, h), ...this.newElementProps(type) });
        st.update(plan => plan.rooms.push(room));
        st.select({ type: 'room', id: room.id });
        this.cb.onCreated?.(type);
      } else this.render();
      return;
    }

    const d = this.drag;
    this.drag = null;
    if (!d) { this.render(); return; }

    if (d.type === 'polyclick') {
      if (G.dist(s, d.start) > 6) return; // war ein Pan-Versuch
      this.polyClick(p, s);
      return;
    }
    if (d.type === 'measureclick') { this.measureClick(p); return; }
    if (d.type === 'underlay') { st.underlayChanged(); this.updateCursor(); return; }
    if (d.type === 'pan') { this.updateCursor(); return; }
    if (d.moved && d.snapshot) {
      st.pushUndo(d.snapshot);
      st.commit();
    } else {
      st.touch();
    }
    this.updateCursor();
  }

  /* ---------- Polygon zeichnen ---------- */
  polyClick(p, s) {
    const zone = this.store.tool === 'zonepoly';
    if (!this.draw || this.draw.type !== 'poly') this.draw = { type: 'poly', etype: zone ? 'zone' : 'room', points: [], cur: null };
    const pts = this.draw.points;
    if (pts.length >= 3 && G.dist(this.toScreen(pts[0]), s) <= HIT + 2) { this.finishPolygon(); return; }
    const sp = this.snap(p);
    if (pts.length && G.dist(pts[pts.length - 1], sp) < 1e-9) return;
    pts.push(sp);
    this.cb.onHint?.(pts.length < 3 ? 'Weitere Ecken anklicken' : 'Zum Schließen auf den ersten Punkt klicken oder Enter drücken');
    this.render();
  }

  finishPolygon() {
    const d = this.draw;
    if (!d || d.type !== 'poly') return;
    this.draw = null;
    this.cb.onHint?.(null);
    const pts = G.cleanPolygon(d.points);
    if (pts.length < 3 || G.area(pts) < 0.05) { this.render(); return; }
    const st = this.store;
    const type = d.etype;
    const room = makeRoom({ type, kind: 'poly', points: pts, ...this.newElementProps(type) });
    st.update(plan => plan.rooms.push(room));
    st.select({ type: 'room', id: room.id });
    this.cb.onCreated?.(type);
  }

  /** Name und Farbe für ein neues Element dieses Typs. */
  newElementProps(type) {
    const rooms = this.store.plan.rooms;
    const n = rooms.filter(r => r.type === type).length + 1;
    if (type === 'zone') return { name: `Bereich ${n}`, color: '#8f8a86' };
    if (type === 'pillar') return { name: `Säule ${n}`, color: PILLAR_COLOR };
    return { name: `Raum ${n}`, color: ROOM_COLORS[(n - 1) % ROOM_COLORS.length] };
  }

  /* ---------- Vorlage: Strecke für den Maßstab messen ---------- */
  measureClick(p) {
    const sp = this.snap(p);
    if (!this.measure || this.measure.b) {
      this.measure = { a: sp, b: null, cur: sp };
      this.cb.onHint?.('Zweiten Punkt der Strecke anklicken');
    } else if (G.dist(this.measure.a, sp) > 1e-6) {
      this.measure.b = sp;
      this.cb.onMeasured?.(G.dist(this.measure.a, sp), this.measure.a, sp);
    }
    this.render();
  }

  clearMeasure() { this.measure = null; this.render(); }

  cancel() {
    if (this.measure) { this.measure = null; this.cb.onMeasured?.(null); if (this.store.tool === 'measure') this.store.setTool('select'); this.render(); return true; }
    if (this.store.tool === 'underlay' || this.store.tool === 'measure') { this.store.setTool('select'); return true; }
    if (this.draw) { this.draw = null; this.cb.onHint?.(null); this.render(); return true; }
    if (this.store.selection) { this.store.select(null); return true; }
    return false;
  }

  undoPolyPoint() {
    if (this.draw?.type === 'poly' && this.draw.points.length) { this.draw.points.pop(); this.render(); return true; }
    return false;
  }

  /* ---------- Türen ---------- */
  doorTarget(s) {
    const p = this.toPlan(s.x, s.y);
    let best = null;
    for (const r of this.store.plan.rooms) {
      if (r.type !== 'room') continue;
      for (let i = 0; i < r.points.length; i++) {
        const a = r.points[i], b = r.points[(i + 1) % r.points.length];
        const c = G.closestOnSegment(p, a, b);
        const dpx = G.dist(this.toScreen(c.point), s);
        if (dpx <= 14 && (!best || dpx < best.dpx)) best = { dpx, roomId: r.id, edge: i, t: c.t, point: c.point, L: G.dist(a, b) };
      }
    }
    if (!best) return null;
    const width = Math.min(this.store.plan.settings.door.width, best.L);
    const half = width / 2;
    best.t = best.L > 0 ? Math.max(half / best.L, Math.min(1 - half / best.L, best.t)) : 0.5;
    best.width = width;
    return best;
  }

  addDoor(t) {
    const st = this.store;
    const door = { id: uid('d'), edge: t.edge, t: t.t, width: t.width, threshold: st.plan.settings.door.threshold };
    st.update(plan => plan.rooms.find(r => r.id === t.roomId).doors.push(door));
    st.select({ type: 'door', roomId: t.roomId, id: door.id });
    this.cb.onCreated?.('door');
  }

  /* ---------- Bearbeitungen ---------- */
  insertVertex(roomId, edge, point) {
    const st = this.store;
    st.update(plan => {
      const room = plan.rooms.find(r => r.id === roomId);
      const n = room.points.length;
      const a = room.points[edge], b = room.points[(edge + 1) % n];
      const L = G.dist(a, b);
      const dAlong = G.dist(a, point);
      room.points.splice(edge + 1, 0, { x: point.x, y: point.y });
      room.kind = 'poly';
      for (const d of room.doors) {
        if (d.edge > edge) d.edge += 1;
        else if (d.edge === edge && L > 0) {
          const sPos = d.t * L;
          if (sPos < dAlong) d.t = dAlong > 0 ? sPos / dAlong : 0.5;
          else { d.edge = edge + 1; d.t = (L - dAlong) > 0 ? (sPos - dAlong) / (L - dAlong) : 0.5; }
        }
      }
    });
    st.select({ type: 'vertex', roomId, index: edge + 1 });
  }

  deleteSelection() {
    const st = this.store;
    const sel = st.selection;
    if (!sel) return false;
    if (sel.type === 'room') {
      st.update(plan => { plan.rooms = plan.rooms.filter(r => r.id !== sel.id); });
      st.select(null);
      return true;
    }
    if (sel.type === 'label') {
      st.update(plan => { plan.labels = plan.labels.filter(l => l.id !== sel.id); });
      st.select(null);
      return true;
    }
    if (sel.type === 'marker') {
      st.update(plan => { plan.markers = plan.markers.filter(m => m.id !== sel.id); });
      st.select(null);
      return true;
    }
    if (sel.type === 'door') {
      st.update(plan => { const r = plan.rooms.find(x => x.id === sel.roomId); if (r) r.doors = r.doors.filter(d => d.id !== sel.id); });
      st.select({ type: 'room', id: sel.roomId });
      return true;
    }
    if (sel.type === 'vertex') {
      const room = st.room(sel.roomId);
      if (!room || room.kind === 'rect' || room.points.length <= 3) { this.cb.toast?.('Ein Polygon braucht mindestens drei Ecken. Rechtecke lassen sich über die Ecken verformen.', 'warn'); return false; }
      st.update(plan => {
        const r = plan.rooms.find(x => x.id === sel.roomId);
        const n = r.points.length;
        const k = sel.index;
        const prevEdge = (k - 1 + n) % n;
        r.points.splice(k, 1);
        r.doors = r.doors.filter(d => d.edge !== k && d.edge !== prevEdge).map(d => ({ ...d, edge: d.edge > k ? d.edge - 1 : d.edge }));
      });
      st.select({ type: 'room', id: sel.roomId });
      return true;
    }
    return false;
  }

  /** Raum um seine Mitte drehen (deg, gegen den Uhrzeigersinn auf dem Bildschirm) oder spiegeln. */
  transformRoom(roomId, kind, value = 0) {
    const st = this.store;
    const room = st.room(roomId);
    if (!room) return;
    const b = G.bbox(room.points);
    const c = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    let fn;
    if (kind === 'rotate') {
      const a = -value * Math.PI / 180; // Bildschirm: y nach unten
      const cos = Math.cos(a), sin = Math.sin(a);
      fn = (p) => ({ x: c.x + (p.x - c.x) * cos - (p.y - c.y) * sin, y: c.y + (p.x - c.x) * sin + (p.y - c.y) * cos });
    } else if (kind === 'flipH') fn = (p) => ({ x: 2 * c.x - p.x, y: p.y });
    else fn = (p) => ({ x: p.x, y: 2 * c.y - p.y });
    st.update(() => {
      room.points = room.points.map(fn);
      const lp = fn(room.label);
      room.label.x = lp.x; room.label.y = lp.y;
      const rightAngle = kind !== 'rotate' || Math.abs(((value % 90) + 90) % 90) < 1e-9;
      if (room.kind === 'rect' && !rightAngle) room.kind = 'poly';
      if (this.snapStep > 0) {
        const nb = G.bbox(room.points);
        const sx = Math.round(nb.minX / this.snapStep) * this.snapStep - nb.minX;
        const sy = Math.round(nb.minY / this.snapStep) * this.snapStep - nb.minY;
        room.points = room.points.map(p => ({ x: p.x + sx, y: p.y + sy }));
        room.label.x += sx; room.label.y += sy;
      }
      room.points = room.points.map(p => ({ x: Math.round(p.x * 1e6) / 1e6, y: Math.round(p.y * 1e6) / 1e6 }));
      room.label.x = Math.round(room.label.x * 1e6) / 1e6; room.label.y = Math.round(room.label.y * 1e6) / 1e6;
    });
  }

  keepLabelInside(room) {
    if (!G.pointInPolygon(room.label, room.points)) {
      const lp = G.labelPoint(room.points);
      room.label.x = lp.x; room.label.y = lp.y;
    }
  }

  /* ---------- Treffer ---------- */
  hitTest(s, p) {
    const st = this.store;
    const plan = st.plan;
    const sel = st.selection;
    const selRoomId = sel?.type === 'room' ? sel.id : (sel?.type === 'vertex' || sel?.type === 'door') ? sel.roomId : null;
    const selRoom = selRoomId ? st.room(selRoomId) : null;

    if (selRoom) {
      for (let i = 0; i < selRoom.points.length; i++) {
        if (G.dist(this.toScreen(selRoom.points[i]), s) <= HIT) return { type: 'vertex', roomId: selRoom.id, index: i };
      }
      for (const d of selRoom.doors) {
        const seg = doorSegment(selRoom.points, d);
        const c = G.closestOnSegment(p, seg.a, seg.b);
        if (G.dist(this.toScreen(c.point), s) <= HIT) return { type: 'door', roomId: selRoom.id, id: d.id };
      }
    }
    // Marker liegen obenauf
    for (let i = plan.markers.length - 1; i >= 0; i--) {
      const mk = plan.markers[i];
      if (this.markerHit(mk, s, plan.settings)) return { type: 'marker', id: mk.id };
    }
    // Beschriftungen
    const labelHit = (x, y, el) => {
      const lay = layoutLabel(el, plan.settings);
      if (!lay) return false;
      const sc = this.toScreen({ x, y });
      const w = Math.max(24, lay.width * this.pxPerMm()), h = Math.max(16, lay.height * this.pxPerMm());
      return Math.abs(s.x - sc.x) <= w / 2 && Math.abs(s.y - sc.y) <= h / 2;
    };
    for (let i = plan.labels.length - 1; i >= 0; i--) {
      const l = plan.labels[i];
      if (labelHit(l.x, l.y, l)) return { type: 'label', id: l.id };
    }
    for (let i = plan.rooms.length - 1; i >= 0; i--) {
      const r = plan.rooms[i];
      if (r.label.visible !== false && labelHit(r.label.x, r.label.y, r)) return { type: 'roomlabel', roomId: r.id };
    }
    // Türen aller Räume
    for (let i = plan.rooms.length - 1; i >= 0; i--) {
      const r = plan.rooms[i];
      for (const d of r.doors) {
        const seg = doorSegment(r.points, d);
        const c = G.closestOnSegment(p, seg.a, seg.b);
        if (G.dist(this.toScreen(c.point), s) <= HIT) return { type: 'door', roomId: r.id, id: d.id };
      }
    }
    // Kanten (für Alt+Klick und Treffer außerhalb)
    for (const pass of ['pillar', 'zone', 'room']) {
      for (let i = plan.rooms.length - 1; i >= 0; i--) {
        const r = plan.rooms[i];
        if (r.type !== pass) continue;
        for (let k = 0; k < r.points.length; k++) {
          const a = r.points[k], b = r.points[(k + 1) % r.points.length];
          const c = G.closestOnSegment(p, a, b);
          if (G.dist(this.toScreen(c.point), s) <= 6) return { type: 'edge', id: r.id, edge: k };
        }
      }
    }
    for (const pass of ['pillar', 'zone', 'room']) {
      // bei verschachtelten Räumen gewinnt der kleinere (innere)
      let best = null, bestArea = Infinity;
      for (const r of plan.rooms) {
        if (r.type !== pass || !G.pointInPolygon(p, r.points)) continue;
        const a = G.area(r.points);
        if (a < bestArea - 1e-9 || (Math.abs(a - bestArea) <= 1e-9)) { best = r; bestArea = a; }
      }
      if (best) return { type: 'room', id: best.id };
    }
    return null;
  }

  markerScreen(mk, s) {
    const k = this.pxPerMm();
    const c = this.toScreen(mk);
    return markerOutline(mk, s).map(q => ({ x: c.x + q.x * k, y: c.y - q.y * k }));
  }

  markerHit(mk, sp, s) {
    const pts = this.markerScreen(mk, s);
    if (G.pointInPolygon(sp, pts)) return true;
    return G.dist(this.toScreen(mk), sp) <= HIT;
  }

  updateCursor() {
    const tool = this.store.tool;
    let cur = 'default';
    if ((this.drag?.type === 'pan' && !this.drag.maybe) || this.drag?.type === 'underlay') cur = 'grabbing';
    else if (tool === 'pan' || this.spaceDown) cur = 'grab';
    else if (tool === 'underlay') cur = this.store.underlay ? 'move' : 'not-allowed';
    else if (tool === 'measure') cur = 'crosshair';
    else if (tool === 'rect' || tool === 'poly' || tool === 'zone' || tool === 'zonepoly' || tool === 'pillar' || tool === 'label' || tool === 'marker' || tool === 'door') cur = 'crosshair';
    else if (this.drag) cur = this.drag.type === 'vertex' ? 'crosshair' : 'move';
    else if (this.hover) {
      cur = this.hover.type === 'vertex' ? 'crosshair' : (this.hover.type === 'edge' ? 'pointer' : 'move');
    }
    this.canvas.style.cursor = cur;
  }

  setSpace(down) { this.spaceDown = down; this.updateCursor(); }

  /* ---------- Rendern ---------- */
  render() {
    if (this.needsRender) return;
    this.needsRender = true;
    requestAnimationFrame(() => { this.needsRender = false; this.paint(); });
  }

  paint() {
    const ctx = this.ctx;
    const plan = this.store.plan;
    const s = plan.settings;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';

    this.drawGrid(ctx);
    this.drawPlate(ctx, plan);
    this.drawUnderlay(ctx);

    const sel = this.store.selection;
    const selRoomId = sel?.type === 'room' ? sel.id : (sel?.type === 'vertex' || sel?.type === 'door') ? sel.roomId : null;

    for (const r of plan.rooms) if (r.type === 'room') this.drawRoom(ctx, r, s);
    for (const r of plan.rooms) if (r.type === 'zone') this.drawZone(ctx, r, s);
    for (const r of plan.rooms) if (r.type === 'pillar') this.drawPillar(ctx, r, s);
    this.drawUnderlayLines(ctx);

    // Beschriftungen
    for (const r of plan.rooms) if (r.label.visible !== false) this.drawLabel(ctx, r.label.x, r.label.y, r, s, selRoomId === r.id && sel?.type === 'room', r.type === 'room' ? r : null);
    for (const l of plan.labels) this.drawLabel(ctx, l.x, l.y, l, s, sel?.type === 'label' && sel.id === l.id, null);
    for (const mk of plan.markers) this.drawMarker(ctx, mk, s, sel?.type === 'marker' && sel.id === mk.id);

    // Hover
    if (this.store.tool === 'select' && this.hover && !this.drag) {
      const h = this.hover;
      if ((h.type === 'room' || h.type === 'edge') && h.id !== selRoomId) {
        const r = this.store.room(h.id);
        if (r) { this.pathPolygon(ctx, r.points); ctx.strokeStyle = ACCENT; ctx.globalAlpha = .55; ctx.lineWidth = 2; ctx.stroke(); ctx.globalAlpha = 1; }
      }
    }

    // Auswahl
    if (selRoomId) {
      const r = this.store.room(selRoomId);
      if (r) this.drawSelection(ctx, r, sel);
    }

    this.drawDrawing(ctx, s);
    this.drawMeasure(ctx);
    this.drawSnapGuide(ctx);
  }

  /** Vorlage multiplizieren: weißes Papier lässt Raster und Platte durchscheinen, Striche dunkeln ab. */
  drawUnderlay(ctx) {
    const u = this.store.underlay;
    if (!u?.visible || !u.img) return;
    const c = this.toScreen(u);
    const k = (u.width / u.w) * this.view.zoom;
    ctx.save();
    ctx.globalAlpha = u.opacity;
    ctx.globalCompositeOperation = 'multiply';
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(c.x, c.y);
    ctx.rotate(u.rot * Math.PI / 180);
    ctx.scale(k, k);
    ctx.drawImage(u.img, -u.w / 2, -u.h / 2);
    ctx.restore();
    if (this.store.tool === 'underlay') {
      const pts = underlayCorners(u);
      this.pathPolygon(ctx, pts);
      ctx.strokeStyle = ACCENT; ctx.setLineDash([6, 4]); ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
    }
  }

  drawUnderlayLines(ctx) {
    const u = this.store.underlay;
    if (!u?.visible || !u.showLines || !u.lines.length) return;
    ctx.beginPath();
    for (const l of planLines(u)) { const a = this.toScreen(l.a), b = this.toScreen(l.b); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    ctx.strokeStyle = 'rgba(14,107,99,.55)'; ctx.lineWidth = 2; ctx.stroke();
  }

  drawSnapGuide(ctx) {
    const g = this.snapGuide;
    if (!g || !this.pointer) return;
    if (g.lines.length) {
      ctx.beginPath();
      for (const l of g.lines) { const a = this.toScreen(l.a), b = this.toScreen(l.b); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
      ctx.strokeStyle = ACCENT; ctx.lineWidth = 2; ctx.setLineDash([7, 4]); ctx.stroke(); ctx.setLineDash([]);
    }
    const q = this.toScreen(g.point);
    ctx.beginPath(); ctx.arc(q.x, q.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = ACCENT; ctx.lineWidth = 2; ctx.stroke();
  }

  drawMeasure(ctx) {
    const m = this.measure;
    if (!m) return;
    const b = m.b ?? m.cur;
    const A = this.toScreen(m.a), B = this.toScreen(b);
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y);
    ctx.strokeStyle = ACCENT; ctx.lineWidth = 2; ctx.stroke();
    for (const q of [A, B]) { ctx.beginPath(); ctx.arc(q.x, q.y, 4, 0, Math.PI * 2); ctx.fillStyle = ACCENT; ctx.fill(); }
    const L = G.dist(m.a, b);
    if (L > 1e-6) {
      const txt = `${fmtM(L)} auf der Vorlage`;
      ctx.font = '500 11px Inter, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 - 14 };
      const tw = ctx.measureText(txt).width + 10;
      ctx.fillStyle = 'rgba(255,255,255,.94)'; ctx.beginPath(); ctx.roundRect(mid.x - tw / 2, mid.y - 9, tw, 18, 4); ctx.fill();
      ctx.fillStyle = ACCENT; ctx.fillText(txt, mid.x, mid.y);
    }
  }

  pathPolygon(ctx, pts, append = false) {
    if (!append) ctx.beginPath();
    pts.forEach((p, i) => { const q = this.toScreen(p); if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y); });
    ctx.closePath();
  }

  drawGrid(ctx) {
    const z = this.view.zoom;
    const step = this.snapStep > 0 && this.snapStep * z >= 7 ? this.snapStep : (z >= 14 ? 0.5 : (z >= 7 ? 1 : (z >= 1.5 ? 5 : 10)));
    const major = step >= 1 ? step * 5 : 1;
    const x0 = Math.floor(-this.view.x / z / step) * step, x1 = (this.width - this.view.x) / z;
    const y0 = Math.floor(-this.view.y / z / step) * step, y1 = (this.height - this.view.y) / z;
    ctx.lineWidth = 1;
    const isMajor = (v) => Math.abs(v / major - Math.round(v / major)) < 1e-6;
    ctx.beginPath();
    for (let x = x0; x <= x1; x += step) { if (isMajor(x)) continue; const sx = Math.round(this.view.x + x * z) + .5; ctx.moveTo(sx, 0); ctx.lineTo(sx, this.height); }
    for (let y = y0; y <= y1; y += step) { if (isMajor(y)) continue; const sy = Math.round(this.view.y + y * z) + .5; ctx.moveTo(0, sy); ctx.lineTo(this.width, sy); }
    ctx.strokeStyle = 'rgba(28,27,24,.055)'; ctx.stroke();
    ctx.beginPath();
    for (let x = Math.floor(x0 / major) * major; x <= x1; x += major) { const sx = Math.round(this.view.x + x * z) + .5; ctx.moveTo(sx, 0); ctx.lineTo(sx, this.height); }
    for (let y = Math.floor(y0 / major) * major; y <= y1; y += major) { const sy = Math.round(this.view.y + y * z) + .5; ctx.moveTo(0, sy); ctx.lineTo(this.width, sy); }
    ctx.strokeStyle = 'rgba(28,27,24,.12)'; ctx.stroke();
    // Achsenbeschriftung
    if (major * z >= 40) {
      ctx.font = '500 10px Inter, system-ui, sans-serif'; ctx.fillStyle = 'rgba(81,76,67,.75)'; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      for (let x = Math.floor(x0 / major) * major; x <= x1; x += major) ctx.fillText(`${(+x.toFixed(2)).toString().replace('.', ',')}`, this.view.x + x * z + 3, 3);
      for (let y = Math.floor(y0 / major) * major; y <= y1; y += major) ctx.fillText(`${(+y.toFixed(2)).toString().replace('.', ',')}`, 3, this.view.y + y * z + 3);
    }
  }

  drawPlate(ctx, plan) {
    const info = plateInfo(plan);
    if (!info.ext) return;
    const s = plan.settings;
    const m = s.plate.margin / s.scale;
    const x = info.ext.minX - m, y = info.ext.minY - m, w = info.ext.width + 2 * m, h = info.ext.height + 2 * m;
    const a = this.toScreen({ x, y }), b = this.toScreen({ x: x + w, y: y + h });
    const r = Math.min((s.plate.cornerRadius / s.scale) * this.view.zoom, (b.x - a.x) / 2, (b.y - a.y) / 2);
    ctx.beginPath(); ctx.roundRect(a.x, a.y, b.x - a.x, b.y - a.y, r);
    ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.fill();
    ctx.setLineDash([6, 4]); ctx.strokeStyle = 'rgba(81,76,67,.55)'; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
    ctx.font = '500 11px Inter, system-ui, sans-serif'; ctx.fillStyle = INK2; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText(`Grundplatte ${fmtMM(info.width)} × ${fmtMM(info.height)}`, b.x - 6, a.y - 5);

    const bed = bedSize(s);
    const tooWide = info.width > bed.w + 1e-6, tooHigh = info.height > bed.h + 1e-6;
    if ((tooWide || tooHigh) && !(info.width <= bed.h + 1e-6 && info.height <= bed.w + 1e-6)) {
      const bw = (bed.w / s.scale) * this.view.zoom, bh = (bed.h / s.scale) * this.view.zoom;
      ctx.beginPath(); ctx.rect(a.x, a.y, bw, bh);
      ctx.setLineDash([3, 3]); ctx.strokeStyle = DANGER; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = DANGER; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(`Druckbett ${bed.w} × ${bed.h} mm`, a.x + 6, a.y + bh + 4);
    }
  }

  drawRoom(ctx, room, s) {
    const z = this.view.zoom;
    // Säulen (Grundplatte) und innere Räume (eigene Fläche) aussparen
    this.pathPolygon(ctx, room.points);
    for (const el of childrenOf(room, this.store.plan.rooms)) this.pathPolygon(ctx, el.points, true);
    ctx.fillStyle = room.color; ctx.globalAlpha = .26; ctx.fill('evenodd'); ctx.globalAlpha = 1;

    const t = s.wall.thickness / s.scale;
    const { pts, doors } = normalizeRoom(room.points, [...room.doors, ...foreignDoorIntervals(room, this.store.plan.rooms)], 1);
    const { runs, gaps } = wallRuns(pts, doors, t);
    ctx.fillStyle = '#2a2824';
    for (const run of runs) this.fillStrip(ctx, run);
    // Türen: Schwelle und Schwungbogen
    for (const g of gaps) {
      if (g.threshold) {
        ctx.fillStyle = '#9b958a';
        this.fillStrip(ctx, { outer: [g.a, g.b], inner: [g.ia, g.ib], closed: false });
        ctx.fillStyle = '#2a2824';
      }
      if (g.foreign) continue; // Schwungbogen nur beim Raum, dem die Tür gehört
      const a = this.toScreen(g.a), b = this.toScreen(g.b), ia = this.toScreen(g.ia);
      const w = G.dist(a, b);
      if (w > 6) {
        const ang0 = Math.atan2(b.y - a.y, b.x - a.x);
        const ang1 = Math.atan2(ia.y - a.y, ia.x - a.x);
        ctx.beginPath(); ctx.moveTo(a.x, a.y);
        let d = ang1 - ang0; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
        ctx.arc(a.x, a.y, w, ang0, ang0 + d, d < 0);
        ctx.closePath();
        ctx.strokeStyle = 'rgba(42,40,36,.5)'; ctx.lineWidth = 1; ctx.stroke();
      }
    }
  }

  fillStrip(ctx, run) {
    ctx.beginPath();
    run.outer.forEach((p, i) => { const q = this.toScreen(p); if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y); });
    if (run.closed) {
      ctx.closePath();
      for (let i = run.inner.length - 1; i >= 0; i--) { const q = this.toScreen(run.inner[i]); if (i === run.inner.length - 1) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y); }
      ctx.closePath();
      ctx.fill('evenodd');
    } else {
      for (let i = run.inner.length - 1; i >= 0; i--) { const q = this.toScreen(run.inner[i]); ctx.lineTo(q.x, q.y); }
      ctx.closePath();
      ctx.fill();
    }
  }

  hatch(color) {
    if (this.hatchCache.has(color)) return this.hatchCache.get(color);
    const c = document.createElement('canvas'); c.width = 12; c.height = 12;
    const g = c.getContext('2d');
    g.strokeStyle = color; g.globalAlpha = .55; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(-2, 14); g.lineTo(14, -2); g.moveTo(-2, 2); g.lineTo(2, -2); g.moveTo(10, 14); g.lineTo(14, 10); g.stroke();
    const pat = this.ctx.createPattern(c, 'repeat');
    this.hatchCache.set(color, pat);
    return pat;
  }

  drawZone(ctx, zone, s) {
    this.pathPolygon(ctx, zone.points);
    ctx.fillStyle = this.hatch('#514c43'); ctx.fill();
    const { pts } = normalizeRoom(zone.points, [], 1);
    const t = s.zone.thickness / s.scale;
    ctx.fillStyle = '#3a3733';
    if (s.zone.dashed) {
      for (const run of dashedRuns(pts, t, s.zone.dash / s.scale, s.zone.gap / s.scale)) this.fillStrip(ctx, run);
    } else {
      this.fillStrip(ctx, { outer: pts, inner: G.insetPolygon(pts, t), closed: true });
    }
  }

  /** Säule: Wand außen herum (im Raum), innen Grundplatte oder – gefüllt – erhabener Block. */
  drawPillar(ctx, pillar, s) {
    const { pts } = normalizeRoom(pillar.points, [], 1);
    const t = s.wall.thickness / s.scale;
    ctx.fillStyle = '#2a2824';
    this.fillStrip(ctx, { outer: G.insetPolygon(pts, -t), inner: pts, closed: true });
    if (pillar.filled) { this.pathPolygon(ctx, pts); ctx.fill(); }
  }

  drawLabel(ctx, x, y, el, s, selected, room) {
    const lay = layoutLabel(el, s);
    if (!lay) return;
    const k = this.pxPerMm();
    const c = this.toScreen({ x, y });
    const w = lay.width * k, h = lay.height * k;
    const fits = room ? this.labelFits(room, x, y, lay, s) : true;

    // Rahmen
    ctx.beginPath(); ctx.roundRect(c.x - w / 2 - 3, c.y - h / 2 - 3, w + 6, h + 6, 4);
    if (selected) { ctx.strokeStyle = ACCENT; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]); }
    else if (!fits) { ctx.strokeStyle = DANGER; ctx.setLineDash([3, 3]); ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]); }

    if (k >= 0.9) {
      // zentriert zeichnen: Inter ist nicht so breit wie die gemessene 3D-Schrift
      ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      for (const ti of lay.textItems) {
        ctx.font = `700 ${(ti.size * k).toFixed(1)}px Inter, system-ui, sans-serif`;
        ctx.fillText(ti.text, c.x + (ti.x + ti.width / 2) * k, c.y - ti.baseline * k);
      }
      const r = Math.max(1, (s.braille.dotDiameter / 2) * k);
      ctx.beginPath();
      for (const d of lay.dots) { ctx.moveTo(c.x + d.x * k + r, c.y - d.y * k); ctx.arc(c.x + d.x * k, c.y - d.y * k, r, 0, Math.PI * 2); }
      ctx.fillStyle = INK; ctx.fill();
    } else {
      ctx.beginPath(); ctx.roundRect(c.x - w / 2, c.y - h / 2, Math.max(w, 2), Math.max(h, 2), 2);
      ctx.fillStyle = 'rgba(28,27,24,.35)'; ctx.fill();
      ctx.font = '500 11px Inter, system-ui, sans-serif'; ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(lay.text.split('\n')[0], c.x, c.y - h / 2 - 2);
    }
  }

  drawMarker(ctx, mk, s, selected) {
    const pts = this.markerScreen(mk, s);
    ctx.beginPath();
    pts.forEach((q, i) => { if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y); });
    ctx.closePath();
    ctx.fillStyle = INK; ctx.fill();
    if (selected) {
      const c = this.toScreen(mk);
      const r = Math.max(...pts.map(q => G.dist(q, c))) + 5;
      ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = ACCENT; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]);
    }
  }

  labelFits(room, x, y, lay, s) {
    const hw = lay.width / 2 / s.scale, hh = lay.height / 2 / s.scale;
    const inset = s.wall.thickness / s.scale + 0.5 / s.scale;
    const { pts } = normalizeRoom(room.points, [], 1);
    const inner = G.insetPolygon(pts, inset);
    const corners = [{ x: x - hw, y: y - hh }, { x: x + hw, y: y - hh }, { x: x + hw, y: y + hh }, { x: x - hw, y: y + hh }];
    return corners.every(c => G.pointInPolygon(c, inner));
  }

  drawSelection(ctx, room, sel) {
    const z = this.view.zoom;
    this.pathPolygon(ctx, room.points);
    ctx.strokeStyle = ACCENT; ctx.lineWidth = 2; ctx.stroke();

    // Maße an den Kanten
    ctx.font = '500 11px Inter, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const { pts } = normalizeRoom(room.points, [], 1);
    const c = G.centroid(room.points);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const L = G.dist(a, b);
      if (L * z < 36) continue;
      const mid = G.lerp(a, b, .5);
      const out = G.mul(G.left(G.norm(G.sub(b, a))), -1); // nach außen
      const sm = this.toScreen(mid);
      const pos = { x: sm.x + out.x * 14, y: sm.y + out.y * 14 };
      const txt = fmtM(L);
      const tw = ctx.measureText(txt).width + 8;
      ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.beginPath(); ctx.roundRect(pos.x - tw / 2, pos.y - 8, tw, 16, 3); ctx.fill();
      ctx.fillStyle = INK2; ctx.fillText(txt, pos.x, pos.y);
    }

    // Türgriffe
    for (const d of room.doors) {
      const seg = doorSegment(room.points, d);
      const sc = this.toScreen(seg.center);
      const active = sel?.type === 'door' && sel.id === d.id;
      ctx.beginPath(); ctx.arc(sc.x, sc.y, active ? 7 : 5.5, 0, Math.PI * 2);
      ctx.fillStyle = active ? ACCENT : '#fff'; ctx.fill();
      ctx.strokeStyle = ACCENT; ctx.lineWidth = 1.5; ctx.stroke();
    }
    // Eckgriffe
    room.points.forEach((p, i) => {
      const q = this.toScreen(p);
      const active = sel?.type === 'vertex' && sel.index === i;
      const hs = active ? HANDLE + 1.5 : HANDLE;
      ctx.beginPath(); ctx.rect(q.x - hs, q.y - hs, hs * 2, hs * 2);
      ctx.fillStyle = active ? ACCENT : '#fff'; ctx.fill();
      ctx.strokeStyle = ACCENT; ctx.lineWidth = 1.5; ctx.stroke();
    });
  }

  drawDrawing(ctx, s) {
    const d = this.draw;
    if (d?.type === 'rect' && d.moved) {
      const a = this.toScreen(d.start), b = this.toScreen(d.cur);
      ctx.beginPath(); ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.fillStyle = 'rgba(14,107,99,.12)'; ctx.fill();
      ctx.strokeStyle = ACCENT; ctx.setLineDash([5, 3]); ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
      const w = Math.abs(d.cur.x - d.start.x), h = Math.abs(d.cur.y - d.start.y);
      ctx.font = '500 11px Inter, system-ui, sans-serif'; ctx.fillStyle = ACCENT; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText(`${fmtM(w)} × ${fmtM(h)}`, Math.min(a.x, b.x) + 4, Math.min(a.y, b.y) - 4);
    }
    if (d?.type === 'poly') {
      const pts = d.points;
      ctx.beginPath();
      pts.forEach((p, i) => { const q = this.toScreen(p); if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y); });
      if (d.cur && pts.length) { const q = this.toScreen(d.cur); ctx.lineTo(q.x, q.y); }
      ctx.strokeStyle = ACCENT; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
      if (pts.length >= 3) { ctx.closePath(); ctx.fillStyle = 'rgba(14,107,99,.10)'; ctx.fill(); }
      pts.forEach((p, i) => {
        const q = this.toScreen(p);
        ctx.beginPath(); ctx.arc(q.x, q.y, i === 0 ? 6 : 4, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? ACCENT : '#fff'; ctx.fill(); ctx.strokeStyle = ACCENT; ctx.lineWidth = 1.5; ctx.stroke();
      });
      if (d.cur && pts.length) {
        const last = pts[pts.length - 1];
        const L = G.dist(last, d.cur);
        const q = this.toScreen(d.cur);
        ctx.font = '500 11px Inter, system-ui, sans-serif'; ctx.fillStyle = ACCENT; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        ctx.fillText(fmtM(L), q.x + 10, q.y - 6);
      }
    }
    if (this.store.tool === 'door' && this.hover?.roomId && !this.drag) {
      const h = this.hover;
      const room = this.store.room(h.roomId);
      if (room) {
        const seg = doorSegment(room.points, { edge: h.edge, t: h.t, width: h.width });
        const a = this.toScreen(seg.a), b = this.toScreen(seg.b);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = ACCENT; ctx.lineWidth = Math.max(4, (s.wall.thickness / s.scale) * this.view.zoom * 1.2); ctx.lineCap = 'butt'; ctx.stroke(); ctx.lineCap = 'round';
      }
    }
  }
}
