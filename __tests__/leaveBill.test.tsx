// LeaveBill and who paid S12 (docs/specs/2026-11-26-who-paid.md A1.5): a payer can't leave a bill
// they paid on, and the reason shows in place of "Leave this bill" before any tap. The bill screen
// passes `blockedText` from lib/peopleView's leaveBlockedText.
// Rendered on native and web (Platform.OS set explicitly), then once through react-native-web to
// static markup, which is what a browser's screen reader gets (react-native-web drops hints).
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Platform } from 'react-native';

import { LeaveBill } from '@/components/LeaveBill';
import { PEOPLE_COPY } from '@/lib/peopleView';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));

const CO_PAYER = "You're one of the people who paid. Ask Hana to change who paid before you leave.";

describe.each(['ios', 'web'] as const)('LeaveBill on %s', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  it('S12: a co-payer sees the reason instead of the Leave button, before any tap', () => {
    const onLeave = jest.fn(async () => null);
    render(<LeaveBill canLeave={false} blockedText={CO_PAYER} onLeave={onLeave} />);
    const reason = screen.getByText(CO_PAYER);
    expect(reason).toBeTruthy();
    expect(screen.queryByLabelText(PEOPLE_COPY.leave)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(onLeave).not.toHaveBeenCalled();
  });

  it('positive control: someone who may leave gets the button and no reason, even if a reason is passed', () => {
    render(<LeaveBill canLeave blockedText={CO_PAYER} onLeave={jest.fn(async () => null)} />);
    expect(screen.getByLabelText(PEOPLE_COPY.leave).props.accessibilityRole).toBe('button');
    expect(screen.queryByText(CO_PAYER)).toBeNull();
  });

  it('no reason and not allowed (claims, or the host): nothing shows, as before', () => {
    render(<LeaveBill canLeave={false} onLeave={jest.fn(async () => null)} />);
    expect(screen.toJSON()).toBeNull();
  });

  it('cannot_leave after a tap (they became a payer meanwhile): the error, then the reason once the refetch lands', async () => {
    const onLeave = jest.fn(async () => 'cannot_leave' as const);
    const view = render(<LeaveBill canLeave onLeave={onLeave} />);
    fireEvent.press(screen.getByLabelText(PEOPLE_COPY.leave));
    fireEvent.press(screen.getByLabelText('Leave'));
    expect(await screen.findByText("You can't leave right now. Unclaim your items first.")).toBeTruthy();
    view.rerender(<LeaveBill canLeave={false} blockedText={CO_PAYER} onLeave={onLeave} />);
    expect(screen.getByText(CO_PAYER)).toBeTruthy();
    // The claims wording no longer fits; the reason replaces it.
    expect(screen.queryByText("You can't leave right now. Unclaim your items first.")).toBeNull();
    expect(screen.queryByLabelText(PEOPLE_COPY.leave)).toBeNull();
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});

/** react-native-web markup for `make()`: what the browser gets. */
function webMarkup(make: (React: typeof import('react')) => ReactElement): string {
  let html = '';
  jest.isolateModules(() => {
    jest.doMock('react-native', () => jest.requireActual('react-native-web'));
    jest.doMock('@/components/ui/Icon', () => ({ Icon: () => null }));
    const React = jest.requireActual<typeof import('react')>('react');
    // @types/react-dom isn't installed; this is the one function used.
    const { renderToStaticMarkup } = jest.requireActual<{ renderToStaticMarkup: (el: ReactElement) => string }>('react-dom/server');
    html = renderToStaticMarkup(make(React));
  });
  return html;
}

describe('LeaveBill in the browser (react-native-web)', () => {
  const component = () => jest.requireActual<typeof import('@/components/LeaveBill')>('@/components/LeaveBill').LeaveBill;
  const escaped = CO_PAYER.replace(/'/g, '&#x27;');

  it('S12: the reason is plain text in the page, with no Leave button', () => {
    const html = webMarkup((React) => React.createElement(component(), { canLeave: false, blockedText: CO_PAYER, onLeave: async () => null }));
    expect(html).toContain(`>${escaped}<`);
    expect(html).not.toContain(`aria-label="${PEOPLE_COPY.leave}"`);
    expect(html).not.toContain('role="button"');
  });

  it('positive control: the Leave button is a labelled button on web', () => {
    const html = webMarkup((React) => React.createElement(component(), { canLeave: true, onLeave: async () => null }));
    expect(html).toMatch(new RegExp(`<[a-z]+ [^>]*aria-label="${PEOPLE_COPY.leave}"[^>]*role="button"|<[a-z]+ [^>]*role="button"[^>]*aria-label="${PEOPLE_COPY.leave}"`));
  });
});
