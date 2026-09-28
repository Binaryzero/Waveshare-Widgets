#!/usr/bin/env node
// Draws the Plinth mark and writes src/Plinth/Assets/plinth.ico, the icon of the exe, the
// settings window and the tray. The tray used to draw a "W" at runtime, left over from the
// project's old name.
//
// The mark is the product: the panel, a wide strip of widget tiles in the accent cyan,
// standing on a plinth. Every size is drawn from the same geometry, snapped to whole pixels
// so the small tray sizes stay crisp. Below 32 px the tiles merge into one bar: a one-pixel
// gap there reads as noise, not as tiles.
//
//   node tools/plinth-icon.js           write the icon
//   node tools/plinth-icon.js --check   fail if the committed icon is not what this draws
//
// The check compares PIXELS, decoded from each entry of the committed file, not bytes: the
// one PNG entry is deflated, and another zlib build may compress the same image differently.
//
// No dependencies: plain Node, zlib for the one PNG-compressed size.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.resolve(__dirname, '..', 'src', 'Plinth', 'Assets', 'plinth.ico');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 256];

// Geometry on a 256-unit canvas: [x0, y0, x1, y1, radius, colour].
const TILE = '#111722';
const CYAN = '#00d4ff';
const PLINTH = '#71839c';
const FOOT = '#4d5d75';
const PANEL = [36, 60, 220, 128, 10];
const shapes = (size) => {
  const list = [
    [8, 8, 248, 248, 48, TILE],          // the tile the mark sits on
    [...PANEL, CYAN],                    // the panel
    [72, 144, 184, 168, 4, PLINTH],      // the plinth's top block
    [48, 180, 208, 204, 4, FOOT],        // its foot
  ];
  return list;
};

// Two gaps split the panel into three widget tiles of EQUAL width, worked out in whole
// pixels at each size: gaps placed on the 256-unit canvas round to tiles a pixel or two
// apart, which at 32 and 48 px is a visibly narrow middle tile. Returned in pixels.
function gaps(size) {
  if (size < 32) return [];
  const snap = (v) => Math.round((v * size) / 256);
  const x0 = snap(PANEL[0]), x1 = snap(PANEL[2]);
  const gap = Math.max(1, Math.round(size / 26));
  const tile = Math.floor((x1 - x0 - 2 * gap) / 3);
  const slack = (x1 - x0) - (3 * tile + 2 * gap);   // 0-2 px, given to the gaps
  const g1 = gap + Math.floor(slack / 2), g2 = gap + (slack - Math.floor(slack / 2));
  return [[x0 + tile, x0 + tile + g1], [x0 + 2 * tile + g1, x0 + 2 * tile + g1 + g2]];
}

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// Straight-alpha RGBA, top row first. Edges snap to whole pixels; only the rounded
// corners are anti-aliased, by 8x8 supersampling.
function draw(size) {
  const px = new Float64Array(size * size * 4);
  const snap = (v) => Math.round((v * size) / 256);
  const SS = 8;
  for (const [ax0, ay0, ax1, ay1, ar, colour] of shapes(size)) {
    const x0 = snap(ax0), y0 = snap(ay0);
    const x1 = Math.max(x0 + 1, snap(ax1)), y1 = Math.max(y0 + 1, snap(ay1));
    const r = Math.min((ar * size) / 256, (x1 - x0) / 2, (y1 - y0) / 2);
    const [cr, cg, cb] = rgb(colour);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        let hit = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const fx = x + (sx + 0.5) / SS, fy = y + (sy + 0.5) / SS;
            const dx = Math.max(x0 + r - fx, 0, fx - (x1 - r));
            const dy = Math.max(y0 + r - fy, 0, fy - (y1 - r));
            if (r <= 0 || dx * dx + dy * dy <= r * r) hit++;
          }
        }
        const a = hit / (SS * SS);
        if (!a) continue;
        const i = (y * size + x) * 4;
        const under = px[i + 3];
        const out = a + under * (1 - a);
        for (const [k, c] of [[0, cr], [1, cg], [2, cb]])
          px[i + k] = out ? (c * a + px[i + k] * under * (1 - a)) / out : 0;
        px[i + 3] = out;
      }
    }
  }
  // The tile gaps, cut through the panel in the tile's own colour.
  const [tr, tg, tb] = rgb(TILE);
  const y0 = Math.round((PANEL[1] * size) / 256), y1 = Math.round((PANEL[3] * size) / 256);
  for (const [gx0, gx1] of gaps(size)) {
    for (let y = y0; y < y1; y++) {
      for (let x = gx0; x < gx1; x++) {
        const i = (y * size + x) * 4;
        px[i] = tr; px[i + 1] = tg; px[i + 2] = tb; px[i + 3] = 1;
      }
    }
  }
  const bytes = Buffer.alloc(size * size * 4);
  for (let i = 0; i < px.length; i += 4) {
    bytes[i] = Math.round(px[i]);
    bytes[i + 1] = Math.round(px[i + 1]);
    bytes[i + 2] = Math.round(px[i + 2]);
    bytes[i + 3] = Math.round(px[i + 3] * 255);
  }
  return bytes;
}

// A 32-bit DIB as an ICO entry expects it: BITMAPINFOHEADER at twice the height, BGRA rows
// bottom-up, then an all-zero AND mask (the alpha channel carries the shape).
function dib(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(size * size * 4, 20);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4, d = ((size - 1 - y) * size + x) * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)]);
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ico() {
  const images = SIZES.map((s) => (s >= 256 ? png(s, draw(s)) : dib(s, draw(s))));
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(SIZES.length, 4);
  let offset = 6 + 16 * SIZES.length;
  const dir = SIZES.map((s, i) => {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s;
    e[1] = s >= 256 ? 0 : s;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(images[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += images[i].length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...images]);
}

// The committed file, decoded back to RGBA per entry: { size: Buffer }. Only what ico()
// writes is understood (32-bit DIBs, and 8-bit RGBA PNGs with filter 0); anything else is
// reported as a mismatch rather than guessed at.
function decode(file) {
  const out = {};
  const count = file.readUInt16LE(4);
  for (let i = 0; i < count; i++) {
    const e = 6 + 16 * i;
    const size = file[e] || 256;
    const len = file.readUInt32LE(e + 8), at = file.readUInt32LE(e + 12);
    const img = file.subarray(at, at + len);
    const rgba = Buffer.alloc(size * size * 4);
    if (img.readUInt32BE(0) === 0x89504e47) {
      const idat = [];
      for (let p = 8; p < img.length;) {
        const n = img.readUInt32BE(p), type = img.toString('ascii', p + 4, p + 8);
        if (type === 'IDAT') idat.push(img.subarray(p + 8, p + 8 + n));
        p += 12 + n;
      }
      const raw = zlib.inflateSync(Buffer.concat(idat));
      for (let y = 0; y < size; y++) {
        if (raw[y * (size * 4 + 1)] !== 0) throw new Error(`entry ${size}: unexpected PNG filter`);
        raw.copy(rgba, y * size * 4, y * (size * 4 + 1) + 1, (y + 1) * (size * 4 + 1));
      }
    } else {
      if (img.readUInt32LE(0) !== 40 || img.readUInt16LE(14) !== 32) throw new Error(`entry ${size}: not a 32-bit DIB`);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const s = 40 + ((size - 1 - y) * size + x) * 4, d = (y * size + x) * 4;
          rgba[d] = img[s + 2]; rgba[d + 1] = img[s + 1]; rgba[d + 2] = img[s]; rgba[d + 3] = img[s + 3];
        }
      }
    }
    out[size] = rgba;
  }
  return out;
}

module.exports = { draw, gaps, png, ico, decode, SIZES, OUT };

if (require.main === module) {
  const built = ico();
  if (process.argv.includes('--check')) {
    let problem = null;
    try {
      if (!fs.existsSync(OUT)) throw new Error('it is missing');
      const committed = decode(fs.readFileSync(OUT));
      const have = Object.keys(committed).map(Number).sort((a, b) => a - b);
      if (have.join() !== SIZES.join()) throw new Error(`it has sizes ${have.join(', ')}, not ${SIZES.join(', ')}`);
      for (const size of SIZES)
        if (!committed[size].equals(draw(size))) throw new Error(`its ${size} px image differs`);
    } catch (e) {
      problem = e.message;
    }
    if (problem) {
      console.error(`plinth.ico is not what tools/plinth-icon.js draws (${problem}): run node tools/plinth-icon.js`);
      process.exit(1);
    }
    console.log(`plinth.ico matches tools/plinth-icon.js at ${SIZES.join(', ')} px`);
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, built);
    console.log(`wrote ${path.relative(process.cwd(), OUT)} (${built.length} bytes, sizes ${SIZES.join(', ')})`);
  }
}
