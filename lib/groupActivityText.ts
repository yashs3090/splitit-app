// Turns `group_events` rows (lib/groups.ts fetchGroupEvents) into one plain sentence each, for the
// group Activity screen (spec docs/specs/2026-11-26-groups-mvp.md T10; A2.1 adds `method`).
//
// Same safety rule as lib/activityText.ts: every sentence is a fixed template. Only display names
// (from `nameOf`), the group name and expense titles the group's members typed, and `formatCents`
// amounts are interpolated. Unknown kinds and malformed details return null and the screen skips them.

import type { NameOf } from './billView';
import type { GroupEvent } from './groups';
import { formatCents } from './money';
import { isSettleCents } from './paylinks';
import { isPaymentMethod, type PaymentMethod } from './paymentMethods';

const YOU = 'You';
const SOMEONE = 'Someone';
const A_FRIEND = 'A friend';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Lookups the screen can give from the current snapshot and the event list. All optional. */
export type GroupEventContext = {
  /** A live expense's current title, or null (deleted expenses aren't in the snapshot). */
  expenseTitle?: (expenseId: string) => string | null;
  /** The payment a `payment_undone` is about, e.g. from its `payment_recorded` event (paymentFromEvents). */
  payment?: (paymentId: string) => { from: string; to: string; cents: number } | null;
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isExpenseCents = (v: unknown): v is number => isSettleCents(v);

function text(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/gu, ' ').trim();
  return t === '' ? null : t;
}

/** A name after a verb or preposition. */
function obj(name: string): string {
  if (name === YOU) return 'you';
  if (name === SOMEONE) return 'someone';
  if (name === A_FRIEND) return 'a friend';
  return name;
}

function possessiveObj(name: string): string {
  return name === YOU ? 'your' : `${obj(name)}'s`;
}

function expenseName(id: unknown, ctx: GroupEventContext): string | null {
  return isUuid(id) ? (text(ctx.expenseTitle?.(id) ?? null) ?? null) : null;
}

function expenseWithAmount(actor: string, verb: string, d: Obj, ctx: GroupEventContext): string | null {
  if (!isExpenseCents(d.amount_cents)) return null;
  const title = expenseName(d.expense_id, ctx);
  return title === null
    ? `${actor} ${verb} an expense of ${formatCents(d.amount_cents)}`
    : `${actor} ${verb} ${title}, ${formatCents(d.amount_cents)}`;
}

type ExpenseFields = { title: string; amount: number; payer: string | null; method: string };
function fields(v: unknown): ExpenseFields | null {
  if (!isObj(v)) return null;
  const title = text(v.title);
  if (title === null || !isExpenseCents(v.amount_cents)) return null;
  if (v.payer_id !== null && v.payer_id !== undefined && !isUuid(v.payer_id)) return null;
  if (v.split_method !== 'equal' && v.split_method !== 'exact') return null;
  return { title, amount: v.amount_cents, payer: (v.payer_id as string | null | undefined) ?? null, method: v.split_method };
}

function expenseEdited(actor: string, d: Obj, nameOf: NameOf): string | null {
  const before = fields(d.before);
  const after = fields(d.after);
  if (before === null || after === null) return null;
  // One sentence for the change that matters most to money (GR-T10-6).
  if (before.amount !== after.amount) return `${actor} changed ${after.title} from ${formatCents(before.amount)} to ${formatCents(after.amount)}`;
  if (before.title !== after.title) return `${actor} renamed ${before.title} to ${after.title}`;
  if (before.payer !== after.payer && after.payer !== null) return `${actor} changed who paid for ${after.title} to ${obj(nameOf(after.payer))}`;
  return `${actor} changed how ${after.title} is split`;
}

/** The method of a recorded payment: A2's `method`, or for rows written before A2 the old `source`. */
function methodOf(d: Obj): PaymentMethod | null {
  if (d.method !== undefined) return isPaymentMethod(d.method) ? d.method : null;
  return d.source === 'venmo' || d.source === 'venmo_link' ? 'venmo' : 'other';
}

const IN_METHOD: Record<PaymentMethod, string> = { venmo: ' via Venmo', cash: ' in cash', other: '' };

function paymentRecorded(e: GroupEvent, d: Obj, nameOf: NameOf): string | null {
  if (!isUuid(d.from) || !isUuid(d.to) || d.from === d.to || !isSettleCents(d.cents)) return null;
  const method = methodOf(d);
  if (method === null) return null;
  const from = nameOf(d.from);
  const to = nameOf(d.to);
  const amount = formatCents(d.cents);
  if (e.actorId !== null && e.actorId === d.to) return `${to} got ${amount} from ${obj(from)}`;
  const verb = method === 'venmo' ? 'sent' : 'paid';
  return `${from} ${verb} ${obj(to)} ${amount}${IN_METHOD[method]}`;
}

function paymentUndone(e: GroupEvent, actor: string, d: Obj, nameOf: NameOf, ctx: GroupEventContext): string | null {
  if (!isUuid(d.payment_id)) return null;
  const p = ctx.payment?.(d.payment_id) ?? null;
  if (p === null || !isSettleCents(p.cents) || e.actorId === null) return `${actor} undid a payment`;
  const amount = formatCents(p.cents);
  // A2.2: the recipient's "Not received" is an undo by the person the money was to.
  if (e.actorId === p.to) {
    const from = nameOf(p.from);
    return actor === YOU ? `You marked ${possessiveObj(from)} ${amount} as not received` : `${actor} didn't receive ${possessiveObj(from)} ${amount}`;
  }
  if (e.actorId === p.from) return `${actor} undid ${actor === YOU ? 'your' : 'their'} ${amount} to ${obj(nameOf(p.to))}`;
  return `${actor} undid a payment`;
}

function billAdded(actor: string, d: Obj): string | null {
  if (!isUuid(d.bill_id) || !isCount(d.converted)) return null;
  const head = `${actor} added a receipt`;
  if (d.converted === 0) return head;
  if (d.converted === 1) return `${head}. 1 'I paid' mark became a group payment`;
  return `${head}. ${d.converted} 'I paid' marks became group payments`;
}

/** One sentence for a group event, or null to skip it. `ctx` adds titles and undone payments when known. */
export function describeGroupEvent(e: GroupEvent, nameOf: NameOf, ctx: GroupEventContext = {}): string | null {
  const d = e.details;
  if (!isObj(d)) return null;
  const actor = nameOf(e.actorId);
  switch (e.kind) {
    case 'group_created': {
      const name = text(d.name);
      return name === null ? `${actor} created the group` : `${actor} created ${name}`;
    }
    case 'member_joined':
      return `${actor} joined`;
    case 'member_left':
      return `${actor} left`;
    case 'renamed': {
      const to = text(d.to);
      return to === null ? null : `${actor} renamed the group to ${to}`;
    }
    case 'link_rotated':
      return `${actor} made a new invite link`;
    case 'expense_added':
      return expenseWithAmount(actor, 'added', d, ctx);
    case 'expense_deleted':
      return expenseWithAmount(actor, 'deleted', d, ctx);
    case 'expense_edited':
      return expenseEdited(actor, d, nameOf);
    case 'payment_recorded':
      return paymentRecorded(e, d, nameOf);
    case 'payment_undone':
      return paymentUndone(e, actor, d, nameOf, ctx);
    case 'bill_added':
      return billAdded(actor, d);
    case 'bill_removed':
      return isUuid(d.bill_id) ? `${actor} took a receipt out of the group` : null;
    default:
      return null;
  }
}

/** The recorded payments in an event list, by payment id (for `GroupEventContext.payment`). */
export function paymentsFromEvents(events: readonly GroupEvent[]): ReadonlyMap<string, { from: string; to: string; cents: number }> {
  const out = new Map<string, { from: string; to: string; cents: number }>();
  for (const e of events) {
    if (e.kind !== 'payment_recorded' || !isObj(e.details)) continue;
    const d = e.details;
    if (isUuid(d.payment_id) && isUuid(d.from) && isUuid(d.to) && d.from !== d.to && isSettleCents(d.cents)) {
      out.set(d.payment_id, { from: d.from, to: d.to, cents: d.cents });
    }
  }
  return out;
}
