// "From contacts" in the Invite card (iOS and Android): pick a contact, choose a number if they
// have several, then send the bill link with Messages or WhatsApp. No modal; one flow at a time.
// Spec: docs/specs/2026-11-24-people-and-invites.md (D4 privacy, D6 contacts flow, Task 10, criteria 57–62).
//
// Privacy: the picked numbers live only in this component's state while the person chooses how to
// send. They are dropped on send, cancel, failure and unmount (sign-out unmounts the bill screen).
// Nothing is stored, logged or sent anywhere except to Messages or WhatsApp, by the person's choice.
//
// Renders a fragment: the button sits in SharePanel's button row, and the steps take a full row below it.
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { useFocusRing } from '@/components/ui/useFocusRing';
import { inviteMessage, phoneChoices, whatsAppUrl, type PhoneChoice } from '@/lib/contactInvite';
import { CONTACT_COPY, phoneChoiceA11yLabel, phoneLabelText } from '@/lib/contactInviteView';
import { pickContactPhones, sendSms, smsAvailable } from '@/lib/contactPicker';
import { opacity, radius, space, TOUCH_TARGET, type, useTheme } from '@/lib/theme';

type Step =
  | { kind: 'idle' }
  /** The system picker is open (or we're checking whether Messages works). */
  | { kind: 'picking' }
  | { kind: 'choose'; phones: PhoneChoice[] }
  /** `sending`: Messages or WhatsApp is opening; the buttons are locked. */
  | { kind: 'send'; number: string; sms: boolean; sending: boolean };

const IDLE: Step = { kind: 'idle' };

export function ContactInvite({ url }: { url: string }) {
  const { colors } = useTheme();
  const [step, setStep] = useState<Step>(IDLE);
  const [notice, setNotice] = useState<string | null>(null);
  /** True from the tap until the flow is back to idle: one picker, one composer at a time. */
  const active = useRef(false);
  const sending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Back to idle, dropping every number. */
  function finish(message: string | null = null) {
    active.current = false;
    sending.current = false;
    setStep(IDLE);
    setNotice(message);
    // iOS VoiceOver ignores live regions; Android and web read the notice's live region.
    if (message !== null && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(message);
  }

  async function toSend(number: string) {
    const sms = await smsAvailable();
    if (!mounted.current) return;
    setStep({ kind: 'send', number, sms, sending: false });
  }

  async function onPick() {
    if (active.current) return;
    active.current = true;
    setNotice(null);
    setStep({ kind: 'picking' });
    const res = await pickContactPhones();
    if (!mounted.current) return;
    switch (res.status) {
      case 'cancelled':
        finish();
        return;
      case 'denied':
        finish(CONTACT_COPY.denied);
        return;
      case 'error':
        finish(CONTACT_COPY.error);
        return;
      case 'picked': {
        const choices = phoneChoices(res.phones);
        const only = choices.length === 1 ? choices[0] : undefined;
        if (choices.length === 0) finish(CONTACT_COPY.noPhone);
        else if (only) await toSend(only.number);
        else setStep({ kind: 'choose', phones: choices });
        return;
      }
    }
  }

  async function onMessages(number: string) {
    if (sending.current) return;
    sending.current = true;
    setStep((s) => (s.kind === 'send' ? { ...s, sending: true } : s));
    const res = await sendSms(number, inviteMessage(url));
    if (!mounted.current) return;
    finish(res === 'error' ? CONTACT_COPY.error : null);
  }

  async function onWhatsApp(number: string) {
    if (sending.current) return;
    sending.current = true;
    setStep((s) => (s.kind === 'send' ? { ...s, sending: true } : s));
    let ok = true;
    try {
      await Linking.openURL(whatsAppUrl(number, inviteMessage(url)));
    } catch {
      ok = false;
    }
    if (!mounted.current) return;
    finish(ok ? null : CONTACT_COPY.whatsAppError);
  }

  return (
    <>
      <Button
        label={CONTACT_COPY.button}
        accessibilityLabel={CONTACT_COPY.button}
        accessibilityHint={CONTACT_COPY.hint}
        variant="secondary"
        loading={step.kind === 'picking'}
        disabled={step.kind !== 'idle'}
        onPress={() => void onPick()}
      />

      {step.kind === 'choose' ? (
        <View style={styles.panel}>
          <Text accessibilityRole="header" style={[type.label, { color: colors.text }]}>
            {CONTACT_COPY.whichNumber}
          </Text>
          {step.phones.map((phone) => {
            const label = phoneLabelText(phone.label);
            return (
              <NumberChoice
                key={phone.number}
                number={phone.number}
                label={label}
                accessibilityLabel={phoneChoiceA11yLabel(phone)}
                onPress={() => {
                  // Checking whether Messages works takes a moment; lock the list meanwhile.
                  setStep({ kind: 'picking' });
                  void toSend(phone.number);
                }}
              />
            );
          })}
          <Button label={CONTACT_COPY.cancel} accessibilityLabel={CONTACT_COPY.cancel} variant="ghost" onPress={() => finish()} />
        </View>
      ) : null}

      {step.kind === 'send' ? (
        <View style={styles.panel}>
          <Text style={[type.label, { color: colors.text }]}>{CONTACT_COPY.sendWith}</Text>
          <View style={styles.buttons}>
            {step.sms ? (
              <Button
                label={CONTACT_COPY.messages}
                accessibilityLabel={CONTACT_COPY.messages}
                accessibilityHint={CONTACT_COPY.messagesHint}
                variant="primary"
                disabled={step.sending}
                onPress={() => void onMessages(step.number)}
              />
            ) : null}
            <Button
              label={CONTACT_COPY.whatsApp}
              accessibilityLabel={CONTACT_COPY.whatsApp}
              accessibilityHint={CONTACT_COPY.whatsAppHint}
              variant={step.sms ? 'secondary' : 'primary'}
              disabled={step.sending}
              onPress={() => void onWhatsApp(step.number)}
            />
            <Button
              label={CONTACT_COPY.cancel}
              accessibilityLabel={CONTACT_COPY.cancel}
              variant="ghost"
              disabled={step.sending}
              onPress={() => finish()}
            />
          </View>
        </View>
      ) : null}

      {notice !== null ? (
        <Text
          accessibilityLiveRegion="polite"
          // Failures read in the danger color, like the card's "Couldn't copy"; "no phone number" isn't a failure.
          style={[type.caption, styles.fullRow, { color: notice === CONTACT_COPY.noPhone ? colors.text : colors.danger }]}
        >
          {notice}
        </Text>
      ) : null}
    </>
  );
}

/** One number to text, with its label ("Mobile"). */
function NumberChoice({
  number,
  label,
  accessibilityLabel,
  onPress,
}: {
  number: string;
  label: string | null;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const { focusProps, ringStyle } = useFocusRing();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      {...focusProps}
      style={({ pressed }) => [
        styles.choice,
        // Tonal, no outline: outlines are for inputs only.
        { backgroundColor: colors.surfaceMuted },
        pressed && styles.pressed,
        ringStyle,
      ]}
    >
      <Text style={[type.body, styles.grow, { color: colors.text }]}>{number}</Text>
      {label !== null ? <Text style={[type.caption, { color: colors.textMuted }]}>{label}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // In SharePanel's wrapping button row, a full-width child starts its own line.
  fullRow: { width: '100%' },
  // No fill of its own: it sits inside the invite card, so spacing groups it (no card in a card).
  panel: { width: '100%', gap: space.sm, paddingTop: space.xs },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
    borderCurve: 'continuous',
  },
  grow: { flex: 1, minWidth: 0 },
  pressed: { opacity: opacity.pressed },
});
