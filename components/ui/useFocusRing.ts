// Keyboard focus ring for custom pressables (web, hardware keyboards). The browser's default ring
// is uneven across elements; this draws the theme's ring only while the element has focus.
// On web it follows `:focus-visible`, so a mouse click or tap doesn't leave a ring behind; only
// keyboard focus draws it. Native platforms have no such distinction: focus there means keyboard.
import { useState } from 'react';
import { Platform, type NativeSyntheticEvent, type ViewStyle } from 'react-native';

import { focusRing, useTheme } from '@/lib/theme';

type FocusEvent = NativeSyntheticEvent<unknown>;

/** On web, whether the browser would show a focus ring here (keyboard focus, not a click). */
function isFocusVisible(e: FocusEvent | undefined): boolean {
  if (Platform.OS !== 'web') return true;
  // On web the event target is the DOM element; `matches` is missing only in very old browsers.
  const native = e?.nativeEvent as { target?: { matches?: (selector: string) => boolean } } | undefined;
  return native?.target?.matches?.(':focus-visible') ?? true;
}

export function useFocusRing(): {
  focusProps: { onFocus: (e?: FocusEvent) => void; onBlur: () => void };
  ringStyle: ViewStyle | null;
} {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  return {
    focusProps: { onFocus: (e) => setFocused(isFocusVisible(e)), onBlur: () => setFocused(false) },
    ringStyle: focused ? { ...focusRing, outlineColor: colors.focus } : null,
  };
}
