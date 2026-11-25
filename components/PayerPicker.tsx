// The host's "Who paid the bill?" list, with its inline confirm (brief §5). The screen decides
// whether to confirm (lib/settleView.ts pickerDecision, on freshly read data) and makes the call.
import Circle from 'lucide-react-native/icons/circle';
import CircleDot from 'lucide-react-native/icons/circle-dot';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Banner, BannerText } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { useFocusRing } from '@/components/ui/useFocusRing';
import { SETTLE_COPY, type PickerRow } from '@/lib/settleView';
import { radius, space, TOUCH_TARGET, type, useTheme } from '@/lib/theme';

/** `payerName`: who stays the payer if the host cancels (for the Cancel button's label). */
export type PickerConfirm = { targetId: string; text: string; button: string; payerName: string };

type Props = {
  rows: PickerRow[];
  /** The row being read or saved (shows a spinner; every row is disabled meanwhile). */
  busyId: string | null;
  confirm: PickerConfirm | null;
  saving: boolean;
  error: string | null;
  onPick: (userId: string) => void;
  onConfirm: () => void;
  onCancelConfirm: () => void;
};

export function PayerPicker({ rows, busyId, confirm, saving, error, onPick, onConfirm, onCancelConfirm }: Props) {
  const locked = busyId !== null || saving || confirm !== null;
  return (
    <Card title={SETTLE_COPY.pickerTitle}>
      <View accessibilityRole="radiogroup" accessibilityLabel={SETTLE_COPY.pickerTitle}>
        {rows.map((row) => (
          <PayerRow key={row.userId} row={row} locked={locked} busy={busyId === row.userId} onPick={onPick} />
        ))}
      </View>

      {error !== null ? (
        <Banner tone="error" alert>
          <BannerText>{error}</BannerText>
        </Banner>
      ) : null}

      {confirm !== null ? (
        <Banner tone="warning">
          <BannerText>{confirm.text}</BannerText>
          <View style={styles.buttons}>
            <Button label={confirm.button} accessibilityLabel={confirm.button} variant="danger" loading={saving} onPress={onConfirm} />
            <Button
              label={SETTLE_COPY.cancel}
              accessibilityLabel={`${SETTLE_COPY.cancel}: keep ${confirm.payerName}`}
              variant="ghost"
              disabled={saving}
              onPress={onCancelConfirm}
            />
          </View>
        </Banner>
      ) : null}
    </Card>
  );
}

function PayerRow({ row, locked, busy, onPick }: { row: PickerRow; locked: boolean; busy: boolean; onPick: (userId: string) => void }) {
  const { colors } = useTheme();
  const { focusProps, ringStyle } = useFocusRing();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={row.name}
      accessibilityState={{ checked: row.checked, disabled: locked, busy }}
      disabled={locked}
      onPress={() => onPick(row.userId)}
      {...focusProps}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceMuted }, ringStyle]}
    >
      {/* Checked differs by shape (dot) and weight, not only color. */}
      <Icon icon={row.checked ? CircleDot : Circle} size="lg" color={row.checked ? colors.primary : colors.textMuted} />
      <Text style={[type.body, styles.name, { color: colors.text }, row.checked && styles.checked]}>{row.name}</Text>
      {busy ? <ActivityIndicator size="small" color={colors.primary} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.xs,
    borderRadius: radius.sm,
    borderCurve: 'continuous',
  },
  name: { flex: 1, minWidth: 0 },
  checked: { fontWeight: '600' },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});
