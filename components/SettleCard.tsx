// The Settle screen's "your part" card: one model per role and state (brief §3,
// docs/specs/2026-11-24-m3-settle-ux.md). Renders lib/settleView.ts's model only: no money math,
// no money strings built here.
import { StyleSheet, Text, View } from 'react-native';

import { Banner, BannerText } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { MoneyText } from '@/components/ui/MoneyText';
import { ToneIcon } from '@/components/ui/ToneIcon';
import { type CardLine, type SettleAction, type SettleButton, type SettleCardModel } from '@/lib/settleView';
import { space, type, useTheme, type Palette } from '@/lib/theme';

/** The card's link buttons: they open Venmo and never write (the screen tracks "Did you pay?"). */
export type OpenAction = Extract<SettleAction, { kind: 'pay' | 'pay_difference' | 'request' }>;

type Props = {
  model: SettleCardModel;
  /** Which write is in flight from this card (its button shows loading; the others are disabled). */
  busy: 'mark' | 'unmark' | 'difference' | null;
  error: string | null;
  /** A short confirmation after the person's own undo ("Marked not paid"), read by screen readers. */  announcement: string | null;
  /** Pay, Pay more and Request call this straight from the press, so the browser sees the user's gesture. */
  onOpen: (action: OpenAction) => void;
  onAction: (action: Exclude<SettleAction, OpenAction>) => void;
};

function isOpen(a: SettleAction): a is OpenAction {
  return a.kind === 'pay' || a.kind === 'pay_difference' || a.kind === 'request';
}

const BUSY_KIND = { mark: 'mark', unmark: 'unmark', difference: 'mark_difference' } as const;

function lineColor(c: Palette, tone: CardLine['tone']): string {
  return tone === 'success' ? c.success : tone === 'warning' ? c.warning : c.textMuted;
}

export function SettleCard({ model, busy, error, announcement, onOpen, onAction }: Props) {
  const { colors } = useTheme();

  const press = (b: SettleButton) => {
    const a = b.action;
    if (isOpen(a)) onOpen(a);
    else onAction(a);
  };
  const isLoading = (b: SettleButton) => busy !== null && b.action.kind === BUSY_KIND[busy];

  // The block slot is filled (primary) unless the model says secondary: the back-due Request is a
  // nudge that never records anything, so that card has no primary (SE-VIS-3; tonal per V6).
  const button = (b: SettleButton, slot: 'block' | 'ghost') => (
    <Button
      key={`${b.action.kind}:${b.label}`}
      label={b.label}
      variant={slot === 'ghost' ? 'ghost' : b.variant === 'secondary' ? 'secondary' : 'primary'}
      block={slot === 'block'}
      accessibilityLabel={b.a11yLabel}
      accessibilityHint={b.a11yHint}
      loading={isLoading(b)}
      disabled={busy !== null && !isLoading(b)}
      onPress={() => press(b)}
      flush={slot === 'ghost'}
    />
  );

  return (
    <Card>
      <View style={styles.head}>
        <Text style={[type.label, { color: colors.text }]}>{model.label}</Text>
        {model.amountCents !== null ? <MoneyText cents={model.amountCents} size="display" /> : null}
        {model.lines.map((line) => (
          <View key={line.text} style={styles.line}>
            <ToneIcon tone={line.tone} color={lineColor(colors, line.tone)} />
            <Text
              accessibilityLiveRegion={line.live ? 'polite' : undefined}
              style={[type.caption, styles.lineText, line.tone !== 'muted' && styles.strong, { color: lineColor(colors, line.tone) }]}
            >
              {line.text}
            </Text>
          </View>
        ))}
      </View>

      {model.primary || model.notes.length > 0 ? (
        <View style={styles.action}>
          {model.primary ? button(model.primary, 'block') : null}
          {model.notes.map((note) => (
            <Text key={note} style={[type.caption, { color: colors.textMuted }]}>
              {note}
            </Text>
          ))}
        </View>
      ) : null}

      {model.secondary.length > 0 ? <View style={styles.secondary}>{model.secondary.map((b) => button(b, 'ghost'))}</View> : null}

      {announcement !== null ? (
        <Text accessibilityLiveRegion="polite" style={[type.caption, { color: colors.textMuted }]}>
          {announcement}
        </Text>
      ) : null}

      {error !== null ? (
        <Banner tone="error" alert>
          <BannerText>{error}</BannerText>
        </Banner>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { gap: space.xs },
  strong: { fontWeight: '600' },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xs },
  lineText: { flexShrink: 1 },
  action: { gap: space.sm, marginTop: space.xs },
  secondary: { flexDirection: 'row', flexWrap: 'wrap', gap: space.lg },
});
