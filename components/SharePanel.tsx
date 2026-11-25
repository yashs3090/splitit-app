// The share panel on the bill screen: the invite link, "Copy link", "Share…", and (host only)
// "Make a new link". Spec: docs/specs/2026-11-20-m1b-m2-share-and-claim.md (Task 12; A1 Q6).
// "From contacts" (every participant, iOS and Android only; Task 10) sits next to Copy link and Share….
// "Add people" (host only, shown when `onAddPeople` is set): docs/specs/2026-11-24-people-and-invites.md (D6, Task 7).
// Any participant can share; only the host can replace the link, after an inline confirmation
// (React Native Web has no Alert dialog, so the confirmation is part of the panel on every platform).
// "Show QR code" (every participant) folds out a QR of the same link under the buttons
// (components/InviteQr.tsx; docs/decisions-to-review.md "Invite QR").
import * as Clipboard from 'expo-clipboard';
import Plus from 'lucide-react-native/icons/plus';
import QrCode from 'lucide-react-native/icons/qr-code';
import { useState } from 'react';
import { Platform, Share, StyleSheet, Text, View } from 'react-native';

import { ContactInvite } from '@/components/ContactInvite';
import { INVITE_QR_COPY, InviteQr } from '@/components/InviteQr';
import { Banner, BannerText } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { StatusLine } from '@/components/ui/StatusLine';
import { TextLink } from '@/components/ui/TextLink';
import { inviteMessage } from '@/lib/contactInvite';
import { contactsSupported } from '@/lib/contactPicker';
import { PEOPLE_COPY } from '@/lib/peopleView';
import { radius, space, type, useTheme } from '@/lib/theme';

const COPIED = 'Link copied';
const COPY_FAILED = "Couldn't copy. Select the link and copy it yourself.";
const ROTATE_CONFIRM = 'The old link will stop working. People already in the bill stay in.';
const ROTATE_FAILED = "Couldn't make a new link. Try again.";

type Props = {
  url: string;
  isHost: boolean;
  /** Replaces the join code; resolves true on success. */
  onRotate: () => Promise<boolean>;
  /** Opens Add people. The bill screen passes it for the host only. */
  onAddPeople?: () => void;
};

/** The native share sheet exists everywhere except web browsers without navigator.share. */
function canShare(): boolean {
  if (Platform.OS !== 'web') return true;
  const nav = (globalThis as { navigator?: { share?: unknown } }).navigator;
  return typeof nav?.share === 'function';
}

export function SharePanel({ url, isHost, onRotate, onAddPeople }: Props) {
  const { colors } = useTheme();
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [confirming, setConfirming] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateFailed, setRotateFailed] = useState(false);
  // Folded by default (opt-in, like the other quiet extras); stays open across a new link, which redraws it.
  const [showQr, setShowQr] = useState(false);
  // A copied-link note belongs to the link it was about.
  const [copiedUrl, setCopiedUrl] = useState(url);
  const copyState = copiedUrl === url ? copy : 'idle';

  async function onCopy() {
    let ok = false;
    try {
      ok = await Clipboard.setStringAsync(url);
    } catch {
      ok = false;
    }
    setCopiedUrl(url);
    setCopy(ok ? 'copied' : 'failed');
  }

  async function onShare() {
    try {
      await Share.share({ message: inviteMessage(url) });
    } catch {
      // Dismissed or unavailable: nothing to tell the person; the link is still on screen.
    }
  }

  async function onConfirmRotate() {
    if (rotating) return;
    setRotating(true);
    setRotateFailed(false);
    const ok = await onRotate();
    setRotating(false);
    if (ok) setConfirming(false);
    else setRotateFailed(true);
  }

  return (
    <Card title="Invite friends">
      {onAddPeople ? (
        <Button
          label={PEOPLE_COPY.addPeople}
          accessibilityLabel={PEOPLE_COPY.addPeople}
          accessibilityHint={PEOPLE_COPY.addPeopleHint}
          variant="secondary"
          icon={Plus}
          onPress={onAddPeople}
        />
      ) : null}
      <Text style={[type.caption, { color: colors.textMuted }]}>
        Anyone with this link can join and claim what they had.
      </Text>
      {/* One line in a quiet inset; the middle is elided so the domain and the code's end both show. */}
      <View style={[styles.url, { backgroundColor: colors.surfaceMuted }]}>
        <Text
          selectable
          numberOfLines={1}
          ellipsizeMode="middle"
          accessibilityLabel={`Invite link ${url}`}
          style={[type.body, { color: colors.text }]}
        >
          {url}
        </Text>
      </View>
      <View style={styles.buttons}>
        <Button label="Copy link" variant="secondary" onPress={() => void onCopy()} />
        {canShare() ? (
          <Button
            label="Share…"
            variant="secondary"
            accessibilityHint="Opens your phone's share options"
            onPress={() => void onShare()}
          />
        ) : null}
        {contactsSupported ? <ContactInvite url={url} /> : null}
      </View>
      {copyState !== 'idle' ? (
        <StatusLine text={copyState === 'copied' ? COPIED : COPY_FAILED} tone={copyState === 'copied' ? 'success' : 'error'} />
      ) : null}

      <TextLink
        label={showQr ? INVITE_QR_COPY.hide : INVITE_QR_COPY.show}
        accessibilityHint={showQr ? undefined : INVITE_QR_COPY.showHint}
        accessibilityState={{ expanded: showQr }}
        icon={QrCode}
        onPress={() => setShowQr((v) => !v)}
      />
      {showQr ? <InviteQr url={url} /> : null}

      {isHost && !confirming ? (
        <TextLink
          label="Make a new link"
          accessibilityHint="Asks before turning off the current link"
          onPress={() => {
            setRotateFailed(false);
            setConfirming(true);
          }}
        />
      ) : null}
      {isHost && confirming ? (
        <Banner tone="warning">
          <BannerText>{ROTATE_CONFIRM}</BannerText>
          {rotateFailed ? <BannerText>{ROTATE_FAILED}</BannerText> : null}
          <View style={styles.buttons}>
            <Button label="Make new link" variant="danger" loading={rotating} onPress={() => void onConfirmRotate()} />
            <Button label="Cancel" variant="ghost" disabled={rotating} onPress={() => setConfirming(false)} />
          </View>
        </Banner>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  url: { paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.sm, borderCurve: 'continuous' },
});
