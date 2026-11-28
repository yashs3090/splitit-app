// lib/useNotPart (spec docs/specs/2026-11-27-group-claim-status.md T6, criteria 34 and 35): the
// focus read, the one-at-a-time write, its endings (refused, network, saved but the reread failed),
// the claim reset that mirrors C3's trigger, and nothing set after unmount or for an old viewer.
// fetchNotPart / setNotPart are replaced by mockDeferred promises, so each test holds a request open,
// makes the situation happen, then answers it (lesson 2026-11-26 on guard tests).
import { act, renderHook } from '@testing-library/react-native';
import { useEffect } from 'react';

import type { GroupResult } from '@/lib/groups';
import { useNotPart } from '@/lib/useNotPart';

jest.mock('expo-router', () => ({
  // The hook mockReads on focus; here, focus is the mount (and a new callback is a new focus).
  useFocusEffect: (cb: () => void) => {
    const { useEffect: effect } = require('react') as typeof import('react');
    effect(cb, [cb]);
  },
}));

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function mockDeferred<T>(): Deferred<T> {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const mockReads: Deferred<GroupResult<{ notPart: boolean }>>[] = [];
const mockWrites: { args: [string, boolean]; d: Deferred<GroupResult> }[] = [];

jest.mock('@/lib/groups', () => ({
  fetchNotPart: jest.fn(() => {
    const d = mockDeferred<GroupResult<{ notPart: boolean }>>();
    mockReads.push(d);
    return d.promise;
  }),
  setNotPart: jest.fn((billId: string, notPart: boolean) => {
    const d = mockDeferred<GroupResult>();
    mockWrites.push({ args: [billId, notPart], d });
    return d.promise;
  }),
}));

const BILL = '11111111-1111-4111-8111-111111111111';
const ME = 'bbbbbbbb-0000-4000-8000-000000000002';
const OTHER = 'cccccccc-0000-4000-8000-000000000003';

type Props = { enabled: boolean; viewerId: string; serverHasMyClaim: boolean };
const onRefused = jest.fn();

/** The server's rows: one unclaimed row, plus one of mine when `serverHasMyClaim`. */
const OPEN = [{ claimerIds: [] }];
const MINE_AND_OPEN = [{ claimerIds: [ME] }, { claimerIds: [] }];
const rowsFor = (p: Props) => (p.serverHasMyClaim ? MINE_AND_OPEN : OPEN);

function setup(initial: Partial<Props> = {}) {
  return renderHook(
    ({ serverHasMyClaim, ...p }: Props) => useNotPart({ billId: BILL, ...p, serverRows: rowsFor({ serverHasMyClaim, ...p }), onRefused }),
    { initialProps: { enabled: true, viewerId: ME, serverHasMyClaim: false, ...initial } },
  );
}

async function answerRead(i: number, res: GroupResult<{ notPart: boolean }>) {
  await act(async () => {
    mockReads[i]?.resolve(res);
  });
}
async function answerWrite(i: number, res: GroupResult) {
  await act(async () => {
    mockWrites[i]?.d.resolve(res);
  });
}

beforeEach(() => {
  mockReads.length = 0;
  mockWrites.length = 0;
  onRefused.mockClear();
});

describe('the read', () => {
  it('a bill not known to be in a group makes no read, and stays loading', () => {
    const { result } = setup({ enabled: false });
    expect(mockReads).toHaveLength(0);
    expect(result.current.read).toEqual({ status: 'loading' });
  });

  it('criterion 34: loading until the read lands, then ready', async () => {
    const { result } = setup();
    expect(mockReads).toHaveLength(1);
    expect(result.current.read).toEqual({ status: 'loading' });
    await answerRead(0, { ok: true, notPart: true });
    expect(result.current.read).toEqual({ status: 'ready', notPart: true });
  });

  it('criterion 34: a failed first read is "failed"; a later failed read keeps the last answer', async () => {
    const { result, rerender } = setup();
    await answerRead(0, { ok: false, error: 'network' });
    expect(result.current.read).toEqual({ status: 'failed' });
    // Turning group on again (a new focus callback) mockReads again.
    rerender({ enabled: false, viewerId: ME, serverHasMyClaim: false });
    rerender({ enabled: true, viewerId: ME, serverHasMyClaim: false });
    expect(mockReads).toHaveLength(2);
    await answerRead(1, { ok: true, notPart: false });
    expect(result.current.read).toEqual({ status: 'ready', notPart: false });
    act(() => result.current.retry());
    await answerRead(2, { ok: false, error: 'network' });
    expect(result.current.read).toEqual({ status: 'ready', notPart: false });
  });

  it('turns on once the group is known: the read starts then', async () => {
    const { result, rerender } = setup({ enabled: false });
    rerender({ enabled: true, viewerId: ME, serverHasMyClaim: false });
    expect(mockReads).toHaveLength(1);
    await answerRead(0, { ok: true, notPart: false });
    expect(result.current.read).toEqual({ status: 'ready', notPart: false });
  });

  it('a new viewer starts over, and the old viewer\'s answer is dropped', async () => {
    const { result, rerender } = setup();
    rerender({ enabled: true, viewerId: OTHER, serverHasMyClaim: false });
    expect(mockReads).toHaveLength(2);
    // The old viewer's read answers late: dropped.
    await answerRead(0, { ok: true, notPart: true });
    expect(result.current.read).toEqual({ status: 'loading' });
    await answerRead(1, { ok: true, notPart: false });
    expect(result.current.read).toEqual({ status: 'ready', notPart: false });
  });
});

describe('the claim reset (mirrors C3)', () => {
  it('a server claim of mine turns an opt-out off, and it stays off after the claim goes', async () => {
    const { result, rerender } = setup();
    await answerRead(0, { ok: true, notPart: true });
    expect(result.current.read).toEqual({ status: 'ready', notPart: true });
    rerender({ enabled: true, viewerId: ME, serverHasMyClaim: true });
    expect(result.current.read).toEqual({ status: 'ready', notPart: false });
    rerender({ enabled: true, viewerId: ME, serverHasMyClaim: false });
    expect(result.current.read).toEqual({ status: 'ready', notPart: false });
  });
});

describe('the write', () => {
  async function ready(notPart = false) {
    const hook = setup();
    await answerRead(0, { ok: true, notPart });
    return hook;
  }

  it('criterion 35: one call per double tap; busy until the reread after it lands', async () => {
    const { result } = await ready();
    act(() => {
      result.current.set(true);
      result.current.set(true);
    });
    expect(mockWrites.map((w) => w.args)).toEqual([[BILL, true]]);
    expect(result.current.busy).toBe(true);
    await answerWrite(0, { ok: true });
    // Saved; the reread is in flight, and the link is still busy.
    expect(mockReads).toHaveLength(2);
    expect(result.current.busy).toBe(true);
    act(() => result.current.set(false));
    expect(mockWrites).toHaveLength(1);
    await answerRead(1, { ok: true, notPart: true });
    expect(result.current.busy).toBe(false);
    expect(result.current.read).toEqual({ status: 'ready', notPart: true });
    expect(result.current.error).toBeNull();
    expect(result.current.refreshFailed).toBe(false);
    // Undo sends false.
    act(() => result.current.set(false));
    expect(mockWrites[1]?.args).toEqual([BILL, false]);
  });

  it('criterion 35: a refusal (has_claims) shows its error, rereads, and tells the screen', async () => {
    const { result } = await ready();
    act(() => result.current.set(true));
    await answerWrite(0, { ok: false, error: 'has_claims' });
    expect(result.current.error).toBe('has_claims');
    expect(result.current.busy).toBe(false);
    expect(mockReads).toHaveLength(2);
    expect(onRefused).toHaveBeenCalledTimes(1);
    // The next tap clears the error.
    act(() => result.current.set(true));
    expect(result.current.error).toBeNull();
  });

  it('criterion 35: network shows its error, re-enables the link, and reads nothing', async () => {
    const { result } = await ready();
    act(() => result.current.set(true));
    await answerWrite(0, { ok: false, error: 'network' });
    expect(result.current.error).toBe('network');
    expect(result.current.busy).toBe(false);
    expect(mockReads).toHaveLength(1);
    expect(onRefused).not.toHaveBeenCalled();
  });

  it('saved, but the reread failed: refreshFailed, the link re-enabled; a failed retry keeps it; a landed one clears it', async () => {
    const { result } = await ready();
    act(() => result.current.set(true));
    await answerWrite(0, { ok: true });
    await answerRead(1, { ok: false, error: 'network' });
    expect(result.current.busy).toBe(false);
    expect(result.current.refreshFailed).toBe(true);
    expect(result.current.read).toEqual({ status: 'ready', notPart: false });
    act(() => result.current.retry());
    expect(result.current.reading).toBe(true);
    await answerRead(2, { ok: false, error: 'network' });
    expect(result.current.refreshFailed).toBe(true);
    act(() => result.current.retry());
    await answerRead(3, { ok: true, notPart: true });
    expect(result.current.refreshFailed).toBe(false);
    expect(result.current.reading).toBe(false);
    expect(result.current.read).toEqual({ status: 'ready', notPart: true });
  });

  it('a write is ignored while the hook is off (not a group bill)', () => {
    const { result } = setup({ enabled: false });
    act(() => result.current.set(true));
    expect(mockWrites).toHaveLength(0);
  });

  it('criterion 35: a write that answers after unmount sets no state', async () => {
    // A probe outside the hook records every render; none may follow the unmount.
    const renders: string[] = [];
    const { result, unmount } = renderHook(() => {
      const s = useNotPart({ billId: BILL, viewerId: ME, enabled: true, serverRows: OPEN, onRefused });
      useEffect(() => {
        renders.push(`${s.busy}-${s.error ?? ''}`);
      });
      return s;
    });
    await answerRead(0, { ok: true, notPart: false });
    act(() => result.current.set(true));
    unmount();
    const before = renders.length;
    await answerWrite(0, { ok: false, error: 'has_claims' });
    expect(renders).toHaveLength(before);
    // The guard also stops the reread and the screen refetch a live refusal would start.
    expect(mockReads).toHaveLength(1);
    expect(onRefused).not.toHaveBeenCalled();
  });

  it('a write for the old viewer that answers after a sign-in as someone else is dropped', async () => {
    const { result, rerender } = await ready();
    act(() => result.current.set(true));
    rerender({ enabled: true, viewerId: OTHER, serverHasMyClaim: false });
    expect(result.current.busy).toBe(false);
    await answerWrite(0, { ok: false, error: 'has_claims' });
    expect(result.current.error).toBeNull();
    expect(onRefused).not.toHaveBeenCalled();
    // And the new viewer can write at once.
    act(() => result.current.set(true));
    expect(mockWrites).toHaveLength(2);
  });
});

describe('review R1: an error goes when the facts behind it change', () => {
  it('has_claims stays while my claim shows (no line), then goes when I unclaim (the prompt is back)', async () => {
    const { result, rerender } = setup();
    await answerRead(0, { ok: true, notPart: false });
    expect(result.current.view.line).toBe('prompt');
    act(() => result.current.set(true));
    await answerWrite(0, { ok: false, error: 'has_claims' });
    expect(result.current.error).toBe('has_claims');
    // The refetch shows my claim: the line goes, the words stay (they explain why).
    rerender({ enabled: true, viewerId: ME, serverHasMyClaim: true });
    expect(result.current.view.line).toBeNull();
    expect(result.current.error).toBe('has_claims');
    // I unclaim: the prompt is back, and "You've claimed something…" would be false now.
    rerender({ enabled: true, viewerId: ME, serverHasMyClaim: false });
    expect(result.current.view.line).toBe('prompt');
    expect(result.current.error).toBeNull();
  });

  it('network, then claiming: the line goes and so does the error (nothing left to retry)', async () => {
    const { result, rerender } = setup();
    await answerRead(0, { ok: true, notPart: false });
    act(() => result.current.set(true));
    await answerWrite(0, { ok: false, error: 'network' });
    expect(result.current.error).toBe('network');
    rerender({ enabled: true, viewerId: ME, serverHasMyClaim: true });
    expect(result.current.error).toBeNull();
  });
});

describe('review R6: stale edges', () => {
  it('a read in flight when the hook turns off leaves nothing reading', async () => {
    const { result, rerender } = setup();
    expect(result.current.reading).toBe(true);
    rerender({ enabled: false, viewerId: ME, serverHasMyClaim: false });
    expect(result.current.reading).toBe(false);
    await answerRead(0, { ok: true, notPart: true });
    expect(result.current.read).toEqual({ status: 'loading' });
    expect(result.current.reading).toBe(false);
  });

  it('a different bill id starts over, and the old bill\'s answer is dropped', async () => {
    const OTHER_BILL = '33333333-3333-4333-8333-333333333333';
    const { result, rerender } = renderHook(({ billId }: { billId: string }) =>
      useNotPart({ billId, viewerId: ME, enabled: true, serverRows: OPEN, onRefused }),
      { initialProps: { billId: BILL } },
    );
    await answerRead(0, { ok: true, notPart: true });
    expect(result.current.read).toEqual({ status: 'ready', notPart: true });
    rerender({ billId: OTHER_BILL });
    expect(result.current.read).toEqual({ status: 'loading' });
    expect(mockReads).toHaveLength(2);
    await answerRead(1, { ok: true, notPart: false });
    expect(result.current.read).toEqual({ status: 'ready', notPart: false });
  });
});
