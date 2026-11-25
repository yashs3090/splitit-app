// Live updates for one bill over a private Realtime channel.
// Spec: docs/specs/2026-11-20-m1b-m2-share-and-claim.md ("Realtime", design decision 7, Task 8).
//
// The database broadcasts event "changed" on the private topic bill:<id> whenever claims,
// participants or the bill change. The message carries no data ({"t": "<table>"} at most), and we
// never read it: every message is only a hint to re-read through the RLS-protected selects.
//
// Checked against the installed @supabase/supabase-js / realtime-js 2.109.0:
// - realtime.setAuth() with no argument fetches the current session's access token (the client
//   wires its accessToken callback to auth.getSession()). The channel join sends that token, so we
//   await it before joining. supabase-js only pushes tokens to Realtime on SIGNED_IN and
//   TOKEN_REFRESHED, not on a restored session, so without this a private join after an app restart
//   would go out with the anon key and be refused.
// - client.channel(topic) returns the EXISTING channel for a topic until it has been removed, and
//   subscribe() on an already-joined channel does nothing. So two screens on the same bill (the bill
//   screen stays mounted under Activity) must share one channel: we keep one per bill, with a set of
//   listeners, and remove it when the last listener leaves.
// - removeChannel() only drops the channel from the client after the server acknowledges the leave,
//   so a quick remount (or React StrictMode's double effect) waits for that before joining again.
//
// Refetch on screen focus and app foreground is the hook's job (lib/useBill.ts, Task 10).

/** Statuses the subscribe callback reports (REALTIME_SUBSCRIBE_STATES). */
export type LiveStatus = 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR';

export const LIVE_DEBOUNCE_MS = 300;
export const BILL_EVENT = 'changed';

/** The slice of a Realtime channel this module uses. The real RealtimeChannel satisfies it. */
export type LiveChannel = {
  on(type: 'broadcast', filter: { event: string }, callback: (message: unknown) => void): LiveChannel;
  subscribe(callback: (status: string, err?: Error) => void): LiveChannel;
};

/** The slice of the Supabase client this module uses. The real client satisfies it (checked in the test). */
export type LiveClient = {
  realtime: { setAuth(token?: string | null): Promise<void> };
  channel(topic: string, params: { config: { private: boolean } }): LiveChannel;
  removeChannel(channel: LiveChannel): Promise<unknown>;
};

type Listener = {
  onChange: () => void;
  onStatus: (status: LiveStatus) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

type Entry = {
  listeners: Set<Listener>;
  channel: LiveChannel | null;
  status: LiveStatus | null;
};

type Registry = {
  entries: Map<string, Entry>;
  /** Removal still waiting for the server's leave ack, per bill. */
  removing: Map<string, Promise<void>>;
};

const registries = new WeakMap<LiveClient, Registry>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: readonly string[] = ['SUBSCRIBED', 'TIMED_OUT', 'CLOSED', 'CHANNEL_ERROR'];

function registryFor(client: LiveClient): Registry {
  let reg = registries.get(client);
  if (!reg) {
    reg = { entries: new Map(), removing: new Map() };
    registries.set(client, reg);
  }
  return reg;
}

/** One screen's bug must not stop live updates for another screen on the same bill. */
function safely(fn: () => void) {
  try {
    fn();
  } catch {
    // Swallowed on purpose: callbacks belong to screens, which handle their own errors.
  }
}

function scheduleRefetch(listener: Listener) {
  if (listener.timer !== null) clearTimeout(listener.timer);
  listener.timer = setTimeout(() => {
    listener.timer = null;
    safely(listener.onChange);
  }, LIVE_DEBOUNCE_MS);
}

async function openChannel(client: LiveClient, reg: Registry, billId: string, entry: Entry) {
  try {
    await reg.removing.get(billId);
  } catch {
    // removeChannel failures are already swallowed; nothing to wait for.
  }
  try {
    await client.realtime.setAuth();
  } catch {
    // Join anyway: without a valid token the server refuses the private channel and we report
    // CHANNEL_ERROR, which the screen shows as "Live updates paused".
  }
  // Everyone left while we waited, or a newer entry replaced this one.
  if (entry.listeners.size === 0 || reg.entries.get(billId) !== entry) return;

  const channel = client.channel(`bill:${billId}`, { config: { private: true } });
  entry.channel = channel;
  channel
    // The message is ignored on purpose (it carries no data, and we never trust it).
    .on('broadcast', { event: BILL_EVENT }, () => {
      entry.listeners.forEach(scheduleRefetch);
    })
    .subscribe((raw) => {
      if (!STATUSES.includes(raw)) return;
      const status = raw as LiveStatus;
      entry.status = status;
      entry.listeners.forEach((l) => {
        safely(() => l.onStatus(status));
        // Every (re)join may have missed messages, so re-read.
        if (status === 'SUBSCRIBED') scheduleRefetch(l);
      });
    });
}

/**
 * Calls `onChange()` (debounced, no arguments) after any change to the bill, and after every
 * (re)subscribe. `onStatus` gets every channel status. Returns an idempotent unsubscribe.
 * A non-UUID id subscribes to nothing.
 */
export function subscribeToBill(
  client: LiveClient,
  billId: string,
  onChange: () => void,
  onStatus: (status: LiveStatus) => void,
): () => void {
  if (!UUID_RE.test(billId)) return () => {};
  const id = billId.toLowerCase();
  const reg = registryFor(client);
  const listener: Listener = { onChange, onStatus, timer: null };

  let entry = reg.entries.get(id);
  if (entry) {
    entry.listeners.add(listener);
    const current = entry.status;
    if (current !== null) safely(() => onStatus(current));
  } else {
    entry = { listeners: new Set([listener]), channel: null, status: null };
    reg.entries.set(id, entry);
    void openChannel(client, reg, id, entry);
  }

  const mine = entry;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (listener.timer !== null) clearTimeout(listener.timer);
    listener.timer = null;
    mine.listeners.delete(listener);
    if (mine.listeners.size > 0) return;

    if (reg.entries.get(id) === mine) reg.entries.delete(id);
    const channel = mine.channel;
    mine.channel = null;
    if (channel === null) return; // never opened; openChannel sees the empty set and stops
    const removal = client
      .removeChannel(channel)
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (reg.removing.get(id) === removal) reg.removing.delete(id);
      });
    reg.removing.set(id, removal);
  };
}
