// Resume gate (docs/specs/2026-11-26-sent-via-venmo.md § D3, A1 F10). `ResumeAfterSignIn` says how
// the launch's sign-in resume ended; the notification responder waits for that before acting on a
// cold-start response. The wait must never hang.
import {
  RESUME_GATE_TIMEOUT_MS,
  resetResumeGateForTests,
  resumeKindNow,
  settleResume,
  whenResumed,
} from './resumeGate';

beforeEach(() => {
  jest.useFakeTimers();
  resetResumeGateForTests();
});
afterEach(() => {
  jest.useRealTimers();
});

/** Resolves to the value if the promise has settled after flushing microtasks, else 'pending'. */
async function peek<T>(p: Promise<T>): Promise<T | 'pending'> {
  let out: T | 'pending' = 'pending';
  void p.then((v) => {
    out = v;
  });
  await jest.advanceTimersByTimeAsync(0);
  return out;
}

describe('resume gate', () => {
  it('a waiter gets the kind once the resume settles', async () => {
    const p = whenResumed();
    expect(await peek(p)).toBe('pending');
    settleResume('none');
    await expect(p).resolves.toBe('none');
    expect(jest.getTimerCount()).toBe(0); // its timer was cleared
  });

  it("passes 'signed_in' through, so the responder can drop the cold-start response", async () => {
    const p = whenResumed();
    settleResume('signed_in');
    await expect(p).resolves.toBe('signed_in');
  });

  it('early return: already settled → resolves at once, with no timer', async () => {
    settleResume('none');
    const p = whenResumed();
    expect(jest.getTimerCount()).toBe(0);
    expect(await peek(p)).toBe('none');
    expect(resumeKindNow()).toBe('none');
  });

  it("never hangs: nobody settles → 'timed_out' after the limit", async () => {
    const p = whenResumed();
    await jest.advanceTimersByTimeAsync(RESUME_GATE_TIMEOUT_MS - 1);
    expect(await peek(p)).toBe('pending');
    await jest.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe('timed_out');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a custom limit is honoured; a bad limit (NaN, negative, Infinity) falls back to the default, never "forever"', async () => {
    const short = whenResumed(10);
    await jest.advanceTimersByTimeAsync(10);
    await expect(short).resolves.toBe('timed_out');
    for (const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      const p = whenResumed(bad);
      await jest.advanceTimersByTimeAsync(RESUME_GATE_TIMEOUT_MS - 1);
      expect(await peek(p)).toBe('pending'); // the default limit, not 0 (Node fires NaN/Infinity at once)
      await jest.advanceTimersByTimeAsync(1);
      await expect(p).resolves.toBe('timed_out');
    }
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a settle after one waiter timed out still answers later waiters', async () => {
    const early = whenResumed();
    await jest.advanceTimersByTimeAsync(RESUME_GATE_TIMEOUT_MS);
    await expect(early).resolves.toBe('timed_out');
    settleResume('none');
    await expect(whenResumed()).resolves.toBe('none');
  });

  it('the first settle wins; later calls change nothing', async () => {
    settleResume('signed_in');
    settleResume('none');
    await expect(whenResumed()).resolves.toBe('signed_in');
  });

  it("an unexpected kind settles as 'signed_in' (the safe side: drop the cold-start response), without throwing", async () => {
    const p = whenResumed();
    expect(() => settleResume('weird' as unknown as 'none')).not.toThrow();
    await expect(p).resolves.toBe('signed_in');
  });

  it('every waiter is answered by one settle', async () => {
    const waiters = [whenResumed(), whenResumed(), whenResumed(50)];
    settleResume('none');
    await expect(Promise.all(waiters)).resolves.toEqual(['none', 'none', 'none']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a waiter whose time ran out is not answered twice', async () => {
    const seen: string[] = [];
    void whenResumed(10).then((k) => seen.push(k));
    await jest.advanceTimersByTimeAsync(10);
    settleResume('none');
    await jest.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(['timed_out']);
  });

  it('resumeKindNow is null before the settle', () => {
    expect(resumeKindNow()).toBeNull();
  });
});
