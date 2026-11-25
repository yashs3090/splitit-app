// Receipt eval core: scoring, decision rules, ground-truth validation and the tuning / held-out
// split (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, C1 / Task 1; Amendment A1).
// Pure and platform-free: no I/O, no Node or React Native imports. The CLI wrappers are
// scripts/eval-receipts.ts and scripts/eval-init.ts.
//
// Money is integer cents throughout. Nothing here knows about any particular receipt: every rule
// is about how receipts and OCR behave in general (spec D3).
import { checkTotals, parseReceipt, totalsGaps } from './receiptText';
import type { Discount, ParsedItem, ParsedReceipt, RecognizedLine, RecognizedText } from './receiptTypes';
import { assessQuality, pickBetter } from './scanPipeline/assessQuality';
import type { QualityVerdict, Scored } from './scanPipeline/types';

// ---------- constants ----------

/**
 * Least name similarity for a parsed item to count as an expected item (prices must also be equal).
 * Why: OCR typos change a few characters of a name ("0" for "o", a dropped letter), which keeps
 * similarity well above 0.6, while two different dishes at the same price rarely share 60% of
 * their characters in order. Equal cents is the strong signal; the name only has to be close.
 * Tuned: starting value (2026-11-22), not tuned.
 */
export const NAME_MATCH_THRESHOLD = 0.6;

/**
 * Fewest checked receipts per set for a decision.
 * Why: below about a dozen receipts, a gain of 2–3 items is within what one lucky or unlucky
 * photo produces, so the eval can't tell a real improvement from noise.
 * Tuned: spec value (C1). Amendment A1 lets the CLI decide provisionally below it.
 */
export const MIN_TUNING_RECEIPTS = 12;
export const MIN_HELDOUT_RECEIPTS = 8;

/**
 * Noise guard for clause (a): the least Σmatched gain on tuning that counts as a real gain.
 * Why: re-reading the same photos with a slightly different image can flip one or two items
 * either way for no systematic reason; requiring max(2, 2% of Σexpected) keeps that churn from
 * being adopted as a win, and scales with the size of the set.
 * Tuned: starting values (2026-11-22), not tuned.
 */
export const NOISE_FLOOR_ITEMS = 2;
export const NOISE_FRACTION = 0.02;

/**
 * Largest loss of matched items one receipt may take (clauses b and f).
 * Why: a change that helps on average but badly breaks one receipt would break that kind of
 * receipt for real users; a loss of 1 is allowed as OCR churn.
 */
export const MAX_RECEIPT_LOSS = 1;

/**
 * Largest rise in Σextra (junk items) on tuning (clause c).
 * Why: an extra item is money the host must delete by hand; allowing 1 tolerates churn.
 */
export const MAX_EXTRA_RISE = 1;

/** Longest name slug, so file names stay readable and well under file-system limits. */
export const MAX_NAME_LENGTH = 60;

// ---------- types ----------

export type EvalSet = 'tuning' | 'heldout';
export type SetReason = 'hash' | 'used-before-split';

export type ExpectedItem = { name: string; qty: number; totalCents: number };

/** `<name>.expected.json` (C1). */
export type ExpectedReceipt = {
  version: 1;
  status: 'draft' | 'checked';
  set: EvalSet;
  setReason: SetReason;
  photo: string;
  items: ExpectedItem[];
  subtotalCents: number | null;
  taxCents: number | null;
  tipCents: number | null;
  feesCents: number | null;
  discounts: Discount[];
  totalCents: number | null;
};

/** The parts of `<name>.<variant>.ocr.json` the eval reads (the harness writes the full C1 shape). */
export type OcrFile = { version: 1; variant?: string; photo?: string; lines: RecognizedLine[] };

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export type PricedName = { name: string; totalCents: number };

export type ReceiptScore = {
  name: string;
  set: EvalSet;
  expected: number;
  matched: number;
  /** Matched with an equal qty too. */
  exact: number;
  extra: number;
  reconciled: boolean;
  totalCorrect: boolean;
  missed: PricedName[];
  extraItems: PricedName[];
};

// ---------- names ----------

/** Lowercase, NFKD with diacritics stripped, letters and digits only. */
export function normalizeName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function levenshtein(a: string, b: string): number {
  const A = Array.from(a);
  const B = Array.from(b);
  let prev = Array.from({ length: B.length + 1 }, (_, j) => j);
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    for (let j = 1; j <= B.length; j++) {
      const cost = A[i - 1] === B[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[B.length] ?? 0;
}

/**
 * 1 − Levenshtein / longer length, on normalised names. 0 when either name has no letters or
 * digits, so two junk strings never match each other by name.
 */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (x.length === 0 || y.length === 0) return 0;
  const longer = Math.max(Array.from(x).length, Array.from(y).length);
  return 1 - levenshtein(x, y) / longer;
}

// ---------- matching and scoring ----------

export type ItemMatch = { expected: ExpectedItem; parsed: ParsedItem; similarity: number; exact: boolean };

/**
 * Greedy one-to-one matching: candidate pairs need exactly equal totalCents and a name similarity
 * at or above the threshold; the best similarity pairs first (an equal qty, then list order,
 * breaks ties so the result is deterministic).
 */
export function matchItems(
  expected: ExpectedItem[],
  parsed: ParsedItem[],
): { matches: ItemMatch[]; missed: ExpectedItem[]; extra: ParsedItem[] } {
  type Pair = { e: number; p: number; similarity: number; exact: boolean };
  const pairs: Pair[] = [];
  expected.forEach((ex, e) => {
    parsed.forEach((px, p) => {
      if (ex.totalCents !== px.totalCents) return;
      const similarity = nameSimilarity(ex.name, px.name);
      if (similarity >= NAME_MATCH_THRESHOLD) pairs.push({ e, p, similarity, exact: ex.qty === px.qty });
    });
  });
  pairs.sort((x, y) => y.similarity - x.similarity || Number(y.exact) - Number(x.exact) || x.e - y.e || x.p - y.p);

  const usedE = new Set<number>();
  const usedP = new Set<number>();
  const matches: ItemMatch[] = [];
  for (const pair of pairs) {
    if (usedE.has(pair.e) || usedP.has(pair.p)) continue;
    usedE.add(pair.e);
    usedP.add(pair.p);
    const ex = expected[pair.e];
    const px = parsed[pair.p];
    if (ex && px) matches.push({ expected: ex, parsed: px, similarity: pair.similarity, exact: pair.exact });
  }
  return {
    matches,
    missed: expected.filter((_, i) => !usedE.has(i)),
    extra: parsed.filter((_, i) => !usedP.has(i)),
  };
}

const priced = (i: { name: string; totalCents: number }): PricedName => ({ name: i.name, totalCents: i.totalCents });

/**
 * Score one parse against its ground truth.
 * `reconciled`: at least one totals check ran and `checkTotals` reports neither gap problem (the
 * parser's own ±1¢ tolerance). A parse where nothing could be checked doesn't count as adding up.
 */
export function scoreReceipt(name: string, expected: ExpectedReceipt, parsed: ParsedReceipt): ReceiptScore {
  const m = matchItems(expected.items, parsed.items);
  const reasons = checkTotals(parsed);
  const anyCheckRan = Object.keys(totalsGaps(parsed)).length > 0;
  return {
    name,
    set: expected.set,
    expected: expected.items.length,
    matched: m.matches.length,
    exact: m.matches.filter((x) => x.exact).length,
    extra: m.extra.length,
    reconciled: anyCheckRan && !reasons.includes('items_vs_subtotal') && !reasons.includes('subtotal_vs_total'),
    totalCorrect: parsed.totalCents === expected.totalCents,
    missed: m.missed.map(priced),
    extraItems: m.extra.map(priced),
  };
}

export type SetSummary = {
  set: EvalSet;
  receipts: number;
  matched: number;
  exact: number;
  expected: number;
  extra: number;
  reconciled: number;
  totalCorrect: number;
  /** Σmatched / Σexpected, or null when nothing was expected. */
  accuracy: number | null;
  /** Up to 3, worst first by (expected − matched) + extra. */
  worst: ReceiptScore[];
};

const badness = (s: ReceiptScore) => s.expected - s.matched + s.extra;
const sumOf = (xs: ReceiptScore[], f: (s: ReceiptScore) => number) => xs.reduce((a, s) => a + f(s), 0);

/** Summary of one set. Tuning and held-out are never pooled. */
export function summarizeSet(scores: ReceiptScore[], set: EvalSet): SetSummary {
  const xs = scores.filter((s) => s.set === set);
  const expected = sumOf(xs, (s) => s.expected);
  const matched = sumOf(xs, (s) => s.matched);
  return {
    set,
    receipts: xs.length,
    matched,
    exact: sumOf(xs, (s) => s.exact),
    expected,
    extra: sumOf(xs, (s) => s.extra),
    reconciled: xs.filter((s) => s.reconciled).length,
    totalCorrect: xs.filter((s) => s.totalCorrect).length,
    accuracy: expected === 0 ? null : matched / expected,
    worst: [...xs]
      .filter((s) => badness(s) > 0)
      .sort((a, b) => badness(b) - badness(a) || a.name.localeCompare(b.name))
      .slice(0, 3),
  };
}

// ---------- decision rules ----------

export type Clause = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g';
export type Verdict = 'ADOPT' | 'REJECT' | 'NO_DECISION' | 'TUNING_PASSED';

export type Decision = {
  verdict: Verdict;
  /** Every failing clause, in order. Empty unless REJECT. */
  failed: Clause[];
  /** One plain sentence. */
  reason: string;
  /** True when decided below the receipt minimum (Amendment A1). */
  provisional: boolean;
};

export type DecideOptions = {
  /** Look at held-out (clauses e–g). Without it the best result is TUNING_PASSED. */
  confirm: boolean;
  /** Amendment A1: decide below the 12 / 8 minimum, marked provisional. */
  allowBelowMinimum?: boolean;
};

const CLAUSE_TEXT: Record<Clause, string> = {
  a: 'tuning matched items did not rise by the noise guard',
  b: 'a tuning receipt lost more than 1 matched item',
  c: 'tuning extra items rose by more than 1',
  d: 'fewer tuning totals were correct',
  e: 'held-out matched items fell',
  f: 'a held-out receipt lost more than 1 matched item',
  g: 'fewer held-out totals were correct',
};

function decideWith(baseline: ReceiptScore[], candidate: ReceiptScore[], opts: DecideOptions, needGain: boolean): Decision {
  const no = (reason: string): Decision => ({ verdict: 'NO_DECISION', failed: [], reason, provisional: false });

  const baseBy = new Map(baseline.map((s) => [s.name, s]));
  const candBy = new Map(candidate.map((s) => [s.name, s]));
  const onlyBase = baseline.filter((s) => !candBy.has(s.name)).map((s) => s.name);
  const onlyCand = candidate.filter((s) => !baseBy.has(s.name)).map((s) => s.name);
  if (onlyBase.length > 0 || onlyCand.length > 0) {
    return no(`the variants scored different receipts (only baseline: ${onlyBase.join(', ') || 'none'}; only candidate: ${onlyCand.join(', ') || 'none'})`);
  }

  const tuning = baseline.filter((s) => s.set === 'tuning').length;
  const heldout = baseline.filter((s) => s.set === 'heldout').length;
  if (tuning === 0) return no('there are no checked tuning receipts');
  if (opts.confirm && heldout === 0) return no('there are no checked held-out receipts');
  const below = tuning < MIN_TUNING_RECEIPTS || heldout < MIN_HELDOUT_RECEIPTS;
  if (below && !opts.allowBelowMinimum) {
    return no(`INSUFFICIENT DATA: ${tuning} tuning / ${heldout} held-out receipts, minimum ${MIN_TUNING_RECEIPTS} / ${MIN_HELDOUT_RECEIPTS}`);
  }

  const failed: Clause[] = [];
  const check = (set: EvalSet, gain: Clause | null, loss: Clause, extra: Clause | null, totals: Clause) => {
    const base = baseline.filter((s) => s.set === set);
    const b = summarizeSet(base, set);
    const c = summarizeSet(candidate, set);
    const delta = c.matched - b.matched;
    if (gain) {
      const guard = Math.max(NOISE_FLOOR_ITEMS, Math.ceil(NOISE_FRACTION * b.expected));
      if (delta < guard) failed.push(gain);
    } else if (set === 'heldout' && delta < 0) {
      failed.push('e');
    }
    if (base.some((s) => s.matched - (candBy.get(s.name)?.matched ?? 0) > MAX_RECEIPT_LOSS)) failed.push(loss);
    if (extra && c.extra - b.extra > MAX_EXTRA_RISE) failed.push(extra);
    if (c.totalCorrect < b.totalCorrect) failed.push(totals);
  };

  check('tuning', needGain ? 'a' : null, 'b', 'c', 'd');
  if (failed.length === 0 && opts.confirm) check('heldout', null, 'f', null, 'g');

  const provisional = below;
  if (failed.length > 0) {
    const first = failed[0] as Clause;
    return { verdict: 'REJECT', failed, reason: `(${first}) ${CLAUSE_TEXT[first]}`, provisional };
  }
  if (!opts.confirm) {
    return { verdict: 'TUNING_PASSED', failed, reason: 'passes on tuning; run once with --confirm for held-out', provisional };
  }
  return { verdict: 'ADOPT', failed, reason: needGain ? 'gains on tuning and does no harm on held-out' : 'does no harm on tuning or held-out', provisional };
}

/**
 * C1 decision rule for an optional stage or parameter: ADOPT only if (a)–(d) hold on tuning and,
 * with `confirm`, (e)–(g) hold on held-out. Held-out is only looked at once tuning passes.
 */
export function decide(baseline: ReceiptScore[], candidate: ReceiptScore[], opts: DecideOptions): Decision {
  return decideWith(baseline, candidate, opts, true);
}

/** C1 rule for the core locate + crop stages: the same without (a), so no gain is needed, only no harm. */
export function decideCore(baseline: ReceiptScore[], candidate: ReceiptScore[], opts: DecideOptions): Decision {
  return decideWith(baseline, candidate, opts, false);
}

// ---------- flow simulation (--flow) ----------

export type FlowResult = Scored & { chosen: 'primary' | 'retry'; retried: boolean; verdict: QualityVerdict };

/**
 * The pipeline's retry logic over saved reads: keep an ok primary; otherwise, if there is a retry
 * read, keep the better of the two by `pickBetter` (a tie keeps the primary).
 */
export function simulateFlow(primary: RecognizedText, retry: RecognizedText | null): FlowResult {
  const score = (text: RecognizedText): Scored => {
    const parsed = parseReceipt(text);
    return { text, parsed, verdict: assessQuality(text, parsed) };
  };
  const p = score(primary);
  if (p.verdict.ok || retry === null) return { ...p, chosen: 'primary', retried: false };
  const r = score(retry);
  const best = pickBetter(p, r);
  return { ...best, chosen: best === p ? 'primary' : 'retry', retried: true };
}

// ---------- validation ----------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCents = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const show = (v: unknown) => (v === undefined ? 'missing' : JSON.stringify(v));

/**
 * Validate an expected.json body. Cents must be non-negative integers (never a float or a string),
 * qty an integer ≥ 1. Every error names the file and the field; nothing is coerced.
 */
export function validateExpected(json: unknown, file: string): Validation<ExpectedReceipt> {
  const errors: string[] = [];
  const err = (field: string, want: string, got: unknown) => errors.push(`${file}: ${field} must be ${want} (got ${show(got)})`);
  if (!isRecord(json)) return { ok: false, errors: [`${file}: must be a JSON object`] };

  const oneOf = (field: string, allowed: readonly unknown[]) => {
    if (!allowed.includes(json[field])) err(field, allowed.map((a) => JSON.stringify(a)).join(' or '), json[field]);
  };
  oneOf('version', [1]);
  oneOf('status', ['draft', 'checked']);
  oneOf('set', ['tuning', 'heldout']);
  oneOf('setReason', ['hash', 'used-before-split']);
  if (typeof json.photo !== 'string') err('photo', 'a string', json.photo);

  const centsOrNull = (field: string, v: unknown) => {
    if (v !== null && !isCents(v)) err(field, 'a non-negative integer number of cents or null', v);
  };
  for (const f of ['subtotalCents', 'taxCents', 'tipCents', 'feesCents', 'totalCents']) centsOrNull(f, json[f]);

  if (!Array.isArray(json.items)) {
    err('items', 'an array', json.items);
  } else {
    json.items.forEach((it: unknown, i) => {
      const at = `items[${i}]`;
      if (!isRecord(it)) return err(at, 'an object', it);
      if (typeof it.name !== 'string' || it.name.trim() === '') err(`${at}.name`, 'a non-empty string', it.name);
      if (!(typeof it.qty === 'number' && Number.isInteger(it.qty) && it.qty >= 1)) err(`${at}.qty`, 'an integer >= 1', it.qty);
      if (!isCents(it.totalCents)) err(`${at}.totalCents`, 'a non-negative integer number of cents', it.totalCents);
    });
  }

  if (!Array.isArray(json.discounts)) {
    err('discounts', 'an array', json.discounts);
  } else {
    json.discounts.forEach((d: unknown, i) => {
      const at = `discounts[${i}]`;
      if (!isRecord(d)) return err(at, 'an object', d);
      if (typeof d.label !== 'string') err(`${at}.label`, 'a string', d.label);
      if (!isCents(d.cents)) err(`${at}.cents`, 'a non-negative integer number of cents', d.cents);
      if (d.appliesTo !== 'subtotal' && d.appliesTo !== 'total') err(`${at}.appliesTo`, '"subtotal" or "total"', d.appliesTo);
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  // Every field was checked above; this narrows the validated object to its type.
  return { ok: true, value: json as unknown as ExpectedReceipt };
}

/** Validate the parts of an ocr.json the eval reads: version 1 and lines of { text, box? }. */
export function validateOcrFile(json: unknown, file: string): Validation<OcrFile> {
  const errors: string[] = [];
  const err = (field: string, want: string, got: unknown) => errors.push(`${file}: ${field} must be ${want} (got ${show(got)})`);
  if (!isRecord(json)) return { ok: false, errors: [`${file}: must be a JSON object`] };
  if (json.version !== 1) err('version', '1', json.version);
  if (!Array.isArray(json.lines)) {
    err('lines', 'an array', json.lines);
  } else {
    json.lines.forEach((l: unknown, i) => {
      if (!isRecord(l)) return err(`lines[${i}]`, 'an object', l);
      if (typeof l.text !== 'string') err(`lines[${i}].text`, 'a string', l.text);
      if (l.box !== undefined) {
        const b = l.box;
        const ok = isRecord(b) && ['x', 'y', 'width', 'height'].every((k) => typeof b[k] === 'number' && Number.isFinite(b[k]));
        if (!ok) err(`lines[${i}].box`, 'an object of finite x, y, width, height', b);
      }
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  // Checked above.
  return { ok: true, value: json as unknown as OcrFile };
}

/** A draft expected file pre-filled from a parse (eval-init). The user corrects it and sets "checked". */
export function draftFromParse(parsed: ParsedReceipt | null, photo: string, set: EvalSet, setReason: SetReason): ExpectedReceipt {
  return {
    version: 1,
    status: 'draft',
    set,
    setReason,
    photo,
    items: (parsed?.items ?? []).map((i) => ({ name: i.name, qty: i.qty, totalCents: i.totalCents })),
    subtotalCents: parsed?.subtotalCents ?? null,
    taxCents: parsed?.taxCents ?? null,
    tipCents: parsed?.tipCents ?? null,
    feesCents: parsed?.feesCents ?? null,
    discounts: (parsed?.discounts ?? []).map((d) => ({ label: d.label, cents: d.cents, appliesTo: d.appliesTo })),
    totalCents: parsed?.totalCents ?? null,
  };
}

// ---------- photo names ----------

/** Slug of a photo's base name: lowercase, [a-z0-9-], at most 60 characters; "receipt" if empty. */
export function slugifyPhotoName(file: string, maxLength = MAX_NAME_LENGTH): string {
  const base = file.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
  const slug = base
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/, '');
  return slug === '' ? 'receipt' : slug;
}

/** Names for a folder of photos, in sorted file order; a repeated slug gets -2, -3, … */
export function photoNames(files: string[]): { file: string; name: string }[] {
  const used = new Set<string>();
  return [...files]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((file) => {
      let name = slugifyPhotoName(file);
      for (let n = 2; used.has(name); n++) {
        const suffix = `-${n}`;
        name = `${slugifyPhotoName(file, MAX_NAME_LENGTH - suffix.length)}${suffix}`;
      }
      used.add(name);
      return { file, name };
    });
}

// ---------- split ----------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * SHA-256 of a string's UTF-8 bytes, as lowercase hex. A small pure implementation so this module
 * needs no Node or Web Crypto API (it is typechecked with the app and run by tsx and Jest).
 */
export function sha256Hex(s: string): string {
  const bytes = new TextEncoder().encode(s);
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] ?? 0;
      const b = w[i - 2] ?? 0;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0] ?? 0, h[1] ?? 0, h[2] ?? 0, h[3] ?? 0, h[4] ?? 0, h[5] ?? 0, h[6] ?? 0, h[7] ?? 0];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, hh].forEach((v, i) => {
      h[i] = ((h[i] ?? 0) + v) >>> 0;
    });
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}

/**
 * The set for a new photo: first byte of SHA-256(name) mod 5, 0–2 → tuning, 3–4 → held-out.
 * Why: about 60/40, fixed by the name so nobody chooses which receipts are held out (spec D3).
 */
export function assignSet(name: string): EvalSet {
  const firstByte = parseInt(sha256Hex(name).slice(0, 2), 16);
  return firstByte % 5 <= 2 ? 'tuning' : 'heldout';
}

// ---------- report ----------

export type Skipped = { name: string; why: string };

const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`);
const money = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
const listPriced = (xs: PricedName[]) => xs.map((x) => `${x.name} ${money(x.totalCents)}`).join('; ');

function formatSet(s: SetSummary, label: string): string[] {
  const out = [
    `${label} (${s.receipts} receipts): line items ${s.matched}/${s.expected} (${pct(s.matched, s.expected)}), exact ${s.exact}, extra ${s.extra}, reconciled ${pct(s.reconciled, s.receipts)}, total correct ${pct(s.totalCorrect, s.receipts)}`,
  ];
  for (const w of s.worst) {
    out.push(`  worst: ${w.name}: matched ${w.matched}/${w.expected}, extra ${w.extra}`);
    if (w.missed.length > 0) out.push(`    missed: ${listPriced(w.missed)}`);
    if (w.extraItems.length > 0) out.push(`    extra: ${listPriced(w.extraItems)}`);
  }
  return out;
}

/** The eval's text report for one variant. Held-out lines appear only with `confirm`. */
export function formatEvalReport(args: { variant: string; scores: ReceiptScore[]; skipped: Skipped[]; confirm: boolean }): string {
  const out = [`Variant: ${args.variant}`];
  for (const s of args.skipped) out.push(`  ${s.name}: ${s.why}`);
  if (args.scores.length === 0) {
    out.push('No checked receipts to score. Correct an answer file in receipts/answers/ and set "checked: yes" (npm run answers:check lists them).');
    return out.join('\n');
  }
  out.push(...formatSet(summarizeSet(args.scores, 'tuning'), 'Tuning'));
  if (args.confirm) {
    out.push(...formatSet(summarizeSet(args.scores, 'heldout'), 'Held-out'));
  } else {
    out.push("held-out hidden (use --confirm once you've chosen on tuning)");
  }
  return out.join('\n');
}
