// Zustand: Plan-Datenmodell, Verlauf (Undo/Redo), Speicherung, Beispielplan.
import { labelPoint, bbox } from './geom.js';
import { layoutLabel } from './labels.js';
import { MARKER_KINDS, markerRadius } from './markers.js';

export const PLAN_VERSION = 1;
const STORAGE_KEY = 'blindenplan.plan.v1';

export const ROOM_COLORS = ['#e9a23b', '#4f86c6', '#67a364', '#d9605c', '#7fb7b2', '#c9b23a', '#a07ab0', '#e58fa0', '#9b7b5f', '#8f8a86'];

export const BEDS = [
  { id: 'a1mini', name: 'Bambu Lab A1 mini', w: 180, h: 180 },
  { id: 'p1x1a1', name: 'Bambu Lab P1 / X1 / A1', w: 256, h: 256 },
  { id: 'h2d', name: 'Bambu Lab H2D', w: 350, h: 320 },
  { id: 'custom', name: 'Eigenes Druckbett', w: 220, h: 220 },
];

export function defaultSettings() {
  return {
    scale: 20,                 // mm pro Meter (1:50)
    bed: 'p1x1a1',
    bedW: 256, bedH: 256,
    plate: { margin: 8, thickness: 2.4, cornerRadius: 4 },
    wall: { height: 2.5, thickness: 1.6 },
    zone: { height: 0.8, thickness: 1.2, dashed: true, dash: 3, gap: 2 },
    door: { width: 0.9, threshold: true, thresholdHeight: 0.6 },
    braille: { dotDiameter: 1.5, dotHeight: 0.6, dotPitch: 2.5, cellPitch: 6.0, linePitch: 10.0, system: 'basis', capitals: false },
    text: { enabled: true, size: 5.5, height: 0.6 },
    marker: { size: 8, height: 1.2 },
    legend: { enabled: true },
    colors: { base: '#e9e4da', raised: '#1f2a44', frame: '#cbc3b4' },
    frame: { rimW: 7, backT: 4, rimOver: 0, clearance: 0.4, split: 'auto', cols: 1, rows: 1, joint: 'dovetail', keyholes: true },
  };
}

export function emptyPlan() {
  return { version: PLAN_VERSION, name: 'Neuer Plan', settings: defaultSettings(), rooms: [], labels: [], markers: [] };
}

let idCounter = 0;
export function uid(prefix = 'e') {
  idCounter = (idCounter + 1) % 100000;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export function makeRoom({ type = 'room', kind = 'rect', points, name, short = '', color }) {
  const lp = labelPoint(points);
  return {
    id: uid(type === 'room' ? 'r' : 'z'),
    type, kind, points,
    name: name ?? (type === 'room' ? 'Raum' : 'Bereich'),
    short,
    color: color ?? ROOM_COLORS[0],
    doors: [],
    label: { x: lp.x, y: lp.y, showBraille: true, showText: true, visible: true },
  };
}

export function rectPoints(x, y, w, h) {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

export function makeLabel(x, y, name = 'Text', short = '') {
  return { id: uid('l'), x, y, name, short, showBraille: true, showText: true };
}

export function makeMarker(x, y, kind = 'here') {
  const k = MARKER_KINDS.find(m => m.id === kind) ?? MARKER_KINDS[0];
  return { id: uid('m'), kind: k.id, x, y, rot: 0, name: k.name };
}

export { displayText } from './labels.js';

export function examplePlan() {
  const plan = emptyPlan();
  plan.name = 'Praxis – Beispiel';
  const R = (x, y, w, h, name, short, color, doors = []) => {
    const r = makeRoom({ type: 'room', kind: 'rect', points: rectPoints(x, y, w, h), name, short, color });
    r.doors = doors.map(d => ({ id: uid('d'), edge: d[0], t: d[1], width: d[2] ?? 0.9, threshold: d[3] ?? true }));
    return r;
  };
  const Z = (x, y, w, h, name, short) => makeRoom({ type: 'zone', kind: 'rect', points: rectPoints(x, y, w, h), name, short, color: '#8f8a86' });

  plan.rooms.push(
    R(0, 0, 7, 5, 'Empfang', '', ROOM_COLORS[0], [[2, 0.72, 1.0, false]]),
    Z(0.3, 0.3, 3.0, 2.3, 'Anmeldung', 'Anm.'),
    Z(3.5, 0.3, 3.2, 4.4, 'Wartebereich', 'Warten'),
    R(7, 0, 2, 2.5, 'WC barrierefrei', 'WC', ROOM_COLORS[4], [[3, 0.5, 0.9, true]]),
    R(7, 2.5, 2, 2.5, 'Lager', 'Lager', ROOM_COLORS[9], [[2, 0.5, 0.9, true]]),
    R(0, 5, 9, 2, 'Flur', '', ROOM_COLORS[8], [[1, 0.5, 1.1, true]]),
    R(0, 7, 3, 3, 'Sprechzimmer 1', 'Spr. 1', ROOM_COLORS[1], [[0, 0.5, 0.9, true]]),
    R(3, 7, 3, 3, 'Sprechzimmer 2', 'Spr. 2', ROOM_COLORS[2], [[0, 0.5, 0.9, true]]),
  );
  const labor = makeRoom({ type: 'room', kind: 'poly', points: [{ x: 6, y: 7 }, { x: 9, y: 7 }, { x: 9, y: 9 }, { x: 8, y: 10 }, { x: 6, y: 10 }], name: 'Labor', short: '', color: ROOM_COLORS[3] });
  labor.doors = [{ id: uid('d'), edge: 0, t: 0.5, width: 0.9, threshold: true }];
  plan.rooms.push(labor);
  plan.labels.push(makeLabel(10.6, 6.0, 'Eingang', 'Eing.'));
  const entry = makeMarker(9.5, 6.0, 'arrow');
  entry.rot = 90;
  plan.markers.push(entry, makeMarker(1.0, 6.0, 'here'));
  return plan;
}

/** Plan validieren / migrieren (für geladene Dateien). */
export function normalizePlan(raw) {
  const plan = emptyPlan();
  if (!raw || typeof raw !== 'object') return plan;
  plan.name = typeof raw.name === 'string' ? raw.name : plan.name;
  const d = plan.settings;
  const s = raw.settings || {};
  const num = (v, fb) => (typeof v === 'number' && isFinite(v) ? v : fb);
  d.scale = num(s.scale, d.scale);
  d.bed = typeof s.bed === 'string' ? s.bed : d.bed;
  d.bedW = num(s.bedW, d.bedW); d.bedH = num(s.bedH, d.bedH);
  for (const grp of ['plate', 'wall', 'zone', 'door', 'braille', 'text', 'marker', 'legend', 'colors', 'frame']) {
    if (s[grp] && typeof s[grp] === 'object') {
      for (const k of Object.keys(d[grp])) {
        const v = s[grp][k];
        if (typeof d[grp][k] === 'number') d[grp][k] = num(v, d[grp][k]);
        else if (typeof d[grp][k] === 'boolean') d[grp][k] = typeof v === 'boolean' ? v : d[grp][k];
        else if (typeof d[grp][k] === 'string') d[grp][k] = typeof v === 'string' ? v : d[grp][k];
      }
    }
  }
  const pts = (arr) => Array.isArray(arr) ? arr.filter(p => p && isFinite(p.x) && isFinite(p.y)).map(p => ({ x: +p.x, y: +p.y })) : [];
  for (const r of Array.isArray(raw.rooms) ? raw.rooms : []) {
    const points = pts(r.points);
    if (points.length < 3) continue;
    const room = makeRoom({ type: r.type === 'zone' ? 'zone' : 'room', kind: r.kind === 'poly' ? 'poly' : 'rect', points, name: String(r.name ?? ''), short: String(r.short ?? ''), color: typeof r.color === 'string' ? r.color : undefined });
    if (room.kind === 'rect' && points.length !== 4) room.kind = 'poly';
    room.id = typeof r.id === 'string' ? r.id : room.id;
    room.doors = (Array.isArray(r.doors) ? r.doors : []).filter(dr => dr && isFinite(dr.edge) && isFinite(dr.t)).map(dr => ({
      id: typeof dr.id === 'string' ? dr.id : uid('d'), edge: Math.max(0, Math.min(points.length - 1, Math.round(dr.edge))),
      t: Math.max(0, Math.min(1, +dr.t)), width: num(dr.width, 0.9), threshold: dr.threshold !== false,
    }));
    if (r.label && typeof r.label === 'object') {
      room.label.x = num(r.label.x, room.label.x); room.label.y = num(r.label.y, room.label.y);
      room.label.showBraille = r.label.showBraille !== false; room.label.showText = r.label.showText !== false;
      room.label.visible = r.label.visible !== false;
    }
    plan.rooms.push(room);
  }
  for (const l of Array.isArray(raw.labels) ? raw.labels : []) {
    if (!l || !isFinite(l.x) || !isFinite(l.y)) continue;
    const lab = makeLabel(+l.x, +l.y, String(l.name ?? l.text ?? 'Text'), String(l.short ?? ''));
    lab.id = typeof l.id === 'string' ? l.id : lab.id;
    lab.showBraille = l.showBraille !== false; lab.showText = l.showText !== false;
    plan.labels.push(lab);
  }
  for (const m of Array.isArray(raw.markers) ? raw.markers : []) {
    if (!m || !isFinite(m.x) || !isFinite(m.y)) continue;
    const mk = makeMarker(+m.x, +m.y, m.kind);
    mk.id = typeof m.id === 'string' ? m.id : mk.id;
    mk.rot = num(m.rot, 0);
    if (typeof m.name === 'string') mk.name = m.name;
    plan.markers.push(mk);
  }
  return plan;
}

/** Ausdehnung des Plans in Metern (Räume, Bereiche, Beschriftungen inkl. Blockgröße). */
export function planExtent(plan) {
  const pts = [];
  for (const r of plan.rooms) pts.push(...r.points);
  const s = plan.settings;
  const addLabel = (x, y, el) => {
    const lay = layoutLabel(el, s);
    if (!lay) return;
    const hw = lay.width / 2 / s.scale, hh = lay.height / 2 / s.scale;
    pts.push({ x: x - hw, y: y - hh }, { x: x + hw, y: y + hh });
  };
  for (const r of plan.rooms) if (r.label?.visible !== false) addLabel(r.label.x, r.label.y, r);
  for (const l of plan.labels) addLabel(l.x, l.y, l);
  for (const mk of plan.markers) {
    const r = markerRadius(mk, s) / s.scale;
    pts.push({ x: mk.x - r, y: mk.y - r }, { x: mk.x + r, y: mk.y + r });
  }
  if (!pts.length) return null;
  return bbox(pts);
}

/** Grundplatte in mm: Ursprung, Breite, Höhe sowie die Abbildung Meter→mm. */
export function plateInfo(plan) {
  const ext = planExtent(plan);
  const s = plan.settings;
  const m = s.plate.margin;
  if (!ext) return { width: 2 * m, height: 2 * m, ext: null, toMM: (p) => ({ x: p.x * s.scale + m, y: -p.y * s.scale + m }) };
  const width = ext.width * s.scale + 2 * m;
  const height = ext.height * s.scale + 2 * m;
  const toMM = (p) => ({ x: (p.x - ext.minX) * s.scale + m, y: (ext.maxY - p.y) * s.scale + m });
  return { width, height, ext, toMM };
}

export function bedSize(settings) {
  const b = BEDS.find(b => b.id === settings.bed) || BEDS[1];
  if (b.id === 'custom') return { w: settings.bedW, h: settings.bedH, name: b.name };
  return { w: b.w, h: b.h, name: b.name };
}

/* ---------- Store mit Verlauf ---------- */
export class Store {
  constructor() {
    this.plan = emptyPlan();
    this.selection = null; // {type:'room'|'door'|'label'|'marker'|'vertex', id, roomId?, index?}
    this.markerKind = 'here'; // Form, die das Marker-Werkzeug setzt
    this.tool = 'select';
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this.saveTimer = null;
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(what = 'plan') { for (const fn of this.listeners) fn(what, this); }

  snapshot() { return JSON.stringify(this.plan); }
  /** Vor einer Änderung aufrufen: legt den Ist-Zustand auf den Undo-Stapel. */
  begin() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 120) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  /** Änderung abschließen: Listener benachrichtigen und speichern. */
  commit() { this.emit('plan'); this.scheduleSave(); }
  /** Einen zuvor gesicherten Zustand als Undo-Schritt ablegen (nach einem Drag). */
  pushUndo(snapshot) {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > 120) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  /** begin + mutate + commit in einem. */
  update(fn) { this.begin(); fn(this.plan); this.commit(); }
  /** Nur neu zeichnen (z. B. während eines Drags). */
  touch() { this.emit('plan'); }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.snapshot());
    this.plan = normalizePlan(JSON.parse(this.undoStack.pop()));
    this.validateSelection();
    this.emit('plan'); this.scheduleSave();
  }
  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.snapshot());
    this.plan = normalizePlan(JSON.parse(this.redoStack.pop()));
    this.validateSelection();
    this.emit('plan'); this.scheduleSave();
  }
  validateSelection() {
    const s = this.selection;
    if (!s) return;
    if (s.type === 'room' && !this.room(s.id)) this.selection = null;
    if (s.type === 'label' && !this.plan.labels.find(l => l.id === s.id)) this.selection = null;
    if (s.type === 'marker' && !this.marker(s.id)) this.selection = null;
    if ((s.type === 'door' || s.type === 'vertex') && !this.room(s.roomId)) this.selection = null;
    if (s.type === 'door' && !this.room(s.roomId)?.doors.find(d => d.id === s.id)) this.selection = null;
  }
  setPlan(plan, { keepHistory = false } = {}) {
    if (!keepHistory) { this.undoStack.length = 0; this.redoStack.length = 0; }
    else this.begin();
    this.plan = plan;
    this.selection = null;
    this.emit('plan'); this.scheduleSave();
  }
  select(sel) { this.selection = sel; this.emit('selection'); }
  setTool(tool) { this.tool = tool; this.emit('tool'); }

  room(id) { return this.plan.rooms.find(r => r.id === id); }
  label(id) { return this.plan.labels.find(l => l.id === id); }
  marker(id) { return this.plan.markers.find(m => m.id === id); }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY, this.snapshot()); } catch { /* Speicher voll oder gesperrt */ }
    }, 400);
  }
  loadSaved() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const plan = normalizePlan(JSON.parse(raw));
      if (!plan.rooms.length && !plan.labels.length && !plan.markers.length) return false;
      this.plan = plan;
      return true;
    } catch { return false; }
  }
}
