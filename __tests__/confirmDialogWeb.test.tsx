/**
 * @jest-environment jsdom
 */
// ConfirmDialog on web (review R1 of docs/specs/2026-11-28-delete-group.md T5): rendered with
// react-native-web into jsdom (react-dom), so this is the DOM a browser gets. When the dialog opens,
// keyboard focus must land on the title, not on the destructive button (Enter would then delete the
// group for everyone), and the role="dialog" element is named by its title.
import type { ReactElement } from 'react';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
// lib/theme.ts reads the Appearance choice, which loads lib/storage; keep it in memory.
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});

jest.mock('react-native-safe-area-context', () => {
  const { createContext } = jest.requireActual<typeof import('react')>('react');
  return { SafeAreaInsetsContext: createContext(null) };
});

const TITLE = 'Delete "Tahoe trip" for everyone?';
const BODY = "It will be removed for both members. This can't be undone.";

let React!: typeof import('react');
let render!: (onConfirm: () => void) => { container: HTMLElement; unmount: () => void };
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  jest.isolateModules(() => {
    jest.doMock('react-native', () => jest.requireActual('react-native-web'));
    // lucide's native SVG doesn't render under react-dom; icons aren't what's checked here.
    jest.doMock('@/components/ui/Icon', () => ({ Icon: () => null }));
    React = jest.requireActual<typeof import('react')>('react');
    // @types/react-dom isn't installed; these are the two functions used.
    const { createRoot } = jest.requireActual<{
      createRoot: (el: HTMLElement) => { render: (n: ReactElement) => void; unmount: () => void };
    }>('react-dom/client');
    const { ConfirmDialog } = jest.requireActual<typeof import('@/components/ConfirmDialog')>('@/components/ConfirmDialog');
    render = (onConfirm) => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      // The opener had focus before the dialog opened.
      const opener = document.createElement('button');
      document.body.appendChild(opener);
      opener.focus();
      const root = createRoot(container);
      React.act(() =>
        root.render(
          React.createElement(ConfirmDialog, {
            visible: true,
            title: TITLE,
            body: BODY,
            confirmLabel: 'Delete group',
            cancelLabel: 'Cancel',
            onConfirm,
            onCancel: () => {},
          }),
        ),
      );
      return {
        container,
        unmount: () => {
          React.act(() => root.unmount());
          container.remove();
          opener.remove();
        },
      };
    };
  });
});

/** The fade's end: react-native-web calls onShow (and turns the focus trap on) from animationend. */
async function finishFade() {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('div'))) {
    await React.act(async () => {
      // React listens for the prefixed name when jsdom has no AnimationEvent; send both.
      el.dispatchEvent(new Event('animationend', { bubbles: true }));
      el.dispatchEvent(new Event('webkitAnimationEnd', { bubbles: true }));
    });
  }
}

describe('ConfirmDialog on web (review R1)', () => {
  it('focus lands on the title, not on the destructive button, and Enter there does nothing', async () => {
    const onConfirm = jest.fn();
    const { unmount } = render(onConfirm);
    await finishFade();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    // Positive control: the dialog and both buttons are there.
    expect(dialog).not.toBeNull();
    const buttons = Array.from(dialog!.querySelectorAll<HTMLElement>('[role="button"]')).map((b) => b.textContent);
    expect(buttons).toEqual(['Delete group', 'Cancel']);
    const focused = document.activeElement as HTMLElement | null;
    expect(focused?.textContent).toBe(TITLE);
    expect(focused?.getAttribute('role')).not.toBe('button');
    expect(dialog!.contains(focused)).toBe(true);
    await React.act(async () => {
      focused?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      focused?.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(onConfirm).not.toHaveBeenCalled();
    unmount();
  });

  it('the dialog is named by its title (aria-labelledby → the title element)', async () => {
    const { unmount } = render(() => {});
    await finishFade();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const id = dialog?.getAttribute('aria-labelledby');
    expect(id).toBeTruthy();
    expect(document.getElementById(id ?? '')?.textContent).toBe(TITLE);
    unmount();
  });
});
