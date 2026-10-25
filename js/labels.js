// Beschriftungsblöcke: Text (Profilschrift) über Braille, gemeinsam zentriert.
// Maße in Millimetern relativ zur Blockmitte, x nach rechts, y nach oben.
import { translate, layoutCells } from './braille.js';

let textMeasurer = null;

/** Breitenmessung der 3D-Schrift einhängen (aus text3d.js), damit Editor und Modell dieselben Maße nutzen. */
export function setTextMeasurer(fn) { textMeasurer = fn; }

export function measureText(text, size) {
  if (textMeasurer) {
    try { return textMeasurer(text, size); } catch { /* Fallback unten */ }
  }
  return text.length * size * 0.62;
}

/** Text, der auf dem Plan steht (Kurzbezeichnung, sonst Name). */
export function displayText(el) {
  const s = (el.short ?? '').trim();
  return s.length ? s : (el.name ?? '').trim();
}

const TEXT_LINE = 1.25;   // Zeilenhöhe relativ zur Schriftgröße
const TEXT_GAP = 2.0;     // Abstand Text ↔ Braille in mm

/**
 * @param {object} el   Raum/Bereich (mit el.label) oder freie Beschriftung
 * @param {object} settings  plan.settings
 * @param {string} [textOverride]
 */
export function layoutLabel(el, settings, textOverride) {
  const text = textOverride ?? displayText(el);
  const flags = el.label ?? el;
  const showB = flags.showBraille !== false;
  const showT = settings.text.enabled && flags.showText !== false;
  if (!text || (!showB && !showT)) return null;

  const braille = showB ? translate(text, settings.braille) : null;
  const cells = braille ? layoutCells(braille.lines, settings.braille) : { dots: [], width: 0, height: 0 };

  const size = settings.text.size;
  const textLines = showT ? text.split('\n').map(l => l.trim()).filter(l => l.length) : [];
  const lineH = size * TEXT_LINE;
  const textBlockH = textLines.length * lineH;
  const textWidths = textLines.map(l => measureText(l, size));
  const textW = textWidths.length ? Math.max(...textWidths) : 0;
  const gap = textLines.length && braille ? TEXT_GAP : 0;

  const width = Math.max(cells.width, textW, 1);
  const height = textBlockH + gap + cells.height;
  const top = height / 2;

  const textItems = textLines.map((t, i) => ({
    text: t,
    width: textWidths[i],
    x: -textWidths[i] / 2,
    baseline: top - (i + 1) * lineH + size * 0.28,
    size,
  }));
  const brailleCenterY = -height / 2 + cells.height / 2;
  const dots = cells.dots.map(d => ({ x: d.x, y: d.y + brailleCenterY }));

  return {
    text, width, height, dots, textItems, size,
    braille, cellsWidth: cells.width, cellsHeight: cells.height, brailleCenterY,
  };
}
