// Group screen and group Activity text (spec docs/specs/2026-11-26-groups-mvp.md T14; GR-M7; A1 N2).
jest.mock('./supabase', () => ({ supabase: {} }));
import type { TimeFormatters } from './activityText';
import { describeGroupEvent } from './groupActivityText';
import { GROUP_ERROR_COPY, type GroupError, type GroupEvent, type GroupSnapshot } from './groups';
import {
  costRowA11yLabel,
  costRowCaption,
  DELETE_GROUP_COPY,
  deleteConfirmText,
  deleteConfirmTitle,
  deletedNoticeText,
  deleteRefusal,
  deleteRowText,
  FORMER_MEMBER,
  groupEventSections,
  groupNameOf,
  leaveConfirmText,
  memberCountText,
  renameChanges,
  statusParts,
  waitingA11yLabel,
  waitingCaption,
} from './groupScreenText';
import { costRows, statusLine, waitingLines } from './groupView';
import { formatCents } from './money';
import { ANA, BEN, BRUNCH_ID, CY, DEE, DINNER_ID, W1, W2 } from '@/test-utils/groupFixtures';
import { S_EXPENSE_ID } from '@/test-utils/deleteGroupFixtures';
import { paymentId, snapshotOf, withNotPart } from '@/test-utils/groupSnapshotFixtures';

const LEFT = 'eeeeeeee-0000-4000-8000-000000000005';

describe('groupNameOf (GR-M7)', () => {
  const members = snapshotOf(W1.input).members;
  const nameOf = groupNameOf(members, ANA);
  it('names the viewer, members, unnamed members, former members and deleted accounts', () => {
    expect(nameOf(ANA)).toBe('You');
    expect(nameOf(BEN)).toBe('Ben');
    expect(groupNameOf([{ ...members[0]!, displayName: '  ' }], BEN)(ANA)).toBe('A friend');
    expect(nameOf(LEFT)).toBe(FORMER_MEMBER);
    expect(nameOf(null)).toBe('Someone');
  });
  it('reads "A former member left" and "A former member joined" in Activity', () => {
    const ev = (kind: string): GroupEvent => ({ id: LEFT, seq: 1, actorId: LEFT, kind, details: {}, createdAt: '2026-11-20T12:00:00Z' });
    expect(describeGroupEvent(ev('member_left'), nameOf)).toBe('A former member left');
    expect(describeGroupEvent(ev('member_joined'), nameOf)).toBe('A former member joined');
    expect(describeGroupEvent({ ...ev('member_left'), actorId: ANA }, nameOf)).toBe('You left');
  });
});

describe('statusParts', () => {
  it.each([-17497, -1, 0, 1, 2, 13002])('net %i: the lead and the amount read exactly as status.text', (net) => {
    const s = statusLine(net);
    const p = statusParts(s);
    expect(p.amountCents === null ? p.lead : `${p.lead} ${formatCents(p.amountCents)}`).toBe(s.text);
  });
});

describe('row labels', () => {
  it('a cost row says title, who paid and the viewer share; a waiting receipt says it is not counted', () => {
    const s = snapshotOf(W2.input);
    const nameOf = groupNameOf(s.members, BEN);
    const labels = costRows(s, BEN, nameOf).map(costRowA11yLabel);
    expect(labels).toContain("Ana's receipt, Ana paid $77.33, Your share isn't counted until everything is claimed");
    expect(labels).toContain('Airbnb, Ana paid $240.00, Your share $60.00');
    const [line] = waitingLines(s, BEN, nameOf);
    expect(line!.text).toBe("Ana's receipt: Nachos left to claim");
    expect(waitingA11yLabel(line!)).toBe("Balances don't include Ana's receipt yet: Nachos left to claim");
  });
  it('the viewer as payer reads "You paid"', () => {
    const s = snapshotOf(W1.input);
    const labels = costRows(s, ANA, groupNameOf(s.members, ANA)).map(costRowA11yLabel);
    expect(labels).toContain('Your receipt, You paid $77.33, Your share $30.08');
  });
});

describe('needs-you labels and captions (group claim status T5, C6)', () => {
  // W2: Dinner's nachos are unclaimed. Dee has no claim on Dinner, so it needs her; Ben has one.
  const s = snapshotOf(W2.input);
  const deeName = groupNameOf(s.members, DEE);
  const dinnerLine = (snap = s) => waitingLines(snap, DEE, deeName).find((l) => l.billId === DINNER_ID)!;
  const dinnerCost = (snap = s, viewer = DEE) => costRows(snap, viewer, groupNameOf(snap.members, viewer)).find((r) => r.id === DINNER_ID)!;

  it('a waiting line that needs me: caption and label both say I have not claimed anything', () => {
    const line = dinnerLine();
    expect(line.needsMe).toBe(true); // positive control: the fixture is the case under test
    expect(waitingCaption(line)).toBe("You haven't claimed anything here yet");
    expect(waitingA11yLabel(line)).toBe("Balances don't include Ana's receipt yet: Nachos left to claim. You haven't claimed anything here yet");
  });
  it('a waiting line I opted out of: "You weren\'t part of this" in caption and label', () => {
    const line = dinnerLine(withNotPart(s, [DINNER_ID]));
    expect(line.notPart).toBe(true);
    expect(waitingCaption(line)).toBe("You weren't part of this");
    expect(waitingA11yLabel(line)).toBe("Balances don't include Ana's receipt yet: Nachos left to claim. You weren't part of this");
  });
  it('any other waiting line: no caption, and the label is the notice alone', () => {
    const line = waitingLines(s, BEN, groupNameOf(s.members, BEN)).find((l) => l.billId === DINNER_ID)!;
    expect(line.needsMe || line.notPart).toBe(false);
    expect(waitingCaption(line)).toBeNull();
    expect(waitingA11yLabel(line)).toBe(line.notice);
  });
  it('a cost row that needs me: caption gains "· Claim your items", and the label says it in reading order', () => {
    const row = dinnerCost();
    expect(row.needsMe).toBe(true);
    expect(costRowCaption(row)).toBe('Ana paid $77.33 · Claim your items');
    expect(costRowA11yLabel(row)).toBe("Ana's receipt, Ana paid $77.33, Claim your items, Your share isn't counted until everything is claimed");
  });
  it('a cost row that does not need me (claimed, opted out, an expense, another bill) is unchanged', () => {
    const claimed = dinnerCost(s, BEN);
    expect(claimed.needsMe).toBe(false);
    expect(costRowCaption(claimed)).toBe('Ana paid $77.33');
    expect(costRowA11yLabel(claimed)).toBe("Ana's receipt, Ana paid $77.33, Your share isn't counted until everything is claimed");
    const optedOut = dinnerCost(withNotPart(s, [DINNER_ID]));
    expect(costRowCaption(optedOut)).toBe('Ana paid $77.33');
    const others = costRows(s, DEE, deeName).filter((r) => r.id !== DINNER_ID && r.id !== BRUNCH_ID);
    expect(others.length).toBeGreaterThan(0);
    for (const r of others) expect(costRowCaption(r)).toBe(r.paidLine);
  });
});

describe('small copy', () => {
  it('counts members, with 1 as "Just you"', () => {
    expect(memberCountText(4)).toBe('4 people');
    expect(memberCountText(1)).toBe('Just you');
  });
  it('asks before leaving, naming the group', () => {
    expect(leaveConfirmText('Tahoe trip')).toBe("Leave Tahoe trip? You'll need the group's link to come back.");
  });
  it('a rename to the same trimmed name changes nothing', () => {
    expect(renameChanges('Tahoe trip', '  Tahoe trip\t')).toBe(false);
    expect(renameChanges('Tahoe trip', 'Tahoe Trip')).toBe(true);
    // Only the six ASCII spaces are trimmed, as in the DB (A1.12): a trailing no-break space is a change.
    expect(renameChanges('Tahoe trip', 'Tahoe trip ')).toBe(true);
  });
});

describe('groupEventSections (A1 N2)', () => {
  const fmt: TimeFormatters = { time: () => '7:42 PM', date: () => 'Nov 18' };
  // Local times, so day boundaries don't depend on the machine's time zone.
  const local = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString();
  const now = new Date(2026, 10, 20, 20, 0);
  const ev = (n: number, createdAt: string): GroupEvent => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    seq: 100 - n,
    actorId: null,
    kind: 'member_joined',
    details: {},
    createdAt,
  });
  it('keeps seq order inside one timestamp (never sorts by time or id)', () => {
    const same = local(20, 19, 59);
    const events = [ev(9, same), ev(1, same), ev(5, same)];
    const sections = groupEventSections(events, now, fmt);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toBe('Just now');
    expect(sections[0]!.events.map((e) => e.seq)).toEqual([91, 99, 95]);
  });
  it('starts a section when the label changes', () => {
    const events = [ev(1, local(20, 19, 59)), ev(2, local(20, 10)), ev(3, local(19, 10)), ev(4, local(1, 10))];
    expect(groupEventSections(events, now, fmt).map((s) => s.title)).toEqual(['Just now', '7:42 PM', 'Yesterday', 'Nov 18']);
  });
});

// ---------------------------------------------------------------------------------------------
// Delete group copy (docs/specs/2026-11-28-delete-group.md, copy table as amended by A2.8 / A2.9).

describe('delete group copy (C1–C12)', () => {
  it('has the spec wording', () => {
    expect(DELETE_GROUP_COPY.row).toBe('Delete group'); // C1
    expect(DELETE_GROUP_COPY.rowHint).toBe('Asks first'); // C1a
    expect(DELETE_GROUP_COPY.waitingCaption).toBe('Every receipt has to be fully claimed before you can delete this group.'); // C2a
    expect(DELETE_GROUP_COPY.notSettledCaption).toBe('Everyone has to be settled up before you can delete this group.'); // C2b
    expect(DELETE_GROUP_COPY.confirm).toBe('Delete group'); // C4
    expect(DELETE_GROUP_COPY.cancel).toBe('Cancel'); // C4
    expect(DELETE_GROUP_COPY.networkError).toBe("Couldn't delete the group. Check your connection and try again."); // C5
    expect(DELETE_GROUP_COPY.changed).toBe('Something in this group just changed. Check it and try again.'); // C6
    expect(DELETE_GROUP_COPY.receiptsWaiting).toBe(DELETE_GROUP_COPY.waitingCaption); // C7 = C2a
    expect(DELETE_GROUP_COPY.deletedHeading).toBe('This group was deleted'); // C8
    expect(DELETE_GROUP_COPY.goHome).toBe('Go home'); // C8
    expect(DELETE_GROUP_COPY.dismiss).toBe('Dismiss'); // C9
    expect(DELETE_GROUP_COPY.dismissHint).toBe('Hides this message'); // C9
  });

  it('C11 and C12 are the same strings as GROUP_ERROR_COPY (one definition)', () => {
    expect(GROUP_ERROR_COPY.group_changed).toBe(DELETE_GROUP_COPY.changed);
    expect(GROUP_ERROR_COPY.receipts_waiting).toBe(DELETE_GROUP_COPY.waitingCaption);
  });

  it('C3 title and C9 notice name the group', () => {
    expect(deleteConfirmTitle('Tahoe trip')).toBe('Delete "Tahoe trip" for everyone?');
    expect(deletedNoticeText('Tahoe trip')).toBe('"Tahoe trip" was deleted.');
  });
});

describe('deleteRowText (C1, C1a, C2a–C2c)', () => {
  it('enabled: label and hint, no caption', () => {
    expect(deleteRowText({ ok: true })).toEqual({
      label: 'Delete group',
      hint: 'Asks first',
      caption: null,
      a11yLabel: 'Delete group',
      disabled: false,
    });
  });

  it.each([
    ['receipts_waiting', 'Every receipt has to be fully claimed before you can delete this group.'],
    ['not_settled', 'Everyone has to be settled up before you can delete this group.'],
  ] as const)('disabled for %s: the caption, and the C2c label', (reason, caption) => {
    expect(deleteRowText({ ok: false, reason })).toEqual({
      label: 'Delete group',
      hint: null,
      caption,
      a11yLabel: `Delete group, unavailable. ${caption}`,
      disabled: true,
    });
  });
});

describe('deleteConfirmText (C3b as amended by A2.8; criterion 36)', () => {
  const MEMBERS4 = [ANA, BEN, CY, DEE];
  /** A snapshot with these counts; the money is irrelevant to the sentence. */
  function counts(members: number, expenses: number, receipts: number, payments: boolean): GroupSnapshot {
    const ids = MEMBERS4.slice(0, members);
    const base = snapshotOf(W1.input, { members: ids });
    const ex = base.expenses[0];
    const bill = base.bills[0];
    const pay = { id: paymentId(1), from: ids[0] ?? ANA, to: ids[1] ?? ANA, cents: 100, method: 'cash', source: 'manual', recordedBy: ids[0] ?? ANA, billId: null, createdAt: base.group.createdAt } as const;
    if (!ex || !bill) throw new Error('fixture');
    return {
      ...base,
      expenses: Array.from({ length: expenses }, (_, i) => ({ ...ex, id: S_EXPENSE_ID(i + 1) })),
      bills: Array.from({ length: receipts }, (_, i) => ({ ...bill, id: `b8000000-0000-4000-8000-00000000000${i + 1}` })),
      payments: payments ? [pay] : [],
    };
  }

  it.each<[string, number, number, number, boolean, string]>([
    ['the A2.8 example', 4, 3, 2, true, "Its 3 expenses, 2 receipts and payment history will be removed for all 4 members. This can't be undone."],
    ['1 member, nothing', 1, 0, 0, false, "It will be removed for you. This can't be undone."],
    ['2 members, 1 expense', 2, 1, 0, false, "Its 1 expense will be removed for both members. This can't be undone."],
    ['3 members, 1 receipt', 3, 0, 1, false, "Its 1 receipt will be removed for all 3 members. This can't be undone."],
    ['2 members, 2 expenses, payments', 2, 2, 0, true, "Its 2 expenses and payment history will be removed for both members. This can't be undone."],
    ['1 member, 1 expense and 1 receipt', 1, 1, 1, false, "Its 1 expense and 1 receipt will be removed for you. This can't be undone."],
    ['3 members, payments only', 3, 0, 0, true, "Its payment history will be removed for all 3 members. This can't be undone."],
  ])('%s', (_label, members, expenses, receipts, payments, text) => {
    expect(deleteConfirmText(counts(members, expenses, receipts, payments))).toBe(text);
  });

  it('review R3: an undone payment (in notReceived, not payments) is deleted too, so it counts as "payment history"', () => {
    const s = counts(2, 1, 0, false);
    const withUndone: GroupSnapshot = {
      ...s,
      notReceived: [{ id: paymentId(9), from: ANA, to: BEN, cents: 100, method: 'cash', undoneAt: s.group.createdAt }],
    };
    expect(deleteConfirmText(withUndone)).toBe("Its 1 expense and payment history will be removed for both members. This can't be undone.");
    // Positive control: the same snapshot without the undone row has no payment history.
    expect(deleteConfirmText(s)).toBe("Its 1 expense will be removed for both members. This can't be undone.");
  });
});

describe('deleteRefusal (criteria 44, 45 as amended by A2.11; A3)', () => {
  it.each<[GroupError, ReturnType<typeof deleteRefusal>]>([
    ['group_changed', { kind: 'close', text: 'Something in this group just changed. Check it and try again.' }],
    ['receipts_waiting', { kind: 'close', text: 'Every receipt has to be fully claimed before you can delete this group.' }],
    // A2.11: the group is gone (a retry after a delete that went through, or deleted by someone else).
    ['not_allowed', { kind: 'gone' }],
    ['busy', { kind: 'stay', text: "That didn't go through. Please try again." }],
    ['network', { kind: 'stay', text: "Couldn't delete the group. Check your connection and try again." }],
    // Anything delete_group never answers reads as the network line (the dialog stays, retry is safe).
    ['invalid_name', { kind: 'stay', text: "Couldn't delete the group. Check your connection and try again." }],
  ])('%s → %j', (error, expected) => {
    expect(deleteRefusal(error)).toEqual(expected);
  });
});
