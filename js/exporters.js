// Export: binäres STL, 3MF (ZIP mit XML-Modell), ZIP-Container, Download.

/* ---------- STL ---------- */
export function stlBinary(trisList, name = 'Raumgefuehl') {
  const total = trisList.reduce((n, t) => n + t.length / 9, 0);
  const buf = new ArrayBuffer(84 + total * 50);
  const dv = new DataView(buf);
  const header = new TextEncoder().encode(`Raumgefuehl ${name}`).subarray(0, 80);
  new Uint8Array(buf, 0, 80).set(header);
  dv.setUint32(80, total, true);
  let off = 84;
  for (const tris of trisList) {
    for (let i = 0; i < tris.length; i += 9) {
      const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
      const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
      const cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      dv.setFloat32(off, nx, true); dv.setFloat32(off + 4, ny, true); dv.setFloat32(off + 8, nz, true);
      dv.setFloat32(off + 12, ax, true); dv.setFloat32(off + 16, ay, true); dv.setFloat32(off + 20, az, true);
      dv.setFloat32(off + 24, bx, true); dv.setFloat32(off + 28, by, true); dv.setFloat32(off + 32, bz, true);
      dv.setFloat32(off + 36, cx, true); dv.setFloat32(off + 40, cy, true); dv.setFloat32(off + 44, cz, true);
      dv.setUint16(off + 48, 0, true);
      off += 50;
    }
  }
  return buf;
}

/* ---------- ZIP (ohne Kompression) ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** files: [{name, data: Uint8Array|ArrayBuffer|string}] */
export function zipFiles(files) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime();
  const entries = files.map(f => {
    const data = typeof f.data === 'string' ? enc.encode(f.data) : (f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : f.data);
    return { name: enc.encode(f.name), data, crc: crc32(data) };
  });
  let size = 22;
  for (const e of entries) size += 30 + e.name.length + e.data.length + 46 + e.name.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let off = 0;
  const offsets = [];
  for (const e of entries) {
    offsets.push(off);
    dv.setUint32(off, 0x04034b50, true); dv.setUint16(off + 4, 20, true); dv.setUint16(off + 6, 0x0800, true); dv.setUint16(off + 8, 0, true);
    dv.setUint16(off + 10, time, true); dv.setUint16(off + 12, date, true); dv.setUint32(off + 14, e.crc, true);
    dv.setUint32(off + 18, e.data.length, true); dv.setUint32(off + 22, e.data.length, true);
    dv.setUint16(off + 26, e.name.length, true); dv.setUint16(off + 28, 0, true);
    off += 30; out.set(e.name, off); off += e.name.length; out.set(e.data, off); off += e.data.length;
  }
  const cdStart = off;
  entries.forEach((e, i) => {
    dv.setUint32(off, 0x02014b50, true); dv.setUint16(off + 4, 20, true); dv.setUint16(off + 6, 20, true); dv.setUint16(off + 8, 0x0800, true); dv.setUint16(off + 10, 0, true);
    dv.setUint16(off + 12, time, true); dv.setUint16(off + 14, date, true); dv.setUint32(off + 16, e.crc, true);
    dv.setUint32(off + 20, e.data.length, true); dv.setUint32(off + 24, e.data.length, true);
    dv.setUint16(off + 28, e.name.length, true); dv.setUint16(off + 30, 0, true); dv.setUint16(off + 32, 0, true);
    dv.setUint16(off + 34, 0, true); dv.setUint16(off + 36, 0, true); dv.setUint32(off + 38, 0, true); dv.setUint32(off + 42, offsets[i], true);
    off += 46; out.set(e.name, off); off += e.name.length;
  });
  const cdSize = off - cdStart;
  dv.setUint32(off, 0x06054b50, true); dv.setUint16(off + 4, 0, true); dv.setUint16(off + 6, 0, true);
  dv.setUint16(off + 8, entries.length, true); dv.setUint16(off + 10, entries.length, true);
  dv.setUint32(off + 12, cdSize, true); dv.setUint32(off + 16, cdStart, true); dv.setUint16(off + 20, 0, true);
  return out;
}

/* ---------- 3MF ---------- */
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function meshXML(trisList) {
  const verts = [];
  const index = new Map();
  const tris = [];
  const key = (x, y, z) => `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
  const vid = (x, y, z) => {
    const k = key(x, y, z);
    let id = index.get(k);
    if (id === undefined) { id = verts.length; verts.push(k.split(',')); index.set(k, id); }
    return id;
  };
  for (const t of trisList) {
    for (let i = 0; i < t.length; i += 9) {
      const a = vid(t[i], t[i + 1], t[i + 2]), b = vid(t[i + 3], t[i + 4], t[i + 5]), c = vid(t[i + 6], t[i + 7], t[i + 8]);
      if (a === b || b === c || a === c) continue;
      tris.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`);
    }
  }
  const v = verts.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('');
  return `<mesh><vertices>${v}</vertices><triangles>${tris.join('')}</triangles></mesh>`;
}

/**
 * @param {{name:string, parts:{kind:string,color:string,tris:Float32Array}[]}[]} pieces
 * @param {{title?:string, split?:boolean, baseColor?:string, raisedColor?:string}} opts
 *   split=true: je Stück ein Objekt aus Komponenten (Grundplatte / erhabene Teile), sonst je Stück ein Netz.
 */
export function threeMF(pieces, opts = {}) {
  const colors = [];
  const colorIndex = (c) => { const k = (c || '#888888').toUpperCase(); let i = colors.indexOf(k); if (i < 0) { colors.push(k); i = colors.length - 1; } return i; };
  let nextId = 2;
  const objects = [];
  const items = [];
  for (const piece of pieces) {
    if (!piece.parts.length) continue;
    if (opts.split) {
      const groups = new Map();
      for (const p of piece.parts) {
        const k = p.kind === 'base' ? 'base' : 'raised';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(p.tris);
      }
      const compIds = [];
      for (const [kind, list] of groups) {
        const id = nextId++;
        const color = kind === 'base' ? (opts.baseColor || '#E9E4DA') : (opts.raisedColor || '#1F2A44');
        objects.push(`<object id="${id}" name="${esc(piece.name)} – ${kind === 'base' ? 'Grundplatte' : 'Erhaben'}" type="model" pid="1" pindex="${colorIndex(color)}">${meshXML(list)}</object>`);
        compIds.push(id);
      }
      const parent = nextId++;
      objects.push(`<object id="${parent}" name="${esc(piece.name)}" type="model"><components>${compIds.map(id => `<component objectid="${id}"/>`).join('')}</components></object>`);
      items.push(`<item objectid="${parent}"/>`);
    } else {
      const id = nextId++;
      objects.push(`<object id="${id}" name="${esc(piece.name)}" type="model" pid="1" pindex="${colorIndex(piece.color || opts.raisedColor)}">${meshXML(piece.parts.map(p => p.tris))}</object>`);
      items.push(`<item objectid="${id}"/>`);
    }
  }
  const materials = `<basematerials id="1">${colors.map((c, i) => `<base name="Farbe ${i + 1}" displaycolor="${c}FF"/>`).join('')}</basematerials>`;
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="de-DE" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Title">${esc(opts.title || 'Raumgefühl')}</metadata>
<metadata name="Application">Raumgefühl</metadata>
<metadata name="CreationDate">${new Date().toISOString().slice(0, 10)}</metadata>
<resources>${materials}${objects.join('')}</resources>
<build>${items.join('')}</build>
</model>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  return zipFiles([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: '3D/3dmodel.model', data: model },
  ]);
}

/* ---------- Download ---------- */
export function download(data, filename, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function safeName(s) {
  return String(s || 'plan').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'plan';
}
