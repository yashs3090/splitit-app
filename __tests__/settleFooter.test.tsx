// The bill screen's settle footer draws its check icon and live region from the action's `tone` and
// `live` (lib/settleView.ts), never from the caption text (review R3, settle-early spec Amendment A1).
import { render, screen } from '@testing-library/react-native';
import Check from 'lucide-react-native/icons/check';

import { SettleFooter } from '@/components/SettleFooter';
import type { SettleFooterAction } from '@/lib/settleView';

// settleView imports lib/bills, which creates the client; this test never talks to it.
jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});

const noop = () => {};

function renderFooter(action: SettleFooterAction) {
  return render(
    <SettleFooter
      action={action}
      waitForSave={false}
      marking={false}
      error={null}
      refreshFailed={false}
      onRefresh={noop}
      onPay={noop}
      onMark={noop}
      onNotYet={noop}
      onSettle={noop}
    />,
  );
}

const settle = (over: Partial<Extract<SettleFooterAction, { kind: 'settle' }>>): SettleFooterAction => ({
  kind: 'settle',
  variant: 'primary',
  caption: null,
  a11yHint: 'See what you owe and pay',
  ...over,
});

describe('SettleFooter caption (review R3)', () => {
  it('"Marked paid" (success, live): a check icon, and the caption is a polite live region', () => {
    renderFooter(settle({ caption: 'Marked paid', tone: 'success', live: true }));
    expect(screen.getByText('Marked paid').props.accessibilityLiveRegion).toBe('polite');
    expect(screen.UNSAFE_queryAllByType(Check)).toHaveLength(1);
  });

  it('the early "Marked paid · 1 item left to claim" (success, not live): the check icon, not announced', () => {
    renderFooter(settle({ variant: 'secondary', caption: 'Marked paid · 1 item left to claim', a11yHint: 'x', early: 'marked', tone: 'success' }));
    expect(screen.getByText('Marked paid · 1 item left to claim').props.accessibilityLiveRegion).toBe('none');
    expect(screen.UNSAFE_queryAllByType(Check)).toHaveLength(1);
  });

  it('a plain caption (no tone): no icon, not announced', () => {
    renderFooter(settle({ variant: 'secondary', caption: '1 item left to claim', a11yHint: 'x' }));
    expect(screen.getByText('1 item left to claim').props.accessibilityLiveRegion).toBe('none');
    expect(screen.UNSAFE_queryAllByType(Check)).toHaveLength(0);
  });

  it('the icon follows the tone, not the words: "Marked paid" text with no tone draws nothing and is silent', () => {
    renderFooter(settle({ caption: 'Marked paid' }));
    expect(screen.getByText('Marked paid').props.accessibilityLiveRegion).toBe('none');
    expect(screen.UNSAFE_queryAllByType(Check)).toHaveLength(0);
  });
});
