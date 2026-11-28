// The group screen: where you stand in the group, the one way to settle up, the receipts that
// don't count yet, and every cost. Spec: docs/specs/2026-11-26-groups-mvp.md T14, as amended by A1
// (S9 waiting lines link to the bill, S15 "Add, then Receipt", turned on by T17) and decisions GR-M7.
//
// Rules this screen keeps:
// - Every status, amount and line comes from lib/groupView.ts's groupScreen (one source per screen;
//   lesson 2026-11-25). The screen does no money math and builds no strings (lib/groupScreenText.ts).
// - Data: one group_snapshot read, refetched on focus, on return to the app and after each write
//   (lib/useGroupSnapshot.ts). A write keeps its control busy until the refetch after it has
//   finished. A failed refetch re-enables everything and says "Couldn't refresh. Try again." with a
//   retry, shown only while the data on screen is still the old data (lessons 2026-11-24/25).
// - Each write is guarded by a ref, so a double tap sends one call. A failed save keeps what was
//   typed. Renaming to the same name sends nothing.
// - Group options are an inline card under the title, not a modal; Leave asks inline.
// - All state lives under a key of the group id and the viewer, so nothing carries over to another
//   group or another account. The screen navigates only when the person taps something (or leaves).
// - Receipt (T17, GR-6): stores this group in lib/scanSession, then opens Scan. The bill form
//   attaches the new bill. Whenever this screen is shown again, or closes, the receipt flow was
//   left, so the stored group is cleared (it never follows the person to a bill started from Home).
// - Group claim status (docs/specs/2026-11-27-group-claim-status.md T5): receipts that wait on me
//   come first in "Not in balances yet", tinted, with "I wasn't part of this" (or Undo once I've
//   said so). That write goes through runWrite like the others; its busy state and error are kept
//   per bill, so only the tapped link spins and its error shows under that row. A refused write
//   (e.g. has_claims) also refetches, since the screen's data was out of date. It never changes money.
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import Ellipsis from 'lucide-react-native/icons/ellipsis';
import Plus from 'lucide-react-native/icons/plus';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Centered, Loading } from '@/components/Centered';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DeleteGroupRow } from '@/components/DeleteGroupRow';
import { GroupCostRow } from '@/components/GroupCostRow';
import { GroupDeletedState } from '@/components/GroupDeletedState';
import { GroupInvite } from '@/components/GroupInvite';
import { GroupWaitingRow } from '@/components/GroupWaitingRow';
import { BackHeader } from '@/components/ui/BackHeader';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { ListRow } from '@/components/ui/ListRow';
import { MoneyText } from '@/components/ui/MoneyText';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { StatusLine } from '@/components/ui/StatusLine';
import { TextField } from '@/components/ui/TextField';
import { TextLink } from '@/components/ui/TextLink';
import { useSession } from '@/lib/auth';
import { markFeedSeen } from '@/lib/feedSeen';
import { setGroupDeletedNotice } from '@/lib/groupDeletedNotice';
import {
  deleteGroup,
  GROUP_ERROR_COPY,
  groupNameProblem,
  leaveGroup,
  renameGroup,
  setGroupHidden,
  setNotPart,
  type GroupError,
  type GroupResult,
  type GroupSnapshot,
} from '@/lib/groups';
import {
  GROUP_SCREEN_COPY as COPY,
  DELETE_GROUP_COPY,
  deleteConfirmText,
  deleteConfirmTitle,
  deleteRefusal,
  deleteRowText,
  groupNameOf,
  leaveConfirmText,
  memberCountText,
  renameChanges,
  statusParts,
  waitingCaption,
} from '@/lib/groupScreenText';
import { groupScreen, keepOrder, type CostRow } from '@/lib/groupView';
import { clearScanGroup, setScanGroup } from '@/lib/scanSession';
import { backToTabs } from '@/lib/tabsNav';
import { layout, space, type, useTheme } from '@/lib/theme';
import { useGroupSnapshot } from '@/lib/useGroupSnapshot';

export default function GroupRoute() {
  const params = useLocalSearchParams<{ id?: string | string[]; invite?: string | string[]; from?: string | string[] }>();
  const id = typeof params.id === 'string' ? params.id : '';
  // T13's new-group flow lands here with `?invite=1`; any other value is ignored (allow-list).
  const openInvite = params.invite === '1';
  // Delete group A1.1: an Activity feed line opens the group with `?from=feed`, which means the viewer
  // was a member when that line loaded, so a refusal here means the group is gone (C8). Allow-listed.
  const fromFeed = params.from === 'feed';
  const { session } = useSession();
  const myId = session?.user.id ?? '';
  // A new group or a new account is a new screen: no panel, error or typed name carries over.
  return <GroupScreen key={`${id}:${myId}`} id={id} myId={myId} openInvite={openInvite} fromFeed={fromFeed} />;
}

function GroupScreen({ id, myId, openInvite, fromFeed }: { id: string; myId: string; openInvite: boolean; fromFeed: boolean }) {
  const router = useRouter();
  const { colors } = useTheme();
  const { load, version, finished, refetch } = useGroupSnapshot(id);
  // Delete group A2.11: a delete answered "not allowed" was a retry after a delete that went through
  // (or someone else deleted it first): the group is gone. Sticky for this screen.
  const [gone, setGone] = useState(false);
  const markGone = useCallback(() => setGone(true), []);
  // Back here (or gone) means the receipt flow started from here was left (T17, GR-6).
  useFocusEffect(useCallback(() => clearScanGroup(), []));
  useEffect(() => () => clearScanGroup(), []);
  // Activity's "opened this group" time (tab-bar spec Contract S, Task 9, criterion 53): once per
  // focus, after a snapshot newer than the one on screen at focus loads ready; never after a failed load.
  const versionNow = useRef(version);
  versionNow.current = version;
  const feedSeenAfter = useRef<number | null>(null);
  useFocusEffect(
    useCallback(() => {
      feedSeenAfter.current = versionNow.current;
      return () => {
        feedSeenAfter.current = null;
      };
    }, []),
  );
  useEffect(() => {
    const after = feedSeenAfter.current;
    if (load.status !== 'ready' || after === null || version <= after) return;
    feedSeenAfter.current = null;
    void markFeedSeen(myId, 'group', id);
  }, [load.status, version, myId, id]);
  // Home (tab-bar spec Task 5, criterion 33): back to the tab this was opened from (Groups, Activity or Tabs).
  const toHome = useCallback(() => backToTabs(router), [router]);
  const back = { label: COPY.back, accessibilityLabel: COPY.back, accessibilityHint: COPY.backHint, onPress: toHome };

  // Delete group C8 (criterion 46): the group is gone. Nothing about it is shown.
  if (gone || load.status === 'deleted' || (fromFeed && load.status === 'not_allowed')) {
    return <GroupDeletedState header={<BackHeader title="Group" back={back} />} />;
  }
  if (load.status === 'loading') {
    return (
      <>
        <BackHeader title="Group" back={back} />
        <Loading />
      </>
    );
  }
  if (load.status === 'not_allowed') {
    return (
      <Centered>
        <BackHeader title="Group" back={back} />
        <Text style={[type.body, styles.centerText, { color: colors.text }]}>{COPY.notMember}</Text>
        <Button label={COPY.goHome} variant="primary" onPress={() => router.replace('/')} />
      </Centered>
    );
  }
  if (load.status === 'error') {
    return (
      <Centered>
        <BackHeader title="Group" back={back} />
        <Text style={[type.body, styles.centerText, { color: colors.text }]}>{COPY.loadError}</Text>
        <Button label={COPY.tryAgain} variant="primary" onPress={() => refetch()} />
      </Centered>
    );
  }
  return (
    <GroupView
      id={id}
      myId={myId}
      openInvite={openInvite}
      snapshot={load.snapshot}
      version={version}
      finished={finished}
      refetch={refetch}
      back={back}
      onGone={markGone}
    />
  );
}

type Panel = 'none' | 'options' | 'rename' | 'leave';
type WriteKind = 'rename' | 'hide' | 'unhide' | 'leave' | 'notPart' | 'delete';
/**
 * A write in flight; `waitFor` is the refetch that must finish before the control is released.
 * `billId` is set for a not-part write, so only that bill's link shows busy.
 */
type Busy = { kind: WriteKind; waitFor: number | null; billId: string | null };
/**
 * The error of the last failed write, shown where that control is (under that bill's row for not-part).
 * `until` (not-part only, review R1): the snapshot version after which it no longer applies. A
 * snapshot newer than the refusal's own refetch (or, for network, newer than the one on screen)
 * may have changed what it said, so it clears.
 */
type ActionError = { kind: WriteKind; error: GroupError; billId: string | null; until: number | null };
type WriteOptions = {
  /** Run instead of the refetch (Leave: there's nothing left to refetch). */
  afterOk?: () => void;
  billId?: string;
  /** A refusal other than `network` means the screen's data is old: refetch (without holding the control). */
  refetchOnRefusal?: boolean;
  /** Handles a refusal itself instead of the inline error (Delete: its dialog decides, deleteRefusal). */
  onRefusal?: (error: GroupError) => void;
};

type ViewProps = {
  id: string;
  myId: string;
  openInvite: boolean;
  snapshot: GroupSnapshot;
  version: number;
  finished: number;
  refetch: () => number;
  back: { label: string; accessibilityLabel: string; accessibilityHint: string; onPress: () => void };
  /** The group turned out to be gone (a delete answered not_allowed): show C8. */
  onGone: () => void;
};

function GroupView({ id, myId, openInvite, snapshot, version, finished, refetch, back, onGone }: ViewProps) {
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const scroll = useRef<ScrollView>(null);

  const nameOf = useMemo(() => groupNameOf(snapshot.members, myId), [snapshot, myId]);
  const model = useMemo(() => groupScreen(snapshot, myId, nameOf), [snapshot, myId, nameOf]);
  // Review R4: the waiting rows keep the order of the screen's last showing, so "I wasn't part of
  // this" doesn't move the row away from the person who tapped it. Each time the screen comes back
  // into focus, the next snapshot sets the order again (needs-me first, GCS-9).
  const [waitingOrder, setWaitingOrder] = useState<string[] | null>(null);
  const reorder = useRef(true);
  const focusedOnce = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focusedOnce.current) reorder.current = true;
      focusedOnce.current = true;
    }, []),
  );
  useEffect(() => {
    if (!reorder.current) return;
    reorder.current = false;
    setWaitingOrder(model.waiting.map((w) => w.billId));
    // version: a refetch that lands with the same data is still "the next snapshot".
  }, [model, version]);
  const waiting = useMemo(() => keepOrder(model.waiting, waitingOrder), [model.waiting, waitingOrder]);
  const status = statusParts(model.status);
  const hidden = snapshot.me.hidden;

  const [panel, setPanel] = useState<Panel>('none');
  const [addOpen, setAddOpen] = useState(false);
  const [inviteShown, setInviteShown] = useState(openInvite);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [actionError, setActionError] = useState<ActionError | null>(null);
  /** The `version` that was on screen when a refetch after a write failed; the line shows while it still is. */
  const [refreshFailedAt, setRefreshFailedAt] = useState<number | null>(null);
  // Delete group (docs/specs/2026-11-28-delete-group.md T5): the options card's last row opens a
  // confirm dialog, the one exception to this screen's inline confirms (DG-1, the user's request).
  const [deleteOpen, setDeleteOpen] = useState(false);
  /** C5 or the busy copy, under the dialog's buttons; the dialog stays open. */
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /**
   * C6 / C7 under the options card after the dialog closed on a refusal. `until`: the refusal's own
   * refetch; a snapshot newer than that no longer matches what the line said, so it clears (review R5,
   * as the not-part errors).
   */
  const [deleteNote, setDeleteNote] = useState<{ text: string; until: number } | null>(null);
  const deleteRowRef = useRef<View>(null);
  /** The fingerprint of the snapshot on screen when Delete is tapped (criterion 43). */
  const fingerprint = useRef(snapshot.moneyFingerprint);
  fingerprint.current = snapshot.moneyFingerprint;

  const writing = useRef(false);
  /** The snapshot version on screen, for a not-part error raised without a refetch (review R1). */
  const shownVersion = useRef(version);
  shownVersion.current = version;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The refetch after a write has ended: release the control. If it failed, say so (with a retry)
  // instead of leaving the button busy or silently showing the old data.
  useEffect(() => {
    if (busy === null || busy.waitFor === null || finished < busy.waitFor) return;
    if (version < busy.waitFor) setRefreshFailedAt(version);
    if (busy.kind === 'rename') setPanel('none');
    if (busy.kind === 'hide') setPanel('none');
    if (busy.kind === 'notPart' && version >= busy.waitFor && Platform.OS === 'ios') {
      // The row's caption is a polite live region (Android, web); VoiceOver needs telling.
      const line = model.waiting.find((w) => w.billId === busy.billId);
      const said = line === undefined ? null : waitingCaption(line);
      if (said !== null) AccessibilityInfo.announceForAccessibility(said);
    }
    writing.current = false;
    setBusy(null);
  }, [busy, finished, version, model]);

  const runWrite = useCallback(
    async (kind: WriteKind, call: () => Promise<GroupResult>, opts: WriteOptions = {}) => {
      if (writing.current) return;
      writing.current = true;
      const billId = opts.billId ?? null;
      setBusy({ kind, waitFor: null, billId });
      setActionError(null);
      let res: GroupResult;
      try {
        res = await call();
      } catch {
        // The wrappers never throw (spec delete-group A3.3); if one ever did, it reads as a network failure.
        res = { ok: false, error: 'network' };
      }
      if (!mounted.current) return;
      if (!res.ok) {
        writing.current = false;
        setBusy(null);
        if (opts.onRefusal) {
          opts.onRefusal(res.error);
          return;
        }
        // Delete group A2.9: not_allowed can mean the group is gone; the refetch then shows C8.
        const refetched = (opts.refetchOnRefusal && res.error !== 'network') || res.error === 'not_allowed' ? refetch() : null;
        const until = kind === 'notPart' ? (refetched ?? shownVersion.current) : null;
        setActionError({ kind, error: res.error, billId, until });
        return;
      }
      if (opts.afterOk) {
        // Leaving: there's nothing left to refetch (we're no longer a member).
        writing.current = false;
        setBusy(null);
        opts.afterOk();
        return;
      }
      setBusy({ kind, waitFor: refetch(), billId });
    },
    [refetch],
  );

  // Review R1: a not-part error clears once a snapshot newer than the one it was raised against lands.
  useEffect(() => {
    if (actionError?.until != null && version > actionError.until) setActionError(null);
  }, [version, actionError]);

  const retryRefresh = () => {
    setRefreshFailedAt(null);
    refetch();
  };
  const showRefreshFailed = refreshFailedAt !== null && refreshFailedAt === version && busy === null;

  // Delete. The dialog shows only while deleting is still allowed: a refetch that makes it not ok
  // (someone added an expense) closes it, unless the call is already in flight (criterion 44a).
  const deleteText = deleteRowText(model.canDelete);
  const deleting = busy?.kind === 'delete';
  const deleteShown = deleteOpen && (model.canDelete.ok || deleting);
  useEffect(() => {
    if (deleteOpen && !model.canDelete.ok && busy?.kind !== 'delete') {
      setDeleteOpen(false);
      setDeleteError(null);
    }
  }, [deleteOpen, model.canDelete.ok, busy]);
  // C7 is the disabled row's own caption (C2a): once the refetch shows the row disabled for that
  // reason, the line under the card would only repeat it.
  const shownDeleteNote = deleteNote !== null && deleteNote.text !== deleteText.caption ? deleteNote.text : null;
  useEffect(() => {
    // VoiceOver ignores the alert role; Android and web read StatusLine's.
    if (deleteNote !== null && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(deleteNote.text);
  }, [deleteNote]);
  useEffect(() => {
    if (deleteNote !== null && version > deleteNote.until) setDeleteNote(null);
  }, [version, deleteNote]);

  const openDelete = () => {
    if (writing.current || !model.canDelete.ok) return;
    setActionError(null);
    setDeleteNote(null);
    setDeleteError(null);
    setDeleteOpen(true);
  };
  const cancelDelete = () => {
    if (writing.current) return;
    setDeleteOpen(false);
    setDeleteError(null);
  };
  const confirmDelete = () => {
    if (writing.current) return;
    const name = model.name;
    setDeleteError(null);
    void runWrite('delete', () => deleteGroup(id, fingerprint.current), {
      afterOk: () => {
        // The screen is going away: nothing else may start (one navigation, criterion 42).
        writing.current = true;
        setGroupDeletedNotice({ name, userId: myId });
        router.replace('/');
      },
      onRefusal: (error) => {
        const refusal = deleteRefusal(error);
        if (refusal.kind === 'stay') {
          setDeleteError(refusal.text);
          return;
        }
        setDeleteOpen(false);
        setDeleteError(null);
        if (refusal.kind === 'gone') {
          onGone();
          return;
        }
        setDeleteNote({ text: refusal.text, until: refetch() });
      },
    });
  };

  const toggleOptions = () => {
    setActionError(null);
    setDeleteNote(null);
    setNameError(null);
    setPanel((p) => (p === 'none' ? 'options' : 'none'));
    scroll.current?.scrollTo({ y: 0, animated: false });
  };
  const startRename = () => {
    setName(model.name);
    setNameError(null);
    setActionError(null);
    setPanel('rename');
  };
  const saveName = () => {
    if (writing.current) return;
    if (!renameChanges(model.name, name)) {
      // Nothing changed: no write, no Activity line.
      setPanel('none');
      return;
    }
    if (groupNameProblem(name) !== null) {
      setNameError(GROUP_ERROR_COPY.invalid_name);
      return;
    }
    setNameError(null);
    void runWrite('rename', () => renameGroup(id, name));
  };
  const hide = () => void runWrite('hide', () => setGroupHidden(id, true));
  const unhide = () => void runWrite('unhide', () => setGroupHidden(id, false));
  const leave = () => void runWrite('leave', () => leaveGroup(id), { afterOk: () => router.replace('/') });
  const markNotPart = (billId: string, notPart: boolean) =>
    void runWrite('notPart', () => setNotPart(billId, notPart), { billId, refetchOnRefusal: true });

  // Leave's confirm shows only while leaving is still offered: a refetch that makes the viewer part
  // of a cost takes it away (unless the DB already said why, which stays on screen).
  const shownPanel: Panel =
    panel === 'leave' && !model.canLeave && busy?.kind !== 'leave' && actionError?.kind !== 'leave' ? 'options' : panel;
  const errorFor = (...kinds: WriteKind[]) => (actionError && kinds.includes(actionError.kind) ? GROUP_ERROR_COPY[actionError.error] : null);
  const isBusy = (kind: WriteKind) => busy?.kind === kind;
  const notPartBusy = (billId: string) => busy?.kind === 'notPart' && busy.billId === billId;
  const notPartError = (billId: string) =>
    actionError?.kind === 'notPart' && actionError.billId === billId ? GROUP_ERROR_COPY[actionError.error] : null;

  const openCost = (row: CostRow): (() => void) | undefined => {
    if (row.billId !== null) {
      const billId = row.billId;
      return () => router.push(`/bills/${billId}`);
    }
    // C-G9: only an expense's creator or payer can edit it, so only they get a way in.
    const expense = snapshot.expenses.find((e) => e.id === row.id);
    if (!expense || (expense.createdBy !== myId && expense.payerId !== myId)) return undefined;
    return () => router.push({ pathname: '/groups/[id]/expense', params: { id, expense: row.id } });
  };

  return (
    <>
      <BackHeader
        title={model.name}
        back={back}
        right={
          <IconButton
            icon={Ellipsis}
            accessibilityLabel={COPY.options}
            accessibilityHint={panel === 'none' ? COPY.optionsHintClosed : COPY.optionsHintOpen}
            expanded={panel !== 'none'}
            onPress={toggleOptions}
          />
        }
      />
      <ScrollView
        ref={scroll}
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xl }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.column}>
          <View style={styles.titleBlock}>
            <Text accessibilityRole="header" style={[type.title, { color: colors.text }]}>
              {model.name}
            </Text>
            <Text style={[type.caption, { color: colors.textMuted }]}>{memberCountText(model.memberCount)}</Text>
            {hidden ? (
              <View style={styles.hiddenLine}>
                <Text accessibilityLiveRegion="polite" style={[type.caption, styles.flex, { color: colors.textMuted }]}>
                  {COPY.hidden}
                </Text>
                <TextLink label={COPY.unhide} accessibilityHint={COPY.unhideHint} onPress={unhide} loading={isBusy('unhide')} />
              </View>
            ) : null}
            {errorFor('unhide') ? <StatusLine text={errorFor('unhide') ?? ''} tone="error" alert /> : null}
          </View>

          {shownPanel === 'options' ? (
            <View style={styles.section}>
              <Card flush>
                <ListRow
                  title={COPY.invite}
                  accessibilityLabel={COPY.invite}
                  accessibilityHint={COPY.inviteHint}
                  onPress={() => {
                    setInviteShown(true);
                    setPanel('none');
                  }}
                />
                <ListRow title={COPY.rename} accessibilityLabel={COPY.rename} onPress={startRename} divider />
                {hidden ? null : (
                  <ListRow title={COPY.hide} accessibilityLabel={COPY.hide} accessibilityHint={COPY.hideHint} onPress={hide} divider />
                )}
                {model.canLeave ? (
                  <ListRow
                    title={COPY.leave}
                    accessibilityLabel={COPY.leave}
                    accessibilityHint={COPY.leaveHint}
                    onPress={() => {
                      setActionError(null);
                      setPanel('leave');
                    }}
                    divider
                  />
                ) : null}
                <DeleteGroupRow ref={deleteRowRef} text={deleteText} onPress={openDelete} />
              </Card>
              {errorFor('hide') ? <StatusLine text={errorFor('hide') ?? ''} tone="error" alert /> : null}
              {shownDeleteNote !== null ? <StatusLine text={shownDeleteNote} tone="error" alert /> : null}
            </View>
          ) : null}

          <ConfirmDialog
            visible={deleteShown}
            title={deleteConfirmTitle(model.name)}
            body={deleteConfirmText(snapshot)}
            confirmLabel={DELETE_GROUP_COPY.confirm}
            confirmVariant="danger"
            cancelLabel={DELETE_GROUP_COPY.cancel}
            onConfirm={confirmDelete}
            onCancel={cancelDelete}
            busy={deleting}
            error={deleteError}
            returnFocusTo={deleteRowRef}
          />


          {shownPanel === 'rename' ? (
            <Card>
              <TextField
                label={COPY.renameField}
                showLabel
                value={name}
                onChangeText={(t) => {
                  setName(t);
                  setNameError(null);
                }}
                error={nameError ?? undefined}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={saveName}
                editable={!isBusy('rename')}
              />
              {errorFor('rename') ? <StatusLine text={errorFor('rename') ?? ''} tone="error" alert /> : null}
              <View style={styles.buttons}>
                <Button label={COPY.save} variant="secondary" onPress={saveName} loading={isBusy('rename')} />
                <Button label={COPY.cancel} variant="ghost" onPress={() => setPanel('none')} disabled={isBusy('rename')} />
              </View>
            </Card>
          ) : null}

          {shownPanel === 'leave' ? (
            <Card>
              <Text style={[type.body, { color: colors.text }]}>{leaveConfirmText(model.name)}</Text>
              {errorFor('leave', 'hide') ? <StatusLine text={errorFor('leave', 'hide') ?? ''} tone="error" alert /> : null}
              <View style={styles.buttons}>
                {actionError?.kind === 'leave' && actionError.error === 'cannot_leave' ? (
                  // The DB knows more than the snapshot (deleted expenses, undone payments): offer Hide.
                  hidden ? null : <Button label={COPY.hide} variant="secondary" accessibilityHint={COPY.hideHint} onPress={hide} loading={isBusy('hide')} />
                ) : (
                  <Button label={COPY.leaveConfirmButton} variant="danger" accessibilityLabel={COPY.leave} onPress={leave} loading={isBusy('leave')} />
                )}
                <Button label={COPY.cancel} variant="ghost" onPress={() => setPanel('none')} disabled={busy !== null} />
              </View>
            </Card>
          ) : null}


          {inviteShown ? (
            <View style={styles.section}>
              {/* A new link changes the snapshot's join code: refetch so the screen and panel agree. */}
              <GroupInvite groupId={id} joinCode={snapshot.group.joinCode} groupName={model.name} onRotated={() => refetch()} />
              <TextLink label={COPY.inviteClose} onPress={() => setInviteShown(false)} />
            </View>
          ) : null}

          {showRefreshFailed ? (
            <View style={styles.refreshLine}>
              <StatusLine text={COPY.refreshFailed} tone="error" alert style={styles.flex} />
              <TextLink label={COPY.tryAgain} accessibilityLabel={COPY.tryAgain} onPress={retryRefresh} />
            </View>
          ) : null}

          <View style={styles.statusBlock}>
            <View accessible accessibilityLabel={model.status.text}>
              {status.amountCents === null ? (
                <Text style={[type.title, { color: colors.text }]}>{status.lead}</Text>
              ) : (
                <>
                  <Text style={[type.body, { color: colors.textMuted }]}>{status.lead}</Text>
                  <MoneyText cents={status.amountCents} size="display" style={model.status.kind === 'owed' ? { color: colors.success } : undefined} />
                </>
              )}
            </View>
            <Button
              label={COPY.settleUp}
              variant="primary"
              block
              accessibilityHint={COPY.settleUpHint}
              onPress={() => router.push({ pathname: '/groups/[id]/settle', params: { id } })}
            />
          </View>

          {waiting.length > 0 ? (
            <View style={styles.section}>
              <SectionHeader title={COPY.waitingHeader} />
              {/* GCS-16: one card per bill (GroupWaitingRow), stacked with the section's gap, so each
                  "I wasn't part of this" / Undo link sits inside its own bill's edges. */}
              {waiting.map((w) => (
                <GroupWaitingRow
                  key={w.billId}
                  line={w}
                  onOpen={() => router.push(`/bills/${w.billId}`)}
                  onNotPart={(notPart) => markNotPart(w.billId, notPart)}
                  busy={notPartBusy(w.billId)}
                  error={notPartError(w.billId)}
                />
              ))}
            </View>
          ) : null}

          <View style={styles.section}>
            <View style={styles.costsHeader}>
              <SectionHeader title={COPY.costs} />
              <TextLink
                label={COPY.add}
                icon={Plus}
                accessibilityLabel={COPY.addA11y}
                accessibilityHint={addOpen ? COPY.addHintOpen : COPY.addHintClosed}
                accessibilityState={{ expanded: addOpen }}
                onPress={() => setAddOpen((o) => !o)}
              />
            </View>
            {addOpen ? (
              <Card flush>
                <ListRow
                  title={COPY.expenseChoice}
                  caption={COPY.expenseChoiceCaption}
                  trailing={<Icon icon={ChevronRight} color={colors.textMuted} />}
                  accessibilityRole="link"
                  accessibilityLabel={COPY.expenseChoiceA11y}
                  accessibilityHint={COPY.expenseChoiceHint}
                  onPress={() => {
                    setAddOpen(false);
                    router.push({ pathname: '/groups/[id]/expense', params: { id } });
                  }}
                />
                <ListRow
                  title={COPY.receiptChoice}
                  caption={COPY.receiptChoiceCaption}
                  trailing={<Icon icon={ChevronRight} color={colors.textMuted} />}
                  accessibilityRole="link"
                  accessibilityLabel={COPY.receiptChoiceA11y}
                  accessibilityHint={COPY.receiptChoiceHint}
                  onPress={() => {
                    setAddOpen(false);
                    setScanGroup({ groupId: id, name: model.name });
                    router.push('/scan');
                  }}
                  divider
                />
              </Card>
            ) : null}
            {model.costs.length === 0 ? (
              <Text style={[type.body, { color: colors.textMuted }]}>{COPY.noCosts}</Text>
            ) : (
              <Card flush>
                {model.costs.map((row, i) => (
                  <GroupCostRow key={`${row.kind}:${row.id}`} row={row} onPress={openCost(row)} divider={i > 0} />
                ))}
              </Card>
            )}
          </View>

          <Card flush>
            <ListRow
              title={COPY.activity}
              trailing={<Icon icon={ChevronRight} color={colors.textMuted} />}
              accessibilityRole="link"
              accessibilityLabel={COPY.activity}
              accessibilityHint={COPY.activityHint}
              onPress={() => router.push({ pathname: '/groups/[id]/activity', params: { id } })}
            />
          </Card>
        </View>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space.lg, paddingTop: space.md },
  column: { width: '100%', maxWidth: layout.content, alignSelf: 'center', gap: space.xl },
  titleBlock: { gap: space.xs },
  statusBlock: { gap: space.lg },
  section: { gap: space.sm },
  costsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
  hiddenLine: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  refreshLine: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  flex: { flex: 1 },
  centerText: { textAlign: 'center', maxWidth: layout.message },
});
