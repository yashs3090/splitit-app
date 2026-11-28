// Record a payment (spec docs/specs/2026-11-26-groups-mvp.md T16, A2.2): for cash, part of what's
// owed, or anything paid outside the Venmo button. Inline on the Settle screen (no modal): which way,
// who, how much, how (Cash by default), Save. An amount over the suggestion between the two warns
// first ("That's more than you owe Dee ($174.97).") and needs a second tap, "Save anyway".
//
// Validation and the warning come from lib (recordAmount, recordPaymentCheck); the form does no money
// math. A failed save keeps everything typed and re-enables Save. The person picker is a radio list:
// the app has no radio row primitive, so this file draws one from tokens (44 pt, focus ring).
import Check from 'lucide-react-native/icons/check';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { TextField } from '@/components/ui/TextField';
import { useFocusRing } from '@/components/ui/useFocusRing';
import { ariaProps } from '@/lib/ariaProps';
import type { NameOf } from '@/lib/billView';
import type { GroupError, GroupSnapshot } from '@/lib/groups';
import { otherMembers, RECORD_METHODS, RECORD_PAYMENT_COPY as COPY, recordAmount, suggestionFor } from '@/lib/groupSettleText';
import { recordPaymentCheck, type GroupSettleModel } from '@/lib/groupSettleView';
import type { PaymentMethod } from '@/lib/paymentMethods';
import { radius, ROW_MIN_HEIGHT, space, type, useTheme } from '@/lib/theme';

type Direction = 'paid' | 'got';

type Props = {
  snapshot: GroupSnapshot;
  model: Pick<GroupSettleModel, 'suggestions'>;
  viewerId: string;
  nameOf: NameOf;
  /** A write is in flight somewhere on the screen. */
  busy: boolean;
  /** This form's save is the write in flight. */
  saving: boolean;
  /** The last failed save's copy (from the screen's write error for 'form'). */
  error: string | null;
  /** Resolves to the error, or null when it saved. */
  onSave: (p: { from: string; to: string; cents: number; method: PaymentMethod }) => Promise<GroupError | null>;
  onClose: () => void;
};

/** Exported for the web aria test (__tests__/groupAriaWeb.test.tsx). */
export function PersonOption({ name, checked, onPress, divider }: { name: string; checked: boolean; onPress: () => void; divider: boolean }) {
  const { colors } = useTheme();
  const { focusProps, ringStyle } = useFocusRing();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={name}
      accessibilityState={{ checked }}
      // Web: react-native-web drops accessibilityState (lib/ariaProps.ts).
      {...ariaProps({ checked })}
      onPress={onPress}
      {...focusProps}
      style={({ pressed }) => [
        styles.option,
        divider && [styles.optionDivider, { borderTopColor: colors.divider }],
        pressed && { backgroundColor: colors.surfaceMuted },
        ringStyle,
      ]}
    >
      <Text style={[type.body, styles.flex, { color: colors.text }]}>{name}</Text>
      {checked ? <Icon icon={Check} color={colors.primary} /> : null}
    </Pressable>
  );
}

export function GroupPaymentForm({ snapshot, model, viewerId, nameOf, busy, saving, error, onSave, onClose }: Props) {
  const { colors } = useTheme();
  const [direction, setDirection] = useState<Direction>('paid');
  const [other, setOther] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [personError, setPersonError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);
  /** The exact input the over warning was shown for: a second Save with it saves anyway. */
  const [warnedFor, setWarnedFor] = useState<string | null>(null);
  const saveTap = useRef(false);

  const people = otherMembers(snapshot, viewerId, nameOf);
  const parsed = recordAmount(amount);
  const viewerPays = direction === 'paid';
  const check =
    other !== null && parsed.kind === 'ok' ? recordPaymentCheck(parsed.cents, suggestionFor(model, viewerId, other, viewerPays, nameOf)) : null;
  const inputKey = other !== null && parsed.kind === 'ok' ? `${direction}|${other}|${parsed.cents}` : null;
  const warning = check?.status === 'over' && warnedFor === inputKey ? check.text : null;

  const save = () => {
    if (busy || saveTap.current) return;
    const personMissing = other === null;
    const amountBad = parsed.kind !== 'ok';
    setPersonError(personMissing ? COPY.pickPerson : null);
    setAmountError(amountBad ? COPY.amountProblem : null);
    if (personMissing || amountBad || other === null || parsed.kind !== 'ok') return;
    if (check?.status === 'over' && warnedFor !== inputKey) {
      setWarnedFor(inputKey);
      return;
    }
    saveTap.current = true;
    const p = viewerPays
      ? { from: viewerId, to: other, cents: parsed.cents, method }
      : { from: other, to: viewerId, cents: parsed.cents, method };
    void onSave(p).then((err) => {
      saveTap.current = false;
      if (err === null) onClose();
    });
  };

  return (
    <Card>
      <Text accessibilityRole="header" style={[type.headline, { color: colors.text }]}>
        {COPY.title}
      </Text>
      <SegmentedControl
        options={[
          { value: 'paid', label: COPY.paid },
          { value: 'got', label: COPY.gotPaid },
        ]}
        value={direction}
        onChange={(d) => {
          setDirection(d);
          setWarnedFor(null);
        }}
        semantics="radio"
        groupLabel={COPY.direction}
        stretch
        disabled={saving}
      />

      <View style={styles.field} accessibilityRole="radiogroup" accessibilityLabel={viewerPays ? COPY.whoPaid : COPY.whoGotPaid}>
        <Text style={[type.label, { color: colors.text }]}>{viewerPays ? COPY.whoPaid : COPY.whoGotPaid}</Text>
        <View style={[styles.options, { borderColor: colors.border }]}>
          {people.map((p, i) => (
            <PersonOption
              key={p.userId}
              name={p.name}
              checked={other === p.userId}
              divider={i > 0}
              onPress={() => {
                if (saving) return;
                setOther(p.userId);
                setPersonError(null);
                setWarnedFor(null);
              }}
            />
          ))}
        </View>
        {personError !== null ? (
          <Text accessibilityRole="alert" style={[type.caption, { color: colors.danger }]}>
            {personError}
          </Text>
        ) : null}
      </View>

      <TextField
        label={COPY.amount}
        showLabel
        prefix="$"
        numeric
        keyboardType="decimal-pad"
        placeholder="0.00"
        value={amount}
        onChangeText={(t) => {
          setAmount(t);
          setAmountError(null);
          setWarnedFor(null);
        }}
        error={amountError ?? undefined}
        editable={!saving}
        returnKeyType="done"
        onSubmitEditing={save}
      />

      <View style={styles.field}>
        <Text style={[type.label, { color: colors.text }]}>{COPY.method}</Text>
        <SegmentedControl
          options={RECORD_METHODS.map((m) => ({ value: m.value, label: m.label, accessibilityLabel: `${m.label}, ${COPY.method.toLowerCase()} it was paid` }))}
          value={method}
          onChange={setMethod}
          semantics="radio"
          groupLabel={COPY.method}
          disabled={saving}
          style={styles.hug}
        />
      </View>

      {warning !== null ? (
        <Text accessibilityRole="alert" style={[type.caption, styles.strong, { color: colors.warning }]}>
          {warning}
        </Text>
      ) : null}
      {error !== null ? (
        <Text accessibilityRole="alert" style={[type.caption, { color: colors.danger }]}>
          {error}
        </Text>
      ) : null}

      <View style={styles.buttons}>
        <Button label={warning !== null ? COPY.saveAnyway : COPY.save} variant="secondary" onPress={save} loading={saving} disabled={busy && !saving} />
        <Button label={COPY.cancel} variant="ghost" onPress={onClose} disabled={saving} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  field: { gap: space.xs },
  options: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, overflow: 'hidden' },
  option: { flexDirection: 'row', alignItems: 'center', minHeight: ROW_MIN_HEIGHT, paddingHorizontal: space.md, gap: space.md },
  optionDivider: { borderTopWidth: StyleSheet.hairlineWidth },
  flex: { flex: 1 },
  hug: { alignSelf: 'flex-start' },
  strong: { fontWeight: '600' },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
});
