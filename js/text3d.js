// 3D-Profilschrift über Three.js (Font: Helvetiker Bold aus den Three-Beispielen).
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';

const FONT_URL = 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/fonts/helvetiker_bold.typeface.json';
let font = null;

const FALLBACK = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue', 'ß': 'ss', '–': '-', '—': '-', '„': '"', '“': '"', '’': "'" };

export async function loadFont() {
  if (font) return font;
  font = await new FontLoader().loadAsync(FONT_URL);
  return font;
}

export function hasFont() { return !!font; }

/** Zeichen ersetzen, die der Font nicht kennt. */
export function sanitize(text) {
  if (!font) return text;
  const glyphs = font.data.glyphs;
  let out = '';
  for (const ch of text) {
    if (glyphs[ch]) out += ch;
    else if (FALLBACK[ch] && [...FALLBACK[ch]].every(c => glyphs[c])) out += FALLBACK[ch];
    else if (glyphs[ch.normalize('NFD')[0]]) out += ch.normalize('NFD')[0];
    else out += glyphs['?'] ? '?' : '';
  }
  return out;
}

export function measure(text, size) {
  if (!font) return text.length * size * 0.62;
  const scale = size / font.data.resolution;
  let w = 0;
  for (const ch of sanitize(text)) {
    const g = font.data.glyphs[ch] || font.data.glyphs['?'];
    if (g) w += (g.ha || 0) * scale;
  }
  return w;
}

/** Dreiecke (Float32Array, x y z …) für einen Textlauf; Grundlinie y=0, Beginn x=0, z von 0 bis depth. */
export function triangles(text, size, depth) {
  if (!font) throw new Error('Font nicht geladen');
  const geo = new TextGeometry(sanitize(text), { font, size, depth, curveSegments: 4, bevelEnabled: false });
  const g = geo.index ? geo.toNonIndexed() : geo;
  const arr = Float32Array.from(g.attributes.position.array);
  geo.dispose();
  if (g !== geo) g.dispose();
  return arr;
}
