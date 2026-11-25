// Activity screen: criteria 138–140 in docs/specs/2026-11-20-m1b-m2-share-and-claim.md (Task 17).
// Criterion 137 (the bill screen's "Activity" link) is in billScreen.test.tsx; 155 in extrasSplit.test.tsx.
// Hana Lee is the host; the viewer is Bo. Pat and Rae Kim are the other participants.
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

import { defaultTimeFormatters, timeLabel, timeLabelText } from '@/lib/activityText';
import { LIVE_DEBOUNCE_MS } from '@/lib/billLive';
import { supabase as realSupabase } from '@/lib/supabase';
import { fakeSession, type FakeChannel, type FakeResult, type FakeSupabase } from '@/test-utils/fakes';

jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});

const supabase = realSupabase as unknown as FakeSupabase;
const ROUTES = './app';

const BILL = '11111111-1111-4111-8111-111111111111';
const HANA = '00000000-0000-4000-8000-00000000000a';
const BO = '00000000-0000-4000-8000-00000000000b';
const PAT = '00000000-0000-4000-8000-00000000000c';
const RAE = '00000000-0000-4000-8000-00000000000d';

type EventRow = {
  id: string;
  actor_id: string | null;
  kind: string;
  item_name: string | null;
  details: unknown;
  created_at: string;
};

const db: { events: EventRow[]; participants: Record<string, unknown>[]; failEvents: boolean } = {
  events: [],
  participants: [],
  failEvents: false,
};

let seq = 0;
/** Ids increase with `seq`, so within one timestamp the later event sorts first (id desc). */
function event(kind: string, actor: string | null, details: unknown, itemName: string | null, at: Date): EventRow {
  seq += 1;
  const id = `eeeeeeee-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  return { id, actor_id: actor, kind, item_name: itemName, details, created_at: at.toISOString() };
}

function times() {
  const now = new Date();
  return {
    justNow: new Date(now.getTime() - 30_000),
    yesterday: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12),
    older: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 5, 12),
  };
}

const header = (at: Date) => timeLabelText(timeLabel(at.toISOString(), new Date(), defaultTimeFormatters));

function fixture() {
  const t = times();
  return [
    event('bill_created', HANA, { items: 4, total_cents: 4480 }, null, t.older),
    event('joined', BO, {}, null, t.older),
    event('joined', null, {}, null, t.older), // a deleted account
    event('claimed', BO, { unit: null, split: null }, 'Fries', t.yesterday),
    event('claimed', RAE, { unit: [0, 2], split: null }, 'Beer', t.yesterday),
    event('confetti', HANA, { x: 1 }, null, t.yesterday), // unknown kind: skipped
    event('amounts_changed', HANA, { total_cents: 'lots' }, null, t.yesterday), // malformed: skipped
    // Criterion 127's update_bill, all from one transaction (same created_at).
    event('item_changed', HANA, { price_cents: [1500, 1800] }, 'Burger', t.justNow),
    event('item_changed', HANA, { qty: [2, 1], price_cents: [1400, 700] }, 'Beer', t.justNow),
    event('item_removed', HANA, { qty: 1, price_cents: 300, claimer_ids: [PAT, RAE] }, 'Soda', t.justNow),
    event('item_added', HANA, { qty: 1, price_cents: 900 }, 'Wings', t.justNow),
    event('amounts_changed', HANA, { total_cents: [4480, 4630] }, null, t.justNow),
  ];
}

function reset() {
  seq = 0;
  db.events = [];
  db.failEvents = false;
  db.participants = [
    { user_id: HANA, profile: { display_name: 'Hana Lee' } },
    { user_id: BO, profile: { display_name: 'Bo' } },
    { user_id: PAT, profile: { display_name: 'Pat' } },
    { user_id: RAE, profile: { display_name: 'Rae Kim' } },
  ];
}

function installTables() {
  const ok = (data: unknown): FakeResult => ({ data, error: null });
  supabase.__setTable('bill_events', () =>
    db.failEvents
      ? { data: null, error: { code: '08006', message: 'server text for ada@example.com' } }
      : // The fake doesn't sort; return newest first as the query asks.
        ok(
          [...db.events].sort(
            (a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
          ),
        ),
  );
  supabase.__setTable('bill_participants', () => ok(db.participants));
}

const eventFetches = () => supabase.__queries.filter((q) => q.table === 'bill_events').length;
const liveChannel = (): FakeChannel => {
  const ch = supabase.__channels.filter((c) => !c.removed).at(-1);
  if (!ch) throw new Error('no open channel');
  return ch;
};

async function openActivity(id = BILL) {
  const router = renderRouter(ROUTES, { initialUrl: `/bills/${id}/activity` });
  await screen.findByText('Activity');
  return router;
}

beforeEach(() => {
  jest.clearAllMocks();
  reset();
  installTables();
  supabase.__queries.length = 0;
  const session = fakeSession('Bo');
  // The session carries an email on purpose: it must never be shown (criterion 140).
  supabase.__setInitialSession({ ...session, user: { ...session.user, id: BO } });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('activity screen', () => {
  it('138: time headers newest first, one plain sentence per event with initials; bad events are skipped', async () => {
    db.events = fixture();
    const t = times();
    await openActivity();

    const headers = screen.getAllByRole('header').map((h) => h.props.children as string);
    expect(headers).toEqual(['Activity', 'Just now', header(t.yesterday), header(t.older)]);
    expect(header(t.yesterday)).toBe('Yesterday');

    const sentences = [
      // Just now: one transaction, ordered by id (newest id first).
      'Hana Lee changed the total from $44.80 to $46.30',
      'Hana Lee added Wings ($9.00)',
      "Hana Lee removed Soda (Pat's and Rae Kim's claims were removed)",
      'Hana Lee changed Beer: quantity 2 → 1, price $14.00 → $7.00',
      'Hana Lee changed Burger from $15.00 to $18.00',
      // Yesterday.
      'Rae Kim claimed Beer (1 of 2)',
      'You claimed Fries',
      // Older.
      'Someone joined',
      'You joined',
      'Hana Lee created the bill ($44.80, 4 items)',
    ];
    const shown = screen.getAllByText(/^(Hana Lee|Rae Kim|You|Someone) /).map((n) => n.props.children as string);
    expect(shown).toEqual(sentences);

    // Initials avatars: one per entry; a deleted account shows "?".
    expect(screen.getAllByText('HL')).toHaveLength(6);
    expect(screen.getAllByText('RK')).toHaveLength(1);
    expect(screen.getAllByText('B')).toHaveLength(2);
    expect(screen.getAllByText('?')).toHaveLength(1);

    // The unknown and malformed events render nothing.
    expect(screen.queryByText(/confetti|lots|undefined|NaN|\[object Object\]/)).toBeNull();
  });

  it('138: a group whose events are all skipped gets no header', async () => {
    const t = times();
    db.events = [event('confetti', HANA, {}, null, t.yesterday), event('joined', PAT, {}, null, t.older)];
    await openActivity();
    expect(screen.getByText('Pat joined')).toBeTruthy();
    expect(screen.queryByText('Yesterday')).toBeNull();
  });

  it('139: a live hint refetches once after the debounce, and the new event appears under "Just now"', async () => {
    db.events = fixture();
    await openActivity();
    await waitFor(() => expect(liveChannel().subscribe).toHaveBeenCalled());
    const ch = liveChannel();
    expect(ch.topic).toBe(`bill:${BILL}`);
    const base = eventFetches();

    jest.useFakeTimers();
    db.events = [...db.events, event('claimed', PAT, { unit: null, split: null }, 'Wings', new Date())];
    act(() => {
      ch.__broadcast('changed', { t: 'claims' });
      ch.__broadcast('changed', { t: 'bills' });
    });
    act(() => jest.advanceTimersByTime(LIVE_DEBOUNCE_MS - 1));
    expect(eventFetches()).toBe(base);
    await act(async () => jest.advanceTimersByTime(1));
    expect(eventFetches()).toBe(base + 1);
    jest.useRealTimers();

    expect(await screen.findByText('Pat claimed Wings')).toBeTruthy();
    // Newest first: it's the first sentence on screen.
    expect(screen.getAllByText(/^(Hana Lee|Rae Kim|You|Someone|Pat) /)[0]?.props.children).toBe('Pat claimed Wings');
  });

  it('139: the empty state', async () => {
    await openActivity();
    expect(await screen.findByText('Nothing yet. Claims and changes will show up here.')).toBeTruthy();
  });

  it('140: an unknown or inaccessible bill shows the no-access copy, never an email', async () => {
    db.participants = []; // RLS returns nothing to a non-participant
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/activity` });
    expect(await screen.findByText("You don't have access to this bill, or it doesn't exist.")).toBeTruthy();
    expect(screen.getByText('Go home')).toBeTruthy();
    expect(screen.queryByText(/@/)).toBeNull();
  });

  it('140: a malformed bill id shows the no-access copy without querying', async () => {
    renderRouter(ROUTES, { initialUrl: '/bills/not-a-bill/activity' });
    expect(await screen.findByText("You don't have access to this bill, or it doesn't exist.")).toBeTruthy();
    expect(eventFetches()).toBe(0);
  });

  it('a failed load shows fixed copy (never server text) and retries', async () => {
    db.failEvents = true;
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/activity` });
    expect(await screen.findByText("Couldn't load the activity.")).toBeTruthy();
    expect(screen.queryByText(/server text|@/)).toBeNull();

    db.failEvents = false;
    db.events = [event('joined', PAT, {}, null, new Date())];
    fireEvent.press(screen.getByText('Try again'));
    expect(await screen.findByText('Pat joined')).toBeTruthy();
  });

  it('"Back to bill" goes to the bill', async () => {
    const router = await openActivity();
    fireEvent.press(screen.getByLabelText('Back to bill'));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
  });

  it('leaving the screen removes its channel', async () => {
    const router = await openActivity();
    await waitFor(() => expect(liveChannel().subscribe).toHaveBeenCalled());
    const ch = liveChannel();
    router.unmount();
    await waitFor(() => expect(ch.removed).toBe(true));
  });
});
