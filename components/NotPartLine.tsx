// "Nothing here was yours? I wasn't part of this" under a group bill's items (spec
// docs/specs/2026-11-27-group-claim-status.md T6, C6). Quiet on purpose: a muted caption and a text
// link, no card, so it never competes with the rows' Claim buttons (the screen's primary action).
// Every word comes from GROUP_CLAIM_COPY / GROUP_ERROR_COPY / SETTLE_COPY; the screen decides which
// line shows (lib/notPartView.ts) and runs the write (lib/useNotPart.ts).
//
// - `line` 'prompt': "Nothing here was yours?" + "I wasn't part of this".
// - `line` 'done': "You said you weren't part of this." + "Undo".
// - `line` null with an error: only the error (the refetch after a refusal can hide the line, e.g.
//   has_claims once my claim shows; its words still explain what happened).
// One TextLink for both looks, so keyboard and screen-reader focus stays on it after a tap. The
// caption is a polite live region (Android, web); iOS hears it through announceForAccessibility.
import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { StatusLine } from '@/components/ui/StatusLine';
import { TextLink } from '@/components/ui/TextLink';
import { GROUP_CLAIM_COPY } from '@/lib/groupClaimStatus';
import { GROUP_ERROR_COPY, type GroupError } from '@/lib/groups';
import { SETTLE_COPY } from '@/lib/settleView';
import { space, type, useTheme } from '@/lib/theme';

type Props = {
  line: 'prompt' | 'done' | null;
  /** The write is running, or waiting for the reread after it. */
  busy: boolean;
  error: GroupError | null;
  /** The write landed, but the reread after it failed. */
  refreshFailed: boolean;
  /** A reread is in flight (Refresh's busy state). */
  refreshing: boolean;
  onSet: (notPart: boolean) => void;
  onRefresh: () => void;
};

export function NotPartLine({ line, busy, error, refreshFailed, refreshing, onSet, onRefresh }: Props) {
  const { colors } = useTheme();
  const tapped = useRef(false);
  const prompt = line === 'done' ? GROUP_CLAIM_COPY.notPartDoneBill : GROUP_CLAIM_COPY.notPartPrompt;

  // After a tap's write lands and the line flips, VoiceOver is told the new words (it ignores live regions).
  const shown = useRef(line);
  useEffect(() => {
    if (shown.current === line) return;
    shown.current = line;
    if (!tapped.current || line === null) return;
    tapped.current = false;
    if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(prompt);
  }, [line, prompt]);

  if (line === null && error === null) return null;
  return (
    <View style={styles.wrap}>
      {line !== null ? (
        // Wraps under large text or 200% zoom: the link drops below the words instead of clipping.
        <View style={styles.row}>
          <Text accessibilityLiveRegion="polite" style={[type.caption, styles.prompt, { color: colors.textMuted }]}>
            {prompt}
          </Text>
          <TextLink
            label={line === 'done' ? GROUP_CLAIM_COPY.undo : GROUP_CLAIM_COPY.notPart}
            accessibilityLabel={line === 'done' ? GROUP_CLAIM_COPY.undoA11y : GROUP_CLAIM_COPY.notPart}
            accessibilityHint={line === 'done' ? GROUP_CLAIM_COPY.undoHint : GROUP_CLAIM_COPY.notPartHint}
            loading={busy}
            onPress={() => {
              tapped.current = true;
              onSet(line !== 'done');
            }}
          />
        </View>
      ) : null}
      {error !== null ? <StatusLine text={GROUP_ERROR_COPY[error]} tone="error" size="caption" alert /> : null}
      {refreshFailed && error === null ? (
        <View style={styles.row}>
          <Text accessibilityRole="alert" style={[type.caption, styles.prompt, { color: colors.textMuted }]}>
            {SETTLE_COPY.refreshFailed}
          </Text>
          <Button
            label={SETTLE_COPY.refresh}
            accessibilityLabel={SETTLE_COPY.refresh}
            accessibilityHint={SETTLE_COPY.refreshHint}
            variant="ghost"
            loading={refreshing}
            onPress={onRefresh}
            flush
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Pulled up toward the item card so it reads as a footnote to the list, not a new section.
  // Lined up with the rows' text (the card's padding).
  wrap: { marginTop: -space.md, paddingHorizontal: space.lg, gap: space.xs },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space.sm },
  prompt: { flexShrink: 1 },
});
