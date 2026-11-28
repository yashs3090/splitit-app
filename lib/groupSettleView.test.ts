// T10 Settle model (spec T10; criteria 52, 54, 55, 110; Amendment A2: 119–121, 123, 125, 126).
// lib/groups.ts imports the Supabase client; these tests only use its types and balanceInputOf.
jest.mock('./supabase', () => ({ supabase: {} }));

import { makeNameOf } from './billView';
import type { GroupSnapshot } from './groups';
import {
  GROUP_SEND_RECORD_TIMEOUT_MS,
  GROUP_VENMO_NOTE_INCLUDES_NAME,
  cleanNoteName,
  groupNoteItems,
  groupSendPlan,
  groupSentCheckKey,
  groupSettle,
  recordPaymentCheck,
  sendPlatformOf,
  type GroupSettleInput,
} from './groupSettleView';
import { venmoPayUrl, venmoRequestUrl } from './paylinks';
import { DEVICE_KEY_RE, SENT_CHECK_INLINE_MAX_MINUTES, withAnswer } from './sentCheck';
import { ANA, BEN, BRUNCH_ID, brunchBill, CY, DEE, dinnerBill, DINNER_ID, W1, W2, W3, W7, type WorkedCase } from '@/test-utils/groupFixtures';
import { at, GROUP_ID, paymentId, snapshotOf, VENMO, withNotPart } from '@/test-utils/groupSnapshotFixtures';

const NOW = Date.parse(at(120));
const snap = (c: WorkedCase, opts?: Parameters<typeof snapshotOf>[1]) => snapshotOf(c.input, opts);
const settle = (s: GroupSnapshot, viewerId: string, more: Partial<GroupSettleInput> = {}) =>
  groupSettle({
    snapshot: s,
    viewerId,
    nameOf: makeNameOf(s.members, viewerId),
    platform: 'native',
    attempt: null,
    justSent: [],
    sentChecks: {},
    now: NOW,
    ...more,
  });

describe('note name (GR-T2-9, criterion 125)', () => {
  it('strips control characters, collapses whitespace, trims', () => {
    expect(cleanNoteName('Tahoe\u0000 trip\n')).toBe('Tahoe trip');
    expect(cleanNoteName('Ta\u0007hoe\ttrip')).toBe('Tahoe trip');
    expect(cleanNoteName('\u0000\n ')).toBe('');
  });
  it('keeps ZWJ emoji sequences', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    expect(cleanNoteName(`Trip ${family}`)).toBe(`Trip ${family}`);
  });
  it('the Venmo note is "SplitIt: Tahoe trip", or plain "SplitIt" with the switch off', () => {
    expect(GROUP_VENMO_NOTE_INCLUDES_NAME).toBe(true);
    expect(groupNoteItems('Tahoe\u0000 trip\n')).toEqual(['Tahoe trip']);
    expect(groupNoteItems('Tahoe trip', false)).toEqual([]);
    expect(groupNoteItems('\u0000')).toEqual([]);
    expect(venmoPayUrl({ username: 'dee-1', cents: 1, itemNames: groupNoteItems('Tahoe\u0000 trip\n') })).toContain('note=SplitIt%3A%20Tahoe%20trip');
  });
});

describe('suggestions and cards on W1 (criterion 52)', () => {
  const s = snap(W1);
  it('the three W1 suggestions in order, with roles and text', () => {
    const m = settle(s, BEN);
    expect(m.suggestions.map((x) => [x.from, x.to, x.cents, x.role, x.text])).toEqual([
      [CY, DEE, 17497, 'other', 'Cy pays Dee $174.97'],
      [BEN, ANA, 13002, 'pay', 'You pay Ana $130.02'],
      [BEN, DEE, 667, 'pay', 'You pay Dee $6.67'],
    ]);
    expect(settle(s, ANA).suggestions[1]).toMatchObject({ role: 'request', text: 'Ben pays you $130.02' });
  });
  it("Cy's card: Pay Dee $174.97 with the group-name note", () => {
    const [pay] = settle(s, CY).pays;
    expect(pay).toMatchObject({ to: DEE, cents: 17497, state: 'pay', text: 'You owe Dee $174.97', methods: ['venmo', 'cash'] });
    expect(pay?.venmo).toEqual({
      label: 'Pay Dee $174.97 on Venmo',
      hint: 'Opens Venmo and records it as sent',
      url: venmoPayUrl({ username: VENMO[DEE] ?? null, cents: 17497, itemNames: ['Tahoe trip'] }),
    });
    expect(pay?.handleNote).toBe('@dee-1 · $174.97');
    expect(pay?.cash.label).toBe('I paid Dee $174.97 in cash');
    expect(pay?.otherWay.label).toBe('Paid another way');
    expect(pay?.webNote).toBeNull();
  });
  it('with the switch off the note is plain "SplitIt"', () => {
    const [pay] = settle(s, CY, { includeNameInNote: false }).pays;
    expect(pay?.venmo?.url).toBe(venmoPayUrl({ username: 'dee-1', cents: 17497 }));
    expect(pay?.venmo?.url).toContain('note=SplitIt');
    expect(pay?.venmo?.url).not.toContain('Tahoe');
  });
  it('desktop web adds the phone line', () => {
    expect(settle(s, CY, { platform: 'desktop_web' }).pays[0]?.webNote).toBe('On a computer? Send it from the Venmo app on your phone.');
  });
  it('no Venmo for the recipient: cash only, no Venmo button', () => {
    const [pay] = settle(snap(W1, { venmo: { ...VENMO, [DEE]: null } }), CY).pays;
    expect(pay).toMatchObject({ methods: ['cash'], venmo: null, handleNote: null, noVenmoLine: "Dee hasn't added Venmo yet." });
  });
  it("Ana's card lists Ben with Request $130.02 and Got paid another way", () => {
    const m = settle(s, ANA);
    expect(m.status.text).toBe("You're owed $130.02");
    expect(m.pays).toEqual([]);
    expect(m.requests).toHaveLength(1);
    expect(m.requests[0]).toMatchObject({
      from: BEN,
      cents: 13002,
      text: 'Ben owes you $130.02',
      gotPaid: { label: 'Got paid another way', confirm: 'Record that Ben paid you $130.02?' },
    });
    expect(m.requests[0]?.request).toEqual({
      label: 'Request $130.02',
      a11yLabel: 'Request $130.02 from Ben on Venmo, @ben-1',
      url: venmoRequestUrl({ username: 'ben-1', cents: 13002, itemNames: ['Tahoe trip'] }),
    });
  });
  it('Dee, owed by two, sees two requests and nothing to pay', () => {
    const m = settle(snap(W1), DEE);
    expect(m.pays).toEqual([]);
    expect(m.requests.map((r) => r.from)).toEqual([CY, BEN]);
  });
});

describe('waiting notice above the suggestions (criterion 110, S1)', () => {
  it("W7: Ana's notice and Pay Ben $27.49", () => {
    const m = settle(snap(W7), ANA);
    expect(m.notices).toEqual(["Balances don't include your receipt yet: Nachos left to claim"]);
    expect(m.pays[0]?.venmo?.label).toBe('Pay Ben $27.49 on Venmo');
  });
  it('W2: others read "Ana\'s receipt"', () => {
    expect(settle(snap(W2), CY).notices).toEqual(["Balances don't include Ana's receipt yet: Nachos left to claim"]);
    expect(settle(snap(W1), CY).notices).toEqual([]);
  });
  it('review R2: the notices keep snapshot order; the group screen\'s needs-me-first order (GCS-9) stays there', () => {
    // Dinner and Brunch both wait; Dee opted out of Dinner, so only Brunch needs her. The group
    // screen would put Brunch first; Settle up keeps the snapshot's order: Dinner, then Brunch.
    const b = brunchBill();
    const brunchNoDee = { ...b, split: { ...b.split, claims: b.split.claims.filter((c) => c.userId !== DEE) } };
    const s = withNotPart(snapshotOf({ ...W1.input, bills: [dinnerBill({ nachosClaimers: [] }), brunchNoDee] }), [DINNER_ID]);
    const notices = settle(s, DEE).notices;
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatch(/^Balances don't include Ana's receipt yet: /);
    expect(notices.map((n) => n.includes('Nachos'))).toEqual([true, false]);
  });
});

describe('groupSendPlan (A2.2, criteria 119, 120)', () => {
  it('sendPlatformOf', () => {
    expect(sendPlatformOf('ios', false)).toBe('native');
    expect(sendPlatformOf('android', true)).toBe('native');
    expect(sendPlatformOf('web', true)).toBe('mobile_web');
    expect(sendPlatformOf('web', false)).toBe('desktop_web');
  });
  it('native: record (4 s) then open', () => {
    expect(groupSendPlan('native', { step: 'start' })).toEqual({ do: 'record', timeoutMs: GROUP_SEND_RECORD_TIMEOUT_MS });
    expect(GROUP_SEND_RECORD_TIMEOUT_MS).toBe(4000);
    expect(groupSendPlan('native', { step: 'record', result: 'ok' })).toEqual({ do: 'open', recorded: 'ok' });
    expect(groupSendPlan('native', { step: 'record', result: 'refused' })).toEqual({ done: 'refused' });
    expect(groupSendPlan('native', { step: 'record', result: 'unknown' })).toEqual({ do: 'open', recorded: 'unknown' });
    expect(groupSendPlan('native', { step: 'open', ok: true, recorded: 'ok' })).toEqual({ done: 'sent' });
    expect(groupSendPlan('native', { step: 'open', ok: true, recorded: 'unknown' })).toEqual({ done: 'ask' });
    expect(groupSendPlan('native', { step: 'open', ok: false, recorded: 'ok' })).toEqual({ do: 'undo' });
    expect(groupSendPlan('native', { step: 'open', ok: false, recorded: 'unknown' })).toEqual({ do: 'undo' });
    expect(groupSendPlan('native', { step: 'undo', ok: true })).toEqual({ done: 'open_failed' });
    expect(groupSendPlan('native', { step: 'undo', ok: false })).toEqual({ done: 'open_failed' });
  });
  it('mobile web: open first, record only if the tab stayed open', () => {
    expect(groupSendPlan('mobile_web', { step: 'start' })).toEqual({ do: 'open_web' });
    expect(groupSendPlan('mobile_web', { step: 'web_open', result: 'blocked' })).toEqual({ done: 'open_failed' });
    expect(groupSendPlan('mobile_web', { step: 'web_open', result: 'ask' })).toEqual({ done: 'ask' });
    expect(groupSendPlan('mobile_web', { step: 'web_open', result: 'record' })).toEqual({ do: 'record', timeoutMs: GROUP_SEND_RECORD_TIMEOUT_MS });
    expect(groupSendPlan('mobile_web', { step: 'record', result: 'ok' })).toEqual({ done: 'sent' });
    expect(groupSendPlan('mobile_web', { step: 'record', result: 'unknown' })).toEqual({ done: 'ask' });
    expect(groupSendPlan('mobile_web', { step: 'record', result: 'refused' })).toEqual({ done: 'refused' });
  });
  it('desktop web: open, never record without Yes', () => {
    expect(groupSendPlan('desktop_web', { step: 'start' })).toEqual({ do: 'open_web' });
    expect(groupSendPlan('desktop_web', { step: 'web_open', result: 'ask' })).toEqual({ done: 'ask' });
    expect(groupSendPlan('desktop_web', { step: 'web_open', result: 'record' })).toEqual({ done: 'ask' });
    expect(groupSendPlan('desktop_web', { step: 'web_open', result: 'blocked' })).toEqual({ done: 'open_failed' });
    expect(groupSendPlan('desktop_web', { step: 'record', result: 'ok' })).toEqual({ done: 'sent' });
  });
  it('every path ends: each outcome on each platform gives a step or a done', () => {
    const outcomes = [
      { step: 'start' },
      { step: 'record', result: 'ok' },
      { step: 'record', result: 'refused' },
      { step: 'record', result: 'unknown' },
      { step: 'open', ok: true, recorded: 'ok' },
      { step: 'open', ok: false, recorded: 'unknown' },
      { step: 'web_open', result: 'blocked' },
      { step: 'web_open', result: 'ask' },
      { step: 'web_open', result: 'record' },
      { step: 'undo', ok: true },
    ] as const;
    for (const p of ['native', 'mobile_web', 'desktop_web'] as const) for (const o of outcomes) expect(groupSendPlan(p, o)).toBeDefined();
  });
});

describe('ask on return (A2.2, N1, criterion 119)', () => {
  const ID = paymentId(99);
  it('"Did you send Dee $174.97?" with Yes, I sent it and Not now', () => {
    const [pay] = settle(snap(W1), CY, { attempt: { id: ID, to: DEE, cents: 17497, phase: 'ask' } }).pays;
    expect(pay).toMatchObject({ state: 'ask_on_return', ask: { text: 'Did you send Dee $174.97?', yes: 'Yes, I sent it', notNow: 'Not now', paymentId: ID, cents: 17497 } });
  });
  it('keyed on the recipient: stays when the amount changes and Yes records the amount opened', () => {
    // Cy now owes Dee 17000 (a 497 payment from elsewhere): the question keeps 17497.
    const changed = snapshotOf({ ...W1.input, payments: [{ from: CY, to: DEE, cents: 497 }] });
    const [pay] = settle(changed, CY, { attempt: { id: ID, to: DEE, cents: 17497, phase: 'ask' } }).pays;
    expect(pay?.cents).toBe(17000);
    expect(pay?.ask).toMatchObject({ cents: 17497, text: 'Did you send Dee $174.97?' });
  });
  it('goes away when Dee is no longer someone Cy pays', () => {
    const paid = snapshotOf({ ...W1.input, payments: [{ from: CY, to: DEE, cents: 17497 }] }, { payments: [{ id: paymentId(5) }] });
    const m = settle(paid, CY, { attempt: { id: ID, to: DEE, cents: 17497, phase: 'ask' } });
    expect(m.pays.some((p) => p.ask !== null)).toBe(false);
  });
  it('once the attempt id is in the snapshot (a late success), it shows as sent instead', () => {
    const paid = snapshotOf(
      { ...W1.input, payments: [{ from: CY, to: DEE, cents: 17497 }] },
      { payments: [{ id: ID, method: 'venmo', source: 'venmo_link', createdAt: at(119) }] },
    );
    const m = settle(paid, CY, { attempt: { id: ID, to: DEE, cents: 17497, phase: 'ask' } });
    expect(m.pays).toEqual([]);
    expect(m.sent.map((x) => x.paymentId)).toEqual([ID]);
  });
  it('open failed: the line names the handle and amount while both still match', () => {
    const s = snap(W1);
    const [pay] = settle(s, CY, { attempt: { id: ID, to: DEE, cents: 17497, phase: 'open_failed' } }).pays;
    expect(pay?.openFailed).toBe("Couldn't open Venmo. Send $174.97 to @dee-1 in the Venmo app, then tap Paid another way.");
    const changed = snapshotOf({ ...W1.input, payments: [{ from: CY, to: DEE, cents: 497 }] });
    expect(settle(changed, CY, { attempt: { id: ID, to: DEE, cents: 17497, phase: 'open_failed' } }).pays[0]?.openFailed).toBeNull();
  });
});

describe('sent card, Undo and the inline check (A2.2, criteria 119, 121, 126)', () => {
  const PID = paymentId(1);
  // Keyed on the payment id only (R9): the same key whenever the payment was made.
  const KEY = (_minutesAgo: number) => groupSentCheckKey(GROUP_ID, PID) ?? '';
  const sentSnap = (minutesAgo: number, extra: Partial<Parameters<typeof snapshotOf>[1]> = {}) =>
    snapshotOf(
      { ...W1.input, payments: [{ from: CY, to: DEE, cents: 17497 }] },
      { payments: [{ id: PID, method: 'venmo', source: 'venmo_link', createdAt: at(120 - minutesAgo) }], ...extra },
    );
  it('"You sent Dee" · $174.97 · Sent via Venmo, with "Didn\'t go through? Undo"', () => {
    const m = settle(sentSnap(0), CY, { justSent: [PID], sentChecks: withAnswer({}, KEY(0), 'shown', NOW) });
    expect(m.sent).toEqual([
      {
        paymentId: PID,
        to: DEE,
        cents: 17497,
        label: 'You sent Dee',
        amountText: '$174.97',
        methodLine: 'Sent via Venmo',
        undo: { label: "Didn't go through? Undo" },
        check: null,
      },
    ]);
    expect(m.status.text).toBe("You're settled up");
  });
  it('the inline check: once per payment, within the time limit', () => {
    const m = settle(sentSnap(5), CY);
    expect(m.sent[0]?.check).toEqual({ text: 'Did your $174.97 to Dee go through?', yes: 'Yes', no: 'No, undo', key: KEY(5) });
    expect(m.sent[0]?.undo).toBeNull();
    const answered = withAnswer({}, KEY(5), 'yes', NOW);
    expect(settle(sentSnap(5), CY, { sentChecks: answered }).sent).toEqual([]);
    expect(settle(sentSnap(SENT_CHECK_INLINE_MAX_MINUTES + 1), CY).sent).toEqual([]);
    expect(settle(sentSnap(SENT_CHECK_INLINE_MAX_MINUTES), CY).sent).toHaveLength(1);
  });
  it('never for cash/other or for a payment someone else recorded', () => {
    const cash = snapshotOf({ ...W1.input, payments: [{ from: CY, to: DEE, cents: 17497 }] }, { payments: [{ id: PID, method: 'cash', source: 'manual', createdAt: at(119) }] });
    expect(settle(cash, CY).sent).toEqual([]);
    const byDee = snapshotOf(
      { ...W1.input, payments: [{ from: CY, to: DEE, cents: 17497 }] },
      { payments: [{ id: PID, method: 'venmo', source: 'venmo_link', recordedBy: DEE, createdAt: at(119) }] },
    );
    expect(settle(byDee, CY).sent).toEqual([]);
  });
  it('the key fits device storage', () => {
    expect(KEY(5)).toMatch(DEVICE_KEY_RE);
    expect(KEY(5)).toBe(`${GROUP_ID}.${PID}.0`);
    expect(Object.keys(withAnswer({}, KEY(5) ?? '', 'yes', NOW))).toEqual([KEY(5)]);
    expect(groupSentCheckKey(GROUP_ID, 'not a uuid')).toBeNull();
    expect(groupSentCheckKey('not a uuid', PID)).toBeNull();
  });
  it('R9: the key needs only the payment id, so a Yes stored before any refetch matches the payment once it shows', () => {
    const answered = withAnswer({}, groupSentCheckKey(GROUP_ID, PID) ?? '', 'yes', NOW);
    expect(settle(sentSnap(5), CY).sent).toHaveLength(1);
    expect(settle(sentSnap(5), CY, { sentChecks: answered }).sent).toEqual([]);
  });
});

describe('recipient side: received payments and Not received (A2.2, criteria 123, 126)', () => {
  const PID = paymentId(1);
  const s = snapshotOf({ ...W1.input, payments: [{ from: BEN, to: ANA, cents: 13002 }] }, { payments: [{ id: PID, method: 'venmo', source: 'venmo_link' }] });
  it('"Ben sent you $130.02" · Sent via Venmo · Not received with its confirm', () => {
    expect(settle(s, ANA).received).toEqual([
      {
        paymentId: PID,
        from: BEN,
        cents: 13002,
        text: 'Ben sent you $130.02',
        status: 'Sent via Venmo',
        notReceived: { label: 'Not received', confirm: "Didn't get Ben's $130.02? This clears it and lets Ben know." },
      },
    ]);
    expect(settle(s, BEN).received).toEqual([]);
  });
  it('cash reads "paid you" and "Paid in cash"', () => {
    const cash = snapshotOf({ ...W1.input, payments: [{ from: BEN, to: ANA, cents: 13002 }] }, { payments: [{ id: PID, method: 'cash' }] });
    expect(settle(cash, ANA).received[0]).toMatchObject({ text: 'Ben paid you $130.02', status: 'Paid in cash' });
  });
  it('a payment the viewer recorded themself has no Not received', () => {
    const mine = snapshotOf({ ...W1.input, payments: [{ from: BEN, to: ANA, cents: 13002 }] }, { payments: [{ id: PID, recordedBy: ANA }] });
    expect(settle(mine, ANA).received).toEqual([]);
  });
  const marked = { id: PID, from: CY, to: DEE, cents: 17497, method: 'venmo' as const, undoneAt: at(100) };
  it('the sender sees "Dee hasn\'t received your $174.97…" until a newer payment to Dee (GR-M6)', () => {
    const m = settle(snapshotOf(W1.input, { notReceived: [marked] }), CY);
    expect(m.notReceived).toEqual([{ to: DEE, cents: 17497, text: "Dee hasn't received your $174.97. Check Venmo before paying again." }]);
    expect(m.pays[0]?.notReceivedLine).toBe("Dee hasn't received your $174.97. Check Venmo before paying again.");
    const newer = snapshotOf({ ...W1.input, payments: [{ from: CY, to: DEE, cents: 100 }] }, { payments: [{ createdAt: at(110) }], notReceived: [marked] });
    expect(settle(newer, CY).notReceived).toEqual([]);
    const older = snapshotOf({ ...W1.input, payments: [{ from: CY, to: DEE, cents: 100 }] }, { payments: [{ createdAt: at(90) }], notReceived: [marked] });
    expect(settle(older, CY).notReceived).toHaveLength(1);
    expect(settle(snapshotOf(W1.input, { notReceived: [marked] }), DEE).notReceived).toEqual([]);
  });
  it('the latest per recipient wins; no list reads as none', () => {
    const two = [marked, { ...marked, id: paymentId(2), cents: 500, undoneAt: at(105) }];
    expect(settle(snapshotOf(W1.input, { notReceived: two }), CY).notReceived.map((n) => n.cents)).toEqual([500]);
    expect(settle(snap(W1), CY).notReceived).toEqual([]);
  });
});

describe('Who paid what (criterion 77) and the payments list', () => {
  it('rows per member in snapshot order, sums to $0.00 (W3)', () => {
    const s = snapshotOf(W3.input, { payments: [{ id: paymentId(1), method: 'venmo', source: 'venmo_link' }] });
    const w = settle(s, CY).whoPaidWhat;
    expect(w.rows.map((r) => [r.name, r.paidText, r.shareText, r.paymentsText, r.netText])).toEqual([
      ['Ana', '$317.33', '$187.31', '$0.00', '+$130.02'],
      ['Ben', '$50.01', '$186.70', '$0.00', '-$136.69'],
      ['You', '$0.00', '$174.97', '+$100.00', '-$74.97'],
      ['Dee', '$300.00', '$118.36', '-$100.00', '+$81.64'],
    ]);
    expect(w.sumLine).toBe("Everyone's balances add up to $0.00");
  });
  it("each person's costs: what they paid and their share, waiting receipts left out", () => {
    const w = settle(snap(W2), BEN).whoPaidWhat;
    const dee = w.rows.find((r) => r.userId === DEE);
    expect(dee?.costs.map((c) => [c.title, c.paidCents, c.shareCents])).toEqual([
      ["Your receipt", 0, 1550],
      ['Rental car', 30000, 4286],
      ['Airbnb', 0, 6000],
    ]);
  });
  it('R7: a receipt is left out of the costs of someone with a $0 share who didn\'t pay it; its payer keeps it', () => {
    // W1 Dinner: Dee is on the receipt but claimed nothing (proportional extras: $0), and Ana paid.
    const w = settle(snap(W1), BEN).whoPaidWhat;
    const dee = w.rows.find((r) => r.userId === DEE);
    const deeIds = dee?.costs.map((c) => c.id) ?? [];
    expect(deeIds).toContain(BRUNCH_ID); // positive control: Dee's other receipt is listed
    expect(deeIds).not.toContain(DINNER_ID);
    const ana = w.rows.find((r) => r.userId === ANA);
    expect(ana?.costs.map((c) => [c.id, c.paidCents > 0, c.shareCents > 0])).toEqual(
      expect.arrayContaining([[DINNER_ID, true, true]]),
    );
    // A payer with a $0 share still sees the receipt they paid.
    const payerOnly = snapshotOf({ ...W1.input, bills: W1.input.bills.map((b) => (b.id === DINNER_ID ? { ...b, payerId: DEE } : b)) });
    const deePaid = settle(payerOnly, BEN).whoPaidWhat.rows.find((r) => r.userId === DEE);
    expect(deePaid?.costs.find((c) => c.id === DINNER_ID)).toMatchObject({ shareCents: 0 });
    expect(deePaid?.costs.find((c) => c.id === DINNER_ID)?.paidCents).toBeGreaterThan(0);
  });
  it('a settled-up person still shows the exact net (GR-3)', () => {
    const s = snapshotOf({ ...W1.input, payments: [{ from: CY, to: DEE, cents: 17496 }] });
    const cy = settle(s, ANA).whoPaidWhat.rows.find((r) => r.userId === CY);
    expect(cy).toMatchObject({ netText: '-$0.01', settled: true });
  });
  it('payments newest first, Undo for either side, confirm when someone else recorded it', () => {
    const s = snapshotOf(
      { ...W1.input, payments: [{ from: CY, to: DEE, cents: 17497 }, { from: BEN, to: ANA, cents: 13002 }] },
      { payments: [{ method: 'venmo', source: 'venmo_link' }, { method: 'other', recordedBy: ANA }] },
    );
    const asBen = settle(s, BEN).payments;
    expect(asBen.map((p) => [p.text, p.methodLine, p.canUndo, p.undoConfirm])).toEqual([
      ['Ana got $130.02 from you', 'Paid', true, "Undo Ana's record of $130.02?"],
      ['Cy sent Dee $174.97', 'Sent via Venmo', false, null],
    ]);
    expect(settle(s, ANA).payments[0]).toMatchObject({ text: 'You got $130.02 from Ben', canUndo: true, undoConfirm: null });
    expect(settle(s, CY).payments[1]).toMatchObject({ text: 'You sent Dee $174.97', canUndo: true, undoConfirm: null });
    expect(settle(s, DEE).payments[1]).toMatchObject({ text: 'Cy sent you $174.97', canUndo: true, undoConfirm: "Undo Cy's record of $174.97?" });
  });
});

describe('recordPaymentCheck (criterion 54)', () => {
  const toDee = { cents: 17497, name: 'Dee', viewerPays: true };
  it('range', () => {
    expect(recordPaymentCheck(0, toDee)).toEqual({ status: 'invalid' });
    expect(recordPaymentCheck(100_000_000, toDee)).toEqual({ status: 'invalid' });
    expect(recordPaymentCheck(1.5, toDee)).toEqual({ status: 'invalid' });
    expect(recordPaymentCheck(1, toDee)).toEqual({ status: 'ok' });
    expect(recordPaymentCheck(99_999_999, null)).toEqual({ status: 'ok' });
  });
  it('over the suggestion, both directions', () => {
    expect(recordPaymentCheck(17497, toDee)).toEqual({ status: 'ok' });
    expect(recordPaymentCheck(17498, toDee)).toEqual({ status: 'over', text: "That's more than you owe Dee ($174.97)." });
    expect(recordPaymentCheck(13003, { cents: 13002, name: 'Ben', viewerPays: false })).toEqual({
      status: 'over',
      text: "That's more than Ben owes you ($130.02).",
    });
  });
});
