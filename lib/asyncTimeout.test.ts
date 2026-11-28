import { TIMED_OUT, within } from './asyncTimeout';

describe('within', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('resolves with the promise\'s value when it settles first', async () => {
    await expect(within(Promise.resolve(42), 1000)).resolves.toBe(42);
  });

  it('resolves with TIMED_OUT when the limit passes first; the promise isn\'t cancelled', async () => {
    let resolve: (v: string) => void = () => {};
    const slow = new Promise<string>((r) => (resolve = r));
    const raced = within(slow, 1000);
    jest.advanceTimersByTime(1000);
    await expect(raced).resolves.toBe(TIMED_OUT);
    resolve('late');
    await expect(slow).resolves.toBe('late');
  });

  it('passes a rejection through (callers keep their own catch)', async () => {
    await expect(within(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');
  });

  it('clears its timer once settled, so nothing is left pending', async () => {
    await within(Promise.resolve('x'), 60_000);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a value that is the TIMED_OUT symbol itself can only come from the limit', () => {
    expect(typeof TIMED_OUT).toBe('symbol');
    expect(TIMED_OUT.description).toBe('timed_out');
  });
});
