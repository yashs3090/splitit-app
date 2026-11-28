// FeedLine: one line of the Activity feed (docs/specs/2026-11-28-tab-bar-and-activity.md Task 8;
// Contracts C and M; criteria 43, 48–51). lib/feedView.ts gives everything it shows: the sentence,
// the caption ("Maya's bill · 7:42 PM"), the marker's tone and glyph, the unread flag, the
// accessibility label and what the line opens. No money arithmetic or wording here.
//
//   [marker]  Sentence that may wrap               •      ← dot only while unread
//             Maya's bill · 7:42 PM
//             Show 3                                      ← roll-up runs only
//             · child sentence …                          ← when expanded
//
// - The whole line (marker, words, dot) is one button that opens its bill or group. Its label is
//   feedView's ("Unread. " + sentence + place + time), so the marker and dot are hidden.
// - A roll-up's toggle is its own button, a sibling under the line (never a button inside a
//   button). It stays put when the children open below it, so focus stays on it (criterion 49).
// - Calm (criterion 51): no row background, no bold, no coloured text. Pressed dims the content
//   (a pressed background would hide the neutral marker's surfaceMuted fill).
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { FEED_SCREEN_A11Y, rollupToggle } from '@/lib/feedText';
import type { FeedLine as FeedLineView } from '@/lib/feedView';
import { opacity, space, type, useTheme } from '@/lib/theme';

import { FEED_MARKER_SIZE, FeedMarker } from './FeedMarker';
import { TextLink } from './ui/TextLink';
import { useFocusRing } from './ui/useFocusRing';

/** Contract M: the unread dot is 8 pt. */
export const FEED_DOT_SIZE = 8;
/** Centres the sentence's first line (type.body) on the 32-pt marker beside it. */
const TEXT_NUDGE = (FEED_MARKER_SIZE - type.body.lineHeight) / 2;
/** Centres the dot on the sentence's first line. */
const DOT_TOP = TEXT_NUDGE + (type.body.lineHeight - FEED_DOT_SIZE) / 2;

type Props = {
  line: FeedLineView;
  /** A roll-up run's children are shown. */
  expanded: boolean;
  onToggle: (key: string) => void;
  onOpen: (line: FeedLineView) => void;
  /** Draw the hairline above this line (every line but a section's first). */
  divider: boolean;
};

export function FeedLine({ line, expanded, onToggle, onOpen, divider }: Props) {
  const { colors } = useTheme();
  const { focusProps, ringStyle } = useFocusRing();
  const toggle = line.run === null ? null : rollupToggle(line.run.count, expanded);
  const hint = 'bill' in line.opens ? FEED_SCREEN_A11Y.opensBill : FEED_SCREEN_A11Y.opensGroup;

  return (
    <View testID={`feed-line-${line.key}`} style={[styles.line, divider && [styles.divider, { borderTopColor: colors.divider }]]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={line.a11yLabel}
        accessibilityHint={hint}
        onPress={() => onOpen(line)}
        {...focusProps}
        style={[styles.main, ringStyle && [ringStyle, styles.ringInside]]}
      >
        {({ pressed }) => (
          <View style={[styles.row, pressed && styles.pressed]}>
            <FeedMarker tone={line.tone} glyph={line.glyph} />
            <View style={styles.words}>
              <Text style={[type.body, { color: colors.text }]}>{line.sentence}</Text>
              <Text style={[type.caption, { color: colors.textMuted }]}>{line.caption}</Text>
            </View>
            {line.unread ? (
              <View
                testID="feed-unread-dot"
                accessible={false}
                importantForAccessibility="no-hide-descendants"
                accessibilityElementsHidden
                style={[styles.dot, { backgroundColor: colors.primary }]}
              />
            ) : (
              // Keeps the words' width the same read or unread, so a line never re-wraps on its next visit.
              <View style={styles.dotSpace} />
            )}
          </View>
        )}
      </Pressable>
      {toggle !== null && line.run !== null ? (
        <View style={styles.run}>
          <TextLink
            label={toggle.text}
            accessibilityLabel={toggle.label}
            accessibilityState={{ expanded }}
            onPress={() => onToggle(line.key)}
          />
          {expanded ? (
            <View style={styles.children}>
              {line.run.children.map((c) => (
                <Text key={c.key} style={[type.caption, { color: colors.textMuted }]}>
                  {c.sentence}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  line: { paddingHorizontal: space.lg },
  divider: { borderTopWidth: StyleSheet.hairlineWidth },
  main: { paddingVertical: space.md },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  // minWidth 0 lets long names wrap instead of pushing the dot off the line (200% zoom, large text).
  words: { flex: 1, minWidth: 0, gap: space.xs, marginTop: TEXT_NUDGE },
  dot: { width: FEED_DOT_SIZE, height: FEED_DOT_SIZE, borderRadius: FEED_DOT_SIZE / 2, marginTop: DOT_TOP },
  dotSpace: { width: FEED_DOT_SIZE },
  pressed: { opacity: opacity.pressed },
  // Lines sit edge to edge inside a clipped card, so the ring is drawn inside the line.
  ringInside: { outlineOffset: -2 },
  // Under the words: the marker's width plus the gap.
  run: { marginLeft: FEED_MARKER_SIZE + space.md, marginTop: -space.sm, paddingBottom: space.sm },
  children: { gap: space.xs, paddingBottom: space.xs },
});
