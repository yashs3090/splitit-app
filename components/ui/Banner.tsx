// Banner: status that is never color-only. Each tone has its own icon plus words, on a tinted
// surface. No colored stripe or outline: the tint and the icon carry the tone (visual pass V5).
import type { LucideIcon } from 'lucide-react-native';
import CircleAlert from 'lucide-react-native/icons/circle-alert';
import CircleCheck from 'lucide-react-native/icons/circle-check';
import Info from 'lucide-react-native/icons/info';
import TriangleAlert from 'lucide-react-native/icons/triangle-alert';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { radius, space, type, useTheme, type Palette } from '@/lib/theme';

import { Icon } from './Icon';

export type BannerTone = 'info' | 'warning' | 'error' | 'success';

/** Error and warning differ by shape as well as color (circle vs triangle). */
const ICON: Record<BannerTone, LucideIcon> = { info: Info, warning: TriangleAlert, error: CircleAlert, success: CircleCheck };

function toneColors(c: Palette, tone: BannerTone): { fg: string; bg: string } {
  switch (tone) {
    case 'info':
      return { fg: c.textMuted, bg: c.surfaceMuted };
    case 'warning':
      return { fg: c.warning, bg: c.warningSurface };
    case 'error':
      return { fg: c.danger, bg: c.dangerSurface };
    case 'success':
      return { fg: c.success, bg: c.successSurface };
  }
}

type Props = {
  tone: BannerTone;
  title?: string;
  children?: ReactNode;
  /** Announce to screen readers (role="alert"). Use for errors only. */
  alert?: boolean;
};

export function Banner({ tone, title, children, alert = false }: Props) {
  const { colors } = useTheme();
  const t = toneColors(colors, tone);
  return (
    <View
      accessibilityRole={alert ? 'alert' : undefined}
      style={[styles.banner, { backgroundColor: t.bg }]}
    >
      <Icon icon={ICON[tone]} color={t.fg} />
      <View style={styles.body}>
        {title ? <Text style={[type.label, { color: tone === 'info' ? colors.text : t.fg }]}>{title}</Text> : null}
        {children}
      </View>
    </View>
  );
}

/** A line of body text inside a Banner, in the theme's text color. */
export function BannerText({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return <Text style={[type.caption, { color: colors.text }]}>{children}</Text>;
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
    borderCurve: 'continuous',
  },
  body: { flex: 1, gap: space.xs },
});
