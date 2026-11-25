// The bill screen footer's next step (docs/specs/2026-11-25-venmo-request-buttons.md, F1–F3):
// "Settle up" for most people; for someone who owes, "Pay <Payer> $X on Venmo" straight from here,
// then the one-line "Did you pay <Payer>?". Renders lib/settleView.ts's SettleFooterAction only: no
// money math and no sentences built here.
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { StatusLine } from '@/components/ui/StatusLine';
import { ToneIcon } from '@/components/ui/ToneIcon';
import { SETTLE_COPY, type SettleAction, type SettleFooterAction } from '@/lib/settleView';
import { space, type, useTheme } from '@/lib/theme';

type PayAction = Extract<SettleAction, { kind: 'pay' }>;
type MarkAction = Extract<SettleAction, { kind: 'mark' }>;

type Props = {
  action: SettleFooterAction;
  /** The viewer's own claim, split or extras change is saving: Pay and I paid wait for it (VR-17). */
  waitForSave: boolean;
  /** "I paid" is saving (until the refetch that includes it has finished). */
  marking: boolean;
  error: string | null;
  /** The refetch after the viewer's own saved change failed, so Pay keeps waiting (review R1). */
  refreshFailed: boolean;
  onRefresh: () => void;
  /** Called straight from the press, so the browser sees the user's gesture (popup rule). */
  onPay: (action: PayAction) => void;
  onMark: (action: MarkAction) => void;
  onNotYet: () => void;
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
  onPay,
  onMark,
  onNotYet,
  onSettle,
}: Props) {
  const { colors } = useTheme();
  const muted = [type.caption, { color: colors.textMuted }];

  // One compact line with an icon, not a full Banner: the footer stays short (visual pass V13).
  const errorBanner = error !== null ? <StatusLine text={error} tone="error" size="caption" alert /> : null;

  // Only where it blocks something: Pay / I paid wait for the refetch (review R1).
  const refreshLine = refreshFailed ? (
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
              {/* A mark confirmation is a success: icon + words (P3). "N left to claim" stays plain. */}
              {action.tone === 'success' ? <ToneIcon tone="success" color={colors.textMuted} /> : null}
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
      flush
    />
  );

  if (action.kind === 'pay') {
    const { button } = action;
    return (
      <View style={styles.stack}>
        <Button
          label={button.label}
          accessibilityLabel={button.a11yLabel}
          accessibilityHint={button.a11yHint}
          variant="primary"
          block
          disabled={waitForSave}
          onPress={() => onPay(button.action)}
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
          disabled={waitForSave}
          onPress={() => onMark(iPaid.action)}
        />
        <Button
          label={action.notYet.label}
          accessibilityLabel={action.notYet.a11yLabel}
          variant="ghost"
          disabled={marking}
          onPress={onNotYet}
          flush
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
  caption: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xs },
  shrink: { flexShrink: 1 },
});
