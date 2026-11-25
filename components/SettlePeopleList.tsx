// The Settle screen's Everyone list: who owes the payer, and who has marked "I paid" (brief §4).
// Undo on someone else's row asks first, inline (React Native Web has no Alert; SharePanel pattern).
// Renders lib/settleView.ts's rows only.
// The payer's rows also carry a Request control (request spec R2/R3): a muted @handle with a small
// ghost "Request" under the status column, or a muted caption saying why there is none. It sits
// outside the grouped row, as Undo does, so the row's label stays "Sam, $15.10, not paid yet".
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Banner, BannerText } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { MoneyText } from '@/components/ui/MoneyText';
import { ToneIcon } from '@/components/ui/ToneIcon';
import {
  SETTLE_COPY,
  type SettlePeopleModel,
  type SettleRowModel,
  type SettleRowRequest,
} from '@/lib/settleView';
import { space, TOUCH_TARGET, type, useTheme } from '@/lib/theme';

type Props = {
  model: SettlePeopleModel;
  /** The user whose mark is being undone, while the call and its refetch are in flight. */
  busyUserId: string | null;
  error: string | null;
  /** One muted line under the rows (the payer's web line, R3), or null. */
  footnote: string | null;
  onUndo: (userId: string) => void;
  /** The payer tapped Request on a row; the screen opens the link. */
  onRequest: (request: Extract<SettleRowRequest, { kind: 'link' }>) => void;
};

export function SettlePeopleList({ model, busyUserId, error, footnote, onUndo, onRequest }: Props) {
  const { colors } = useTheme();
  const [confirming, setConfirming] = useState<string | null>(null);
  // A confirm only stays open while its row still offers Undo (a live refetch may have removed it).
  const open = confirming !== null && model.rows.some((r) => r.userId === confirming && r.undo !== null) ? confirming : null;

  return (
    <Card title={model.title} aside={model.aside ?? undefined}>
      {model.rows.map((row, i) => (
        <View key={row.userId} style={[styles.row, i > 0 && [styles.divider, { borderTopColor: colors.divider }]]}>
          <RowMain row={row} />
          {row.request !== null ? <RequestLine request={row.request} onRequest={onRequest} /> : null}
          {row.undo !== null && open !== row.userId ? (
            <Button
              label={SETTLE_COPY.undo}
              variant="ghost"
              accessibilityLabel={row.undo.a11yLabel}
              accessibilityHint="Asks before clearing their mark"
              disabled={busyUserId !== null}
              loading={busyUserId === row.userId}
              onPress={() => setConfirming(row.userId)}
              style={styles.undo}
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
      {footnote !== null ? <Text style={[type.caption, { color: colors.textMuted }]}>{footnote}</Text> : null}
      {error !== null ? (
        <Banner tone="error" alert>
          <BannerText>{error}</BannerText>
        </Banner>
      ) : null}
    </Card>
  );
}

/** Q1: muted @handle + ghost Request. Q2–Q4: the muted caption alone. */
function RequestLine({
  request,
  onRequest,
}: {
  request: SettleRowRequest;
  onRequest: (request: Extract<SettleRowRequest, { kind: 'link' }>) => void;
}) {
  const { colors } = useTheme();
  if (request.kind === 'caption') {
    return <Text style={[type.caption, { color: colors.textMuted }]}>{request.caption}</Text>;
  }
  return (
    <View style={styles.requestLine}>
      {/* The button's label already says the handle; screen readers hear it once. */}
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        numberOfLines={1}
        style={[type.caption, styles.grow, { color: colors.textMuted }]}
      >
        {request.caption}
      </Text>
      <Button
        label={request.label}
        variant="ghost"
        accessibilityLabel={request.a11yLabel}
        accessibilityHint={request.a11yHint}
        onPress={() => onRequest(request)}
        style={styles.request}
      />
    </View>
  );
}

function RowMain({ row }: { row: SettleRowModel }) {
  const { colors } = useTheme();
  return (
    <View accessible accessibilityLabel={row.a11yLabel} style={styles.main}>
      <View style={styles.line}>
        <Text style={[type.body, styles.name, { color: colors.text }]}>{row.name}</Text>
        <MoneyText cents={row.amountCents} />
        {row.status !== null ? (
          <View style={[styles.status, styles.statusRow]}>
            <ToneIcon tone={row.status.tone} color={colors.success} />
            <Text
              style={[
                type.caption,
                styles.statusText,
                { color: row.status.tone === 'success' ? colors.success : colors.textMuted },
              ]}
            >
              {row.status.text}
            </Text>
          </View>
        ) : (
          <View style={styles.status} />
        )}
      </View>
      {row.subLine !== null ? (
        <View style={styles.subLine}>
          <ToneIcon tone={row.subLine.tone} color={colors.warning} />
          <Text style={[type.caption, styles.shrink, { color: row.subLine.tone === 'warning' ? colors.warning : colors.textMuted }]}>
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
  // A fixed-width status column keeps the amounts lined up; it wraps under the name at large text sizes.
  status: { minWidth: 64 },
  statusRow: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'flex-start', gap: space.xs },
  statusText: { textAlign: 'right', fontWeight: '600' },
  subLine: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xs },
  shrink: { flexShrink: 1 },
  // Flush right under the status column; "Undo" alone is narrower than a 44-pt target.
  undo: { paddingHorizontal: 0, minWidth: TOUCH_TARGET, alignSelf: 'flex-end' },
  requestLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  grow: { flex: 1, minWidth: 0 },
  // Same flush-right treatment as Undo: quiet, but still a 44-pt target.
  request: { paddingHorizontal: 0, minWidth: TOUCH_TARGET },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});
