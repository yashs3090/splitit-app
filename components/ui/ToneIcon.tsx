// ToneIcon: the icon for a status line's tone, so status copy never needs a glyph (proposal P3).
// success → Check, warning → TriangleAlert, error → CircleAlert; muted/none draws nothing.
// 16 pt, sized for caption and label text, nudged 1 pt down to sit on an 18-pt first line.
import Check from 'lucide-react-native/icons/check';
import CircleAlert from 'lucide-react-native/icons/circle-alert';
import TriangleAlert from 'lucide-react-native/icons/triangle-alert';
import { StyleSheet } from 'react-native';

import { Icon } from './Icon';

export type StatusTone = 'success' | 'warning' | 'error' | 'muted';

const ICONS = { success: Check, warning: TriangleAlert, error: CircleAlert } as const;

export function ToneIcon({ tone, color }: { tone: StatusTone; color: string }) {
  if (tone === 'muted') return null;
  return <Icon icon={ICONS[tone]} size="sm" color={color} style={styles.nudge} />;
}

const styles = StyleSheet.create({
  // The 16-pt icon centered on an 18-pt caption line.
  nudge: { marginTop: 1 },
});
