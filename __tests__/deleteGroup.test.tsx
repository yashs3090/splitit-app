// Delete group on the group screen (docs/specs/2026-11-28-delete-group.md T5; criteria 40–47, as
// amended by A2.8, A2.11 and A3): the options card's Delete row, the confirm dialog, every refusal,
// and the deleted state. Runs on native and web (lesson 2026-11-19). lib/groups.ts is mocked at its
// exported functions (its mapping is lib/groups.test.ts's); the copy is lib's, imported, so a test
// can't pass on a string the screen built itself.
import { router as appRouter } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import type { ReactElement } from 'react';
import { AccessibilityInfo, AppState, Modal, Platform, StyleSheet, Text, type AppStateStatus } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';

import { clearGroupDeletedNotice, takeGroupDeletedNotice } from '@/lib/groupDeletedNotice';
import type { GroupError, GroupResult, GroupSnapshot } from '@/lib/groups';
import * as groups from '@/lib/groups';
import { DELETE_GROUP_COPY, deleteRowText, GROUP_SCREEN_COPY } from '@/lib/groupScreenText';
import { supabase as realSupabase } from '@/lib/supabase';
import { colors } from '@/lib/theme';
import { waitBill } from '@/test-utils/deleteGroupFixtures';
import { fakeSession, type FakeSupabase } from '@/test-utils/fakes';
import { ANA, BEN, W1 } from '@/test-utils/groupFixtures';
import { FINGERPRINT, GROUP_ID, GROUP_NAME, snapshotOf } from '@/test-utils/groupSnapshotFixtures';

jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});
jest.mock('@/lib/groups', () => {
  const actual = jest.requireActual<typeof import('@/lib/groups')>('@/lib/groups');
  return {
    ...actual,
    fetchGroupSnapshot: jest.fn(),
    renameGroup: jest.fn(),
    setGroupHidden: jest.fn(),
    leaveGroup: jest.fn(),
    setNotPart: jest.fn(),
    deleteGroup: jest.fn(),
  };
});

const supabase = realSupabase as unknown as FakeSupabase;
const fetchSnapshot = groups.fetchGroupSnapshot as jest.MockedFunction<typeof groups.fetchGroupSnapshot>;
const rename = groups.renameGroup as jest.MockedFunction<typeof groups.renameGroup>;
const setHidden = groups.setGroupHidden as jest.MockedFunction<typeof groups.setGroupHidden>;
const leave = groups.leaveGroup as jest.MockedFunction<typeof groups.leaveGroup>;
const setNotPart = groups.setNotPart as jest.MockedFunction<typeof groups.setNotPart>;
const del = groups.deleteGroup as jest.MockedFunction<typeof groups.deleteGroup>;

type SnapResult = Awaited<ReturnType<typeof groups.fetchGroupSnapshot>>;
const ok = (snapshot: GroupSnapshot): SnapResult => ({ ok: true, snapshot });
const fail = (error: GroupError): { ok: false; error: GroupError } => ({ ok: false, error });
const done: GroupResult = { ok: true };

const FP2 = 'fedcba9876543210fedcba9876543210';
const TITLE = `Delete "${GROUP_NAME}" for everyone?`;

/** Ana and Ben, nothing owed: an Airbnb Ana paid, split evenly, and Ben's payment back. */
function settled(fingerprint = FINGERPRINT): GroupSnapshot {
  return snapshotOf(
    {
      members: [ANA, BEN],
      bills: [],
      expenses: [
        {
          id: 'e5000000-0000-4000-8000-000000000001',
          payerId: ANA,
          amountCents: 1000,
          shares: [
            { userId: ANA, cents: 500 },
            { userId: BEN, cents: 500 },
          ],
        },
      ],
      payments: [{ from: BEN, to: ANA, cents: 500 }],
    },
    { members: [ANA, BEN], moneyFingerprint: fingerprint },
  );
}
const SETTLED_BODY = "Its 1 expense and payment history will be removed for both members. This can't be undone.";

/** Ana and Ben, settled, but a receipt with an unclaimed row (contract W2). */
function waiting(): GroupSnapshot {
  return snapshotOf({ members: [ANA, BEN], bills: [waitBill('W2', 'proportional')], expenses: [], payments: [] }, { members: [ANA, BEN] });
}

let snapshotReply: () => Promise<SnapResult>;
const replyWith = (s: GroupSnapshot) => {
  snapshotReply = async () => ok(s);
};

function signInAs(userId: string) {
  const session = fakeSession('Ana');
  supabase.__setInitialSession({ ...session, user: { ...session.user, id: userId } });
}

function HomeStandIn() {
  return <Text>Home stand-in</Text>;
}
const ROUTES = { appDir: './app', overrides: { '(app)/(tabs)/index': HomeStandIn } };

/** The AppState listener useGroupSnapshot registers: calling it with 'active' refetches. */
let appStateListeners: ((s: AppStateStatus) => void)[] = [];
const comeBack = async () => {
  await act(async () => {
    for (const l of appStateListeners) l('active');
  });
};

async function openGroup(path = `/groups/${GROUP_ID}`) {
  const router = renderRouter(ROUTES, { initialUrl: path });
  await screen.findByRole('button', { name: 'Settle up' });
  return router;
}
const press = async (el: ReactTestInstance) => {
  await act(async () => {
    fireEvent.press(el);
  });
};
const openOptions = () => press(screen.getByRole('button', { name: 'Group options' }));
const deleteRow = () => screen.getByRole('button', { name: DELETE_GROUP_COPY.row });
const dialogShown = () => screen.UNSAFE_getByType(Modal).props.visible === true;
/** The dialog's own buttons (the row behind it has the same name). */
const dialogButton = (name: string) => {
  const modal = screen.UNSAFE_getByType(Modal);
  const found = screen.getAllByRole('button', { name }).filter((b) => isInside(b, modal));
  if (found.length !== 1) throw new Error(`${found.length} dialog buttons named ${name}`);
  return found[0]!;
};
function isInside(node: ReactTestInstance, root: ReactTestInstance): boolean {
  for (let n: ReactTestInstance | null = node; n; n = n.parent) if (n === root) return true;
  return false;
}
async function openDialog() {
  await openOptions();
  await press(deleteRow());
  expect(dialogShown()).toBe(true);
}

beforeEach(() => {
  jest.clearAllMocks();
  clearGroupDeletedNotice();
  signInAs(ANA);
  replyWith(settled());
  fetchSnapshot.mockImplementation(() => snapshotReply());
  rename.mockResolvedValue(done);
  setHidden.mockResolvedValue(done);
  leave.mockResolvedValue(done);
  setNotPart.mockResolvedValue(done);
  del.mockResolvedValue(done);
  jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
  appStateListeners = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    appStateListeners.push(listener as (s: AppStateStatus) => void);
    return { remove: () => {} };
  });
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe.each(['ios', 'web'] as const)('Delete group (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  describe('the row (criterion 40)', () => {
    it('is the last row of the options card, in the danger colour, enabled with "Asks first" when settled', async () => {
      await openGroup();
      await openOptions();
      const labels = screen.getAllByRole('button').map((b) => b.props.accessibilityLabel as string | undefined);
      const at = labels.indexOf(DELETE_GROUP_COPY.row);
      // The options rows in order, Delete last. Ana is part of a cost, so Leave isn't offered here.
      expect(labels.slice(at - 3, at + 1)).toEqual([
        GROUP_SCREEN_COPY.invite,
        GROUP_SCREEN_COPY.rename,
        GROUP_SCREEN_COPY.hide,
        DELETE_GROUP_COPY.row,
      ]);
      const row = deleteRow();
      expect(row.props.accessibilityHint).toBe('Asks first');
      expect(row.props.accessibilityState).toMatchObject({ disabled: false });
      const title = screen.getByText(DELETE_GROUP_COPY.row);
      expect(StyleSheet.flatten(title.props.style).color).toBe(colors.light.danger);
    });

    it.each([
      ['not settled (W1)', () => snapshotOf(W1.input), DELETE_GROUP_COPY.notSettledCaption],
      ['a receipt waiting', waiting, DELETE_GROUP_COPY.waitingCaption],
    ])('%s: disabled, the reason as visible text and in its label, and pressing does nothing', async (_name, make, caption) => {
      replyWith(make());
      await openGroup();
      await openOptions();
      expect(screen.getByText(caption)).toBeTruthy();
      const row = screen.getByRole('button', { name: `Delete group, unavailable. ${caption}` });
      expect(row.props.accessibilityState).toMatchObject({ disabled: true });
      expect(row.props.accessibilityHint).toBeUndefined();
      await press(row);
      expect(dialogShown()).toBe(false);
      expect(del).not.toHaveBeenCalled();
    });
  });

  describe('the dialog (criterion 41)', () => {
    it('shows the title with the group name, the body, and Delete group / Cancel', async () => {
      await openGroup();
      await openDialog();
      expect(screen.getByRole('header', { name: TITLE })).toBeTruthy();
      expect(screen.getByText(SETTLED_BODY)).toBeTruthy();
      expect(dialogButton(DELETE_GROUP_COPY.confirm)).toBeTruthy();
      expect(dialogButton(DELETE_GROUP_COPY.cancel)).toBeTruthy();
    });

    it.each([
      ['Cancel', () => press(dialogButton(DELETE_GROUP_COPY.cancel))],
      ['Android back / web Escape', async () => act(() => screen.UNSAFE_getByType(Modal).props.onRequestClose())],
      ['a tap on the scrim', () => press(screen.getByTestId('confirm-dialog-scrim', { includeHiddenElements: true }))],
    ])('%s closes it with no call', async (_how, close) => {
      await openGroup();
      await openDialog();
      await close();
      expect(dialogShown()).toBe(false);
      expect(del).not.toHaveBeenCalled();
    });

    it('while the call is in flight, Cancel is disabled and nothing else closes it', async () => {
      let resolve: (r: GroupResult) => void = () => {};
      del.mockImplementation(() => new Promise((r) => (resolve = r)));
      await openGroup();
      await openDialog();
      await press(dialogButton(DELETE_GROUP_COPY.confirm));
      expect(dialogButton(DELETE_GROUP_COPY.confirm).props.accessibilityState).toMatchObject({ busy: true });
      expect(dialogButton(DELETE_GROUP_COPY.cancel).props.accessibilityState).toMatchObject({ disabled: true });
      await press(dialogButton(DELETE_GROUP_COPY.cancel));
      act(() => screen.UNSAFE_getByType(Modal).props.onRequestClose());
      await press(screen.getByTestId('confirm-dialog-scrim', { includeHiddenElements: true }));
      expect(dialogShown()).toBe(true);
      await act(async () => resolve(fail('network')));
      expect(dialogShown()).toBe(true);
    });
  });

  describe('confirming (criteria 42, 43)', () => {
    it('two taps in one tick send one call; then the notice is left for Home and it goes Home once', async () => {
      const replace = jest.spyOn(appRouter, 'replace');
      const router = await openGroup();
      await openDialog();
      const confirm = dialogButton(DELETE_GROUP_COPY.confirm);
      await act(async () => {
        fireEvent.press(confirm);
        fireEvent.press(confirm);
      });
      expect(del).toHaveBeenCalledTimes(1);
      expect(del).toHaveBeenCalledWith(GROUP_ID, FINGERPRINT);
      expect(await screen.findByText('Home stand-in')).toBeTruthy();
      expect(router.getPathname()).toBe('/');
      expect(replace).toHaveBeenCalledTimes(1);
      expect(replace).toHaveBeenCalledWith('/');
      // The notice is for this account, with the group's name.
      expect(takeGroupDeletedNotice(BEN)).toBeNull();
      expect(takeGroupDeletedNotice(ANA)).toEqual({ name: GROUP_NAME });
    });

    it('sends the fingerprint of the snapshot on screen at the tap, after a refetch landed', async () => {
      await openGroup();
      await openDialog();
      replyWith(settled(FP2));
      const before = fetchSnapshot.mock.calls.length;
      await comeBack();
      await waitFor(() => expect(fetchSnapshot.mock.calls.length).toBe(before + 1));
      expect(dialogShown()).toBe(true);
      await press(dialogButton(DELETE_GROUP_COPY.confirm));
      expect(del).toHaveBeenCalledWith(GROUP_ID, FP2);
    });
  });

  describe('a race while the dialog is open (criterion 44)', () => {
    it('(a) a refetch that makes deleting not ok closes the dialog, and the row shows why', async () => {
      await openGroup();
      await openDialog();
      replyWith(snapshotOf(W1.input));
      await comeBack();
      await waitFor(() => expect(dialogShown()).toBe(false));
      expect(screen.getByText(DELETE_GROUP_COPY.notSettledCaption)).toBeTruthy();
      expect(del).not.toHaveBeenCalled();
    });

    it.each([
      ['group_changed', DELETE_GROUP_COPY.changed],
      ['receipts_waiting', DELETE_GROUP_COPY.receiptsWaiting],
    ] as const)(
      '(b) %s: the dialog closes, its words show under the options card, a refetch starts, no navigation',
      async (error, text) => {
        del.mockResolvedValue(fail(error));
        const router = await openGroup();
        await openDialog();
        const before = fetchSnapshot.mock.calls.length;
        await press(dialogButton(DELETE_GROUP_COPY.confirm));
        expect(dialogShown()).toBe(false);
        expect(await screen.findByText(text)).toBeTruthy();
        expect(screen.getByText(text).props.accessibilityRole).toBe('alert');
        expect(fetchSnapshot.mock.calls.length).toBe(before + 1);
        // Still on the group, the row still there (the refetch here still says settled).
        expect(deleteRow()).toBeTruthy();
        expect(router.getPathname()).toBe(`/groups/${GROUP_ID}`);
        expect(takeGroupDeletedNotice(ANA)).toBeNull();
      },
    );

    it('(b) receipts_waiting, then the refetch shows the waiting receipt: the reason shows once, as the row caption', async () => {
      del.mockResolvedValue(fail('receipts_waiting'));
      await openGroup();
      await openDialog();
      replyWith(waiting());
      await press(dialogButton(DELETE_GROUP_COPY.confirm));
      await screen.findByRole('button', { name: `Delete group, unavailable. ${DELETE_GROUP_COPY.waitingCaption}` });
      expect(screen.getAllByText(DELETE_GROUP_COPY.waitingCaption)).toHaveLength(1);
    });

    it('review R5: C6 stays through its own refetch, and clears once a newer snapshot lands', async () => {
      del.mockResolvedValue(fail('group_changed'));
      await openGroup();
      await openDialog();
      let resolveSnap: (r: SnapResult) => void = () => {};
      snapshotReply = () => new Promise((r) => (resolveSnap = r));
      await press(dialogButton(DELETE_GROUP_COPY.confirm));
      expect(screen.getByText(DELETE_GROUP_COPY.changed)).toBeTruthy();
      // The refusal's own refetch lands: the line still explains why the dialog closed.
      await act(async () => resolveSnap(ok(settled(FP2))));
      await waitFor(() => expect(fetchSnapshot).toHaveBeenCalledTimes(2));
      expect(screen.getByText(DELETE_GROUP_COPY.changed)).toBeTruthy();
      // A later refetch (the app comes back) lands newer data: the line no longer applies.
      replyWith(settled(FP2));
      await comeBack();
      await waitFor(() => expect(screen.queryByText(DELETE_GROUP_COPY.changed)).toBeNull());
      // Positive control: still the group's options card, with the Delete row.
      expect(deleteRow()).toBeTruthy();
    });
  });

  describe('failures (criterion 45, A2.11, A3)', () => {
    it.each([
      ['network', DELETE_GROUP_COPY.networkError],
      ['busy', groups.GROUP_ERROR_COPY.busy],
    ] as const)(
      '%s: the dialog stays open with its words and Delete enabled; a retry sends the current fingerprint',
      async (error, text) => {
        del.mockResolvedValueOnce(fail(error));
        const router = await openGroup();
        await openDialog();
        await press(dialogButton(DELETE_GROUP_COPY.confirm));
        expect(dialogShown()).toBe(true);
        expect(screen.getByText(text).props.accessibilityRole).toBe('alert');
        expect(dialogButton(DELETE_GROUP_COPY.confirm).props.accessibilityState).toMatchObject({ disabled: false, busy: false });
        expect(router.getPathname()).toBe(`/groups/${GROUP_ID}`);
        if (os === 'ios') expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(text);
        // Retry, after a refetch with a new fingerprint landed.
        replyWith(settled(FP2));
        await comeBack();
        await waitFor(() => expect(screen.getByText(SETTLED_BODY)).toBeTruthy());
        await press(dialogButton(DELETE_GROUP_COPY.confirm));
        expect(del).toHaveBeenLastCalledWith(GROUP_ID, FP2);
        expect(await screen.findByText('Home stand-in')).toBeTruthy();
      },
    );

    it('a thrown call reads as a network failure, with no unhandled rejection', async () => {
      del.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '40P01' }));
      await openGroup();
      await openDialog();
      await press(dialogButton(DELETE_GROUP_COPY.confirm));
      expect(screen.getByText(DELETE_GROUP_COPY.networkError)).toBeTruthy();
      expect(dialogButton(DELETE_GROUP_COPY.confirm).props.accessibilityState).toMatchObject({ disabled: false });
    });

    it('not_allowed (a retry after a delete that went through): the dialog closes and the screen shows C8, no error line, no second call', async () => {
      del.mockResolvedValueOnce(fail('network')).mockResolvedValueOnce(fail('not_allowed'));
      const router = await openGroup();
      await openDialog();
      await press(dialogButton(DELETE_GROUP_COPY.confirm));
      await press(dialogButton(DELETE_GROUP_COPY.confirm));
      expect(await screen.findByRole('header', { name: DELETE_GROUP_COPY.deletedHeading })).toBeTruthy();
      expect(del).toHaveBeenCalledTimes(2);
      expect(screen.queryByText(DELETE_GROUP_COPY.networkError)).toBeNull();
      expect(screen.queryByText(groups.GROUP_ERROR_COPY.not_allowed)).toBeNull();
      expect(screen.queryByText(GROUP_NAME)).toBeNull();
      expect(screen.queryByText(TITLE)).toBeNull();
      await press(screen.getByRole('button', { name: DELETE_GROUP_COPY.goHome }));
      await waitFor(() => expect(router.getPathname()).toBe('/'));
      expect(del).toHaveBeenCalledTimes(2);
    });
  });

  describe('the deleted state (criteria 46, 47; A1.1)', () => {
    it('a refetch that finds the group gone shows C8 with nothing about the group; Go home replaces with Home', async () => {
      const router = await openGroup();
      expect(screen.getAllByText(GROUP_NAME).length).toBeGreaterThan(0);
      snapshotReply = async () => fail('not_allowed');
      await comeBack();
      expect(await screen.findByRole('header', { name: DELETE_GROUP_COPY.deletedHeading })).toBeTruthy();
      expect(screen.queryByText(GROUP_NAME)).toBeNull();
      expect(screen.queryByText(/\$/)).toBeNull();
      expect(screen.queryByText('Ben')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Settle up' })).toBeNull();
      await press(screen.getByRole('button', { name: DELETE_GROUP_COPY.goHome }));
      await waitFor(() => expect(router.getPathname()).toBe('/'));
    });

    it('Rename answered not_allowed shows its words and refetches; the refetch then gives C8', async () => {
      rename.mockResolvedValue(fail('not_allowed'));
      await openGroup();
      await openOptions();
      await press(screen.getByRole('button', { name: GROUP_SCREEN_COPY.rename }));
      fireEvent.changeText(screen.getByLabelText(GROUP_SCREEN_COPY.renameField), 'Tahoe 2027');
      let resolveSnap: (r: SnapResult) => void = () => {};
      snapshotReply = () => new Promise((r) => (resolveSnap = r));
      const before = fetchSnapshot.mock.calls.length;
      await press(screen.getByRole('button', { name: GROUP_SCREEN_COPY.save }));
      expect(screen.getByText(groups.GROUP_ERROR_COPY.not_allowed)).toBeTruthy();
      expect(fetchSnapshot.mock.calls.length).toBe(before + 1);
      await act(async () => resolveSnap(fail('not_allowed')));
      expect(await screen.findByRole('header', { name: DELETE_GROUP_COPY.deletedHeading })).toBeTruthy();
    });

    it('A1.1: opened from an Activity feed line (?from=feed) after the group was deleted, the first load shows C8', async () => {
      snapshotReply = async () => fail('not_allowed');
      renderRouter(ROUTES, { initialUrl: `/groups/${GROUP_ID}?from=feed` });
      expect(await screen.findByRole('header', { name: DELETE_GROUP_COPY.deletedHeading })).toBeTruthy();
      expect(screen.queryByText(GROUP_SCREEN_COPY.notMember)).toBeNull();
    });

    it.each([`/groups/${GROUP_ID}`, `/groups/${GROUP_ID}?from=elsewhere`])(
      'a first load refused at %s keeps the not-a-member words',
      async (url) => {
        snapshotReply = async () => fail('not_allowed');
        renderRouter(ROUTES, { initialUrl: url });
        expect(await screen.findByText(GROUP_SCREEN_COPY.notMember)).toBeTruthy();
        expect(screen.queryByText(DELETE_GROUP_COPY.deletedHeading)).toBeNull();
      },
    );
  });

  describe('busy on every write (A3.3): the words show, the control is released, nothing navigates', () => {
    const BUSY = groups.GROUP_ERROR_COPY.busy;

    it('rename', async () => {
      rename.mockResolvedValue(fail('busy'));
      const router = await openGroup();
      await openOptions();
      await press(screen.getByRole('button', { name: GROUP_SCREEN_COPY.rename }));
      fireEvent.changeText(screen.getByLabelText(GROUP_SCREEN_COPY.renameField), 'Tahoe 2027');
      await press(screen.getByRole('button', { name: GROUP_SCREEN_COPY.save }));
      expect(screen.getByText(BUSY)).toBeTruthy();
      expect(screen.getByRole('button', { name: GROUP_SCREEN_COPY.save }).props.accessibilityState).toMatchObject({ disabled: false });
      expect(screen.getByLabelText(GROUP_SCREEN_COPY.renameField).props.value).toBe('Tahoe 2027');
      expect(router.getPathname()).toBe(`/groups/${GROUP_ID}`);
    });

    it('hide', async () => {
      setHidden.mockResolvedValue(fail('busy'));
      const router = await openGroup();
      await openOptions();
      await press(screen.getByRole('button', { name: GROUP_SCREEN_COPY.hide }));
      expect(screen.getByText(BUSY)).toBeTruthy();
      expect(screen.getByRole('button', { name: GROUP_SCREEN_COPY.hide })).toBeTruthy();
      expect(router.getPathname()).toBe(`/groups/${GROUP_ID}`);
    });

    it('unhide', async () => {
      replyWith({ ...settled(), me: { ...settled().me, hidden: true } });
      setHidden.mockResolvedValue(fail('busy'));
      const router = await openGroup();
      await press(screen.getByRole('button', { name: GROUP_SCREEN_COPY.unhide }));
      expect(screen.getByText(BUSY)).toBeTruthy();
      expect(screen.getByRole('button', { name: GROUP_SCREEN_COPY.unhide }).props.accessibilityState?.busy).toBeFalsy();
      expect(router.getPathname()).toBe(`/groups/${GROUP_ID}`);
    });

    it('leave', async () => {
      // Two members with no costs: Ana may leave.
      replyWith(snapshotOf({ members: [ANA, BEN], bills: [], expenses: [], payments: [] }, { members: [ANA, BEN] }));
      leave.mockResolvedValue(fail('busy'));
      const router = await openGroup();
      await openOptions();
      await press(screen.getByRole('button', { name: GROUP_SCREEN_COPY.leave }));
      const confirm = screen.getAllByRole('button', { name: GROUP_SCREEN_COPY.leave }).at(-1)!;
      await press(confirm);
      expect(screen.getByText(BUSY)).toBeTruthy();
      expect(screen.getAllByRole('button', { name: GROUP_SCREEN_COPY.leave }).at(-1)!.props.accessibilityState).toMatchObject({
        disabled: false,
      });
      expect(router.getPathname()).toBe(`/groups/${GROUP_ID}`);
    });

    it("I wasn't part of this", async () => {
      // Ben has nothing claimed on the waiting receipt, so it waits on him.
      signInAs(BEN);
      replyWith(waiting());
      setNotPart.mockResolvedValue(fail('busy'));
      const router = await openGroup();
      await press(screen.getByRole('button', { name: "I wasn't part of this" }));
      expect(await screen.findByText(BUSY)).toBeTruthy();
      expect(screen.getByRole('button', { name: "I wasn't part of this" }).props.accessibilityState?.busy).toBeFalsy();
      expect(router.getPathname()).toBe(`/groups/${GROUP_ID}`);
    });
  });
});

describe('the Delete row on web carries its state as aria-* (criterion 40)', () => {
  type Make = (React: typeof import('react')) => ReactElement;
  /** The opening tag labelled `label` in the react-native-web markup (as __tests__/groupAriaWeb.test.tsx). */
  function webTag(make: Make, label: string): string {
    let html = '';
    jest.isolateModules(() => {
      jest.doMock('react-native', () => jest.requireActual('react-native-web'));
      const React = jest.requireActual<typeof import('react')>('react');
      // @types/react-dom isn't installed; this is the one function used.
      const { renderToStaticMarkup } = jest.requireActual<{ renderToStaticMarkup: (el: ReactElement) => string }>('react-dom/server');
      html = renderToStaticMarkup(make(React));
    });
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, '&#x27;');
    const found = html.match(new RegExp(`<[a-z]+ [^>]*aria-label="${escaped}"[^>]*>`, 'g')) ?? [];
    if (found.length !== 1) throw new Error(`${found.length} tags labelled ${label} in ${html}`);
    return found[0] ?? '';
  }
  const row = () => jest.requireActual<typeof import('@/components/DeleteGroupRow')>('@/components/DeleteGroupRow');

  it('disabled: aria-disabled="true" on the button, with the reason in its label', () => {
    const text = deleteRowText({ ok: false, reason: 'not_settled' });
    const tag = webTag((React) => React.createElement(row().DeleteGroupRow, { text, onPress: () => {} }), text.a11yLabel);
    expect(tag).toContain('role="button"');
    expect(tag).toContain('aria-disabled="true"');
  });

  it('enabled: no aria-disabled', () => {
    const text = deleteRowText({ ok: true });
    const tag = webTag((React) => React.createElement(row().DeleteGroupRow, { text, onPress: () => {} }), text.a11yLabel);
    expect(tag).toContain('role="button"');
    expect(tag).not.toContain('aria-disabled');
  });
});
