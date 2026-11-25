// StatusLine: a short inline result or error ("Saved", "Added Sam", "Link copied", "Couldn't save
// your claim"), icon + words, so it's never color-only. Results are a polite live region (Android,
// web; iOS VoiceOver ignores it, so callers that must be heard on iOS also call
// AccessibilityInfo.announceForAccessibility). Errors that must interrupt pass `alert`.
// `size="caption"` is the compact form for tight places such as the bill footer (visual pass V13).
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { space, type, useTheme } from '@/lib/theme';

import { ToneIcon } from './ToneIcon';

type Props = {
  text: string;
  tone?: 'success' | 'error';
  size?: 'label' | 'caption';
  /** Announce as an alert (errors). Otherwise the text is a polite live region. */
  alert?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function StatusLine({ text, tone = 'success', size = 'label', alert = false, style }: Props) {
  const { colors } = useTheme();
  const color = tone === 'success' ? colors.success : colors.danger;
  return (
    <View style={[styles.line, style]}>
      <ToneIcon tone={tone} color={color} />
      <Text
        accessibilityRole={alert ? 'alert' : undefined}
        accessibilityLiveRegion={alert ? undefined : 'polite'}
        style={[size === 'caption' ? type.caption : type.label, styles.text, { color }]}
      >
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // Top-aligned so a wrapped message keeps its icon on the first line.
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xs },
  // Wraps under large text instead of clipping.
  text: { flexShrink: 1 },
});
