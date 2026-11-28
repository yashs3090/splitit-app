// FeedMarker: the 32-pt circle with a 16-pt lucide glyph at the start of an Activity line
// (docs/specs/2026-11-28-tab-bar-and-activity.md Contract M, U12). The only consumer of
// FEED_MARKER_TONES: colour comes from the tone (unread needs_you / money / dispute), and every read
// line is `neutral` (feedMarkerTone decides; lib/feedView.ts passes the tone). The glyph always
// carries the meaning, so colour is never the only cue. Hidden from screen readers: the line's label
// says what it means.
import type { LucideIcon } from 'lucide-react-native';
import Banknote from 'lucide-react-native/icons/banknote';
import CircleAlert from 'lucide-react-native/icons/circle-alert';
import CircleCheck from 'lucide-react-native/icons/circle-check';
import Hand from 'lucide-react-native/icons/hand';
import ListChecks from 'lucide-react-native/icons/list-checks';
import Receipt from 'lucide-react-native/icons/receipt';
import RefreshCw from 'lucide-react-native/icons/refresh-cw';
import UsersRound from 'lucide-react-native/icons/users-round';
import { StyleSheet, View } from 'react-native';

import { FEED_MARKER_TONES, type FeedGlyph, type FeedTone } from '@/lib/feedText';
import { useTheme } from '@/lib/theme';

import { Icon } from './ui/Icon';

/** Contract M: a 32-pt circle. */
export const FEED_MARKER_SIZE = 32;

const GLYPHS: Readonly<Record<FeedGlyph, LucideIcon>> = {
  hand: Hand,
  'list-checks': ListChecks,
  banknote: Banknote,
  'circle-alert': CircleAlert,
  'refresh-cw': RefreshCw,
  receipt: Receipt,
  'circle-check': CircleCheck,
  'users-round': UsersRound,
};

export function FeedMarker({ tone, glyph }: { tone: FeedTone; glyph: FeedGlyph }) {
  const { colors } = useTheme();
  const t = FEED_MARKER_TONES[tone];
  return (
    <View
      testID={`feed-marker-${tone}`}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[styles.circle, { backgroundColor: colors[t.fill] }]}
    >
      <Icon icon={GLYPHS[glyph]} size="sm" color={colors[t.icon]} />
    </View>
  );
}

const styles = StyleSheet.create({
  circle: {
    width: FEED_MARKER_SIZE,
    height: FEED_MARKER_SIZE,
    borderRadius: FEED_MARKER_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
});
