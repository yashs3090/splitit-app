// One "Not in balances yet" line on the group screen (spec docs/specs/2026-11-27-group-claim-status.md
// T5, C1/C5/C6). Every word comes from lib/groupView.ts's WaitingLine and lib/groupScreenText.ts;
// this component only lays it out.
//
// Each bill is its own small card (GCS-16), so its link and any error sit inside that bill's edges
// and can't be read against the next bill's row. The screen stacks the cards with a gap.
// Three looks:
// - Needs me: a soft warningSurface card. On top, the row (opens the bill); under it, inside the
//   tint, the quiet "I wasn't part of this" link. Two separate targets, never a button in a button.
// - Opted out: plain card; caption "You weren't part of this" and an "Undo" link.
// - Otherwise: the plain row in a plain card.
// A failed not-part write shows its words inside this card (the screen tracks errors per bill).
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import { StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { ListRow } from '@/components/ui/ListRow';
import { StatusLine } from '@/components/ui/StatusLine';
import { TextLink } from '@/components/ui/TextLink';
import { GROUP_CLAIM_COPY } from '@/lib/groupClaimStatus';
import { GROUP_SCREEN_COPY, waitingA11yLabel, waitingCaption } from '@/lib/groupScreenText';
import type { WaitingLine } from '@/lib/groupView';
import { space, type, useTheme } from '@/lib/theme';

type Props = {
  line: WaitingLine;
  onOpen: () => void;
  /** Sets (true) or clears (false) "I wasn't part of this" for this bill. */
  onNotPart: (notPart: boolean) => void;
  /** This bill's not-part write is in flight (until the refetch after it ends). */
  busy: boolean;
  /** The words for this bill's last failed not-part write, or null. */
  error: string | null;
};

export function GroupWaitingRow({ line, onOpen, onNotPart, busy, error }: Props) {
  const { colors } = useTheme();
  const caption = waitingCaption(line);
  return (
    // Flush card: rounded (continuous) corners, clipped so the row's pressed state follows them. The
    // tint replaces the hairline edge, which would read as a second box on the warm fill.
    <Card flush style={line.needsMe ? { backgroundColor: colors.warningSurface, borderColor: 'transparent' } : undefined}>
      <ListRow
        title={line.text}
        caption={
          caption === null ? undefined : (
            // Polite live region: the words change after "I wasn't part of this" or Undo (Android, web).
            <Text accessibilityLiveRegion="polite" style={[type.caption, { color: colors.textMuted }]}>
              {caption}
            </Text>
          )
        }
        trailing={<Icon icon={ChevronRight} color={colors.textMuted} />}
        accessibilityRole="link"
        accessibilityLabel={waitingA11yLabel(line)}
        accessibilityHint={GROUP_SCREEN_COPY.waitingHint}
        onPress={onOpen}
      />
      {line.needsMe ? (
        <View style={styles.action}>
          <TextLink
            label={GROUP_CLAIM_COPY.notPart}
            accessibilityLabel={GROUP_CLAIM_COPY.notPart}
            accessibilityHint={GROUP_CLAIM_COPY.notPartHint}
            onPress={() => onNotPart(true)}
            loading={busy}
          />
        </View>
      ) : line.notPart ? (
        <View style={styles.action}>
          <TextLink
            label={GROUP_CLAIM_COPY.undo}
            accessibilityLabel={GROUP_CLAIM_COPY.undoA11y}
            accessibilityHint={GROUP_CLAIM_COPY.undoHint}
            onPress={() => onNotPart(false)}
            loading={busy}
          />
        </View>
      ) : null}
      {error !== null ? <StatusLine text={error} tone="error" size="caption" alert style={styles.error} /> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  // Lined up with the title. Pulled up into the row's bottom padding so the link reads as part of
  // the row, while keeping its own full 44-pt target.
  action: { paddingLeft: space.lg, paddingRight: space.lg, marginTop: -space.sm, paddingBottom: space.xs },
  error: { paddingHorizontal: space.lg, paddingBottom: space.md },
});
