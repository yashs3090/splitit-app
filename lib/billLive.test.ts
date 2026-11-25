import { createFakeRealtime, type FakeChannel } from '@/test-utils/fakes';

import { LIVE_DEBOUNCE_MS, subscribeToBill, type LiveClient } from './billLive';

// Compile-time check: the real supabase client satisfies the narrow interface billLive needs.
// (A type-only import: lib/supabase is never executed here.)
type RealClient = typeof import('./supabase').supabase;
const realClientFits: RealClient extends LiveClient ? true : false = true;
void realClientFits;

const BILL = '11111111-2222-4333-8444-555555555555';
const OTHER_BILL = '99999999-2222-4333-8444-555555555555';

function makeClient() {
  const rt = createFakeRealtime();
  const client = { channel: rt.channel, removeChannel: rt.removeChannel, realtime: rt.realtime };
  return { rt, client: client as unknown as LiveClient };
}

/** Let the async setAuth → channel → subscribe chain run. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function onlyChannel(rt: ReturnType<typeof createFakeRealtime>): FakeChannel {
  const live = rt.__channels.filter((c) => !c.removed);
  expect(live).toHaveLength(1);
  return live[0]!;
}

describe('subscribeToBill', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('sets Realtime auth before joining a private bill:<id> channel for the "changed" event', async () => {
    const { rt, client } = makeClient();
    let release: () => void = () => {};
    rt.realtime.setAuth.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));

    const stop = subscribeToBill(client, BILL, jest.fn(), jest.fn());
    await settle();
    expect(rt.realtime.setAuth).toHaveBeenCalledWith(); // no argument: use the session's token
    expect(rt.channel).not.toHaveBeenCalled(); // the join must carry the user's token

    release();
    await settle();
    expect(rt.channel).toHaveBeenCalledTimes(1);
    expect(rt.channel).toHaveBeenCalledWith(`bill:${BILL}`, { config: { private: true } });
    stop();
  });

  it('subscribes to broadcast "changed" and reports every status', async () => {
    const { rt, client } = makeClient();
    const onStatus = jest.fn();
    const stop = subscribeToBill(client, BILL, jest.fn(), onStatus);
    await settle();

    const ch = onlyChannel(rt);
    expect(ch.on).toHaveBeenCalledWith('broadcast', { event: 'changed' }, expect.any(Function));
    expect(ch.subscribe).toHaveBeenCalledTimes(1);

    ch.__status('SUBSCRIBED');
    ch.__status('CHANNEL_ERROR', new Error('server text that must not leak'));
    ch.__status('TIMED_OUT');
    ch.__status('CLOSED');
    expect(onStatus.mock.calls).toEqual([['SUBSCRIBED'], ['CHANNEL_ERROR'], ['TIMED_OUT'], ['CLOSED']]);
    stop();
  });

  it('refetches once, after the debounce, for one message', async () => {
    const { rt, client } = makeClient();
    const onChange = jest.fn();
    const stop = subscribeToBill(client, BILL, onChange, jest.fn());
    await settle();
    const ch = onlyChannel(rt);

    ch.__broadcast('changed', { t: 'claims' });
    expect(onChange).not.toHaveBeenCalled();
    jest.advanceTimersByTime(LIVE_DEBOUNCE_MS - 1);
    expect(onChange).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it('coalesces three quick messages into one refetch', async () => {
    const { rt, client } = makeClient();
    const onChange = jest.fn();
    const stop = subscribeToBill(client, BILL, onChange, jest.fn());
    await settle();
    const ch = onlyChannel(rt);

    ch.__broadcast('changed', { t: 'claims' });
    jest.advanceTimersByTime(100);
    ch.__broadcast('changed', { t: 'bills' });
    jest.advanceTimersByTime(100);
    ch.__broadcast('changed', { t: 'bill_participants' });
    jest.advanceTimersByTime(LIVE_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);

    ch.__broadcast('changed', { t: 'claims' });
    jest.advanceTimersByTime(LIVE_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
  });

  it('never reads the payload: onChange gets no arguments, whatever the message carries', async () => {
    const { rt, client } = makeClient();
    const onChange = jest.fn();
    const stop = subscribeToBill(client, BILL, onChange, jest.fn());
    await settle();
    const ch = onlyChannel(rt);

    ch.__broadcast('changed', { t: 'claims', user_id: 'someone', parts: 3, total_cents: 999 });
    ch.__broadcast('changed', null);
    ch.__broadcast('changed', 'garbage');
    jest.advanceTimersByTime(LIVE_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith();
    stop();
  });

  it('ignores other broadcast events', async () => {
    const { rt, client } = makeClient();
    const onChange = jest.fn();
    const stop = subscribeToBill(client, BILL, onChange, jest.fn());
    await settle();

    onlyChannel(rt).__broadcast('something_else', { t: 'claims' });
    jest.advanceTimersByTime(LIVE_DEBOUNCE_MS);
    expect(onChange).not.toHaveBeenCalled();
    stop();
  });

  it('refetches on every SUBSCRIBED (covers reconnects)', async () => {
    const { rt, client } = makeClient();
    const onChange = jest.fn();
    const stop = subscribeToBill(client, BILL, onChange, jest.fn());
    await settle();
    const ch = onlyChannel(rt);

    ch.__status('SUBSCRIBED');
    jest.advanceTimersByTime(LIVE_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);

    ch.__status('CHANNEL_ERROR');
    jest.advanceTimersByTime(LIVE_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);

    ch.__status('SUBSCRIBED');
    jest.advanceTimersByTime(LIVE_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
  });

  it('unsubscribing calls removeChannel once, cancels a pending refetch and stops all callbacks', async () => {
    const { rt, client } = makeClient();
    const onChange = jest.fn();
    const onStatus = jest.fn();
    const stop = subscribeToBill(client, BILL, onChange, onStatus);
    await settle();
    const ch = onlyChannel(rt);

    ch.__broadcast('changed', { t: 'claims' });
    stop();
    stop(); // idempotent
    jest.advanceTimersByTime(LIVE_DEBOUNCE_MS * 2);

    expect(onChange).not.toHaveBeenCalled();
    expect(rt.removeChannel).toHaveBeenCalledTimes(1);
    expect(rt.removeChannel).toHaveBeenCalledWith(ch);
    ch.__status('SUBSCRIBED');
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('unsubscribing before setAuth resolves never opens a channel', async () => {
    const { rt, client } = makeClient();
    let release: () => void = () => {};
    rt.realtime.setAuth.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));

    const stop = subscribeToBill(client, BILL, jest.fn(), jest.fn());
    stop();
    release();
    await settle();

    expect(rt.channel).not.toHaveBeenCalled();
    expect(rt.removeChannel).not.toHaveBeenCalled();
  });

  it('still joins (and lets the server decide) if setAuth rejects', async () => {
    const { rt, client } = makeClient();
    rt.realtime.setAuth.mockRejectedValueOnce(new Error('no token'));
    const stop = subscribeToBill(client, BILL, jest.fn(), jest.fn());
    await settle();
    expect(rt.channel).toHaveBeenCalledTimes(1);
    stop();
  });

  it('two subscribers to the same bill share one channel; each gets its own refetch', async () => {
    const { rt, client } = makeClient();
    const a = jest.fn();
    const b = jest.fn();
    const statusA = jest.fn();
    const statusB = jest.fn();
    const stopA = subscribeToBill(client, BILL, a, statusA);
    const stopB = subscribeToBill(client, BILL, b, statusB);
    await settle();

    const ch = onlyChannel(rt);
    expect(ch.subscribe).toHaveBeenCalledTimes(1);
    ch.__status('SUBSCRIBED');
    expect(statusA).toHaveBeenCalledWith('SUBSCRIBED');
    expect(statusB).toHaveBeenCalledWith('SUBSCRIBED');
    jest.advanceTimersByTime(LIVE_DEBOUNCE_MS);
    a.mockClear();
    b.mockClear();

    ch.__broadcast('changed', { t: 'claims' });
    jest.advanceTimersByTime(LIVE_DEBOUNCE_MS);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    // The first leaving doesn't close the channel for the second.
    stopA();
    expect(rt.removeChannel).not.toHaveBeenCalled();
    ch.__broadcast('changed', { t: 'claims' });
    jest.advanceTimersByTime(LIVE_DEBOUNCE_MS);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);

    stopB();
    expect(rt.removeChannel).toHaveBeenCalledTimes(1);
  });

  it('a late subscriber to an open channel is told its current status', async () => {
    const { rt, client } = makeClient();
    const stopA = subscribeToBill(client, BILL, jest.fn(), jest.fn());
    await settle();
    onlyChannel(rt).__status('SUBSCRIBED');

    const statusB = jest.fn();
    const stopB = subscribeToBill(client, BILL, jest.fn(), statusB);
    expect(statusB).toHaveBeenCalledWith('SUBSCRIBED');
    stopA();
    stopB();
  });

  it('a quick unmount/remount waits for the old channel to be removed, then opens a fresh one', async () => {
    const { rt, client } = makeClient();
    let finishRemove: () => void = () => {};
    rt.removeChannel.mockImplementationOnce(
      (ch: FakeChannel) =>
        new Promise<'ok'>((r) => {
          finishRemove = () => {
            ch.removed = true;
            r('ok');
          };
        }),
    );

    const stop1 = subscribeToBill(client, BILL, jest.fn(), jest.fn());
    await settle();
    const first = onlyChannel(rt);
    stop1();

    const onChange = jest.fn();
    const stop2 = subscribeToBill(client, BILL, onChange, jest.fn());
    await settle();
    expect(rt.channel).toHaveBeenCalledTimes(1); // still waiting for the leave to finish

    finishRemove();
    await settle();
    expect(rt.channel).toHaveBeenCalledTimes(2);
    const second = rt.__channels[1]!;
    expect(second).not.toBe(first);
    expect(second.subscribe).toHaveBeenCalledTimes(1);

    second.__broadcast('changed', {});
    jest.advanceTimersByTime(LIVE_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop2();
  });

  it('keeps bills apart', async () => {
    const { rt, client } = makeClient();
    const a = jest.fn();
    const b = jest.fn();
    const stopA = subscribeToBill(client, BILL, a, jest.fn());
    const stopB = subscribeToBill(client, OTHER_BILL, b, jest.fn());
    await settle();

    rt.__channels.find((c) => c.topic === `bill:${BILL}`)!.__broadcast('changed', {});
    jest.advanceTimersByTime(LIVE_DEBOUNCE_MS);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    stopA();
    stopB();
  });

  it('does nothing for a non-UUID bill id (no topic is built from untrusted text)', async () => {
    const { rt, client } = makeClient();
    const stop = subscribeToBill(client, 'not-a-uuid', jest.fn(), jest.fn());
    await settle();
    expect(rt.realtime.setAuth).not.toHaveBeenCalled();
    expect(rt.channel).not.toHaveBeenCalled();
    stop();
  });

  it('a callback that throws does not break other subscribers', async () => {
    const { rt, client } = makeClient();
    const bad = jest.fn(() => {
      throw new Error('boom');
    });
    const good = jest.fn();
    const stopA = subscribeToBill(client, BILL, bad, bad);
    const stopB = subscribeToBill(client, BILL, good, jest.fn());
    await settle();
    const ch = onlyChannel(rt);

    expect(() => ch.__status('SUBSCRIBED')).not.toThrow();
    expect(() => jest.advanceTimersByTime(LIVE_DEBOUNCE_MS)).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    stopA();
    stopB();
  });
});
