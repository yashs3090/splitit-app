// The item detail sheet: who pays what for one unit row, and the only way to split it differently.
// Spec: docs/specs/2026-11-20-m1b-m2-share-and-claim.md (Task 11, "Claim screen UX"; A1.2, A2.3).
//
// Any current claimer can set every claimer's parts (1–20). The preview runs the real split math
// (lib/billView.ts splitPreview); this component does no money arithmetic. Saving and resetting are
// handed to the screen, which applies them optimistically and calls set_item_split.
// A claimable discount row (spec 2026-11-24-claimable-discounts, Task 7) uses the same sheet: its
// preview runs splitPreview with kind 'discount', so the pieces are negative.
//
// A group bill (spec 2026-11-26-groups-mvp, T18) passes `assign`: the sheet then adds "Who had
// this?" (components/AssignChips.tsx), offers "Split differently" to any member, and saves both
// through assign_item itself (lib/useAssignItem.ts), waiting for the screen's refetch. Without
// `assign` the sheet is exactly the non-group sheet: no chips, the stepper only for claimers, and
// saves handed to the screen through onSave.
import Minus from 'lucide-react-native/icons/minus';
import Plus from 'lucide-react-native/icons/plus';
import { useState } from 'react';
import { AccessibilityInfo, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AssignChips, chipsFor } from '@/components/AssignChips';
import { Avatar, type AvatarPerson } from '@/components/Avatars';
import { Banner, BannerText } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { MoneyText } from '@/components/ui/MoneyText';
import { MAX_PARTS, MIN_PARTS, partsLabel, splitPreview, stepParts } from '@/lib/billView';
import { ASSIGN_COPY, toggleAssignee } from '@/lib/itemAssign';
import { formatCents } from '@/lib/money';
import type { RowKind } from '@/lib/split';
import { SPLIT_KEY, useAssignItem, type AssignSource } from '@/lib/useAssignItem';
import { layout, radius, space, TOUCH_TARGET, type, useTheme } from '@/lib/theme';

export type SheetClaimer = { person: AvatarPerson; cents: number; parts: number };

/** A group bill's item: who may be assigned, and the screen's refetch (useBill's numbering). */
export type SheetAssign = AssignSource & {
  /** Every group member (the viewer has `isMe`). */
  members: readonly AvatarPerson[];
};

type Props = {
  /** Visible name, e.g. "Beer · 1 of 2". */
  label: string;
  priceCents: number;
  /** The row's status line ("Split 2 ways · $3.00 each", "Custom split · set by Hana", …). */
  status: string;
  /** Current claimers (the viewer first), with what each pays now. */
  claimers: readonly SheetClaimer[];
  /** The viewer is a current claimer, so they may change the split. */
  canEdit: boolean;
  /** Parts differ between claimers ("Reset to even" is offered). */
  custom: boolean;
  /** A split for this row is being saved. */
  saving: boolean;
  /** Fixed copy from the screen, or null. */
  error: string | null;
  /** Every current claimer's parts. */
  onSave: (parts: Record<string, number>) => void;
  onClose: () => void;
  /** 'discount' for a claimable discount row. Absent means an item. */
  kind?: RowKind;
  /**
   * Only on a group bill. `current` must be the server's claimer map for this row (no optimistic
   * claims): it is sent as assign_item's `p_expected`. Absent: the non-group sheet, unchanged.
   */
  assign?: SheetAssign;
};

const NOUN: Record<RowKind, 'item' | 'discount'> = { item: 'item', discount: 'discount' };
const RESET_HINT: Record<RowKind, string> = {
  item: 'Everyone on this item pays the same',
  discount: 'Everyone on this discount gets the same amount off',
};

export function ItemSheet(props: Props) {
  const { label, priceCents, status, claimers, custom, error, onClose, assign, kind = 'item' } = props;
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState<Record<string, number> | null>(null);
  const writes = useAssignItem(assign ?? null, (key, next) => {
    if (key === SPLIT_KEY) setDraft(null);
    if (Platform.OS === 'web' || assign === undefined) return;
    // The chip's new state, said once the refetch shows it (web reads the checkbox state change).
    const said = key === SPLIT_KEY ? ASSIGN_COPY.splitSaved : chipsFor(assign.members, next).find((c) => c.userId === key)?.a11yLabel;
    if (said !== undefined) AccessibilityInfo.announceForAccessibility(said);
  });
  // On a group bill any member may change the split (T18); otherwise only a claimer.
  const canEdit = assign !== undefined || props.canEdit;
  const saving = props.saving || writes.busy !== null;
  const editing = draft !== null && canEdit && claimers.length >= 2;

  // Who is on the row and with how many parts, as the next save starts from. On a group bill that is
  // the server's map (`assign.current`, sent as p_expected), never the `claimers` prop, which may hold
  // an optimistic or stale claim: a save then can't add or drop anyone by accident (review R2-S1).
  const base: Readonly<Record<string, number>> =
    assign !== undefined ? assign.current : Object.fromEntries(claimers.map((c) => [c.person.userId, c.parts]));
  // Exactly the current claimers: someone who joined while editing starts at their current parts.
  const draftParts = (): Record<string, number> =>
    Object.fromEntries(Object.entries(base).map(([userId, parts]) => [userId, draft?.[userId] ?? parts]));
  const preview = editing ? splitPreview(priceCents, draftParts(), kind) : null;
  // Saving the parts already in place would only log a no-op change: allow it once something differs.
  const changed = editing && Object.entries(base).some(([userId, parts]) => draftParts()[userId] !== parts);

  function save(parts: Record<string, number>) {
    if (assign !== undefined) {
      // Kept open until the refetch shows the saved split, so a failure keeps what was set.
      writes.send(SPLIT_KEY, parts);
      return;
    }
    setDraft(null);
    props.onSave(parts);
  }

  function toggle(userId: string) {
    if (assign === undefined) return;
    writes.send(userId, toggleAssignee(assign.current, userId));
  }

  const body = (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <View style={styles.titleLine}>
          <Text accessibilityRole="header" style={[type.title, styles.grow, { color: colors.text }]}>
            {label}
          </Text>
          <MoneyText cents={priceCents} size="title" />
        </View>
        <Text style={[type.caption, { color: colors.textMuted }]}>{status}</Text>
      </View>

      {assign !== undefined ? (
        <AssignChips
          members={assign.members}
          current={assign.current}
          busyId={writes.busy}
          disabled={writes.busy !== null}
          noun={NOUN[kind]}
          onToggle={toggle}
        />
      ) : null}

      {claimers.length === 0 ? (
        // A group bill's chips already show nobody had it.
        assign !== undefined ? null : (
          <Text style={[type.body, { color: colors.textMuted }]}>Nobody has claimed this yet.</Text>
        )
      ) : (
        <View style={styles.list}>
          {claimers.map((c) => {
            const userId = c.person.userId;
            const parts = editing ? draftParts()[userId] ?? c.parts : c.parts;
            const cents = preview?.[userId] ?? c.cents;
            return (
              <View key={userId} style={styles.person}>
                <View accessible accessibilityLabel={`${c.person.name} ${formatCents(cents)}`} style={styles.personInfo}>
                  <Avatar person={c.person} />
                  <Text numberOfLines={1} style={[type.body, styles.grow, { color: colors.text }]}>
                    {c.person.name}
                  </Text>
                </View>
                {editing ? (
                  <Stepper
                    name={c.person.name}
                    parts={parts}
                    // A group bill's split is being saved: hold the parts still until it lands.
                    locked={assign !== undefined && saving}
                    onStep={(delta) => setDraft({ ...draftParts(), [userId]: stepParts(parts, delta) })}
                  />
                ) : null}
                <MoneyText cents={cents} style={styles.amount} />
              </View>
            );
          })}
        </View>
      )}

      {error ? (
        <Banner tone="error" alert>
          <BannerText>{error}</BannerText>
        </Banner>
      ) : null}

      {writes.message ? (
        <View style={styles.message}>
          <Banner tone="error" alert>
            <BannerText>{writes.message.text}</BannerText>
          </Banner>
          {writes.message.retry ? (
            <Button
              label={ASSIGN_COPY.retry}
              variant="secondary"
              accessibilityHint={ASSIGN_COPY.retryHint}
              onPress={writes.retry}
              style={styles.retry}
            />
          ) : null}
        </View>
      ) : null}

      {editing ? (
        <View style={styles.actions}>
          <Button
            label="Save split"
            variant="primary"
            block
            loading={assign !== undefined ? writes.busy === SPLIT_KEY : saving}
            disabled={!changed || (assign !== undefined && saving)}
            accessibilityHint={changed ? undefined : 'Change someone\'s parts first'}
            onPress={() => save(draftParts())}
          />
          <Button label="Cancel" variant="ghost" block onPress={() => setDraft(null)} />
        </View>
      ) : (
        <View style={styles.actions}>
          {canEdit && claimers.length >= 2 ? (
            <View style={styles.links}>
              <Button
                label="Split differently"
                variant="ghost"
                disabled={saving}
                accessibilityHint="Choose how many parts each person pays"
                onPress={() => setDraft({})}
                flush
              />
              {custom ? (
                <Button
                  label="Reset to even"
                  variant="ghost"
                  disabled={saving}
                  accessibilityHint={RESET_HINT[kind]}
                  onPress={() => save(Object.fromEntries(Object.keys(base).map((userId) => [userId, MIN_PARTS])))}
                  flush
                />
              ) : null}
            </View>
          ) : null}
          {!canEdit && claimers.length > 0 ? (
            <Text style={[type.caption, { color: colors.textMuted }]}>{`Claim this ${NOUN[kind]} to change how it's split.`}</Text>
          ) : null}
          <Button label="Done" variant="secondary" block onPress={onClose} />
        </View>
      )}
    </ScrollView>
  );

  // iOS (proposal P6): the system page sheet. It slides up, dims what's behind, and the person can
  // swipe it down to close: RN reports that swipe through onRequestClose (allowSwipeDismissal).
  if (Platform.OS === 'ios') {
    return (
      <Modal
        visible
        presentationStyle="pageSheet"
        // No swipe-to-close while a split is being edited, so a swipe can't silently drop it.
        allowSwipeDismissal={!editing}
        animationType="slide"
        onRequestClose={onClose}
      >
        <View
          accessibilityViewIsModal
          style={[styles.pageSheet, { backgroundColor: colors.surface, paddingBottom: insets.bottom + space.lg }]}
        >
          {body}
        </View>
      </Modal>
    );
  }

  // Android and web: a bottom sheet over a scrim. Tapping the scrim or Android's back button closes it.
  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <View style={styles.backdropWrap}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={onClose}
          style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }]}
        />
        <View
          accessibilityViewIsModal
          style={[styles.sheet, { backgroundColor: colors.surface, paddingBottom: insets.bottom + space.lg }]}
        >
          {body}
        </View>
      </View>
    </Modal>
  );
}

function Stepper({
  name,
  parts,
  locked = false,
  onStep,
}: {
  name: string;
  parts: number;
  locked?: boolean;
  onStep: (delta: 1 | -1) => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.stepper}>
      <IconButton icon={Minus} accessibilityLabel={`Fewer parts for ${name}`} disabled={locked || parts <= MIN_PARTS} onPress={() => onStep(-1)} />
      <Text accessibilityLiveRegion="polite" style={[type.caption, styles.partsText, { color: colors.text }]}>
        {partsLabel(parts)}
      </Text>
      <IconButton icon={Plus} accessibilityLabel={`More parts for ${name}`} disabled={locked || parts >= MAX_PARTS} onPress={() => onStep(1)} />
    </View>
  );
}

const styles = StyleSheet.create({
  backdropWrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    width: '100%',
    maxWidth: layout.content,
    maxHeight: '85%',
    alignSelf: 'center',
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderCurve: 'continuous',
  },
  // The system draws the page sheet's shape; it just fills it.
  pageSheet: { flex: 1 },
  content: { padding: space.lg, gap: space.lg },
  header: { gap: space.xs },
  titleLine: { flexDirection: 'row', alignItems: 'baseline', gap: space.md },
  grow: { flex: 1, minWidth: 0 },
  list: { gap: space.md },
  person: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: TOUCH_TARGET },
  personInfo: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: space.sm },
  amount: { minWidth: 64, textAlign: 'right' },
  stepper: { flexDirection: 'row', alignItems: 'center' },
  partsText: { minWidth: 52, textAlign: 'center' },
  actions: { gap: space.sm },
  message: { gap: space.sm },
  retry: { alignSelf: 'flex-start' },
  links: { flexDirection: 'row', flexWrap: 'wrap', columnGap: space.lg },
});
