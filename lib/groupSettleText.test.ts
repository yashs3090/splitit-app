jest.mock('./supabase', () => ({ supabase: {} }));


import { ANA, BEN, CY, DEE, W1, W3 } from '@/test-utils/groupFixtures';
import { GROUP_ID, paymentId, snapshotOf } from '@/test-utils/groupSnapshotFixtures';

import { groupNameOf } from './groupScreenText';
import { groupSettle, whoPaidWhat, type WhoPaidWhatRow } from './groupSettleView';
import {
  chooserOptions,
  costLine,
  costsHint,
  looseNotReceived,
  manualIntentKey,
  otherMembers,
  RECORD_METHODS,
  RECORD_PAYMENT_COPY,
  recordAmount,
  recordedEntry,
  requestOpenFailedLine,
  suggestionFor,
  venmoOf,
  whoPaidWhatA11y,
  whoPaidWhatLine,
} from './groupSettleText';

const model = (s: ReturnType<typeof snapshotOf>, viewer: string) =>
  groupSettle({ snapshot: s, viewerId: viewer, nameOf: groupNameOf(s.members, viewer), platform: 'native', attempt: null, justSent: [], sentChecks: {}, now: 0 });

describe('recordedEntry', () => {
  it('describes the viewer’s own cash or other record while it is in the snapshot', () => {
    const s = snapshotOf(W3.input, { payments: [{ method: 'cash' }] }); // Cy → Dee 10000, cash
    expect(recordedEntry(s, paymentId(1), CY, groupNameOf(s.members, CY))).toEqual({
      paymentId: paymentId(1),
      to: DEE,
      cents: 10000,
      label: 'You paid Dee',
      amountText: '$100.00',
      methodLine: 'Paid in cash',
    });
    const other = snapshotOf(W3.input); // method 'other'
    expect(recordedEntry(other, paymentId(1), CY, groupNameOf(other.members, CY))?.methodLine).toBe('Marked paid');
  });

  it('is null once the payment is gone, for a Venmo payment, for someone else’s, or with no id', () => {
    const s = snapshotOf(W1.input);
    expect(recordedEntry(s, paymentId(1), CY, groupNameOf(s.members, CY))).toBeNull();
    const venmo = snapshotOf(W3.input, { payments: [{ method: 'venmo', source: 'venmo_link' }] });
    expect(recordedEntry(venmo, paymentId(1), CY, groupNameOf(venmo.members, CY))).toBeNull();
    const cash = snapshotOf(W3.input, { payments: [{ method: 'cash' }] });
    expect(recordedEntry(cash, paymentId(1), DEE, groupNameOf(cash.members, DEE))).toBeNull();
    expect(recordedEntry(cash, null, CY, groupNameOf(cash.members, CY))).toBeNull();
  });
});

describe('requestOpenFailedLine', () => {
  it('shows only while a Request for that person and amount is on screen', () => {
    const s = snapshotOf(W1.input);
    const m = model(s, ANA); // Ben owes Ana $130.02
    expect(requestOpenFailedLine(m, s, { from: BEN, cents: 13002 })).toBe("Couldn't open Venmo. Request $130.02 from @ben-1 in the Venmo app.");
    expect(requestOpenFailedLine(m, s, { from: BEN, cents: 100 })).toBeNull();
    expect(requestOpenFailedLine(m, s, { from: CY, cents: 13002 })).toBeNull();
    expect(requestOpenFailedLine(m, s, null)).toBeNull();
  });
});

describe('looseNotReceived', () => {
  it('lists only the "hasn’t received" lines no pay card shows', () => {
    const nr = { id: paymentId(9), from: CY, to: DEE, cents: 17497, method: 'venmo' as const, undoneAt: '2026-11-20T14:00:00.000Z' };
    const s = snapshotOf(W1.input, { notReceived: [nr] });
    // Cy still pays Dee: the pay card carries the line.
    expect(looseNotReceived(model(s, CY))).toEqual([]);
    const toAna = { ...nr, to: ANA, cents: 500 };
    const s2 = snapshotOf(W1.input, { notReceived: [toAna] });
    expect(looseNotReceived(model(s2, CY))).toEqual(["Ana hasn't received your $5.00. Check Venmo before paying again."]);
  });
});

describe('Who paid what text', () => {
  const s = snapshotOf(W1.input);
  const rows = whoPaidWhat(s, ANA, groupNameOf(s.members, ANA)).rows;
  const ana = rows.find((r) => r.userId === ANA) as WhoPaidWhatRow;
  const cy = rows.find((r) => r.userId === CY) as WhoPaidWhatRow;

  it('reads paid, share and payments in one line, and everything in the label', () => {
    expect(whoPaidWhatLine(cy)).toBe(`Paid ${cy.paidText} · Share ${cy.shareText} · Payments ${cy.paymentsText}`);
    expect(whoPaidWhatA11y(cy)).toBe(`Cy, net −$174.97. Paid $0.00, share ${cy.shareText}, payments $0.00`.replace('−', '-'));
    expect(whoPaidWhatA11y(ana)).toContain('You, net +$130.02.');
  });

  it('says settled up in the label when the person is', () => {
    expect(whoPaidWhatA11y({ ...cy, settled: true, netText: '$0.00' })).toBe(`Cy, net $0.00, settled up. Paid $0.00, share ${cy.shareText}, payments $0.00`);
  });

  it('names whose costs a toggle shows', () => {
    expect(costsHint(ana, false)).toBe('Shows your costs');
    expect(costsHint(cy, true)).toBe("Hides Cy's costs");
  });

  it('a cost line shows Paid only for the person who paid it', () => {
    expect(costLine({ id: 'x', title: 'Airbnb', paidCents: 24000, shareCents: 6000 })).toBe('Paid $240.00 · Share $60.00');
    expect(costLine({ id: 'x', title: 'Airbnb', paidCents: 0, shareCents: 6000 })).toBe('Share $60.00');
    expect(costLine({ id: 'x', title: 'Dinner', paidCents: 0, shareCents: 0 })).toBe('Share $0.00');
  });
});

describe('Record a payment helpers', () => {
  it('reads the amount, never treating bad input as $0', () => {
    expect(recordAmount('')).toEqual({ kind: 'empty' });
    expect(recordAmount('  ')).toEqual({ kind: 'empty' });
    expect(recordAmount('100')).toEqual({ kind: 'ok', cents: 10000 });
    expect(recordAmount('0.01')).toEqual({ kind: 'ok', cents: 1 });
    expect(recordAmount('0')).toEqual({ kind: 'invalid' });
    expect(recordAmount('0.00')).toEqual({ kind: 'invalid' });
    expect(recordAmount('abc')).toEqual({ kind: 'invalid' });
    expect(recordAmount('-5')).toEqual({ kind: 'invalid' });
    expect(recordAmount('99999.99')).toEqual({ kind: 'ok', cents: 9_999_999 });
    expect(recordAmount('100000')).toEqual({ kind: 'invalid' });
    expect(RECORD_PAYMENT_COPY.amountProblem).toBe('Enter an amount from $0.01 to $99,999.99.');
  });

  it('lists the other members and finds the suggestion in the chosen direction', () => {
    const s = snapshotOf(W1.input);
    const nameOf = groupNameOf(s.members, CY);
    expect(otherMembers(s, CY, nameOf)).toEqual([
      { userId: ANA, name: 'Ana' },
      { userId: BEN, name: 'Ben' },
      { userId: DEE, name: 'Dee' },
    ]);
    const m = model(s, CY);
    expect(suggestionFor(m, CY, DEE, true, nameOf)).toEqual({ cents: 17497, name: 'Dee', viewerPays: true });
    expect(suggestionFor(m, CY, DEE, false, nameOf)).toBeNull();
    expect(suggestionFor(m, CY, ANA, true, nameOf)).toBeNull();
    const ana = model(s, ANA);
    expect(suggestionFor(ana, ANA, BEN, false, groupNameOf(s.members, ANA))).toEqual({ cents: 13002, name: 'Ben', viewerPays: false });
  });

  it('defaults to Cash and keys a manual record on its content', () => {
    expect(RECORD_METHODS.map((m) => m.value)).toEqual(['cash', 'venmo', 'other']);
    expect(RECORD_METHODS.map((m) => m.label)).toEqual(['Cash', 'Venmo', 'Other']);
    expect(manualIntentKey({ from: CY, to: DEE, cents: 100, method: 'cash' })).toBe(`${CY}|${DEE}|100|cash|manual`);
  });

  it('venmoOf reads the member’s username', () => {
    const s = snapshotOf(W1.input, { venmo: { [DEE]: null } });
    expect(venmoOf(s, DEE)).toBeNull();
    expect(venmoOf(snapshotOf(W1.input), DEE)).toBe('dee-1');
    expect(s.group.id).toBe(GROUP_ID);
  });
});

describe('chooserOptions', () => {
  it('offers Venmo and Cash with context in each label, and never Other', () => {
    expect(chooserOptions(['venmo', 'cash'])).toEqual([
      { value: 'venmo', label: 'Venmo', accessibilityLabel: "Venmo, how you're paying" },
      { value: 'cash', label: 'Cash', accessibilityLabel: "Cash, how you're paying" },
    ]);
    expect(chooserOptions(['cash'])).toHaveLength(1);
    expect(chooserOptions(['other'])).toEqual([]);
  });
});
