// The item detail sheet: who pays what for one unit row, and the only way to split it differently.
// Spec: docs/specs/2026-11-20-m1b-m2-share-and-claim.md (Task 11, "Claim screen UX"; A1.2, A2.3).
//
// Any current claimer can set every claimer's parts (1–20). The preview runs the real split math
// (lib/billView.ts splitPreview); this component does no money arithmetic. Saving and resetting are
// handed to the screen, which applies them optimistically and calls set_item_split.
// A claimable discount row (spec 2026-11-24-claimable-discounts, Task 7) uses the same sheet: its
// preview runs splitPreview with kind 'discount', so the pieces are negative.
import Minus from 'lucide-react-native/icons/minus';
import Plus from 'lucide-react-native/icons/plus';
import { useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar, type AvatarPerson } from '@/components/Avatars';
import { Banner, BannerText } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { MoneyText } from '@/components/ui/MoneyText';
import { MAX_PARTS, MIN_PARTS, partsLabel, splitPreview, stepParts } from '@/lib/billView';
import { formatCents } from '@/lib/money';
import type { RowKind } from '@/lib/split';
import { layout, radius, space, TOUCH_TARGET, type, useTheme } from '@/lib/theme';

export type SheetClaimer = { person: AvatarPerson; cents: number; parts: number };

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
};

const NOUN: Record<RowKind, string> = { item: 'item', discount: 'discount' };
const RESET_HINT: Record<RowKind, string> = {
  item: 'Everyone on this item pays the same',
  discount: 'Everyone on this discount gets the same amount off',
};

export function ItemSheet(props: Props) {
  const { label, priceCents, status, claimers, canEdit, custom, saving, error, onSave, onClose, kind = 'item' } = props;
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState<Record<string, number> | null>(null);
  const editing = draft !== null && canEdit && claimers.length >= 2;

  // Exactly the current claimers: someone who joined while editing starts at their current parts.
  const draftParts = (): Record<string, number> =>
    Object.fromEntries(claimers.map((c) => [c.person.userId, draft?.[c.person.userId] ?? c.parts]));
  const preview = editing ? splitPreview(priceCents, draftParts(), kind) : null;
  // Saving the parts already in place would only log a no-op change: allow it once something differs.
  const changed = editing && claimers.some((c) => draftParts()[c.person.userId] !== c.parts);

  function save(parts: Record<string, number>) {
    setDraft(null);
    onSave(parts);
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

      {claimers.length === 0 ? (
        <Text style={[type.body, { color: colors.textMuted }]}>Nobody has claimed this yet.</Text>
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

      {editing ? (
        <View style={styles.actions}>
          <Button
            label="Save split"
            variant="primary"
            block
            loading={saving}
            disabled={!changed}
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
                  onPress={() => save(Object.fromEntries(claimers.map((c) => [c.person.userId, MIN_PARTS])))}
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

function Stepper({ name, parts, onStep }: { name: string; parts: number; onStep: (delta: 1 | -1) => void }) {
  const { colors } = useTheme();
  return (
    <View style={styles.stepper}>
      <IconButton icon={Minus} accessibilityLabel={`Fewer parts for ${name}`} disabled={parts <= MIN_PARTS} onPress={() => onStep(-1)} />
      <Text accessibilityLiveRegion="polite" style={[type.caption, styles.partsText, { color: colors.text }]}>
        {partsLabel(parts)}
      </Text>
      <IconButton icon={Plus} accessibilityLabel={`More parts for ${name}`} disabled={parts >= MAX_PARTS} onPress={() => onStep(1)} />
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
  links: { flexDirection: 'row', flexWrap: 'wrap', columnGap: space.lg },
});
