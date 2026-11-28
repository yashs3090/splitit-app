// The invite QR popup: "Show QR code" in components/SharePanel.tsx (bills) and
// components/GroupInvite.tsx (groups) opens it so a friend at the table can scan a big code.
// It shows a title (copy from lib/inviteQr.ts, passed in), the QR as large as fits, the link
// (selectable, middle-elided), "Copy link" with its "Link copied" line, and "Done".
// Presentation follows components/ItemSheet.tsx: iOS uses the system page sheet (swipe down to
// close); Android and web a bottom sheet over a scrim (tap outside, Android back or web Escape
// closes). Kept small so it can move onto a shared components/ui/Sheet.tsx later (splitit-app-96).
//
// Focus: on open, screen readers land on the title (native; web's Modal focus trap moves focus into
// the sheet itself). On close it returns to `returnFocusTo` (the "Show QR code" link): iOS after the
// sheet has finished sliding away (onDismiss), Android when it closes; web's Modal restores focus
// to the element that opened it on its own.
// Decisions: docs/decisions-to-review.md ("QR popup").
import * as Clipboard from 'expo-clipboard';
import { useContext, useEffect, useRef, useState, type RefObject } from 'react';
import {
  AccessibilityInfo,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { InviteQr } from '@/components/InviteQr';
import { Button } from '@/components/ui/Button';
import { StatusLine } from '@/components/ui/StatusLine';
import { INVITE_QR_COPY, qrTileLayout } from '@/lib/inviteQr';
import { layout, radius, space, type, useTheme } from '@/lib/theme';

type Props = {
  visible: boolean;
  /** "Scan to join Tahoe trip" / "Scan to join this bill" (lib/inviteQr.ts qrSheetTitle). */
  title: string;
  /** The invite link, encoded exactly as given. */
  url: string;
  onClose: () => void;
  /** Where screen-reader focus goes back to when the sheet closes. */
  returnFocusTo?: RefObject<View | null>;
};

function focusOn(target: View | null | undefined) {
  if (Platform.OS === 'web' || target == null) return;
  AccessibilityInfo.sendAccessibilityEvent(target, 'focus');
}

export function QrSheet({ visible, title, url, onClose, returnFocusTo }: Props) {
  const { colors } = useTheme();
  // The panels that open it are also rendered alone (tests, previews): no provider means no inset.
  const bottomInset = useContext(SafeAreaInsetsContext)?.bottom ?? 0;
  const { width, height } = useWindowDimensions();
  const { size, quietZone } = qrTileLayout(width, height);
  const titleRef = useRef<Text>(null);

  // A "Link copied" note belongs to this opening and this link.
  const [copy, setCopy] = useState<{ state: 'copied' | 'failed'; url: string } | null>(null);
  const copyState = copy !== null && copy.url === url ? copy.state : null;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Android: focus goes back as soon as the sheet closes (iOS waits for onDismiss below).
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (wasVisible.current && !visible) {
      setCopy(null);
      if (Platform.OS === 'android') focusOn(returnFocusTo?.current);
    }
    wasVisible.current = visible;
  }, [visible, returnFocusTo]);

  async function onCopy() {
    let ok = false;
    try {
      ok = await Clipboard.setStringAsync(url);
    } catch {
      ok = false;
    }
    if (!mounted.current) return;
    setCopy({ state: ok ? 'copied' : 'failed', url });
    // VoiceOver ignores live regions; Android and web read StatusLine's.
    if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(ok ? INVITE_QR_COPY.copied : INVITE_QR_COPY.copyFailed);
  }

  const body = (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text ref={titleRef} accessibilityRole="header" style={[type.title, styles.center, { color: colors.text }]}>
        {title}
      </Text>
      <InviteQr url={url} size={size} quietZone={quietZone} />
      {/* One line in a quiet inset; the middle is elided so the domain and the code's end both show. */}
      <View style={[styles.url, { backgroundColor: colors.surfaceMuted }]}>
        <Text
          selectable
          numberOfLines={1}
          ellipsizeMode="middle"
          accessibilityLabel={INVITE_QR_COPY.linkA11y(url)}
          style={[type.body, styles.center, { color: colors.text }]}
        >
          {url}
        </Text>
      </View>
      <View style={styles.actions}>
        <Button label={INVITE_QR_COPY.copy} variant="secondary" block onPress={() => void onCopy()} />
        {copyState !== null ? (
          <StatusLine
            text={copyState === 'copied' ? INVITE_QR_COPY.copied : INVITE_QR_COPY.copyFailed}
            tone={copyState === 'copied' ? 'success' : 'error'}
            alert={copyState === 'failed'}
            style={styles.status}
          />
        ) : null}
        <Button label={INVITE_QR_COPY.done} variant="primary" block onPress={onClose} />
      </View>
    </ScrollView>
  );

  const onShow = () => focusOn(titleRef.current);

  if (Platform.OS === 'ios') {
    return (
      <Modal
        visible={visible}
        presentationStyle="pageSheet"
        allowSwipeDismissal
        animationType="slide"
        onRequestClose={onClose}
        onShow={onShow}
        onDismiss={() => focusOn(returnFocusTo?.current)}
      >
        <View accessibilityViewIsModal style={[styles.pageSheet, { backgroundColor: colors.surface, paddingBottom: bottomInset + space.lg }]}>
          {body}
        </View>
      </Modal>
    );
  }

  return (
    <Modal transparent animationType="slide" visible={visible} onRequestClose={onClose} onShow={onShow}>
      <View style={styles.backdropWrap}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={INVITE_QR_COPY.close}
          onPress={onClose}
          // Web: not a Tab stop, so the focus trap lands on Copy link; Escape closes instead.
          focusable={false}
          style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }]}
        />
        <View accessibilityViewIsModal style={[styles.sheet, { backgroundColor: colors.surface, paddingBottom: bottomInset + space.lg }]}>
          {body}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdropWrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    width: '100%',
    maxWidth: layout.content,
    maxHeight: '92%',
    alignSelf: 'center',
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderCurve: 'continuous',
  },
  // The system draws the page sheet's shape; it just fills it.
  pageSheet: { flex: 1 },
  content: { padding: space.lg, paddingTop: space.xl, gap: space.lg, alignItems: 'stretch' },
  center: { textAlign: 'center' },
  url: { paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.sm, borderCurve: 'continuous' },
  actions: { gap: space.sm },
  status: { alignSelf: 'center' },
});
