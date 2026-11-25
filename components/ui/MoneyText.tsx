// MoneyText: integer cents shown as dollars with tabular numerals. Formatting only via lib/money.ts.
import { Text, type StyleProp, type TextStyle } from 'react-native';

import { formatCents } from '@/lib/money';
import { tabularNums, type, useTheme } from '@/lib/theme';

type Props = {
  /** Integer cents, or null for "not known" (shown as an em dash). */
  cents: number | null;
  size?: 'body' | 'title' | 'display';
  muted?: boolean;
  style?: StyleProp<TextStyle>;
};

export function MoneyText({ cents, size = 'body', muted = false, style }: Props) {
  const { colors } = useTheme();
  const text = cents === null ? '—' : formatCents(cents);
  return (
    <Text
      accessibilityLabel={cents === null ? 'Not entered' : undefined}
      style={[type[size], tabularNums, { color: muted ? colors.textMuted : colors.text }, size !== 'body' && { fontWeight: '700' }, style]}
    >
      {text}
    </Text>
  );
}
