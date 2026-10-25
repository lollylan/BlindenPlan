// Deutsche Brailleschrift: Basisschrift (buchstabengetreu) und Vollschrift (mit Lautgruppen).
// Eine Zelle ist ein Array der gesetzten Punkte 1–6 (1–3 linke Spalte, 4–6 rechte Spalte).

const LETTERS = {
  a: [1], b: [1, 2], c: [1, 4], d: [1, 4, 5], e: [1, 5], f: [1, 2, 4], g: [1, 2, 4, 5], h: [1, 2, 5], i: [2, 4], j: [2, 4, 5],
  k: [1, 3], l: [1, 2, 3], m: [1, 3, 4], n: [1, 3, 4, 5], o: [1, 3, 5], p: [1, 2, 3, 4], q: [1, 2, 3, 4, 5], r: [1, 2, 3, 5], s: [2, 3, 4], t: [2, 3, 4, 5],
  u: [1, 3, 6], v: [1, 2, 3, 6], w: [2, 4, 5, 6], x: [1, 3, 4, 6], y: [1, 3, 4, 5, 6], z: [1, 3, 5, 6],
  'ä': [3, 4, 5], 'ö': [2, 4, 6], 'ü': [1, 2, 5, 6], 'ß': [2, 3, 4, 6],
};

// Lautgruppen der Vollschrift, längste zuerst.
const GROUPS = [
  ['sch', [1, 5, 6]],
  ['st', [2, 3, 4, 5, 6]],
  ['äu', [3, 4]],
  ['au', [1, 6]],
  ['eu', [1, 2, 6]],
  ['ei', [1, 4, 6]],
  ['ch', [1, 4, 5, 6]],
  ['ie', [3, 4, 6]],
];

const DIGITS = { '1': [1], '2': [1, 2], '3': [1, 4], '4': [1, 4, 5], '5': [1, 5], '6': [1, 2, 4], '7': [1, 2, 4, 5], '8': [1, 2, 5], '9': [2, 4], '0': [2, 4, 5] };
const NUMBER_SIGN = [3, 4, 5, 6];
const CAPITAL_SIGN = [4, 6];

const PUNCT = {
  '.': [2, 5, 6], ',': [2], '-': [3, 6], '–': [3, 6], ':': [2, 5], ';': [2, 3], '!': [2, 3, 5], '?': [2, 6],
  '(': [2, 3, 5, 6], ')': [2, 3, 5, 6], '"': [2, 3, 6], '„': [2, 3, 6], '“': [2, 3, 6], "'": [3], '’': [3],
  '/': [3, 4], '+': [2, 3, 5], '=': [2, 3, 5, 6], '*': [3, 5], '&': [1, 2, 3, 4, 6], '§': [3, 4, 6], '%': [1, 2, 3, 4, 5, 6],
};

const DOT_BIT = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 16, 6: 32 };

export function cellToUnicode(cell) {
  let bits = 0;
  for (const d of cell) bits |= DOT_BIT[d] || 0;
  return String.fromCharCode(0x2800 + bits);
}

/**
 * Übersetzt Text in Braillezellen.
 * @param {string} text  Zeilen durch "\n" getrennt. "|" verhindert eine Lautgruppe (wird nicht ausgegeben).
 * @param {{system?: 'basis'|'voll', capitals?: boolean}} opts
 * @returns {{lines: number[][][], unicode: string, warnings: string[], cellCount: number}}
 */
export function translate(text, opts = {}) {
  const system = opts.system === 'voll' ? 'voll' : 'basis';
  const capitals = !!opts.capitals;
  const warnings = [];
  const unknown = new Set();
  const lines = [];

  for (const rawLine of String(text ?? '').replace(/\r/g, '').split('\n')) {
    const cells = [];
    const line = rawLine.replace(/\s+/g, ' ').trim();
    const words = line.length ? line.split(' ') : [];
    words.forEach((word, wi) => {
      if (wi > 0) cells.push([]); // Leerzelle
      translateWord(word, cells, { system, capitals, unknown });
    });
    lines.push(cells);
  }

  if (unknown.size) warnings.push(`Unbekannte Zeichen werden als „?“ gesetzt: ${[...unknown].join(' ')}`);
  const unicode = lines.map(cs => cs.map(c => c.length ? cellToUnicode(c) : ' ').join('')).join('\n');
  const cellCount = lines.reduce((n, cs) => n + cs.length, 0);
  return { lines, unicode, warnings, cellCount };
}

function translateWord(word, cells, ctx) {
  const clean = word.replace(/\|/g, '');
  const letters = clean.replace(/[^\p{L}]/gu, '');
  const allCaps = ctx.capitals && letters.length >= 2 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
  if (allCaps) cells.push(CAPITAL_SIGN, CAPITAL_SIGN);

  let i = 0;
  let inNumber = false;
  while (i < word.length) {
    const ch = word[i];
    if (ch === '|') { i++; continue; }

    if (DIGITS[ch]) {
      if (!inNumber) { cells.push(NUMBER_SIGN); inNumber = true; }
      cells.push(DIGITS[ch]);
      i++;
      continue;
    }
    if (ch === '.' || ch === ',') {
      // Innerhalb einer Zahl bleibt das Zahlzeichen bestehen (z. B. 1,5)
      cells.push(PUNCT[ch]);
      i++;
      if (!(inNumber && DIGITS[word[i]])) inNumber = false;
      continue;
    }
    inNumber = false;

    const lower = ch.toLowerCase();
    const isLetter = /\p{L}/u.test(ch);
    if (isLetter) {
      const isUpper = ch !== lower && ch === ch.toUpperCase();
      if (ctx.capitals && isUpper && !allCaps) cells.push(CAPITAL_SIGN);

      if (ctx.system === 'voll') {
        const rest = word.slice(i).toLowerCase();
        let matched = false;
        for (const [grp, cell] of GROUPS) {
          if (rest.startsWith(grp)) {
            // Gruppe nur, wenn kein "|" dazwischen steht
            const slice = word.slice(i, i + grp.length);
            if (!slice.includes('|')) {
              // Großbuchstaben innerhalb der Gruppe kommen bei Beschriftungen praktisch nicht vor.
              cells.push(cell);
              i += grp.length;
              matched = true;
              break;
            }
          }
        }
        if (matched) continue;
      }

      const base = LETTERS[lower] ?? LETTERS[stripDiacritics(lower)];
      if (base) {
        cells.push(base);
      } else {
        ctx.unknown.add(ch);
        cells.push([2, 6]);
      }
      i++;
      continue;
    }

    if (PUNCT[ch]) { cells.push(PUNCT[ch]); i++; continue; }
    ctx.unknown.add(ch);
    cells.push([2, 6]);
    i++;
  }
}

function stripDiacritics(ch) {
  const map = { 'é': 'e', 'è': 'e', 'ê': 'e', 'á': 'a', 'à': 'a', 'â': 'a', 'ó': 'o', 'ô': 'o', 'ú': 'u', 'û': 'u', 'í': 'i', 'î': 'i', 'ç': 'c', 'ñ': 'n', 'ë': 'e', 'ï': 'i', 'ÿ': 'y' };
  return map[ch] ?? ch;
}

/**
 * Dot-Layout eines Braille-Blocks in Millimetern, relativ zur Blockmitte (x rechts, y oben).
 * Zeilen linksbündig. Liefert Punktmittelpunkte und Blockmaße.
 */
export function layoutCells(lines, dims) {
  const { dotPitch, cellPitch, linePitch } = dims;
  const nLines = Math.max(1, lines.length);
  const widths = lines.map(cs => cs.length ? (cs.length - 1) * cellPitch + dotPitch : 0);
  const width = Math.max(0, ...widths);
  const height = (nLines - 1) * linePitch + 2 * dotPitch;
  const x0 = -width / 2;
  const yTop = height / 2;
  const dots = [];
  lines.forEach((cells, li) => {
    cells.forEach((cell, ci) => {
      for (const d of cell) {
        const col = d >= 4 ? 1 : 0;
        const row = (d - 1) % 3;
        dots.push({ x: x0 + ci * cellPitch + col * dotPitch, y: yTop - li * linePitch - row * dotPitch });
      }
    });
  });
  return { dots, width, height };
}
