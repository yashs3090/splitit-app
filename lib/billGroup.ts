// Words and small decisions for a bill and its group (spec docs/specs/2026-11-26-groups-mvp.md T17,
// as amended by A1 S1b/S7). Pure: the screens (app/(app)/bills/[id]/group.tsx, the bill form, the
// invite link) and components/BillGroupLine.tsx render from these and build no strings themselves.
//
// - attachCheck: before "Add to <group>", who on the bill isn't in the group yet (then the host is
//   asked to invite them first, and there's no button), and whose "I paid" will become a group
//   payment (U-G1). The database checks both again (participants_not_members; the conversion).
// - billGroupLine: what the bill screen's line under the title says.
// - groupBillText: the words the bill screen, Settle and Add people use on a group bill (T17 part 2).
// - joinBillProblem: the /b/<code> screen's error kinds, including the group bill's (A1 S7).
import type { BillError } from './bills';
import type { NameOf } from './billView';
import { nameList } from './billView';
import { GROUP_ERROR_COPY, type GroupError } from './groups';

export const BILL_GROUP_COPY = {
  title: 'Add to a group',
  inGroupTitle: 'In a group',
  back: 'Back',
  backHint: 'Goes back to the bill',
  intro: "Everyone in the group joins this bill, and it counts in the group's balances.",
  yourGroups: 'Your groups',
  noGroups: "You're not in any groups yet.",
  startGroup: 'Start a group',
  startGroupHint: 'Opens a new group',
  loadError: "Couldn't load your groups.",
  billLoadError: "Couldn't load the bill.",
  tryAgain: 'Try again',
  goHome: 'Go home',
  invitePeople: 'Invite people',
  detachExplain: "It will stop counting in the group's balances. Everyone stays on the bill.",
  moveToGroup: 'Move to a group',
  moveToGroupHint: 'Choose a group for this bill',
  takeOut: 'Take out',
  takeOutHint: 'Opens a screen to take this bill out of the group',
  openGroupHint: 'Opens the group',
} as const;

/** "Add to Tahoe trip": the one primary action once a group is chosen. */
export function attachButtonText(groupName: string): string {
  return `Add to ${groupName}`;
}

/** "Take out of Tahoe trip". */
export function detachButtonText(groupName: string): string {
  return `Take out of ${groupName}`;
}

/** The bill form's line when the receipt came from a group: "Goes in Tahoe trip". */
export function receiptGoesInText(groupName: string): string {
  return `Goes in ${groupName}`;
}

/** The bill form's save hint for a receipt from a group. */
export function saveHintForGroup(groupName: string): string {
  return `Saves the bill and adds it to ${groupName}.`;
}

/** "This bill is in Tahoe trip." */
export function inGroupText(groupName: string): string {
  return `This bill is in ${groupName}.`;
}

/** The host's name in "Only Hana can move this bill into a group." ("You" never reaches here.) */
export function onlyHostCanMoveText(hostName: string): string {
  return `Only ${hostName} can move this bill into a group.`;
}

export function onlyHostCanTakeOutText(hostName: string, groupName: string): string {
  return `Only ${hostName} can take it out of ${groupName}.`;
}

export function checkingText(groupName: string): string {
  return `Checking who's in ${groupName}…`;
}

export function checkFailedText(groupName: string): string {
  return `Couldn't check who's in ${groupName}.`;
}

/** The radio row's label: everything it shows. "Tahoe trip, 4 people". */
export function groupChoiceA11yLabel(groupName: string, countText: string): string {
  return `${groupName}, ${countText}`;
}

export function inviteHint(groupName: string): string {
  return `Opens ${groupName} with its invite link`;
}

/** "Invite Sam to Tahoe trip first." / "Invite Sam and Ben to Tahoe trip first." */
export function inviteFirstText(names: readonly string[], groupName: string): string {
  return `Invite ${nameList(names)} to ${groupName} first.`;
}

/**
 * Who marked "I paid", as it reads after moving in (U-G1). One person uses the spec's wording:
 * `Ben's "I paid" will become a Tahoe trip payment.` / `Your "I paid" …`. Several:
 * `"I paid" from Ben and Cy will become Tahoe trip payments.` (with "you" for the viewer).
 */
export function conversionText(names: readonly string[], groupName: string): string {
  const [only] = names;
  if (names.length === 1 && only !== undefined) {
    const owner = only === 'You' ? 'Your' : `${only}'s`;
    return `${owner} "I paid" will become a ${groupName} payment.`;
  }
  const list = nameList(names.map((n) => (n === 'You' ? 'you' : n)));
  return `"I paid" from ${list} will become ${groupName} payments.`;
}

type CheckParticipant = { userId: string; mark: unknown };

export type AttachCheck =
  | { kind: 'invite_first'; text: string }
  | { kind: 'not_complete'; text: string }
  | { kind: 'ready'; conversion: string | null };

/**
 * The bill's claim state for A1 S1b, from lib (the screen passes `sharesComplete(...).complete` and
 * lib/settle.ts `allZero(...)` over the bill it loaded: the same rules as the DB's
 * private.bill_is_complete / private.bill_all_zero that attach_bill_to_group uses).
 */
export type AttachBillState = { complete: boolean; allZero: boolean };

/**
 * Before attaching, in the order the person fixes things:
 * 1. participants who aren't members (in the bill's join order): "invite first";
 * 2. A1 S1b: a bill with any "I paid" mark that isn't fully claimed, or is all-$0, can't move in
 *    ("Finish claiming before moving it into the group."); a bill with no marks can;
 * 3. otherwise ready: the conversion line names everyone with a mark, or null when nobody has one.
 * The database checks all three again; its refusals stay the backstop.
 */
export function attachCheck(
  participants: readonly CheckParticipant[],
  memberIds: readonly string[],
  groupName: string,
  nameOf: NameOf,
  bill: AttachBillState,
): AttachCheck {
  const members = new Set(memberIds);
  const missing = participants.filter((p) => !members.has(p.userId)).map((p) => nameOf(p.userId));
  if (missing.length > 0) return { kind: 'invite_first', text: inviteFirstText(missing, groupName) };
  const marked = participants.filter((p) => p.mark !== null && p.mark !== undefined).map((p) => nameOf(p.userId));
  if (marked.length > 0 && (!bill.complete || bill.allZero)) return { kind: 'not_complete', text: GROUP_ERROR_COPY.not_complete };
  return { kind: 'ready', conversion: marked.length > 0 ? conversionText(marked, groupName) : null };
}

/** T17's attach-failure copy, also the bill screen's line after a failed attach from the bill form. */
export function attachFailedText(groupName: string): string {
  return `Couldn't add it to ${groupName}. Try again.`;
}

/** An attach refusal, said on the group screen. A network failure names the group. */
export function attachErrorText(error: GroupError, groupName: string): string {
  return error === 'network' ? attachFailedText(groupName) : GROUP_ERROR_COPY[error];
}

export function detachErrorText(error: GroupError, groupName: string): string {
  return error === 'network' ? `Couldn't take it out of ${groupName}. Try again.` : GROUP_ERROR_COPY[error];
}

// ---------------------------------------------------------------------------
// The bill form: does the stored group still apply? (GR-6)
// ---------------------------------------------------------------------------

/** A route of the (app) stack as the navigator reports it ("groups/[id]/index", "scan", "bill"). */
export type StackRoute = { name: string; params?: object };

/** The steps of the receipt flow between the group screen and the bill form. */
const RECEIPT_FLOW_ROUTES: ReadonlySet<string> = new Set(['scan', 'bill']);
const GROUP_ROUTE = 'groups/[id]/index';

/**
 * The stored group applies only if the person came to this bill form from that group's screen:
 * below the form, past any Scan and bill-form steps, the next screen is `groups/[id]` with the
 * stored id. Otherwise (Home, a bill, another group, a cold link), the receipt goes in no group.
 * Needed because leaving Scan for Home can keep the group screen mounted further down the stack.
 */
export function receiptGroupFor(routes: readonly StackRoute[], stored: BillGroupRef | null): BillGroupRef | null {
  if (stored === null) return null;
  let i = routes.length - 1;
  // The form itself is the newest 'bill' route; start below it.
  while (i >= 0 && routes[i]?.name !== 'bill') i--;
  for (i -= 1; i >= 0; i--) {
    const route = routes[i];
    if (route === undefined) return null;
    if (RECEIPT_FLOW_ROUTES.has(route.name)) continue;
    const id = route.params !== undefined && 'id' in route.params ? (route.params as { id?: unknown }).id : undefined;
    return route.name === GROUP_ROUTE && id === stored.groupId ? stored : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The bill screen's line (components/BillGroupLine.tsx)
// ---------------------------------------------------------------------------

export type BillGroupRef = { groupId: string; name: string };
/** A failed attach right after create_bill (lib/scanSession.ts takes it to the bill screen). */
export type AttachFailure = { billId: string; groupId: string; groupName: string };

/**
 * A group bill's lines (T17): the footer and Settle say where it's settled, the invite card becomes
 * a link to the group's invite, and Add people says where the people come from. One home for the
 * words so the three screens can't drift.
 */
export function groupBillText(groupName: string) {
  return {
    settledIn: `Settled in ${groupName}`,
    settledInHint: 'Opens the group to see balances and settle up',
    settleBody: "This bill counts in the group's balances. Payments for it are made in the group.",
    openGroup: `Open ${groupName}`,
    openGroupHint: BILL_GROUP_COPY.openGroupHint,
    invite: `Invite people to ${groupName}`,
    inviteHint: inviteHint(groupName),
    peopleFromGroup: `Everyone in ${groupName} is on this bill. To add someone, invite them to the group.`,
  } as const;
}

/**
 * On a group bill the row's own claim control sends the whole map through assign_item, like the
 * item sheet's chips (one way to claim, U-G6). From the server's map: `claimed` puts the viewer on
 * it (keeping their parts if they're already there), otherwise takes only them off. Pure.
 */
export function claimMapFor(current: Readonly<Record<string, number>>, userId: string, claimed: boolean): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [id, parts] of Object.entries(current)) if (id !== userId) next[id] = parts;
  const mine = current[userId];
  if (claimed) next[userId] = mine ?? 1;
  return next;
}

/**
 * GR-T17-17 (resolved, money safety): until the bill's group is known, no screen shows a way to pay,
 * mark, request, leave or invite. If the group read failed, this line stands where those were.
 */
export const GROUP_CHECK_COPY = {
  failed: "Couldn't check this bill's group. Try again.",
  checking: "Checking this bill's group…",
  tryAgain: 'Try again',
  tryAgainHint: 'Checks again whether this bill is in a group',
} as const;

/**
 * A write refused with in_group: the bill was moved into a group under the screen. Said once the
 * group is known (with its name) or while it's being checked (without). After Venmo opened (web
 * opens first), it also says not to send it.
 */
export function inGroupRefusalText(groupName: string | null, afterOpen: boolean): string {
  const where = groupName === null ? 'a group' : groupName;
  const lead = afterOpen ? `Venmo opened, but this bill is now in ${where}. Don't send it.` : `This bill is now in ${where}.`;
  return `${lead} Settle up in the group.`;
}

export type BillGroupLineModel =
  | { kind: 'hidden' }
  | { kind: 'in_group'; groupId: string; text: string; a11yLabel: string; canManage: boolean; takeOutA11y: string }
  | { kind: 'move'; text: string }
  | { kind: 'attach_failed'; groupId: string; text: string };

/**
 * `group`: the bill's group (fetchBillGroup), null for none, undefined while unknown (loading or a
 * failed read: the line stays out rather than offering a move that may be wrong).
 * `canMove`: the host may move it (the caller decides, e.g. host with at least one group).
 * `failure`: shown only while it still describes this bill and the bill is still in no group
 * (lesson 2026-11-25: a message is kept with the facts it describes).
 * `retryError`: the last Try again's refusal; a database refusal says why in its fixed copy, a
 * network failure keeps "Couldn't add it to Tahoe trip. Try again.".
 */
export function billGroupLine(input: {
  billId: string;
  group: BillGroupRef | null | undefined;
  isHost: boolean;
  canMove: boolean;
  failure: AttachFailure | null;
  retryError?: GroupError | null;
}): BillGroupLineModel {
  const { billId, group, isHost, canMove, failure, retryError = null } = input;
  if (group === undefined) return { kind: 'hidden' };
  if (group !== null) {
    const text = `In ${group.name}`;
    return { kind: 'in_group', groupId: group.groupId, text, a11yLabel: text, canManage: isHost, takeOutA11y: detachButtonText(group.name) };
  }
  if (failure !== null && failure.billId === billId && isHost) {
    return { kind: 'attach_failed', groupId: failure.groupId, text: attachErrorText(retryError ?? 'network', failure.groupName) };
  }
  if (isHost && canMove) return { kind: 'move', text: BILL_GROUP_COPY.moveToGroup };
  return { kind: 'hidden' };
}

// ---------------------------------------------------------------------------
// The invite link /b/<code> (A1 S7)
// ---------------------------------------------------------------------------

export type JoinBillProblem = 'invalid' | 'in_group' | 'failed';

/**
 * The join screen's error kinds (GR-25 / A1 S7: a non-member opening a group bill's link gets
 * BILL_ERROR_COPY.in_group with no retry). Anything else is 'failed' (Try again).
 */
export function joinBillProblem(error: BillError): JoinBillProblem {
  if (error === 'invalid_code') return 'invalid';
  if (error === 'in_group') return 'in_group';
  return 'failed';
}
