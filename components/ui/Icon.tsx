// Icon: a lucide outline icon at a theme size and stroke. Decorative: hidden from screen readers
// (the text or the control's accessibilityLabel says what it means).
import type { LucideIcon } from 'lucide-react-native';
import { View, type StyleProp, type ViewStyle } from 'react-native';

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
  // The hiding props go on a wrapping View, not the SVG: on web, react-native-svg forwards them to
  // the <svg> element as unknown DOM props, React warns, and the dev error toast covers the screen.
  // A View maps them to aria-hidden on web and to the native accessibility flags on iOS/Android.
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={style}
    >
      <Glyph size={iconSize[size]} color={color ?? colors.text} strokeWidth={ICON_STROKE} />
    </View>
  );
}
