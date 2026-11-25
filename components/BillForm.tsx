// One editable bill form for manual entry and for reviewing a scan.
// Spec: docs/specs/2026-11-20-m1a-scan-receipt.md (Task 6). Rendering only: every rule
// (validation, the totals check, copy) lives in lib/billDraft.ts. User and recognized text
// is shown only as a TextInput value or Text child; all other copy is fixed app copy.
//
// Layout: a scrolling column of cards (items, discounts, totals) and a sticky footer with the
// bill total, whether the numbers add up, and the screen's primary action.
//
// Controlled (M1b Task 9): the screen owns the draft (useReducer) so it can save it.
import { Fragment, useEffect, useRef, useState, type Dispatch, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react-native';
import CircleCheck from 'lucide-react-native/icons/circle-check';
import Ellipsis from 'lucide-react-native/icons/ellipsis';
import Plus from 'lucide-react-native/icons/plus';
import TriangleAlert from 'lucide-react-native/icons/triangle-alert';
import X from 'lucide-react-native/icons/x';
import { Platform, ScrollView, StyleSheet, Switch, Text, View, type TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Banner, BannerText } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { MoneyText } from '@/components/ui/MoneyText';
import { TipOptions } from '@/components/TipOptions';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { TextField } from '@/components/ui/TextField';
import { TextLink } from '@/components/ui/TextLink';
import {
  evaluateDraft,
  FIELD_ERROR_COPY,
  REASON_COPY,
  reasonCopy,
  setDiscountClaimable,
  tipCents,
  type BillDraft,
  type DraftAction,
  type DraftStatus,
  type FieldError,
  type TotalField,
} from '@/lib/billDraft';
import { formatCents } from '@/lib/money';
import { layout, radius, space, TOUCH_TARGET, type, useTheme } from '@/lib/theme';

const TOTAL_FIELDS: { field: TotalField; label: string }[] = [
  { field: 'subtotal', label: 'Subtotal' },
  { field: 'tax', label: 'Tax' },
  { field: 'fees', label: 'Fees' },
  { field: 'tip', label: 'Tip' },
  { field: 'total', label: 'Total' },
];

export const MISMATCH_BANNER = "These numbers don't add up. Check them against the receipt.";
export const FLAGGED_ROW_COPY = 'Check this quantity and price.';
/** Claimable discounts (docs/specs/2026-11-24-claimable-discounts.md, criterion 42). */
export const CLAIM_SWITCH_COPY = 'Claim like an item';
export const CLAIM_CAPTION_COPY = 'People claim this like an item and can share it.';
/** Same limit as the database's row names (1–100 characters, C1). */
const LABEL_MAX_LENGTH = 100;

const QTY_WIDTH = 56;
const PRICE_WIDTH = 108;
const TOTAL_FIELD_WIDTH = 160;

type Props = {
  draft: BillDraft;
  dispatch: Dispatch<DraftAction>;
  /** Rendered above the cards (the screen title). */
  header?: ReactNode;
  /** The screen's primary action, in the sticky footer under the bill total (thumb reach). */
  footerAction?: ReactNode;
  /** Small print in the sticky footer. */
  footerNote?: string;
  /** Rendered below the cards (secondary actions). */
  children?: ReactNode;
  /** The screen shows the native stack header, which already clears the status bar. */
  underHeader?: boolean;
};

export function BillForm({ draft, dispatch, header, footerAction, footerNote, children, underHeader = false }: Props) {
  const ev = evaluateDraft(draft);
  const errorFor = (key: string): FieldError | undefined => ev.errors[key];
  /** The error copy for a field, read by screen readers as the input's hint (the visible text sits under the row). */
  const errorHint = (key: string): string | undefined => {
    const e = errorFor(key);
    return e === undefined ? undefined : FIELD_ERROR_COPY[e];
  };
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  // Notes are opt-in: a row shows its note field once "+ Add note" is tapped, or while it has a note.
  const [openNotes, setOpenNotes] = useState<ReadonlySet<string>>(() => new Set());
  const noteShown = (item: BillDraft['items'][number]) => item.note !== '' || openNotes.has(item.id);
  const setNoteOpen = (id: string, open: boolean) =>
    setOpenNotes((prev) => {
      if (prev.has(id) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });

  // Tip chips show while there's no tip. A bill that opens with a tip keeps them folded behind
  // "Tip options" (or focusing the Tip field). Once shown they stay for the rest of the visit,
  // so picking a chip or typing a tip never makes them disappear under the user's finger.
  const [tipExpanded, setTipExpanded] = useState(false);
  const tipOptionsShown = tipExpanded || tipCents(draft) === 0;
  useEffect(() => {
    if (tipOptionsShown && !tipExpanded) setTipExpanded(true);
  }, [tipOptionsShown, tipExpanded]);

  // Return key moves to the next field, in reading order.
  const refs = useRef(new Map<string, TextInput | null>());
  const order: string[] = [
    ...draft.items.flatMap((i) => [`${i.id}.name`, `${i.id}.qty`, `${i.id}.price`, ...(noteShown(i) ? [`${i.id}.note`] : [])]),
    ...draft.discounts.flatMap((d) => [`${d.id}.label`, `${d.id}.amount`]),
    ...TOTAL_FIELDS.map((t) => `totals.${t.field}`),
  ];
  const fieldRef = (key: string) => (el: TextInput | null) => {
    refs.current.set(key, el);
  };
  const focus = (key: string | undefined) => {
    if (key !== undefined) refs.current.get(key)?.focus?.();
  };
  const nextProps = (key: string) => {
    const next = order[order.indexOf(key) + 1];
    return {
      returnKeyType: next === undefined ? ('done' as const) : ('next' as const),
      submitBehavior: next === undefined ? ('blurAndSubmit' as const) : ('submit' as const),
      onSubmitEditing: () => focus(next),
    };
  };

  // A row the user just added gets focus, so they can type straight away.
  const counts = useRef({ items: draft.items.length, discounts: draft.discounts.length });
  useEffect(() => {
    const prev = counts.current;
    const lastItem = draft.items[draft.items.length - 1];
    const lastDiscount = draft.discounts[draft.discounts.length - 1];
    if (draft.items.length === prev.items + 1 && lastItem) focus(`${lastItem.id}.name`);
    if (draft.discounts.length === prev.discounts + 1 && lastDiscount) focus(`${lastDiscount.id}.label`);
    counts.current = { items: draft.items.length, discounts: draft.discounts.length };
  }, [draft.items, draft.discounts]);

  // "+ Add note" focuses the note field once it has rendered.
  const pendingNoteFocus = useRef<string | null>(null);
  useEffect(() => {
    const id = pendingNoteFocus.current;
    if (id !== null && openNotes.has(id)) {
      pendingNoteFocus.current = null;
      focus(`${id}.note`);
    }
  }, [openNotes]);

  const hasMismatch = ev.mismatches.length > 0;
  const pill: Record<DraftStatus, { text: string; icon: LucideIcon; fg: string; bg: string }> = {
    has_errors: { text: 'Fix the highlighted fields', icon: TriangleAlert, fg: colors.danger, bg: colors.dangerSurface },
    mismatch: { text: "Doesn't add up", icon: TriangleAlert, fg: colors.danger, bg: colors.dangerSurface },
    incomplete: { text: 'Not checked yet', icon: Ellipsis, fg: colors.textMuted, bg: colors.surfaceMuted },
    adds_up: { text: 'Adds up', icon: CircleCheck, fg: colors.success, bg: colors.successSurface },
  };
  const status = pill[ev.status];
  const missingTotals = ev.missing.filter((r) => r !== 'no_items');

  return (
    <View style={[styles.flex, { backgroundColor: colors.background }]}>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[styles.scroll, { paddingTop: underHeader ? space.md : insets.top + space.xl }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <View style={styles.column}>
          {header}

          {/* Items */}
          <Card title="Items" aside={draft.items.length > 0 ? `${draft.items.length} ${draft.items.length === 1 ? 'line' : 'lines'}` : undefined}>
            {draft.items.length > 0 ? (
              <View style={styles.row} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                <Text style={[type.caption, styles.flex, { color: colors.textMuted }]}>Item</Text>
                <Text style={[type.caption, styles.colQty, styles.colHead, { color: colors.textMuted }]}>Qty</Text>
                <Text style={[type.caption, styles.colPrice, styles.colHead, { color: colors.textMuted }]}>Price</Text>
              </View>
            ) : null}
            {draft.items.map((item, index) => {
              const n = index + 1;
              const errors = (['name', 'qty', 'price'] as const)
                .map((f) => errorFor(`${item.id}.${f}`))
                .filter((e): e is FieldError => e !== undefined);
              return (
                <View key={item.id} style={[styles.itemRow, index > 0 && [styles.rowDivider, { borderTopColor: colors.divider }]]}>
                  <View style={styles.row}>
                    <TextField
                      ref={fieldRef(`${item.id}.name`)}
                      label={`Item ${n} name`}
                      placeholder="Item name"
                      value={item.name}
                      onChangeText={(name) => dispatch({ type: 'updateItem', id: item.id, patch: { name } })}
                      invalid={errorFor(`${item.id}.name`) !== undefined}
                      accessibilityHint={errorHint(`${item.id}.name`)}
                      autoCapitalize="words"
                      style={styles.flex}
                      {...nextProps(`${item.id}.name`)}
                    />
                    <TextField
                      ref={fieldRef(`${item.id}.qty`)}
                      label={`Item ${n} qty`}
                      placeholder="1"
                      keyboardType="number-pad"
                      numeric
                      maxLength={3}
                      value={item.qty}
                      onChangeText={(qty) => dispatch({ type: 'updateItem', id: item.id, patch: { qty } })}
                      invalid={errorFor(`${item.id}.qty`) !== undefined}
                      accessibilityHint={errorHint(`${item.id}.qty`)}
                      style={styles.colQty}
                      {...nextProps(`${item.id}.qty`)}
                    />
                    <TextField
                      ref={fieldRef(`${item.id}.price`)}
                      label={`Item ${n} price`}
                      placeholder="0.00"
                      prefix="$"
                      keyboardType="decimal-pad"
                      numeric
                      value={item.price}
                      onChangeText={(price) => dispatch({ type: 'updateItem', id: item.id, patch: { price } })}
                      invalid={errorFor(`${item.id}.price`) !== undefined}
                      accessibilityHint={errorHint(`${item.id}.price`)}
                      style={styles.colPrice}
                      {...nextProps(`${item.id}.price`)}
                    />
                  </View>
                  <View style={styles.row}>
                    {noteShown(item) ? (
                      <TextField
                        ref={fieldRef(`${item.id}.note`)}
                        label={`Item ${n} note`}
                        placeholder="Note, e.g. no onions"
                        subtle
                        value={item.note}
                        onChangeText={(note) => dispatch({ type: 'updateItem', id: item.id, patch: { note } })}
                        // An emptied note folds back into the "+ Add note" link when the field is left.
                        onBlur={() => {
                          if (item.note === '') setNoteOpen(item.id, false);
                        }}
                        style={styles.flex}
                        {...nextProps(`${item.id}.note`)}
                      />
                    ) : (
                      <View style={styles.flex}>
                        <TextLink
                          label="Add note"
                          icon={Plus}
                          accessibilityLabel={`Add note to item ${n}`}
                          accessibilityHint="Shows a note field, e.g. no onions."
                          onPress={() => {
                            pendingNoteFocus.current = item.id;
                            setNoteOpen(item.id, true);
                          }}
                        />
                      </View>
                    )}
                    <IconButton
                      icon={X}
                      tone="danger"
                      accessibilityLabel={`Delete item ${n}`}
                      onPress={() => dispatch({ type: 'removeItem', id: item.id })}
                    />
                  </View>
                  {item.flagged ? (
                    <View style={[styles.flag, { backgroundColor: colors.warningSurface }]}>
                      <Icon icon={TriangleAlert} size="sm" color={colors.warning} style={styles.flagIcon} />
                      <Text style={[type.caption, styles.flex, { color: colors.warning }]}>{FLAGGED_ROW_COPY}</Text>
                    </View>
                  ) : null}
                  {errors.map((e) => (
                    <Text key={e} accessibilityRole="alert" style={[type.caption, { color: colors.danger }]}>
                      {FIELD_ERROR_COPY[e]}
                    </Text>
                  ))}
                </View>
              );
            })}
            {ev.missing.includes('no_items') ? (
              <Text style={[type.body, styles.empty, { color: colors.textMuted }]}>{REASON_COPY.no_items}</Text>
            ) : null}
            <Button label="Add item" icon={Plus} variant="ghost" onPress={() => dispatch({ type: 'addItem' })} />
          </Card>

          {/* Discounts */}
          <Card title="Discounts" aside="Optional">
            {draft.discounts.length === 0 ? (
              <Text style={[type.caption, { color: colors.textMuted }]}>Coupons or promos printed on the receipt.</Text>
            ) : null}
            {draft.discounts.map((discount, index) => {
              const n = index + 1;
              const amountError = errorFor(`${discount.id}.amount`);
              return (
                <View key={discount.id} style={[styles.itemRow, index > 0 && [styles.rowDivider, { borderTopColor: colors.divider }]]}>
                  <View style={styles.row}>
                    <TextField
                      ref={fieldRef(`${discount.id}.label`)}
                      label={`Discount ${n} label`}
                      placeholder="e.g. Coupon"
                      maxLength={LABEL_MAX_LENGTH}
                      value={discount.label}
                      onChangeText={(label) => dispatch({ type: 'updateDiscount', id: discount.id, patch: { label } })}
                      style={styles.flex}
                      {...nextProps(`${discount.id}.label`)}
                    />
                    <TextField
                      ref={fieldRef(`${discount.id}.amount`)}
                      label={`Discount ${n} amount`}
                      placeholder="0.00"
                      prefix="−$"
                      keyboardType="decimal-pad"
                      numeric
                      value={discount.amount}
                      onChangeText={(amount) => dispatch({ type: 'updateDiscount', id: discount.id, patch: { amount } })}
                      invalid={amountError !== undefined}
                      accessibilityHint={amountError ? FIELD_ERROR_COPY[amountError] : undefined}
                      style={styles.colPrice}
                      {...nextProps(`${discount.id}.amount`)}
                    />
                  </View>
                  <View style={styles.row}>
                    <SegmentedControl
                      options={(['subtotal', 'total'] as const).map((appliesTo) => {
                        const text = appliesTo === 'subtotal' ? 'Before subtotal' : 'After subtotal';
                        return { value: appliesTo, label: text, accessibilityLabel: `Discount ${n} ${text.toLowerCase()}` };
                      })}
                      value={discount.appliesTo}
                      onChange={(appliesTo) => dispatch({ type: 'updateDiscount', id: discount.id, patch: { appliesTo } })}
                      stretch
                      checkSelected
                      style={styles.flex}
                    />
                    <IconButton
                      icon={X}
                      tone="danger"
                      accessibilityLabel={`Delete discount ${n}`}
                      onPress={() => dispatch({ type: 'removeDiscount', id: discount.id })}
                    />
                  </View>
                  {/* Split (off, the default) or claimed like an item (on). Moves no money in the form. */}
                  <View style={styles.switchRow}>
                    <Text
                      accessible={false}
                      importantForAccessibility="no"
                      suppressHighlighting
                      onPress={() => dispatch(setDiscountClaimable(discount.id, !discount.claimable))}
                      style={[type.body, styles.switchLabel, { color: colors.text }]}
                    >
                      {CLAIM_SWITCH_COPY}
                    </Text>
                    <Switch
                      accessibilityRole="switch"
                      accessibilityLabel={`Discount ${n}: claim like an item`}
                      accessibilityHint="When on, people claim this discount instead of splitting it across the bill."
                      accessibilityState={{ checked: discount.claimable }}
                      value={discount.claimable}
                      onValueChange={(claimable) => dispatch(setDiscountClaimable(discount.id, claimable))}
                      trackColor={{ false: colors.border, true: colors.primary }}
                      // iOS keeps its native white thumb; Android and web get a thumb that contrasts with both tracks (>= 3:1).
                      thumbColor={Platform.OS === 'ios' ? undefined : colors.surface}
                      ios_backgroundColor={colors.border}
                    />
                  </View>
                  {discount.claimable ? (
                    <Text style={[type.caption, { color: colors.textMuted }]}>{CLAIM_CAPTION_COPY}</Text>
                  ) : null}
                  {amountError ? (
                    <Text accessibilityRole="alert" style={[type.caption, { color: colors.danger }]}>
                      {FIELD_ERROR_COPY[amountError]}
                    </Text>
                  ) : null}
                </View>
              );
            })}
            <Button label="Add discount" icon={Plus} variant="ghost" onPress={() => dispatch({ type: 'addDiscount' })} />
          </Card>

          {/* The live totals check */}
          {hasMismatch ? (
            <Banner tone="error" title={MISMATCH_BANNER} alert>
              {ev.mismatches.map((r) => {
                const gap = ev.gaps[r];
                return (
                  <Fragment key={r}>
                    <BannerText>{reasonCopy(ev, r)}</BannerText>
                    {gap !== undefined && gap !== 0 ? <BannerText>{`Off by ${formatCents(Math.abs(gap))}`}</BannerText> : null}
                  </Fragment>
                );
              })}
            </Banner>
          ) : null}

          {/* Totals, receipt style */}
          <Card title="Totals">
            <Text style={[type.caption, { color: colors.textMuted }]}>{`Items add up to ${formatCents(ev.itemsTotalCents)}`}</Text>
            {TOTAL_FIELDS.map(({ field, label }) => {
              const isTotal = field === 'total';
              const key = `totals.${field}`;
              const error = errorFor(key);
              return (
                <View key={field} style={isTotal && [styles.totalRow, { borderTopColor: colors.divider }]}>
                  <View style={styles.receiptRow}>
                    <Text style={[isTotal ? type.title : type.body, styles.flex, { color: colors.text }]}>{label}</Text>
                    <TextField
                      ref={fieldRef(key)}
                      label={label}
                      placeholder="Not on receipt"
                      prefix="$"
                      keyboardType="decimal-pad"
                      numeric
                      large={isTotal}
                      value={draft.totals[field]}
                      onChangeText={(value) =>
                        dispatch(field === 'tip' ? { type: 'setTip', value } : { type: 'setTotal', field, value })
                      }
                      onFocus={field === 'tip' ? () => setTipExpanded(true) : undefined}
                      invalid={error !== undefined}
                      accessibilityHint={error ? FIELD_ERROR_COPY[error] : undefined}
                      style={styles.totalField}
                      {...nextProps(key)}
                    />
                  </View>
                  {error ? (
                    <Text accessibilityRole="alert" style={[type.caption, styles.totalError, { color: colors.danger }]}>
                      {FIELD_ERROR_COPY[error]}
                    </Text>
                  ) : null}
                  {field === 'tip' ? (
                    tipOptionsShown ? (
                      <View style={styles.tipOptions}>
                        <TipOptions
                          draft={draft}
                          dispatch={dispatch}
                          customRef={fieldRef('totals.tipCustom')}
                          onCustomSubmit={() => focus('totals.total')}
                        />
                      </View>
                    ) : (
                      <View style={styles.tipLink}>
                        <TextLink
                          label="Tip options"
                          accessibilityLabel="Tip options"
                          accessibilityHint="Shows 15, 18, 20 and 25 percent and a custom tip."
                          onPress={() => setTipExpanded(true)}
                        />
                      </View>
                    )
                  ) : null}
                </View>
              );
            })}
            {missingTotals.length > 0 ? (
              <Banner tone="info">
                {missingTotals.map((r) => (
                  <BannerText key={r}>{REASON_COPY[r]}</BannerText>
                ))}
              </Banner>
            ) : null}
          </Card>

          {children}
        </View>
      </ScrollView>

      {/* Sticky footer: the bill total and the check's status, always in view. */}
      <View
        style={[
          styles.footer,
          { backgroundColor: colors.surface, borderTopColor: colors.divider, paddingBottom: insets.bottom + space.md },
        ]}
      >
        <View style={[styles.column, styles.footerRow]}>
          <View style={styles.flex}>
            <Text style={[type.caption, { color: colors.textMuted }]}>Bill total</Text>
            <MoneyText cents={ev.receipt.totalCents} size="title" />
          </View>
          <View
            accessible
            accessibilityLabel={`Totals check: ${status.text}`}
            style={[styles.pill, { backgroundColor: status.bg }]}
          >
            <Icon icon={status.icon} size="sm" color={status.fg} />
            <Text style={[type.caption, styles.pillText, { color: status.fg }]}>{status.text}</Text>
          </View>
        </View>
        {footerAction ? <View style={styles.column}>{footerAction}</View> : null}
        {footerNote ? (
          <Text style={[type.caption, styles.column, { color: colors.textMuted }]}>{footerNote}</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { paddingHorizontal: space.lg, paddingBottom: space.xxl },
  column: { width: '100%', maxWidth: layout.form, alignSelf: 'center', gap: space.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  itemRow: { gap: space.sm },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.md },
  colQty: { width: QTY_WIDTH },
  colPrice: { width: PRICE_WIDTH },
  colHead: { textAlign: 'right', paddingRight: space.md },
  empty: { textAlign: 'center', paddingVertical: space.md },
  flag: { flexDirection: 'row', gap: space.sm, padding: space.sm, borderRadius: radius.sm, borderCurve: 'continuous' },
  // The 16-pt icon centred on the caption's 18-pt first line.
  flagIcon: { marginTop: 1 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: TOUCH_TARGET },
  switchLabel: { flex: 1, paddingVertical: space.sm },
  receiptRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  totalField: { width: TOTAL_FIELD_WIDTH },
  totalRow: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.md, marginTop: space.xs },
  totalError: { textAlign: 'right' },
  tipOptions: { marginTop: space.sm },
  tipLink: { flexDirection: 'row', justifyContent: 'flex-end' },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.md, paddingHorizontal: space.lg, gap: space.sm },
  footerRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  // Status, not a control: a tinted pill with icon + words, no outline.
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    gap: space.xs,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  pillText: { fontWeight: '600', flexShrink: 1 },
});
