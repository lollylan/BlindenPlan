// Oberfläche: Panels, Statusleiste, Tastatur, Datei-Aktionen, Export.
import { layoutLabel, displayText } from './labels.js';
import { ROOM_COLORS, BEDS, bedSize, plateInfo, planExtent, emptyPlan, examplePlan, normalizePlan, defaultSettings } from './state.js';
import { buildModel, legendEntries, hasTextProvider } from './model3d.js';
import { MARKER_KINDS, markerKind, markerLegendEntries } from './markers.js';
import { stlBinary, threeMF, zipFiles, download, safeName } from './exporters.js';
import { buildFrame, frameLayout } from './frame.js';
import * as G from './geom.js';
import { parentRoom } from './walls.js';
import { loadImageFile, createUnderlay, restoreUnderlay, serializeUnderlay, autoAlign, detectLines, needsRedetect, normDeg } from './underlay.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (v, d = 2) => Number(v).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt1 = (v) => fmt(v, 1);
const ICON = (name) => `<svg><use href="#${name}"/></svg>`;

const TOOL_HINTS = {
  rect: 'Raum aufziehen: Maustaste drücken, ziehen, loslassen',
  poly: 'Ecken nacheinander anklicken · Enter oder Klick auf den ersten Punkt schließt',
  zone: 'Bereich aufziehen: Maustaste drücken, ziehen, loslassen',
  zonepoly: 'Ecken des Bereichs anklicken · Enter schließt',
  pillar: 'Säule aufziehen: im Raum ziehen – die Fläche bleibt Grundplatte',
  door: 'Auf eine Wand klicken, um eine Tür zu setzen',
  label: 'Position der Beschriftung anklicken',
  marker: 'Position des Markers anklicken',
  pan: 'Ziehen verschiebt die Ansicht · Mausrad zoomt',
  measure: 'Strecke mit bekannter Länge messen: ersten Punkt anklicken',
  underlay: 'Vorlage mit der Maus verschieben · Esc beendet',
};

const NICE_DENOMS = [10, 15, 20, 25, 30, 40, 50, 60, 75, 80, 100, 125, 150, 200, 250, 300, 400, 500];

export class UI {
  constructor(store, editor, previewCtl) {
    this.store = store;
    this.editor = editor;
    this.preview = previewCtl;
    this.tab = 'selection';
    this.exportOpts = { format: '3mf', scope: 'whole', split: true, legend: true, surround: true };
    this.buildWarnings = [];
    this.editSnapshot = null;
    this.measured = null;      // gemessene Strecke auf der Vorlage {d, a, b}, wartet auf die echte Länge
    this.redetectTimer = null;
    this.panel = $('panel');
    this.bind();
  }

  /* ---------- Bindings ---------- */
  bind() {
    const st = this.store;
    const name = $('projectName');
    name.addEventListener('focus', () => { this.editSnapshot = st.snapshot(); });
    name.addEventListener('input', () => { st.plan.name = name.value; });
    name.addEventListener('change', () => { if (this.editSnapshot) { st.pushUndo(this.editSnapshot); this.editSnapshot = null; } st.commit(); });

    $('btnNew').addEventListener('click', () => {
      if ((hasContent(st.plan) || st.underlay) && !confirm('Neuen Plan beginnen? Der aktuelle Plan und die Vorlage werden verworfen (vorher ggf. als JSON speichern).')) return;
      st.setPlan(emptyPlan()); this.clearUnderlay(); this.editor.fit(); this.setTab('selection');
    });
    $('btnOpen').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try {
        const raw = JSON.parse(await file.text());
        const plan = normalizePlan(raw);
        st.setPlan(plan);
        const u = raw?.underlay ? await restoreUnderlay(raw.underlay).catch(() => null) : null;
        this.clearUnderlay(u);
        this.editor.fit();
        this.toast(`„${plan.name}“ geladen${u ? ' – mit Vorlage' : ''}.`, 'ok');
      } catch { this.toast('Die Datei konnte nicht gelesen werden. Erwartet wird eine Raumgefühl-JSON-Datei.', 'danger'); }
    });
    $('btnSave').addEventListener('click', () => this.saveJSON());
    $('btnExample').addEventListener('click', () => this.loadExample());
    $('emptyExample').addEventListener('click', () => this.loadExample());
    $('emptyRect').addEventListener('click', () => { st.setTool('rect'); $('editor').focus(); });
    $('btnUnderlay').addEventListener('click', () => $('imageInput').click());
    $('emptyUnderlay').addEventListener('click', () => $('imageInput').click());
    $('imageInput').addEventListener('change', (e) => { const f = e.target.files?.[0]; e.target.value = ''; this.importImage(f); });
    // Bild auf die Zeichenfläche ziehen oder aus der Zwischenablage einfügen
    const stage = $('stage');
    const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    stage.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; stage.classList.add('dropping'); });
    stage.addEventListener('dragleave', (e) => { if (!stage.contains(e.relatedTarget)) stage.classList.remove('dropping'); });
    stage.addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); stage.classList.remove('dropping'); this.importImage(e.dataTransfer.files[0]); });
    document.addEventListener('paste', (e) => {
      if (this.isTyping(e) || document.querySelector('dialog[open]')) return;
      const item = [...(e.clipboardData?.items ?? [])].find(it => it.kind === 'file' && it.type.startsWith('image/'));
      if (item) { e.preventDefault(); this.importImage(item.getAsFile()); }
    });
    $('btnUndo').addEventListener('click', () => st.undo());
    $('btnRedo').addEventListener('click', () => st.redo());
    $('btnHelp').addEventListener('click', () => $('helpDialog').showModal());
    $('helpClose').addEventListener('click', () => $('helpDialog').close());
    $('btnImprint').addEventListener('click', () => $('imprintDialog').showModal());
    for (const dlg of document.querySelectorAll('dialog.dialog')) {
      dlg.addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
      dlg.querySelector('[data-close]')?.addEventListener('click', () => dlg.close());
    }
    document.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => {
      b.closest('dialog')?.close();
      $(b.dataset.open).showModal();
    }));
    $('btnExport').addEventListener('click', () => this.setTab('export'));
    $('viewPlan').addEventListener('click', () => this.setView('plan'));
    $('view3d').addEventListener('click', () => this.setView('3d'));
    $('btnZoomIn').addEventListener('click', () => this.editor.zoomAt(1.25));
    $('btnZoomOut').addEventListener('click', () => this.editor.zoomAt(0.8));
    $('btnFit').addEventListener('click', () => this.editor.fit());
    $('snapSelect').addEventListener('change', (e) => this.editor.setSnap(parseFloat(e.target.value)));

    document.querySelectorAll('.rail .tool[data-tool]').forEach(b => b.addEventListener('click', () => { st.setTool(b.dataset.tool); $('editor').focus(); }));
    document.querySelectorAll('.tabs .tab').forEach(b => b.addEventListener('click', () => this.setTab(b.dataset.tab)));

    // Panel-Delegation
    this.panel.addEventListener('focusin', (e) => { if (e.target.matches('[data-path]')) this.editSnapshot = st.snapshot(); });
    this.panel.addEventListener('input', (e) => this.onFieldInput(e, false));
    this.panel.addEventListener('change', (e) => this.onFieldInput(e, true));
    this.panel.addEventListener('click', (e) => this.onPanelClick(e));
    this.panel.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'ulRealLen') { e.preventDefault(); this.applyScale(); } });

    document.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('keyup', (e) => { if (e.code === 'Space') this.editor.setSpace(false); });
    window.addEventListener('blur', () => this.editor.setSpace(false));
  }

  isTyping(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  onKey(e) {
    const st = this.store;
    const openDialog = document.querySelector('dialog[open]');
    if (openDialog) { if (e.key === 'Escape') openDialog.close(); return; }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) st.redo(); else st.undo(); return; }
    if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); st.redo(); return; }
    if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); this.saveJSON(); return; }
    if (this.isTyping(e)) {
      if (e.key === 'Escape') e.target.blur();
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur();
      return;
    }
    if (e.code === 'Space') { if (!e.repeat) this.editor.setSpace(true); e.preventDefault(); return; }
    switch (e.key) {
      case 'Escape': this.editor.cancel(); break;
      case 'Enter': this.editor.finishPolygon(); break;
      case 'Delete': this.editor.deleteSelection(); break;
      case 'Backspace': if (!this.editor.undoPolyPoint()) this.editor.deleteSelection(); break;
      case 'v': case 'V': st.setTool('select'); break;
      case 'r': case 'R': st.setTool('rect'); break;
      case 'p': case 'P': st.setTool('poly'); break;
      case 'b': case 'B': st.setTool('zone'); break;
      case 'n': case 'N': st.setTool('zonepoly'); break;
      case 's': case 'S': st.setTool('pillar'); break;
      case 't': case 'T': st.setTool('door'); break;
      case 'l': case 'L': st.setTool('label'); break;
      case 'm': case 'M': st.setTool('marker'); break;
      case 'h': case 'H': st.setTool('pan'); break;
      case '0': this.editor.fit(); break;
      case '+': case '=': this.editor.zoomAt(1.25); break;
      case '-': this.editor.zoomAt(0.8); break;
      default: return;
    }
    e.preventDefault();
  }

  /* ---------- Felder ---------- */
  resolveTarget(el) {
    const st = this.store;
    const t = el.dataset.target || 'plan';
    if (t === 'plan') return st.plan;
    if (t === 'sel') {
      const s = st.selection;
      if (!s) return null;
      if (s.type === 'room' || s.type === 'vertex' || s.type === 'door') return st.room(s.id ?? s.roomId);
      if (s.type === 'label') return st.label(s.id);
      if (s.type === 'marker') return st.marker(s.id);
      return null;
    }
    if (t === 'door') {
      const room = st.room(el.dataset.room);
      return room?.doors.find(d => d.id === el.dataset.door) ?? null;
    }
    return null;
  }

  onFieldInput(e, isChange) {
    const el = e.target;
    if (!el.matches('[data-path]')) return;
    if (el.dataset.target === 'underlay') { this.onUnderlayField(el, isChange); return; }
    const st = this.store;
    const type = el.dataset.type || 'text';
    const instant = type === 'checkbox' || type === 'select' || type === 'color';
    if (instant && !isChange) return;
    const target = this.resolveTarget(el);
    if (!target) return;
    let value;
    if (type === 'number') {
      value = parseFloat(String(el.value).replace(',', '.'));
      if (!isFinite(value)) { el.classList.add('invalid'); return; }
      if (el.min !== '' && value < parseFloat(el.min)) value = parseFloat(el.min);
      if (el.max !== '' && value > parseFloat(el.max)) value = parseFloat(el.max);
      el.classList.remove('invalid');
    } else if (type === 'checkbox') value = el.checked;
    else value = el.value;

    if (instant) {
      st.update(() => setPath(target, el.dataset.path, value));
      if (el.dataset.after) this.afterChange(el.dataset.after);
      return;
    }
    setPath(target, el.dataset.path, value);
    if (el.dataset.after) this.afterChange(el.dataset.after);
    if (isChange) {
      if (this.editSnapshot) { st.pushUndo(this.editSnapshot); this.editSnapshot = null; }
      st.commit();
    } else {
      st.touch();
    }
  }

  /** Felder der Vorlage: kein Undo, sofort übernehmen. */
  onUnderlayField(el, isChange) {
    const u = this.store.underlay;
    if (!u) return;
    const type = el.dataset.type;
    const path = el.dataset.path;
    let value;
    if (type === 'checkbox') {
      if (!isChange) return;
      value = el.checked;
    } else {
      value = parseFloat(String(el.value).replace(',', '.'));
      if (!isFinite(value)) { el.classList.add('invalid'); return; }
      if (el.min !== '' && value < parseFloat(el.min)) value = parseFloat(el.min);
      if (el.max !== '' && value > parseFloat(el.max)) value = parseFloat(el.max);
      el.classList.remove('invalid');
      if (type === 'percent') value /= 100;
    }
    u[path] = path === 'rot' ? normDeg(value) : value;
    if (path === 'rot') this.redetectSoon();
    this.store.underlayChanged();
  }

  afterChange(what) {
    const st = this.store;
    if (what === 'bed') {
      const b = BEDS.find(b => b.id === st.plan.settings.bed);
      if (b && b.id !== 'custom') { st.plan.settings.bedW = b.w; st.plan.settings.bedH = b.h; }
    }
    if (what === 'doorWidth') {
      // Türbreite geklemmt lassen
    }
  }

  onPanelClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const st = this.store;
    const a = btn.dataset.action;
    const sel = st.selection;
    switch (a) {
      case 'select': st.select({ type: 'room', id: btn.dataset.id }); break;
      case 'selectLabel': st.select({ type: 'label', id: btn.dataset.id }); break;
      case 'selectMarker': st.select({ type: 'marker', id: btn.dataset.id }); break;
      case 'markerTool': st.markerKind = btn.dataset.kind; st.setTool('marker'); $('editor').focus(); break;
      case 'markerKind': {
        const mk = st.marker(sel?.id);
        if (!mk) break;
        const from = markerKind(mk.kind), to = markerKind(btn.dataset.kind);
        st.markerKind = to.id;
        // Bedeutung mitnehmen, solange sie noch der Standardtext der alten Form ist
        st.update(() => { mk.kind = to.id; if (!mk.name.trim() || mk.name === from.name) mk.name = to.name; });
        this.renderSelection(); // Fokus liegt im Panel, refresh() zeichnet es dann nicht neu
        break;
      }
      case 'markerRot': { const mk = st.marker(sel?.id); if (mk) { st.update(() => { mk.rot = ((mk.rot + parseFloat(btn.dataset.deg)) % 360 + 360) % 360; }); this.renderSelection(); } break; }
      case 'selectDoor': st.select({ type: 'door', roomId: btn.dataset.room, id: btn.dataset.door }); break;
      case 'delete': this.editor.deleteSelection(); break;
      case 'deleteDoor': st.update(p => { const r = p.rooms.find(r => r.id === btn.dataset.room); if (r) r.doors = r.doors.filter(d => d.id !== btn.dataset.door); }); if (sel?.type === 'door') st.select({ type: 'room', id: btn.dataset.room }); break;
      case 'addDoor': st.setTool('door'); $('editor').focus(); break;
      case 'centerLabel': {
        const room = st.room(sel?.id ?? sel?.roomId);
        if (room) st.update(() => { const lp = G.labelPoint(room.points); room.label.x = lp.x; room.label.y = lp.y; });
        break;
      }
      case 'toPoly': { const room = st.room(sel?.id); if (room) st.update(() => { room.kind = 'poly'; }); break; }
      case 'color': { const room = st.room(sel?.id ?? sel?.roomId); if (room) st.update(() => { room.color = btn.dataset.color; }); break; }
      case 'selectRoomOfDoor': st.select({ type: 'room', id: sel.roomId }); break;
      case 'deleteVertex': this.editor.deleteSelection(); break;
      case 'fitBed': this.fitToBed(); break;
      case 'brailleDefaults': st.update(p => { Object.assign(p.settings.braille, { dotDiameter: 1.5, dotHeight: 0.6, dotPitch: 2.5, cellPitch: 6.0, linePitch: 10.0 }); }); break;
      case 'resetSettings': if (confirm('Alle Maße auf die Standardwerte zurücksetzen? Der Grundriss bleibt erhalten.')) st.update(p => { const name = p.name; p.settings = defaultSettings(); p.name = name; }); break;
      case 'export': this.doExport(); break;
      case 'exportFrame': this.doExportFrame(); break;
      case 'exportOpt': this.exportOpts[btn.dataset.key] = btn.dataset.value === 'true' ? true : btn.dataset.value === 'false' ? false : btn.dataset.value; this.renderExport(); break;
      case 'toggleLegend': this.exportOpts.legend = !this.exportOpts.legend; this.renderExport(); break;
      case 'toggleSurround': this.exportOpts.surround = !this.exportOpts.surround; this.renderExport(); break;
      case 'rotate': { const id = sel?.id ?? sel?.roomId; if (id) this.editor.transformRoom(id, 'rotate', parseFloat(btn.dataset.deg)); break; }
      case 'rotateBy': {
        const id = sel?.id ?? sel?.roomId;
        const deg = parseFloat(String(this.panel.querySelector('#rotDeg')?.value ?? '0').replace(',', '.'));
        if (id && isFinite(deg) && deg !== 0) this.editor.transformRoom(id, 'rotate', deg);
        break;
      }
      case 'flipH': case 'flipV': { const id = sel?.id ?? sel?.roomId; if (id) this.editor.transformRoom(id, btn.dataset.action); break; }
      case 'view3d': this.setView('3d'); break;
      case 'ulLoad': $('imageInput').click(); break;
      case 'ulAuto': this.alignUnderlay(btn); break;
      case 'ulRot': { const u = st.underlay; if (u) { u.rot = normDeg(u.rot + parseFloat(btn.dataset.deg)); this.redetectSoon(); st.underlayChanged(); } break; }
      case 'ulMeasure': this.measured = null; this.editor.clearMeasure(); st.setTool('measure'); this.renderUnderlay(); $('editor').focus(); break;
      case 'ulMove': st.setTool(st.tool === 'underlay' ? 'select' : 'underlay'); if (st.tool === 'underlay') $('editor').focus(); break;
      case 'ulFit': this.editor.fit(); break;
      case 'ulApplyScale': this.applyScale(); break;
      case 'ulCancelScale': this.measured = null; this.editor.clearMeasure(); this.renderUnderlay(); break;
      case 'ulRedetect': {
        const u = st.underlay;
        if (u) { const n = detectLines(u); st.underlayChanged(); this.toast(n ? `${n} Wandlinien erkannt.` : 'Keine Wandlinien erkannt.', n ? 'ok' : 'warn'); }
        break;
      }
      case 'ulRemove': if (confirm('Vorlage entfernen? Der gezeichnete Plan bleibt erhalten.')) { this.clearUnderlay(); this.renderUnderlay(); } break;
      case 'scaleDenom': {
        const input = this.panel.querySelector('#scaleDenom');
        const n = parseFloat(String(input.value).replace(',', '.'));
        if (isFinite(n) && n >= 5 && n <= 1000) st.update(p => { p.settings.scale = 1000 / n; });
        break;
      }
      default: return;
    }
  }

  fitToBed() {
    const st = this.store;
    const s = st.plan.settings;
    const bed = bedSize(s);
    const usableW = bed.w - 2 * s.plate.margin - 1, usableH = bed.h - 2 * s.plate.margin - 1;
    let denom = null;
    for (let iter = 0; iter < 3; iter++) {
      const ext = planExtent(st.plan);
      if (!ext || ext.width <= 0 || ext.height <= 0) { this.toast('Erst Räume zeichnen, dann einpassen.', 'warn'); return; }
      const scale = Math.max(Math.min(usableW / ext.width, usableH / ext.height), Math.min(usableW / ext.height, usableH / ext.width));
      const raw = 1000 / scale;
      denom = NICE_DENOMS.find(d => d >= raw - 1e-9) ?? Math.ceil(raw);
      st.plan.settings.scale = 1000 / denom;
    }
    st.begin(); st.commit();
    this.toast(`Maßstab 1:${denom} – die Platte passt auf ${bed.name}.`, 'ok');
  }

  /* ---------- Ansicht / Tabs ---------- */
  setView(v) {
    const is3d = v === '3d';
    $('viewPlan').classList.toggle('active', !is3d); $('viewPlan').setAttribute('aria-selected', String(!is3d));
    $('view3d').classList.toggle('active', is3d); $('view3d').setAttribute('aria-selected', String(is3d));
    if (is3d) this.preview.show(); else this.preview.hide();
  }

  setTab(tab) {
    this.tab = tab;
    document.querySelectorAll('.tabs .tab').forEach(b => { const on = b.dataset.tab === tab; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
    for (const t of ['selection', 'underlay', 'plan', 'export']) $(`tab-${t}`).hidden = t !== tab;
    this.renderTab();
  }

  renderTab() {
    if (this.tab === 'selection') this.renderSelection();
    else if (this.tab === 'underlay') this.renderUnderlay();
    else if (this.tab === 'plan') this.renderPlan();
    else this.renderExport();
  }

  /* ---------- Aktualisierung ---------- */
  refresh(what) {
    const st = this.store;
    $('btnUndo').disabled = !st.undoStack.length;
    $('btnRedo').disabled = !st.redoStack.length;
    const nameEl = $('projectName');
    if (document.activeElement !== nameEl) nameEl.value = st.plan.name;
    $('emptyState').hidden = hasContent(st.plan) || !!st.underlay;
    this.updateStatus();
    document.querySelectorAll('.rail .tool[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === st.tool));
    if (what === 'tool') {
      // angefangene Messung verwerfen, wenn ein anderes Werkzeug gewählt wird
      if (st.tool !== 'measure' && this.editor.measure && !this.editor.measure.b) this.editor.clearMeasure();
      this.setHint(TOOL_HINTS[st.tool] || null);
      this.editor.updateCursor();
      this.editor.render();
    }
    if (what === 'selection') {
      if (st.selection && this.tab !== 'export') this.setTab('selection');
      else this.renderTab();
      return;
    }
    const focusInside = this.panel.contains(document.activeElement) && document.activeElement !== this.panel;
    if (focusInside) this.updateDerived();
    else this.renderTab();
    if (this.preview.visible && what === 'plan') this.preview.rebuild();
  }

  updateStatus() {
    const s = this.store.plan.settings;
    const denom = 1000 / s.scale;
    $('statusScale').textContent = `Maßstab 1:${denom % 1 ? fmt(denom, 1) : denom} · ${fmt1(s.scale)} mm/m`;
    const info = plateInfo(this.store.plan);
    const el = $('statusPlate');
    if (!info.ext) { el.textContent = 'Noch keine Grundplatte'; el.classList.remove('bad'); return; }
    const bed = bedSize(s);
    const fits = (info.width <= bed.w && info.height <= bed.h);
    const fitsRot = (info.width <= bed.h && info.height <= bed.w);
    el.textContent = `Platte ${Math.round(info.width)} × ${Math.round(info.height)} mm · ${fits ? 'passt auf' : fitsRot ? 'passt gedreht auf' : 'zu groß für'} ${bed.name} (${bed.w} × ${bed.h})`;
    el.classList.toggle('bad', !fits && !fitsRot);
  }

  setCursor(p) { $('statusCursor').textContent = `x ${fmt(p.x)} m · y ${fmt(p.y)} m`; }
  setZoom(z) { $('statusZoom').textContent = `${Math.round(z)} %`; }
  setHint(text) { const h = $('stageHint'); if (text) { h.textContent = text; h.hidden = false; } else h.hidden = true; }
  onCreated() { /* Platz für künftige Rückmeldungen */ }
  showWarnings(list) { this.buildWarnings = list; }

  toast(msg, kind = 'info', ms = 3800) {
    const box = $('toasts');
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    const icon = kind === 'ok' ? 'i-check' : kind === 'warn' || kind === 'danger' ? 'i-warn' : 'i-info';
    t.innerHTML = `${ICON(icon)}<span>${esc(msg)}</span>`;
    box.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 220); }, ms);
  }

  /* ---------- Warnungen ---------- */
  collectWarnings() {
    const st = this.store;
    const plan = st.plan, s = plan.settings;
    const out = [];
    const info = plateInfo(plan);
    if (info.ext) {
      const bed = bedSize(s);
      const fits = info.width <= bed.w && info.height <= bed.h, fitsRot = info.width <= bed.h && info.height <= bed.w;
      if (!fits && !fitsRot) out.push({ kind: 'warn', text: `Die Grundplatte (${Math.round(info.width)} × ${Math.round(info.height)} mm) ist größer als das Druckbett. Maßstab verkleinern oder Räume einzeln drucken.`, action: 'fitBed', actionLabel: 'Einpassen' });
    }
    for (const r of plan.rooms) {
      if (r.type !== 'room' || r.label.visible === false) continue;
      const lay = layoutLabel(r, s);
      if (lay && !this.editor.labelFits(r, r.label.x, r.label.y, lay, s)) out.push({ kind: 'warn', text: `Die Beschriftung „${displayText(r)}“ (${Math.round(lay.width)} mm) passt nicht in „${r.name}“. Kurzbezeichnung vergeben oder Maßstab vergrößern.`, select: r.id });
      const b = G.bbox(r.points);
      const minMM = Math.min(b.width, b.height) * s.scale;
      if (minMM < s.wall.thickness * 3) out.push({ kind: 'warn', text: `„${r.name}“ ist im Druck nur ${fmt1(minMM)} mm schmal – zu eng für die Wände.`, select: r.id });
    }
    if (s.text.enabled && !hasTextProvider()) out.push({ kind: 'info', text: 'Die 3D-Schrift lädt noch oder ist nicht verfügbar; Profilschrift erscheint dann nicht im Modell.' });
    return out;
  }

  warningsHTML(list) {
    if (!list.length) return '';
    return list.map(w => `<div class="notice ${w.kind}">${ICON(w.kind === 'info' ? 'i-info' : 'i-warn')}<div>${esc(w.text)}${w.select ? ` <button class="btn small" style="margin-top:6px" data-action="select" data-id="${w.select}">Anzeigen</button>` : ''}${w.action ? ` <button class="btn small" style="margin-top:6px" data-action="${w.action}">${esc(w.actionLabel)}</button>` : ''}</div></div>`).join('');
  }

  /* ---------- Panel: Auswahl ---------- */
  renderSelection() {
    const st = this.store;
    const sel = st.selection;
    const host = $('tab-selection');
    if (!sel) { host.innerHTML = this.elementListHTML(); return; }
    if (sel.type === 'label') { host.innerHTML = this.labelPanelHTML(st.label(sel.id)); return; }
    if (sel.type === 'marker') { host.innerHTML = this.markerPanelHTML(st.marker(sel.id)); return; }
    if (sel.type === 'door') { host.innerHTML = this.doorPanelHTML(st.room(sel.roomId), sel.id); return; }
    const room = st.room(sel.type === 'room' ? sel.id : sel.roomId);
    if (!room) { host.innerHTML = this.elementListHTML(); return; }
    host.innerHTML = this.roomPanelHTML(room, sel);
  }

  elementListHTML() {
    const plan = this.store.plan;
    const rooms = plan.rooms.filter(r => r.type === 'room'), zones = plan.rooms.filter(r => r.type === 'zone'), pillars = plan.rooms.filter(r => r.type === 'pillar');
    const s = plan.settings;
    const item = (r) => {
      const b = G.bbox(r.points);
      return `<button class="list-item" data-action="select" data-id="${r.id}"><span class="dot ${r.type === 'room' ? '' : r.type}" style="background:${esc(r.color)}"></span><span class="name">${esc(r.name || '–')}</span><span class="sub">${fmt(b.width, 1)} × ${fmt(b.height, 1)} m</span></button>`;
    };
    const labelItem = (l) => `<button class="list-item" data-action="selectLabel" data-id="${l.id}"><span class="dot" style="background:transparent;box-shadow:none">${ICON('i-label')}</span><span class="name">${esc(l.name || '–')}</span><span class="sub">Text</span></button>`;
    const markerItem = (m) => `<button class="list-item" data-action="selectMarker" data-id="${m.id}"><span class="dot" style="background:transparent;box-shadow:none">${ICON('i-marker')}</span><span class="name">${esc(m.name || '–')}</span><span class="sub">${esc(markerKind(m.kind).shape)}</span></button>`;
    const warnings = this.collectWarnings();
    const total = rooms.length + zones.length + pillars.length + plan.labels.length + plan.markers.length;
    const legendCount = legendEntries(plan).length + markerLegendEntries(plan).length;
    return `
      ${this.warningsHTML(warnings)}
      <div class="section">
        <div class="section-title"><span>Räume</span><span class="hint">${rooms.length}</span></div>
        <div class="list">${rooms.length ? rooms.map(item).join('') : '<div class="empty-list">Noch keine Räume. Werkzeug „Rechteck“ (R) oder „Polygon“ (P) wählen.</div>'}</div>
      </div>
      <div class="section">
        <div class="section-title"><span>Bereiche</span><span class="hint">${zones.length}</span></div>
        <div class="list">${zones.length ? zones.map(item).join('') : '<div class="empty-list">Bereiche sind Zonen ohne Wände innerhalb eines Raums, z. B. Anmeldung und Wartebereich.</div>'}</div>
      </div>
      <div class="section">
        <div class="section-title"><span>Säulen</span><span class="hint">${pillars.length}</span></div>
        <div class="list">${pillars.length ? pillars.map(item).join('') : '<div class="empty-list">Säulen und Schächte mitten im Raum. Ihre Fläche bleibt Grundplatte, rundherum entsteht eine Wand. Werkzeug „Säule“ (S).</div>'}</div>
      </div>
      <div class="section">
        <div class="section-title"><span>Freie Beschriftungen</span><span class="hint">${plan.labels.length}</span></div>
        <div class="list">${plan.labels.length ? plan.labels.map(labelItem).join('') : '<div class="empty-list">Mit dem Werkzeug „Beschriftung“ (L) setzen, z. B. „Eingang“.</div>'}</div>
      </div>
      <div class="section">
        <div class="section-title"><span>Orientierungsmarker</span><span class="hint">${plan.markers.length}</span></div>
        <div class="list">${plan.markers.length ? plan.markers.map(markerItem).join('') : '<div class="empty-list">Tastbare Symbole, z. B. der Standort „Sie sind hier“ oder ein Pfeil am Eingang. Werkzeug „Marker“ (M).</div>'}</div>
        <div class="actions">${MARKER_KINDS.map(k => `<button class="btn small" data-action="markerTool" data-kind="${k.id}">${esc(k.shape)} setzen</button>`).join('')}</div>
      </div>
      ${total ? `<div class="section"><div class="section-title"><span>Legende</span></div><div class="meta">${legendCount ? `<span><b>${legendCount}</b> Einträge (Kurzbezeichnungen und Marker)</span>` : '<span>Keine Kurzbezeichnungen oder Marker.</span>'}</div></div>` : ''}
      <div class="section"><div class="meta"><span>Maßstab 1:${Math.round(1000 / s.scale)}</span><span>Rechtsklick/Mittlere Taste zieht die Ansicht</span></div></div>`;
  }

  labelBlockHTML(el, s, room) {
    const lay = layoutLabel(el, s);
    const text = displayText(el);
    const unicode = lay?.braille?.unicode ?? '';
    const warn = lay?.braille?.warnings ?? [];
    const fits = room && lay ? this.editor.labelFits(room, room.label.x, room.label.y, lay, s) : true;
    return `
      <div class="field"><div class="lbl">Braille${s.braille.system === 'voll' ? ' (Vollschrift)' : ' (Basisschrift)'}</div>
        <div class="braille-preview" id="braillePreview">${esc(unicode) || '<span style="color:var(--ink-3);font:13px var(--font)">Kein Text</span>'}</div>
        <div class="meta" id="labelMeta">${lay ? `<span><b>${lay.braille?.cellCount ?? 0}</b> Zellen</span><span><b>${Math.round(lay.width)} × ${Math.round(lay.height)}</b> mm</span>${room ? `<span style="color:${fits ? 'var(--ok)' : 'var(--danger)'}">${fits ? 'passt in den Raum' : 'passt nicht in den Raum'}</span>` : ''}` : ''}</div>
        ${warn.length ? `<div class="help" style="color:var(--warn)">${esc(warn.join(' '))}</div>` : ''}
        ${text !== (el.name ?? '').trim() && text ? `<div class="help">Auf dem Plan steht die Kurzbezeichnung, der volle Name kommt in die Legende.</div>` : ''}
      </div>`;
  }

  roomPanelHTML(room, sel) {
    const s = this.store.plan.settings;
    const isRoom = room.type === 'room', isPillar = room.type === 'pillar';
    const typeName = isRoom ? 'Raum' : isPillar ? 'Säule' : 'Bereich';
    const owner = isPillar || isRoom ? parentRoom(room, this.store.plan.rooms) : null;
    const b = G.bbox(room.points);
    const areaM2 = G.area(room.points);
    const kindName = room.kind === 'rect' ? 'Rechteck' : `Polygon · ${room.points.length} Ecken`;
    const doorRows = room.doors.map((d, i) => {
      const active = sel.type === 'door' && sel.id === d.id;
      return `<div class="list-item ${active ? 'active' : ''}" style="display:grid;grid-template-columns:auto 1fr auto auto;gap:8px;align-items:center;cursor:default">
        <button class="btn small" data-action="selectDoor" data-room="${room.id}" data-door="${d.id}" title="Tür auswählen">Tür ${i + 1}</button>
        <div class="input-unit"><input class="input" type="number" step="0.05" min="0.3" max="5" value="${d.width}" data-path="width" data-type="number" data-target="door" data-room="${room.id}" data-door="${d.id}" aria-label="Türbreite"><span>m</span></div>
        <label class="check" title="Niedrige Schwelle in der Türöffnung"><input type="checkbox" data-path="threshold" data-type="checkbox" data-target="door" data-room="${room.id}" data-door="${d.id}" ${d.threshold ? 'checked' : ''}> Schwelle</label>
        <button class="btn icon" data-action="deleteDoor" data-room="${room.id}" data-door="${d.id}" title="Tür entfernen">${ICON('i-trash')}</button>
      </div>`;
    }).join('');
    const vertexBlock = sel.type === 'vertex' ? `
      <div class="section">
        <div class="section-title"><span>Ecke ${sel.index + 1}</span></div>
        <div class="row">
          <div class="field"><label>x</label><div class="input-unit"><input class="input" type="number" step="0.05" value="${room.points[sel.index].x}" data-path="points.${sel.index}.x" data-type="number" data-target="sel"><span>m</span></div></div>
          <div class="field"><label>y</label><div class="input-unit"><input class="input" type="number" step="0.05" value="${room.points[sel.index].y}" data-path="points.${sel.index}.y" data-type="number" data-target="sel"><span>m</span></div></div>
        </div>
        ${room.kind === 'poly' && room.points.length > 3 ? `<button class="btn small" data-action="deleteVertex">${ICON('i-trash')}<span>Ecke entfernen</span></button>` : '<div class="help">Bei Rechtecken verformen die Ecken das ganze Rechteck.</div>'}
      </div>` : '';
    return `
      <div class="section">
        <div class="section-title"><span>${typeName}</span><span class="hint">${kindName}</span></div>
        <div class="field"><label for="f-name">Name</label><input class="input" id="f-name" type="text" value="${esc(room.name)}" data-path="name" data-type="text" data-target="sel" autocomplete="off"></div>
        <div class="field"><label for="f-short">Kurzbezeichnung auf dem Plan</label><input class="input" id="f-short" type="text" value="${esc(room.short)}" data-path="short" data-type="text" data-target="sel" placeholder="leer = Name" autocomplete="off"><div class="help">Für kleine Räume. Der volle Name kommt dann in die Legende.</div></div>
        ${this.labelBlockHTML(room, s, isRoom ? room : null)}
        <div class="checks">
          <label class="check"><input type="checkbox" data-path="label.showBraille" data-type="checkbox" data-target="sel" ${room.label.showBraille !== false ? 'checked' : ''}> Braille</label>
          <label class="check"><input type="checkbox" data-path="label.showText" data-type="checkbox" data-target="sel" ${room.label.showText !== false ? 'checked' : ''}> Profilschrift für Sehende</label>
          <label class="check"><input type="checkbox" data-path="label.visible" data-type="checkbox" data-target="sel" ${room.label.visible !== false ? 'checked' : ''}> Beschriftung auf dem Plan</label>
        </div>
        <div class="actions"><button class="btn small" data-action="centerLabel">Beschriftung zentrieren</button></div>
      </div>
      ${isRoom && owner ? `<div class="notice info">${ICON('i-info')}<div>Liegt in „${esc(owner.name)}“. Bei „Räume einzeln“ wird der Raum aus dessen Boden ausgespart und passt als eigenes Teil genau ins Loch.</div></div>` : ''}
      ${vertexBlock}
      ${isPillar ? `
      <div class="section">
        <div class="section-title"><span>Darstellung</span><span class="hint">${owner ? `in „${esc(owner.name)}“` : 'in keinem Raum'}</span></div>
        <div class="checks"><label class="check"><input type="checkbox" data-path="filled" data-type="checkbox" data-target="sel" ${room.filled ? 'checked' : ''}> Als erhabenen Block füllen (sonst nur umrandet)</label></div>
        <div class="help">Rundherum entsteht eine Wand. Bei „Räume einzeln“ hat der Raum an dieser Stelle ein Loch, die Fläche der Säule wird ein Teil der Umgebungsplatte.</div>
      </div>` : ''}
      ${isRoom ? `
      <div class="section">
        <div class="section-title"><span>Farbe</span><span class="hint">Vorschau und Einzelteile</span></div>
        <div class="color-field">
          <div class="swatches">${ROOM_COLORS.map(c => `<button class="swatch ${c === room.color ? 'active' : ''}" style="background:${c}" data-action="color" data-color="${c}" title="${c}" aria-label="Farbe ${c}"></button>`).join('')}</div>
          <input type="color" value="${esc(room.color)}" data-path="color" data-type="color" data-target="sel" aria-label="Eigene Farbe">
        </div>
      </div>
      <div class="section">
        <div class="section-title"><span>Türen</span><span class="hint">${room.doors.length}</span></div>
        <div class="list">${doorRows || '<div class="empty-list">Keine Türen. Türen sind Lücken in der Wand.</div>'}</div>
        <div class="actions"><button class="btn small" data-action="addDoor">${ICON('i-door')}<span>Tür setzen (T)</span></button></div>
      </div>` : ''}
      <div class="section">
        <div class="section-title"><span>Drehen und Spiegeln</span></div>
        <div class="actions">
          <button class="btn small" data-action="rotate" data-deg="90">90° links</button>
          <button class="btn small" data-action="rotate" data-deg="-90">90° rechts</button>
          <button class="btn small" data-action="rotate" data-deg="180">180°</button>
        </div>
        <div class="row" style="align-items:end;margin-top:8px">
          <div class="field" style="margin-bottom:0"><label for="rotDeg">Winkel</label><div class="input-unit"><input class="input" id="rotDeg" type="number" step="1" min="-359" max="359" value="15"><span>°</span></div></div>
          <button class="btn" data-action="rotateBy" style="height:32px">Drehen (links)</button>
        </div>
        <div class="actions" style="margin-top:8px">
          <button class="btn small" data-action="flipH">Horizontal spiegeln</button>
          <button class="btn small" data-action="flipV">Vertikal spiegeln</button>
        </div>
        <div class="help" style="margin-top:6px">Gedreht wird um die Mitte ${isRoom ? 'des Raums' : isPillar ? 'der Säule' : 'des Bereichs'}, Türen und Beschriftung wandern mit. Andere Winkel als 90° machen aus einem Rechteck ein Polygon.</div>
      </div>
      <div class="section">
        <div class="section-title"><span>Maße</span></div>
        <dl class="kv">
          <dt>Größe</dt><dd>${fmt(b.width)} × ${fmt(b.height)} m</dd>
          <dt>Fläche</dt><dd>${fmt(areaM2, 1)} m²</dd>
          <dt>Im Druck</dt><dd>${Math.round(b.width * s.scale)} × ${Math.round(b.height * s.scale)} mm</dd>
        </dl>
        ${room.kind === 'rect' ? `<div class="actions"><button class="btn small" data-action="toPoly">In Polygon umwandeln</button></div><div class="help" style="margin-top:6px">Mit Alt+Klick auf eine Kante lässt sich auch direkt eine Ecke einfügen.</div>` : ''}
      </div>
      <div class="actions"><button class="btn danger" data-action="delete">${ICON('i-trash')}<span>${typeName} löschen</span></button></div>`;
  }

  doorPanelHTML(room, doorId) {
    const d = room?.doors.find(x => x.id === doorId);
    if (!d) return this.elementListHTML();
    const i = room.doors.indexOf(d);
    const n = room.points.length;
    const L = G.dist(room.points[d.edge], room.points[(d.edge + 1) % n]);
    return `
      <div class="section">
        <div class="section-title"><span>Tür ${i + 1}</span><span class="hint">in „${esc(room.name)}“</span></div>
        <div class="field"><label>Breite</label><div class="input-unit"><input class="input" type="number" step="0.05" min="0.3" max="${Math.max(0.3, L).toFixed(2)}" value="${d.width}" data-path="width" data-type="number" data-target="door" data-room="${room.id}" data-door="${d.id}"><span>m</span></div></div>
        <div class="checks"><label class="check"><input type="checkbox" data-path="threshold" data-type="checkbox" data-target="door" data-room="${room.id}" data-door="${d.id}" ${d.threshold ? 'checked' : ''}> Schwelle (niedrige Tastkante in der Öffnung)</label></div>
        <div class="help">Die Tür lässt sich auf der Zeichenfläche entlang der Wand verschieben, auch um Ecken.</div>
        <dl class="kv" style="margin-top:10px"><dt>Wand</dt><dd>${d.edge + 1} von ${n} · ${fmt(L)} m lang</dd><dt>Position</dt><dd>${fmt(d.t * L)} m vom Wandanfang</dd></dl>
      </div>
      <div class="actions">
        <button class="btn" data-action="selectRoomOfDoor">Zum Raum</button>
        <button class="btn danger" data-action="deleteDoor" data-room="${room.id}" data-door="${d.id}">${ICON('i-trash')}<span>Tür löschen</span></button>
      </div>`;
  }

  labelPanelHTML(l) {
    if (!l) return this.elementListHTML();
    const s = this.store.plan.settings;
    return `
      <div class="section">
        <div class="section-title"><span>Freie Beschriftung</span></div>
        <div class="field"><label for="f-name">Text</label><input class="input" id="f-name" type="text" value="${esc(l.name)}" data-path="name" data-type="text" data-target="sel" autocomplete="off"></div>
        <div class="field"><label for="f-short">Kurzbezeichnung auf dem Plan</label><input class="input" id="f-short" type="text" value="${esc(l.short)}" data-path="short" data-type="text" data-target="sel" placeholder="leer = Text" autocomplete="off"></div>
        ${this.labelBlockHTML(l, s, null)}
        <div class="checks">
          <label class="check"><input type="checkbox" data-path="showBraille" data-type="checkbox" data-target="sel" ${l.showBraille !== false ? 'checked' : ''}> Braille</label>
          <label class="check"><input type="checkbox" data-path="showText" data-type="checkbox" data-target="sel" ${l.showText !== false ? 'checked' : ''}> Profilschrift für Sehende</label>
        </div>
        <div class="row">
          <div class="field"><label>x</label><div class="input-unit"><input class="input" type="number" step="0.05" value="${l.x}" data-path="x" data-type="number" data-target="sel"><span>m</span></div></div>
          <div class="field"><label>y</label><div class="input-unit"><input class="input" type="number" step="0.05" value="${l.y}" data-path="y" data-type="number" data-target="sel"><span>m</span></div></div>
        </div>
        <div class="help">Freie Beschriftungen liegen außerhalb der Räume (z. B. „Eingang“). Beim Export „Räume einzeln“ gehören sie zu dem Raum, in dem sie liegen.</div>
      </div>
      <div class="actions"><button class="btn danger" data-action="delete">${ICON('i-trash')}<span>Beschriftung löschen</span></button></div>`;
  }

  markerPanelHTML(m) {
    if (!m) return this.elementListHTML();
    const s = this.store.plan.settings;
    const kind = markerKind(m.kind);
    return `
      <div class="section">
        <div class="section-title"><span>Orientierungsmarker</span><span class="hint">${esc(kind.shape)}</span></div>
        <div class="field"><div class="lbl">Form</div>
          <div class="actions">${MARKER_KINDS.map(k => `<button class="btn small ${k.id === m.kind ? 'primary' : ''}" data-action="markerKind" data-kind="${k.id}" aria-pressed="${k.id === m.kind}">${esc(k.shape)}</button>`).join('')}</div>
        </div>
        <div class="field"><label for="f-name">Bedeutung in der Legende</label><input class="input" id="f-name" type="text" value="${esc(m.name)}" data-path="name" data-type="text" data-target="sel" placeholder="${esc(kind.name)}" autocomplete="off"><div class="help">Auf dem Plan steht nur das Symbol. Die Legende erklärt es in Braille und Profilschrift; gleiche Form und Bedeutung erscheinen dort nur einmal.</div></div>
        <div class="row">
          <div class="field"><label>x</label><div class="input-unit"><input class="input" type="number" step="0.05" value="${m.x}" data-path="x" data-type="number" data-target="sel"><span>m</span></div></div>
          <div class="field"><label>y</label><div class="input-unit"><input class="input" type="number" step="0.05" value="${m.y}" data-path="y" data-type="number" data-target="sel"><span>m</span></div></div>
        </div>
        ${m.kind === 'here' ? '' : `
        <div class="field"><label for="f-rot">Drehung</label>
          <div style="display:flex;gap:8px;align-items:center">
            <div class="input-unit" style="max-width:110px"><input class="input" id="f-rot" type="number" step="15" min="0" max="359" value="${Math.round(m.rot)}" data-path="rot" data-type="number" data-target="sel"><span>°</span></div>
            <button class="btn small" data-action="markerRot" data-deg="90">90° links</button>
            <button class="btn small" data-action="markerRot" data-deg="-90">90° rechts</button>
          </div>
          ${m.kind === 'arrow' ? '<div class="help">0° zeigt nach oben. Am Eingang zeigt der Pfeil ins Gebäude.</div>' : ''}
        </div>`}
        <dl class="kv"><dt>Im Druck</dt><dd>${fmt1(s.marker.size)} mm, ${fmt1(s.marker.height)} mm hoch</dd></dl>
      </div>
      <div class="actions"><button class="btn danger" data-action="delete">${ICON('i-trash')}<span>Marker löschen</span></button></div>`;
  }

  updateDerived() {
    const st = this.store;
    const sel = st.selection;
    if (this.tab === 'selection' && sel) {
      const el = sel.type === 'label' ? st.label(sel.id) : sel.type === 'marker' ? null : st.room(sel.id ?? sel.roomId);
      if (el && !(sel.type === 'door')) {
        const host = $('tab-selection');
        const block = host.querySelector('#braillePreview')?.closest('.field');
        if (block) {
          const tmp = document.createElement('div');
          tmp.innerHTML = this.labelBlockHTML(el, st.plan.settings, el.type === 'room' ? el : null);
          block.replaceWith(tmp.firstElementChild);
        }
      }
    }
    if (this.tab === 'plan') {
      const sd = this.panel.querySelector('#scaleDenom');
      if (sd && document.activeElement !== sd) sd.value = Math.round(1000 / st.plan.settings.scale * 10) / 10;
      const pi = this.panel.querySelector('#plateInfoLine');
      if (pi) pi.innerHTML = this.plateInfoHTML();
      const fi = this.panel.querySelector('#frameInfoLine');
      if (fi) fi.innerHTML = this.frameInfoHTML();
    }
    if (this.tab === 'export') {
      const info = this.panel.querySelector('#exportInfo');
      if (info) info.innerHTML = this.exportInfoHTML();
    }
    if (this.tab === 'underlay' && st.underlay) {
      const u = st.underlay;
      this.panel.querySelectorAll('[data-target="underlay"][data-path]').forEach(el => {
        if (el === document.activeElement) return;
        const v = u[el.dataset.path];
        if (el.type === 'checkbox') el.checked = !!v;
        else el.value = el.dataset.type === 'percent' ? Math.round(v * 100) : Math.round(v * 100) / 100;
      });
      const ov = $('ulOpacityVal'); if (ov) ov.textContent = `${Math.round(u.opacity * 100)} %`;
      const rh = $('ulRotHint'); if (rh) rh.textContent = this.rotText(u.rot);
      const li = $('ulLinesInfo'); if (li) li.innerHTML = this.linesInfoHTML(u);
      const mv = $('ulMoveBtn'); if (mv) { mv.classList.toggle('primary', st.tool === 'underlay'); mv.setAttribute('aria-pressed', String(st.tool === 'underlay')); }
    }
  }

  /* ---------- Panel: Vorlage ---------- */
  rotText(rot) {
    if (Math.abs(rot) < 0.005) return 'gerade';
    return `${fmt(Math.abs(rot), Math.abs(rot % 1) < 0.005 ? 0 : 1)}° ${rot > 0 ? 'im' : 'gegen den'} Uhrzeigersinn`;
  }

  linesInfoHTML(u) {
    return u.lines.length
      ? `<span><b>${u.lines.length}</b> Wandlinien erkannt</span>`
      : '<span>Keine Wandlinien erkannt. Hilfreich sind kräftige, gerade Striche und ein gleichmäßig ausgeleuchtetes Foto.</span>';
  }

  renderUnderlay() {
    const host = $('tab-underlay');
    const st = this.store;
    const u = st.underlay;
    if (!u) {
      host.innerHTML = `
        <div class="section">
          <div class="section-title"><span>Grundriss als Vorlage</span></div>
          <p class="prose">Lade ein Foto, einen Scan oder eine Skizze des Grundrisses. Das Bild liegt durchscheinend unter dem Plan, und du zeichnest die Räume darauf nach.</p>
          <ol class="steps">
            <li><b>Bild laden.</b> Es wird automatisch so gedreht, dass die Wände parallel zum Raster liegen.</li>
            <li><b>Maßstab festlegen.</b> Eine Strecke bekannter Länge messen, zum Beispiel eine Wand mit Bemaßung.</li>
            <li><b>Räume zeichnen.</b> Der Zeiger fängt an den erkannten Wänden und ihren Ecken.</li>
          </ol>
          <button class="btn primary block" data-action="ulLoad">${ICON('i-image')}<span>Bild laden</span></button>
          <div class="help" style="margin-top:8px">PNG, JPG oder WebP. Du kannst das Bild auch auf die Zeichenfläche ziehen oder mit Strg+V einfügen. PDF-Pläne vorher als Bild speichern.</div>
        </div>`;
      return;
    }
    const m = this.measured;
    const moving = st.tool === 'underlay';
    const calib = m ? `
      <div class="section calib">
        <div class="section-title"><span>Maßstab festlegen</span></div>
        <div class="meta" style="margin-bottom:8px"><span>Gemessen: <b>${fmt(m.d)} m</b> auf der Vorlage</span></div>
        <div class="field"><label for="ulRealLen">Echte Länge dieser Strecke</label><div class="input-unit"><input class="input" id="ulRealLen" type="number" step="0.01" min="0.05" inputmode="decimal" placeholder="z. B. 4,50"><span>m</span></div></div>
        <div class="actions"><button class="btn primary" data-action="ulApplyScale">Maßstab übernehmen</button><button class="btn" data-action="ulCancelScale">Abbrechen</button></div>
      </div>`
      : !u.calibrated ? `<div class="notice warn">${ICON('i-warn')}<div>Der Maßstab ist noch geschätzt. Miss vor dem Zeichnen eine Strecke, deren Länge du kennst. <button class="btn small" style="margin-top:6px" data-action="ulMeasure">${ICON('i-ruler')}<span>Strecke messen</span></button></div></div>` : '';
    host.innerHTML = `
      <div class="underlay-file">
        <img src="${u.src}" alt="">
        <div class="uf-text"><span class="name">${esc(u.name)}</span><span class="sub">${u.w} × ${u.h} px · ${fmt(u.width, 1)} m</span></div>
        <button class="btn icon" data-action="ulLoad" title="Anderes Bild laden">${ICON('i-upload')}</button>
      </div>
      ${calib}
      <div class="section">
        <div class="section-title"><span>Darstellung</span></div>
        <div class="checks"><label class="check"><input type="checkbox" data-path="visible" data-type="checkbox" data-target="underlay" ${u.visible ? 'checked' : ''}> Vorlage anzeigen</label></div>
        <div class="field"><label for="ulOpacity">Deckkraft</label>
          <div class="range-field"><input type="range" id="ulOpacity" min="10" max="100" step="5" value="${Math.round(u.opacity * 100)}" data-path="opacity" data-type="percent" data-target="underlay"><output id="ulOpacityVal" for="ulOpacity">${Math.round(u.opacity * 100)} %</output></div>
        </div>
      </div>
      <div class="section">
        <div class="section-title"><span>Ausrichtung</span><span class="hint" id="ulRotHint">${this.rotText(u.rot)}</span></div>
        <button class="btn block" data-action="ulAuto">${ICON('i-rotate')}<span>Automatisch geradestellen</span></button>
        <div class="actions">
          <button class="btn small" data-action="ulRot" data-deg="-90">${ICON('i-rotl')}<span>90° links</span></button>
          <button class="btn small" data-action="ulRot" data-deg="90">${ICON('i-rotate')}<span>90° rechts</span></button>
        </div>
        <div class="row" style="align-items:end;margin-top:10px;grid-template-columns:1fr auto auto">
          <div class="field" style="margin-bottom:0"><label for="ulRot">Drehung</label><div class="input-unit"><input class="input" id="ulRot" type="number" step="0.1" min="-180" max="180" value="${Math.round(u.rot * 100) / 100}" data-path="rot" data-type="number" data-target="underlay"><span>°</span></div></div>
          <button class="btn" style="height:32px" data-action="ulRot" data-deg="-0.5" title="0,5° gegen den Uhrzeigersinn">−0,5°</button>
          <button class="btn" style="height:32px" data-action="ulRot" data-deg="0.5" title="0,5° im Uhrzeigersinn">+0,5°</button>
        </div>
        <div class="help" style="margin-top:6px">Positive Werte drehen im Uhrzeigersinn. Die automatische Ausrichtung behält oben und unten bei; liegt die Skizze auf der Seite, mit 90° nachhelfen.</div>
      </div>
      <div class="section">
        <div class="section-title"><span>Maßstab und Lage</span></div>
        <div class="field"><label for="ulWidth">Breite des ganzen Bildes</label><div class="input-unit"><input class="input" id="ulWidth" type="number" step="0.1" min="0.5" max="1000" value="${Math.round(u.width * 100) / 100}" data-path="width" data-type="number" data-target="underlay"><span>m</span></div><div class="help">Genauer geht es über eine gemessene Strecke.</div></div>
        <div class="actions">
          <button class="btn small" data-action="ulMeasure">${ICON('i-ruler')}<span>Strecke messen</span></button>
          <button class="btn small ${moving ? 'primary' : ''}" id="ulMoveBtn" data-action="ulMove" aria-pressed="${moving}">${ICON('i-move')}<span>Verschieben</span></button>
          <button class="btn small" data-action="ulFit" title="Plan und Vorlage ganz anzeigen">${ICON('i-fit')}<span>Anzeigen</span></button>
        </div>
      </div>
      <div class="section">
        <div class="section-title"><span>Wandfang</span></div>
        <div class="checks">
          <label class="check"><input type="checkbox" data-path="snap" data-type="checkbox" data-target="underlay" ${u.snap ? 'checked' : ''}> Beim Zeichnen an Wänden der Vorlage fangen</label>
          <label class="check"><input type="checkbox" data-path="showLines" data-type="checkbox" data-target="underlay" ${u.showLines ? 'checked' : ''}> Erkannte Wandlinien anzeigen</label>
        </div>
        <div class="meta" id="ulLinesInfo">${this.linesInfoHTML(u)}</div>
        <div class="actions"><button class="btn small" data-action="ulRedetect">Linien neu erkennen</button></div>
        <div class="help" style="margin-top:6px">Ecken bestehender Räume haben Vorrang vor der Vorlage. Liegen zwei Wände nah beieinander, fängt der Zeiger an ihrer Ecke.</div>
      </div>
      <div class="actions"><button class="btn danger" data-action="ulRemove">${ICON('i-trash')}<span>Vorlage entfernen</span></button></div>
      <div class="help" style="margin-top:10px">Die Vorlage wird weder gedruckt noch exportiert. Sie bleibt in diesem Browser und in der gespeicherten JSON-Datei. Änderungen an ihr lassen sich nicht mit Strg+Z zurücknehmen.</div>`;
  }

  async importImage(file) {
    const st = this.store;
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      this.toast(file.type === 'application/pdf' ? 'PDF-Dateien lassen sich nicht direkt laden. Bitte die Seite als Bild (PNG oder JPG) speichern oder einen Screenshot machen.' : 'Bitte eine Bilddatei wählen (PNG, JPG oder WebP).', 'warn', 6000);
      return;
    }
    if (st.underlay && !confirm('Die vorhandene Vorlage durch dieses Bild ersetzen?')) return;
    this.setHint('Vorlage wird geladen und ausgerichtet …');
    try {
      const loaded = await loadImageFile(file);
      await new Promise(r => setTimeout(r, 20)); // Hinweis zeichnen lassen, bevor die Analyse rechnet
      const u = createUnderlay(loaded, planExtent(st.plan));
      const res = autoAlign(u);
      const n = detectLines(u);
      this.clearUnderlay(u);
      this.editor.fit();
      this.setTab('underlay');
      const turn = !res.applied ? 'ohne eindeutige Wandrichtung – bitte von Hand drehen'
        : Math.abs(res.delta) < 0.05 ? 'sie liegt bereits gerade' : `um ${fmt1(Math.abs(res.delta))}° geradegestellt`;
      this.toast(`Vorlage geladen, ${turn}. ${n} Wandlinien erkannt. Jetzt den Maßstab festlegen.`, res.applied ? 'ok' : 'warn', 6500);
    } catch (e) {
      console.error(e);
      this.toast('Das Bild konnte nicht gelesen werden. Fotos im HEIC-Format bitte vorher als JPG speichern.', 'danger', 6000);
    } finally {
      this.setHint(TOOL_HINTS[st.tool] || null);
    }
  }

  /** Vorlage ersetzen oder entfernen, laufende Messung verwerfen. */
  clearUnderlay(u = null) {
    this.measured = null;
    this.editor.clearMeasure();
    if (!u && (this.store.tool === 'underlay' || this.store.tool === 'measure')) this.store.setTool('select');
    this.store.setUnderlay(u);
  }

  async alignUnderlay(btn) {
    const st = this.store;
    const u = st.underlay;
    if (!u) return;
    btn?.classList.add('loading');
    await new Promise(r => setTimeout(r, 20));
    try {
      const res = autoAlign(u);
      if (!res.applied) { this.toast('Keine eindeutige Wandrichtung gefunden. Bitte von Hand drehen.', 'warn'); return; }
      if (needsRedetect(u)) detectLines(u);
      st.underlayChanged();
      this.toast(Math.abs(res.delta) < 0.05 ? 'Die Vorlage liegt bereits gerade.' : `Um ${fmt1(Math.abs(res.delta))}° ${res.delta > 0 ? 'im' : 'gegen den'} Uhrzeigersinn gedreht.`, 'ok');
    } finally {
      btn?.classList.remove('loading');
    }
  }

  redetectSoon() {
    clearTimeout(this.redetectTimer);
    this.redetectTimer = setTimeout(() => {
      const u = this.store.underlay;
      if (u && needsRedetect(u)) { detectLines(u); this.store.underlayChanged(); }
    }, 300);
  }

  /** Editor meldet eine gemessene Strecke (oder null bei Abbruch). */
  onMeasured(d, a, b) {
    if (d == null) { this.measured = null; if (this.tab === 'underlay') this.renderUnderlay(); return; }
    this.measured = { d, a, b };
    this.store.setTool('select');
    this.setTab('underlay');
    $('ulRealLen')?.focus();
  }

  applyScale() {
    const st = this.store;
    const u = st.underlay, m = this.measured;
    const input = $('ulRealLen');
    if (!u || !m) return;
    const L = parseFloat(String(input?.value ?? '').replace(',', '.'));
    if (!isFinite(L) || L <= 0) { input?.classList.add('invalid'); input?.focus(); this.toast('Bitte die echte Länge der Strecke in Metern eintragen.', 'warn'); return; }
    const f = L / m.d;
    // der erste Messpunkt bleibt liegen
    u.x = m.a.x + (u.x - m.a.x) * f;
    u.y = m.a.y + (u.y - m.a.y) * f;
    u.width *= f;
    u.calibrated = true;
    this.measured = null;
    this.editor.clearMeasure();
    st.underlayChanged();
    this.renderUnderlay();
    this.editor.fit();
    this.toast(`Maßstab übernommen: Das Bild ist ${fmt(u.width, 1)} m breit.${hasContent(st.plan) ? ' Bereits gezeichnete Räume bleiben unverändert.' : ''}`, 'ok', 5000);
  }

  /* ---------- Panel: Plan ---------- */
  num(label, path, value, { unit = 'mm', step = 0.1, min = 0, max = 1000, help = '', target = 'plan', after = '' } = {}) {
    const id = `f-${path.replace(/\./g, '-')}`;
    return `<div class="field"><label for="${id}">${label}</label><div class="input-unit"><input class="input" id="${id}" type="number" step="${step}" min="${min}" max="${max}" value="${value}" data-path="${path}" data-type="number" data-target="${target}" ${after ? `data-after="${after}"` : ''}>${unit ? `<span>${unit}</span>` : ''}</div>${help ? `<div class="help">${help}</div>` : ''}</div>`;
  }

  plateInfoHTML() {
    const info = plateInfo(this.store.plan);
    const s = this.store.plan.settings;
    const bed = bedSize(s);
    if (!info.ext) return '<span>Noch keine Räume gezeichnet.</span>';
    const fits = info.width <= bed.w && info.height <= bed.h;
    const fitsRot = info.width <= bed.h && info.height <= bed.w;
    return `<span>Grundplatte <b>${Math.round(info.width)} × ${Math.round(info.height)} mm</b></span><span style="color:${fits || fitsRot ? 'var(--ok)' : 'var(--danger)'}">${fits ? 'passt' : fitsRot ? 'passt gedreht' : 'zu groß'} auf ${esc(bed.name)}</span>`;
  }

  frameInfoHTML() {
    const plan = this.store.plan;
    const info = plateInfo(plan);
    if (!info.ext) return '<span>Noch keine Räume gezeichnet.</span>';
    const L = frameLayout(plan, info.width, info.height);
    const n = L.cols * L.rows;
    return `<span>Außenmaß <b>${Math.round(L.W)} × ${Math.round(L.H)} mm</b></span><span>${n === 1 ? 'ein Stück' : `${L.cols} × ${L.rows} Kacheln, je ${Math.round(L.tileW)} × ${Math.round(L.tileH)} mm`}</span><span style="color:${L.fitsBed ? 'var(--ok)' : 'var(--danger)'}">${L.fitsBed ? 'passt' : 'zu groß'} für ${esc(L.bed.name)}</span>`;
  }

  renderPlan() {
    const s = this.store.plan.settings;
    const denom = Math.round(1000 / s.scale * 10) / 10;
    $('tab-plan').innerHTML = `
      <div class="section">
        <div class="section-title"><span>Maßstab und Druckbett</span></div>
        <div class="field"><label for="scaleDenom">Maßstab 1 :</label>
          <div style="display:flex;gap:8px"><input class="input" id="scaleDenom" type="number" step="1" min="5" max="1000" value="${denom}" style="max-width:120px"><button class="btn" data-action="scaleDenom">Übernehmen</button><button class="btn" data-action="fitBed" title="Kleinsten Maßstab wählen, bei dem die Platte aufs Druckbett passt">${ICON('i-fit')}<span>Einpassen</span></button></div>
          <div class="help">1:50 heißt: 1 m im Gebäude = 20 mm im Modell. Braillezellen bleiben immer 6 mm breit, deshalb brauchen beschriftete Räume genug Platz.</div>
        </div>
        <div class="field"><label for="f-bed">Druckbett</label><select class="input" id="f-bed" data-path="settings.bed" data-type="select" data-target="plan" data-after="bed">${BEDS.map(b => `<option value="${b.id}" ${b.id === s.bed ? 'selected' : ''}>${esc(b.name)}${b.id !== 'custom' ? ` (${b.w} × ${b.h} mm)` : ''}</option>`).join('')}</select></div>
        ${s.bed === 'custom' ? `<div class="row">${this.num('Breite', 'settings.bedW', s.bedW, { step: 1, min: 50, max: 1000 })}${this.num('Tiefe', 'settings.bedH', s.bedH, { step: 1, min: 50, max: 1000 })}</div>` : ''}
        <div class="meta" id="plateInfoLine">${this.plateInfoHTML()}</div>
      </div>
      <div class="section">
        <div class="section-title"><span>Grundplatte</span></div>
        <div class="row three">
          ${this.num('Rand', 'settings.plate.margin', s.plate.margin, { step: 1, min: 0, max: 50 })}
          ${this.num('Dicke', 'settings.plate.thickness', s.plate.thickness, { step: 0.2, min: 1, max: 10 })}
          ${this.num('Eckenradius', 'settings.plate.cornerRadius', s.plate.cornerRadius, { step: 1, min: 0, max: 30 })}
        </div>
      </div>
      <div class="section">
        <div class="section-title"><span>Wände und Türen</span></div>
        <div class="row">
          ${this.num('Wandhöhe über Platte', 'settings.wall.height', s.wall.height, { step: 0.1, min: 0.5, max: 10 })}
          ${this.num('Wanddicke', 'settings.wall.thickness', s.wall.thickness, { step: 0.1, min: 0.8, max: 5, help: 'Wände liegen innerhalb der Raumgrenze; angrenzende Räume ergeben doppelte Wände.' })}
        </div>
        <div class="row">
          ${this.num('Standard-Türbreite', 'settings.door.width', s.door.width, { unit: 'm', step: 0.05, min: 0.3, max: 5 })}
          ${this.num('Schwellenhöhe', 'settings.door.thresholdHeight', s.door.thresholdHeight, { step: 0.1, min: 0, max: 5 })}
        </div>
        <div class="checks"><label class="check"><input type="checkbox" data-path="settings.door.threshold" data-type="checkbox" data-target="plan" ${s.door.threshold ? 'checked' : ''}> Neue Türen mit Schwelle</label></div>
      </div>
      <div class="section">
        <div class="section-title"><span>Bereiche (Zonen ohne Wände)</span></div>
        <div class="row">
          ${this.num('Linienhöhe', 'settings.zone.height', s.zone.height, { step: 0.1, min: 0.3, max: 5 })}
          ${this.num('Liniendicke', 'settings.zone.thickness', s.zone.thickness, { step: 0.1, min: 0.6, max: 5 })}
        </div>
        <div class="checks"><label class="check"><input type="checkbox" data-path="settings.zone.dashed" data-type="checkbox" data-target="plan" ${s.zone.dashed ? 'checked' : ''}> Gestrichelt (tastbar von Wänden unterscheidbar)</label></div>
        ${s.zone.dashed ? `<div class="row">${this.num('Strichlänge', 'settings.zone.dash', s.zone.dash, { step: 0.5, min: 1, max: 20 })}${this.num('Lücke', 'settings.zone.gap', s.zone.gap, { step: 0.5, min: 0.5, max: 20 })}</div>` : ''}
      </div>
      <div class="section">
        <div class="section-title"><span>Brailleschrift</span><button class="btn small" data-action="brailleDefaults" title="Punktabstand 2,5 · Zeichen 6,0 · Zeile 10,0 · Punkt Ø 1,5 · Höhe 0,6">Marburg Medium</button></div>
        <div class="field"><label for="f-bsys">Schriftsystem</label><select class="input" id="f-bsys" data-path="settings.braille.system" data-type="select" data-target="plan"><option value="basis" ${s.braille.system === 'basis' ? 'selected' : ''}>Basisschrift (buchstabengetreu)</option><option value="voll" ${s.braille.system === 'voll' ? 'selected' : ''}>Vollschrift (mit Lautgruppen au, ei, ch, sch, st …)</option></select><div class="help">Vollschrift wird automatisch gesetzt und kennt keine Wortfugen („Haus|tür“ trennt mit „|“). Im Zweifel Basisschrift oder einen Braille-Leser fragen.</div></div>
        <div class="checks"><label class="check"><input type="checkbox" data-path="settings.braille.capitals" data-type="checkbox" data-target="plan" ${s.braille.capitals ? 'checked' : ''}> Großschreibzeichen setzen (⠨)</label></div>
        <div class="row three">
          ${this.num('Punktabstand', 'settings.braille.dotPitch', s.braille.dotPitch, { step: 0.1, min: 2, max: 4 })}
          ${this.num('Zeichenabstand', 'settings.braille.cellPitch', s.braille.cellPitch, { step: 0.1, min: 4, max: 10 })}
          ${this.num('Zeilenabstand', 'settings.braille.linePitch', s.braille.linePitch, { step: 0.5, min: 6, max: 20 })}
        </div>
        <div class="row">
          ${this.num('Punktdurchmesser', 'settings.braille.dotDiameter', s.braille.dotDiameter, { step: 0.1, min: 1, max: 2.5 })}
          ${this.num('Punkthöhe', 'settings.braille.dotHeight', s.braille.dotHeight, { step: 0.1, min: 0.3, max: 1.5, help: 'Üblich 0,5–0,8 mm, kuppelförmig.' })}
        </div>
      </div>
      <div class="section">
        <div class="section-title"><span>Profilschrift für Sehende</span></div>
        <div class="checks"><label class="check"><input type="checkbox" data-path="settings.text.enabled" data-type="checkbox" data-target="plan" ${s.text.enabled ? 'checked' : ''}> Erhabene Buchstaben über der Brailleschrift</label></div>
        <div class="row">
          ${this.num('Schriftgröße', 'settings.text.size', s.text.size, { step: 0.5, min: 3, max: 20 })}
          ${this.num('Höhe', 'settings.text.height', s.text.height, { step: 0.1, min: 0.2, max: 3 })}
        </div>
      </div>
      <div class="section">
        <div class="section-title"><span>Orientierungsmarker</span></div>
        <div class="row">
          ${this.num('Größe', 'settings.marker.size', s.marker.size, { step: 0.5, min: 4, max: 20, help: 'Durchmesser des Standort-Kreises; Pfeil und Quadrat richten sich danach.' })}
          ${this.num('Höhe', 'settings.marker.height', s.marker.height, { step: 0.1, min: 0.4, max: 4, help: 'Höher als Braillepunkte, damit das Symbol auffällt.' })}
        </div>
      </div>
      <div class="section">
        <div class="section-title"><span>Rahmen (Wanne zum Einlegen)</span></div>
        <div class="row">
          ${this.num('Randbreite', 'settings.frame.rimW', s.frame.rimW, { step: 0.5, min: 3, max: 30 })}
          ${this.num('Rückwand', 'settings.frame.backT', s.frame.backT, { step: 0.5, min: 1.5, max: 10, help: 'Ab 2,5 mm passen Schlüssellöcher hinein.' })}
        </div>
        <div class="row">
          ${this.num('Rand über Plattenoberkante', 'settings.frame.rimOver', s.frame.rimOver, { step: 0.5, min: -2, max: 10, help: '0 = bündig mit der Platte.' })}
          ${this.num('Spiel zur Platte', 'settings.frame.clearance', s.frame.clearance, { step: 0.1, min: 0, max: 2 })}
        </div>
        <div class="field"><label for="f-fsplit">Teilung</label><select class="input" id="f-fsplit" data-path="settings.frame.split" data-type="select" data-target="plan"><option value="auto" ${s.frame.split !== 'manual' ? 'selected' : ''}>Automatisch nach Druckbett</option><option value="manual" ${s.frame.split === 'manual' ? 'selected' : ''}>Manuell</option></select></div>
        ${s.frame.split === 'manual' ? `<div class="row">${this.num('Spalten', 'settings.frame.cols', s.frame.cols, { unit: '', step: 1, min: 1, max: 6 })}${this.num('Reihen', 'settings.frame.rows', s.frame.rows, { unit: '', step: 1, min: 1, max: 6 })}</div>` : ''}
        <div class="field"><label for="f-fjoint">Verbindung der Kacheln</label><select class="input" id="f-fjoint" data-path="settings.frame.joint" data-type="select" data-target="plan"><option value="dovetail" ${s.frame.joint !== 'none' ? 'selected' : ''}>Schwalbenschwanz (stecken und kleben)</option><option value="none" ${s.frame.joint === 'none' ? 'selected' : ''}>Stumpf (nur kleben)</option></select></div>
        <div class="checks"><label class="check"><input type="checkbox" data-path="settings.frame.keyholes" data-type="checkbox" data-target="plan" ${s.frame.keyholes ? 'checked' : ''}> Schlüssellöcher zum Aufhängen (oberste Reihe)</label></div>
        <div class="meta" id="frameInfoLine">${this.frameInfoHTML()}</div>
      </div>
      <div class="section">
        <div class="section-title"><span>Farben</span><span class="hint">Vorschau und 3MF</span></div>
        <div class="row">
          <div class="field"><label>Grundplatte</label><div class="color-field"><input type="color" value="${esc(s.colors.base)}" data-path="settings.colors.base" data-type="color" data-target="plan"><span class="help">${esc(s.colors.base)}</span></div></div>
          <div class="field"><label>Erhabene Teile</label><div class="color-field"><input type="color" value="${esc(s.colors.raised)}" data-path="settings.colors.raised" data-type="color" data-target="plan"><span class="help">${esc(s.colors.raised)}</span></div></div>
          <div class="field"><label>Rahmen</label><div class="color-field"><input type="color" value="${esc(s.colors.frame || '#cbc3b4')}" data-path="settings.colors.frame" data-type="color" data-target="plan"><span class="help">${esc(s.colors.frame || '#cbc3b4')}</span></div></div>
        </div>
        <div class="help">Kontrastreiche Paare helfen Menschen mit Sehrest: helle Platte, dunkle Wände und Punkte.</div>
      </div>
      <div class="actions"><button class="btn" data-action="resetSettings">Maße zurücksetzen</button></div>`;
  }

  /* ---------- Panel: Export ---------- */
  exportInfoHTML() {
    const plan = this.store.plan;
    const s = plan.settings;
    const info = plateInfo(plan);
    const o = this.exportOpts;
    const rooms = plan.rooms.filter(r => r.type === 'room').length;
    const legendCount = legendEntries(plan).length + markerLegendEntries(plan).length;
    const layer = s.plate.thickness;
    const layers02 = Math.round(layer / 0.2);
    let scopeText = '';
    if (o.scope === 'whole') scopeText = `Eine Platte ${Math.round(info.width)} × ${Math.round(info.height)} mm`;
    else if (o.scope === 'rooms') scopeText = `${rooms} Raumteil${rooms === 1 ? '' : 'e'} mit eigenem Boden${o.surround ? ' + Umgebungsplatte' : ''}`;
    else scopeText = 'Nur der ausgewählte Raum';
    return `
      <div class="big">${esc(scopeText)}</div>
      <div class="small">${o.split ? (o.format === '3mf' ? 'Grundplatte und erhabene Teile als getrennte Teile eines Objekts – im Slicer je ein Filament zuweisen.' : 'Grundplatte und erhabene Teile als getrennte STL-Dateien (ZIP) – im Slicer zusammenfügen und je ein Filament zuweisen.') : `Ein Körper. Filamentwechsel im Slicer bei <b>${fmt1(layer)} mm</b> einfügen (Oberkante Grundplatte, bei 0,2 mm Schichten nach Schicht ${layers02}).`}</div>
      ${o.legend && o.scope !== 'selected' ? `<div class="small" style="margin-top:4px">Legende: ${legendCount ? `${legendCount} Einträge als eigene Tafel` : 'keine Einträge (weder Kurzbezeichnungen noch Marker) – wird weggelassen'}</div>` : ''}`;
  }

  renderExport() {
    const o = this.exportOpts;
    const st = this.store;
    const sel = st.selection;
    const selRoom = sel && (sel.type === 'room' || sel.type === 'vertex' || sel.type === 'door') ? st.room(sel.id ?? sel.roomId) : null;
    const hasSelRoom = selRoom && selRoom.type === 'room';
    if (o.scope === 'selected' && !hasSelRoom) o.scope = 'whole';
    const card = (key, value, title, desc, disabled = false) => `<label class="radio-card ${o[key] === value ? 'active' : ''} ${disabled ? 'disabled' : ''}" ${disabled ? 'style="opacity:.5"' : ''}><input type="radio" name="x-${key}" ${o[key] === value ? 'checked' : ''} ${disabled ? 'disabled' : ''} data-action="exportOpt" data-key="${key}" data-value="${value}"><div><div class="rc-title">${title}</div><div class="rc-desc">${desc}</div></div></label>`;
    const none = !hasContent(st.plan);
    $('tab-export').innerHTML = `
      ${none ? `<div class="notice info">${ICON('i-info')}<div>Erst einen Grundriss zeichnen oder den Beispielplan laden.</div></div>` : ''}
      <div class="section">
        <div class="section-title"><span>Format</span></div>
        <div class="radio-cards">
          ${card('format', '3mf', '3MF', 'Mehrere Teile und Farben in einer Datei. Empfohlen für Bambu Studio.')}
          ${card('format', 'stl', 'STL', 'Ein Netz je Datei. Mehrere Teile kommen als ZIP.')}
        </div>
      </div>
      <div class="section">
        <div class="section-title"><span>Umfang</span></div>
        <div class="radio-cards">
          ${card('scope', 'whole', 'Gesamtplatte', 'Alle Räume auf einer Grundplatte mit Rand.')}
          ${card('scope', 'rooms', 'Räume einzeln', 'Jeder Raum als Puzzleteil mit eigenem Boden – für verschiedene Farben oder große Pläne.')}
          ${card('scope', 'selected', 'Ausgewählter Raum', hasSelRoom ? `Nur „${esc(selRoom.name)}“ als Einzelteil.` : 'Dafür zuerst einen Raum auswählen.', !hasSelRoom)}
        </div>
      </div>
      <div class="section">
        <div class="section-title"><span>Farbtrennung</span></div>
        <div class="radio-cards">
          ${card('split', true, 'Grundplatte und erhabene Teile getrennt', 'Zwei Teile pro Stück – im Slicer je ein Filament zuweisen.')}
          ${card('split', false, 'Ein Körper', 'Alles in einem Netz. Farbwechsel über einen Filamentwechsel an der Schicht.')}
        </div>
      </div>
      <div class="section">
        <div class="checks">
          <label class="check"><input type="checkbox" data-action="toggleLegend" ${o.legend ? 'checked' : ''} ${o.scope === 'selected' ? 'disabled' : ''}> Legende als eigene Tafel beilegen</label>
          ${o.scope === 'rooms' ? `<label class="check"><input type="checkbox" data-action="toggleSurround" ${o.surround ? 'checked' : ''}> Restliche Grundplatte (Rand und Zwischenräume) als Teil „Umgebung“</label>` : ''}
        </div>
      </div>
      <div class="export-info" id="exportInfo">${this.exportInfoHTML()}</div>
      ${this.buildWarnings.length ? this.warningsHTML(this.buildWarnings.map(t => ({ kind: 'warn', text: t }))) : ''}
      <button class="btn primary block" id="btnDoExport" data-action="export" ${none ? 'disabled' : ''}>${ICON('i-download')}<span>${o.format === '3mf' ? '3MF' : 'STL'} herunterladen</span></button>
      <div class="section" style="margin-top:22px">
        <div class="section-title"><span>Rahmen zum Einlegen</span><span class="hint">Maße im Tab „Plan“</span></div>
        <div class="meta" style="margin-bottom:10px">${none ? '<span>Erst Räume zeichnen.</span>' : this.frameInfoHTML()}</div>
        <div class="help" style="margin-bottom:10px">Wanne mit Rückwand und Rand; Platte oder Raumteile einlegen und verkleben. Kacheln mit Schwalbenschwanz zusammenstecken, Schlüssellöcher auf der Rückseite zum Aufhängen. Rückwand nach unten drucken.</div>
        <button class="btn block" id="btnDoExportFrame" data-action="exportFrame" ${none ? 'disabled' : ''}>${ICON('i-download')}<span>Rahmen als ${o.format === '3mf' ? '3MF' : 'STL'} herunterladen</span></button>
      </div>
      <div class="help" style="margin-top:10px">Tipp: Erst in der <button class="btn small" data-action="view3d" style="vertical-align:middle">${ICON('i-cube')}<span>3D-Vorschau</span></button> prüfen. Datei danach in Bambu Studio öffnen oder importieren.</div>`;
  }

  async doExport() {
    const btn = $('btnDoExport');
    btn?.classList.add('loading');
    await new Promise(r => setTimeout(r, 30));
    try {
      const o = this.exportOpts;
      const st = this.store;
      const plan = st.plan;
      const sel = st.selection;
      const selRoom = sel && (sel.type === 'room' || sel.type === 'vertex' || sel.type === 'door') ? st.room(sel.id ?? sel.roomId) : null;
      const scope = o.scope === 'selected' ? 'rooms' : o.scope;
      const roomIds = o.scope === 'selected' && selRoom ? [selRoom.id] : undefined;
      const model = buildModel(plan, { scope, roomIds, overlap: o.split ? 0 : 0.2, legend: o.legend && o.scope !== 'selected', surround: o.surround });
      this.buildWarnings = model.warnings;
      if (!model.pieces.length) { this.toast('Nichts zu exportieren – der Plan enthält keine Räume.', 'warn'); return; }
      const base = `raumgefuehl-${safeName(plan.name)}`;
      const suffix = o.scope === 'whole' ? 'gesamt' : o.scope === 'rooms' ? 'raeume-einzeln' : safeName(selRoom?.name);
      if (o.format === '3mf') {
        const data = threeMF(model.pieces, { split: o.split, title: plan.name, baseColor: plan.settings.colors.base, raisedColor: plan.settings.colors.raised });
        download(data, `${base}-${suffix}.3mf`, 'model/3mf');
      } else {
        const files = [];
        for (const piece of model.pieces) {
          const pname = safeName(piece.name);
          if (o.split) {
            const basePart = piece.parts.filter(p => p.kind === 'base').map(p => p.tris);
            const raised = piece.parts.filter(p => p.kind !== 'base').map(p => p.tris);
            if (basePart.length) files.push({ name: `${pname}-grundplatte.stl`, data: stlBinary(basePart, piece.name) });
            if (raised.length) files.push({ name: `${pname}-erhaben.stl`, data: stlBinary(raised, piece.name) });
          } else {
            files.push({ name: `${pname}.stl`, data: stlBinary(piece.parts.map(p => p.tris), piece.name) });
          }
        }
        if (files.length === 1) download(files[0].data, `${base}-${suffix}.stl`, 'model/stl');
        else download(zipFiles(files), `${base}-${suffix}-stl.zip`, 'application/zip');
      }
      this.toast(`Export fertig: ${model.pieces.length} Teil${model.pieces.length === 1 ? '' : 'e'}, ${model.info.triangles.toLocaleString('de-DE')} Dreiecke.`, 'ok');
      this.renderExport();
    } catch (e) {
      console.error(e);
      this.toast(`Export fehlgeschlagen: ${e.message}`, 'danger', 6000);
    } finally {
      btn?.classList.remove('loading');
    }
  }

  async doExportFrame() {
    const btn = $('btnDoExportFrame');
    btn?.classList.add('loading');
    await new Promise(r => setTimeout(r, 30));
    try {
      const plan = this.store.plan;
      const info = plateInfo(plan);
      if (!info.ext) { this.toast('Erst Räume zeichnen.', 'warn'); return; }
      const fr = buildFrame(plan, info.width, info.height);
      this.buildWarnings = fr.warnings;
      const base = `raumgefuehl-${safeName(plan.name)}-rahmen`;
      if (this.exportOpts.format === '3mf') {
        download(threeMF(fr.pieces, { split: false, title: `${plan.name} – Rahmen`, raisedColor: plan.settings.colors.frame }), `${base}.3mf`, 'model/3mf');
      } else {
        const files = fr.pieces.map(p => ({ name: `${safeName(p.name)}.stl`, data: stlBinary(p.parts.map(x => x.tris), p.name) }));
        if (files.length === 1) download(files[0].data, `${base}.stl`, 'model/stl');
        else download(zipFiles(files), `${base}-stl.zip`, 'application/zip');
      }
      const n = fr.pieces.length;
      this.toast(`Rahmen exportiert: ${n === 1 ? 'ein Stück' : `${n} Kacheln`}, ${Math.round(fr.layout.W)} × ${Math.round(fr.layout.H)} mm.`, 'ok');
      this.renderExport();
    } catch (e) {
      console.error(e);
      this.toast(`Rahmen-Export fehlgeschlagen: ${e.message}`, 'danger', 6000);
    } finally {
      btn?.classList.remove('loading');
    }
  }

  /* ---------- Datei ---------- */
  saveJSON() {
    const plan = this.store.plan;
    const u = this.store.underlay;
    const data = u ? { ...plan, underlay: serializeUnderlay(u) } : plan;
    download(JSON.stringify(data, null, 2), `raumgefuehl-${safeName(plan.name)}.json`, 'application/json');
    this.toast(u ? 'Plan mit Vorlage als JSON gespeichert.' : 'Plan als JSON gespeichert.', 'ok');
  }

  loadExample() {
    const st = this.store;
    if ((hasContent(st.plan) || st.underlay) && !confirm('Beispielplan laden? Der aktuelle Plan und die Vorlage werden ersetzt.')) return;
    st.setPlan(examplePlan());
    this.clearUnderlay();
    this.editor.fit();
    this.setTab('selection');
    this.toast('Beispielplan geladen: Empfang mit Anmeldung und Wartebereich, Flur, Sprechzimmer, Labor.', 'ok', 5000);
  }
}

function hasContent(plan) {
  return !!(plan.rooms.length || plan.labels.length || plan.markers.length);
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
  o[parts[parts.length - 1]] = value;
}
