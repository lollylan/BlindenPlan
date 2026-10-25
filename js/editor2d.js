// 2D-Editor: Zeichenfläche für Räume, Bereiche, Türen und Beschriftungen (Einheit: Meter).
import * as G from './geom.js';
import { normalizeRoom, wallRuns, dashedRuns, doorSegment } from './walls.js';
import { layoutLabel } from './labels.js';
import { makeRoom, makeLabel, rectPoints, ROOM_COLORS, plateInfo, bedSize, planExtent, uid } from './state.js';

const HIT = 9;        // Trefferradius in px
const HANDLE = 5;     // halbe Griffgröße in px
const INK = '#1c1b18';
const INK2 = '#514c43';
const ACCENT = '#0e6b63';
const DANGER = '#b4281e';

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
      q = { x: Math.round(p.x / this.snapStep) * this.snapStep, y: Math.round(p.y / this.snapStep) * this.snapStep };
    }
    if (opts.vertices !== false) {
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
      if (best) q = { x: best.v.x, y: best.v.y };
    }
    return q;
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
    const ext = planExtent(plan);
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
    c.addEventListener('pointerleave', () => { if (!this.drag) { this.pointer = null; this.hover = null; this.render(); } });
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
    if (tool === 'rect' || tool === 'zone') {
      const sp = this.snap(p);
      this.draw = { type: 'rect', zone: tool === 'zone', start: sp, cur: sp, moved: false };
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

    if (this.draw?.type === 'rect') { this.draw.cur = this.snap(p); this.draw.moved = true; this.render(); return; }
    if (this.draw?.type === 'poly') { this.draw.cur = this.snap(p); this.render(); return; }

    const tool = this.store.tool;
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
          if (bb.width < 0.2 || bb.height < 0.2) return;
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
      if (w >= 0.2 && h >= 0.2) {
        const type = d.zone ? 'zone' : 'room';
        const color = d.zone ? '#8f8a86' : ROOM_COLORS[st.plan.rooms.filter(r => r.type === 'room').length % ROOM_COLORS.length];
        const room = makeRoom({ type, kind: 'rect', points: rectPoints(x, y, w, h), name: d.zone ? `Bereich ${st.plan.rooms.filter(r => r.type === 'zone').length + 1}` : `Raum ${st.plan.rooms.filter(r => r.type === 'room').length + 1}`, color });
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
    if (!this.draw || this.draw.type !== 'poly') this.draw = { type: 'poly', zone, points: [], cur: null };
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
    const type = d.zone ? 'zone' : 'room';
    const color = d.zone ? '#8f8a86' : ROOM_COLORS[st.plan.rooms.filter(r => r.type === 'room').length % ROOM_COLORS.length];
    const room = makeRoom({ type, kind: 'poly', points: pts, name: d.zone ? `Bereich ${st.plan.rooms.filter(r => r.type === 'zone').length + 1}` : `Raum ${st.plan.rooms.filter(r => r.type === 'room').length + 1}`, color });
    st.update(plan => plan.rooms.push(room));
    st.select({ type: 'room', id: room.id });
    this.cb.onCreated?.(type);
  }

  cancel() {
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
    for (const pass of ['zone', 'room']) {
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
    for (const pass of ['zone', 'room']) {
      for (let i = plan.rooms.length - 1; i >= 0; i--) {
        const r = plan.rooms[i];
        if (r.type === pass && G.pointInPolygon(p, r.points)) return { type: 'room', id: r.id };
      }
    }
    return null;
  }

  updateCursor() {
    const tool = this.store.tool;
    let cur = 'default';
    if (this.drag?.type === 'pan' && !this.drag.maybe) cur = 'grabbing';
    else if (tool === 'pan' || this.spaceDown) cur = 'grab';
    else if (tool === 'rect' || tool === 'poly' || tool === 'zone' || tool === 'zonepoly' || tool === 'label' || tool === 'door') cur = 'crosshair';
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

    const sel = this.store.selection;
    const selRoomId = sel?.type === 'room' ? sel.id : (sel?.type === 'vertex' || sel?.type === 'door') ? sel.roomId : null;

    for (const r of plan.rooms) if (r.type === 'room') this.drawRoom(ctx, r, s);
    for (const r of plan.rooms) if (r.type === 'zone') this.drawZone(ctx, r, s);

    // Beschriftungen
    for (const r of plan.rooms) if (r.label.visible !== false) this.drawLabel(ctx, r.label.x, r.label.y, r, s, selRoomId === r.id && sel?.type === 'room', r.type === 'room' ? r : null);
    for (const l of plan.labels) this.drawLabel(ctx, l.x, l.y, l, s, sel?.type === 'label' && sel.id === l.id, null);

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
  }

  pathPolygon(ctx, pts) {
    ctx.beginPath();
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
    this.pathPolygon(ctx, room.points);
    ctx.fillStyle = room.color; ctx.globalAlpha = .26; ctx.fill(); ctx.globalAlpha = 1;

    const t = s.wall.thickness / s.scale;
    const { pts, doors } = normalizeRoom(room.points, room.doors, 1);
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
      ctx.fillStyle = INK; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      for (const ti of lay.textItems) {
        ctx.font = `700 ${(ti.size * k).toFixed(1)}px Inter, system-ui, sans-serif`;
        ctx.fillText(ti.text, c.x + ti.x * k, c.y - ti.baseline * k);
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
