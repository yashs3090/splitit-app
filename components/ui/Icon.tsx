// Icon: a lucide outline icon at a theme size and stroke. Decorative: hidden from screen readers
// (the text or the control's accessibilityLabel says what it means).
import type { LucideIcon } from 'lucide-react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import { ICON_STROKE, iconSize, useTheme } from '@/lib/theme';

export type IconSize = keyof typeof iconSize;

type Props = {
  icon: LucideIcon;
  /** `sm` 16 next to caption text, `md` 20 next to body text and in icon buttons, `lg` 24 in badges. */
  size?: IconSize;
  /** Defaults to the theme text color; pass the color of the text it sits with. */
  color?: string;
  style?: StyleProp<ViewStyle>;
};

export function Icon({ icon: Glyph, size = 'md', color, style }: Props) {
  const { colors } = useTheme();
  return (
    <Glyph
      size={iconSize[size]}
      color={color ?? colors.text}
      strokeWidth={ICON_STROKE}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={style}
    />
  );
}
