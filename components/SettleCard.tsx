// The Settle screen's "your part" card: one model per role and state (brief §3,
// docs/specs/2026-11-24-m3-settle-ux.md; sent-via-Venmo D5). Renders lib/settleView.ts's model only:
// no money math, no money strings built here.
//
// Slots, top to bottom: head (label, amount, status lines), the "How you're paying" chooser (hugs
// its labels, left-aligned; SV-VIS-1), the primary and its notes, then either the inline check
// ("Did it go through?" with Yes / No, undo) or the ghost row. The check and the card's own Undo
// never show together (the model guarantees it).
//
// Held (QA N3): a payment was saved but the screen couldn't refresh, so the card still shows what
// the server last confirmed ("You owe … / Pay"). Every control is disabled and a warning Banner says
// the payment is saved, with Try again; nothing optimistic is drawn.
import { StyleSheet, Text, View } from 'react-native';

import { Banner, BannerText } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { MoneyText } from '@/components/ui/MoneyText';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { ToneIcon } from '@/components/ui/ToneIcon';
import type { PaymentMethod } from '@/lib/paymentMethods';
import { SETTLE_COPY, type CardLine, type SettleAction, type SettleButton, type SettleCardModel } from '@/lib/settleView';
import { space, type, useTheme, type Palette } from '@/lib/theme';

/** The card's link buttons: Pay, Pay more and Request. `slot` 'ghost' is "Open Venmo again" (opens only). */
export type OpenAction = Extract<SettleAction, { kind: 'pay' | 'pay_difference' | 'request' }>;

type Props = {
  model: SettleCardModel;
  /**
   * The kinds of action in flight from this card: those buttons show their spinner, and every other
   * control on the card (chooser included) is disabled. Empty when nothing is in flight.
   */
  busy: readonly SettleAction['kind'][];
  /**
   * With `busy`: only the button whose action also has this method spins (Cash and "Paid another
   * way" are both `mark`). Undefined: every button of a busy kind spins.
   */
  busyMethod?: PaymentMethod;
  /** Saved, but not refreshed (N3): 'failed' shows the message; 'retrying' while Try again runs. */
  held?: 'failed' | 'retrying' | null;
  /**
   * Several cards (who paid A1.5): another card's write is in flight, so every control here is
   * disabled, with no spinner. Default false.
   */
  locked?: boolean;
  /** Try again for `held`. */
  onRetry?: () => void;
  error: string | null;
  /** A short confirmation after the person's own undo ("Marked not paid"), read by screen readers. */
  announcement: string | null;
  /** Pay, Pay more and Request call this straight from the press, so the browser sees the user's gesture. */
  onOpen: (action: OpenAction, slot: 'block' | 'ghost') => void;
  onAction: (action: Exclude<SettleAction, OpenAction>) => void;
  /** A segment of the chooser was tapped. */
  onChoose: (method: PaymentMethod) => void;
};

function isOpen(a: SettleAction): a is OpenAction {
  return a.kind === 'pay' || a.kind === 'pay_difference' || a.kind === 'request';
}

function lineColor(c: Palette, tone: CardLine['tone']): string {
  return tone === 'success' ? c.success : tone === 'warning' ? c.warning : c.textMuted;
}

export function SettleCard({ model, busy, busyMethod, held = null, locked = false, onRetry, error, announcement, onOpen, onAction, onChoose }: Props) {
  const { colors } = useTheme();
  // Held (N3) and locked block every control as a write in flight does, without a spinner.
  const inFlight = busy.length > 0 || held !== null || locked;

  const press = (b: SettleButton, slot: 'block' | 'ghost') => {
    const a = b.action;
    if (isOpen(a)) onOpen(a, slot);
    else onAction(a);
  };
  const isLoading = (b: SettleButton) =>
    busy.includes(b.action.kind) && (busyMethod === undefined || !('method' in b.action) || b.action.method === busyMethod);

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
      disabled={inFlight && !isLoading(b)}
      onPress={() => press(b, slot)}
      // Ghosts sit on the card's text edge, so a short "Yes" or "Undo" lines up with the lines above.
      flush={slot === 'ghost' ? 'start' : false}
    />
  );
  const { chooser, check } = model;

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

      {model.primary || model.notes.length > 0 || chooser !== null ? (
        <View style={styles.action}>
          {chooser !== null ? (
            <SegmentedControl
              options={chooser.options.map((o) => ({ value: o.value, label: o.label, accessibilityLabel: o.a11yLabel }))}
              value={chooser.value}
              onChange={onChoose}
              semantics="radio"
              groupLabel={chooser.a11yLabel}
              disabled={inFlight}
              style={styles.chooser}
            />
          ) : null}
          {model.primary ? button(model.primary, 'block') : null}
          {model.notes.map((note) => (
            <Text key={note} style={[type.caption, { color: colors.textMuted }]}>
              {note}
            </Text>
          ))}
        </View>
      ) : null}

      {check !== null ? (
        // A question, not a status: its own block after the head group. Not live: it appears with the
        // live "Sent via Venmo" line, and the buttons carry the context (SV-UX-21).
        <View>
          <Text style={[type.caption, { color: colors.textMuted }]}>{check.question}</Text>
          <View style={styles.secondary}>
            {button(check.yes, 'ghost')}
            {button(check.undo, 'ghost')}
          </View>
        </View>
      ) : null}

      {model.secondary.length > 0 ? <View style={styles.secondary}>{model.secondary.map((b) => button(b, 'ghost'))}</View> : null}

      {announcement !== null ? (
        <Text accessibilityLiveRegion="polite" style={[type.caption, { color: colors.textMuted }]}>
          {announcement}
        </Text>
      ) : null}

      {held !== null ? (
        // A warning, not an error: the payment is saved. Announced once, when it appears.
        <Banner tone="warning" alert>
          <View style={styles.heldRow}>
            <View style={styles.grow}>
              <BannerText>{SETTLE_COPY.savedNotRefreshed}</BannerText>
            </View>
            <Button
              label={SETTLE_COPY.tryAgain}
              accessibilityLabel={SETTLE_COPY.tryAgain}
              accessibilityHint={SETTLE_COPY.refreshHint}
              variant="ghost"
              loading={held === 'retrying'}
              disabled={onRetry === undefined}
              onPress={() => onRetry?.()}
              flush
            />
          </View>
        </Banner>
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
  // 12 to the primary (action gap 8 + 4): the chooser and the button are one decision (SV-VIS §1.2).
  chooser: { alignSelf: 'flex-start', marginBottom: space.xs },
  secondary: { flexDirection: 'row', flexWrap: 'wrap', gap: space.lg },
  heldRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
  grow: { flexGrow: 1, flexShrink: 1, flexBasis: 160 },
});
