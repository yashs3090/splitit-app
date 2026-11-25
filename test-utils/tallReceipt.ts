// Synthetic tall "receipts" for the strip-tiling tests (spec Task 12, criterion 70). Test-only.
// Rows of dark glyph-like blocks (an item name on the left, a price on the right) on light, slightly
// noisy paper. Nothing here comes from a receipt photo or its OCR output.
import { prng } from './opencv';

export type TextRow = { top: number; bottom: number };

export type TallPage = {
  /** 8-bit grey, row-major. */
  gray: Uint8Array;
  width: number;
  height: number;
  /** Every text row's ink extent `[top, bottom)` (ascenders and descenders included). */
  rows: TextRow[];
};

export type TallPageOptions = {
  width?: number;
  height?: number;
  /** Text-row height (ink extent) and the distance between row tops. */
  lineH?: number;
  pitch?: number;
  /** Blank paper above the first row. */
  topMargin?: number;
  paper?: number;
  ink?: number;
  /** ± grey levels of paper noise. */
  noise?: number;
  seed?: number;
  /** Rows `[from, to)` (pixels) filled with ink everywhere: a logo / photo block with no blank row. */
  solidBlock?: [number, number];
  /** Paper brightness change from top to bottom (a shadow at the bottom: negative). */
  paperGradient?: number;
};

/** A page `width × height` (default 600 × 3600, 1:6) with text rows every `pitch` px down to the bottom margin. */
export function renderTallPage(o: TallPageOptions = {}): TallPage {
  const width = o.width ?? 600;
  const height = o.height ?? 3600;
  const lineH = o.lineH ?? 28;
  const pitch = o.pitch ?? 44;
  const top = o.topMargin ?? 40;
  const paper = o.paper ?? 225;
  const ink = o.ink ?? 45;
  const noise = o.noise ?? 6;
  const grad = o.paperGradient ?? 0;
  const rnd = prng(o.seed ?? 12);
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const base = paper + (grad * y) / height;
    for (let x = 0; x < width; x++) gray[y * width + x] = clamp(base + (rnd() * 2 - 1) * noise);
  }
  const rows: TextRow[] = [];
  const margin = Math.round(width * 0.05);
  for (let y0 = top; y0 + lineH <= height - top; y0 += pitch) {
    rows.push({ top: y0, bottom: y0 + lineH });
    // Name: 2–4 words of 3–8 glyphs; price: 4–6 glyphs, right-aligned.
    let x = margin;
    const words = 2 + Math.floor(rnd() * 3);
    for (let w = 0; w < words; w++) {
      const glyphs = 3 + Math.floor(rnd() * 6);
      for (let g = 0; g < glyphs; g++) x = glyph(gray, width, x, y0, lineH, ink, rnd);
      x += 10;
    }
    let px = width - margin - (4 + Math.floor(rnd() * 3)) * 13;
    while (px < width - margin - 10) px = glyph(gray, width, px, y0, lineH, ink, rnd);
  }
  if (o.solidBlock) {
    const [a, b] = o.solidBlock;
    for (let y = a; y < Math.min(b, height); y++) for (let x = margin; x < width - margin; x++) gray[y * width + x] = ink;
  }
  const page = { gray, width, height, rows };
  markRowExtents(page, ink);
  return page;
}

/** One glyph: a body at the x-height plus, sometimes, an ascender or descender stroke. Returns the next x. */
function glyph(gray: Uint8Array, width: number, x: number, y0: number, lineH: number, ink: number, rnd: () => number): number {
  const w = 7 + Math.floor(rnd() * 5);
  const asc = Math.round(lineH * 0.25);
  const desc = Math.round(lineH * 0.2);
  const bodyTop = y0 + asc;
  const bodyBottom = y0 + lineH - desc;
  const kind = rnd();
  for (let y = bodyTop; y < bodyBottom; y++) {
    for (let dx = 0; dx < w; dx++) {
      // Two vertical strokes and a top/bottom bar: an "o"/"n"-like shape, not a solid box.
      const stroke = dx < 2 || dx >= w - 2 || y < bodyTop + 2 || y >= bodyBottom - 2;
      if (stroke && x + dx < width) gray[y * width + x + dx] = ink;
    }
  }
  const ascender = kind < 0.3;
  const descender = kind > 0.8;
  if (ascender || rnd() < 0.05) for (let y = y0; y < bodyTop; y++) for (let dx = 0; dx < 2; dx++) gray[y * width + x + dx] = ink;
  if (descender || rnd() < 0.05) for (let y = bodyBottom; y < y0 + lineH; y++) for (let dx = w - 2; dx < w; dx++) gray[y * width + x + dx] = ink;
  return x + w + 3;
}

/** Forces every row's full extent to carry ink (one ascender + one descender stroke at the row's start). */
export function markRowExtents(page: TallPage, ink = 45): void {
  const x = Math.round(page.width * 0.05);
  for (const r of page.rows) for (let y = r.top; y < r.bottom; y++) for (let dx = 0; dx < 2; dx++) page.gray[y * page.width + x + dx] = ink;
}

function clamp(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/** True when `y` is inside any text row. */
export function inTextRow(rows: readonly TextRow[], y: number): boolean {
  return rows.some((r) => y >= r.top && y < r.bottom);
}
