/**
 * @jest-environment jsdom
 */
// QA N2 (Sent via Venmo re-check): SegmentedControl's radio mode follows the WAI-ARIA radio-group
// keyboard pattern on web. Rendered with react-native-web into jsdom (react-dom), so these are the
// DOM attributes and the key handling a browser gets:
// - Space selects the focused radio (Enter already did, through react-native-web's press responder).
// - Arrow keys move the selection to the previous / next radio, wrapping round, and move focus with it.
// - Roving tabindex: only the checked radio is a tab stop (tabindex 0); the others are -1.
// Button mode (the default) is unchanged: every segment is a tab stop and arrows do nothing.
import type { ReactElement } from 'react';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
// lib/theme.ts reads the Appearance choice (lib/themePreference.ts), which loads lib/storage; this
// file renders through react-native-web without expo-secure-store's native module, so storage is in memory.
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});

type Semantics = 'button' | 'radio';
type Mounted = { container: HTMLElement; onChange: jest.Mock; unmount: () => void };

const OPTIONS = [
  { value: 'venmo', label: 'Venmo' },
  { value: 'cash', label: 'Cash' },
  { value: 'other', label: 'Other' },
] as const;

let rnw: {
  React: typeof import('react');
  mount: (semantics: Semantics, initial?: string, disabled?: boolean) => Mounted;
};

beforeAll(() => {
  jest.isolateModules(() => {
    jest.doMock('react-native', () => jest.requireActual('react-native-web'));
    // lucide's native SVG doesn't render under react-dom; icons aren't what's checked here.
    jest.doMock('@/components/ui/Icon', () => ({ Icon: () => null }));
    const React = jest.requireActual<typeof import('react')>('react');
    // @types/react-dom isn't installed; these are the two functions used.
    const { createRoot } = jest.requireActual<{
      createRoot: (el: HTMLElement) => { render: (n: ReactElement) => void; unmount: () => void };
    }>('react-dom/client');
    const { SegmentedControl } = jest.requireActual<typeof import('@/components/ui/SegmentedControl')>('@/components/ui/SegmentedControl');

    const mount = (semantics: Semantics, initial = 'venmo', disabled = false): Mounted => {
      const onChange = jest.fn();
      function Controlled() {
        const [value, setValue] = React.useState(initial);
        return React.createElement(SegmentedControl<string>, {
          options: OPTIONS,
          value,
          onChange: (v: string) => {
            onChange(v);
            setValue(v);
          },
          semantics,
          groupLabel: "How you're paying",
          disabled,
        });
      }
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      React.act(() => root.render(React.createElement(Controlled)));
      return {
        container,
        onChange,
        unmount: () => {
          React.act(() => root.unmount());
          container.remove();
        },
      };
    };
    rnw = { React, mount };
  });
});

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

/** A segment by its text (these options have no accessibilityLabel). */
const segment = (c: HTMLElement, label: string): HTMLElement => {
  const all = Array.from(c.querySelectorAll<HTMLElement>('[role="radio"], [role="button"]'));
  const found = all.find((e) => e.textContent === label) ?? null;
  if (found === null) throw new Error(`no segment ${label} in ${c.innerHTML}`);
  return found;
};
const press = (el: HTMLElement, key: string) => {
  rnw.React.act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
  });
};
const checked = (c: HTMLElement) => Array.from(c.querySelectorAll('[role="radio"]')).map((e) => e.getAttribute('aria-checked'));
const tabStops = (c: HTMLElement) => Array.from(c.querySelectorAll('[role="radio"], [role="button"]')).map((e) => e.getAttribute('tabindex'));

describe('SegmentedControl radio mode on web: keyboard (QA N2)', () => {
  let m: Mounted;
  afterEach(() => m.unmount());

  it('roving tabindex: only the checked radio is a tab stop, and it follows the selection', () => {
    m = rnw.mount('radio', 'cash');
    expect(checked(m.container)).toEqual(['false', 'true', 'false']); // positive control: three radios
    expect(tabStops(m.container)).toEqual(['-1', '0', '-1']);
  });

  it('Space selects the focused radio', () => {
    m = rnw.mount('radio', 'venmo');
    const cash = segment(m.container, 'Cash');
    cash.focus();
    press(cash, ' ');
    expect(m.onChange).toHaveBeenCalledWith('cash');
    expect(checked(m.container)).toEqual(['false', 'true', 'false']);
  });

  it('Space on the already-checked radio changes nothing', () => {
    m = rnw.mount('radio', 'venmo');
    const venmo = segment(m.container, 'Venmo');
    venmo.focus();
    press(venmo, ' ');
    expect(checked(m.container)).toEqual(['true', 'false', 'false']);
  });

  it('Enter still selects (unchanged)', () => {
    m = rnw.mount('radio', 'venmo');
    const cash = segment(m.container, 'Cash');
    cash.focus();
    press(cash, 'Enter');
    expect(m.onChange).toHaveBeenCalledWith('cash');
  });

  it.each([
    ['ArrowRight', 'venmo', 'cash'],
    ['ArrowDown', 'venmo', 'cash'],
    ['ArrowLeft', 'cash', 'venmo'],
    ['ArrowUp', 'cash', 'venmo'],
    ['ArrowRight', 'other', 'venmo'], // wraps forward
    ['ArrowLeft', 'venmo', 'other'], // wraps back
  ])('%s from %s selects %s and moves focus to it', (key, from, to) => {
    m = rnw.mount('radio', from);
    const start = segment(m.container, OPTIONS.find((o) => o.value === from)?.label ?? '');
    start.focus();
    press(start, key);
    expect(m.onChange).toHaveBeenLastCalledWith(to);
    const target = segment(m.container, OPTIONS.find((o) => o.value === to)?.label ?? '');
    expect(target.getAttribute('aria-checked')).toBe('true');
    expect(target.getAttribute('tabindex')).toBe('0');
    expect(document.activeElement).toBe(target);
  });

  it('disabled: arrows and Space do nothing', () => {
    m = rnw.mount('radio', 'venmo', true);
    const venmo = segment(m.container, 'Venmo');
    press(venmo, 'ArrowRight');
    press(segment(m.container, 'Cash'), ' ');
    expect(m.onChange).not.toHaveBeenCalled();
    expect(checked(m.container)).toEqual(['true', 'false', 'false']);
  });
});

describe('SegmentedControl button mode on web: unchanged (QA N2)', () => {
  let m: Mounted;
  afterEach(() => m.unmount());

  it('every segment is a tab stop and arrows do nothing', () => {
    m = rnw.mount('button', 'venmo');
    // Positive control: three native <button>s (the browser turns Enter / Space into a click on
    // those itself, which jsdom doesn't simulate, so a key press isn't checked here).
    expect(Array.from(m.container.querySelectorAll('[role="button"]')).map((e) => e.tagName)).toEqual(['BUTTON', 'BUTTON', 'BUTTON']);
    expect(tabStops(m.container)).toEqual(['0', '0', '0']);
    const venmo = segment(m.container, 'Venmo');
    venmo.focus();
    press(venmo, 'ArrowRight');
    expect(m.onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(venmo);
  });
});
