// Turns on-device recognized text into line items and totals. Pure, deterministic, never throws.
// Rules: docs/specs/2026-11-20-m1a-scan-receipt.md, Task 4, with Amendment A1.4 (priced modifiers
// fold into the item) and Amendment A2 (no-subtotal cross-check, item-level discounts), plus the
// user's line rules in docs/lessons/log.md (2026-11-22) and fixes from real web OCR captures.
import { parseMoneyToken } from './money';
import { toRows } from './receiptRows';
import type { Discount, ParsedItem, ParsedReceipt, RecognizedText, ReviewReason } from './receiptTypes';

// ---------- money tokens on a row ----------

const NUM = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}`;
// `(…)` negatives, or an optional `-`/`$`/`-$`/`$-` prefix and an optional trailing `-`.
// A space is allowed only after `$`, so "Item - 12.99" is not read as negative. Not followed by
// more digits, a further decimal part, or `%` (so a tax rate like "8.25%" is not a price).
const TOKEN_SOURCE = String.raw`(?:\((?:\$\s?)?${NUM}\)|(?:-\$\s?|\$\s?-|\$\s?|-)?${NUM}-?)(?!\d|\.\d|\s?%)`;

type Token = { index: number; text: string; cents: number };

/** Every money token on the row, left to right. */
function findTokens(s: string): Token[] {
  const re = new RegExp(TOKEN_SOURCE, 'g');
  const found: Token[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const prev = m.index > 0 ? s.charAt(m.index - 1) : '';
    const cents = /[\d.,]/.test(prev) ? null : parseMoneyToken(m[0]);
    if (cents === null) {
      re.lastIndex = m.index + 1; // retry from the next character
      continue;
    }
    found.push({ index: m.index, text: m[0], cents });
  }
  return found;
}

function findLastToken(s: string): Token | null {
  const tokens = findTokens(s);
  return tokens[tokens.length - 1] ?? null;
}

// A tax-category code printed after the price, e.g. "Burger 12.99 T" or "12.99 TX" (review R7).
const TAX_CODE_AFTER_PRICE_RE = /^\s*[A-Z]{1,2}\s*$/;
// Camera noise after the price: at most one letter plus punctuation, e.g. "$16.95 a", "6.00 /".
// A real word ("12.99 large") is kept (review R7).
const NOISE_AFTER_PRICE_RE = /^[^\w]*(?:[a-z][^\w]*)?$/i;

type Priced = { label: string; cents: number | null };

/** The last money token on the row is the price. The rest of the row is the label. */
function splitPrice(row: string): Priced {
  const last = findLastToken(row);
  if (!last) return { label: row, cents: null };
  let after = row.slice(last.index + last.text.length);
  if (TAX_CODE_AFTER_PRICE_RE.test(after) || NOISE_AFTER_PRICE_RE.test(after)) after = '';
  const label = `${row.slice(0, last.index)} ${after}`;
  return { label: label.replace(/\s+/g, ' ').trim(), cents: last.cents };
}

// ---------- row classification ----------

const SUBTOTAL_RE = /\bsub[\s-]?total\b|\bfood total\b/i;
// Summary lines that mention "total" or "saved" but are not the bill total (review R3).
const SUMMARY_RE = /\btotal\s+(?:savings?|saved|discounts?|items?|qty|quantity|count)\b|\byou saved\b|\bitem count\b/i;
const TOTAL_START_RE = /^(?:grand total|total|amount due|balance due)\b/i;
const TOTAL_RE = /\b(?:grand total|total|amount due|balance due)\b/i;
const INCLUDES_RE = /\bincl/i; // "Total incl. tax" is the total, not tax
const TAX_RE = /\b(?:sales tax|tax(?:es)?|hst|gst|vat)\b/i;
// "Total Tax(es)" / "Tax Total": the sum of the tax lines above it, not one more tax.
const TAX_SUM_RE = /\btotal\s+tax(?:es)?\b|\btax(?:es)?\s+total\b/i;
// "Gratuity", "Auto Gratuity", "Gratuity (18%)" are all the tip; a service charge is a fee.
const TIP_RE = /\b(?:tip|gratuity)\b/i;
const FEES_RE = /\bservice (?:charge|fee)\b/i;
// "Optional Service (18%)", "Optional Service Charge", "OPT SERVICE", "Optional Svc", and the same
// convention as "discretionary" / "voluntary" service: a service line the guest may decline is the
// tip, not a fee (user rule, 2026-11-23). A plain or "mandatory" service charge stays a fee.
const OPTIONAL_SERVICE_RE = /\b(?:optional|opt\.?|discretionary|voluntary)\s*(?:service|serv|svc)\b/i;

const TIP_BLOCK_HEADER_RE = /suggested|tip guide|gratuity guide/i;
const PERCENT_RE = /\d{1,2}%/;
// A row with two or more percentages is a tip guide ("15% 20% 25%"), never a tip or an item.
const MULTI_PERCENT_RE = /\d{1,2}(?:\.\d+)?\s?%.*\d{1,2}(?:\.\d+)?\s?%/;

// A column header with a QTY column, e.g. "ITEM QTY PRICE" or "QTY DESCRIPTION AMOUNT".
const QTY_HEADER_RE = /\b(?:qty|quantity)\b/i;
const ITEM_HEADER_RE = /\b(?:items?|description|desc|name|product)\b/i;

const PAYMENT_RE = /\b(?:visa|mastercard|amex|discover|card|cash|change|tendered|auth|approval)\b|x{2,}\d{4}|\*{2,}\d{4}/i;
const HEADER_INFO_RE = /\b(?:server|table|guests?)\b|\bcheck\s*#|\border\s*(?:#|no\.?|number)?\s*:?\s*\d/i;
// Times printed with a dot ("7.45 PM") look like money (review R9).
const TIME_RE = /\b\d{1,2}[.:]\d{2}\s*(?:am|pm)\b|\btime\b\s*:?\s*\d/i;
// A clock time at the start of a row, e.g. "09:19PM Total 126.37" (Raintree). Only a colon time:
// "7.45 Total 12.00" is ambiguous with a price. The am/pm part allows OCR damage ("PH", "py").
const LEADING_TIME_RE = /^[^\w]*\d{1,2}:\d{2}(?::\d{2})?(?:\s?(?:[ap]\.?m\.?|[ap][a-z]?))?\s+/i;
// OCR damage to a bare "Total" / "Subtotal" label: the "l" read as ")", "]", "|", "1" or "I", or
// the "o" as "0" ("Tota)", "Tota1", "T0tal"). Only a label that is nothing but that word is repaired.
const DAMAGED_TOTAL_RE = /^(sub[\s-]?)?t[o0]ta[l1i|)\]]\s*:?$/i;

function repairLabel(label: string): string {
  const m = DAMAGED_TOTAL_RE.exec(label);
  if (!m) return label;
  return m[1] === undefined ? 'Total' : 'Subtotal';
}

// Modifiers: `+`/`add ` always; `-`/`no ` only when unpriced or negative, so a priced row like
// "No Bake Cheesecake 7.00" is an item (review R8). All need a word (a letter), not a number.
const MOD_ADD_RE = /^(?:\+\s*|add\s+)(?=[a-z])/i;
const MOD_REMOVE_RE = /^(?:-\s*|no\s+)(?=[a-z])/i;

// A2.2: a row is a discount only if its amount is negative or its label is nothing but discount
// words (plus filler like "code", amounts and percentages). "Happy Hour Wings 8.00" is an item.
const DISCOUNT_WORD_RE = /\b(?:discounts?|coupons?|promo(?:tion)?s?|comp(?:ed)?|happy hour|off|savings?)\b/gi;
const DISCOUNT_FILLER_RE =
  /\b(?:code|applied|item|special|senior|military|employee|manager|student|loyalty|member|reward|instant)\b/gi;

function isDiscountLabel(label: string): boolean {
  if (!new RegExp(DISCOUNT_WORD_RE.source, 'i').test(label)) return false;
  const rest = label.replace(DISCOUNT_WORD_RE, '').replace(DISCOUNT_FILLER_RE, '').replace(/[\d%$\s.,:#*()/-]/g, '');
  return rest === '';
}

type TotalKind = 'subtotal' | 'total' | 'tax' | 'taxSum' | 'tip' | 'fees';

function totalKind(label: string): TotalKind | 'summary' | null {
  if (SUBTOTAL_RE.test(label)) return 'subtotal';
  if (SUMMARY_RE.test(label)) return 'summary';
  if (TOTAL_START_RE.test(label) && INCLUDES_RE.test(label)) return 'total';
  if (TAX_SUM_RE.test(label)) return 'taxSum'; // before total, so "Total Tax" is tax
  if (TAX_RE.test(label)) return 'tax';
  if (TOTAL_START_RE.test(label)) return 'total';
  if (OPTIONAL_SERVICE_RE.test(label)) return 'tip'; // before fees: "Optional Service Charge" is the tip
  if (FEES_RE.test(label)) return 'fees';
  if (TIP_RE.test(label)) return 'tip';
  if (TOTAL_RE.test(label)) return 'total';
  return null;
}

/** A printed "qty @ unit price" annotation, e.g. "(2@3.50)" = 2 x 3.50. */
type UnitNote = { qty: number; unitCents: number };

type Row =
  | { kind: 'skip' } // ignored: noise, unpriced text, suggested-tip block, summaries
  // `included`: a tax or tax-sum row whose label says the tax is already inside the total
  // ("VAT included", "Tax total (incl.)").
  | { kind: 'totals'; which: TotalKind; cents: number; included?: true }
  | { kind: 'modifier'; text: string; cents: number | null }
  | { kind: 'discount'; label: string; cents: number }
  | { kind: 'priced'; label: string; cents: number; note?: UnitNote }
  | { kind: 'unitNote'; note: UnitNote }; // a row that is only "(2@3.50)" / "2 @ 3.50": for the item next to it

// ---------- unit-price notation (user rule, 2026-11-23) ----------

// "(2@3.50)", "(2 @ $3.50)", "(2@3.50 ea)", or bare "2@3.50" / "2 @ $ 3.50 each" between spaces.
// The qty is an integer. The unit price has one or two decimals (user rule, 2026-11-24): "(2@3.5)"
// is 2 x 3.50, but only inside the note; everywhere else a price needs exactly two decimals. A
// whole-number unit ("2@3") is left in the name: with no decimal point, "2@3" reads as well as a
// count, a table or a size, and nothing on the row says it is money. Three decimals ("2@3.555")
// are not a note either. An "@" with no "<qty> @ <price>" around it ("Email @ checkout") is left alone.
const NOTE_NUM = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{1,2}`;
const NOTE_EACH = String.raw`(?:\s*(?:each|ea)\.?)?`;
const UNIT_NOTE_RE = new RegExp(
  String.raw`\(\s*(\d{1,2})\s*@\s*\$?\s?(${NOTE_NUM})${NOTE_EACH}\s*\)` +
    String.raw`|(?:^|\s)(\d{1,2})\s*@\s*\$?\s?(${NOTE_NUM})${NOTE_EACH}(?=\s|$)`,
  'i',
);

/** A note's unit price in cents: "3.5" is padded to "3.50" so the usual 2-decimal parser reads it. */
function noteUnitCents(s: string): number | null {
  return parseMoneyToken(/\.\d$/.test(s) ? `${s}0` : s);
}

/** The first unit-price annotation on the row, and the row without it. */
function findUnitNote(row: string): { note: UnitNote; rest: string } | null {
  const m = UNIT_NOTE_RE.exec(row);
  if (!m) return null;
  const qty = parseInt(m[1] ?? m[3] ?? '', 10);
  const unitCents = noteUnitCents(m[2] ?? m[4] ?? '');
  if (!(qty >= 1) || unitCents === null || unitCents <= 0) return null;
  const rest = `${row.slice(0, m.index)} ${row.slice(m.index + m[0].length)}`.replace(/\s+/g, ' ').trim();
  return { note: { qty, unitCents }, rest };
}

/** A row that is only an annotation and a line price, e.g. "2 @ 3.50 7.00" under its name. */
function isPricedNoteRow(row: string): boolean {
  const found = findUnitNote(row);
  return found !== null && !/[a-z]/i.test(found.rest) && splitPrice(found.rest).cents !== null;
}

function cleanName(s: string): string {
  return s
    .replace(/^[\s.:*•#-]+/, '')
    .replace(/[\s.:*•-]+$/, '')
    .trim();
}

function totalsRow(which: TotalKind, label: string, cents: number): Row {
  const isTax = which === 'tax' || which === 'taxSum';
  return isTax && INCLUDES_RE.test(label)
    ? { kind: 'totals', which, cents, included: true }
    : { kind: 'totals', which, cents };
}

/**
 * A totals row with a clock time in front ("09:19PM Tota) 126.37"), which TIME_RE would skip. Only
 * when the rest is one amount and a label with no digits that reads as a totals label.
 */
function timedTotals(row: string): Row | null {
  const m = LEADING_TIME_RE.exec(row);
  if (!m) return null;
  const rest = row.slice(m[0].length);
  if (findTokens(rest).length !== 1 || PAYMENT_RE.test(rest)) return null;
  const { label, cents } = splitPrice(rest);
  if (cents === null || /\d/.test(label)) return null;
  const which = totalKind(repairLabel(label));
  return which && which !== 'summary' ? totalsRow(which, label, cents) : null;
}

/**
 * A unit-price annotation is taken off the row before anything else, so it is never read as a
 * price or a menu number. With no line price on the row, the price is qty x unit.
 */
function classify(row: string, inTipBlock: boolean): Row {
  // Time, payment and header rows are skipped as before ("Party of 2 @ 7.00 PM" is not an item).
  const plain = PAYMENT_RE.test(row) || HEADER_INFO_RE.test(row) || TIME_RE.test(row);
  const found = plain ? null : findUnitNote(row);
  if (!found) return classifyRow(row, inTipBlock, null);
  const { note, rest } = found;
  if (!/[a-z]/i.test(rest)) return { kind: 'unitNote', note };
  const r = classifyRow(rest, inTipBlock, note.qty * note.unitCents);
  return r.kind === 'priced' ? { ...r, note } : r;
}

/** `fallbackCents` is the row's price when no money token is printed on it. */
function classifyRow(row: string, inTipBlock: boolean, fallbackCents: number | null): Row {
  if ((inTipBlock && PERCENT_RE.test(row)) || MULTI_PERCENT_RE.test(row)) return { kind: 'skip' };
  const split = splitPrice(row);
  const label = split.label;
  const cents = split.cents ?? fallbackCents;
  if (MOD_ADD_RE.test(row)) {
    return { kind: 'modifier', text: label.replace(MOD_ADD_RE, '').trim(), cents };
  }
  if (MOD_REMOVE_RE.test(row) && (cents === null || cents <= 0)) {
    return { kind: 'modifier', text: label, cents };
  }
  const timed = timedTotals(row);
  if (timed) return timed;
  if (PAYMENT_RE.test(row) || HEADER_INFO_RE.test(row) || TIME_RE.test(row)) return { kind: 'skip' };
  // Unpriced rows are never items, which covers the spec's "date, time or phone with no price" rule.
  if (cents === null) return { kind: 'skip' };
  const which = totalKind(repairLabel(label));
  if (which === 'summary') return { kind: 'skip' };
  if (which) return totalsRow(which, label, cents);
  if (cents < 0 || isDiscountLabel(label)) {
    return { kind: 'discount', label: cleanName(label) || 'Discount', cents: Math.abs(cents) };
  }
  // Only amounts (e.g. the "$7.43 $9.90 $12.38" line of a tip guide): never an item.
  if (!/[a-z]/i.test(label)) return { kind: 'skip' };
  return { kind: 'priced', label, cents };
}

/**
 * Review R1 fallback: when a name and its price land on separate rows (e.g. a tilted photo the
 * row grouping could not fix), join a text row with no price to a directly following price-only row,
 * or to a following "2 @ 3.50 7.00" row (the qty, unit and line price under the name).
 */
function mergeSplitRows(rows: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i] ?? '';
    const next = rows[i + 1];
    if (next !== undefined && /[a-z]/i.test(cur) && splitPrice(cur).cents === null) {
      const n = splitPrice(next);
      if (n.cents !== null && (n.label === '' || isPricedNoteRow(next))) {
        out.push(`${cur} ${next}`);
        i++;
        continue;
      }
    }
    out.push(cur);
  }
  return out;
}

/**
 * A tilted photo can make the row grouping join two totals lines into one row, e.g.
 * "09:19PM Tota) 126.37 Gratuity 15.60" (Raintree). Split a row with exactly two amounts after the
 * first one, but only when both halves are totals rows on their own; item rows are never split.
 */
function splitJoinedTotals(rows: string[]): string[] {
  return rows.flatMap((row) => {
    const tokens = findTokens(row);
    const first = tokens[0];
    if (tokens.length !== 2 || !first) return [row];
    const end = first.index + first.text.length;
    const left = row.slice(0, end).trim();
    const right = row.slice(end).trim();
    const bothTotals = [left, right].every((half) => classify(half, false).kind === 'totals');
    return bothTotals ? [left, right] : [row];
  });
}

// ---------- items ----------

const QTY_X_RE = /^(\d{1,2})\s*x\s+(.+)$/i; // "2 x Burger", "2x Burger"
// "2 Burger", or "1 6. Taco" / "1 2) Combo" where "6." / "2)" is a menu number that stays in the
// name. A number followed by "." or ")" is never the quantity (user rule, 2026-11-22), so
// "6. Taco" alone is qty 1. Known limitation: "3 Cheese Pizza" reads as qty 3 of "Cheese Pizza".
// The name may also start with any word that starts with a digit, e.g. "1 607 FILET", "2 12OZ
// RIBEYE", "1 2007 Vintage", "1 24/7 Fries": the first integer is the qty and the rest is the name,
// as long as a word with a letter follows. A word ending in "." or ")" is a menu number (above).
const QTY_LEAD_RE = /^(\d{1,2})\s+((?:\d{1,3}[.)]\s*|\d(?:\S*[^\s.)])?\s+)?[a-z].*)$/i;
// A unit word after a leading number means a size, not a quantity: "12 oz Steak" (review R6).
// "0z" is "oz" with the O read as a zero.
const SIZE_UNIT_RE = /^(?:[o0]z|lbs?|pcs?|pieces?|in|inch(?:es)?|pk|ct|g|ml)\b/i;
// "Burger 2", "Burger x2", "Burger x 2", "Burger 2x" (before a unit price or the line price).
const QTY_TAIL_RE = /^(.*?[a-z].*?)\s+(?:x\s?(\d{1,2})|(\d{1,2})\s?x|(\d{1,2}))$/i;
const EACH_RE = /\s+(?:ea|each)\.?$/i;

function unitFor(totalCents: number, qty: number): number | null {
  return totalCents % qty === 0 ? totalCents / qty : null;
}

type NamedQty = { name: string; qty: number };
/** `explicit` = written with an x ("x2", "2x", "2 x"). */
type FoundQty = NamedQty & { explicit: boolean };

/** Where the receipt's column header puts the QTY column, if it has one. */
type QtyColumn = { qtyFirst: boolean | null } | null;

/** A quantity after the name. */
function trailingQty(s: string): FoundQty | null {
  const m = QTY_TAIL_RE.exec(s);
  if (!m) return null;
  const digits = m[2] ?? m[3] ?? m[4] ?? '';
  const qty = parseInt(digits, 10);
  return qty >= 1 ? { name: m[1] ?? '', qty, explicit: m[4] === undefined } : null;
}

// ---------- OCR confusion in size units ----------

// Size units as OCR reads them, with the common swaps O<->0, Z<->2/7, l<->1, S<->5 (case ignored).
// Longer units first, so "lbs" wins over "lb" and "kg" over "g".
const SIZE_UNITS: readonly (readonly [canonical: string, ocr: string])[] = [
  ['oz', '[o0][z27]'],
  ['lbs', '[l1]b[s5]'],
  ['lb', '[l1]b'],
  ['ml', 'm[l1]'],
  ['kg', 'kg'],
  ['g', 'g'],
  ['in', 'in'],
];
// The first token of the name: a size number (1-999, no leading zero) glued to a unit, followed by
// a word with a letter, e.g. "6OZ FILET", "160Z STRIP", "21b Brisket", "750m1 Wine".
const GLUED_SIZE_RE = new RegExp(
  String.raw`^([1-9]\d{0,2})(${SIZE_UNITS.map(([, ocr]) => ocr).join('|')})(?=\s+[a-z])`,
  'i',
);
// The same unit as its own word after the number: "12 0Z Steak" -> "12 oz Steak".
const SPACED_OZ_RE = /^([1-9]\d{0,2})\s+0z(?=\s+[a-z])/i;

/**
 * Repairs an OCR-damaged size unit at the start of a name to "<n><unit>". Prices, totals and tokens
 * later in the name are never touched. When every character of the unit was read as a digit
 * ("607" = 6 + "07"), the token can't be told from a real number, so it is only repaired right after
 * a leading quantity and only for a one-digit size 2-9: "107", "1207" and a year like "2007" stay.
 */
function fixSizeUnit(name: string, afterQty: boolean): string {
  const spaced = name.replace(SPACED_OZ_RE, '$1 oz');
  if (spaced !== name) return spaced;
  const m = GLUED_SIZE_RE.exec(name);
  if (!m) return name;
  const size = m[1] ?? '';
  const ocr = m[2] ?? '';
  const unit = SIZE_UNITS.find(([, re]) => new RegExp(`^(?:${re})$`, 'i').test(ocr));
  if (!unit) return name;
  if (/^\d+$/.test(ocr) && !(afterQty && /^[2-9]$/.test(size))) return name;
  return `${size}${unit[0]}${name.slice(m[0].length)}`;
}

function leadingQty(s: string): FoundQty | null {
  const x = QTY_X_RE.exec(s);
  const lead = x ? null : QTY_LEAD_RE.exec(s);
  const m = x ?? (lead && !SIZE_UNIT_RE.test(lead[2] ?? '') ? lead : null);
  const qty = m ? parseInt(m[1] ?? '', 10) : 0;
  return m && qty >= 1 ? { name: fixSizeUnit(m[2] ?? '', true), qty, explicit: x !== null } : null;
}

/**
 * The quantity directly left or right of the name (user rule, 2026-11-22). `tailOk` decides whether
 * a bare number after the name counts. With a QTY column header, its order decides:
 * - ITEM QTY PRICE: an integer before the name is noise and is dropped ("4 CAUSA DE POLLO RTE
 *   $8.95" is 1 x "CAUSA DE POLLO RTE"); only "2 x Burger" still counts as a leading qty.
 * - QTY ITEM PRICE: an integer after the name is not the qty and stays in the name ("Combo 3");
 *   only "Wings x3" still counts as a trailing qty.
 * Without a header (or one with no item column), `tailFirst` picks which side wins.
 */
function qtyNextToName(
  s: string,
  qtyColumn: QtyColumn,
  tailOk: (tail: FoundQty) => boolean,
  tailFirst: boolean,
): NamedQty | null {
  const lead = leadingQty(s);
  const t = trailingQty(s);
  const tail = t && tailOk(t) ? t : null;
  switch (qtyColumn?.qtyFirst) {
    case false: {
      if (tail) {
        const noise = leadingQty(tail.name);
        return { name: noise && !noise.explicit ? noise.name : tail.name, qty: tail.qty };
      }
      if (lead) return lead.explicit ? lead : { name: lead.name, qty: 1 };
      return null;
    }
    case true:
      return lead ?? (tail?.explicit ? tail : null);
    default:
      return tailFirst ? (tail ?? lead) : (lead ?? tail);
  }
}

/**
 * A printed unit price at the end of the label: "Burger 2 12.99", "Soda 2 @ $ 2.50 ea" (review R4).
 * Returns the text before it, with any `@` removed.
 */
function trailingUnit(label: string): { before: string; unit: number } | null {
  const s = label.replace(EACH_RE, '');
  const t = findLastToken(s);
  if (!t || t.cents <= 0 || t.index + t.text.length !== s.length) return null;
  const before = s.slice(0, t.index);
  if (before !== '' && !/[\s@]$/.test(before)) return null;
  return { before: before.replace(/\s*@\s*$/, '').trim(), unit: t.cents };
}

function toItem(label: string, totalCents: number, qtyColumn: QtyColumn, note: UnitNote | null): ParsedItem | null {
  let name = label;
  let qty = 1;
  let printedUnit: number | null = null;

  if (note) {
    // The annotation gives qty and unit. The same qty also printed next to the name is dropped
    // ("2 Margarita (2@3.50)"); a different number stays in the name ("Combo 3 (2@3.50)").
    ({ qty, unitCents: printedUnit } = note);
    const found = qtyNextToName(label, null, () => true, false);
    if (found && found.qty === note.qty) name = found.name;
  }
  const col = note ? null : trailingUnit(label);
  if (col) {
    printedUnit = col.unit;
    name = col.before;
    const found = qtyNextToName(col.before, qtyColumn, () => true, true);
    if (found) ({ name, qty } = found);
  } else if (!note) {
    // Backlog item 2: the one price is the line price. A bare number after the name counts when it
    // is written with an x, when a QTY column header is present, or when the price divides by it
    // exactly ("Wings 10 12.99" stays a name).
    const tailOk = (tail: FoundQty) => tail.explicit || qtyColumn !== null || totalCents % tail.qty === 0;
    const found = qtyNextToName(label, qtyColumn, tailOk, false);
    if (found) ({ name, qty } = found);
  }

  name = fixSizeUnit(cleanName(name), false);
  if (!/[a-z0-9]/i.test(name)) return null; // a bare price with no name
  const item: ParsedItem = {
    name,
    qty,
    unitCents: printedUnit ?? unitFor(totalCents, qty),
    totalCents,
    modifiers: [],
  };
  if (note ? !noteFits(note, totalCents) : printedUnit !== null && printedUnit * qty !== totalCents) {
    item.flags = ['qty_price_mismatch'];
  }
  return item;
}

function flagItem(item: ParsedItem): void {
  if (!item.flags?.includes('qty_price_mismatch')) item.flags = [...(item.flags ?? []), 'qty_price_mismatch'];
}

/** qty x unit matches the line price within the totals tolerance (a rounded unit like "3@0.33 1.00"). */
function noteFits(note: UnitNote, totalCents: number): boolean {
  return Math.abs(note.qty * note.unitCents - totalCents) <= TOLERANCE_CENTS;
}

/** A unit-price line under (or over) an item: the printed line price is kept, qty and unit come from the note. */
function applyNote(item: ParsedItem, note: UnitNote): void {
  item.qty = note.qty;
  item.unitCents = note.unitCents;
  if (!noteFits(note, item.totalCents)) flagItem(item);
}

// ---------- totals check ----------

const TOLERANCE_CENTS = 1;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** The two reconciliation checks, as signed gaps in cents. */
export type TotalsGaps = Partial<Record<'items_vs_subtotal' | 'subtotal_vs_total', number>>;

/**
 * How far off each totals check is, in signed cents (computed minus printed). A check that can't
 * run (a needed number is missing) has no entry. checkTotals flags a gap over 1 cent; the form
 * shows it as "Off by $X".
 */
export function totalsGaps(r: ParsedReceipt): TotalsGaps {
  const gaps: TotalsGaps = {};
  const discountsOn = (on: Discount['appliesTo']) => sum(r.discounts.filter((d) => d.appliesTo === on).map((d) => d.cents));
  const itemsCents = sum(r.items.map((i) => i.totalCents));
  const extras = (r.taxCents ?? 0) + (r.feesCents ?? 0) + (r.tipCents ?? 0);

  if (r.subtotalCents !== null && r.items.length > 0) {
    gaps.items_vs_subtotal = itemsCents - discountsOn('subtotal') - r.subtotalCents;
  }
  if (r.subtotalCents !== null && r.totalCents !== null) {
    gaps.subtotal_vs_total = r.subtotalCents + extras - discountsOn('total') - r.totalCents;
  }
  // A2.1: with no subtotal line, check the items (less every discount) plus extras against the total.
  if (r.subtotalCents === null && r.totalCents !== null && r.items.length > 0) {
    gaps.subtotal_vs_total = itemsCents - sum(r.discounts.map((d) => d.cents)) + extras - r.totalCents;
  }
  return gaps;
}

/** Reconciliation reasons for a receipt (qty_price_mismatch is added by parseReceipt / the form). */
export function checkTotals(r: ParsedReceipt): ReviewReason[] {
  const reasons: ReviewReason[] = [];
  if (r.items.length === 0) reasons.push('no_items');
  if (r.subtotalCents === null) reasons.push('missing_subtotal');
  if (r.totalCents === null) reasons.push('missing_total');

  const gaps = totalsGaps(r);
  for (const reason of ['items_vs_subtotal', 'subtotal_vs_total'] as const) {
    const gap = gaps[reason];
    if (gap !== undefined && Math.abs(gap) > TOLERANCE_CENTS) reasons.push(reason);
  }
  return reasons;
}

// ---------- parser ----------

/**
 * Some receipts print no "Subtotal": "Total" is the subtotal, then a tip or service charge, then a
 * second "Total". The first Total may be read as the subtotal (row indexes of the first and last
 * Total returned) only when all of these hold; parseReceipt checks R2 (no subtotal row anywhere):
 *   R1. 2+ Total rows with exactly 2 distinct amounts, and the first differs from the last
 *       (3+ distinct amounts is an unusual layout: keep today's reading).
 *   R3. No tax, tax-sum, tip or fees row before the first Total. Excludes the card slip: Tax,
 *       "Total 50.00", then "Tip 10.00 / Total 60.00", where the first Total already includes the
 *       tax; likewise a fee or tip printed above the first Total is already inside it.
 *   R4. The first Total is below the last, or above it with a discount row between them.
 * Tax and discount rows strictly between the two Totals then also count (included-tax rows don't:
 * that tax is inside the first Total), and parseReceipt keeps the reading only if it doesn't add a
 * totals mismatch (R5). Spec docs/specs/2026-11-24-first-total-as-subtotal.md, amendments A1-A7.
 */
function firstTotalSpan(rows: Row[]): { first: number; last: number } | null {
  const totals = rows.flatMap((r, i) => (r.kind === 'totals' && r.which === 'total' ? [{ i, cents: r.cents }] : []));
  const first = totals[0];
  const last = totals[totals.length - 1];
  if (!first || !last || first.cents === last.cents) return null;
  if (new Set(totals.map((t) => t.cents)).size !== 2) return null;
  const extraBefore = rows
    .slice(0, first.i)
    .some((r) => r.kind === 'totals' && r.which !== 'subtotal' && r.which !== 'total');
  if (extraBefore) return null;
  const discountBetween = rows.slice(first.i + 1, last.i).some((r) => r.kind === 'discount');
  if (first.cents > last.cents && !discountBetween) return null;
  return { first: first.i, last: last.i };
}

/**
 * Two or more tip lines (e.g. "Optional Service 12.00" on the bill and "Tip 5.00" on the card slip)
 * are either the same tip printed twice or two tips. The last line is the tip, as before; they are
 * added up only when the sum reconciles with the printed total and the last line alone does not.
 * So a tip is never counted twice, and with no total to check against the last line is kept.
 */
function chooseTip(r: ParsedReceipt, tipLines: number[]): number | null {
  const last = r.tipCents;
  if (tipLines.length < 2 || r.totalCents === null) return last;
  const reconciles = (tipCents: number | null) => {
    const gap = totalsGaps({ ...r, tipCents }).subtotal_vs_total;
    return gap !== undefined && Math.abs(gap) <= TOLERANCE_CENTS;
  };
  const summed = sum(tipLines);
  return !reconciles(last) && reconciles(summed) ? summed : last;
}

export function parseReceipt(text: RecognizedText): ParsedReceipt {
  const rowTexts = splitJoinedTotals(mergeSplitRows(toRows(text)));

  // Pass 1: classify, tracking the suggested-tip block.
  let inTipBlock = false;
  let qtyColumn: QtyColumn = null;
  let qtyHeaderIndex = -1;
  const rows: Row[] = rowTexts.map((row, index) => {
    if (qtyHeaderIndex < 0 && QTY_HEADER_RE.test(row) && !SUMMARY_RE.test(row) && splitPrice(row).cents === null) {
      const q = row.search(QTY_HEADER_RE);
      const i = row.search(ITEM_HEADER_RE);
      qtyColumn = { qtyFirst: i < 0 ? null : q < i };
      qtyHeaderIndex = index;
      return { kind: 'skip' };
    }
    if (TIP_BLOCK_HEADER_RE.test(row)) {
      inTipBlock = true;
      return { kind: 'skip' };
    }
    if (inTipBlock && !PERCENT_RE.test(row)) inTipBlock = false;
    return classify(row, inTipBlock);
  });

  // Items end at the first subtotal row, or at the first totals row if there is no subtotal.
  const firstSubtotal = rows.findIndex((r) => r.kind === 'totals' && r.which === 'subtotal');
  const firstTotals = rows.findIndex((r) => r.kind === 'totals');
  const cutoff = firstSubtotal >= 0 ? firstSubtotal : firstTotals >= 0 ? firstTotals : rows.length;

  const span = firstSubtotal < 0 ? firstTotalSpan(rows) : null; // R2: no subtotal row anywhere
  const betweenTotals = (index: number) => span !== null && index > span.first && index < span.last;

  const items: ParsedItem[] = [];
  const discounts: Discount[] = [];
  let subtotalCents: number | null = null;
  let taxCents: number | null = null;
  let tipCents: number | null = null;
  let feesCents: number | null = null;
  let totalCents: number | null = null;
  // The item the next modifier or item-level discount attaches to: only set while the rows
  // directly under an item are its modifiers or discounts.
  let lastItem: ParsedItem | null = null;
  let seenTotal = false;
  let seenTaxSum = false;
  // A unit-price line printed over its item, waiting for the item row directly below it.
  let pendingNote: UnitNote | null = null;
  // Every tip line in order (see the tip choice after the loop).
  const tipLines: number[] = [];
  // Tax and discounts as they stood at the first Total: the tip is chosen as without the rule (A4).
  let taxAtFirstTotal: number | null = null;
  let discountsAtFirstTotal = 0;
  // Items that already have their qty and unit from a note: a second note never overrides one.
  const noted = new Set<ParsedItem>();

  rows.forEach((row, index) => {
    if (row.kind === 'unitNote') {
      // A "(2@3.50)" line goes to the item directly above it, or else the item directly below.
      // When both exist, the one whose line price is qty x unit wins; the item above on a tie.
      const next = rows[index + 1];
      const below = next?.kind === 'priced' && !next.note && index + 1 < cutoff ? next : null;
      const above = lastItem && !noted.has(lastItem) && index < cutoff ? lastItem : null;
      if (above && (noteFits(row.note, above.totalCents) || !below || !noteFits(row.note, below.cents))) {
        applyNote(above, row.note); // lastItem stays: modifiers under the note still attach
        noted.add(above);
        return;
      }
      pendingNote = below && !seenTotal ? row.note : null;
      lastItem = null;
      return;
    }
    const carriedNote = pendingNote;
    pendingNote = null;

    if (row.kind === 'modifier') {
      if (lastItem && index < cutoff && row.text !== '') {
        lastItem.modifiers.push(row.text);
        if (row.cents !== null) {
          lastItem.totalCents += row.cents;
          lastItem.unitCents = unitFor(lastItem.totalCents, lastItem.qty);
        }
      }
      return;
    }

    // A2.2: a discount directly under an item (before the subtotal) folds into that item.
    if (row.kind === 'discount' && lastItem && index < cutoff) {
      if (row.cents <= lastItem.totalCents) {
        lastItem.modifiers.push(row.label);
        lastItem.totalCents -= row.cents;
        lastItem.unitCents = unitFor(lastItem.totalCents, lastItem.qty);
      } else {
        // Larger than the item: keep it bill-level and ask the host to check that item.
        discounts.push({ label: row.label, cents: row.cents, appliesTo: 'subtotal' });
        flagItem(lastItem);
        lastItem = null;
      }
      return;
    }
    lastItem = null;

    if (row.kind === 'totals') {
      // After the total, only tip, fees and (a later) total still count.
      const countsAfterTotal =
        row.which === 'tip' ||
        row.which === 'fees' ||
        row.which === 'total' ||
        (betweenTotals(index) && (row.which === 'tax' || row.which === 'taxSum') && !row.included);
      if (seenTotal && !countsAfterTotal) return;
      switch (row.which) {
        case 'subtotal':
          if (subtotalCents === null) subtotalCents = row.cents; // the first one wins
          break;
        case 'tax':
          if (!seenTaxSum) taxCents = (taxCents ?? 0) + row.cents;
          break;
        case 'taxSum':
          // Replaces the itemized tax lines it sums; later plain tax lines are part of it too.
          taxCents = row.cents;
          seenTaxSum = true;
          break;
        case 'fees':
          feesCents = (feesCents ?? 0) + row.cents;
          break;
        case 'tip':
          tipCents = row.cents;
          tipLines.push(row.cents);
          break;
        case 'total':
          if (!seenTotal) {
            taxAtFirstTotal = taxCents;
            discountsAtFirstTotal = discounts.length;
          }
          if (index === span?.first) subtotalCents = row.cents;
          totalCents = row.cents; // the last one wins
          seenTotal = true;
          break;
      }
      return;
    }
    // Anything else after the total is ignored, except a discount between a first-Total subtotal
    // and the last Total, which comes off the total.
    if (seenTotal && !(row.kind === 'discount' && betweenTotals(index))) return;

    if (row.kind === 'discount') {
      discounts.push({ label: row.label, cents: row.cents, appliesTo: index < cutoff ? 'subtotal' : 'total' });
      return;
    }
    if (row.kind === 'priced' && index < cutoff) {
      const item = toItem(row.label, row.cents, index > qtyHeaderIndex ? qtyColumn : null, row.note ?? carriedNote);
      if (item) {
        if (row.note ?? carriedNote) noted.add(item);
        items.push(item);
        lastItem = item;
      }
    }
  });

  const receipt: ParsedReceipt = {
    items,
    subtotalCents,
    taxCents,
    tipCents,
    feesCents,
    discounts,
    totalCents,
    needsReview: false,
    reasons: [],
  };
  // The reading without the several-Total rule: no subtotal, and none of the tax or discounts the
  // rule added after the first Total. Without the rule (span null) it is the receipt itself.
  const withoutRule: ParsedReceipt = span
    ? {
        ...receipt,
        subtotalCents: null,
        taxCents: taxAtFirstTotal,
        discounts: discounts.slice(0, discountsAtFirstTotal),
      }
    : receipt;
  // A4: the tip is chosen as without the rule.
  const tip = chooseTip(withoutRule, tipLines);
  receipt.tipCents = tip;
  withoutRule.tipCents = tip;
  // R5 (A6, A7): the receipt is read entirely as without the rule when either
  //   (a) the rule's reading has a totals mismatch and the reading without it has none, or
  //   (b) the rule's subtotal-vs-total check is off by more than the tolerance and the rule
  //       added tax or discounts: those extras don't fit, so they aren't trusted.
  const mismatched = (r: ParsedReceipt) =>
    checkTotals(r).some((reason) => reason === 'items_vs_subtotal' || reason === 'subtotal_vs_total');
  const ruleGap = totalsGaps(receipt).subtotal_vs_total;
  const ruleAddedExtras =
    receipt.taxCents !== withoutRule.taxCents || receipt.discounts.length !== withoutRule.discounts.length;
  const extrasDontFit = ruleGap !== undefined && Math.abs(ruleGap) > TOLERANCE_CENTS && ruleAddedExtras;
  const fallBack = span !== null && ((mismatched(receipt) && !mismatched(withoutRule)) || extrasDontFit);
  const chosen = fallBack ? withoutRule : receipt;
  const reasons = checkTotals(chosen);
  if (items.some((i) => i.flags?.includes('qty_price_mismatch'))) reasons.push('qty_price_mismatch');
  return { ...chosen, reasons, needsReview: reasons.length > 0 };
}
