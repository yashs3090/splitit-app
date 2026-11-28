// Groups' hand-built controls on web: react-native-web 0.21 drops accessibilityState, so each one
// also passes ariaProps (lib/ariaProps.ts). Rendered with react-native-web to static markup, as in
// __tests__/assignChips.test.tsx, so these are the attributes a browser's screen reader gets.
// One test per control kind: checkbox (expense split rows), radio (expense payer, Record a payment's
// person), expandable (Who paid what's person row, components/WhoPaidWhatPersonRow.tsx; the group's ⋯ options button),
// and the group screen's "I wasn't part of this" / Undo links (group claim status T5, criterion 29).
import type { ReactElement } from 'react';

import { GROUP_CLAIM_COPY } from '@/lib/groupClaimStatus';
import { groupNameOf } from '@/lib/groupScreenText';
import { whoPaidWhatA11y } from '@/lib/groupSettleText';
import { whoPaidWhat } from '@/lib/groupSettleView';
import { waitingLines, type WaitingLine } from '@/lib/groupView';
import { snapshotOf, withNotPart } from '@/test-utils/groupSnapshotFixtures';
import { ANA, DEE, DINNER_ID, W1, W2 } from '@/test-utils/groupFixtures';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
// lib/theme.ts reads the Appearance choice (lib/themePreference.ts), which loads lib/storage; this
// file renders through react-native-web without expo-secure-store's native module, so storage is in memory.
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});

type Make = (React: typeof import('react')) => ReactElement;

/** The opening tag labelled `label` in the react-native-web markup of `make()`. */
function webTag(make: Make, label: string): string {
  let html = '';
  jest.isolateModules(() => {
    jest.doMock('react-native', () => jest.requireActual('react-native-web'));
    // lucide's native SVG doesn't render under react-dom; icons aren't what's checked here.
    jest.doMock('@/components/ui/Icon', () => ({ Icon: () => null }));
    const React = jest.requireActual<typeof import('react')>('react');
    // @types/react-dom isn't installed; this is the one function used.
    const { renderToStaticMarkup } = jest.requireActual<{ renderToStaticMarkup: (el: ReactElement) => string }>('react-dom/server');
    html = renderToStaticMarkup(make(React));
  });
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, '&#x27;');
  const found = html.match(new RegExp(`<[a-z]+ [^>]*aria-label="${escaped}"[^>]*>`, 'g')) ?? [];
  if (found.length !== 1) throw new Error(`${found.length} tags labelled ${label} in ${html}`);
  return found[0] ?? '';
}

const rows = () => jest.requireActual<typeof import('@/components/ExpenseFormRows')>('@/components/ExpenseFormRows');

describe('groups controls on web carry their state as aria-*', () => {
  it.each([true, false])('expense split row: a checkbox with aria-checked=%s', (checked) => {
    const tag = webTag(
      (React) =>
        React.createElement(rows().ExpenseCheckRow, {
          name: 'Ben',
          checked,
          cents: 500,
          accessibilityLabel: 'Ben, $5.00',
          accessibilityHint: 'hint',
          disabled: false,
          onToggle: () => {},
          divider: false,
        }),
      'Ben, $5.00',
    );
    expect(tag).toContain('role="checkbox"'); // positive control: the web checkbox
    expect(tag).toContain(`aria-checked="${String(checked)}"`);
  });

  it.each([true, false])('expense payer row: a radio with aria-checked=%s', (checked) => {
    const tag = webTag((React) => React.createElement(rows().ExpensePayerRow, { name: 'Ben', checked, disabled: false, onPick: () => {}, divider: false }), 'Ben');
    expect(tag).toContain('role="radio"');
    expect(tag).toContain(`aria-checked="${String(checked)}"`);
  });

  it.each([true, false])('Record a payment person: a radio with aria-checked=%s', (checked) => {
    const tag = webTag((React) => {
      const { PersonOption } = jest.requireActual<typeof import('@/components/GroupPaymentForm')>('@/components/GroupPaymentForm');
      return React.createElement(PersonOption, { name: 'Dee', checked, onPress: () => {}, divider: false });
    }, 'Dee');
    expect(tag).toContain('role="radio"');
    expect(tag).toContain(`aria-checked="${String(checked)}"`);
  });

  it.each([true, false])('Who paid what person row: aria-expanded=%s', (open) => {
    // Plain data built in this registry; the component and its text helpers load inside webTag.
    const row = whoPaidWhat(snapshotOf(W1.input), ANA, (id) => (id === ANA ? 'You' : 'Someone')).rows[0];
    if (row === undefined) throw new Error('no row');
    const label = whoPaidWhatA11y(row);
    const tag = webTag((React) => {
      const { WhoPaidWhatPersonRow } = jest.requireActual<typeof import('@/components/WhoPaidWhatPersonRow')>('@/components/WhoPaidWhatPersonRow');
      return React.createElement(WhoPaidWhatPersonRow, { row, open, divider: false, onToggle: () => {} });
    }, label);
    expect(tag).toContain('role="button"');
    expect(tag).toContain(`aria-expanded="${String(open)}"`);
  });

  it.each([true, false])('the group ⋯ options button (IconButton expanded): aria-expanded=%s', (expanded) => {
    const tag = webTag((React) => {
      const { IconButton } = jest.requireActual<typeof import('@/components/ui/IconButton')>('@/components/ui/IconButton');
      const Ellipsis = () => null;
      return React.createElement(IconButton, { icon: Ellipsis as never, accessibilityLabel: 'Group options', expanded, onPress: () => {} });
    }, 'Group options');
    expect(tag).toContain('role="button"');
    expect(tag).toContain(`aria-expanded="${String(expanded)}"`);
  });

  it('an IconButton without `expanded` gets no aria-expanded (other icon buttons unchanged)', () => {
    const tag = webTag((React) => {
      const { IconButton } = jest.requireActual<typeof import('@/components/ui/IconButton')>('@/components/ui/IconButton');
      const Copy = () => null;
      return React.createElement(IconButton, { icon: Copy as never, accessibilityLabel: 'Copy', onPress: () => {} });
    }, 'Copy');
    expect(tag).toContain('role="button"');
    expect(tag).not.toContain('aria-expanded');
  });

  describe('group screen waiting row links (T5, criterion 29)', () => {
    const lineFor = (notPartIds: readonly string[]): WaitingLine => {
      const snap = withNotPart(snapshotOf(W2.input), notPartIds);
      const line = waitingLines(snap, DEE, groupNameOf(snap.members, DEE)).find((l) => l.billId === DINNER_ID);
      if (line === undefined) throw new Error('no Dinner line');
      return line;
    };
    const rowTag = (line: WaitingLine, busy: boolean, label: string) =>
      webTag((React) => {
        const { GroupWaitingRow } = jest.requireActual<typeof import('@/components/GroupWaitingRow')>('@/components/GroupWaitingRow');
        return React.createElement(GroupWaitingRow, { line, onOpen: () => {}, onNotPart: () => {}, busy, error: null });
      }, label);

    it.each([false, true])('"I wasn\'t part of this" is a button with its name, and aria-busy only while busy (busy=%s)', (busy) => {
      const line = lineFor([]);
      expect(line.needsMe).toBe(true);
      const tag = rowTag(line, busy, GROUP_CLAIM_COPY.notPart);
      expect(tag).toContain('role="button"');
      if (busy) expect(tag).toContain('aria-busy="true"');
      else expect(tag).not.toContain('aria-busy');
    });

    it('Undo is a button named "Undo, I was part of this"; the row says "You weren\'t part of this" in its label', () => {
      const line = lineFor([DINNER_ID]);
      expect(line.notPart).toBe(true);
      expect(rowTag(line, false, GROUP_CLAIM_COPY.undoA11y)).toContain('role="button"');
      // The row's own label carries the caption, so nothing that matters lives only in a hint.
      const row = rowTag(line, false, "Balances don't include Ana's receipt yet: Nachos left to claim. You weren't part of this");
      expect(row).toContain('role="link"');
    });
  });
});
