// ConfirmDialog: a small centred card over a scrim that asks before something that can't be taken
// back. Generic: the caller passes every word (lib/ owns the copy). First used by Delete group
// (docs/specs/2026-11-28-delete-group.md T5, DG-1): the user asked for a popup there, an exception to
// the group screen's inline-confirm rule. It's an in-app React Native Modal, not Alert.alert, so it
// looks and works the same on iOS, Android and web.
//
// - Ways to close: Cancel, the scrim, Android back and web Escape (both through onRequestClose). None
//   of them work while `busy` (the call is in flight), and Cancel is disabled then.
// - Focus: on show, focus lands on the title on every platform, never on the confirm button (review
//   R1: on web, react-native-web's focus trap would otherwise pick the first button, the destructive
//   one, so Enter would confirm). On web the title is a tabIndex -1 target, and it names the
//   role="dialog" element (aria-labelledby). On close focus goes back to `returnFocusTo` (native;
//   web's Modal restores focus to the element that opened it), as components/QrSheet.tsx does.
// - The card scrolls, so it fits at 200% zoom and the largest text size. Colours are theme tokens.
import { useContext, useEffect, useId, useRef, type RefObject } from 'react';
import { AccessibilityInfo, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { Button, type ButtonVariant } from '@/components/ui/Button';
import { StatusLine } from '@/components/ui/StatusLine';
import { layout, radius, space, type, useTheme } from '@/lib/theme';

type Props = {
  visible: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  confirmVariant?: ButtonVariant;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** The confirm call is in flight: Confirm shows a spinner, nothing else closes the dialog. */
  busy?: boolean;
  /** A failure to show under the buttons (an alert); the dialog stays open. */
  error?: string | null;
  /** Where screen-reader focus goes back to when the dialog closes (native). */
  returnFocusTo?: RefObject<View | null>;
};

function focusOn(target: View | Text | null | undefined) {
  if (target == null) return;
  if (Platform.OS === 'web') {
    // react-native-web's host node is the DOM element.
    (target as unknown as { focus?: () => void }).focus?.();
    return;
  }
  AccessibilityInfo.sendAccessibilityEvent(target, 'focus');
}

/** Web only: the title can take focus from code but isn't a Tab stop. */
const WEB_FOCUS_TARGET = Platform.OS === 'web' ? ({ tabIndex: -1 } as const) : {};

export function ConfirmDialog({
  visible,
  title,
  body,
  confirmLabel,
  confirmVariant = 'danger',
  cancelLabel,
  onConfirm,
  onCancel,
  busy = false,
  error = null,
  returnFocusTo,
}: Props) {
  const { colors } = useTheme();
  // Keeps a tall dialog (large text, 200% zoom) clear of the notch and home indicator. Rendered alone
  // (tests, previews) there's no provider and no inset.
  const insets = useContext(SafeAreaInsetsContext);
  const titleRef = useRef<Text>(null);
  const titleId = `confirm-dialog-title-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;

  // Focus goes back to the opener once the dialog has closed.
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (wasVisible.current && !visible && Platform.OS !== 'web') focusOn(returnFocusTo?.current);
    wasVisible.current = visible;
  }, [visible, returnFocusTo]);

  // VoiceOver ignores live regions; Android and web read the StatusLine's alert role.
  useEffect(() => {
    if (visible && error && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(error);
  }, [visible, error]);

  const cancel = () => {
    if (!busy) onCancel();
  };

  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={cancel}
      onShow={() => focusOn(titleRef.current)}
      // Web: react-native-web passes this to its role="dialog" element, so the dialog is named by its title.
      aria-labelledby={titleId}
    >
      <View style={[styles.backdrop, { paddingTop: (insets?.top ?? 0) + space.lg, paddingBottom: (insets?.bottom ?? 0) + space.lg }]}>
        {/* A tap outside cancels. Hidden from screen readers and not a Tab stop on web: it would be a
            second "Cancel" next to the real one (Escape and Android back also cancel). */}
        <Pressable
          testID="confirm-dialog-scrim"
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          aria-hidden
          onPress={cancel}
          focusable={false}
          style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }]}
        />
        <View accessibilityViewIsModal style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.divider }]}>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Text
              ref={titleRef}
              nativeID={titleId}
              {...WEB_FOCUS_TARGET}
              accessibilityRole="header"
              style={[type.title, { color: colors.text }]}
            >
              {title}
            </Text>
            {/* What goes and that it's for good: the part to read, so full text colour, not muted. */}
            <Text style={[type.body, { color: colors.text }]}>{body}</Text>
            <View style={styles.actions}>
              <Button label={confirmLabel} variant={confirmVariant} block onPress={onConfirm} loading={busy} />
              <Button label={cancelLabel} variant="ghost" block onPress={cancel} disabled={busy} />
            </View>
            {error ? <StatusLine text={error} tone="error" alert /> : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg },
  card: {
    width: '100%',
    maxWidth: layout.message,
    maxHeight: '100%',
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    // As components/ui/Card.tsx: a hairline edge, which also separates the card from the scrim in dark mode.
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  content: { padding: space.xl, gap: space.md },
  actions: { gap: space.sm, marginTop: space.sm },
});
