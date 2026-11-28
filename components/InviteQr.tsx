// The invite link as a QR code, for a friend at the same table to scan with their phone camera.
// Drawn inside the QR popup (components/QrSheet.tsx) that "Show QR code" opens in SharePanel and
// GroupInvite. It encodes exactly the `url` it's given; it never builds a link itself.
// Decisions: docs/decisions-to-review.md ("Invite QR", "QR popup").
// Library: react-native-qrcode-svg (pure JS over react-native-svg), so it draws on web and native.
import { StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { INVITE_QR_COPY } from '@/lib/inviteQr';
import { qrColors, radius, space, type, useTheme } from '@/lib/theme';

// Kept here too so existing imports (`@/components/InviteQr`) still find the copy.
export { INVITE_QR_COPY };

type Props = {
  url: string;
  /** The code's side in points (lib/inviteQr.ts qrTileLayout). */
  size?: number;
  /** The light margin around the code, >= 4 modules (lib/inviteQr.ts qrTileLayout). */
  quietZone?: number;
};

export function InviteQr({ url, size = 200, quietZone = space.xl }: Props) {
  const { colors } = useTheme();
  return (
    <View style={styles.wrap}>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={INVITE_QR_COPY.imageLabel}
        // The quiet zone is the tile's padding, so it stays light in dark mode.
        style={[styles.tile, { padding: quietZone, backgroundColor: qrColors.background, borderColor: colors.divider }]}
      >
        {/* ecl "M" (15% recovery): a code that still reads through glare and a scuffed screen. */}
        <QRCode value={url} size={size} color={qrColors.module} backgroundColor={qrColors.background} ecl="M" />
      </View>
      <Text style={[type.caption, styles.caption, { color: colors.textMuted }]}>{INVITE_QR_COPY.caption}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: space.sm },
  tile: {
    borderRadius: radius.md,
    borderCurve: 'continuous',
    // A hairline so the white tile has an edge on a white surface (light mode); decorative only.
    borderWidth: StyleSheet.hairlineWidth,
  },
  caption: { textAlign: 'center' },
});
