// The group's invite panel: the link, Copy link, Share…, From contacts (iOS and Android), Show QR
// code, and "Make a new link" with an inline confirm. Any member can do all of it (GR-23).
// Spec: docs/specs/2026-11-26-groups-mvp.md T13 (GroupInvite), GR-28 (the share message has no
// group name). Same patterns as components/SharePanel.tsx (bills). "Show QR code"
// opens components/QrSheet.tsx, titled with the group's name.
// The group screen (T14) renders it and owns the snapshot: `joinCode` comes from it, and
// `onRotated` hands the new code back so the screen can refetch.
// "From contacts" sends the same group message as Share… (GR-T13-5).
import * as Clipboard from 'expo-clipboard';
import QrCode from 'lucide-react-native/icons/qr-code';
import { useEffect, useRef, useState } from 'react';
import { Platform, Share, StyleSheet, Text, View } from 'react-native';

import { ContactInvite } from '@/components/ContactInvite';
import { QrSheet } from '@/components/QrSheet';
import { Banner, BannerText } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { StatusLine } from '@/components/ui/StatusLine';
import { TextLink } from '@/components/ui/TextLink';
import { contactsSupported } from '@/lib/contactPicker';
import { groupInviteUrl } from '@/lib/groupInviteLink';
import { rotateGroupCode } from '@/lib/groups';
import { INVITE_QR_COPY, qrSheetTitle } from '@/lib/inviteQr';
import { radius, space, type, useTheme } from '@/lib/theme';

export const GROUP_INVITE_COPY = {
  title: 'Invite people',
  caption: 'Anyone with this link can join the group and see its costs.',
  linkA11y: (url: string) => `Invite link ${url}`,
  copy: 'Copy link',
  copied: 'Link copied',
  copyFailed: "Couldn't copy. Select the link and copy it yourself.",
  share: 'Share…',
  shareHint: "Opens your phone's share options",
  rotate: 'Make a new link',
  rotateHint: 'Asks before turning off the current link',
  rotateConfirm: 'The old link will stop working. People already in the group stay in.',
  rotateConfirmButton: 'Make new link',
  rotateFailed: "Couldn't make a new link. Try again.",
  cancel: 'Cancel',
  /** GR-28: the link only, no group name. */
  message: (url: string) => `Join our group on SplitIt: ${url}`,
} as const;

type Props = {
  groupId: string;
  /** The group's current join code (from the snapshot). */
  joinCode: string;
  /** Called with the new code after "Make new link" succeeds. */
  onRotated: (joinCode: string) => void;
  /** The group's name, for the QR popup's title ("Scan to join Tahoe trip"). Not in the share message (GR-28). */
  groupName?: string;
};

/** The native share sheet exists everywhere except web browsers without navigator.share. */
function canShare(): boolean {
  if (Platform.OS !== 'web') return true;
  const nav = (globalThis as { navigator?: { share?: unknown } }).navigator;
  return typeof nav?.share === 'function';
}

/** The link for a code, or null if the code isn't well formed (never builds a link from junk). */
function urlFor(code: string): string | null {
  try {
    return groupInviteUrl(code);
  } catch {
    return null;
  }
}

export function GroupInvite({ groupId, joinCode, onRotated, groupName }: Props) {
  const { colors } = useTheme();
  // The newest code this panel knows: its own rotate result, until the screen passes a newer one.
  const [code, setCode] = useState(joinCode);
  useEffect(() => setCode(joinCode), [joinCode]);
  const url = urlFor(code);

  const [copy, setCopy] = useState<{ state: 'copied' | 'failed'; url: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateFailed, setRotateFailed] = useState(false);
  const [showQr, setShowQr] = useState(false);

  const qrTrigger = useRef<View>(null);
  const rotatingRef = useRef(false);
  // The share sheet is outside the app: repeat taps while it's open are ignored (lesson 2026-11-24).
  const sharingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  if (url === null) return null;
  // A "Link copied" note belongs to the link it was about.
  const copyState = copy !== null && copy.url === url ? copy.state : null;

  async function onCopy(link: string) {
    let ok = false;
    try {
      ok = await Clipboard.setStringAsync(link);
    } catch {
      ok = false;
    }
    if (mounted.current) setCopy({ state: ok ? 'copied' : 'failed', url: link });
  }

  async function onShare(link: string) {
    if (sharingRef.current) return;
    sharingRef.current = true;
    try {
      await Share.share({ message: GROUP_INVITE_COPY.message(link) });
    } catch {
      // Dismissed or unavailable: the link is still on screen.
    } finally {
      sharingRef.current = false;
    }
  }

  async function onConfirmRotate() {
    if (rotatingRef.current) return;
    rotatingRef.current = true;
    setRotating(true);
    setRotateFailed(false);
    const res = await rotateGroupCode(groupId);
    rotatingRef.current = false;
    if (!mounted.current) return;
    setRotating(false);
    if (res.ok) {
      setConfirming(false);
      setCode(res.joinCode);
      onRotated(res.joinCode);
    } else setRotateFailed(true);
  }

  return (
    <Card title={GROUP_INVITE_COPY.title}>
      <Text style={[type.caption, { color: colors.textMuted }]}>{GROUP_INVITE_COPY.caption}</Text>
      {/* One line in a quiet inset; the middle is elided so the domain and the code's end both show. */}
      <View style={[styles.url, { backgroundColor: colors.surfaceMuted }]}>
        <Text selectable numberOfLines={1} ellipsizeMode="middle" accessibilityLabel={GROUP_INVITE_COPY.linkA11y(url)} style={[type.body, { color: colors.text }]}>
          {url}
        </Text>
      </View>
      <View style={styles.buttons}>
        <Button label={GROUP_INVITE_COPY.copy} variant="secondary" onPress={() => void onCopy(url)} />
        {canShare() ? (
          <Button label={GROUP_INVITE_COPY.share} variant="secondary" accessibilityHint={GROUP_INVITE_COPY.shareHint} onPress={() => void onShare(url)} />
        ) : null}
        {contactsSupported ? <ContactInvite url={url} message={GROUP_INVITE_COPY.message} kind="group" /> : null}
      </View>
      {copyState !== null ? (
        <StatusLine
          text={copyState === 'copied' ? GROUP_INVITE_COPY.copied : GROUP_INVITE_COPY.copyFailed}
          tone={copyState === 'copied' ? 'success' : 'error'}
        />
      ) : null}

      <TextLink
        ref={qrTrigger}
        label={INVITE_QR_COPY.show}
        accessibilityHint={INVITE_QR_COPY.showHint}
        icon={QrCode}
        onPress={() => setShowQr(true)}
      />
      <QrSheet
        visible={showQr}
        title={qrSheetTitle({ kind: 'group', name: groupName })}
        url={url}
        onClose={() => setShowQr(false)}
        returnFocusTo={qrTrigger}
      />

      {confirming ? (
        <Banner tone="warning">
          <BannerText>{GROUP_INVITE_COPY.rotateConfirm}</BannerText>
          {rotateFailed ? <StatusLine text={GROUP_INVITE_COPY.rotateFailed} tone="error" size="caption" alert /> : null}
          <View style={styles.buttons}>
            <Button label={GROUP_INVITE_COPY.rotateConfirmButton} variant="danger" loading={rotating} onPress={() => void onConfirmRotate()} />
            <Button label={GROUP_INVITE_COPY.cancel} variant="ghost" disabled={rotating} onPress={() => setConfirming(false)} />
          </View>
        </Banner>
      ) : (
        <TextLink
          label={GROUP_INVITE_COPY.rotate}
          accessibilityHint={GROUP_INVITE_COPY.rotateHint}
          onPress={() => {
            setRotateFailed(false);
            setConfirming(true);
          }}
        />
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  url: { paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.sm, borderCurve: 'continuous' },
});
