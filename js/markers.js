// Orientierungsmarker: tastbare Symbole (Standort, Pfeil, Treffpunkt) mit fester Größe in mm.
// Umriss relativ zur Markermitte, x nach rechts, y nach oben; Drehung in Grad gegen den Uhrzeigersinn.

export const MARKER_KINDS = [
  { id: 'here', name: 'Sie sind hier', shape: 'Vollkreis' },
  { id: 'arrow', name: 'Eingang', shape: 'Pfeil' },
  { id: 'square', name: 'Treffpunkt', shape: 'Quadrat' },
];

export const markerKind = (id) => MARKER_KINDS.find(k => k.id === id) ?? MARKER_KINDS[0];

/** Umriss ohne Drehung; der Pfeil zeigt nach oben. */
function baseOutline(kind, size) {
  if (kind === 'arrow') {
    const L = size * 1.5, head = size * 0.62, hw = size / 2, sw = size * 0.19;
    const yb = -L / 2, yh = L / 2 - head, yt = L / 2;
    return [{ x: -sw, y: yb }, { x: sw, y: yb }, { x: sw, y: yh }, { x: hw, y: yh }, { x: 0, y: yt }, { x: -hw, y: yh }, { x: -sw, y: yh }];
  }
  if (kind === 'square') {
    const h = size * 0.45;
    return [{ x: -h, y: -h }, { x: h, y: -h }, { x: h, y: h }, { x: -h, y: h }];
  }
  const r = size / 2, n = 40;
  return Array.from({ length: n }, (_, i) => ({ x: r * Math.cos((i / n) * Math.PI * 2), y: r * Math.sin((i / n) * Math.PI * 2) }));
}

/** Umriss eines Markers in mm (gegen den Uhrzeigersinn). */
export function markerOutline(marker, settings) {
  const pts = baseOutline(marker.kind, settings.marker.size);
  const a = ((marker.rot ?? 0) * Math.PI) / 180;
  if (!a) return pts;
  const cos = Math.cos(a), sin = Math.sin(a);
  return pts.map(p => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }));
}

/** Halbe Ausdehnung in mm (für Plattengröße und Treffer). */
export function markerRadius(marker, settings) {
  return Math.max(...markerOutline(marker, settings).map(p => Math.hypot(p.x, p.y)));
}

/** Legendenzeilen: je Form und Bedeutung einmal. */
export function markerLegendEntries(plan) {
  const seen = new Set();
  const out = [];
  for (const m of plan.markers ?? []) {
    const name = (m.name ?? '').trim();
    if (!name) continue;
    const key = `${m.kind}|${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: m.kind, name });
  }
  return out;
}
