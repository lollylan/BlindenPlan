// Vorlage: Grundriss-Skizze als durchscheinendes Bild unter dem Plan.
// Laden und verkleinern, automatisch geradestellen, Wandlinien für den Fang erkennen.
// Die Vorlage gehört nicht zum Plan-Verlauf (kein Undo) und wird nie exportiert.

const MAX_SIDE = 2400;       // gespeicherte Bildgröße, lange Seite in px
const LINE_SIDE = 1000;      // Arbeitsgröße der Linienerkennung
const DEFAULT_LONG_SIDE = 20; // angenommene Gebäudegröße in m, bis der Maßstab gemessen ist

/* ---------- Laden ---------- */

export function imageFromSrc(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Bild nicht lesbar'));
    img.src = src;
  });
}

/** Datei lesen, auf MAX_SIDE verkleinern und als JPEG-Data-URL ablegen. */
export async function loadImageFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const raw = await imageFromSrc(url);
    const w = raw.naturalWidth, h = raw.naturalHeight;
    if (!w || !h) throw new Error('Bild ist leer');
    const s = Math.min(1, MAX_SIDE / Math.max(w, h));
    const cv = document.createElement('canvas');
    cv.width = Math.round(w * s); cv.height = Math.round(h * s);
    const g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); // transparente PNGs auf Papierweiß
    g.imageSmoothingQuality = 'high';
    g.drawImage(raw, 0, 0, cv.width, cv.height);
    const src = cv.toDataURL('image/jpeg', 0.88);
    const img = await imageFromSrc(src);
    return { src, img, name: file.name || 'Vorlage' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Neue Vorlage: lange Seite DEFAULT_LONG_SIDE m, mittig auf vorhandene Räume oder mit der Ecke im Ursprung. */
export function createUnderlay({ src, img, name }, ext) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const width = DEFAULT_LONG_SIDE * w / Math.max(w, h);
  const height = width * h / w;
  const center = ext ? { x: (ext.minX + ext.maxX) / 2, y: (ext.minY + ext.maxY) / 2 } : { x: width / 2, y: height / 2 };
  return {
    src, img, name, w, h,
    x: center.x, y: center.y, width, rot: 0,
    opacity: 0.55, visible: true, snap: true, showLines: false, calibrated: false,
    lines: [], linesRot: null, version: 0,
  };
}

export function serializeUnderlay(u) {
  return { src: u.src, name: u.name, x: u.x, y: u.y, width: u.width, rot: u.rot, opacity: u.opacity, visible: u.visible, snap: u.snap, showLines: u.showLines, calibrated: u.calibrated };
}

export async function restoreUnderlay(raw) {
  if (!raw || typeof raw.src !== 'string' || !raw.src.startsWith('data:image/')) return null;
  const img = await imageFromSrc(raw.src);
  const u = createUnderlay({ src: raw.src, img, name: typeof raw.name === 'string' ? raw.name : 'Vorlage' }, null);
  const num = (v, fb) => (typeof v === 'number' && isFinite(v) ? v : fb);
  u.x = num(raw.x, u.x); u.y = num(raw.y, u.y);
  u.width = Math.max(0.5, num(raw.width, u.width));
  u.rot = num(raw.rot, 0);
  u.opacity = Math.max(0.05, Math.min(1, num(raw.opacity, u.opacity)));
  u.visible = raw.visible !== false; u.snap = raw.snap !== false; u.showLines = raw.showLines === true; u.calibrated = raw.calibrated === true;
  detectLines(u);
  return u;
}

/* ---------- Abbildung Bildpixel → Plan (Meter) ---------- */

export function toPlan(u, pt) {
  const k = u.width / u.w;
  const r = u.rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const dx = (pt.x - u.w / 2) * k, dy = (pt.y - u.h / 2) * k;
  return { x: u.x + dx * c - dy * s, y: u.y + dx * s + dy * c };
}

export function underlayCorners(u) {
  return [{ x: 0, y: 0 }, { x: u.w, y: 0 }, { x: u.w, y: u.h }, { x: 0, y: u.h }].map(p => toPlan(u, p));
}

/** Erkannte Linien in Planmetern, zwischengespeichert bis zur nächsten Verschiebung/Drehung. */
export function planLines(u) {
  if (u._planVer === u.version && u._planLines) return u._planLines;
  u._planLines = u.lines.map(l => {
    const a = toPlan(u, l.a), b = toPlan(u, l.b);
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { a, b, L, d: { x: (b.x - a.x) / L, y: (b.y - a.y) / L } };
  });
  u._planVer = u.version;
  return u._planLines;
}

export const normDeg = (d) => { let v = ((d % 360) + 360) % 360; if (v > 180) v -= 360; return Math.round(v * 1000) / 1000; };

/** Liegen die Linien noch achsparallel zur aktuellen Drehung? Sonst neu erkennen. */
export function needsRedetect(u) {
  if (u.linesRot == null) return true;
  const d = ((u.rot - u.linesRot) % 90 + 90) % 90;
  return Math.min(d, 90 - d) > 0.2;
}

/* ---------- Rasterisieren ---------- */

/** Bild gedreht (Grad, im Uhrzeigersinn) auf eine Arbeitsfläche zeichnen und als Graustufen liefern. */
function rasterize(img, rotDeg, maxSide, withMask = false) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const s = Math.min(1, maxSide / Math.max(w, h));
  const r = rotDeg * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
  const W = Math.max(1, Math.ceil((w * Math.abs(cos) + h * Math.abs(sin)) * s));
  const H = Math.max(1, Math.ceil((w * Math.abs(sin) + h * Math.abs(cos)) * s));
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.fillStyle = withMask ? paperColor(img) : '#fff'; g.fillRect(0, 0, W, H);
  g.translate(W / 2, H / 2); g.rotate(r); g.scale(s, s);
  g.drawImage(img, -w / 2, -h / 2);
  const d = g.getImageData(0, 0, W, H).data;
  const gray = new Uint8ClampedArray(W * H);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) gray[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  let inside = null;
  if (withMask) {
    // Bildfläche ohne einen schmalen Randstreifen: die Bildkante selbst ist keine Wand
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    g.translate(W / 2, H / 2); g.rotate(r); g.scale(s, s);
    g.fillStyle = '#fff'; g.fillRect(-w / 2, -h / 2, w, h);
    g.strokeStyle = '#000'; g.lineWidth = 12 / s; g.strokeRect(-w / 2, -h / 2, w, h);
    const m = g.getImageData(0, 0, W, H).data;
    inside = new Uint8Array(W * H);
    for (let i = 0, j = 0; j < inside.length; i += 4, j++) inside[j] = m[i] > 127 ? 1 : 0;
  }
  // Arbeitsfläche → Bildpixel (Umkehrung von Drehung und Skalierung)
  const toImage = (X, Y) => {
    const dx = (X - W / 2) / s, dy = (Y - H / 2) / s;
    return { x: w / 2 + dx * cos + dy * sin, y: h / 2 - dx * sin + dy * cos };
  };
  return { gray, W, H, toImage, inside };
}

/** Mittlere Farbe des Bildes, als Hintergrund der gedrehten Arbeitsfläche (sonst wirkt der Rand dunkel). */
function paperColor(img) {
  const cv = document.createElement('canvas'); cv.width = 1; cv.height = 1;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, 1, 1);
  const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
  return `rgb(${r},${gr},${b})`;
}

/* ---------- Automatisch geradestellen ---------- */

/**
 * Hauptrichtung der Kanten (modulo 90°) über ein Gradienten-Histogramm schätzen
 * und per Projektionsprofil verfeinern. Liefert die Drehung, die die Wände
 * achsparallel stellt, sowie ein Maß für die Eindeutigkeit.
 */
export function detectAngle(img) {
  const { gray: g, W, H } = rasterize(img, 0, 640);
  const bins = new Float64Array(180); // 0,5°-Schritte über 0…90°
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = (g[i - W + 1] + 2 * g[i + 1] + g[i + W + 1]) - (g[i - W - 1] + 2 * g[i - 1] + g[i + W - 1]);
      const gy = (g[i + W - 1] + 2 * g[i + W] + g[i + W + 1]) - (g[i - W - 1] + 2 * g[i - W] + g[i - W + 1]);
      const m = Math.hypot(gx, gy);
      if (m < 80) continue;
      const a = Math.atan2(gy, gx) * 180 / Math.PI;
      const t = ((a % 90) + 90) % 90;
      bins[Math.floor(t * 2) % 180] += m;
    }
  }
  const sm = new Float64Array(180);
  let total = 0;
  for (let k = 0; k < 180; k++) {
    for (let j = -3; j <= 3; j++) sm[k] += bins[(k + j + 180) % 180] * (4 - Math.abs(j));
    total += sm[k];
  }
  if (total <= 0) return { angle: 0, confidence: 0 };
  let best = 0;
  for (let k = 1; k < 180; k++) if (sm[k] > sm[best]) best = k;
  let wsum = 0, osum = 0;
  for (let j = -3; j <= 3; j++) { const v = bins[(best + j + 180) % 180]; wsum += v; osum += v * j; }
  let theta = (((best + 0.5 + (wsum ? osum / wsum : 0)) / 2) % 90 + 90) % 90;
  if (theta > 45) theta -= 90;
  const confidence = sm[best] / (total / 180);

  // Feinabgleich: bei geraden Wänden werden Zeilen- und Spaltensummen am schärfsten
  let rot = -theta;
  const refine = (center, span, step) => {
    let bestRot = center, bestScore = -1;
    for (let d = -span; d <= span + 1e-9; d += step) {
      const sc = projectionScore(img, center + d);
      if (sc > bestScore) { bestScore = sc; bestRot = center + d; }
    }
    return bestRot;
  };
  if (confidence >= 2) {
    rot = refine(rot, 1.2, 0.1);
    rot = refine(rot, 0.1, 0.025);
  }
  return { angle: Math.round(rot * 100) / 100, confidence };
}

function projectionScore(img, rotDeg) {
  const { gray, W, H } = rasterize(img, rotDeg, 480);
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  const thr = sum / gray.length - 40;
  const rows = new Float64Array(H), cols = new Float64Array(W);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (gray[y * W + x] < thr) { rows[y]++; cols[x]++; }
  let s = 0;
  for (let y = 0; y < H; y++) s += rows[y] * rows[y];
  for (let x = 0; x < W; x++) s += cols[x] * cols[x];
  return s;
}

/**
 * Vorlage geradestellen. Die bisherige 90°-Lage bleibt erhalten, damit ein von Hand
 * gewähltes „oben“ nicht verloren geht.
 */
export function autoAlign(u) {
  const res = detectAngle(u.img);
  if (res.confidence < 2) return { ...res, applied: false, delta: 0 };
  const quarter = Math.round((u.rot - res.angle) / 90) * 90;
  const next = normDeg(res.angle + quarter);
  const delta = normDeg(next - u.rot);
  u.rot = next;
  return { ...res, applied: true, delta };
}

/* ---------- Wandlinien erkennen ---------- */

/**
 * Lange, achsparallele dunkle Striche in der Vorlage finden (in der aktuellen Drehung).
 * Ergebnis in Bildpixeln, damit Verschieben und Skalieren die Linien mitnehmen.
 */
export function detectLines(u) {
  const { gray, W, H, toImage, inside } = rasterize(u.img, u.rot, LINE_SIDE, true);
  // adaptive Schwelle gegen ungleichmäßig ausgeleuchtete Fotos
  const W1 = W + 1;
  const integ = new Float64Array(W1 * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) { row += gray[y * W + x]; integ[(y + 1) * W1 + x + 1] = integ[y * W1 + x + 1] + row; }
  }
  const big = Math.max(W, H);
  const R = Math.max(10, Math.round(big / 16));
  const dark = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - R), y1 = Math.min(H, y + R + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - R), x1 = Math.min(W, x + R + 1);
      const sum = integ[y1 * W1 + x1] - integ[y0 * W1 + x1] - integ[y1 * W1 + x0] + integ[y0 * W1 + x0];
      const v = gray[y * W + x];
      if (inside[y * W + x] && v < 200 && v < sum / ((x1 - x0) * (y1 - y0)) - 22) dark[y * W + x] = 1;
    }
  }
  const minLen = Math.max(18, Math.round(big * 0.03));
  const maxThick = Math.max(6, Math.round(big * 0.04));
  const segs = [...scanRuns(dark, W, H, true, minLen, maxThick), ...scanRuns(dark, W, H, false, minLen, maxThick)];

  u.lines = segs
    .sort((p, q) => (q.s1 - q.s0) - (p.s1 - p.s0))
    .slice(0, 400)
    .map(sg => sg.horiz
      ? { a: toImage(sg.s0, sg.c), b: toImage(sg.s1, sg.c) }
      : { a: toImage(sg.c, sg.s0), b: toImage(sg.c, sg.s1) });
  u.linesRot = u.rot;
  u._planLines = null;
  return u.lines.length;
}

/** Zeilen (horiz) bzw. Spalten nach langen Läufen absuchen und benachbarte Läufe zu Wandbändern bündeln. */
function scanRuns(dark, W, H, horiz, minLen, maxThick) {
  const nA = horiz ? H : W, nB = horiz ? W : H;
  const GAP = 2; // kleine Lücken in Bleistiftstrichen überbrücken
  let open = [];
  const done = [];
  for (let a = 0; a < nA; a++) {
    const runs = [];
    let start = -1, last = -1;
    for (let b = 0; b < nB; b++) {
      if (horiz ? dark[a * W + b] : dark[b * W + a]) { if (start < 0) start = b; last = b; }
      else if (start >= 0 && b - last > GAP) { if (last - start + 1 >= minLen) runs.push([start, last]); start = -1; }
    }
    if (start >= 0 && last - start + 1 >= minLen) runs.push([start, last]);

    const next = [];
    for (const [s0, s1] of runs) {
      let g = null;
      for (const o of open) {
        if (o.used) continue;
        const ov = Math.min(s1, o.l1) - Math.max(s0, o.l0);
        if (ov >= 0.6 * Math.min(s1 - s0, o.l1 - o.l0)) { g = o; break; }
      }
      const len = s1 - s0 + 1;
      if (g) {
        g.used = true; g.l0 = s0; g.l1 = s1; g.last = a; g.sumA += a * len; g.w += len;
        g.min0 = Math.min(g.min0, s0); g.max1 = Math.max(g.max1, s1);
        next.push(g);
      } else next.push({ l0: s0, l1: s1, first: a, last: a, sumA: a * len, w: len, min0: s0, max1: s1, used: true });
    }
    for (const o of open) if (!o.used) { if (a - o.last <= 1) next.push(o); else done.push(o); }
    for (const o of next) o.used = false;
    open = next;
  }
  done.push(...open);

  const segs = [];
  for (const g of done) {
    const thick = g.last - g.first + 1;
    if (thick > maxThick || g.max1 - g.min0 + 1 < minLen * 1.5) continue;
    segs.push({ horiz, c: g.sumA / g.w + 0.5, s0: g.min0, s1: g.max1 + 1, t: thick });
  }
  // fluchtende Stücke mit kleiner Lücke zusammenfassen
  segs.sort((p, q) => p.c - q.c || p.s0 - q.s0);
  const merged = [];
  for (const sg of segs) {
    const m = merged.find(o => Math.abs(o.c - sg.c) <= Math.max(2, (o.t + sg.t) / 2) && sg.s0 <= o.s1 + 8 && o.s0 <= sg.s1 + 8);
    if (m) {
      const lm = m.s1 - m.s0, ls = sg.s1 - sg.s0;
      m.c = (m.c * lm + sg.c * ls) / (lm + ls);
      m.s0 = Math.min(m.s0, sg.s0); m.s1 = Math.max(m.s1, sg.s1); m.t = Math.max(m.t, sg.t);
    } else merged.push({ ...sg });
  }
  return merged;
}
