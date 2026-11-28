// lib/billGroup.ts: spec docs/specs/2026-11-26-groups-mvp.md T17 (criteria 81, 111) as amended by A1.
import {
  attachCheck,
  attachErrorText,
  billGroupLine,
  claimMapFor,
  conversionText,
  detachErrorText,
  GROUP_CHECK_COPY,
  groupBillText,
  inGroupRefusalText,
  inviteFirstText,
  joinBillProblem,
  receiptGroupFor,
} from './billGroup';
import { makeNameOf } from './billView';

// GROUP_ERROR_COPY lives in lib/groups.ts, which imports the client.
jest.mock('./supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});

const ANA = 'aaaaaaaa-0000-4000-8000-000000000001';
const BEN = 'bbbbbbbb-0000-4000-8000-000000000002';
const SAM = 'cccccccc-0000-4000-8000-000000000003';
const CY = 'dddddddd-0000-4000-8000-000000000004';
const BILL = '11111111-2222-4333-8444-555555555555';
const GROUP = '99999999-0000-4000-8000-000000000009';
const MARK = { cents: 1200, at: '2026-11-20T12:00:00.000Z', method: 'venmo', toUserId: ANA };

const people = [
  { userId: ANA, displayName: 'Ana' },
  { userId: BEN, displayName: 'Ben' },
  { userId: SAM, displayName: 'Sam' },
  { userId: CY, displayName: null },
];
const nameOf = makeNameOf(people, ANA);
const COMPLETE = { complete: true, allZero: false };

describe('inviteFirstText', () => {
  it('names one person, then two', () => {
    expect(inviteFirstText(['Sam'], 'Tahoe trip')).toBe('Invite Sam to Tahoe trip first.');
    expect(inviteFirstText(['Sam', 'Ben'], 'Tahoe trip')).toBe('Invite Sam and Ben to Tahoe trip first.');
  });
});

describe('conversionText (count of 1, the viewer, several)', () => {
  it('one other person uses the spec wording', () => {
    expect(conversionText(['Ben'], 'Tahoe trip')).toBe('Ben\'s "I paid" will become a Tahoe trip payment.');
  });
  it('the viewer alone reads "Your"', () => {
    expect(conversionText(['You'], 'Tahoe trip')).toBe('Your "I paid" will become a Tahoe trip payment.');
  });
  it('several, with the viewer as "you"', () => {
    expect(conversionText(['Ben', 'Sam'], 'Tahoe trip')).toBe('"I paid" from Ben and Sam will become Tahoe trip payments.');
    expect(conversionText(['You', 'Ben', 'Sam'], 'Tahoe trip')).toBe('"I paid" from you, Ben and Sam will become Tahoe trip payments.');
  });
});

describe('attachCheck', () => {
  it('81: a participant who is not a member means invite first (in join order), whatever the marks', () => {
    const parts = [
      { userId: ANA, mark: null },
      { userId: SAM, mark: MARK },
      { userId: BEN, mark: null },
    ];
    expect(attachCheck(parts, [ANA, BEN], 'Tahoe trip', nameOf, COMPLETE)).toEqual({ kind: 'invite_first', text: 'Invite Sam to Tahoe trip first.' });
    expect(attachCheck(parts, [ANA], 'Tahoe trip', nameOf, COMPLETE)).toEqual({
      kind: 'invite_first',
      text: 'Invite Sam and Ben to Tahoe trip first.',
    });
  });

  it('an unnamed participant reads "A friend"', () => {
    expect(attachCheck([{ userId: CY, mark: null }], [ANA], 'Trip', nameOf, COMPLETE)).toEqual({ kind: 'invite_first', text: 'Invite A friend to Trip first.' });
  });

  it('81: everyone a member: names each marked person, or no line', () => {
    const members = [ANA, BEN, SAM];
    expect(attachCheck([{ userId: ANA, mark: null }, { userId: BEN, mark: MARK }], members, 'Tahoe trip', nameOf, COMPLETE)).toEqual({
      kind: 'ready',
      conversion: 'Ben\'s "I paid" will become a Tahoe trip payment.',
    });
    expect(
      attachCheck([{ userId: ANA, mark: MARK }, { userId: BEN, mark: MARK }, { userId: SAM, mark: null }], members, 'Tahoe trip', nameOf, COMPLETE),
    ).toEqual({ kind: 'ready', conversion: '"I paid" from you and Ben will become Tahoe trip payments.' });
    expect(attachCheck([{ userId: ANA, mark: null }, { userId: BEN, mark: null }], members, 'Tahoe trip', nameOf, COMPLETE)).toEqual({
      kind: 'ready',
      conversion: null,
    });
  });
});

describe('attachCheck: A1 S1b up front (R2-N1)', () => {
  const members = [ANA, BEN, SAM];
  const marked = [{ userId: ANA, mark: null }, { userId: BEN, mark: MARK }];
  const unmarked = [{ userId: ANA, mark: null }, { userId: BEN, mark: null }];
  const NOT_COMPLETE = { kind: 'not_complete', text: 'Finish claiming before moving it into the group.' };

  it('marks + not fully claimed, or marks + all-$0: finish claiming first', () => {
    expect(attachCheck(marked, members, 'Tahoe trip', nameOf, { complete: false, allZero: false })).toEqual(NOT_COMPLETE);
    expect(attachCheck(marked, members, 'Tahoe trip', nameOf, { complete: true, allZero: true })).toEqual(NOT_COMPLETE);
  });
  it('marks + complete: ready, naming the mark', () => {
    expect(attachCheck(marked, members, 'Tahoe trip', nameOf, COMPLETE)).toEqual({
      kind: 'ready',
      conversion: 'Ben\'s "I paid" will become a Tahoe trip payment.',
    });
  });
  it('no marks: an incomplete or all-$0 bill can still move in', () => {
    expect(attachCheck(unmarked, members, 'Tahoe trip', nameOf, { complete: false, allZero: false })).toEqual({ kind: 'ready', conversion: null });
    expect(attachCheck(unmarked, members, 'Tahoe trip', nameOf, { complete: true, allZero: true })).toEqual({ kind: 'ready', conversion: null });
  });
  it('someone missing comes first', () => {
    expect(attachCheck([...marked, { userId: CY, mark: null }], members, 'Tahoe trip', nameOf, { complete: false, allZero: false })).toMatchObject({
      kind: 'invite_first',
    });
  });
});

describe('error copy', () => {
  it('network names the group; refusals use the fixed group copy', () => {
    expect(attachErrorText('network', 'Tahoe trip')).toBe("Couldn't add it to Tahoe trip. Try again.");
    expect(attachErrorText('not_complete', 'Tahoe trip')).toBe('Finish claiming before moving it into the group.');
    expect(attachErrorText('already_in_group', 'Tahoe trip')).toBe('This bill is already in another group.');
    expect(attachErrorText('participants_not_members', 'Tahoe trip')).toBe('Everyone on the bill has to be in the group first.');
    expect(detachErrorText('network', 'Tahoe trip')).toBe("Couldn't take it out of Tahoe trip. Try again.");
    expect(detachErrorText('has_bill_payments', 'Tahoe trip')).toBe('Undo the payments that came from this bill\'s "I paid" marks first.');
  });
});

describe('billGroupLine', () => {
  const base = { billId: BILL, isHost: true, canMove: true, failure: null };
  const tahoe = { groupId: GROUP, name: 'Tahoe trip' };

  it('unknown group: nothing, even for the host', () => {
    expect(billGroupLine({ ...base, group: undefined })).toEqual({ kind: 'hidden' });
  });
  it('in a group: "In Tahoe trip" for everyone; only the host can manage', () => {
    expect(billGroupLine({ ...base, group: tahoe })).toEqual({
      kind: 'in_group',
      groupId: GROUP,
      text: 'In Tahoe trip',
      a11yLabel: 'In Tahoe trip',
      canManage: true,
      takeOutA11y: 'Take out of Tahoe trip',
    });
    expect(billGroupLine({ ...base, isHost: false, group: tahoe })).toMatchObject({ kind: 'in_group', canManage: false });
  });
  it('no group: the host gets "Move to a group" when they can move it; others get nothing', () => {
    expect(billGroupLine({ ...base, group: null })).toEqual({ kind: 'move', text: 'Move to a group' });
    expect(billGroupLine({ ...base, canMove: false, group: null })).toEqual({ kind: 'hidden' });
    expect(billGroupLine({ ...base, isHost: false, group: null })).toEqual({ kind: 'hidden' });
  });
  it('a failed attach shows while it still describes this bill, and goes once the bill is in a group', () => {
    const failure = { billId: BILL, groupId: GROUP, groupName: 'Tahoe trip' };
    expect(billGroupLine({ ...base, group: null, failure })).toEqual({
      kind: 'attach_failed',
      groupId: GROUP,
      text: "Couldn't add it to Tahoe trip. Try again.",
    });
    expect(billGroupLine({ ...base, group: tahoe, failure })).toMatchObject({ kind: 'in_group' });
    expect(billGroupLine({ ...base, group: null, failure: { ...failure, billId: 'other' } })).toEqual({ kind: 'move', text: 'Move to a group' });
  });
  it('a retry the database refused says why (its fixed copy); a network failure keeps the retry line', () => {
    const failure = { billId: BILL, groupId: GROUP, groupName: 'Tahoe trip' };
    expect(billGroupLine({ ...base, group: null, failure, retryError: 'participants_not_members' })).toEqual({
      kind: 'attach_failed',
      groupId: GROUP,
      text: 'Everyone on the bill has to be in the group first.',
    });
    expect(billGroupLine({ ...base, group: null, failure, retryError: 'network' })).toMatchObject({
      text: "Couldn't add it to Tahoe trip. Try again.",
    });
    expect(billGroupLine({ ...base, group: null, failure, retryError: null })).toMatchObject({
      text: "Couldn't add it to Tahoe trip. Try again.",
    });
  });
  it('a guest never sees the failed attach (only the host can retry it)', () => {
    const failure = { billId: BILL, groupId: GROUP, groupName: 'Tahoe trip' };
    expect(billGroupLine({ ...base, isHost: false, group: null, failure })).toEqual({ kind: 'hidden' });
  });
});

describe('groupBillText (T17: the bill screen, Settle and Add people on a group bill)', () => {
  it('names the group in every line', () => {
    expect(groupBillText('Tahoe trip')).toEqual({
      settledIn: 'Settled in Tahoe trip',
      settledInHint: 'Opens the group to see balances and settle up',
      settleBody: "This bill counts in the group's balances. Payments for it are made in the group.",
      openGroup: 'Open Tahoe trip',
      openGroupHint: 'Opens the group',
      invite: 'Invite people to Tahoe trip',
      inviteHint: 'Opens Tahoe trip with its invite link',
      peopleFromGroup: 'Everyone in Tahoe trip is on this bill. To add someone, invite them to the group.',
    });
  });
});

describe('joinBillProblem (A1 S7)', () => {
  it('maps the join errors, unknown ones to a retry', () => {
    expect(joinBillProblem('invalid_code')).toBe('invalid');
    expect(joinBillProblem('in_group')).toBe('in_group');
    expect(joinBillProblem('network')).toBe('failed');
    expect(joinBillProblem('not_allowed')).toBe('failed');
  });
});

describe('receiptGroupFor (GR-6)', () => {
  const stored = { groupId: GROUP, name: 'Tahoe trip' };
  const group = (id: string) => ({ name: 'groups/[id]/index', params: { id } });
  const scan = { name: 'scan', params: {} };
  const form = { name: 'bill', params: {} };
  const home = { name: 'index', params: {} };

  it('applies when the form came from that group, through Scan (and Start over) or straight', () => {
    expect(receiptGroupFor([home, group(GROUP), scan, form], stored)).toBe(stored);
    expect(receiptGroupFor([group(GROUP), scan, scan, form], stored)).toBe(stored);
    expect(receiptGroupFor([group(GROUP), form], stored)).toBe(stored);
  });
  it('does not apply when Home (or anything else) is below the flow, even with the group further down', () => {
    expect(receiptGroupFor([group(GROUP), home, scan, form], stored)).toBeNull();
    expect(receiptGroupFor([home, scan, form], stored)).toBeNull();
    expect(receiptGroupFor([group('other'), scan, form], stored)).toBeNull();
    expect(receiptGroupFor([form], stored)).toBeNull();
    expect(receiptGroupFor([], stored)).toBeNull();
  });
  it('nothing stored: nothing applies', () => {
    expect(receiptGroupFor([group(GROUP), scan, form], null)).toBeNull();
  });
});

describe('claimMapFor (a row\'s own claim control on a group bill goes through assign_item)', () => {
  const current = { [BEN]: 2, [SAM]: 1 };
  it('claiming adds the viewer at 1 part and keeps everyone else', () => {
    expect(claimMapFor(current, ANA, true)).toEqual({ [BEN]: 2, [SAM]: 1, [ANA]: 1 });
  });
  it('claiming when already on it keeps the viewer\'s parts (a no-op for assign_item)', () => {
    expect(claimMapFor({ ...current, [ANA]: 3 }, ANA, true)).toEqual({ [BEN]: 2, [SAM]: 1, [ANA]: 3 });
  });
  it('unclaiming drops only the viewer, and is a no-op when they weren\'t on it', () => {
    expect(claimMapFor({ ...current, [ANA]: 3 }, ANA, false)).toEqual(current);
    expect(claimMapFor(current, ANA, false)).toEqual(current);
  });
  it('never changes the map it was given', () => {
    const before = { ...current };
    claimMapFor(current, ANA, true);
    expect(current).toEqual(before);
  });
});

describe('GR-T17-17: the group check and an in_group refusal', () => {
  it('has fixed copy for a group read that failed', () => {
    expect(GROUP_CHECK_COPY.failed).toBe("Couldn't check this bill's group. Try again.");
    expect(GROUP_CHECK_COPY.checking).toBe("Checking this bill's group…");
  });
  it('names the group once known, and says not to send after Venmo opened', () => {
    expect(inGroupRefusalText('Tahoe trip', false)).toBe('This bill is now in Tahoe trip. Settle up in the group.');
    expect(inGroupRefusalText(null, false)).toBe('This bill is now in a group. Settle up in the group.');
    expect(inGroupRefusalText('Tahoe trip', true)).toBe(
      "Venmo opened, but this bill is now in Tahoe trip. Don't send it. Settle up in the group.",
    );
  });
});
