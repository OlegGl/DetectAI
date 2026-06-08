/**
 * generate-icons.js
 * Creates PNG icon files for DetectAI using only built-in Node.js modules.
 * Generates icon16.png, icon48.png, icon128.png in ./icons/
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── CRC32 table ──────────────────────────────────────────────────────────────
const CRC_TABLE = (function () {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buf, offset, length) {
  let crc = 0xFFFFFFFF;
  for (let i = offset; i < offset + length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── PNG chunk builder ─────────────────────────────────────────────────────────
function makeChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len       = data.length;
  const chunk     = Buffer.allocUnsafe(4 + 4 + len + 4);

  // Length
  chunk.writeUInt32BE(len, 0);
  // Type
  typeBytes.copy(chunk, 4);
  // Data
  if (len > 0) data.copy(chunk, 8);
  // CRC over type + data
  const crcVal = crc32(chunk, 4, 4 + len);
  chunk.writeUInt32BE(crcVal, 8 + len);
  return chunk;
}

// ── IHDR chunk ────────────────────────────────────────────────────────────────
function makeIHDR(width, height) {
  const buf = Buffer.allocUnsafe(13);
  buf.writeUInt32BE(width,  0);
  buf.writeUInt32BE(height, 4);
  buf[8]  = 8;  // bit depth
  buf[9]  = 2;  // color type: RGB
  buf[10] = 0;  // compression
  buf[11] = 0;  // filter
  buf[12] = 0;  // interlace
  return makeChunk('IHDR', buf);
}

// ── Raw image data → IDAT chunk ───────────────────────────────────────────────
function makeIDAT(pixels, width, height) {
  // pixels: Uint8Array of length width*height*3 (R,G,B)
  // Build raw PNG scanlines: filter byte 0 per row
  const raw = Buffer.allocUnsafe(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * 3);
    raw[rowOffset] = 0; // filter type None
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 3;
      const dst = rowOffset + 1 + x * 3;
      raw[dst]     = pixels[src];
      raw[dst + 1] = pixels[src + 1];
      raw[dst + 2] = pixels[src + 2];
    }
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  return makeChunk('IDAT', compressed);
}

// ── IEND chunk ────────────────────────────────────────────────────────────────
function makeIEND() {
  return makeChunk('IEND', Buffer.alloc(0));
}

// ── PNG signature ─────────────────────────────────────────────────────────────
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// ── Assemble PNG ──────────────────────────────────────────────────────────────
function buildPNG(pixels, width, height) {
  const ihdr = makeIHDR(width, height);
  const idat = makeIDAT(pixels, width, height);
  const iend = makeIEND();
  return Buffer.concat([PNG_SIGNATURE, ihdr, idat, iend]);
}

// ── Icon drawing ──────────────────────────────────────────────────────────────
// Colors (R,G,B)
const BG_COLOR      = [15,  17,  23];  // #0f1117 dark navy
const CIRCLE_COLOR  = [30,  64, 175];  // #1e40af blue
const LETTER_COLOR  = [255, 255, 255]; // #ffffff white

function setPixel(pixels, width, x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= width || y >= width) return;
  const idx = (y * width + x) * 3;
  pixels[idx]     = r;
  pixels[idx + 1] = g;
  pixels[idx + 2] = b;
}

function fillRect(pixels, width, x0, y0, x1, y1, r, g, b) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      setPixel(pixels, width, x, y, r, g, b);
    }
  }
}

function fillCircle(pixels, size, cx, cy, radius, r, g, b) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= radius * radius) {
        setPixel(pixels, size, x, y, r, g, b);
      }
    }
  }
}

/**
 * Draw rounded-rectangle background icon.
 * Blue rounded square + white "D" letter pixel art scaled to icon size.
 */
function drawIcon(size) {
  const pixels = new Uint8Array(size * size * 3);

  // ── Background: dark navy ──
  for (let i = 0; i < size * size; i++) {
    pixels[i * 3]     = BG_COLOR[0];
    pixels[i * 3 + 1] = BG_COLOR[1];
    pixels[i * 3 + 2] = BG_COLOR[2];
  }

  // ── Blue rounded square ──
  const margin = Math.max(1, Math.round(size * 0.07));
  const radius = Math.round(size * 0.22);
  const x0 = margin, y0 = margin;
  const x1 = size - 1 - margin, y1 = size - 1 - margin;

  // Fill rounded rect via pixel-by-pixel distance test
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      // Corner test
      const inCornerTL = x < x0 + radius && y < y0 + radius;
      const inCornerTR = x > x1 - radius && y < y0 + radius;
      const inCornerBL = x < x0 + radius && y > y1 - radius;
      const inCornerBR = x > x1 - radius && y > y1 - radius;

      let inside = true;
      if (inCornerTL) {
        const dx = x - (x0 + radius);
        const dy = y - (y0 + radius);
        inside = dx * dx + dy * dy <= radius * radius;
      } else if (inCornerTR) {
        const dx = x - (x1 - radius);
        const dy = y - (y0 + radius);
        inside = dx * dx + dy * dy <= radius * radius;
      } else if (inCornerBL) {
        const dx = x - (x0 + radius);
        const dy = y - (y1 - radius);
        inside = dx * dx + dy * dy <= radius * radius;
      } else if (inCornerBR) {
        const dx = x - (x1 - radius);
        const dy = y - (y1 - radius);
        inside = dx * dx + dy * dy <= radius * radius;
      }

      if (inside) {
        setPixel(pixels, size, x, y, CIRCLE_COLOR[0], CIRCLE_COLOR[1], CIRCLE_COLOR[2]);
      }
    }
  }

  // ── Letter "D" pixel art ──
  // Defined on a 7×9 grid, scaled to fit the icon
  // 1 = letter pixel, 0 = background
  const D_BITMAP = [
    [1,1,1,1,0,0,0],
    [1,0,0,0,1,0,0],
    [1,0,0,0,0,1,0],
    [1,0,0,0,0,1,0],
    [1,0,0,0,0,1,0],
    [1,0,0,0,0,1,0],
    [1,0,0,0,0,1,0],
    [1,0,0,0,1,0,0],
    [1,1,1,1,0,0,0],
  ];
  const GRID_COLS = 7;
  const GRID_ROWS = 9;

  // Scale: letter should occupy ~55% of the icon width
  const letterArea    = Math.round(size * 0.56);
  const cellW         = Math.max(1, Math.floor(letterArea / GRID_COLS));
  const cellH         = Math.max(1, Math.floor(letterArea / GRID_ROWS));
  const letterW       = cellW * GRID_COLS;
  const letterH       = cellH * GRID_ROWS;
  const letterOffsetX = Math.round((size - letterW) / 2);
  const letterOffsetY = Math.round((size - letterH) / 2);

  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      if (D_BITMAP[row][col]) {
        const px0 = letterOffsetX + col * cellW;
        const py0 = letterOffsetY + row * cellH;
        fillRect(pixels, size, px0, py0, px0 + cellW - 1, py0 + cellH - 1,
          LETTER_COLOR[0], LETTER_COLOR[1], LETTER_COLOR[2]);
      }
    }
  }

  return pixels;
}

// ── Main: generate all sizes ──────────────────────────────────────────────────
const ICON_SIZES = [16, 48, 128];
const ICONS_DIR  = path.join(__dirname, 'icons');

if (!fs.existsSync(ICONS_DIR)) {
  fs.mkdirSync(ICONS_DIR, { recursive: true });
}

for (const size of ICON_SIZES) {
  const pixels  = drawIcon(size);
  const png     = buildPNG(pixels, size, size);
  const outPath = path.join(ICONS_DIR, `icon${size}.png`);
  fs.writeFileSync(outPath, png);
}

console.log('✓ Icons generated: icon16.png, icon48.png, icon128.png');
