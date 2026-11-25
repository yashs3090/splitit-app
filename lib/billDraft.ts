// The bill form model: draft state, a reducer for edits, validation and the live totals check.
// Spec: docs/specs/2026-11-20-m1a-scan-receipt.md (Task 5).
//
// Form fields hold the strings the user typed, so a half-typed `12.` isn't lost. Cents are only
// ever computed from those strings by lib/money.ts, never with float math here.
import { formatCentsInput, isTooLarge, MAX_INPUT_CENTS, parseMoneyInput, percentOfCents } from './money';
import { checkTotals, totalsGaps } from './receiptText';
import type { Discount, ParsedItem, ParsedReceipt, ReviewReason } from './receiptTypes';

export type TotalField = 'subtotal' | 'tax' | 'fees' | 'tip' | 'total';

export type DraftItem = {
  id: string;
  name: string;
  qty: string;
  /** Line price (qty already included). */
  price: string;
  note: string;
  /** Parser qty_price_mismatch; cleared when the row is edited. */
  flagged: boolean;
};

export type DraftDiscount = {
  id: string;
  label: string;
  amount: string;
  appliesTo: 'subtotal' | 'total';
  /**
   * Claim like an item (docs/specs/2026-11-24-claimable-discounts.md, C5): saved as a negative bill row
   * that people claim, instead of being spread over everyone. False ("Split") by default. It never
   * changes the totals check: both kinds count in their own bucket (C2).
   */
  claimable: boolean;
};

export type BillDraft = {
  source: 'scan' | 'manual';
  items: DraftItem[];
  discounts: DraftDiscount[];
  totals: Record<TotalField, string>;
  /** Shared counter for row ids: items are `i<n>`, discounts `d<n>`, so tests are deterministic. */
  nextId: number;
};

export type FieldError = 'name_required' | 'price_required' | 'invalid_money' | 'too_large' | 'invalid_qty';

/**
 * What the footer pill shows. Field errors come first: an invalid field counts as blank in the
 * sums, so the rest could reconcile without it and wrongly say "Adds up" (review R2).
 */
export type DraftStatus = 'adds_up' | 'mismatch' | 'incomplete' | 'has_errors';

export type DraftEvaluation = {
  /** Built from the valid fields only; invalid or blank fields count as missing. */
  receipt: ParsedReceipt;
  /** Key `${rowId}.${field}` or `totals.${TotalField}`. */
  errors: Record<string, FieldError>;
  /** Σ valid item prices. */
  itemsTotalCents: number;
  /** items_vs_subtotal | subtotal_vs_total | qty_price_mismatch → red banner. */
  mismatches: ReviewReason[];
  /** no_items | missing_total → neutral hint, not the banner. Never missing_subtotal (A3). */
  missing: ReviewReason[];
  /**
   * Signed cents (computed minus printed) for each totals check that could run, from
   * totalsGaps in lib/receiptText.ts. A reason in `mismatches` has a gap over 1 cent.
   */
  gaps: Partial<Record<ReviewReason, number>>;
  status: DraftStatus;
};

export type ItemPatch = Partial<Pick<DraftItem, 'name' | 'qty' | 'price' | 'note'>>;
export type DiscountPatch = Partial<Pick<DraftDiscount, 'label' | 'amount' | 'appliesTo' | 'claimable'>>;

export type DraftAction =
  | { type: 'addItem' }
  | { type: 'updateItem'; id: string; patch: ItemPatch }
  | { type: 'removeItem'; id: string }
  | { type: 'addDiscount' }
  | { type: 'updateDiscount'; id: string; patch: DiscountPatch }
  | { type: 'removeDiscount'; id: string }
  | { type: 'setTotal'; field: TotalField; value: string }
  /** Sets the tip and keeps the total in step with it (see setTipAndTotal). The form uses this for the Tip field and the % chips. */
  | { type: 'setTip'; value: string }
  | { type: 'reset'; draft: BillDraft };

export const FIELD_ERROR_COPY: Record<FieldError, string> = {
  name_required: 'Add a name.',
  price_required: 'Add a price.',
  invalid_money: 'Enter an amount like 12.99.',
  too_large: 'That amount is too large.',
  invalid_qty: 'Use a whole number from 1 to 99.',
};

export const REASON_COPY: Record<ReviewReason, string> = {
  no_items: 'Add the items from the receipt.',
  missing_subtotal: 'Enter the subtotal from the receipt to check the items.',
  missing_total: 'Enter the total from the receipt to check it.',
  items_vs_subtotal: "The items don't add up to the subtotal.",
  subtotal_vs_total: "The subtotal, tax, fees and tip don't add up to the total.",
  qty_price_mismatch: "A quantity doesn't match its price. Check the flagged items.",
};

const MISMATCH_REASONS: readonly ReviewReason[] = ['items_vs_subtotal', 'subtotal_vs_total', 'qty_price_mismatch'];

/**
 * The subtotal_vs_total copy when there's no subtotal: the check then uses the items in its place
 * (A2.1 in totalsGaps), so the copy names the items (docs/specs/2026-11-24-first-total-as-subtotal.md, A3).
 */
export const NO_SUBTOTAL_MISMATCH_COPY = "The items, tax, fees and tip don't add up to the total.";

/** The copy to show for a reason, worded for whether the bill has a subtotal. */
export function reasonCopy(ev: DraftEvaluation, reason: ReviewReason): string {
  if (reason === 'subtotal_vs_total' && ev.receipt.subtotalCents === null) return NO_SUBTOTAL_MISMATCH_COPY;
  return REASON_COPY[reason];
}

const blankTotals = (): Record<TotalField, string> => ({ subtotal: '', tax: '', fees: '', tip: '', total: '' });

export function emptyDraft(): BillDraft {
  return { source: 'manual', items: [], discounts: [], totals: blankTotals(), nextId: 1 };
}

const centsToField = (v: number | null): string => (v === null ? '' : formatCentsInput(v));

/** A new item row's quantity; an untouched row still has it. */
const DEFAULT_QTY = '1';
const filled = (v: string): boolean => v.trim() !== '';

/**
 * Whether leaving the new-bill form would throw something away (visual pass V10a, decision VP-M1):
 * any typed text in an item, discount or totals field, a changed quantity, or a scanned draft
 * (leaving discards the scan). Blank rows the person added but never typed in don't count.
 */
export function draftHasEntries(d: BillDraft): boolean {
  if (d.source === 'scan') return true;
  const itemEntered = d.items.some(
    (i) => filled(i.name) || filled(i.price) || filled(i.note) || (filled(i.qty) && i.qty.trim() !== DEFAULT_QTY),
  );
  const discountEntered = d.discounts.some((x) => filled(x.label) || filled(x.amount));
  return itemEntered || discountEntered || Object.values(d.totals).some(filled);
}

/** line_items limits (private.validate_bill_rows): a name or discount label is 1–100 characters, a note at most 200. */
export const NAME_MAX_LENGTH = 100;
export const NOTE_MAX_LENGTH = 200;

/**
 * Scanned text clipped to a DB limit (review R2). Counts code points, as Postgres's char_length
 * does, and trims, so the result is never longer than `max` and never ends in a space.
 */
function clip(text: string, max: number): string {
  return Array.from(text.trim()).slice(0, max).join('').trimEnd();
}

export function fromParsed(p: ParsedReceipt): BillDraft {
  let n = 1;
  const items: DraftItem[] = p.items.map((it) => ({
    id: `i${n++}`,
    name: clip(it.name, NAME_MAX_LENGTH),
    qty: String(it.qty),
    price: formatCentsInput(it.totalCents),
    note: clip(it.modifiers.join(', '), NOTE_MAX_LENGTH),
    flagged: it.flags?.includes('qty_price_mismatch') ?? false,
  }));
  const discounts: DraftDiscount[] = p.discounts.map((d) => ({
    id: `d${n++}`,
    label: clip(d.label, NAME_MAX_LENGTH),
    amount: formatCentsInput(d.cents),
    appliesTo: d.appliesTo,
    claimable: false,
  }));
  const totals: Record<TotalField, string> = {
    subtotal: centsToField(p.subtotalCents),
    tax: centsToField(p.taxCents),
    fees: centsToField(p.feesCents),
    tip: centsToField(p.tipCents),
    total: centsToField(p.totalCents),
  };
  return { source: 'scan', items, discounts, totals, nextId: n };
}

export function draftReducer(d: BillDraft, action: DraftAction): BillDraft {
  switch (action.type) {
    case 'addItem': {
      const item: DraftItem = { id: `i${d.nextId}`, name: '', qty: DEFAULT_QTY, price: '', note: '', flagged: false };
      return { ...d, items: [...d.items, item], nextId: d.nextId + 1 };
    }
    case 'updateItem':
      if (!d.items.some((i) => i.id === action.id)) return d;
      return {
        ...d,
        items: d.items.map((i) => (i.id === action.id ? { ...i, ...action.patch, flagged: false } : i)),
      };
    case 'removeItem':
      if (!d.items.some((i) => i.id === action.id)) return d;
      return { ...d, items: d.items.filter((i) => i.id !== action.id) };
    case 'addDiscount': {
      const discount: DraftDiscount = { id: `d${d.nextId}`, label: '', amount: '', appliesTo: 'subtotal', claimable: false };
      return { ...d, discounts: [...d.discounts, discount], nextId: d.nextId + 1 };
    }
    case 'updateDiscount':
      if (!d.discounts.some((x) => x.id === action.id)) return d;
      return { ...d, discounts: d.discounts.map((x) => (x.id === action.id ? { ...x, ...action.patch } : x)) };
    case 'removeDiscount':
      if (!d.discounts.some((x) => x.id === action.id)) return d;
      return { ...d, discounts: d.discounts.filter((x) => x.id !== action.id) };
    case 'setTotal':
      return { ...d, totals: { ...d.totals, [action.field]: action.value } };
    case 'setTip':
      return setTipAndTotal(d, action.value);
    case 'reset':
      return action.draft;
  }
}

/** The Split / Claim like an item switch on one discount row. */
export function setDiscountClaimable(id: string, claimable: boolean): DraftAction {
  return { type: 'updateDiscount', id, patch: { claimable } };
}

type MoneyField = { cents: number } | { error: FieldError } | { blank: true };

/** Reads a money field: blank, valid cents, or the error to show. */
function readMoney(s: string): MoneyField {
  if (s.trim() === '') return { blank: true };
  const cents = parseMoneyInput(s);
  if (cents !== null) return { cents };
  return { error: isTooLarge(s) ? 'too_large' : 'invalid_money' };
}

const QTY_RE = /^\d{1,2}$/;

/** Integer 1–99, digits only (surrounding spaces ignored); otherwise null. */
function readQty(s: string): number | null {
  const t = s.trim();
  if (!QTY_RE.test(t)) return null;
  const n = parseInt(t, 10);
  return n >= 1 && n <= 99 ? n : null;
}

export function evaluateDraft(d: BillDraft): DraftEvaluation {
  const errors: Record<string, FieldError> = {};
  const items: ParsedItem[] = [];

  for (const row of d.items) {
    const name = row.name.trim();
    if (name === '' && row.price.trim() === '' && row.note.trim() === '') continue;

    let ok = true;
    const fail = (field: string, e: FieldError) => {
      errors[`${row.id}.${field}`] = e;
      ok = false;
    };
    if (name === '') fail('name', 'name_required');
    const price = readMoney(row.price);
    if ('blank' in price) fail('price', 'price_required');
    else if ('error' in price) fail('price', price.error);
    const qty = readQty(row.qty);
    if (qty === null) fail('qty', 'invalid_qty');
    if (!ok || qty === null || !('cents' in price)) continue;

    const totalCents = price.cents;
    const item: ParsedItem = {
      name,
      qty,
      unitCents: totalCents % qty === 0 ? totalCents / qty : null,
      totalCents,
      modifiers: row.note
        .split(',')
        .map((m) => m.trim())
        .filter((m) => m !== ''),
    };
    if (row.flagged) item.flags = ['qty_price_mismatch'];
    items.push(item);
  }

  const discounts: Discount[] = [];
  for (const row of d.discounts) {
    const label = row.label.trim();
    if (label === '' && row.amount.trim() === '') continue;
    const amount = readMoney(row.amount);
    if ('blank' in amount) errors[`${row.id}.amount`] = 'price_required';
    else if ('error' in amount) errors[`${row.id}.amount`] = amount.error;
    else discounts.push({ label: label === '' ? 'Discount' : label, cents: amount.cents, appliesTo: row.appliesTo });
  }

  const total = (field: TotalField): number | null => {
    const v = readMoney(d.totals[field]);
    if ('error' in v) errors[`totals.${field}`] = v.error;
    return 'cents' in v ? v.cents : null;
  };

  const base: ParsedReceipt = {
    items,
    subtotalCents: total('subtotal'),
    taxCents: total('tax'),
    tipCents: total('tip'),
    feesCents: total('fees'),
    discounts,
    totalCents: total('total'),
    needsReview: false,
    reasons: [],
  };
  // checkTotals never adds qty_price_mismatch itself (the parser does), so add it once here.
  const reasons = checkTotals(base);
  if (items.some((i) => i.flags?.includes('qty_price_mismatch'))) reasons.push('qty_price_mismatch');

  const mismatches = reasons.filter((r) => MISMATCH_REASONS.includes(r));
  // A blank subtotal isn't asked for: many receipts don't print one, and the checks use the items
  // in its place (A3). receipt.reasons still carries missing_subtotal, exactly as checkTotals gives it.
  const missing = reasons.filter((r) => !MISMATCH_REASONS.includes(r) && r !== 'missing_subtotal');
  const status: DraftStatus =
    Object.keys(errors).length > 0
      ? 'has_errors'
      : mismatches.length > 0
        ? 'mismatch'
        : missing.length > 0
          ? 'incomplete'
          : 'adds_up';

  return {
    receipt: { ...base, reasons, needsReview: reasons.length > 0 },
    errors,
    itemsTotalCents: items.reduce((sum, i) => sum + i.totalCents, 0),
    mismatches,
    missing,
    gaps: totalsGaps(base),
    status,
  };
}

// ---------- tip (backlog item 1, 2026-11-22) ----------
// A tip % is worked out on the subtotal before tax, after before-subtotal discounts. Only the
// tip in cents is kept (the DB stores tip_cents); the % the user picked is not remembered.

/** The quick tip chips, in hundredths of a percent: 15%, 18%, 20%, 25%. */
export const TIP_PRESETS: readonly number[] = [1500, 1800, 2000, 2500];

const sumCents = (values: number[]): number => values.reduce((a, b) => a + b, 0);

type TipContext = { baseCents: number | null; preTipCents: number | null };

/**
 * The tip base and the pre-tip total, or null where a field they need is invalid. With a blank
 * subtotal both come from the items, which must then be free of errors and not empty.
 */
function tipContext(d: BillDraft): TipContext {
  const ev = evaluateDraft(d);
  const subtotal = readMoney(d.totals.subtotal);
  const tax = readMoney(d.totals.tax);
  const fees = readMoney(d.totals.fees);
  const { items, discounts } = ev.receipt;
  const discountsOn = (on: Discount['appliesTo']) => sumCents(discounts.filter((x) => x.appliesTo === on).map((x) => x.cents));
  const rowErrors = Object.keys(ev.errors).some((k) => !k.startsWith('totals.'));

  let baseCents: number | null = null;
  let preTipBase: number | null = null;
  if ('cents' in subtotal) {
    baseCents = subtotal.cents;
    preTipBase = subtotal.cents - discountsOn('total');
  } else if ('blank' in subtotal && !rowErrors && items.length > 0) {
    const itemsCents = sumCents(items.map((i) => i.totalCents));
    baseCents = itemsCents - discountsOn('subtotal');
    // Matches the totals check with no subtotal line (A2.1): items less every discount.
    preTipBase = itemsCents - sumCents(discounts.map((x) => x.cents));
  }
  if (baseCents !== null && baseCents < 0) baseCents = null;

  const extra = (f: MoneyField): number | null => ('error' in f ? null : 'cents' in f ? f.cents : 0);
  const taxCents = extra(tax);
  const feesCents = extra(fees);
  const preTipCents = preTipBase === null || taxCents === null || feesCents === null ? null : preTipBase + taxCents + feesCents;
  return { baseCents, preTipCents };
}

/** What a tip % is worked out on, in cents; null when it can't be (nothing entered, or a needed field is invalid). */
export function tipBaseCents(d: BillDraft): number | null {
  return tipContext(d).baseCents;
}

/** Subtotal + tax + fees − after-subtotal discounts, in cents: what the total is before any tip. */
export function preTipTotalCents(d: BillDraft): number | null {
  return tipContext(d).preTipCents;
}

/** The tip in cents for `hundredths` of a percent of the base, rounded half up; null without a base. */
export function tipForPercent(d: BillDraft, hundredths: number): number | null {
  const base = tipBaseCents(d);
  return base === null ? null : percentOfCents(base, hundredths);
}

/** Each quick chip with the tip it works out to, or null when there's no base yet. */
export function tipPresets(d: BillDraft): { hundredths: number; cents: number }[] | null {
  const base = tipBaseCents(d);
  if (base === null) return null;
  return TIP_PRESETS.map((hundredths) => ({ hundredths, cents: percentOfCents(base, hundredths) }));
}

/** The tip field's value in cents: 0 when blank, null when invalid. */
export function tipCents(d: BillDraft): number | null {
  const tip = readMoney(d.totals.tip);
  return 'error' in tip ? null : 'cents' in tip ? tip.cents : 0;
}

/**
 * Sets the tip. The total follows it when it is "in step": blank (and the new tip is above zero),
 * or within 1 cent of pre-tip sum + the old tip. Then the total moves by the tip's change, so a
 * 1-cent rounding difference already on the receipt is kept. A total the user typed differently
 * is left alone, and the totals check flags it. Nothing moves if the new tip is invalid or the
 * pre-tip sum can't be worked out.
 */
function setTipAndTotal(d: BillDraft, value: string): BillDraft {
  const next: BillDraft = { ...d, totals: { ...d.totals, tip: value } };
  const newTip = readMoney(value);
  if ('error' in newTip) return next;
  const newTipCents = 'cents' in newTip ? newTip.cents : 0;
  const { preTipCents } = tipContext(d);
  if (preTipCents === null) return next;

  const total = readMoney(d.totals.total);
  let newTotal: number;
  if ('blank' in total) {
    if (newTipCents === 0) return next;
    newTotal = preTipCents + newTipCents;
  } else if ('cents' in total) {
    const oldTipCents = tipCents(d) ?? 0;
    if (Math.abs(total.cents - (preTipCents + oldTipCents)) > 1) return next;
    newTotal = total.cents - oldTipCents + newTipCents;
  } else {
    return next;
  }
  if (newTotal < 0 || newTotal > MAX_INPUT_CENTS) return next;
  return { ...next, totals: { ...next.totals, total: formatCentsInput(newTotal) } };
}
