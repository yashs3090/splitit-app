import { ASSIGN_COPY, MAX_ASSIGN_PARTS, assignChipHint, assignChips, chipNames, toggleAssignee } from './itemAssign';

const ANA = 'aaaaaaaa-0000-4000-8000-000000000001';
const BEN = 'aaaaaaaa-0000-4000-8000-000000000002';
const CY = 'aaaaaaaa-0000-4000-8000-000000000003';
const DEE = 'aaaaaaaa-0000-4000-8000-000000000004';
const NAMES: Record<string, string> = { [ANA]: 'Ana', [BEN]: 'Ben', [CY]: 'Cy', [DEE]: 'dee' };
const asViewer = (viewer: string) => (id: string) => (id === viewer ? 'You' : (NAMES[id] ?? 'A friend'));

describe('toggleAssignee (criterion 59)', () => {
  it('adds a new person at 1 part and keeps everyone else’s parts', () => {
    const current = { [ANA]: 2, [CY]: 3 };
    expect(toggleAssignee(current, BEN)).toEqual({ [ANA]: 2, [CY]: 3, [BEN]: 1 });
  });

  it('adds to an empty map', () => {
    expect(toggleAssignee({}, BEN)).toEqual({ [BEN]: 1 });
  });

  it('removes a person cleanly (the key is gone, others unchanged)', () => {
    const next = toggleAssignee({ [ANA]: 2, [BEN]: 1, [CY]: 5 }, BEN);
    expect(next).toEqual({ [ANA]: 2, [CY]: 5 });
    expect(Object.keys(next)).not.toContain(BEN);
  });

  it('removing the last person gives {} (nobody had it)', () => {
    expect(toggleAssignee({ [BEN]: 4 }, BEN)).toEqual({});
  });

  it('never mutates its input', () => {
    const current = { [ANA]: 2 };
    toggleAssignee(current, BEN);
    toggleAssignee(current, ANA);
    expect(current).toEqual({ [ANA]: 2 });
  });

  it('keeps parts at the 1 and 20 bounds', () => {
    expect(toggleAssignee({ [ANA]: 1, [CY]: MAX_ASSIGN_PARTS }, BEN)).toEqual({ [ANA]: 1, [CY]: 20, [BEN]: 1 });
  });

  it.each<[string, Record<string, number>]>([
    ['0 parts', { [ANA]: 0 }],
    ['21 parts', { [ANA]: 21 }],
    ['negative parts', { [ANA]: -1 }],
    ['fractional parts', { [ANA]: 1.5 }],
    ['NaN parts', { [ANA]: Number.NaN }],
  ])('refuses a current map with %s (never returns parts outside 1..20)', (_label, current) => {
    expect(() => toggleAssignee(current, BEN)).toThrow(RangeError);
    // Even when the bad entry is the one being removed: the input is broken, so nothing is sent.
    expect(() => toggleAssignee(current, ANA)).toThrow(RangeError);
  });

  it('refuses an empty user id', () => {
    expect(() => toggleAssignee({}, '')).toThrow(RangeError);
  });

  it('every result has only integer parts in 1..20', () => {
    const maps: Record<string, number>[] = [{}, { [ANA]: 20 }, { [ANA]: 3, [BEN]: 1 }];
    for (const m of maps) {
      for (const id of [ANA, BEN, CY]) {
        for (const parts of Object.values(toggleAssignee(m, id))) {
          expect(Number.isInteger(parts) && parts >= 1 && parts <= 20).toBe(true);
        }
      }
    }
  });
});

describe('assignChips', () => {
  const members = [{ userId: DEE }, { userId: CY }, { userId: ANA }, { userId: BEN }];

  it('puts the viewer first, then everyone by name (case ignored)', () => {
    const chips = assignChips(members, {}, CY, asViewer(CY));
    expect(chips.map((c) => c.name)).toEqual(['You', 'Ana', 'Ben', 'dee']);
    expect(chips[0]).toMatchObject({ userId: CY, isViewer: true });
    expect(chips.slice(1).every((c) => !c.isViewer)).toBe(true);
  });

  it('marks who had it, with their parts', () => {
    const chips = assignChips(members, { [BEN]: 2, [CY]: 1 }, ANA, asViewer(ANA));
    expect(chips.map((c) => [c.name, c.checked, c.parts])).toEqual([
      ['You', false, null],
      ['Ben', true, 2],
      ['Cy', true, 1],
      ['dee', false, null],
    ]);
  });

  it('gives each chip its accessibility label (criterion 86 wording)', () => {
    const chips = assignChips(members, { [BEN]: 1, [ANA]: 1 }, ANA, asViewer(ANA));
    expect(chips.map((c) => c.a11yLabel)).toEqual(['You had this', 'Ben, had this', "Cy, didn't have this", "dee, didn't have this"]);
    const notMine = assignChips(members, {}, ANA, asViewer(ANA));
    expect(notMine[0]?.a11yLabel).toBe("You didn't have this");
  });

  it('a viewer who isn’t a member gets no chip; everyone is by name', () => {
    const chips = assignChips([{ userId: BEN }, { userId: ANA }], {}, CY, asViewer(CY));
    expect(chips.map((c) => c.name)).toEqual(['Ana', 'Ben']);
  });

  it('lists each member once and breaks name ties by id', () => {
    const twins = [{ userId: BEN }, { userId: ANA }, { userId: BEN }];
    const sameName = () => 'Sam';
    const chips = assignChips(twins, {}, CY, sameName);
    expect(chips.map((c) => c.userId)).toEqual([ANA, BEN]);
  });

  it('a blank or throwing name reads as "A friend"', () => {
    const chips = assignChips([{ userId: ANA }, { userId: BEN }], {}, CY, (id) => {
      if (id === ANA) return '  ';
      throw new Error('boom');
    });
    expect(chips.map((c) => c.name)).toEqual(['A friend', 'A friend']);
  });

  it('ignores claim keys that aren’t members (no chip for them)', () => {
    const chips = assignChips([{ userId: ANA }], { [DEE]: 1 }, ANA, asViewer(ANA));
    expect(chips).toHaveLength(1);
    expect(chips[0]?.checked).toBe(false);
  });

  it('no members → no chips', () => {
    expect(assignChips([], {}, ANA, asViewer(ANA))).toEqual([]);
  });
});

describe('chipNames (T18: chips show first names)', () => {
  const chip = (userId: string, name: string, isViewer = false) =>
    assignChips([{ userId }], {}, isViewer ? userId : 'nobody', () => name)[0]!;

  it('shows the first name, and "You" for the viewer', () => {
    const chips = [chip(ANA, 'You', true), chip(BEN, 'Ben Okafor'), chip(CY, 'Cy')];
    expect(chipNames(chips)).toEqual({ [ANA]: 'You', [BEN]: 'Ben', [CY]: 'Cy' });
  });

  it('two people with the same first name (case ignored) both show their full names', () => {
    const chips = [chip(ANA, 'Sam Lee'), chip(BEN, 'sam Park'), chip(CY, 'Cy Doe')];
    expect(chipNames(chips)).toEqual({ [ANA]: 'Sam Lee', [BEN]: 'sam Park', [CY]: 'Cy' });
  });

  it('"A friend" stays whole, even twice', () => {
    const chips = [chip(ANA, '  '), chip(BEN, '')];
    expect(chipNames(chips)).toEqual({ [ANA]: 'A friend', [BEN]: 'A friend' });
  });

  it('a viewer named like a friend does not make the friend show the full name', () => {
    const chips = [chip(ANA, 'You', true), chip(BEN, 'You Ng')];
    expect(chipNames(chips)).toEqual({ [ANA]: 'You', [BEN]: 'You' });
  });
});

describe('assignChipHint', () => {
  const [you, ben] = assignChips([{ userId: ANA }, { userId: BEN }], { [ANA]: 1 }, ANA, asViewer(ANA));

  it('says what a tap does, for the viewer and for someone else, item and discount', () => {
    expect(assignChipHint(you!, 'item')).toBe('Takes you off this item');
    expect(assignChipHint(ben!, 'item')).toBe('Puts Ben on this item');
    const [, benOn] = assignChips([{ userId: ANA }, { userId: BEN }], { [BEN]: 2 }, ANA, asViewer(ANA));
    const [youOff] = assignChips([{ userId: ANA }], {}, ANA, asViewer(ANA));
    expect(assignChipHint(benOn!, 'discount')).toBe('Takes Ben off this discount');
    expect(assignChipHint(youOff!, 'discount')).toBe('Puts you on this discount');
  });
});

describe('ASSIGN_COPY', () => {
  it('has the fixed words the sheet shows', () => {
    expect(ASSIGN_COPY).toEqual({
      heading: 'Who had this?',
      refreshFailed: "Couldn't refresh this item. Try again.",
      retry: 'Try again',
      retryHint: 'Loads the latest for this item',
      splitSaved: 'Split saved',
    });
  });
});
