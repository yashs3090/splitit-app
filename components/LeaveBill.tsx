// "Leave this bill" for guests, shown only when rule L3 allows it (canLeave), with an inline
// confirm (web has no Alert). Spec: docs/specs/2026-11-24-people-and-invites.md (D4, D6; criterion 48).
// The bill screen does the call and, on success, the navigation home; this owns the confirm.
// Who paid S12 (docs/specs/2026-11-26-who-paid.md A1.5): a payer can't leave, and `blockedText`
// (lib/peopleView's leaveBlockedText) shows in place of the button, before any tap.
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Banner, BannerText } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { BILL_ERROR_COPY, type BillError } from '@/lib/bills';
import { PEOPLE_COPY } from '@/lib/peopleView';
import { layout, space, type, useTheme } from '@/lib/theme';

type Props = {
  /** canLeave(data, viewer): no claims, no "I paid" mark, not the payer, not the host. */
  canLeave: boolean;
  /** Why Leave is missing when they paid (S12), shown in its place; null or absent = say nothing. */
  blockedText?: string | null;
  /** Calls leave_bill. Resolves null on success (the screen then goes home), else the error. */
  onLeave: () => Promise<BillError | null>;
};

export function LeaveBill({ canLeave, blockedText = null, onLeave }: Props) {
  const { colors } = useTheme();
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<BillError | null>(null);
  const leavingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function onConfirm() {
    if (leavingRef.current) return;
    leavingRef.current = true;
    setLeaving(true);
    setError(null);
    const err = await onLeave();
    leavingRef.current = false;
    if (!mounted.current) return;
    setLeaving(false);
    if (err === null) return;
    setError(err);
    // cannot_leave: they hold a claim or a mark now; the refetch hides the button. A network error,
    // or busy (a lock clash aborted it, delete-group A3.4), keeps the confirm open to try again.
    if (err !== 'network' && err !== 'busy') setConfirming(false);
  }

  const errorBanner =
    error !== null ? (
      <Banner tone="error" alert>
        <BannerText>{BILL_ERROR_COPY[error]}</BannerText>
      </Banner>
    ) : null;

  if (!canLeave) {
    // A payer: the reason says what to do, and replaces a cannot_leave line worded for claims.
    if (blockedText !== null) {
      return <Text style={[type.caption, styles.reason, { color: colors.textMuted }]}>{blockedText}</Text>;
    }
    return errorBanner;
  }

  return (
    <View style={styles.wrap}>
      {errorBanner}
      {confirming ? (
        <Banner tone="warning">
          <BannerText>{PEOPLE_COPY.leaveConfirm}</BannerText>
          <View style={styles.buttons}>
            <Button
              label="Leave"
              accessibilityLabel="Leave"
              accessibilityHint="Takes you off this bill"
              variant="danger"
              loading={leaving}
              onPress={() => void onConfirm()}
            />
            <Button label="Cancel" accessibilityLabel="Cancel" variant="ghost" disabled={leaving} onPress={() => setConfirming(false)} />
          </View>
        </Banner>
      ) : (
        <Button
          label={PEOPLE_COPY.leave}
          accessibilityLabel={PEOPLE_COPY.leave}
          accessibilityHint={PEOPLE_COPY.leaveHint}
          variant="ghost"
          onPress={() => {
            setError(null);
            setConfirming(true);
          }}
          style={styles.centered}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  centered: { alignSelf: 'center' },
  reason: { textAlign: 'center', alignSelf: 'center', maxWidth: layout.message },
});
