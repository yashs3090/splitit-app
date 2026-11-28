// The line under a bill's title about its group (spec docs/specs/2026-11-26-groups-mvp.md T17):
// "In Tahoe trip" (opens the group; the host also gets a quiet "Take out" that opens the bill's
// group screen), "Move to a group" for the host of a bill in none, or, after the bill form's attach
// failed, "Couldn't add it to Tahoe trip. Try again." with a Try again link.
//
// Renders lib/billGroup.ts's billGroupLine model and builds no strings. It never navigates on its
// own: each control calls back and the screen decides. Every control has a 44-pt target.
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import UsersRound from 'lucide-react-native/icons/users-round';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { StatusLine } from '@/components/ui/StatusLine';
import { TextLink } from '@/components/ui/TextLink';
import { useFocusRing } from '@/components/ui/useFocusRing';
import { BILL_GROUP_COPY as COPY, type BillGroupLineModel } from '@/lib/billGroup';
import { opacity, space, TOUCH_TARGET, type, useTheme } from '@/lib/theme';

type Props = {
  model: BillGroupLineModel;
  /** "In Tahoe trip": open the group screen. */
  onOpenGroup: (groupId: string) => void;
  /** "Move to a group" and the host's "Take out": open app/(app)/bills/[id]/group.tsx. */
  onManage: () => void;
  /** After a failed attach: attach again (a retry to the same group is a no-op success). */
  onRetry: (groupId: string) => void;
  /** The retry is in flight. */
  retrying?: boolean;
};

export function BillGroupLine({ model, onOpenGroup, onManage, onRetry, retrying = false }: Props) {
  const { colors } = useTheme();
  const { focusProps, ringStyle } = useFocusRing();

  switch (model.kind) {
    case 'hidden':
      return null;
    case 'move':
      return (
        <View style={styles.line}>
          <TextLink label={model.text} icon={UsersRound} accessibilityHint={COPY.moveToGroupHint} onPress={onManage} />
        </View>
      );
    case 'attach_failed':
      return (
        <View style={styles.line}>
          <StatusLine text={model.text} tone="error" size="caption" alert style={styles.flex} />
          <TextLink label={COPY.tryAgain} loading={retrying} onPress={() => onRetry(model.groupId)} />
        </View>
      );
    case 'in_group':
      return (
        <View style={styles.line}>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={model.a11yLabel}
            accessibilityHint={COPY.openGroupHint}
            onPress={() => onOpenGroup(model.groupId)}
            {...focusProps}
            style={({ pressed }) => [styles.groupLink, pressed && styles.pressed, ringStyle]}
          >
            <Icon icon={UsersRound} size="sm" color={colors.primary} />
            <Text style={[type.caption, styles.groupName, { color: colors.primary }]}>{model.text}</Text>
            <Icon icon={ChevronRight} size="sm" color={colors.primary} />
          </Pressable>
          {model.canManage ? (
            <TextLink
              label={COPY.takeOut}
              accessibilityLabel={model.takeOutA11y}
              accessibilityHint={COPY.takeOutHint}
              onPress={onManage}
            />
          ) : null}
        </View>
      );
  }
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: space.md },
  flex: { flex: 1, minWidth: 0 },
  // The label stays leading; the whole row is at least 44 pt tall.
  groupLink: { flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: TOUCH_TARGET, flexShrink: 1 },
  groupName: { fontWeight: '600', flexShrink: 1 },
  pressed: { opacity: opacity.pressed },
});
