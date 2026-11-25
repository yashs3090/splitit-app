// docs/specs/2026-11-24-people-and-invites.md: L4 search, D6 captions (Task 3), D7 listPeople (Task 4).
import { type FakeDbError, type FakeSupabase } from '@/test-utils/fakes';

import {
  addablePeople,
  filterPeople,
  listPeople,
  matchesQuery,
  personA11yLabel,
  personCaption,
  personName,
  type Person,
} from './people';
import { supabase as realSupabase } from './supabase';

jest.mock('./supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});

const supabase = realSupabase as unknown as FakeSupabase;

const SAM_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const ALI_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const SASHA_ID = 'bbbbbbbb-0000-4000-8000-000000000003';
const ALEX1_ID = 'bbbbbbbb-0000-4000-8000-000000000004';
const ALEX2_ID = 'bbbbbbbb-0000-4000-8000-000000000005';
const NONAME_ID = 'bbbbbbbb-0000-4000-8000-000000000006';
const SERVER_TEXT = 'permission denied for function people_i_split_with (ada@example.com)';

function person(userId: string, displayName: string | null, extra: Partial<Person> = {}): Person {
  return { userId, displayName, venmoUsername: null, sharedBills: 1, lastSharedAt: '2026-11-20T18:00:00Z', ...extra };
}

/** A fixed formatter, so tests don't depend on the machine's locale or time zone. */
const fmtDate = (d: Date) => (d.toISOString().startsWith('2026-11-20') ? 'Nov 20' : `D${d.toISOString().slice(0, 10)}`);

// ---------------------------------------------------------------------------
// L4 search (criterion 23)
// ---------------------------------------------------------------------------

describe('matchesQuery (L4)', () => {
  it.each<[string, string | null, string, boolean]>([
    ['S1', 'Sam Lee', 'sa', true],
    ['S2', 'Sam Lee', 'lee', true],
    ['S3', 'Sam Lee', 'am', false],
    ['S4', 'Sam Lee', '  SAM  ', true],
    ['S5', 'José Ruiz', 'jose', true],
    ['S6', 'Jose Ruiz', 'josé', true],
    ['S7', 'Sam Lee', 'sam l', true],
    ['S8', 'Sam Lee', 'sam x', false],
    ['S9', null, 'a', false],
    ['S10', null, '', true],
  ])('%s: %p ~ %p → %p', (_id, name, query, expected) => {
    expect(matchesQuery(name, query)).toBe(expected);
  });

  it('an empty or whitespace-only query matches everyone, a blank name included', () => {
    expect(matchesQuery('Sam Lee', '')).toBe(true);
    expect(matchesQuery('Sam Lee', '   ')).toBe(true);
    expect(matchesQuery('   ', '  ')).toBe(true);
  });

  it('a blank name matches only the empty query', () => {
    expect(matchesQuery('   ', 'a')).toBe(false);
  });

  it('every query word must start some word of the name, in any order', () => {
    expect(matchesQuery('Sam Lee', 'lee sam')).toBe(true);
    expect(matchesQuery('Sam Lee', 'le s')).toBe(true);
    // Two query words may start the same name word.
    expect(matchesQuery('Samantha', 'sam sa')).toBe(true);
  });

  it('folds accents and case on both sides, decomposed input included', () => {
    expect(matchesQuery('ÉLODIE Ñúñez', 'elodie nunez')).toBe(true);
    expect(matchesQuery('José Ruiz', 'JOSÉ')).toBe(true); // NFD in the name
    expect(matchesQuery('Zoë', 'zoe')).toBe(true);
  });

  it('splits names and queries on any whitespace', () => {
    expect(matchesQuery('Sam\tLee', 'lee')).toBe(true);
    expect(matchesQuery('Sam Lee', 'sam\n lee')).toBe(true);
  });

  it('matches a 60-character query using only its first 50 characters', () => {
    const word = 'x'.repeat(50);
    expect(matchesQuery(word, `${word}${'y'.repeat(10)}`)).toBe(true);
    expect(matchesQuery(`${word} Lee`, `${word} zzzzzzzzz`)).toBe(true); // the second word is cut off
    // Without the cut, the 51st character would have to match.
    expect(matchesQuery('x'.repeat(49), `${word}${'y'.repeat(10)}`)).toBe(false);
  });

  it('cuts by characters, not UTF-16 units, so an emoji is never split', () => {
    const query = `${'a'.repeat(49)}😀zz`; // 52 characters, 53 UTF-16 units
    expect(matchesQuery(`${'a'.repeat(49)}😀`, query)).toBe(true);
  });
});

describe('filterPeople and addablePeople (criterion 24)', () => {
  const sam = person(SAM_ID, 'Sam');
  const ali = person(ALI_ID, 'Ali');
  const sasha = person(SASHA_ID, 'Sasha');
  const list = [sam, ali, sasha];

  it('keeps the L2 order for any query', () => {
    expect(filterPeople(list, 'sa')).toEqual([sam, sasha]);
    expect(filterPeople(list, '')).toEqual(list);
    expect(filterPeople(list, 'zzz')).toEqual([]);
  });

  it('never sorts: a reversed input stays reversed', () => {
    expect(filterPeople([sasha, ali, sam], 's')).toEqual([sasha, sam]);
  });

  it('addablePeople drops exactly the participant ids and keeps the order', () => {
    expect(addablePeople(list, [ALI_ID])).toEqual([sam, sasha]);
    expect(addablePeople(list, [])).toEqual(list);
    expect(addablePeople(list, [SAM_ID, ALI_ID, SASHA_ID, 'someone-else'])).toEqual([]);
  });

  it("doesn't mutate its input", () => {
    const copy = [...list];
    filterPeople(list, 'sa');
    addablePeople(list, [SAM_ID]);
    expect(list).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// Captions and labels (criterion 25)
// ---------------------------------------------------------------------------

describe('personName', () => {
  it('is the trimmed name, or "A friend" when blank or missing', () => {
    expect(personName(person(SAM_ID, '  Sam Lee '))).toBe('Sam Lee');
    expect(personName(person(SAM_ID, null))).toBe('A friend');
    expect(personName(person(SAM_ID, '  '))).toBe('A friend');
  });
});

describe('personCaption (D6, PI-10)', () => {
  it('1 bill → "1 bill · Nov 20"', () => {
    const p = person(SAM_ID, 'Sam Lee');
    expect(personCaption(p, [p], fmtDate)).toBe('1 bill · Nov 20');
  });

  it('4 bills → "4 bills · last Nov 20" (date through the injected formatter)', () => {
    const p = person(SAM_ID, 'Sam Lee', { sharedBills: 4 });
    const seen: Date[] = [];
    const caption = personCaption(p, [p], (d) => {
      seen.push(d);
      return 'Nov 20';
    });
    expect(caption).toBe('4 bills · last Nov 20');
    expect(seen.map((d) => d.toISOString())).toEqual(['2026-11-20T18:00:00.000Z']);
  });

  it('two people whose names match ignoring case each show their handle; one without a handle shows none', () => {
    const a = person(ALEX1_ID, 'alex kim', { venmoUsername: 'alex-kim-1' });
    const b = person(ALEX2_ID, 'Alex Kim', { sharedBills: 2 });
    const all = [a, b, person(SAM_ID, 'Sam')];
    expect(personCaption(a, all, fmtDate)).toBe('1 bill · Nov 20 · @alex-kim-1');
    expect(personCaption(b, all, fmtDate)).toBe('2 bills · last Nov 20');
  });

  it('cleans the name before comparing (spaces around and between words)', () => {
    const a = person(ALEX1_ID, ' Alex  Kim ', { venmoUsername: 'alex-kim-1' });
    const b = person(ALEX2_ID, 'alex kim', { venmoUsername: 'akim_22' });
    expect(personCaption(a, [a, b], fmtDate)).toBe('1 bill · Nov 20 · @alex-kim-1');
    expect(personCaption(b, [a, b], fmtDate)).toBe('1 bill · Nov 20 · @akim_22');
  });

  it('a unique name never gets the suffix, even with a handle', () => {
    const sam = person(SAM_ID, 'Sam Lee', { venmoUsername: 'sam-lee' });
    const ali = person(ALI_ID, 'Ali', { venmoUsername: 'ali-99' });
    expect(personCaption(sam, [sam, ali], fmtDate)).toBe('1 bill · Nov 20');
  });

  it('two people with no name both read "A friend", so they are told apart too', () => {
    const a = person(NONAME_ID, null, { venmoUsername: 'friend-one' });
    const b = person(SAM_ID, '  ', { venmoUsername: 'friend-two' });
    expect(personCaption(a, [a, b], fmtDate)).toBe('1 bill · Nov 20 · @friend-one');
  });

  it('a name is not a duplicate of itself (same user id listed once)', () => {
    const p = person(SAM_ID, 'Sam', { venmoUsername: 'sam-lee' });
    expect(personCaption(p, [p], fmtDate)).toBe('1 bill · Nov 20');
  });
});

describe('personA11yLabel (D6)', () => {
  it('name, bills together and the date', () => {
    const p = person(SAM_ID, 'Sam Lee', { sharedBills: 4 });
    expect(personA11yLabel(p, [p], fmtDate)).toBe('Sam Lee, 4 bills together, last on Nov 20');
  });

  it('one bill reads "1 bill together, on Nov 20"', () => {
    const p = person(SAM_ID, 'Sam Lee');
    expect(personA11yLabel(p, [p], fmtDate)).toBe('Sam Lee, 1 bill together, on Nov 20');
  });

  it('adds the Venmo handle exactly when the caption shows it', () => {
    const a = person(ALEX1_ID, 'Alex Kim', { venmoUsername: 'alex-kim-1', sharedBills: 3 });
    const b = person(ALEX2_ID, 'alex kim');
    expect(personA11yLabel(a, [a, b], fmtDate)).toBe('Alex Kim, 3 bills together, last on Nov 20, Venmo @alex-kim-1');
    expect(personA11yLabel(b, [a, b], fmtDate)).toBe('alex kim, 1 bill together, on Nov 20');
    expect(personA11yLabel(a, [a], fmtDate)).not.toContain('Venmo');
  });

  it('uses "A friend" for a person with no name', () => {
    const p = person(NONAME_ID, null);
    expect(personA11yLabel(p, [p], fmtDate)).toBe('A friend, 1 bill together, on Nov 20');
  });
});

// ---------------------------------------------------------------------------
// listPeople (Task 4, criterion 28)
// ---------------------------------------------------------------------------

type RawRow = {
  user_id: unknown;
  display_name: unknown;
  venmo_username: unknown;
  shared_bills: unknown;
  last_shared_at: unknown;
};

function raw(userId: string, name: string | null, extra: Partial<RawRow> = {}): RawRow {
  return {
    user_id: userId,
    display_name: name,
    venmo_username: null,
    shared_bills: 1,
    last_shared_at: '2026-11-20T18:00:00+00:00',
    ...extra,
  };
}

function rpcReturns(data: unknown, error: FakeDbError | null = null) {
  supabase.__setRpc(() => ({ data, error }));
}

describe('listPeople (D7)', () => {
  beforeEach(() => {
    supabase.rpc.mockClear();
    rpcReturns([]);
  });

  it('calls people_i_split_with with no arguments and keeps the order it receives', async () => {
    rpcReturns([
      raw(SAM_ID, 'Sam', { shared_bills: 3, venmo_username: 'sam-lee' }),
      raw(ALI_ID, null, { shared_bills: 1, last_shared_at: '2026-11-21T09:00:00Z' }),
      raw(SASHA_ID, 'Sasha'),
    ]);
    const res = await listPeople();
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc.mock.calls[0]).toEqual(['people_i_split_with']);
    expect(res).toEqual({
      ok: true,
      people: [
        {
          userId: SAM_ID,
          displayName: 'Sam',
          venmoUsername: 'sam-lee',
          sharedBills: 3,
          lastSharedAt: '2026-11-20T18:00:00+00:00',
        },
        { userId: ALI_ID, displayName: null, venmoUsername: null, sharedBills: 1, lastSharedAt: '2026-11-21T09:00:00Z' },
        {
          userId: SASHA_ID,
          displayName: 'Sasha',
          venmoUsername: null,
          sharedBills: 1,
          lastSharedAt: '2026-11-20T18:00:00+00:00',
        },
      ],
    });
  });

  it('an empty list is ok with no people (P8)', async () => {
    rpcReturns([]);
    expect(await listPeople()).toEqual({ ok: true, people: [] });
  });

  it('drops extra columns the server might add', async () => {
    rpcReturns([{ ...raw(SAM_ID, 'Sam'), email: 'sam@example.com' }]);
    const res = await listPeople();
    expect(res.ok && Object.keys(res.people[0] ?? {})).toEqual([
      'userId',
      'displayName',
      'venmoUsername',
      'sharedBills',
      'lastSharedAt',
    ]);
  });

  it.each<[string, unknown]>([
    ['a non-uuid id', [raw('sam', 'Sam')]],
    ['shared_bills 0', [raw(SAM_ID, 'Sam', { shared_bills: 0 })]],
    ['shared_bills 1.5', [raw(SAM_ID, 'Sam', { shared_bills: 1.5 })]],
    ['shared_bills "2"', [raw(SAM_ID, 'Sam', { shared_bills: '2' })]],
    ['shared_bills missing', [raw(SAM_ID, 'Sam', { shared_bills: undefined })]],
    ['a bad timestamp', [raw(SAM_ID, 'Sam', { last_shared_at: 'yesterday' })]],
    ['a null timestamp', [raw(SAM_ID, 'Sam', { last_shared_at: null })]],
    ['a handle failing VENMO_USERNAME_PATTERN', [raw(SAM_ID, 'Sam', { venmo_username: '@sam' })]],
    ['a too-short handle', [raw(SAM_ID, 'Sam', { venmo_username: 'sam' })]],
    ['a non-string name', [raw(SAM_ID, 42 as unknown as string)]],
    ['one bad row among good ones', [raw(SAM_ID, 'Sam'), raw(ALI_ID, 'Ali', { shared_bills: 0 })]],
    ['the same person twice', [raw(SAM_ID, 'Sam'), raw(SAM_ID, 'Sam')]],
    ['a row that is not an object', [null]],
    ['data that is not an array', { user_id: SAM_ID }],
    ['null data', null],
  ])('%s makes the whole result network', async (_label, data) => {
    rpcReturns(data);
    expect(await listPeople()).toEqual({ ok: false, error: 'network' });
  });

  it.each<[string, FakeDbError, 'not_allowed' | 'network']>([
    ['42501 not_allowed (signed out)', { code: '42501', message: 'not_allowed' }, 'not_allowed'],
    ["anon's permission denied", { code: '42501', message: SERVER_TEXT }, 'not_allowed'],
    ['an unknown SQLSTATE', { code: 'XX000', message: SERVER_TEXT }, 'network'],
    ['a fetch failure', { code: '', message: 'TypeError: Failed to fetch' }, 'network'],
  ])('maps %s', async (_label, error, expected) => {
    rpcReturns(null, error);
    const res = await listPeople();
    expect(res).toEqual({ ok: false, error: expected });
    expect(JSON.stringify(res)).not.toContain('@');
  });

  it('treats a thrown error as network', async () => {
    supabase.__setRpc(() => {
      throw new Error(SERVER_TEXT);
    });
    expect(await listPeople()).toEqual({ ok: false, error: 'network' });
  });
});
