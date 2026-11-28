// The bill screen footer's next step (docs/specs/2026-11-25-venmo-request-buttons.md, F1–F3):
// "Settle up" for most people; for someone who owes, "Pay <Payer> $X on Venmo" straight from here,
// then the one-line "Did you pay <Payer>?". Sent-via-Venmo D5 adds `cash` (the Pay layout with the
// cash primary), `sent_check` (the inline check: Yes / No, undo as ghosts, no primary) and a
// `warning` caption tone (the triangle in `warning`, text muted; SV-VIS-13). Renders
// lib/settleView.ts's SettleFooterAction only: no money math and no sentences built here.
// QA N3: `paymentHeld` (a payment saved whose refetch failed) replaces the refresh line with
// "Your payment was saved…" and Try again, and holds every write button until a refetch lands.
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { StatusLine } from '@/components/ui/StatusLine';
import { ToneIcon } from '@/components/ui/ToneIcon';
import { SETTLE_COPY, type SettleAction, type SettleFooterAction } from '@/lib/settleView';
import { space, type, useTheme } from '@/lib/theme';

type PayAction = Extract<SettleAction, { kind: 'pay' }>;
type MarkAction = Extract<SettleAction, { kind: 'mark' }>;
type CheckAction = Extract<SettleAction, { kind: 'sent_check_yes' | 'sent_check_undo' }>;

type Props = {
  action: SettleFooterAction;
  /** The viewer's own claim, split or extras change is saving: Pay and I paid wait for it (VR-17). */
  waitForSave: boolean;
  /** A Pay / cash / "Yes, I sent it" write is in flight (until the refetch that includes it has finished). */
  marking: boolean;
  error: string | null;
  /** The refetch after the viewer's own saved change failed, so Pay keeps waiting (review R1). */
  refreshFailed: boolean;
  onRefresh: () => void;
  /** A payment was saved but the refetch after it failed (N3): 'retrying' while Try again runs. */
  paymentHeld?: 'failed' | 'retrying' | null;
  /** Try again for `paymentHeld`. */
  onRetryPayment?: () => void;
  /** Called straight from the press, so the browser sees the user's gesture (popup rule). */
  onPay: (action: PayAction) => void;
  onMark: (action: MarkAction) => void;
  onNotYet: () => void;
  /**
   * The inline check's Yes / No, undo (sent_check). The bill screen wires it (Task 9b); without it
   * the two answers are drawn disabled rather than doing nothing silently.
   */
  onCheck?: (action: CheckAction) => void;
  /** The check's "No, undo" is in flight. */
  checking?: boolean;
  /** "Settle up" and "Details" both open the Settle page. */
  onSettle: () => void;
};

export function SettleFooter({
  action,
  waitForSave,
  marking,
  error,
  refreshFailed,
  onRefresh,
  paymentHeld = null,
  onRetryPayment,
  onPay,
  onMark,
  onNotYet,
  onCheck,
  checking = false,
  onSettle,
}: Props) {
  const { colors } = useTheme();
  const muted = [type.caption, { color: colors.textMuted }];

  // One compact line with an icon, not a full Banner: the footer stays short (visual pass V13).
  const errorBanner = error !== null ? <StatusLine text={error} tone="error" size="caption" alert /> : null;

  // Only where it blocks something: Pay / I paid wait for the refetch (review R1). A saved payment
  // that isn't on screen yet (N3) says so instead, with Try again, and holds the write buttons.
  const held = paymentHeld !== null;
  const refreshLine = held ? (
    <View style={styles.row}>
      <Text accessibilityRole="alert" style={[muted, styles.grow]}>
        {SETTLE_COPY.savedNotRefreshed}
      </Text>
      <Button
        label={SETTLE_COPY.tryAgain}
        accessibilityLabel={SETTLE_COPY.tryAgain}
        accessibilityHint={SETTLE_COPY.refreshHint}
        variant="ghost"
        loading={paymentHeld === 'retrying'}
        disabled={onRetryPayment === undefined}
        onPress={() => onRetryPayment?.()}
        flush
      />
    </View>
  ) : refreshFailed ? (
    <View style={styles.row}>
      <Text accessibilityRole="alert" style={[muted, styles.grow]}>
        {SETTLE_COPY.refreshFailed}
      </Text>
      <Button
        label={SETTLE_COPY.refresh}
        accessibilityLabel={SETTLE_COPY.refresh}
        accessibilityHint={SETTLE_COPY.refreshHint}
        variant="ghost"
        onPress={onRefresh}
        flush
      />
    </View>
  ) : null;

  if (action.kind === 'settle') {
    return (
      <View style={styles.stack}>
        <View style={styles.row}>
          <Button
            label={SETTLE_COPY.settleUp}
            accessibilityLabel={SETTLE_COPY.settleUp}
            accessibilityHint={action.a11yHint}
            variant={action.variant}
            // In a row, "block" would stretch vertically; flex fills the footer's width instead.
            style={action.variant === 'primary' ? styles.grow : undefined}
            onPress={onSettle}
          />
          {action.caption !== null ? (
            <View style={[styles.caption, styles.grow]}>
              {/* A mark confirmation is a success: icon + words (P3). "N left to claim" stays plain.
                  Not received is the footer's one coloured icon: the triangle in `warning` (SV-VIS-13). */}
              {action.tone === 'success' ? <ToneIcon tone="success" color={colors.textMuted} /> : null}
              {action.tone === 'warning' ? <ToneIcon tone="warning" color={colors.warning} /> : null}
              <Text
                // Only what lib marks live is announced; "N left to claim" would speak on every claim tap.
                accessibilityLiveRegion={action.live === true ? 'polite' : 'none'}
                style={[muted, styles.shrink]}
              >
                {action.caption}
              </Text>
            </View>
          ) : null}
        </View>
        {errorBanner}
      </View>
    );
  }

  const details = (
    <Button
      label={action.details.label}
      accessibilityLabel={action.details.a11yLabel}
      accessibilityHint={action.details.a11yHint}
      variant="ghost"
      onPress={onSettle}
      flush="end"
    />
  );

  if (action.kind === 'pay' || action.kind === 'cash') {
    // Cash has the Pay layout exactly (SV-UX-10): same button shape, same place, for either method.
    const pay = action.kind === 'pay' ? action.button : null;
    const cash = action.kind === 'cash' ? action.button : null;
    const button = pay ?? cash;
    if (button === null) return null;
    return (
      <View style={styles.stack}>
        <Button
          label={button.label}
          accessibilityLabel={button.a11yLabel}
          accessibilityHint={button.a11yHint}
          variant="primary"
          block
          // Either method shows the spinner while its write runs (native Pay records before Venmo opens).
          loading={marking}
          disabled={waitForSave || held}
          onPress={() => {
            if (pay !== null) onPay(pay.action);
            else if (cash !== null) onMark(cash.action);
          }}
        />
        <View style={styles.row}>
          <View style={styles.grow}>
            {action.notes.map((note) => (
              <Text key={note} style={muted}>
                {note}
              </Text>
            ))}
          </View>
          {details}
        </View>
        {refreshLine}
        {errorBanner}
      </View>
    );
  }

  if (action.kind === 'sent_check') {
    // No primary: doing nothing already means "yes" (SV-VIS §7). Two flush ghosts, Details at the right.
    const { yes, undo } = action;
    const answer = (a: CheckAction) => onCheck?.(a);
    const unwired = onCheck === undefined;
    return (
      <View style={styles.stack}>
        {/* It appears on the way back from Venmo: announced politely, like contract O's question. */}
        <Text accessibilityLiveRegion="polite" style={[type.label, { color: colors.text }]}>
          {action.text}
        </Text>
        <View style={styles.row}>
          <View style={styles.answers}>
            <Button
              label={yes.label}
              accessibilityLabel={yes.a11yLabel}
              accessibilityHint={yes.a11yHint}
              variant="ghost"
              disabled={unwired || checking || held}
              onPress={() => answer(yes.action)}
              flush="start"
            />
            <Button
              label={undo.label}
              accessibilityLabel={undo.a11yLabel}
              accessibilityHint={undo.a11yHint}
              variant="ghost"
              loading={checking}
              disabled={unwired || held}
              onPress={() => answer(undo.action)}
              flush="start"
            />
          </View>
          <View style={styles.grow} />
          {details}
        </View>
        {refreshLine}
        {errorBanner}
      </View>
    );
  }

  // did_you_pay: one question, its two answers, and Details at the same spot as under Pay.
  const { iPaid } = action;
  return (
    <View style={styles.stack}>
      <Text accessibilityLiveRegion="polite" style={[type.label, { color: colors.text }]}>
        {action.text}
      </Text>
      <View style={styles.row}>
        <Button
          label={iPaid.label}
          accessibilityLabel={iPaid.a11yLabel}
          accessibilityHint={iPaid.a11yHint}
          variant="primary"
          loading={marking}
          disabled={waitForSave || held}
          onPress={() => onMark(iPaid.action)}
        />
        <Button
          label={action.notYet.label}
          accessibilityLabel={action.notYet.a11yLabel}
          variant="ghost"
          disabled={marking}
          onPress={onNotYet}
          flush="start"
        />
        <View style={styles.grow} />
        {details}
      </View>
      {refreshLine}
      {errorBanner}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.md,
  },
  grow: { flex: 1, minWidth: 0 },
  answers: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.lg },
  caption: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xs },
  shrink: { flexShrink: 1 },
});
