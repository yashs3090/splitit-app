// "Tax & tip: split proportionally" in the expanded shares summary (A1.7, Task 19).
// Everyone sees the line as text. The host sees it as one quiet selector: tapping the line reveals
// the two options, and choosing one closes them. Saving (optimistic, with rollback) lives in the
// bill screen; this component only shows the mode it's given and reports a choice.
import Check from 'lucide-react-native/icons/check';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import ChevronUp from 'lucide-react-native/icons/chevron-up';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { StatusLine } from '@/components/ui/StatusLine';
import { useFocusRing } from '@/components/ui/useFocusRing';
import { EXTRAS_MODES, extrasModeHelp, extrasModeName, extrasModeText } from '@/lib/billView';
import type { ExtrasMode } from '@/lib/split';
import { iconSize, opacity, space, TOUCH_TARGET, type, useTheme } from '@/lib/theme';

export const EXTRAS_SPLIT_ERROR = "Couldn't change how tax and tip are split.";
export const EXTRAS_SPLIT_LABEL = 'How tax and tip are split';

type Props = {
  mode: ExtrasMode;
  isHost: boolean;
  /** A change is being saved: the selector is disabled until it settles. */
  saving?: boolean;
  /** The last change failed and was rolled back. */
  error?: boolean;
  onChange: (mode: ExtrasMode) => void;
};

/** "Split proportionally", "Split evenly". */
function optionLabel(mode: ExtrasMode): string {
  const name = extrasModeName(mode);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function ExtrasSplitControl({ mode, isHost, saving = false, error = false, onChange }: Props) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const help = extrasModeHelp(mode);
  const { focusProps, ringStyle } = useFocusRing();

  return (
    <View style={styles.wrap}>
      {isHost ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={EXTRAS_SPLIT_LABEL}
          accessibilityValue={{ text: extrasModeName(mode) }}
          accessibilityHint={open ? 'Hides the options' : 'Choose how tax and tip are split'}
          accessibilityState={{ expanded: open, disabled: saving, busy: saving }}
          disabled={saving}
          onPress={() => setOpen((v) => !v)}
          {...focusProps}
          style={({ pressed }) => [styles.line, pressed && styles.pressed, saving && styles.inactive, ringStyle]}
        >
          <Text style={[type.caption, styles.grow, { color: colors.text }]}>{extrasModeText(mode)}</Text>
          <View accessible={false} importantForAccessibility="no-hide-descendants" style={styles.toggle}>
            <Text style={[type.caption, styles.toggleText, { color: colors.primary }]}>{open ? 'Done' : 'Change'}</Text>
            <Icon icon={open ? ChevronUp : ChevronDown} size="sm" color={colors.primary} />
          </View>
        </Pressable>
      ) : (
        <Text style={[type.caption, { color: colors.textMuted }]}>{extrasModeText(mode)}</Text>
      )}

      {isHost && open ? (
        <View accessibilityRole="radiogroup" accessibilityLabel={EXTRAS_SPLIT_LABEL} style={styles.options}>
          {EXTRAS_MODES.map((m) => (
            <Option
              key={m}
              label={optionLabel(m)}
              selected={m === mode}
              onPress={() => {
                setOpen(false);
                if (m !== mode) onChange(m);
              }}
            />
          ))}
        </View>
      ) : null}

      {help ? <Text style={[type.caption, { color: colors.textMuted }]}>{help}</Text> : null}
      {error ? <StatusLine text={EXTRAS_SPLIT_ERROR} tone="error" size="caption" alert /> : null}
    </View>
  );
}

/** One choice. The check marks the chosen option (shape, not only color); an empty slot keeps labels aligned. */
function Option({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const { focusProps, ringStyle } = useFocusRing();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      {...focusProps}
      style={({ pressed }) => [styles.option, pressed && styles.pressed, ringStyle]}
    >
      <View style={styles.check}>{selected ? <Icon icon={Check} color={colors.primary} /> : null}</View>
      <Text style={[type.body, styles.grow, { color: colors.text }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.xs },
  line: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: TOUCH_TARGET },
  grow: { flex: 1, minWidth: 0 },
  options: { gap: 0 },
  option: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: TOUCH_TARGET },
  check: { width: iconSize.md, alignItems: 'center' },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  toggleText: { fontWeight: '600' },
  pressed: { opacity: opacity.pressed },
  inactive: { opacity: opacity.disabled },
});
