// "Who had this?" in the item sheet of a group bill: criteria 84–86 of
// docs/specs/2026-11-26-groups-mvp.md (T18; A1.6 retries, A3.2 claims_changed).
// The sheet is rendered with a small stand-in for the bill screen that holds the row's claimer map
// and numbers its refetches like lib/useBill.ts (refetch() → n; `version` / `finished`), so the
// write → refetch → result endings are tested the way the screen will drive them (part 2 wires it).
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { useRef, useState } from 'react';
import { AccessibilityInfo, Platform, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { AvatarPerson } from '@/components/Avatars';
import { ItemSheet, type SheetClaimer } from '@/components/ItemSheet';
import { splitPreview } from '@/lib/billView';
import { supabase as realSupabase } from '@/lib/supabase';
import { TOUCH_TARGET } from '@/lib/theme';
import type { FakeResult, FakeSupabase } from '@/test-utils/fakes';

jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});

const supabase = realSupabase as unknown as FakeSupabase;

const ROW = '22222222-0000-4000-8000-000000000002';
const ANA = 'aaaaaaaa-0000-4000-8000-000000000001'; // the viewer
const BEN = 'aaaaaaaa-0000-4000-8000-000000000002';
const CY = 'aaaaaaaa-0000-4000-8000-000000000003';
const DEE = 'aaaaaaaa-0000-4000-8000-000000000004';

const person = (userId: string, name: string, initials: string, isMe = false): AvatarPerson => ({ userId, name, initials, isMe });
// Given out of order: the chips put the viewer first, then by name.
const MEMBERS: AvatarPerson[] = [
  person(DEE, 'Dee Park', 'DP'),
  person(BEN, 'Ben Okafor', 'BO'),
  person(ANA, 'You', 'AN', true),
  person(CY, 'Cy', 'CY'),
];

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

/** What the server holds; a successful refetch shows it. */
const server: { claims: Record<string, number> } = { claims: {} };
/** 'ok': refetches land on the next tick; 'fail': they finish without data; 'hold': the test settles them. */
let refetchMode: 'ok' | 'fail' | 'hold' = 'ok';
const held: Array<(ok: boolean) => void> = [];
let refetchCount = 0;

type ScreenProps = {
  initial: Record<string, number>;
  canEdit?: boolean;
  /** What the screen's claimers list shows, when it differs from the server's map (stale/optimistic). */
  listed?: Record<string, number>;
};

function Screen({ initial, canEdit = false, listed }: ScreenProps) {
  const [shown, setShown] = useState({ claims: initial, version: 0, finished: 0 });
  const [open, setOpen] = useState(true);
  const n = useRef(0);
  const refetch = (): number => {
    const k = ++n.current;
    refetchCount += 1;
    const settle = (ok: boolean) =>
      setShown((s) => ({
        claims: ok ? { ...server.claims } : s.claims,
        version: ok ? Math.max(s.version, k) : s.version,
        finished: Math.max(s.finished, k),
      }));
    if (refetchMode === 'hold') held.push(settle);
    else void Promise.resolve().then(() => settle(refetchMode === 'ok'));
    return k;
  };
  if (!open) return null;
  const list = listed ?? shown.claims;
  const cents = splitPreview(600, list);
  const claimers: SheetClaimer[] = MEMBERS.filter((m) => list[m.userId] !== undefined)
    .sort((a, b) => Number(b.isMe) - Number(a.isMe))
    .map((m) => ({ person: m, cents: cents[m.userId] ?? 0, parts: list[m.userId] ?? 1 }));
  return (
    <ItemSheet
      label="Fries"
      priceCents={600}
      status="status line"
      claimers={claimers}
      canEdit={canEdit}
      custom={new Set(Object.values(shown.claims)).size > 1}
      saving={false}
      error={null}
      onSave={() => {
        throw new Error('a group bill never saves through onSave');
      }}
      onClose={() => setOpen(false)}
      assign={{
        lineItemId: ROW,
        members: MEMBERS,
        current: shown.claims,
        refetch,
        version: shown.version,
        finished: shown.finished,
      }}
    />
  );
}

function renderSheet(initial: Record<string, number>, opts: { canEdit?: boolean; listed?: Record<string, number> } = {}) {
  server.claims = { ...initial };
  render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <Screen initial={initial} canEdit={opts.canEdit} listed={opts.listed} />
    </SafeAreaProvider>,
  );
}

const assignCalls = () => supabase.rpc.mock.calls.filter(([fn]) => fn === 'assign_item');
const chip = (label: string) => screen.getByRole('checkbox', { name: label });
const flush = () => act(async () => {});

beforeEach(() => {
  jest.clearAllMocks();
  refetchMode = 'ok';
  held.length = 0;
  refetchCount = 0;
  // A write succeeds and the server then holds what was sent.
  supabase.__setRpc((fn, args) => {
    if (fn === 'assign_item') server.claims = { ...(args as { p_parts: Record<string, number> }).p_parts };
    return { data: null, error: null };
  });
});

describe.each(['ios', 'android', 'web'] as const)('on %s', (os) => {
  beforeEach(() => jest.replaceProperty(Platform, 'OS', os));

  it('84/86: one checkbox chip per member, viewer first, then by name; checked state and labels', () => {
    renderSheet({ [BEN]: 1 });
    expect(screen.getByRole('header', { name: 'Who had this?' })).toBeTruthy();
    const chips = screen.getAllByRole('checkbox');
    expect(chips.map((c) => c.props.accessibilityLabel)).toEqual([
      "You didn't have this",
      'Ben Okafor, had this',
      "Cy, didn't have this",
      "Dee Park, didn't have this",
    ]);
    expect(chip('Ben Okafor, had this').props.accessibilityState).toMatchObject({ checked: true });
    expect(chip("You didn't have this").props.accessibilityState).toMatchObject({ checked: false });
    expect(chip('Ben Okafor, had this').props.accessibilityHint).toBe('Takes Ben Okafor off this item');
    expect(chip("You didn't have this").props.accessibilityHint).toBe('Puts you on this item');
    // Chips show first names (full names stay in the labels).
    expect(within(chip('Ben Okafor, had this')).getByText('Ben')).toBeTruthy();
    expect(within(chip("Dee Park, didn't have this")).getByText('Dee')).toBeTruthy();
    expect(within(chip("You didn't have this")).getByText('You')).toBeTruthy();
  });
});

describe('assigning', () => {
  it('84: tapping Ben sends assign_item once with the shown map as expected; the chip is busy until the refetch lands', async () => {
    refetchMode = 'hold';
    renderSheet({ [ANA]: 2 });
    fireEvent.press(chip("Ben Okafor, didn't have this"));
    fireEvent.press(chip("Ben Okafor, didn't have this")); // a double tap sends nothing more
    fireEvent.press(chip("Cy, didn't have this")); // nor does another chip while one is busy
    await flush();
    expect(assignCalls()).toEqual([
      ['assign_item', { p_line_item_id: ROW, p_parts: { [ANA]: 2, [BEN]: 1 }, p_expected: { [ANA]: 2 } }],
    ]);
    // The write is done and its refetch is out: still busy, and nothing else can be tapped.
    expect(refetchCount).toBe(1);
    expect(chip("Ben Okafor, didn't have this").props.accessibilityState).toMatchObject({ busy: true });
    expect(chip("Cy, didn't have this").props.accessibilityState).toMatchObject({ disabled: true });

    await act(async () => held.shift()?.(true));
    expect(chip('Ben Okafor, had this').props.accessibilityState).toMatchObject({ checked: true, busy: false, disabled: false });
    expect(chip("Cy, didn't have this").props.accessibilityState).toMatchObject({ disabled: false });
    // The claimers list follows the server's map.
    expect(screen.getByLabelText('Ben Okafor $2.00')).toBeTruthy();
    expect(screen.getByLabelText('You $4.00')).toBeTruthy();
  });

  it('taking yourself off sends the map without you', async () => {
    renderSheet({ [ANA]: 1, [CY]: 3 });
    fireEvent.press(chip('You had this'));
    await flush();
    expect(assignCalls()[0]?.[1]).toEqual({ p_line_item_id: ROW, p_parts: { [CY]: 3 }, p_expected: { [ANA]: 1, [CY]: 3 } });
    expect(await screen.findByRole('checkbox', { name: "You didn't have this" })).toBeTruthy();
  });

  it('announces the result on native once the refetch shows it', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    renderSheet({});
    fireEvent.press(chip("Ben Okafor, didn't have this"));
    await screen.findByRole('checkbox', { name: 'Ben Okafor, had this' });
    expect(announce).toHaveBeenCalledWith('Ben Okafor, had this');
  });

  it('84: claims_changed refetches, keeps the sheet open and shows the fixed copy', async () => {
    renderSheet({ [ANA]: 1 });
    // Someone else added Cy meanwhile, so the shown map is stale.
    supabase.__setRpc(() => {
      server.claims = { [ANA]: 1, [CY]: 1 };
      return { data: null, error: { code: '22023', message: 'claims_changed' } };
    });
    fireEvent.press(chip("Ben Okafor, didn't have this"));
    const alert = await screen.findByText('Someone changed this item. Check and try again.');
    expect(alert).toBeTruthy();
    // Announced: the banner is an alert (it isn't focusable, so it's found by its props).
    expect(screen.UNSAFE_getByProps({ accessibilityRole: 'alert' })).toBeTruthy();
    expect(refetchCount).toBe(1);
    // The refetch shows the server's map; the chips are usable again; the sheet stayed open.
    expect(await screen.findByRole('checkbox', { name: 'Cy, had this' })).toBeTruthy();
    expect(chip("Ben Okafor, didn't have this").props.accessibilityState).toMatchObject({ checked: false, busy: false, disabled: false });
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();

    // Trying again sends the new map as expected, and clears the message.
    supabase.__setRpc((fn, args) => {
      if (fn === 'assign_item') server.claims = { ...(args as { p_parts: Record<string, number> }).p_parts };
      return { data: null, error: null };
    });
    fireEvent.press(chip("Ben Okafor, didn't have this"));
    expect(screen.queryByText('Someone changed this item. Check and try again.')).toBeNull();
    await screen.findByRole('checkbox', { name: 'Ben Okafor, had this' });
    expect(assignCalls().at(-1)?.[1]).toEqual({
      p_line_item_id: ROW,
      p_parts: { [ANA]: 1, [CY]: 1, [BEN]: 1 },
      p_expected: { [ANA]: 1, [CY]: 1 },
    });
  });

  it('a write that worked but whose refetch failed re-enables the chips with Try again', async () => {
    refetchMode = 'fail';
    renderSheet({});
    fireEvent.press(chip("Cy, didn't have this"));
    expect(await screen.findByText("Couldn't refresh this item. Try again.")).toBeTruthy();
    expect(chip("Cy, didn't have this").props.accessibilityState).toMatchObject({ busy: false, disabled: false });

    refetchMode = 'ok';
    const retry = screen.getByRole('button', { name: 'Try again' });
    expect(retry.props.accessibilityHint).toBe('Loads the latest for this item');
    fireEvent.press(retry);
    expect(await screen.findByRole('checkbox', { name: 'Cy, had this' })).toBeTruthy();
    expect(screen.queryByText("Couldn't refresh this item. Try again.")).toBeNull();
    expect(assignCalls()).toHaveLength(1);
  });

  it('a Try again whose refetch fails again keeps the message and the button', async () => {
    refetchMode = 'fail';
    renderSheet({});
    fireEvent.press(chip("Cy, didn't have this"));
    fireEvent.press(await screen.findByRole('button', { name: 'Try again' }));
    await flush();
    expect(refetchCount).toBe(2);
    expect(screen.getByText("Couldn't refresh this item. Try again.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('any other failure shows fixed copy (never the server text), with no refetch', async () => {
    supabase.__setRpc(() => ({ data: null, error: { code: '08006', message: 'server text: boom' } }));
    renderSheet({ [ANA]: 1 });
    fireEvent.press(chip("Ben Okafor, didn't have this"));
    expect(await screen.findByText('Something went wrong. Check your connection and try again.')).toBeTruthy();
    expect(screen.queryByText(/server text/)).toBeNull();
    expect(refetchCount).toBe(0);
    expect(chip("Ben Okafor, didn't have this").props.accessibilityState).toMatchObject({ busy: false, disabled: false });
  });

  it('not_allowed (the bill left the group, or you left) shows its fixed copy', async () => {
    supabase.__setRpc(() => ({ data: null, error: { code: '42501', message: 'not_allowed' } }));
    renderSheet({});
    fireEvent.press(chip("Cy, didn't have this"));
    expect(await screen.findByText("You can't make that change.")).toBeTruthy();
  });

  it('closing the sheet while a write is out still refetches the bill', async () => {
    let resolve: (r: FakeResult) => void = () => {};
    supabase.__setRpc(() => new Promise<FakeResult>((r) => (resolve = r)));
    renderSheet({});
    fireEvent.press(chip("Cy, didn't have this"));
    fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('checkbox')).toBeNull();
    await act(async () => resolve({ data: null, error: null }));
    expect(refetchCount).toBe(1);
  });

  it('chips are at least 44 pt tall and show the checked state by a mark, not only color', () => {
    renderSheet({ [BEN]: 1 });
    for (const c of screen.getAllByRole('checkbox')) {
      const style = StyleSheet.flatten(typeof c.props.style === 'function' ? c.props.style({ pressed: false }) : c.props.style);
      expect(style.minHeight).toBeGreaterThanOrEqual(TOUCH_TARGET);
    }
    expect(within(chip('Ben Okafor, had this')).getByTestId('assign-chip-checked')).toBeTruthy();
    expect(within(chip("Cy, didn't have this")).queryByTestId('assign-chip-checked')).toBeNull();
    expect(within(chip("Cy, didn't have this")).getByTestId('assign-chip-add')).toBeTruthy();
  });

  it('a group bill has no "claim this" hint and no "nobody has claimed" line (the chips say it)', () => {
    renderSheet({});
    expect(screen.getAllByRole('checkbox')).toHaveLength(4);
    expect(screen.queryByText('Nobody has claimed this yet.')).toBeNull();
    expect(screen.queryByText(/^Claim this item/)).toBeNull();
  });
});

describe('splitting differently on a group bill', () => {
  it('is offered to any member, not only claimers, and saves through assign_item', async () => {
    renderSheet({ [BEN]: 1, [CY]: 1 }, { canEdit: false });
    fireEvent.press(screen.getByRole('button', { name: 'Split differently' }));
    fireEvent.press(screen.getByRole('button', { name: 'More parts for Ben Okafor' }));
    expect(screen.getByLabelText('Ben Okafor $4.00')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Save split' }));
    await flush();
    expect(assignCalls()).toEqual([
      ['assign_item', { p_line_item_id: ROW, p_parts: { [BEN]: 2, [CY]: 1 }, p_expected: { [BEN]: 1, [CY]: 1 } }],
    ]);
    expect(supabase.rpc.mock.calls.some(([fn]) => fn === 'set_item_split')).toBe(false);
    // After the refetch the editor closes and the saved split shows.
    expect(await screen.findByRole('button', { name: 'Split differently' })).toBeTruthy();
    expect(screen.getByLabelText('Ben Okafor $4.00')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reset to even' })).toBeTruthy();
  });

  it('Save split is busy until the refetch lands; a failed save keeps the draft and re-enables it', async () => {
    let resolve: (r: FakeResult) => void = () => {};
    supabase.__setRpc(() => new Promise<FakeResult>((r) => (resolve = r)));
    renderSheet({ [ANA]: 1, [BEN]: 1 });
    fireEvent.press(screen.getByRole('button', { name: 'Split differently' }));
    fireEvent.press(screen.getByRole('button', { name: 'More parts for You' }));
    fireEvent.press(screen.getByRole('button', { name: 'Save split' }));
    expect(screen.getByRole('button', { name: 'Save split' }).props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByRole('checkbox', { name: 'You had this' }).props.accessibilityState).toMatchObject({ disabled: true });

    await act(async () => resolve({ data: null, error: { code: '08006', message: 'x' } }));
    expect(screen.getByText('Something went wrong. Check your connection and try again.')).toBeTruthy();
    expect(screen.getByText('2 parts')).toBeTruthy();
    expect(screen.getByLabelText('You $4.00')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save split' }).props.accessibilityState).toMatchObject({ disabled: false });
  });

  it('claims_changed on a split keeps the editor open with the new claimers and the copy', async () => {
    renderSheet({ [ANA]: 1, [BEN]: 1 });
    supabase.__setRpc(() => {
      server.claims = { [ANA]: 1, [BEN]: 1, [CY]: 1 };
      return { data: null, error: { code: '22023', message: 'claims_changed' } };
    });
    fireEvent.press(screen.getByRole('button', { name: 'Split differently' }));
    fireEvent.press(screen.getByRole('button', { name: 'More parts for You' }));
    fireEvent.press(screen.getByRole('button', { name: 'Save split' }));
    expect(await screen.findByRole('button', { name: 'More parts for Cy' })).toBeTruthy();
    expect(screen.getByText('Someone changed this item. Check and try again.')).toBeTruthy();
    expect(screen.getByText('2 parts')).toBeTruthy();
  });

  it('Reset to even goes through assign_item with every claimer at 1', async () => {
    renderSheet({ [ANA]: 3, [BEN]: 1 });
    fireEvent.press(screen.getByRole('button', { name: 'Reset to even' }));
    await flush();
    expect(assignCalls()).toEqual([
      ['assign_item', { p_line_item_id: ROW, p_parts: { [ANA]: 1, [BEN]: 1 }, p_expected: { [ANA]: 3, [BEN]: 1 } }],
    ]);
    expect(await screen.findByLabelText('You $3.00')).toBeTruthy();
  });
});

// Review R2-S1: on a group bill a split save starts from the server's map (assign.current, which is
// also p_expected), never from the claimers list, which can lag behind or hold an optimistic claim.
describe('a split save uses the server map, not the claimers list (R2-S1)', () => {
  it('someone missing from a stale list is kept, at their parts', async () => {
    renderSheet({ [ANA]: 1, [BEN]: 1, [CY]: 3 }, { listed: { [ANA]: 1, [BEN]: 1 } });
    expect(screen.queryByLabelText(/^Cy \$/)).toBeNull(); // the list really lacks Cy
    fireEvent.press(screen.getByRole('button', { name: 'Split differently' }));
    fireEvent.press(screen.getByRole('button', { name: 'More parts for You' }));
    fireEvent.press(screen.getByRole('button', { name: 'Save split' }));
    await flush();
    expect(assignCalls()).toEqual([
      ['assign_item', { p_line_item_id: ROW, p_parts: { [ANA]: 2, [BEN]: 1, [CY]: 3 }, p_expected: { [ANA]: 1, [BEN]: 1, [CY]: 3 } }],
    ]);
  });

  it('an extra optimistic claim in the list is not added', async () => {
    renderSheet({ [ANA]: 1, [BEN]: 1 }, { listed: { [ANA]: 1, [BEN]: 1, [DEE]: 1 } });
    expect(screen.getByLabelText('Dee Park $2.00')).toBeTruthy(); // the list really has Dee
    fireEvent.press(screen.getByRole('button', { name: 'Split differently' }));
    fireEvent.press(screen.getByRole('button', { name: 'More parts for You' }));
    fireEvent.press(screen.getByRole('button', { name: 'Save split' }));
    await flush();
    expect(assignCalls()).toEqual([
      ['assign_item', { p_line_item_id: ROW, p_parts: { [ANA]: 2, [BEN]: 1 }, p_expected: { [ANA]: 1, [BEN]: 1 } }],
    ]);
  });

  it('Reset to even covers exactly the server map', async () => {
    renderSheet({ [ANA]: 3, [CY]: 1 }, { listed: { [ANA]: 3, [BEN]: 1 } });
    fireEvent.press(screen.getByRole('button', { name: 'Reset to even' }));
    await flush();
    expect(assignCalls()).toEqual([
      ['assign_item', { p_line_item_id: ROW, p_parts: { [ANA]: 1, [CY]: 1 }, p_expected: { [ANA]: 3, [CY]: 1 } }],
    ]);
  });
});

// What the browser gets: react-native-web 0.21 drops accessibilityState, so the chips also pass
// aria-* (lib/ariaProps). Rendered through react-native-web to static HTML, as in uiPrimitives.test.
describe('on web: the chips carry aria-checked (react-native-web markup)', () => {
  function chipTags(props: { busyId: string | null; disabled: boolean }): Record<string, string> {
    let html = '';
    jest.isolateModules(() => {
      jest.doMock('react-native', () => jest.requireActual('react-native-web'));
      // lucide's native SVG doesn't render under react-dom; icons aren't what's checked here.
      jest.doMock('@/components/ui/Icon', () => ({ Icon: () => null }));
      const React = jest.requireActual<typeof import('react')>('react');
      // @types/react-dom isn't installed; this is the one function used.
      const { renderToStaticMarkup } = jest.requireActual<{ renderToStaticMarkup: (el: React.ReactElement) => string }>('react-dom/server');
      const { AssignChips: Web } = jest.requireActual<typeof import('@/components/AssignChips')>('@/components/AssignChips');
      html = renderToStaticMarkup(
        React.createElement(Web, { members: MEMBERS, current: { [BEN]: 1 }, noun: 'item', onToggle: () => {}, ...props }),
      );
    });
    const out: Record<string, string> = {};
    for (const label of ['Ben Okafor, had this', "You didn't have this"]) {
      const found = html.match(new RegExp(`<[a-z]+ [^>]*aria-label="${label.replace("'", '&#x27;')}"[^>]*>`, 'g')) ?? [];
      if (found.length !== 1) throw new Error(`${found.length} tags labelled ${label} in ${html}`);
      out[label] = found[0] ?? '';
    }
    return out;
  }

  it('checked and unchecked, not busy', () => {
    const t = chipTags({ busyId: null, disabled: false });
    const ben = t['Ben Okafor, had this']!;
    const you = t["You didn't have this"]!;
    expect(ben).toContain('role="checkbox"'); // positive control: the web checkbox
    expect(ben).toContain('aria-checked="true"');
    expect(you).toContain('aria-checked="false"');
    expect(ben).toContain('aria-busy="false"');
    expect(ben).not.toContain('aria-disabled="true"');
  });

  it('while a write is out: the busy chip says busy, every chip says disabled', () => {
    const t = chipTags({ busyId: BEN, disabled: true });
    expect(t['Ben Okafor, had this']).toContain('aria-busy="true"');
    expect(t["You didn't have this"]).toContain('aria-busy="false"');
    for (const tag of Object.values(t)) expect(tag).toContain('aria-disabled="true"');
  });
});
