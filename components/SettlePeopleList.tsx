// The Settle screen's Everyone list: who owes the payer, and who has marked "I paid" (brief §4).
// Undo on someone else's row asks first, inline (React Native Web has no Alert; SharePanel pattern).
// Renders lib/settleView.ts's rows only: no money math, no money strings built here.
// The payer's rows also carry Venmo controls (request spec R2/R3; settle-early spec D6): a muted
// @handle with a small flush-right ghost ("Request", "Request $1.10", "Pay $1.10 back"), or a muted
// caption saying why there is none. A back-due row adds "I paid it back" on its own line, and the
// host-payer's Undo sits on its own line below that (SE-ENG-13). Controls sit outside the grouped
// row, so the row's label stays the one sentence lib built.
// Sent via Venmo (D4, SV-VIS-9): the payer gets "Not received" instead of Undo on a marked row, a
// quiet TextLink on its own line, flush right, which asks first in the same inline warning Banner.
// A row never has both.
// Several payers (who paid A1.5 S4): rows grouped by who receives, each group under its label
// ("Paying you", "Paying Sam"); one recipient draws no label, so it looks as before. A person can
// have a row in two groups, so rows, confirms and busy states are keyed by (recipient, person).
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Banner, BannerText } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { MoneyText } from '@/components/ui/MoneyText';
import { TextLink } from '@/components/ui/TextLink';
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
export type NotReceivedAction = Extract<SettleAction, { kind: 'not_received' }>;

/**
 * Status column width while any row shows a difference status ("You owe $1.10 back"), so every
 * row's amount still lines up (SE-VIS-6). A local layout constant, not a token: used once here.
 */
const WIDE_STATUS_WIDTH = 120;

type Props = {
  model: SettlePeopleModel;
  /**
   * The row whose Undo, "I paid it back" or Not received is in flight, until the refetch after it
   * has finished. `payerId`: the pair's payer (the row's group); absent matches any group.
   */
  busy: { userId: string; payerId?: string; kind: 'unmark' | 'difference' | 'not_received' } | null;
  error: string | null;
  /** One muted line under the rows (the payer's web line, R3 / SE-UX-11), or null. */
  footnote: string | null;
  /** A short polite confirmation ("Marked paid back", SE-UX-12) until the next action, or null. */
  announcement: string | null;
  /** Undo on `userId`'s row, for the pair to `payerId` (lib's stamp, else the row's group). */
  onUndo: (userId: string, payerId: string | undefined) => void;
  /** The payer tapped a row's Venmo link (Request or Pay back); the screen opens it. */
  onOpenLink: (link: RowLink, kind: 'request' | 'pay_back') => void;
  /** The payer tapped "I paid it back". */
  onRecord: (action: RecordAction) => void;
  /** The payer confirmed Not received on a row. */
  onNotReceived: (action: NotReceivedAction) => void;
};

/**
 * Which inline confirm is open: a row's Undo, or its Not received with the mark it was opened for
 * (review R2). A re-send (new settled_at) or a new amount closes it, so the confirm never clears a
 * payment the payer didn't see.
 */
type Confirming =
  | { key: string; userId: string; kind: 'undo' }
  | { key: string; userId: string; kind: 'not_received'; expectedAt: string; expectedCents: number };

type Group = { recipientId: string | null; label: string | null; rows: SettleRowModel[] };

function toneColor(c: Palette, tone: 'success' | 'muted' | 'warning'): string {
  return tone === 'success' ? c.success : tone === 'warning' ? c.warning : c.textMuted;
}

export function SettlePeopleList({ model, busy, error, footnote, announcement, onUndo, onOpenLink, onRecord, onNotReceived }: Props) {
  const { colors } = useTheme();
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  // A confirm only stays open while its row still offers that control (a live refetch may have removed it).
  const groups: Group[] = model.groups ?? [{ recipientId: null, label: null, rows: model.rows }];
  const keyed = groups.flatMap((g) => g.rows.map((r) => ({ key: `${g.recipientId ?? ''}:${r.userId}`, row: r })));
  const stillOffered = (c: Confirming) =>
    keyed.some(({ key, row: r }) => {
      if (key !== c.key) return false;
      if (c.kind === 'undo') return r.undo !== null;
      const now = r.notReceived?.action;
      return now !== undefined && now.expectedAt === c.expectedAt && now.expectedCents === c.expectedCents;
    });
  const open = confirming !== null && stillOffered(confirming) ? confirming : null;
  const undoOpen = open?.kind === 'undo' ? open.key : null;
  const notReceivedOpen = open?.kind === 'not_received' ? open.key : null;
  /** This row's control is the one in flight (the same person and, when known, the same pair). */
  const busyHere = (row: SettleRowModel, recipientId: string | null, kind: 'unmark' | 'difference' | 'not_received') =>
    busy?.kind === kind && busy.userId === row.userId && (busy.payerId === undefined || recipientId === null || busy.payerId === recipientId);

  return (
    <Card title={model.title} aside={model.aside ?? undefined}>
      {groups.map((group, gi) => (
        <View key={group.recipientId ?? 'all'}>
          {group.label !== null ? (
            <Text
              accessibilityRole="header"
              style={[type.caption, styles.groupLabel, gi > 0 && styles.groupApart, { color: colors.textMuted }]}
            >
              {group.label}
            </Text>
          ) : null}
          {group.rows.map((row, i) => {
            const key = `${group.recipientId ?? ''}:${row.userId}`;
            return (
              <View key={key} style={[styles.row, i > 0 && [styles.divider, { borderTopColor: colors.divider }]]}>
                <RowMain row={row} wide={model.wideStatus} />
                {row.request !== null ? <LinkLine link={row.request} onOpen={(l) => onOpenLink(l, 'request')} /> : null}
                {row.payBack !== null ? (
                  <PayBackLines
                    payBack={row.payBack}
                    disabled={busy !== null}
                    loading={busyHere(row, group.recipientId, 'difference')}
                    onOpen={(l) => onOpenLink(l, 'pay_back')}
                    onRecord={onRecord}
                  />
                ) : null}
                {row.notReceived !== null && notReceivedOpen !== key ? (
                  <TextLink
                    label={row.notReceived.label}
                    accessibilityLabel={row.notReceived.a11yLabel}
                    accessibilityHint={row.notReceived.a11yHint}
                    disabled={busy !== null}
                    loading={busyHere(row, group.recipientId, 'not_received')}
                    onPress={() => {
                      const { expectedAt, expectedCents } = row.notReceived?.action ?? { expectedAt: '', expectedCents: 0 };
                      setConfirming({ key, userId: row.userId, kind: 'not_received', expectedAt, expectedCents });
                    }}
                    // It clears someone else's record: extra room from a pay-back control above (SV-VIS-9).
                    style={[styles.endLink, row.payBack !== null && styles.apart]}
                  />
                ) : null}
                {row.notReceived !== null && notReceivedOpen === key ? (
                  <Banner tone="warning">
                    <BannerText>{row.notReceived.confirmText}</BannerText>
                    <View style={styles.buttons}>
                      <Button
                        label={row.notReceived.confirmLabel}
                        variant="danger"
                        accessibilityLabel={row.notReceived.confirmA11yLabel}
                        style={styles.confirmButton}
                        onPress={() => {
                          const action = row.notReceived?.action;
                          setConfirming(null);
                          if (action) onNotReceived(action);
                        }}
                      />
                      <Button
                        label={row.notReceived.cancelLabel}
                        accessibilityLabel={row.notReceived.cancelA11yLabel}
                        variant="ghost"
                        style={styles.confirmButton}
                        onPress={() => setConfirming(null)}
                      />
                    </View>
                  </Banner>
                ) : null}
                {row.undo !== null && undoOpen !== key ? (
                  <Button
                    label={SETTLE_COPY.undo}
                    variant="ghost"
                    accessibilityLabel={row.undo.a11yLabel}
                    accessibilityHint="Asks before clearing their mark"
                    disabled={busy !== null}
                    loading={busyHere(row, group.recipientId, 'unmark')}
                    onPress={() => setConfirming({ key, userId: row.userId, kind: 'undo' })}
                    flush="end"
                    style={styles.end}
                  />
                ) : null}
                {row.undo !== null && undoOpen === key ? (
                  <Banner tone="warning">
                    <BannerText>{row.undo.confirmText}</BannerText>
                    <View style={styles.buttons}>
                      <Button
                        label={SETTLE_COPY.undo}
                        variant="danger"
                        accessibilityLabel={`Confirm: ${row.undo.a11yLabel}`}
                        style={styles.confirmButton}
                        onPress={() => {
                          const target = row.userId;
                          const pair = row.undo?.payerId ?? group.recipientId ?? undefined;
                          setConfirming(null);
                          onUndo(target, pair);
                        }}
                      />
                      <Button
                        label={SETTLE_COPY.cancel}
                        accessibilityLabel={`${SETTLE_COPY.cancel}: keep ${row.name}'s I paid`}
                        variant="ghost"
                        style={styles.confirmButton}
                        onPress={() => setConfirming(null)}
                      />
                    </View>
                  </Banner>
                ) : null}
              </View>
            );
          })}
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
        flush="end"
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
        flush="end"
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
  // A group's label sits right above its rows; a later group gets room from the one before.
  groupLabel: { fontWeight: '600' },
  groupApart: { marginTop: space.md },
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
  // TextLink hugs its label at the leading edge by default; on a row it sits flush right.
  endLink: { alignSelf: 'flex-end' },
  apart: { marginTop: space.sm },
  // Handle left, control right; at large text the control wraps to its own line, still flush right.
  linkLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space.sm },
  grow: { flex: 1, minWidth: 0 },
  pushRight: { marginLeft: 'auto' },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  // QA F2: at 200% zoom or large text a confirm button can be wider than the Banner's text column.
  // It shrinks to that width (the label wraps inside, Button's label has flexShrink) instead of
  // overflowing the Banner and the card; Button's minHeight keeps the 44-pt target.
  confirmButton: { flexShrink: 1, maxWidth: '100%' },
});
