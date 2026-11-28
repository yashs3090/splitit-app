// A bill and its group: the host moves a bill into one of their groups, or takes it out.
// Spec: docs/specs/2026-11-26-groups-mvp.md T17 (criteria 81, 83) as amended by A1 (S1b, A1.6).
//
// Rules this screen keeps:
// - Reads: the bill (lib/useBill), the host's groups (listMyGroups) and the bill's group
//   (fetchBillGroup). Picking a group reads that group's members (fetchGroupSnapshot) to check
//   everyone on the bill is in it; the check reruns when the screen is shown again (after inviting).
// - Words and the check come from lib/billGroup.ts; this file builds no strings and does no math.
// - "Invite Sam to Tahoe trip first." shows instead of the button while anyone on the bill isn't a
//   member. A bill with "I paid" marks that isn't fully claimed (or is all-$0) shows "Finish
//   claiming before moving it into the group." instead (A1 S1b, review R2-N1). With marks on a
//   complete bill, the conversion line names each marked person (U-G1).
// - The database decides (participants_not_members, not_complete, already_in_group,
//   has_bill_payments); its refusals show as fixed copy and keep the choice. A retry to the same
//   group is a no-op success (A1.6), so Try again after a lost reply is safe.
// - One write at a time (a ref). A failed write re-enables everything. Success goes back to the
//   bill, the only navigation the screen does on its own after a tap; it never redirects.
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Centered, Loading } from '@/components/Centered';
import { GroupChoiceRow } from '@/components/GroupChoiceRow';
import { BackHeader } from '@/components/ui/BackHeader';
import { Banner, BannerText } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { StatusLine } from '@/components/ui/StatusLine';
import { TextLink } from '@/components/ui/TextLink';
import { useSession } from '@/lib/auth';
import {
  attachButtonText,
  attachCheck,
  attachErrorText,
  BILL_GROUP_COPY as COPY,
  checkFailedText,
  checkingText,
  detachButtonText,
  detachErrorText,
  inGroupText,
  inviteHint,
  onlyHostCanMoveText,
  onlyHostCanTakeOutText,
  type BillGroupRef,
} from '@/lib/billGroup';
import { makeNameOf, splitInputFor } from '@/lib/billView';
import { BILL_ERROR_COPY, type BillData } from '@/lib/bills';
import {
  attachBillToGroup,
  detachBillFromGroup,
  fetchBillGroup,
  fetchGroupSnapshot,
  listMyGroups,
  type GroupError,
  type GroupSummary,
} from '@/lib/groups';
import { memberCountText } from '@/lib/groupScreenText';
import { layout, space, TOUCH_TARGET, type, useTheme } from '@/lib/theme';
import { allZero } from '@/lib/settle';
import { sharesComplete } from '@/lib/split';
import { useBill } from '@/lib/useBill';

export default function BillGroupRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const { session } = useSession();
  const myId = session?.user.id ?? '';
  // A new bill or account is a new screen: no choice or error carries over.
  return <BillGroupScreen key={`${id}:${myId}`} id={id} myId={myId} />;
}

type GroupsLoad =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'not_allowed' }
  | { status: 'ready'; groups: GroupSummary[]; current: BillGroupRef | null };

function BillGroupScreen({ id, myId }: { id: string; myId: string }) {
  const router = useRouter();
  const { colors } = useTheme();
  const { load, refetch: refetchBill } = useBill(id);
  const [groupsLoad, setGroupsLoad] = useState<GroupsLoad>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([listMyGroups(), fetchBillGroup(id)]).then(([groupsRes, billGroupRes]) => {
      if (!active) return;
      if (!billGroupRes.ok && billGroupRes.error === 'not_allowed') return setGroupsLoad({ status: 'not_allowed' });
      if (!groupsRes.ok || !billGroupRes.ok) {
        // A failed reload keeps what's on screen (the screen's own error says what went wrong).
        return setGroupsLoad((prev) => (prev.status === 'ready' ? prev : { status: 'error' }));
      }
      const g = billGroupRes.group;
      setGroupsLoad({ status: 'ready', groups: groupsRes.groups, current: g === null ? null : { groupId: g.groupId, name: g.name } });
    });
    return () => {
      active = false;
    };
  }, [id, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const retryAll = () => {
    setGroupsLoad({ status: 'loading' });
    refetchBill();
    reload();
  };

  // Back to the bill: pops to it when it's under this screen, otherwise opens it (cold deep link).
  const toBill = useCallback(() => router.dismissTo(`/bills/${id}`), [router, id]);
  const inGroup = groupsLoad.status === 'ready' && groupsLoad.current !== null;
  const header = (
    <BackHeader
      title={inGroup ? COPY.inGroupTitle : COPY.title}
      back={{ label: COPY.back, accessibilityLabel: COPY.back, accessibilityHint: COPY.backHint, onPress: toBill, disabled: busy }}
    />
  );

  if (load.status === 'not_found' || groupsLoad.status === 'not_allowed') {
    return (
      <Centered>
        {header}
        <Text accessibilityRole="alert" style={[type.body, styles.centerText, { color: colors.text }]}>
          {BILL_ERROR_COPY.not_found}
        </Text>
        <Button label={COPY.goHome} variant="primary" onPress={() => router.replace('/')} />
      </Centered>
    );
  }
  if (load.status === 'error' || groupsLoad.status === 'error') {
    return (
      <Centered>
        {header}
        <Text accessibilityRole="alert" style={[type.body, styles.centerText, { color: colors.text }]}>
          {load.status === 'error' ? COPY.billLoadError : COPY.loadError}
        </Text>
        <Button label={COPY.tryAgain} variant="primary" onPress={retryAll} />
      </Centered>
    );
  }
  if (load.status === 'loading' || groupsLoad.status === 'loading') {
    return (
      <>
        {header}
        <Loading />
      </>
    );
  }

  const props = { id, myId, data: load.data, busy, setBusy, toBill, reload, refetchBill };
  return (
    <>
      {header}
      {groupsLoad.current !== null ? (
        <InGroupView {...props} current={groupsLoad.current} />
      ) : (
        <AttachView {...props} groups={groupsLoad.groups} />
      )}
    </>
  );
}

type ViewProps = {
  id: string;
  myId: string;
  data: BillData;
  busy: boolean;
  setBusy: (b: boolean) => void;
  toBill: () => void;
  reload: () => void;
  refetchBill: () => number;
};

/** The write guard and mounted flag both views use. */
function useWrite(setBusy: (b: boolean) => void) {
  const writing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useCallback(
    async <R,>(call: () => Promise<R>): Promise<R | null> => {
      if (writing.current) return null;
      writing.current = true;
      setBusy(true);
      const res = await call();
      writing.current = false;
      if (!mounted.current) return null;
      setBusy(false);
      return res;
    },
    [setBusy],
  );
}

function Screen({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xl }]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.column}>{children}</View>
    </ScrollView>
  );
}

type Check =
  | { groupId: string; status: 'loading' }
  | { groupId: string; status: 'error' }
  | { groupId: string; status: 'ready'; memberIds: string[] };

function AttachView({ id, myId, data, busy, setBusy, toBill, reload, refetchBill, groups }: ViewProps & { groups: GroupSummary[] }) {
  const router = useRouter();
  const { colors } = useTheme();
  const nameOf = useMemo(() => makeNameOf(data.participants, myId), [data.participants, myId]);
  const isHost = data.bill.host_id === myId;
  // A1 S1b up front: whether the loaded bill is fully claimed and not all-$0 (lib's rules, the same
  // as the DB's). attach_bill_to_group still refuses with not_complete if this is out of date.
  const billState = useMemo(() => {
    const input = splitInputFor(data, data.claims);
    return { complete: sharesComplete(input).complete, allZero: allZero(input) };
  }, [data]);
  const only = groups.length === 1 ? groups[0] : undefined;
  const [selectedId, setSelectedId] = useState<string | null>(only?.id ?? null);
  const [check, setCheck] = useState<Check | null>(null);
  const [checkAttempt, setCheckAttempt] = useState(0);
  const [error, setError] = useState<{ groupId: string; error: GroupError } | null>(null);
  const write = useWrite(setBusy);

  const selected = groups.find((g) => g.id === selectedId) ?? null;

  // Who's in the chosen group. Only the newest answer for the chosen group is applied.
  useEffect(() => {
    if (selectedId === null || !isHost) return;
    let active = true;
    setCheck({ groupId: selectedId, status: 'loading' });
    void fetchGroupSnapshot(selectedId).then((res) => {
      if (!active) return;
      setCheck(
        res.ok
          ? { groupId: selectedId, status: 'ready', memberIds: res.snapshot.members.map((m) => m.userId) }
          : { groupId: selectedId, status: 'error' },
      );
    });
    return () => {
      active = false;
    };
  }, [selectedId, checkAttempt, isHost]);

  // Shown again (e.g. back from inviting someone to the group): check the members again.
  const shownBefore = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (shownBefore.current) setCheckAttempt((n) => n + 1);
      shownBefore.current = true;
    }, []),
  );

  const title = (
    <Text accessibilityRole="header" style={[type.title, { color: colors.text }]}>
      {COPY.title}
    </Text>
  );
  if (!isHost) {
    return (
      <Screen>
        <View style={styles.titleBlock}>
          {title}
          <Text style={[type.body, { color: colors.text }]}>{onlyHostCanMoveText(nameOf(data.bill.host_id))}</Text>
        </View>
      </Screen>
    );
  }
  if (groups.length === 0) {
    return (
      <Screen>
        <View style={styles.titleBlock}>
          {title}
          <Text style={[type.body, { color: colors.text }]}>{COPY.noGroups}</Text>
        </View>
        <Button
          label={COPY.startGroup}
          variant="secondary"
          accessibilityHint={COPY.startGroupHint}
          onPress={() => router.push('/groups/new')}
          style={styles.start}
        />
      </Screen>
    );
  }

  const current = check !== null && check.groupId === selectedId ? check : null;
  const result = current?.status === 'ready' && selected ? attachCheck(data.participants, current.memberIds, selected.name, nameOf, billState) : null;
  const shownError = error !== null && error.groupId === selectedId && selected ? attachErrorText(error.error, selected.name) : null;

  const pick = (groupId: string) => {
    if (busy) return;
    setError(null);
    setSelectedId(groupId);
  };

  const attach = async () => {
    if (!selected) return;
    const target = selected;
    setError(null);
    const res = await write(() => attachBillToGroup(id, target.id));
    if (res === null) return;
    if (res.ok) {
      toBill();
      return;
    }
    setError({ groupId: target.id, error: res.error });
    // The facts behind the refusal changed under the screen: read them again.
    if (res.error === 'participants_not_members') {
      refetchBill();
      setCheckAttempt((n) => n + 1);
    } else if (res.error === 'already_in_group') {
      reload();
    }
  };

  return (
    <Screen>
      <View style={styles.titleBlock}>
        {title}
        <Text style={[type.body, { color: colors.textMuted }]}>{COPY.intro}</Text>
      </View>

      <View style={styles.section}>
        <SectionHeader title={COPY.yourGroups} />
        <Card flush>
          <View accessibilityRole="radiogroup" accessibilityLabel={COPY.yourGroups}>
            {groups.map((g, i) => (
              <GroupChoiceRow
                key={g.id}
                name={g.name}
                caption={memberCountText(g.memberCount)}
                checked={g.id === selectedId}
                disabled={busy}
                divider={i > 0}
                onPick={() => pick(g.id)}
              />
            ))}
          </View>
        </Card>
      </View>

      {selected ? (
        <View style={styles.section}>
          {current?.status === 'loading' ? (
            <View style={styles.inline}>
              <ActivityIndicator size="small" color={colors.textMuted} />
              <Text accessibilityLiveRegion="polite" style={[type.caption, styles.flex, { color: colors.textMuted }]}>
                {checkingText(selected.name)}
              </Text>
            </View>
          ) : null}
          {current?.status === 'error' ? (
            <View style={styles.inline}>
              <StatusLine text={checkFailedText(selected.name)} tone="error" alert style={styles.flex} />
              <TextLink label={COPY.tryAgain} onPress={() => setCheckAttempt((n) => n + 1)} />
            </View>
          ) : null}
          {result?.kind === 'not_complete' ? (
            <Banner tone="warning">
              <BannerText>{result.text}</BannerText>
            </Banner>
          ) : null}
          {result?.kind === 'invite_first' ? (
            <Banner tone="warning">
              <BannerText>{result.text}</BannerText>
              <TextLink
                label={COPY.invitePeople}
                accessibilityHint={inviteHint(selected.name)}
                onPress={() => router.push({ pathname: '/groups/[id]', params: { id: selected.id, invite: '1' } })}
              />
            </Banner>
          ) : null}
          {result?.kind === 'ready' && result.conversion !== null ? (
            <Banner tone="info">
              <BannerText>{result.conversion}</BannerText>
            </Banner>
          ) : null}
          {shownError !== null ? <StatusLine text={shownError} tone="error" alert /> : null}
          {result?.kind === 'ready' ? (
            <Button
              label={attachButtonText(selected.name)}
              variant="primary"
              block
              loading={busy}
              accessibilityHint={COPY.intro}
              onPress={() => void attach()}
            />
          ) : null}
        </View>
      ) : null}
    </Screen>
  );
}

function InGroupView({ id, myId, data, busy, setBusy, toBill, current }: ViewProps & { current: BillGroupRef }) {
  const { colors } = useTheme();
  const nameOf = useMemo(() => makeNameOf(data.participants, myId), [data.participants, myId]);
  const isHost = data.bill.host_id === myId;
  const [error, setError] = useState<GroupError | null>(null);
  const write = useWrite(setBusy);

  const detach = async () => {
    setError(null);
    const res = await write(() => detachBillFromGroup(id));
    if (res === null) return;
    if (res.ok) toBill();
    else setError(res.error);
  };

  return (
    <Screen>
      <View style={styles.titleBlock}>
        <Text accessibilityRole="header" style={[type.title, { color: colors.text }]}>
          {inGroupText(current.name)}
        </Text>
        <Text style={[type.body, { color: colors.textMuted }]}>
          {isHost ? COPY.detachExplain : onlyHostCanTakeOutText(nameOf(data.bill.host_id), current.name)}
        </Text>
      </View>
      {isHost ? (
        <View style={styles.section}>
          {error !== null ? <StatusLine text={detachErrorText(error, current.name)} tone="error" alert /> : null}
          <Button
            label={detachButtonText(current.name)}
            variant="danger"
            block
            loading={busy}
            accessibilityHint={COPY.detachExplain}
            onPress={() => void detach()}
          />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space.lg, paddingTop: space.md },
  column: { width: '100%', maxWidth: layout.content, alignSelf: 'center', gap: space.xl },
  titleBlock: { gap: space.xs },
  section: { gap: space.md },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: TOUCH_TARGET },
  start: { alignSelf: 'flex-start' },
  flex: { flex: 1, minWidth: 0 },
  centerText: { textAlign: 'center', maxWidth: layout.message },
});
