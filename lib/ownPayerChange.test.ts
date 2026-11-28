// lib/ownPayerChange.ts: the host's own change of who paid, noted by the Who paid? page so the
// Settle page under it skips the "is now collecting" notice and refetches (review R12).
import {
  announceOwnPayerChange,
  forgetOwnPayerChange,
  noteOwnPayerChange,
  OWN_PAYER_CHANGE_MAX_MS,
  subscribeOwnPayerChange,
  takeOwnPayerChange,
} from './ownPayerChange';

const BILL = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const T = 1_700_000_000_000;

afterEach(() => {
  // Module state is per process: leave nothing noted for the next test.
  forgetOwnPayerChange(BILL);
  forgetOwnPayerChange(OTHER);
});

describe('take-once', () => {
  it('a noted change is taken once; the second take is false', () => {
    noteOwnPayerChange(BILL, T);
    expect(takeOwnPayerChange(BILL, T + 1)).toBe(true);
    expect(takeOwnPayerChange(BILL, T + 2)).toBe(false);
  });

  it('nothing noted → false', () => {
    expect(takeOwnPayerChange(BILL, T)).toBe(false);
  });

  it('keyed by bill: a change on one bill is not taken for another', () => {
    noteOwnPayerChange(BILL, T);
    expect(takeOwnPayerChange(OTHER, T + 1)).toBe(false);
    expect(takeOwnPayerChange(BILL, T + 1)).toBe(true);
  });

  it('a second note replaces the first time', () => {
    noteOwnPayerChange(BILL, T);
    noteOwnPayerChange(BILL, T + OWN_PAYER_CHANGE_MAX_MS);
    expect(takeOwnPayerChange(BILL, T + OWN_PAYER_CHANGE_MAX_MS + 1)).toBe(true);
  });
});

describe('expiry (OWN_PAYER_CHANGE_MAX_MS)', () => {
  it('is 2 minutes', () => {
    expect(OWN_PAYER_CHANGE_MAX_MS).toBe(120_000);
  });

  it('at exactly the limit it still counts; one ms later it does not', () => {
    noteOwnPayerChange(BILL, T);
    expect(takeOwnPayerChange(BILL, T + OWN_PAYER_CHANGE_MAX_MS)).toBe(true);
    noteOwnPayerChange(BILL, T);
    expect(takeOwnPayerChange(BILL, T + OWN_PAYER_CHANGE_MAX_MS + 1)).toBe(false);
  });

  it('an expired note is used up by the take, so it never counts later', () => {
    noteOwnPayerChange(BILL, T);
    expect(takeOwnPayerChange(BILL, T + OWN_PAYER_CHANGE_MAX_MS + 1)).toBe(false);
    expect(takeOwnPayerChange(BILL, T + 1)).toBe(false);
  });
});

describe('forget', () => {
  it('a failed write forgets the note, so the next payer change is not taken as ours', () => {
    noteOwnPayerChange(BILL, T);
    forgetOwnPayerChange(BILL);
    expect(takeOwnPayerChange(BILL, T + 1)).toBe(false);
  });

  it('forgets only that bill', () => {
    noteOwnPayerChange(BILL, T);
    noteOwnPayerChange(OTHER, T);
    forgetOwnPayerChange(BILL);
    expect(takeOwnPayerChange(OTHER, T + 1)).toBe(true);
  });

  it('forgetting with nothing noted is harmless', () => {
    expect(() => forgetOwnPayerChange(BILL)).not.toThrow();
  });
});

describe('announce and subscribe', () => {
  it('every listener hears the bill id; unsubscribing stops it', () => {
    const a = jest.fn();
    const b = jest.fn();
    const offA = subscribeOwnPayerChange(a);
    const offB = subscribeOwnPayerChange(b);
    announceOwnPayerChange(BILL);
    expect(a).toHaveBeenCalledWith(BILL);
    expect(b).toHaveBeenCalledWith(BILL);
    offA();
    announceOwnPayerChange(OTHER);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenLastCalledWith(OTHER);
    offB();
  });

  it('a listener that throws does not stop the others, and announce never throws', () => {
    const before = jest.fn();
    const after = jest.fn();
    const offs = [
      subscribeOwnPayerChange(before),
      subscribeOwnPayerChange(() => {
        throw new Error('boom');
      }),
      subscribeOwnPayerChange(after),
    ];
    expect(() => announceOwnPayerChange(BILL)).not.toThrow();
    expect(before).toHaveBeenCalledWith(BILL);
    expect(after).toHaveBeenCalledWith(BILL);
    offs.forEach((off) => off());
  });

  it('a listener that unsubscribes itself while being called does not skip the next one', () => {
    const next = jest.fn();
    const off = subscribeOwnPayerChange(() => off());
    const offNext = subscribeOwnPayerChange(next);
    announceOwnPayerChange(BILL);
    expect(next).toHaveBeenCalledTimes(1);
    offNext();
  });

  it('announcing does not take the note (the Settle page takes it when it sees the change)', () => {
    noteOwnPayerChange(BILL, T);
    announceOwnPayerChange(BILL);
    expect(takeOwnPayerChange(BILL, T + 1)).toBe(true);
  });
});
