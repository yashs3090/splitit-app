// Contract M: how someone paid (docs/specs/2026-11-26-sent-via-venmo.md D1, Amendment A1).
//
// The one list of payment methods in the app. Nothing else in lib/, app/ or components/ spells it
// out. The database's one list is private.is_payment_method (Task 2's migration); the drift test in
// paymentMethods.test.ts reads the newest migration that defines it and fails if the two differ.
// Adding Zelle later = one migration (`create or replace` that function) plus one entry here.
import { formatCents } from './money';
import { VENMO_USERNAME_PATTERN } from './venmo';

export const PAYMENT_METHODS = ['venmo', 'cash', 'other'] as const;

/**
 * How a mark was made. `venmo` is written only around opening Venmo (the send path, or contract O's
 * "Yes, I sent it"), so it means "recorded around opening Venmo", never "Venmo confirmed it" (SV-3).
 * `cash` is a deliberate self-report. `other` is "Paid another way", and every mark made before
 * this slice.
 */
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

const KNOWN: ReadonlySet<string> = new Set(PAYMENT_METHODS);

export function isPaymentMethod(v: unknown): v is PaymentMethod {
  return typeof v === 'string' && KNOWN.has(v);
}

/**
 * The methods the owes card's chooser offers, in order. Venmo only when the payer has a valid Venmo
 * username; Cash always. `other` is never here: it is the separate "Paid another way" link, always
 * offered. With fewer than two options there is no chooser (SV-29).
 */
export function availableMethods(payerVenmo: string | null): readonly PaymentMethod[] {
  const hasVenmo = typeof payerVenmo === 'string' && VENMO_USERNAME_PATTERN.test(payerVenmo);
  return hasVenmo ? ['venmo', 'cash'] : ['cash'];
}

type MethodCopy = {
  /** The chooser segment, or null for `other` (offered as the "Paid another way" link instead). */
  readonly chooserLabel: string | null;
  /** The status line on the person's own marked card. */
  readonly markLine: string;
  /** The status on the payer's row for that person. */
  readonly rowStatus: string;
  /** The person's own Home pill, e.g. "Sent $15.10". */
  readonly ownPill: (amount: string) => string;
};

/** D1's copy table. "Sent", never "Paid" or "Confirmed", for Venmo: the app only knows Venmo opened. */
export const PAYMENT_METHOD_COPY: Readonly<Record<PaymentMethod, MethodCopy>> = {
  venmo: { chooserLabel: 'Venmo', markLine: 'Sent via Venmo', rowStatus: 'Sent via Venmo', ownPill: (a) => `Sent ${a}` },
  cash: { chooserLabel: 'Cash', markLine: 'Paid in cash', rowStatus: 'Paid in cash', ownPill: (a) => `Paid ${a} in cash` },
  other: { chooserLabel: null, markLine: 'Marked paid', rowStatus: 'Paid', ownPill: (a) => `Paid ${a}` },
};

/**
 * The methods the device remembers as the chooser's default (D5, SV-18): the ones the chooser offers,
 * that is, every method with a chooser label. "Paid another way" (`other`) is never remembered.
 */
export function isRememberedMethod(v: unknown): v is PaymentMethod {
  return isPaymentMethod(v) && PAYMENT_METHOD_COPY[v].chooserLabel !== null;
}

export const methodMarkLine = (m: PaymentMethod): string => PAYMENT_METHOD_COPY[m].markLine;
export const methodRowStatus = (m: PaymentMethod): string => PAYMENT_METHOD_COPY[m].rowStatus;
export const methodOwnPill = (m: PaymentMethod, cents: number): string => PAYMENT_METHOD_COPY[m].ownPill(formatCents(cents));

const DEFINITION_RE = /create\s+(?:or\s+replace\s+)?function\s+private\.is_payment_method\s*\(/gi;
const IN_LIST_RE = /\bin\s*\(([^)]*)\)/i;

/**
 * For the drift test: the quoted values of the `in (...)` list in the last definition of
 * private.is_payment_method in one SQL file, or null if the file doesn't define it. A call to the
 * function (in a check or another body) is not a definition.
 */
export function parseIsPaymentMethodList(sql: string): string[] | null {
  let last: number | null = null;
  for (const m of sql.matchAll(DEFINITION_RE)) last = m.index ?? null;
  if (last === null) return null;
  const list = IN_LIST_RE.exec(sql.slice(last))?.[1];
  if (list === undefined) return null;
  return [...list.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? '');
}
