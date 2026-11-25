// Plain-text receipt answer files: `receipts/answers/<photo name without extension>.txt`, the
// correct ("expected") result for one photo, written the way a receipt reads, in dollars. The eval
// (scripts/eval-receipts.ts) turns each into an ExpectedReceipt in integer cents. How-to for the
// user: docs/setup/receipt-answers.md.
//
//   # lines starting with # are comments
//   1  Dos Tacos (Brunch)   18.00        item: whole-number qty, name, line price (2 decimals, optional $)
//   subtotal  52.70                      subtotal / tax / tip / fees / total: amount, "-" or blank = not printed
//   discount 2.00                        taken off the total (subtotal + tax + tip + fees - discount = total)
//   discount before subtotal 1.50        taken off the items (items - discount = subtotal)
//   checked: yes                         ready to score; absent or "no" = draft, skipped by the eval
//
// Pure: no I/O. Money is read from the digit string by lib/money.ts, never through a float.
import { formatCentsInput, parseMoneyToken } from './money';
import { assignSet, type EvalSet, type ExpectedItem, type ExpectedReceipt, type SetReason, type Validation } from './receiptEval';
import { checkTotals, totalsGaps } from './receiptText';
import type { Discount, ParsedReceipt } from './receiptTypes';

export type Answer = {
  checked: boolean;
  items: ExpectedItem[];
  subtotalCents: number | null;
  taxCents: number | null;
  tipCents: number | null;
  feesCents: number | null;
  discounts: Discount[];
  totalCents: number | null;
};

/** Longest quantity we accept, so a typo like "12 50" (a price split by a space) stands out. */
const MAX_QTY = 999;
const DEFAULT_DISCOUNT_LABEL = 'Discount';
const NO_NAME = '(no name)';

// Optional `$` (and one space after it), plain or comma-grouped dollars, exactly two decimals.
const AMOUNT_RE = /^\$?\s?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}$/;
// Anything that looks like someone tried to write a number: used to choose the error message.
const NUMBERISH_RE = /^[-(]?\$?[\d,.]*\d[\d,.]*\)?-?$/;
const KEYWORD_RE = /^(subtotal|tax|tip|fees?|total|discount|checked)(?=[\s:]|$)\s*:?\s*(.*)$/i;

type Amount = { kind: 'ok'; cents: number } | { kind: 'negative' } | { kind: 'bad' };

/** One amount as written in an answer file. A leading `-` is reported as negative, not dropped. */
function readAmount(s: string): Amount {
  const t = s.trim();
  const negative = t.startsWith('-');
  const body = negative ? t.slice(1).trim() : t;
  if (!AMOUNT_RE.test(body)) return { kind: 'bad' };
  const cents = parseMoneyToken(body);
  if (cents === null || cents < 0) return { kind: 'bad' }; // too many digits to be exact
  return negative && cents > 0 ? { kind: 'negative' } : { kind: 'ok', cents };
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Parse an answer file. Every error names the file and the line (counted from 1, comments
 * included) and says what a correct line looks like. Nothing is guessed or coerced.
 */
export function parseAnswer(text: string, file: string): Validation<Answer> {
  const errors: string[] = [];
  const at = (n: number, msg: string) => errors.push(`${file} line ${n}: ${msg}`);
  const answer: Answer = {
    checked: false,
    items: [],
    subtotalCents: null,
    taxCents: null,
    tipCents: null,
    feesCents: null,
    discounts: [],
    totalCents: null,
  };
  const seenOnce = new Map<string, number>();
  const once = (key: string, n: number): boolean => {
    const first = seenOnce.get(key);
    if (first !== undefined) {
      at(n, `${key} is written twice (first on line ${first}); keep one`);
      return false;
    }
    seenOnce.set(key, n);
    return true;
  };

  text.split(/\r?\n/).forEach((raw, i) => {
    const n = i + 1;
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;

    if (/^\d/.test(line)) {
      readItem(line, n);
      return;
    }
    const kw = KEYWORD_RE.exec(line);
    if (!kw) {
      const word = line.split(/\s+/)[0] ?? line;
      at(
        n,
        `"${word}" isn't understood. Item lines start with a quantity, like "1  Fish Tacos  12.50"; other lines start with subtotal, tax, tip, fees, discount, total or checked; comments start with #`,
      );
      return;
    }
    const key = (kw[1] ?? '').toLowerCase();
    const value = (kw[2] ?? '').trim();

    if (key === 'checked') {
      if (!once('checked', n)) return;
      if (/^yes$/i.test(value)) answer.checked = true;
      else if (/^no$/i.test(value)) answer.checked = false;
      else at(n, `checked must be yes or no; got "${value}"`);
      return;
    }
    if (key === 'discount') {
      readDiscount(value, n);
      return;
    }

    const field = key === 'fee' ? 'fees' : key;
    if ((field === 'subtotal' || field === 'total' || field === 'tip') && !once(field, n)) return;
    if (value === '' || value === '-') {
      return; // not printed
    }
    const amount = readAmount(value);
    if (amount.kind === 'negative') {
      at(n, `${field} can't be negative; write it as printed without the minus`);
      return;
    }
    if (amount.kind === 'bad') {
      at(n, `${field} must be an amount like 12.50, or - if the receipt doesn't print it; got "${value}"`);
      return;
    }
    if (field === 'subtotal') answer.subtotalCents = amount.cents;
    else if (field === 'total') answer.totalCents = amount.cents;
    else if (field === 'tip') answer.tipCents = amount.cents;
    else if (field === 'tax') answer.taxCents = (answer.taxCents ?? 0) + amount.cents; // several tax lines add up
    else answer.feesCents = (answer.feesCents ?? 0) + amount.cents;
  });

  function readItem(line: string, n: number): void {
    const tokens = line.split(/\s+/);
    const qtyToken = tokens[0] ?? '';
    if (!/^\d+$/.test(qtyToken)) {
      at(n, `quantity must be a whole number on its own, like 2 (got "${qtyToken}"); write "2  Fish Tacos  25.00"`);
      return;
    }
    const qty = parseInt(qtyToken, 10);
    if (qty < 1 || qty > MAX_QTY) {
      at(n, `quantity must be a whole number 1 or more (got ${qtyToken})`);
      return;
    }
    let priceToken = tokens[tokens.length - 1] ?? '';
    let nameTokens = tokens.slice(1, -1);
    // "$ 12.50": the "$" is part of the price, not the name.
    if (nameTokens[nameTokens.length - 1] === '$') {
      priceToken = `$${priceToken}`;
      nameTokens = nameTokens.slice(0, -1);
    }
    if (tokens.length < 2 || !NUMBERISH_RE.test(priceToken)) {
      at(n, 'an item line ends with its price, like 12.50, e.g. "1  Fish Tacos  12.50"');
      return;
    }
    const amount = readAmount(priceToken);
    if (amount.kind === 'negative') {
      at(n, "an item price can't be negative; write a discount line instead (\"discount before subtotal 2.00\")");
      return;
    }
    if (amount.kind === 'bad') {
      at(n, `price must look like 12.50 (two decimals); got "${priceToken}"`);
      return;
    }
    const name = collapse(nameTokens.join(' '));
    if (name === '') {
      at(n, 'the item needs a name between the quantity and the price, like "1  Fish Tacos  12.50"');
      return;
    }
    answer.items.push({ name, qty, totalCents: amount.cents });
  }

  function readDiscount(value: string, n: number): void {
    let rest = value;
    let appliesTo: Discount['appliesTo'] = 'total';
    const before = /^before\s+subtotal\b\s*/i.exec(rest);
    if (before) {
      appliesTo = 'subtotal';
      rest = rest.slice(before[0].length);
    }
    const tokens = rest.split(/\s+/).filter(Boolean);
    let amountToken = tokens[tokens.length - 1] ?? '';
    let labelTokens = tokens.slice(0, -1);
    if (labelTokens[labelTokens.length - 1] === '$' || labelTokens[labelTokens.length - 1] === '-$') {
      amountToken = `${labelTokens[labelTokens.length - 1] ?? ''}${amountToken}`;
      labelTokens = labelTokens.slice(0, -1);
    }
    if (!NUMBERISH_RE.test(amountToken)) {
      at(n, 'a discount line ends with its amount, like "discount 2.00" or "discount before subtotal Happy hour 2.00"');
      return;
    }
    // A discount is always taken off, so "-2.00" as printed on the receipt means 2.00.
    const amount = readAmount(amountToken.replace(/^-/, ''));
    if (amount.kind !== 'ok') {
      at(n, `discount must be an amount like 2.00 (two decimals); got "${amountToken}"`);
      return;
    }
    answer.discounts.push({ label: collapse(labelTokens.join(' ')) || DEFAULT_DISCOUNT_LABEL, cents: amount.cents, appliesTo });
  }

  if (errors.length === 0 && answer.checked && answer.items.length === 0) {
    errors.push(`${file}: checked: yes but there are no item lines; add the items or set checked: no`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: answer };
}

const dollars = (cents: number | null) => (cents === null ? '-' : formatCentsInput(cents));

/**
 * The text of an answer file. `header` lines go first (each should start with "#"). The result
 * always parses back to the same answer (names have their whitespace collapsed).
 */
export function formatAnswer(a: Answer, opts: { header: string[] }): string {
  const out = [...opts.header];
  if (out.length > 0) out.push('');
  const names = a.items.map((i) => collapse(i.name) || NO_NAME);
  const qw = Math.max(1, ...a.items.map((i) => String(i.qty).length));
  const nw = Math.min(40, Math.max(0, ...names.map((s) => s.length)));
  const pw = Math.max(0, ...a.items.map((i) => dollars(i.totalCents).length));
  a.items.forEach((item, i) => {
    out.push(`${String(item.qty).padEnd(qw)}  ${(names[i] ?? NO_NAME).padEnd(nw)}  ${dollars(item.totalCents).padStart(pw)}`);
  });
  if (a.items.length > 0) out.push('');
  const row = (key: string, value: string) => out.push(`${key.padEnd(9)} ${value}`);
  row('subtotal', dollars(a.subtotalCents));
  row('tax', dollars(a.taxCents));
  row('tip', dollars(a.tipCents));
  row('fees', dollars(a.feesCents));
  for (const d of a.discounts) {
    const label = collapse(d.label);
    const key = d.appliesTo === 'subtotal' ? 'discount before subtotal' : 'discount';
    out.push(`${key}${label === '' || label === DEFAULT_DISCOUNT_LABEL ? '' : ` ${label}`}  ${dollars(d.cents)}`);
  }
  row('total', dollars(a.totalCents));
  out.push('');
  out.push(`checked: ${a.checked ? 'yes' : 'no'}`);
  return `${out.join('\n')}\n`;
}

const isCents = (v: number | null): v is number => v !== null && Number.isSafeInteger(v) && v >= 0;

/**
 * A draft answer from the app's parse of a photo. Anything a text file can't hold (a negative
 * price, a fractional qty) is left out and described in `notes`, so the draft always parses.
 */
export function answerFromParse(parsed: ParsedReceipt | null): { answer: Answer; notes: string[] } {
  const notes: string[] = [];
  const answer: Answer = {
    checked: false,
    items: [],
    subtotalCents: null,
    taxCents: null,
    tipCents: null,
    feesCents: null,
    discounts: [],
    totalCents: null,
  };
  if (parsed === null) return { answer, notes };
  for (const item of parsed.items) {
    const name = collapse(item.name) || NO_NAME;
    const qtyOk = Number.isInteger(item.qty) && item.qty >= 1 && item.qty <= MAX_QTY;
    if (!isCents(item.totalCents) || !qtyOk) {
      notes.push(
        `the app also read "${name} ${Number.isSafeInteger(item.totalCents) ? formatCentsInput(item.totalCents) : String(item.totalCents)}" (qty ${item.qty}), which an item line can't hold; if it's a discount, write a discount line`,
      );
      continue;
    }
    answer.items.push({ name, qty: item.qty, totalCents: item.totalCents });
  }
  const total = (key: 'subtotal' | 'tax' | 'tip' | 'fees' | 'total', v: number | null): number | null => {
    if (v === null || isCents(v)) return v;
    notes.push(`the app read ${key} ${Number.isSafeInteger(v) ? formatCentsInput(v) : String(v)}, which can't be right; left as -`);
    return null;
  };
  answer.subtotalCents = total('subtotal', parsed.subtotalCents);
  answer.taxCents = total('tax', parsed.taxCents);
  answer.tipCents = total('tip', parsed.tipCents);
  answer.feesCents = total('fees', parsed.feesCents);
  answer.totalCents = total('total', parsed.totalCents);
  for (const d of parsed.discounts) {
    if (isCents(d.cents)) answer.discounts.push({ label: collapse(d.label) || DEFAULT_DISCOUNT_LABEL, cents: d.cents, appliesTo: d.appliesTo });
    else notes.push(`the app read a discount "${d.label}" of ${String(d.cents)}, which can't be right; left out`);
  }
  return { answer, notes };
}

/** Migration from an old `eval/receipts/<name>.expected.json`: same values, checked kept. */
export function answerFromExpected(e: ExpectedReceipt): Answer {
  return {
    checked: e.status === 'checked',
    items: e.items.map((i) => ({ name: i.name, qty: i.qty, totalCents: i.totalCents })),
    subtotalCents: e.subtotalCents,
    taxCents: e.taxCents,
    tipCents: e.tipCents,
    feesCents: e.feesCents,
    discounts: e.discounts.map((d) => ({ label: d.label, cents: d.cents, appliesTo: d.appliesTo })),
    totalCents: e.totalCents,
  };
}

/** The scored form of an answer. The set comes from the set record, never from the answer file. */
export function answerToExpected(a: Answer, meta: { set: EvalSet; setReason: SetReason; photo: string }): ExpectedReceipt {
  return {
    version: 1,
    status: a.checked ? 'checked' : 'draft',
    set: meta.set,
    setReason: meta.setReason,
    photo: meta.photo,
    items: a.items.map((i) => ({ ...i })),
    subtotalCents: a.subtotalCents,
    taxCents: a.taxCents,
    tipCents: a.tipCents,
    feesCents: a.feesCents,
    discounts: a.discounts.map((d) => ({ ...d })),
    totalCents: a.totalCents,
  };
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

/** An answer as the parser's own result type, so the parser's totals rule can check it. */
function answerAsParsed(a: Answer): ParsedReceipt {
  return {
    items: a.items.map((i) => ({ name: i.name, qty: i.qty, unitCents: null, totalCents: i.totalCents, modifiers: [] })),
    subtotalCents: a.subtotalCents,
    taxCents: a.taxCents,
    tipCents: a.tipCents,
    feesCents: a.feesCents,
    discounts: a.discounts.map((d) => ({ ...d })),
    totalCents: a.totalCents,
    needsReview: false,
    reasons: [],
  };
}

/**
 * Does the answer add up? The parser's own rule (review R3; CLAUDE.md: one money rule, one
 * tolerance): `totalsGaps` gives the two checks' gaps and `checkTotals` decides which are over the
 * parser's tolerance (±1¢ per check), so a 1¢ gap adds up here exactly when it does in the app. A
 * receipt that really doesn't add up can still be checked; this is a warning for the user, not an error.
 */
export function answerTotalsCheck(a: Answer): { addsUp: boolean; problems: string[] } {
  const parsed = answerAsParsed(a);
  const gaps = totalsGaps(parsed);
  if (gaps.items_vs_subtotal === undefined && gaps.subtotal_vs_total === undefined) {
    return { addsUp: false, problems: ['no subtotal or total written, so nothing to check'] };
  }
  const over = new Set(checkTotals(parsed));
  const problems: string[] = [];
  const beforeSubtotal = sum(a.discounts.filter((d) => d.appliesTo === 'subtotal').map((d) => d.cents));
  if (over.has('items_vs_subtotal') && gaps.items_vs_subtotal !== undefined && a.subtotalCents !== null) {
    const lhs = a.subtotalCents + gaps.items_vs_subtotal;
    problems.push(
      beforeSubtotal > 0
        ? `items - discounts before subtotal = ${dollars(lhs)} but subtotal is ${dollars(a.subtotalCents)}`
        : `items add up to ${dollars(lhs)} but subtotal is ${dollars(a.subtotalCents)}`,
    );
  }
  if (over.has('subtotal_vs_total') && gaps.subtotal_vs_total !== undefined && a.totalCents !== null) {
    const lhs = a.totalCents + gaps.subtotal_vs_total;
    problems.push(
      a.subtotalCents !== null
        ? `subtotal + tax + tip + fees - discounts = ${dollars(lhs)} but total is ${dollars(a.totalCents)}`
        : `items + tax + tip + fees - discounts = ${dollars(lhs)} but total is ${dollars(a.totalCents)}`,
    );
  }
  return { addsUp: problems.length === 0, problems };
}

/** `receipts/x.jpeg` → `x`: the answer file's name is the photo's name without its extension. */
export function answerBaseName(photoFile: string): string {
  return photoFile.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
}

// ---------- the set record (eval/receipts/sets.json) ----------
// The tuning / held-out set is not in the answer file the user edits, so it can't be changed by
// accident. It is recorded once per eval name by `npm run answers:draft`, which only ever adds
// names. A name with no record gets the deterministic hash set.

export type SetEntry = { set: EvalSet; setReason: SetReason };
export type SetsFile = { version: 1; sets: Record<string, SetEntry> };

export function validateSetsFile(json: unknown, file: string): Validation<SetsFile> {
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isRecord(json)) return { ok: false, errors: [`${file}: must be a JSON object`] };
  const errors: string[] = [];
  if (json.version !== 1) errors.push(`${file}: version must be 1`);
  if (!isRecord(json.sets)) {
    errors.push(`${file}: sets must be an object of name -> { set, setReason }`);
  } else {
    for (const [name, e] of Object.entries(json.sets)) {
      if (!isRecord(e)) {
        errors.push(`${file}: sets.${name} must be an object`);
        continue;
      }
      if (e.set !== 'tuning' && e.set !== 'heldout') errors.push(`${file}: sets.${name}.set must be "tuning" or "heldout" (got ${JSON.stringify(e.set)})`);
      if (e.setReason !== 'hash' && e.setReason !== 'used-before-split') {
        errors.push(`${file}: sets.${name}.setReason must be "hash" or "used-before-split" (got ${JSON.stringify(e.setReason)})`);
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  // Every entry was checked above.
  return { ok: true, value: json as unknown as SetsFile };
}

/**
 * The set for an eval name: the recorded one; else the one in an old expected.json (migration);
 * else tuning if it was seen before the split; else the hash of the name.
 */
export function resolveSet(name: string, opts: { recorded?: SetEntry; legacy?: SetEntry; forceTuning: boolean }): SetEntry {
  if (opts.recorded) return { set: opts.recorded.set, setReason: opts.recorded.setReason };
  if (opts.legacy) return { set: opts.legacy.set, setReason: opts.legacy.setReason };
  if (opts.forceTuning) return { set: 'tuning', setReason: 'used-before-split' };
  return { set: assignSet(name), setReason: 'hash' };
}
