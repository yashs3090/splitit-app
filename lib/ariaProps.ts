// react-native-web 0.21 ignores `accessibilityState`: its createDOMProps reads only the aria-* props
// (and the old accessibilityChecked / accessibilitySelected / accessibilityDisabled names). So a
// control that sets only accessibilityState is announced on web without its state (QA F1).
// React Native's Pressable merges the same aria-* props into accessibilityState (aria first), so
// passing both, with the same values, changes nothing on native.
import type { AccessibilityState } from 'react-native';

export type AriaStateProps = {
  'aria-busy'?: boolean;
  'aria-checked'?: boolean | 'mixed';
  'aria-disabled'?: boolean;
  'aria-expanded'?: boolean;
  'aria-selected'?: boolean;
};

/** The aria-* props for an accessibilityState, only for the states that are set. Spread next to it. */
export function ariaProps(state: AccessibilityState | undefined): AriaStateProps {
  const out: AriaStateProps = {};
  if (state === undefined) return out;
  if (state.busy !== undefined) out['aria-busy'] = state.busy;
  if (state.checked !== undefined) out['aria-checked'] = state.checked;
  if (state.disabled !== undefined) out['aria-disabled'] = state.disabled;
  if (state.expanded !== undefined) out['aria-expanded'] = state.expanded;
  if (state.selected !== undefined) out['aria-selected'] = state.selected;
  return out;
}
