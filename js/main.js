// Einstieg: Store, Editor, Panels und 3D-Vorschau verbinden.
import { Store } from './state.js';
import { Editor } from './editor2d.js';
import { UI } from './ui.js';
import { setTextMeasurer } from './labels.js';
import { setTextProvider, buildModel } from './model3d.js';
import { bedSize } from './state.js';

const store = new Store();
store.loadSaved();

const canvas = document.getElementById('editor');
let ui = null;
const editor = new Editor(canvas, store, {
  onCursor: (p) => ui?.setCursor(p),
  onZoom: (z) => ui?.setZoom(z),
  onHint: (t) => ui?.setHint(t),
  toast: (m, k) => ui?.toast(m, k),
  onCreated: (type) => ui?.onCreated(type),
});

/* ---------- 3D-Vorschau (verzögert geladen) ---------- */
const previewEl = document.getElementById('preview');
const previewCanvas = document.getElementById('previewCanvas');
const previewFallback = document.getElementById('previewFallback');
const previewStats = document.getElementById('previewStats');
let preview = null;
let previewFailed = false;
const previewOpts = { colorMode: 'split', scope: 'whole', legend: false };

const previewCtl = {
  visible: false,
  async show() {
    this.visible = true;
    previewEl.hidden = false;
    if (!preview && !previewFailed) {
      try {
        const mod = await import('./preview3d.js');
        preview = new mod.Preview(previewCanvas);
      } catch (e) {
        previewFailed = true;
        previewFallback.hidden = false;
        previewFallback.textContent = 'Die 3D-Vorschau konnte nicht geladen werden (Three.js vom CDN nicht erreichbar). Der Export funktioniert trotzdem.';
        return;
      }
    }
    this.rebuild();
  },
  hide() { this.visible = false; previewEl.hidden = true; },
  rebuild() {
    if (!preview) return;
    const plan = store.plan;
    const model = buildModel(plan, { scope: previewOpts.scope, overlap: 0, legend: previewOpts.legend });
    preview.setModel(model, { colorMode: previewOpts.colorMode, baseColor: plan.settings.colors.base, raisedColor: plan.settings.colors.raised, bed: bedSize(plan.settings) });
    const dims = model.pieces.length ? `${Math.round(model.info.plateWidth)} × ${Math.round(model.info.plateHeight)} mm` : '';
    previewStats.textContent = `${model.pieces.length} Teil${model.pieces.length === 1 ? '' : 'e'} · ${model.info.triangles.toLocaleString('de-DE')} Dreiecke${dims ? ' · ' + dims : ''}`;
    if (model.warnings.length) ui?.showWarnings(model.warnings);
  },
  setOption(k, v) { previewOpts[k] = v; this.rebuild(); },
};

previewEl.querySelectorAll('[data-colormode]').forEach(b => b.addEventListener('click', () => {
  previewEl.querySelectorAll('[data-colormode]').forEach(x => x.classList.toggle('active', x === b));
  previewCtl.setOption('colorMode', b.dataset.colormode);
}));
previewEl.querySelectorAll('[data-scope]').forEach(b => b.addEventListener('click', () => {
  previewEl.querySelectorAll('[data-scope]').forEach(x => x.classList.toggle('active', x === b));
  previewCtl.setOption('scope', b.dataset.scope);
}));
document.getElementById('previewLegend').addEventListener('change', (e) => previewCtl.setOption('legend', e.target.checked));
document.getElementById('btnRebuild').addEventListener('click', () => previewCtl.rebuild());

ui = new UI(store, editor, previewCtl);

store.subscribe((what) => {
  editor.render();
  ui.refresh(what);
});
ui.refresh('init');
editor.fit();

/* ---------- 3D-Schrift laden ---------- */
(async () => {
  try {
    const t3 = await import('./text3d.js');
    await t3.loadFont();
    setTextMeasurer(t3.measure);
    setTextProvider(t3.triangles);
    store.touch();
  } catch (e) {
    ui.toast('Die 3D-Schrift konnte nicht geladen werden. Beschriftungen werden nur in Braille ausgegeben.', 'warn', 6000);
  }
})();
