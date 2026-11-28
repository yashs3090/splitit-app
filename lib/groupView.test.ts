// T10 group screen model (spec docs/specs/2026-11-26-groups-mvp.md T10, criteria 51, 110; A1 S1, S2, S5, S9).
// lib/groups.ts imports the Supabase client; these tests only use its types and balanceInputOf.
jest.mock('./supabase', () => ({ supabase: {} }));
import { makeNameOf } from './billView';
import * as balance from './groupBalance';
import { balanceInputOf, type GroupSnapshot } from './groups';
import {
  canDeleteGroup,
  canLeaveGroup,
  groupMath,
  groupScreen,
  keepOrder,
  needsMeFirst,
  receiptLabel,
  statusLine,
  waitingLines,
  waitingReasonText,
  type WaitingLine,
} from './groupView';
import { isSettledUp } from './simplify';
import {
  AIRBNB_ID,
  ANA,
  BEN,
  BRUNCH_ID,
  RENTAL_CAR_ID,
  CY,
  DEE,
  DINNER_ID,
  DINNER_ROWS,
  W1,
  W2,
  W3,
  W7,
  brunchBill,
  dinnerBill,
  type WorkedCase,
} from '@/test-utils/groupFixtures';
import { SETTLE_CASES, WAIT_BILL_ID, WAIT_CASES, type SettleCase } from '@/test-utils/deleteGroupFixtures';
import { snapshotOf, withNotPart } from '@/test-utils/groupSnapshotFixtures';

const snap = (c: WorkedCase) => snapshotOf(c.input);
const nameOf = (s: GroupSnapshot, viewer: string) => makeNameOf(s.members, viewer);
const screen = (s: GroupSnapshot, viewer: string) => groupScreen(s, viewer, nameOf(s, viewer));

describe('snapshot fixture', () => {
  it('feeds the same nets as the worked example', () => {
    for (const c of [W1, W2, W3, W7]) {
      const nets = balance.netsOf(balance.groupBalances(balanceInputOf(snap(c))));
      for (const [id, cols] of Object.entries(c.expected ?? {})) expect(nets[id]).toBe(cols.net);
    }
  });
});

describe('statusLine (criterion 51, S2)', () => {
  it('reads owed / owe / settled up from isSettledUp', () => {
    expect(statusLine(13002)).toEqual({ kind: 'owed', text: "You're owed $130.02", amountCents: 13002 });
    expect(statusLine(-1240)).toEqual({ kind: 'owes', text: 'You owe $12.40', amountCents: 1240 });
    expect(statusLine(0)).toEqual({ kind: 'settled', text: "You're settled up", amountCents: null });
  });
  it.each([-3, -2, -1, 0, 1, 2, 3])('net %i: settled exactly when isSettledUp', (n) => {
    expect(statusLine(n).kind === 'settled').toBe(isSettledUp(n));
  });
  it('a 2¢ balance still shows the amount', () => {
    expect(statusLine(2).text).toBe("You're owed $0.02");
    expect(statusLine(-2).text).toBe('You owe $0.02');
  });
});

describe('groupScreen on W1 (criterion 51)', () => {
  const s = snap(W1);
  it('status line per viewer', () => {
    expect(screen(s, ANA).status.text).toBe("You're owed $130.02");
    expect(screen(s, DEE).status.text).toBe("You're owed $181.64");
    expect(screen(s, CY).status.text).toBe('You owe $174.97');
    expect(screen(s, BEN).status.text).toBe('You owe $136.69');
  });
  it('no waiting lines when every receipt counts', () => {
    expect(screen(s, ANA).waiting).toEqual([]);
  });
  it('cost rows: newest first, payer line, viewer share', () => {
    const rows = screen(s, CY).costs;
    // Brunch (30), Rental car (20), Dinner (10), Airbnb (0).
    expect(rows.map((r) => r.title)).toEqual(["Ben's receipt", 'Rental car', "Ana's receipt", 'Airbnb']);
    const dinner = rows.find((r) => r.id === DINNER_ID);
    expect(dinner).toMatchObject({ kind: 'bill', billId: DINNER_ID, paidLine: 'Ana paid $77.33', shareLine: 'you $19.76', viewerShareCents: 1976 });
    expect(rows.find((r) => r.title === 'Airbnb')).toMatchObject({ kind: 'expense', paidLine: 'Ana paid $240.00', shareLine: 'you $60.00' });
  });
  it('the viewer as payer reads "You paid"; a $0 share reads "you $0.00"', () => {
    const rows = screen(s, ANA).costs;
    expect(rows.find((r) => r.id === DINNER_ID)).toMatchObject({ title: 'Your receipt', paidLine: 'You paid $77.33', shareLine: 'you $30.08' });
    expect(screen(s, DEE).costs.find((r) => r.id === DINNER_ID)?.shareLine).toBe('you $0.00');
  });
  it('an expense the viewer is not in reads "you $0.00"', () => {
    const one = { ...s, expenses: s.expenses.map((e) => (e.title === 'Airbnb' ? { ...e, shares: e.shares.filter((x) => x.userId !== DEE).map((x, i) => ({ ...x, cents: i === 0 ? 8000 : 8000 })) } : e)) };
    expect(screen(one, DEE).costs.find((r) => r.title === 'Airbnb')).toMatchObject({ shareLine: 'you $0.00', viewerShareCents: 0 });
  });
  it('ties in created_at order by id, newest id first', () => {
    const tied = { ...s, expenses: s.expenses.map((e) => ({ ...e, createdAt: s.bills[0]?.createdAt ?? '' })) };
    const ids = screen(tied, ANA).costs.map((r) => r.id);
    const sameTime = ids.filter((id) => id !== BRUNCH_ID);
    expect(sameTime).toEqual([...sameTime].sort().reverse());
  });
});

describe('waiting lines and notice (criteria 51, 110; S1, S9)', () => {
  it('W2: one row left is named; "Your receipt" for the host, "Ana\'s receipt" for others', () => {
    const s = snap(W2);
    expect(screen(s, ANA).waiting).toEqual([
      {
        billId: DINNER_ID,
        reason: 'incomplete',
        text: 'Your receipt: Nachos left to claim',
        notice: "Balances don't include your receipt yet: Nachos left to claim",
        needsMe: false,
        notPart: false,
      },
    ]);
    expect(screen(s, BEN).waiting[0]?.text).toBe("Ana's receipt: Nachos left to claim");
    expect(screen(s, BEN).waiting[0]?.notice).toBe("Balances don't include Ana's receipt yet: Nachos left to claim");
  });
  it('W2: the waiting bill shows "you —" and adds nothing', () => {
    const row = screen(snap(W2), BEN).costs.find((r) => r.id === DINNER_ID);
    expect(row).toMatchObject({ shareLine: 'you —', viewerShareCents: null, waiting: true });
  });
  it('W7: the notice for Ana and for the others', () => {
    const s = snap(W7);
    expect(screen(s, ANA).waiting[0]?.notice).toBe("Balances don't include your receipt yet: Nachos left to claim");
    expect(screen(s, CY).waiting[0]?.notice).toBe("Balances don't include Ana's receipt yet: Nachos left to claim");
    expect(screen(s, ANA).status.text).toBe('You owe $47.25');
  });
  it('two rows left are both named (Water and Happy hour)', () => {
    const s = snapshotOf({ ...W1.input, bills: [dinnerBill({ unclaimedWater: true, unclaimedHappyHour: true }), brunchBill()] });
    expect(screen(s, BEN).waiting[0]?.text).toBe("Ana's receipt: Water and Happy hour left to claim");
  });
  it('three or more rows use the count (footerIncomplete)', () => {
    const s = snapshotOf({ ...W1.input, bills: [dinnerBill({ nachosClaimers: [], unclaimedWater: true, unclaimedHappyHour: true }), brunchBill()] });
    expect(screen(s, BEN).waiting[0]?.text).toBe("Ana's receipt: 2 items and 1 discount left to claim");
  });
  it('a blank name or two rows with the same name fall back to the count', () => {
    const base = snapshotOf({ ...W1.input, bills: [dinnerBill({ unclaimedWater: true, unclaimedHappyHour: true }), brunchBill()] });
    const rename = (name: string) => ({
      ...base,
      bills: base.bills.map((b) => ({ ...b, rows: b.rows.map((r) => (r.name !== null ? { ...r, name } : r)) })),
    });
    expect(screen(rename('Water'), BEN).waiting[0]?.text).toBe("Ana's receipt: 1 item and 1 discount left to claim");
    expect(screen(rename('  '), BEN).waiting[0]?.text).toBe("Ana's receipt: 1 item and 1 discount left to claim");
  });
  it('all-$0 receipt: guest copy and host copy', () => {
    const zero = {
      id: DINNER_ID,
      payerId: ANA,
      totalCents: 500,
      split: {
        totalCents: 500,
        items: [{ id: DINNER_ROWS.ana, totalCents: 0 }],
        claims: [{ itemId: DINNER_ROWS.ana, userId: ANA, parts: 1 }],
        participantIds: [ANA, BEN, CY, DEE],
        extrasMode: 'proportional' as const,
      },
    };
    const s = snapshotOf({ ...W1.input, bills: [zero, brunchBill()] });
    expect(screen(s, BEN).waiting[0]).toMatchObject({ reason: 'all_zero', text: "Ana's receipt: Every item is $0. Ask Ana to fix the prices." });
    expect(screen(s, ANA).waiting[0]?.text).toBe('Your receipt: every item is $0. Fix the prices in Edit items.');
    expect(screen(s, ANA).waiting[0]?.notice).toBe("Balances don't include your receipt yet: every item is $0. Fix the prices in Edit items.");
  });
  it('waitingReasonText and waitingLines are what groupScreen uses (needs-me first: needsMeFirst)', () => {
    const s = snap(W2);
    expect(needsMeFirst(waitingLines(s, ANA, nameOf(s, ANA)))).toEqual(screen(s, ANA).waiting);
    expect(waitingReasonText({ billId: DINNER_ID, reason: 'incomplete', unclaimedRows: 5, unclaimedDiscountRows: 0, unclaimedRowIds: [] }, s, ANA, nameOf(s, ANA))).toBe('5 items left to claim');
  });
  it('receiptLabel', () => {
    const s = snap(W1);
    expect(receiptLabel(ANA, ANA, nameOf(s, ANA))).toBe('Your receipt');
    expect(receiptLabel(ANA, BEN, nameOf(s, BEN))).toBe("Ana's receipt");
  });
});

describe('needs me and "I wasn\'t part of this" (group claim status C1, criterion 19)', () => {
  // Worked out by hand: with the nachos open, Dinner needs only Dee (Ana, Ben and Cy each claimed a
  // dish). With Dee's waffles unclaimed too, Brunch also needs only Dee.
  const brunchNoDee = () => {
    const b = brunchBill();
    return { ...b, split: { ...b.split, claims: b.split.claims.filter((c) => c.userId !== DEE) } };
  };
  const both = () => snapshotOf({ ...W1.input, bills: [dinnerBill({ nachosClaimers: [] }), brunchNoDee()] });

  it('W2: the open Dinner needs Dee, not the people who claimed on it', () => {
    const s = snap(W2);
    expect(screen(s, DEE).waiting).toMatchObject([{ billId: DINNER_ID, needsMe: true, notPart: false }]);
    for (const v of [ANA, BEN, CY]) expect(screen(s, v).waiting).toMatchObject([{ billId: DINNER_ID, needsMe: false, notPart: false }]);
  });

  it('an opt-out: not needed any more, and marked notPart; the text and notice are unchanged', () => {
    const s = snap(W2);
    const before = screen(s, DEE).waiting[0]!;
    const after = screen(withNotPart(s, [DINNER_ID]), DEE).waiting[0]!;
    expect(after).toEqual({ ...before, needsMe: false, notPart: true });
  });

  it('claims win: a stale opt-out with a claim of mine is neither needsMe nor notPart (B4)', () => {
    const s = snapshotOf({ ...W1.input, bills: [dinnerBill({ nachosClaimers: [DEE], unclaimedWater: true }), brunchBill()] });
    expect(screen(withNotPart(s, [DINNER_ID]), DEE).waiting).toMatchObject([{ billId: DINNER_ID, needsMe: false, notPart: false }]);
  });

  it('needs-me lines first, each group keeping snapshot order (GCS-9)', () => {
    // Snapshot order: Dinner, Brunch. Both wait. Dee opts out of Dinner: Brunch (needs me) goes first.
    const s = both();
    expect(groupMath(s).balances.waiting.map((w) => w.billId)).toEqual([DINNER_ID, BRUNCH_ID]);
    expect(screen(s, DEE).waiting.map((w) => [w.billId, w.needsMe])).toEqual([[DINNER_ID, true], [BRUNCH_ID, true]]);
    const optedOut = screen(withNotPart(s, [DINNER_ID]), DEE).waiting;
    expect(optedOut.map((w) => [w.billId, w.needsMe, w.notPart])).toEqual([[BRUNCH_ID, true, false], [DINNER_ID, false, true]]);
    // Ben needs neither: snapshot order.
    expect(screen(s, BEN).waiting.map((w) => w.billId)).toEqual([DINNER_ID, BRUNCH_ID]);
  });

  it('review R2: waitingLines itself keeps snapshot order (Settle up uses it); only groupScreen sorts', () => {
    const s = withNotPart(both(), [DINNER_ID]);
    expect(waitingLines(s, DEE, nameOf(s, DEE)).map((w) => w.billId)).toEqual([DINNER_ID, BRUNCH_ID]);
    expect(screen(s, DEE).waiting.map((w) => w.billId)).toEqual([BRUNCH_ID, DINNER_ID]);
  });

  it('review R4: keepOrder holds a previous order; new lines follow in their own order; gone ones drop', () => {
    const line = (billId: string) => ({ billId }) as WaitingLine;
    const now = [line('b'), line('c'), line('a')];
    expect(keepOrder(now, null).map((l) => l.billId)).toEqual(['b', 'c', 'a']);
    expect(keepOrder(now, ['a', 'b']).map((l) => l.billId)).toEqual(['a', 'b', 'c']);
    expect(keepOrder(now, ['x', 'c']).map((l) => l.billId)).toEqual(['c', 'b', 'a']);
  });

  it('ordering keeps snapshot order among the needs-me lines and among the rest', () => {
    const s = both();
    const swapped = { ...s, bills: [...s.bills].reverse() };
    const order = groupMath(swapped).balances.waiting.map((w) => w.billId);
    expect(screen(swapped, DEE).waiting.map((w) => w.billId)).toEqual(order);
    expect(screen(withNotPart(swapped, [BRUNCH_ID]), DEE).waiting.map((w) => w.billId)).toEqual([DINNER_ID, BRUNCH_ID]);
  });

  it('cost rows: needsMe only on the bills that need me, never on expenses', () => {
    const s = both();
    const flags = (v: string, t: GroupSnapshot = s) => Object.fromEntries(screen(t, v).costs.map((r) => [r.id, r.needsMe]));
    expect(flags(DEE)).toEqual({ [DINNER_ID]: true, [BRUNCH_ID]: true, [AIRBNB_ID]: false, [RENTAL_CAR_ID]: false });
    expect(flags(BEN)).toEqual({ [DINNER_ID]: false, [BRUNCH_ID]: false, [AIRBNB_ID]: false, [RENTAL_CAR_ID]: false });
    expect(flags(DEE, withNotPart(s, [BRUNCH_ID]))).toMatchObject({ [DINNER_ID]: true, [BRUNCH_ID]: false });
    // A fully claimed bill needs nobody.
    expect(screen(snap(W1), DEE).costs.every((r) => !r.needsMe)).toBe(true);
  });

  it('an opt-out changes no money: the same status line and shares with and without it', () => {
    const s = snap(W2);
    const a = screen(s, DEE);
    const b = screen(withNotPart(s, [DINNER_ID]), DEE);
    expect(b.status).toEqual(a.status);
    expect(b.costs.map((r) => [r.id, r.shareLine, r.viewerShareCents, r.paidLine])).toEqual(a.costs.map((r) => [r.id, r.shareLine, r.viewerShareCents, r.paidLine]));
  });
});

describe('groupMath memoizes per snapshot (A1.7, S5)', () => {
  it('computes balances once per snapshot object', () => {
    const s = snap(W1);
    const spy = jest.spyOn(balance, 'groupBalances');
    try {
      const a = groupMath(s);
      screen(s, ANA);
      screen(s, CY);
      expect(groupMath(s)).toBe(a);
      expect(spy).toHaveBeenCalledTimes(1);
      const fresh = snap(W1);
      expect(groupMath(fresh)).not.toBe(a);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
  it('carries the shown suggestions and per-bill shares', () => {
    const m = groupMath(snap(W1));
    expect(m.suggestions.shown).toEqual(W1.shown);
    expect(m.billShares.get(DINNER_ID)?.get(DEE)).toBe(0);
    expect(m.billShares.has(BRUNCH_ID)).toBe(true);
    expect(groupMath(snap(W2)).billShares.has(DINNER_ID)).toBe(false);
  });
});

describe('canLeaveGroup (C-G10 mirror, N3)', () => {
  const NEW = 'eeeeeeee-0000-4000-8000-000000000005';
  const withNewcomer = (s: GroupSnapshot): GroupSnapshot => ({
    ...s,
    members: [...s.members, { userId: NEW, displayName: 'Eve', venmoUsername: null, joinedAt: s.members[0]?.joinedAt ?? '' }],
    bills: s.bills.map((b) => ({ ...b, participantIds: [...b.participantIds, NEW] })),
  });
  it('false for anyone with history; true for a member with none', () => {
    const s = withNewcomer(snap(W1));
    for (const u of [ANA, BEN, CY, DEE]) expect(canLeaveGroup(s, u)).toBe(false);
    expect(canLeaveGroup(s, NEW)).toBe(true);
    expect(screen(s, NEW).canLeave).toBe(true);
  });
  it('a $0 expense share does not trap; a 1¢ share does', () => {
    const base = withNewcomer(snapshotOf({ members: [], bills: [], expenses: [], payments: [] }));
    const exp = (cents: number) => ({
      ...base,
      bills: [],
      expenses: [{ id: 'e9000000-0000-4000-8000-000000000001', title: 'Gum', payerId: ANA, amountCents: 1, splitMethod: 'equal' as const, createdBy: ANA, createdAt: base.group.createdAt, editedAt: null, version: 1, shares: [{ userId: ANA, cents: 1 - cents }, { userId: NEW, cents }] }],
    });
    expect(canLeaveGroup(exp(0), NEW)).toBe(true);
    expect(canLeaveGroup(exp(1), NEW)).toBe(false);
  });
  it('a claim, a payment (either side or recorder), and being the only member each block', () => {
    const s = withNewcomer(snapshotOf({ members: [], bills: [], expenses: [], payments: [] }));
    const claimed = { ...withNewcomer(snap(W1)) };
    claimed.bills = claimed.bills.map((b) => (b.id === DINNER_ID ? { ...b, rows: b.rows.map((r) => (r.id === DINNER_ROWS.ana ? { ...r, claims: { ...r.claims, [NEW]: 1 } } : r)) } : b));
    expect(canLeaveGroup(claimed, NEW)).toBe(false);
    const pay = (from: string, to: string, recordedBy: string) => ({
      ...s,
      payments: [{ id: 'c9000000-0000-4000-8000-000000000001', from, to, cents: 5, method: 'other' as const, source: 'manual' as const, recordedBy, billId: null, createdAt: s.group.createdAt }],
    });
    expect(canLeaveGroup(pay(NEW, ANA, NEW), NEW)).toBe(false);
    expect(canLeaveGroup(pay(ANA, NEW, ANA), NEW)).toBe(false);
    expect(canLeaveGroup(s, NEW)).toBe(true);
    const alone = { ...s, members: s.members.filter((m) => m.userId === NEW), bills: [] };
    expect(canLeaveGroup(alone, NEW)).toBe(false);
  });
  it('a viewer who is not in the snapshot cannot leave and reads settled up', () => {
    const s = snap(W1);
    const stranger = 'ffffffff-0000-4000-8000-000000000009';
    expect(canLeaveGroup(s, stranger)).toBe(false);
    expect(screen(s, stranger).status.kind).toBe('settled');
  });
});

// ---------------------------------------------------------------------------------------------
// Delete group (docs/specs/2026-11-28-delete-group.md T4; contracts S and W, A2.10; criteria 33, 34).

describe('contract W: waiting receipts, both extras modes (criterion 33, A2.10)', () => {
  const rows = WAIT_CASES.flatMap((c) => (['proportional', 'equal'] as const).map((mode) => [c.id, mode, c] as const));

  it.each(rows)('%s (%s) matches the A2.10 answer, in groupBalances and in canDeleteGroup', (_id, mode, c) => {
    const bill = c.make(mode);
    const input = { members: [ANA, BEN], bills: [bill], expenses: [], payments: [] };
    const waits = balance.groupBalances(input).waiting.some((w) => w.billId === WAIT_BILL_ID);
    expect(waits).toBe(c.waiting[mode]);

    // Through the caller: a waiting bill refuses as receipts_waiting. A counting one is settled
    // off with one payment (the amount read from lib, never worked out here), and is then ok.
    const nets = balance.netsOf(balance.groupBalances(input));
    const benNet = nets[BEN] ?? 0;
    const payments = benNet < 0 ? [{ from: BEN, to: ANA, cents: -benNet }] : benNet > 0 ? [{ from: ANA, to: BEN, cents: benNet }] : [];
    const snapshot = snapshotOf({ ...input, payments }, { members: [ANA, BEN] });
    expect(canDeleteGroup(snapshot)).toEqual(c.waiting[mode] ? { ok: false, reason: 'receipts_waiting' } : { ok: true });
  });

  it('covers every A2.10 case in both modes: the 22 rows delete_group.test.sql asserts', () => {
    expect(rows).toHaveLength(22);
    expect(WAIT_CASES.map((c) => c.id)).toEqual([
      'W1',
      'W2',
      'W3',
      'W4',
      'W4-zero',
      'W5',
      'W6',
      'W7',
      'W7-zero',
      'discount-only',
      'discount-only-zero',
    ]);
  });
});

describe('contract S: canDeleteGroup (criterion 33, S1–S8)', () => {
  const snapOf = (c: SettleCase) => snapshotOf(c.input, { members: c.input.members, hidden: c.hidden ?? false });

  it.each(SETTLE_CASES.map((c) => [c.id, c.label, c] as const))('%s %s', (_id, _label, c) => {
    const s = snapOf(c);
    // The fixture's nets are the spec table's (so the case can't drift from it).
    expect(balance.netsOf(groupMath(s).balances)).toEqual(c.nets);
    expect(canDeleteGroup(s)).toEqual(c.expected);
  });

  it('is about every member, not the viewer: the same answer whoever looks (S4 as Ana and as Ben)', () => {
    const s4 = SETTLE_CASES.find((c) => c.id === 'S4');
    if (!s4) throw new Error('S4 missing');
    const s = snapOf(s4);
    // Each viewer's own status line says the opposite thing, but deleting is refused for both.
    expect(screen(s, ANA).canDelete).toEqual({ ok: false, reason: 'not_settled' });
    expect(screen(s, BEN).canDelete).toEqual({ ok: false, reason: 'not_settled' });
  });

  it('uses isSettledUp per member: the worked example W1 (unsettled) is not_settled', () => {
    const s = snap(W1);
    expect(groupMath(s).balances.members.some((m) => !isSettledUp(m.netCents))).toBe(true);
    expect(canDeleteGroup(s)).toEqual({ ok: false, reason: 'not_settled' });
  });

  it('a waiting worked case (W2: nachos unclaimed) is receipts_waiting', () => {
    expect(canDeleteGroup(snap(W2))).toEqual({ ok: false, reason: 'receipts_waiting' });
  });

  it('groupScreen carries canDelete', () => {
    const ok = SETTLE_CASES.find((c) => c.id === 'S2');
    if (!ok) throw new Error('S2 missing');
    expect(screen(snapOf(ok), ANA).canDelete).toEqual({ ok: true });
  });
});

describe('canDeleteGroup reads groupMath (criterion 34)', () => {
  it('a memo hit: no second groupBalances for a snapshot groupMath already did; one for a fresh one', () => {
    const s = snap(W1);
    const spy = jest.spyOn(balance, 'groupBalances');
    try {
      groupMath(s);
      expect(spy).toHaveBeenCalledTimes(1);
      canDeleteGroup(s);
      expect(spy).toHaveBeenCalledTimes(1);
      const fresh = snap(W1);
      canDeleteGroup(fresh);
      expect(spy).toHaveBeenCalledTimes(2);
      // ...and that call was groupMath's: it is now memoized for the fresh snapshot too.
      groupMath(fresh);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});
