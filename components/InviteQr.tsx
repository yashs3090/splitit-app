// The invite link as a QR code, for a friend at the same table to scan with their phone camera.
// Shown under the link in SharePanel behind "Show QR code". It encodes exactly the `url` it's given
// (SharePanel's, from lib/inviteLink.ts inviteUrl); it never builds a link itself.
// Decisions: docs/decisions-to-review.md ("Invite QR").
// Library: react-native-qrcode-svg (pure JS over react-native-svg), so it draws on web and native.
import { StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { qrColors, radius, space, type, useTheme } from '@/lib/theme';

export const INVITE_QR_COPY = {
  show: 'Show QR code',
  showHint: 'Shows a code friends can scan to open the invite link',
  hide: 'Hide QR code',
  caption: 'Friends can scan this with their phone camera.',
  imageLabel: 'QR code for the invite link',
} as const;

/** Modules drawn at 200 pt: about 6 pt each for a ~60-character link (a 33×33 code). */
const QR_SIZE = 200;
/**
 * The light margin around the code. Scanners need 4 modules of it; 24 pt is 4 modules at 6 pt.
 * Drawn by the tile's padding so it stays light in dark mode.
 */
const QUIET_ZONE = space.xl;

type Props = { url: string };

export function InviteQr({ url }: Props) {
  const { colors } = useTheme();
  return (
    <View style={styles.wrap}>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={INVITE_QR_COPY.imageLabel}
        style={[styles.tile, { backgroundColor: qrColors.background, borderColor: colors.divider }]}
      >
        {/* ecl "M" (15% recovery): a small code that still reads through glare and a scuffed screen. */}
        <QRCode value={url} size={QR_SIZE} color={qrColors.module} backgroundColor={qrColors.background} ecl="M" />
      </View>
      <Text style={[type.caption, styles.caption, { color: colors.textMuted }]}>{INVITE_QR_COPY.caption}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: space.sm },
  tile: {
    padding: QUIET_ZONE,
    borderRadius: radius.md,
    borderCurve: 'continuous',
    // A hairline so the white tile has an edge on a white card (light mode); decorative only.
    borderWidth: StyleSheet.hairlineWidth,
  },
  caption: { textAlign: 'center' },
});
