// Groups recognized lines into printed receipt rows.
//
// Vision often returns "Burger" and "12.99" as separate observations (all the names, then all the
// prices). With bounding boxes we put them back together: lines whose vertical centres are within
// half the median line height belong to the same row, after correcting for a slightly tilted photo.
import type { Box, RecognizedLine, RecognizedText } from './receiptTypes';

type BoxedLine = { text: string; box: Box };

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

const centreY = (l: BoxedLine) => l.box.y + l.box.height / 2;

function hasBox(l: RecognizedLine): l is BoxedLine {
  return l.box !== undefined;
}

const centreX = (l: BoxedLine) => l.box.x + l.box.width / 2;

/** Steepest tilt we correct for (about 11 degrees); anything steeper is more likely noise. */
const MAX_SLOPE = 0.2;
/** With fewer name/price pairs than this, an offset is as likely misalignment as tilt: don't correct. */
const MIN_SLOPE_PAIRS = 3;

/**
 * Estimates the photo's tilt as dy/dx. For each line, take the line to its right (starting after
 * it ends) whose centre is closest in y, within one line height: on a receipt that is usually the
 * price on the same printed row. The median of those slopes ignores the odd wrong pairing.
 */
function estimateSlope(lines: BoxedLine[], lineHeight: number): number {
  const slopes: number[] = [];
  for (const a of lines) {
    let best: { dy: number; dx: number } | null = null;
    for (const b of lines) {
      if (b.box.x < a.box.x + a.box.width) continue;
      const dy = centreY(b) - centreY(a);
      const dx = centreX(b) - centreX(a);
      if (dx <= 0 || Math.abs(dy) > lineHeight) continue;
      if (!best || Math.abs(dy) < Math.abs(best.dy)) best = { dy, dx };
    }
    if (best) slopes.push(best.dy / best.dx);
  }
  if (slopes.length < MIN_SLOPE_PAIRS) return 0;
  const slope = median(slopes);
  return Math.max(-MAX_SLOPE, Math.min(MAX_SLOPE, slope));
}

function groupByBoxes(lines: BoxedLine[]): string[] {
  const lineHeight = median(lines.map((l) => l.box.height));
  const tolerance = lineHeight / 2;
  const slope = estimateSlope(lines, lineHeight);
  // De-skewed centre: where the line's centre would be if the photo were level.
  const levelY = (l: BoxedLine) => centreY(l) - slope * centreX(l);
  const byY = [...lines].sort((a, b) => levelY(a) - levelY(b));
  const groups: { lines: BoxedLine[]; sumY: number }[] = [];
  for (const line of byY) {
    const current = groups[groups.length - 1];
    const cy = levelY(line);
    if (current && Math.abs(cy - current.sumY / current.lines.length) <= tolerance) {
      current.lines.push(line);
      current.sumY += cy;
    } else {
      groups.push({ lines: [line], sumY: cy });
    }
  }
  return groups.map((g) =>
    clean(
      [...g.lines]
        .sort((a, b) => a.box.x - b.box.x)
        .map((l) => l.text)
        .join(' '),
    ),
  );
}

/**
 * Turns recognized lines into row strings, top to bottom.
 * With boxes on every line: geometric grouping. Otherwise (no boxes, or a mix): the returned order.
 */
export function toRows(text: RecognizedText): string[] {
  const lines = text.lines.filter((l) => clean(l.text) !== '');
  const rows = lines.length > 0 && lines.every(hasBox) ? groupByBoxes(lines) : lines.map((l) => clean(l.text));
  return rows.filter((r) => r !== '');
}
