// components/BillGroupLine.tsx on its own (spec docs/specs/2026-11-26-groups-mvp.md T17, criterion 80's
// "In Tahoe trip" line). Part 2 places it on the bill screen; these check each model kind renders,
// reads and calls back as it should, built through lib/billGroup.ts's billGroupLine.
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { BillGroupLine } from '@/components/BillGroupLine';
import { billGroupLine } from '@/lib/billGroup';

jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});

const BILL = '11111111-2222-4333-8444-555555555555';
const GROUP = '9a000000-0000-4000-8000-000000000001';
const tahoe = { groupId: GROUP, name: 'Tahoe trip' };

function setup(input: Partial<Parameters<typeof billGroupLine>[0]>, retrying = false) {
  const model = billGroupLine({ billId: BILL, group: null, isHost: true, canMove: true, failure: null, ...input });
  const onOpenGroup = jest.fn();
  const onManage = jest.fn();
  const onRetry = jest.fn();
  const view = render(<BillGroupLine model={model} onOpenGroup={onOpenGroup} onManage={onManage} onRetry={onRetry} retrying={retrying} />);
  return { view, onOpenGroup, onManage, onRetry };
}

describe.each(['ios', 'web'] as const)('BillGroupLine (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('in a group: one link "In Tahoe trip" that opens the group; the host also gets Take out', () => {
    const { onOpenGroup, onManage } = setup({ group: tahoe });
    const link = screen.getByRole('link', { name: 'In Tahoe trip' });
    expect(link.props.accessibilityHint).toBe('Opens the group');
    expect(screen.getByText('In Tahoe trip')).toBeTruthy();
    fireEvent.press(link);
    expect(onOpenGroup).toHaveBeenCalledWith(GROUP);
    const takeOut = screen.getByRole('button', { name: 'Take out of Tahoe trip' });
    expect(screen.getByText('Take out')).toBeTruthy();
    fireEvent.press(takeOut);
    expect(onManage).toHaveBeenCalledTimes(1);
  });

  it('in a group, not the host: the link only', () => {
    setup({ group: tahoe, isHost: false });
    expect(screen.getByRole('link', { name: 'In Tahoe trip' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Take out/ })).toBeNull();
  });

  it('no group, the host: "Move to a group" opens the group screen', () => {
    const { onManage } = setup({ group: null });
    const move = screen.getByRole('button', { name: 'Move to a group' });
    expect(move.props.accessibilityHint).toBe('Choose a group for this bill');
    fireEvent.press(move);
    expect(onManage).toHaveBeenCalledTimes(1);
  });

  it('a failed attach: the error is an alert, and Try again retries that group (busy while retrying)', () => {
    const failure = { billId: BILL, groupId: GROUP, groupName: 'Tahoe trip' };
    const { onRetry, view } = setup({ group: null, failure });
    expect(screen.getByRole('alert', { name: "Couldn't add it to Tahoe trip. Try again." })).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledWith(GROUP);
    expect(screen.queryByRole('button', { name: 'Move to a group' })).toBeNull();

    view.rerender(
      <BillGroupLine
        model={billGroupLine({ billId: BILL, group: null, isHost: true, canMove: true, failure })}
        onOpenGroup={jest.fn()}
        onManage={jest.fn()}
        onRetry={onRetry}
        retrying
      />,
    );
    expect(screen.getByRole('button', { name: 'Try again' }).props.accessibilityState).toMatchObject({ busy: true, disabled: true });
  });

  it('nothing for a guest of a bill in no group, or while the group is unknown', () => {
    setup({ group: null, isHost: false });
    expect(screen.toJSON()).toBeNull();
    setup({ group: undefined });
    expect(screen.toJSON()).toBeNull();
  });
});
