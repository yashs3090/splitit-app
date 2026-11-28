// The viewer's part of a group's Settle screen (spec docs/specs/2026-11-26-groups-mvp.md T16, A2.2):
// what they pay (with the Venmo | Cash chooser), what they just sent, what's owed to them, and what
// they've received. Group-only on purpose: components/SettleCard.tsx is bill-shaped and owned by
// the Sent via Venmo work, so it is neither used nor changed here.
//
// Renders lib/groupSettleView.ts's entries only: no money math, no money strings built here. Every
// card's head is one screen-reader element that reads its full sentence ("You owe Dee $174.97").
import { StyleSheet, Text, View } from 'react-native';

import { Banner, BannerText } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { MoneyText } from '@/components/ui/MoneyText';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { StatusLine } from '@/components/ui/StatusLine';
import { ToneIcon } from '@/components/ui/ToneIcon';
import { chooserOptions, GROUP_SETTLE_SCREEN_COPY as COPY, type RecordedEntry } from '@/lib/groupSettleText';
import type { PayEntry, ReceivedEntry, RequestEntry, SentEntry } from '@/lib/groupSettleView';
import type { PaymentMethod } from '@/lib/paymentMethods';
import { SETTLE_COPY } from '@/lib/settleView';
import { space, type, useTheme } from '@/lib/theme';
import type { GroupBusy } from '@/lib/useGroupSettle';

/** The card's head: a short label over the big amount, read as one sentence. */
function Head({ label, cents, a11y, size = 'display' }: { label: string; cents: number; a11y: string; size?: 'display' | 'title' }) {
  const { colors } = useTheme();
  return (
    <View accessible accessibilityLabel={a11y} style={styles.head}>
      <Text style={[type.label, { color: colors.text }]}>{label}</Text>
      <MoneyText cents={cents} size={size} />
    </View>
  );
}

function Line({ text, tone, live = false }: { text: string; tone: 'muted' | 'success' | 'warning'; live?: boolean }) {
  const { colors } = useTheme();
  const color = tone === 'success' ? colors.success : tone === 'warning' ? colors.warning : colors.textMuted;
  return (
    <View style={styles.line}>
      <ToneIcon tone={tone} color={color} />
      <Text accessibilityLiveRegion={live ? 'polite' : undefined} style={[type.caption, styles.lineText, tone !== 'muted' && styles.strong, { color }]}>
        {text}
      </Text>
    </View>
  );
}

function Note({ text }: { text: string }) {
  const { colors } = useTheme();
  return <Text style={[type.caption, { color: colors.textMuted }]}>{text}</Text>;
}

function ErrorBanner({ text }: { text: string | null }) {
  if (text === null) return null;
  return (
    <Banner tone="error" alert>
      <BannerText>{text}</BannerText>
    </Banner>
  );
}

const isBusy = (busy: GroupBusy | null, kind: GroupBusy['kind'], target: string) => busy !== null && busy.kind === kind && busy.target === target;

// ---------------------------------------------------------------------------------------------

type PayProps = {
  entry: PayEntry;
  /** "You owe Dee" (lib's owesLabel). */
  label: string;
  /** The chooser's value (chosenMethod of the remembered choice and Dee's Venmo). */
  method: PaymentMethod;
  busy: GroupBusy | null;
  error: string | null;
  onChoose: (m: PaymentMethod) => void;
  /** Called straight from the press, so the browser sees the user's gesture. */
  onPay: () => void;
  onCash: () => void;
  onOther: () => void;
  onYes: () => void;
  onNotNow: () => void;
};

export function GroupPayCard({ entry, label, method, busy, error, onChoose, onPay, onCash, onOther, onYes, onNotNow }: PayProps) {
  const { colors } = useTheme();
  const inFlight = busy !== null;
  const ask = entry.state === 'ask_on_return' ? entry.ask : null;
  const useVenmo = method === 'venmo' && entry.venmo !== null;
  const options = chooserOptions(entry.methods);

  return (
    <Card>
      <View style={styles.headGroup}>
        <Head label={label} cents={entry.cents} a11y={entry.text} />
        {entry.notReceivedLine !== null ? <Line text={entry.notReceivedLine} tone="warning" /> : null}
        {entry.noVenmoLine !== null ? <Line text={entry.noVenmoLine} tone="muted" /> : null}
      </View>

      {ask !== null ? (
        // Desktop web, or the record's outcome unknown: one question, one answer that records (A2.2).
        <View style={styles.action}>
          <Text style={[type.body, { color: colors.text }]}>{ask.text}</Text>
          <Button
            label={ask.yes}
            variant="primary"
            block
            accessibilityHint={COPY.yesHint}
            loading={isBusy(busy, 'yes', entry.to)}
            disabled={inFlight && !isBusy(busy, 'yes', entry.to)}
            onPress={onYes}
          />
          <Button label={ask.notNow} variant="ghost" flush="start" accessibilityHint={COPY.notNowHint} disabled={inFlight} onPress={onNotNow} />
        </View>
      ) : (
        <View style={styles.action}>
          {options.length > 1 ? (
            <SegmentedControl
              options={options}
              value={method}
              onChange={onChoose}
              semantics="radio"
              groupLabel={SETTLE_COPY.chooserA11y}
              disabled={inFlight}
              style={styles.chooser}
            />
          ) : null}
          {useVenmo && entry.venmo !== null ? (
            <Button
              label={entry.venmo.label}
              variant="primary"
              block
              accessibilityHint={entry.venmo.hint}
              loading={isBusy(busy, 'send', entry.to)}
              disabled={inFlight && !isBusy(busy, 'send', entry.to)}
              onPress={onPay}
            />
          ) : (
            <Button
              label={entry.cash.label}
              variant="primary"
              block
              accessibilityHint={entry.cash.hint}
              loading={isBusy(busy, 'cash', `pay:${entry.to}`)}
              disabled={inFlight && !isBusy(busy, 'cash', `pay:${entry.to}`)}
              onPress={onCash}
            />
          )}
          {useVenmo && entry.handleNote !== null ? <Note text={entry.handleNote} /> : null}
          {useVenmo && entry.webNote !== null ? <Note text={entry.webNote} /> : null}
          {entry.openFailed !== null ? <StatusLine text={entry.openFailed} tone="error" size="caption" alert /> : null}
          <Button
            label={entry.otherWay.label}
            variant="ghost"
            flush="start"
            accessibilityHint={entry.otherWay.hint}
            loading={isBusy(busy, 'other', `pay:${entry.to}`)}
            disabled={inFlight && !isBusy(busy, 'other', `pay:${entry.to}`)}
            onPress={onOther}
          />
        </View>
      )}
      <ErrorBanner text={error} />
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------

type SentProps = { entry: SentEntry; busy: GroupBusy | null; error: string | null; onYes: () => void; onNo: () => void; onUndo: () => void };

/** "You sent Dee" / $174.97 / "Sent via Venmo", then the inline check or "Didn't go through? Undo". */
export function GroupSentCard({ entry, busy, error, onYes, onNo, onUndo }: SentProps) {
  const { colors } = useTheme();
  const inFlight = busy !== null;
  const undoing = isBusy(busy, 'undo', `sent:${entry.paymentId}`);
  return (
    <Card>
      <View style={styles.headGroup}>
        <Head label={entry.label} cents={entry.cents} a11y={`${entry.label} ${entry.amountText}`} />
        <Line text={entry.methodLine} tone="success" live />
      </View>
      {entry.check !== null ? (
        // A question, not a status: the buttons carry the context (SV-UX-21).
        <View>
          <Text style={[type.caption, { color: colors.textMuted }]}>{entry.check.text}</Text>
          <View style={styles.ghosts}>
            <Button label={entry.check.yes} variant="ghost" flush="start" accessibilityLabel={SETTLE_COPY.sentCheckYesA11y} disabled={inFlight} onPress={onYes} />
            <Button
              label={entry.check.no}
              variant="ghost"
              flush="start"
              accessibilityLabel={SETTLE_COPY.sentCheckUndoA11y}
              accessibilityHint={COPY.undoHint}
              loading={undoing}
              disabled={inFlight && !undoing}
              onPress={onNo}
            />
          </View>
        </View>
      ) : entry.undo !== null ? (
        <Button
          label={entry.undo.label}
          variant="ghost"
          flush="start"
          accessibilityHint={COPY.undoHint}
          loading={undoing}
          disabled={inFlight && !undoing}
          onPress={onUndo}
        />
      ) : null}
      <ErrorBanner text={error} />
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------

type RecordedProps = { entry: RecordedEntry; busy: GroupBusy | null; error: string | null; onUndo: () => void };

/** The viewer's own cash / "Paid another way" record, with Undo, until the next action. */
export function GroupRecordedCard({ entry, busy, error, onUndo }: RecordedProps) {
  const undoing = isBusy(busy, 'undo', `rec:${entry.paymentId}`);
  return (
    <Card>
      <View style={styles.headGroup}>
        <Head label={entry.label} cents={entry.cents} a11y={`${entry.label} ${entry.amountText}`} />
        <Line text={entry.methodLine} tone="success" live />
      </View>
      <Button
        label={COPY.undo}
        variant="ghost"
        flush="start"
        accessibilityLabel={COPY.undoRecordedA11y}
        accessibilityHint={COPY.undoHint}
        loading={undoing}
        disabled={busy !== null && !undoing}
        onPress={onUndo}
      />
      <ErrorBanner text={error} />
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------

type RequestProps = {
  entry: RequestEntry;
  /** "Ben owes you" (lib's negativeLabel). */
  label: string;
  busy: GroupBusy | null;
  error: string | null;
  openFailed: string | null;
  confirming: boolean;
  divider: boolean;
  onRequest: () => void;
  onGotPaid: () => void;
  onConfirm: () => void;
  onCancel: () => void;
};

/** One person who owes the viewer: Request on Venmo (opens only), or "Got paid another way" (asks first). */
export function GroupRequestRow({ entry, label, busy, error, openFailed, confirming, divider, onRequest, onGotPaid, onConfirm, onCancel }: RequestProps) {
  const { colors } = useTheme();
  const inFlight = busy !== null;
  const saving = isBusy(busy, 'got_paid', `req:${entry.from}`);
  return (
    <View style={[styles.row, divider && [styles.dividerRow, { borderTopColor: colors.divider }]]}>
      <Head label={label} cents={entry.cents} a11y={entry.text} size="title" />
      {confirming ? (
        <View style={styles.action}>
          <Text style={[type.body, { color: colors.text }]}>{entry.gotPaid.confirm}</Text>
          <View style={styles.ghosts}>
            <Button label={COPY.recordIt} variant="secondary" loading={saving} disabled={inFlight && !saving} onPress={onConfirm} />
            <Button label={COPY.cancel} variant="ghost" disabled={saving} onPress={onCancel} />
          </View>
        </View>
      ) : (
        <View style={styles.action}>
          {entry.request !== null ? (
            <Button
              label={entry.request.label}
              variant="secondary"
              accessibilityLabel={entry.request.a11yLabel}
              accessibilityHint={COPY.opensVenmo}
              onPress={onRequest}
            />
          ) : (
            <Note text={SETTLE_COPY.requestNoVenmo} />
          )}
          {entry.webNote !== null ? <Note text={entry.webNote} /> : null}
          {openFailed !== null ? <StatusLine text={openFailed} tone="error" size="caption" alert /> : null}
          <Button label={entry.gotPaid.label} variant="ghost" flush="start" accessibilityHint={COPY.gotPaidHint} disabled={inFlight} onPress={onGotPaid} />
        </View>
      )}
      <ErrorBanner text={error} />
    </View>
  );
}

// ---------------------------------------------------------------------------------------------

type ReceivedProps = {
  entry: ReceivedEntry;
  busy: GroupBusy | null;
  error: string | null;
  confirming: boolean;
  divider: boolean;
  onNotReceived: () => void;
  onConfirm: () => void;
  onCancel: () => void;
};

/** A payment someone else recorded to the viewer: "Ben sent you $130.02" · "Sent via Venmo" · Not received. */
export function GroupReceivedRow({ entry, busy, error, confirming, divider, onNotReceived, onConfirm, onCancel }: ReceivedProps) {
  const { colors } = useTheme();
  const saving = isBusy(busy, 'not_received', `recv:${entry.paymentId}`);
  return (
    <View style={[styles.row, divider && [styles.dividerRow, { borderTopColor: colors.divider }]]}>
      <View accessible accessibilityLabel={`${entry.text}, ${entry.status}`} style={styles.head}>
        <Text style={[type.body, { color: colors.text }]}>{entry.text}</Text>
        <Text style={[type.caption, { color: colors.textMuted }]}>{entry.status}</Text>
      </View>
      {confirming ? (
        <View style={styles.action}>
          <Text style={[type.body, { color: colors.text }]}>{entry.notReceived.confirm}</Text>
          <View style={styles.ghosts}>
            <Button label={entry.notReceived.label} variant="danger" loading={saving} disabled={busy !== null && !saving} onPress={onConfirm} />
            <Button label={COPY.cancel} variant="ghost" disabled={saving} onPress={onCancel} />
          </View>
        </View>
      ) : (
        <Button
          label={entry.notReceived.label}
          variant="ghost"
          flush="start"
          accessibilityLabel={`${entry.notReceived.label}: ${entry.text}`}
          accessibilityHint={COPY.notReceivedHint}
          disabled={busy !== null}
          onPress={onNotReceived}
        />
      )}
      <ErrorBanner text={error} />
    </View>
  );
}

const styles = StyleSheet.create({
  headGroup: { gap: space.xs },
  head: { gap: space.xs },
  strong: { fontWeight: '600' },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xs },
  lineText: { flexShrink: 1 },
  action: { gap: space.sm, marginTop: space.xs },
  // 12 to the primary (action gap 8 + 4): the chooser and the button are one decision (as SettleCard).
  chooser: { alignSelf: 'flex-start', marginBottom: space.xs },
  ghosts: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.lg },
  row: { gap: space.sm },
  // The card's own gap sits above the hairline; this is the same space below it.
  dividerRow: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.md },
});
