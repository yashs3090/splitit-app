// A group bill is settled in its group, not on the bill (spec docs/specs/2026-11-26-groups-mvp.md
// T17, criterion 80; ADR 0022 amends 0015 and 0021). Two forms of one message:
// - `footer`: the bill screen's footer line "Settled in Tahoe trip" in place of Pay / I paid /
//   Settle up. A link (role "link") that opens the group.
// - `card`: Settle up's one card, with one primary "Open Tahoe trip".
// Words come from lib/billGroup.ts's groupBillText; this never navigates on its own.
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import UsersRound from 'lucide-react-native/icons/users-round';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { useFocusRing } from '@/components/ui/useFocusRing';
import { groupBillText } from '@/lib/billGroup';
import { opacity, space, TOUCH_TARGET, type, useTheme } from '@/lib/theme';

type Props = {
  groupName: string;
  variant: 'footer' | 'card';
  onOpenGroup: () => void;
};

export function SettledInGroup({ groupName, variant, onOpenGroup }: Props) {
  const { colors } = useTheme();
  const { focusProps, ringStyle } = useFocusRing();
  const text = groupBillText(groupName);

  if (variant === 'card') {
    return (
      <Card title={text.settledIn}>
        <Text style={[type.body, { color: colors.textMuted }]}>{text.settleBody}</Text>
        <Button
          label={text.openGroup}
          accessibilityLabel={text.openGroup}
          accessibilityHint={text.settledInHint}
          variant="primary"
          block
          onPress={onOpenGroup}
        />
      </Card>
    );
  }

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={text.settledIn}
      accessibilityHint={text.settledInHint}
      onPress={onOpenGroup}
      {...focusProps}
      style={({ pressed }) => [styles.line, pressed && styles.pressed, ringStyle]}
    >
      <Icon icon={UsersRound} size="sm" color={colors.primary} />
      <Text style={[type.label, styles.text, { color: colors.primary }]}>{text.settledIn}</Text>
      <View style={styles.grow} />
      <Icon icon={ChevronRight} size="sm" color={colors.primary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // The whole line is the target, at least 44 pt tall; the name wraps rather than clipping.
  line: { flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: TOUCH_TARGET },
  text: { flexShrink: 1 },
  grow: { flex: 1 },
  pressed: { opacity: opacity.pressed },
});
