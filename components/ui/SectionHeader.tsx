// SectionHeader: the small muted label above a group of rows ("Discounts", "Just now").
import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';

import { space, type, useTheme } from '@/lib/theme';

type Props = { title: string; style?: StyleProp<TextStyle> };

export function SectionHeader({ title, style }: Props) {
  const { colors } = useTheme();
  return (
    <Text accessibilityRole="header" style={[type.section, styles.header, { color: colors.textMuted }, style]}>
      {title}
    </Text>
  );
}

const styles = StyleSheet.create({
  // A 4-pt inset (as on Activity, the reference screen) so the label doesn't sit on the card's edge.
  header: { paddingHorizontal: space.xs },
});
