// The Settle screen's Everyone list: who owes the payer, and who has marked "I paid" (brief §4).
// Undo on someone else's row asks first, inline (React Native Web has no Alert; SharePanel pattern).
// Renders lib/settleView.ts's rows only: no money math, no money strings built here.
// The payer's rows also carry Venmo controls (request spec R2/R3; settle-early spec D6): a muted
// @handle with a small flush-right ghost ("Request", "Request $1.10", "Pay $1.10 back"), or a muted
// caption saying why there is none. A back-due row adds "I paid it back" on its own line, and the
// host-payer's Undo sits on its own line below that (SE-ENG-13). Controls sit outside the grouped
// row, so the row's label stays the one sentence lib built.
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Banner, BannerText } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { MoneyText } from '@/components/ui/MoneyText';
import { ToneIcon } from '@/components/ui/ToneIcon';
import {
  SETTLE_COPY,
  type SettleAction,
  type SettlePeopleModel,
  type SettleRowModel,
  type SettleRowPayBack,
  type SettleRowRequest,
} from '@/lib/settleView';
import { space, TOUCH_TARGET, type, useTheme, type Palette } from '@/lib/theme';

export type RowLink = Extract<SettleRowRequest, { kind: 'link' }>;
type RecordAction = Extract<SettleAction, { kind: 'mark_difference' }>;

/**
 * Status column width while any row shows a difference status ("You owe $1.10 back"), so every
 * row's amount still lines up (SE-VIS-6). A local layout constant, not a token: used once here.
 */
const WIDE_STATUS_WIDTH = 120;

type Props = {
  model: SettlePeopleModel;
  /** The row whose Undo or "I paid it back" is in flight, until the refetch after it has finished. */
  busy: { userId: string; kind: 'unmark' | 'difference' } | null;
  error: string | null;
  /** One muted line under the rows (the payer's web line, R3 / SE-UX-11), or null. */
  footnote: string | null;
  /** A short polite confirmation ("Marked paid back", SE-UX-12) until the next action, or null. */
  announcement: string | null;
  onUndo: (userId: string) => void;
  /** The payer tapped a row's Venmo link (Request or Pay back); the screen opens it. */
  onOpenLink: (link: RowLink, kind: 'request' | 'pay_back') => void;
  /** The payer tapped "I paid it back". */
  onRecord: (action: RecordAction) => void;
};

function toneColor(c: Palette, tone: 'success' | 'muted' | 'warning'): string {
  return tone === 'success' ? c.success : tone === 'warning' ? c.warning : c.textMuted;
}

export function SettlePeopleList({ model, busy, error, footnote, announcement, onUndo, onOpenLink, onRecord }: Props) {
  const { colors } = useTheme();
  const [confirming, setConfirming] = useState<string | null>(null);
  // A confirm only stays open while its row still offers Undo (a live refetch may have removed it).
  const open = confirming !== null && model.rows.some((r) => r.userId === confirming && r.undo !== null) ? confirming : null;

  return (
    <Card title={model.title} aside={model.aside ?? undefined}>
      {model.rows.map((row, i) => (
        <View key={row.userId} style={[styles.row, i > 0 && [styles.divider, { borderTopColor: colors.divider }]]}>
          <RowMain row={row} wide={model.wideStatus} />
          {row.request !== null ? <LinkLine link={row.request} onOpen={(l) => onOpenLink(l, 'request')} /> : null}
          {row.payBack !== null ? (
            <PayBackLines
              payBack={row.payBack}
              disabled={busy !== null}
              loading={busy?.kind === 'difference' && busy.userId === row.userId}
              onOpen={(l) => onOpenLink(l, 'pay_back')}
              onRecord={onRecord}
            />
          ) : null}
          {row.undo !== null && open !== row.userId ? (
            <Button
              label={SETTLE_COPY.undo}
              variant="ghost"
              accessibilityLabel={row.undo.a11yLabel}
              accessibilityHint="Asks before clearing their mark"
              disabled={busy !== null}
              loading={busy?.kind === 'unmark' && busy.userId === row.userId}
              onPress={() => setConfirming(row.userId)}
              flush
              style={styles.end}
            />
          ) : null}
          {row.undo !== null && open === row.userId ? (
            <Banner tone="warning">
              <BannerText>{row.undo.confirmText}</BannerText>
              <View style={styles.buttons}>
                <Button
                  label={SETTLE_COPY.undo}
                  variant="danger"
                  accessibilityLabel={`Confirm: ${row.undo.a11yLabel}`}
                  onPress={() => {
                    const target = row.userId;
                    setConfirming(null);
                    onUndo(target);
                  }}
                />
                <Button
                  label={SETTLE_COPY.cancel}
                  accessibilityLabel={`${SETTLE_COPY.cancel}: keep ${row.name}'s I paid`}
                  variant="ghost"
                  onPress={() => setConfirming(null)}
                />
              </View>
            </Banner>
          ) : null}
        </View>
      ))}
      {announcement !== null ? (
        <Text accessibilityLiveRegion="polite" style={[type.caption, { color: colors.textMuted }]}>
          {announcement}
        </Text>
      ) : null}
      {footnote !== null ? <Text style={[type.caption, { color: colors.textMuted }]}>{footnote}</Text> : null}
      {error !== null ? (
        <Banner tone="error" alert>
          <BannerText>{error}</BannerText>
        </Banner>
      ) : null}
    </Card>
  );
}

/** The payer's back-due controls: the pay link line, then "I paid it back" on its own line. */
function PayBackLines({
  payBack,
  disabled,
  loading,
  onOpen,
  onRecord,
}: {
  payBack: SettleRowPayBack;
  disabled: boolean;
  loading: boolean;
  onOpen: (link: RowLink) => void;
  onRecord: (action: RecordAction) => void;
}) {
  const { record } = payBack;
  return (
    <>
      <LinkLine link={payBack.link} onOpen={onOpen} />
      <Button
        label={record.label}
        variant="ghost"
        accessibilityLabel={record.a11yLabel}
        accessibilityHint={record.a11yHint}
        disabled={disabled && !loading}
        loading={loading}
        onPress={() => onRecord(record.action)}
        flush
        style={styles.end}
      />
    </>
  );
}

/** Q1: muted @handle + flush-right ghost link. Q2–Q4: the muted caption alone, where the handle would be. */
function LinkLine({ link, onOpen }: { link: SettleRowRequest; onOpen: (link: RowLink) => void }) {
  const { colors } = useTheme();
  if (link.kind === 'caption') {
    return <Text style={[type.caption, { color: colors.textMuted }]}>{link.caption}</Text>;
  }
  return (
    <View style={styles.linkLine}>
      {/* The button's label already says the handle; screen readers hear it once. The handle gives
          way (ellipsizes) before the button does. */}
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        numberOfLines={1}
        style={[type.caption, styles.grow, { color: colors.textMuted }]}
      >
        {link.caption}
      </Text>
      <Button
        label={link.label}
        variant="ghost"
        accessibilityLabel={link.a11yLabel}
        accessibilityHint={link.a11yHint}
        onPress={() => onOpen(link)}
        flush
        style={styles.pushRight}
      />
    </View>
  );
}

function RowMain({ row, wide }: { row: SettleRowModel; wide: boolean }) {
  const { colors } = useTheme();
  return (
    <View accessible accessibilityLabel={row.a11yLabel} style={styles.main}>
      <View style={styles.line}>
        <Text style={[type.body, styles.name, { color: colors.text }]}>{row.name}</Text>
        <MoneyText cents={row.amountCents} />
        {row.status !== null ? (
          <View style={[wide ? styles.statusWide : styles.status, styles.statusRow]}>
            <ToneIcon tone={row.status.tone} color={toneColor(colors, row.status.tone)} />
            <Text style={[type.caption, styles.statusText, { color: toneColor(colors, row.status.tone) }]}>{row.status.text}</Text>
          </View>
        ) : (
          <View style={wide ? styles.statusWide : styles.status} />
        )}
      </View>
      {row.subLine !== null ? (
        <View style={styles.subLine}>
          <ToneIcon tone={row.subLine.tone} color={toneColor(colors, row.subLine.tone)} />
          <Text style={[type.caption, styles.shrink, { color: toneColor(colors, row.subLine.tone) }]}>
            {row.subLine.text}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: space.sm, gap: space.xs },
  divider: { borderTopWidth: StyleSheet.hairlineWidth },
  main: { gap: space.xs },
  line: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: space.md, rowGap: space.xs },
  name: { flex: 1, minWidth: 96 },
  // A fixed-width status column keeps the amounts lined up. marginLeft 'auto' keeps a status that
  // wraps onto its own line (large text) flush right, under the money, not at the left edge.
  status: { minWidth: 64, marginLeft: 'auto' },
  statusWide: { width: WIDE_STATUS_WIDTH, marginLeft: 'auto' },
  statusRow: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'flex-start', gap: space.xs },
  statusText: { flexShrink: 1, textAlign: 'right', fontWeight: '600' },
  subLine: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xs },
  shrink: { flexShrink: 1 },
  // A control on its own line ("I paid it back", Undo): flush right under the status column, and
  // still a 44-pt target (Button flush keeps minWidth 44).
  end: { alignSelf: 'flex-end', minWidth: TOUCH_TARGET },
  // Handle left, control right; at large text the control wraps to its own line, still flush right.
  linkLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space.sm },
  grow: { flex: 1, minWidth: 0 },
  pushRight: { marginLeft: 'auto' },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});
