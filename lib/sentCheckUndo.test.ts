// lib/sentCheckUndo.ts: the "No, undo" runner shared by the bill footer and the notification
// responder (docs/specs/2026-11-26-sent-via-venmo.md D3, A1 F6; criteria 40, 41).
import type { BillData, BillResult } from './bills';
import { createMemoryStorage } from '@/test-utils/fakes';
import { parseSentCheckBlob, sentCheckBlobKey, sentCheckKey, sentCheckNotificationId, storeSentCheckAnswer } from './sentCheck';
import { resetOwnUndosForTests, subscribeOwnUndo, takeOwnUndo } from './ownUndo';
import { runSentCheckUndo, type SentCheckUndoDeps } from './sentCheckUndo';

// The defaults (real bills, storage, notifications) are never used here: every test injects its own.
jest.mock('./supabase', () => ({ supabase: {} }));
jest.mock('./checkInNotifications', () => ({ cancelSentCheck: jest.fn(async () => {}) }));

const BILL = '11111111-1111-4111-8111-111111111111';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c'; // a co-payer who isn't the lead (A-43b)
const AT = '2026-11-26T20:00:00.000Z';
const AT_MS = Date.parse(AT);
const KEY = sentCheckKey(BILL, A, AT_MS) ?? '';
const NID = sentCheckNotificationId(B, BILL, A, AT_MS) ?? '';
const NOW = AT_MS + 90_000;

type Mark = { cents: number; at: string; method: 'venmo' | 'cash' | 'other'; toUserId: string } | null;

type Pay = { to: string; cents: number; at: string; method: 'venmo' | 'cash' | 'other' };

/**
 * The bill as fetchBill returns it: B's payments are bill_payments entries (the ledger), and
 * `participants[B].mark` is derived toward the lead A only, as lib/bills.ts does. `mark` is B's
 * payment (to `mark.toUserId`); `extra` adds more of B's payments.
 */
function bill(mark: Mark, extra: readonly Pay[] = []): BillData {
  const pays: Pay[] = [...(mark === null ? [] : [{ to: mark.toUserId, cents: mark.cents, at: mark.at, method: mark.method }]), ...extra];
  const payments = pays.map((p, i) => ({ id: `33333333-0000-4000-8000-00000000000${i}`, fromId: B, toId: p.to, cents: p.cents, method: p.method, planKey: null, at: p.at }));
  const toLead = pays.filter((p) => p.to === A).at(-1);
  return {
    bill: { id: BILL, host_id: A, payer_id: A } as BillData['bill'],
    rows: [],
    participants: [
      { userId: A, displayName: 'Hana', mark: null } as unknown as BillData['participants'][number],
      { userId: B, displayName: 'Sam', mark: toLead === undefined ? null : { cents: toLead.cents, at: toLead.at, method: toLead.method, toUserId: A } } as unknown as BillData['participants'][number],
      { userId: C, displayName: 'Cy', mark: null } as unknown as BillData['participants'][number],
    ],
    claims: [],
    payers: [],
    payments,
    flags: [],
  };
}

function deps(over: Partial<Omit<SentCheckUndoDeps, 'storage'>> = {}) {
  const storage = createMemoryStorage();
  const d = {
    storage,
    fetchBill: jest.fn(async (): Promise<BillResult<BillData>> => ({ ok: true, ...bill({ cents: 1510, at: AT, method: 'venmo', toUserId: A }) })),
    unmarkPaid: jest.fn(async (): Promise<BillResult> => ({ ok: true })),
    cancelSentCheck: jest.fn(async () => {}),
    now: () => NOW,
    ...over,
  };
  return d;
}

const input = { billId: BILL, userId: B, payerId: A, cents: 1510, markAtMs: AT_MS };
const stored = (d: ReturnType<typeof deps>) => parseSentCheckBlob(d.storage.data.get(sentCheckBlobKey(B) ?? '') ?? null)[KEY]?.a ?? null;

describe('runSentCheckUndo (the undo rule, F6)', () => {
  it('1: an answer already stored as "undo" → noop: no read of the bill, no write, nothing cancelled', async () => {
    const d = deps();
    await storeSentCheckAnswer(d.storage, B, KEY, 'undo', NOW);
    await expect(runSentCheckUndo(input, d)).resolves.toEqual({ kind: 'noop' });
    expect(d.fetchBill).not.toHaveBeenCalled();
    expect(d.unmarkPaid).not.toHaveBeenCalled();
    expect(d.cancelSentCheck).not.toHaveBeenCalled();
  });

  it('2: the mark is already gone → stores "undo", cancels, no write ("silent")', async () => {
    const d = deps({ fetchBill: jest.fn(async () => ({ ok: true as const, ...bill(null) })) });
    await expect(runSentCheckUndo(input, d)).resolves.toEqual({ kind: 'silent' });
    expect(d.unmarkPaid).not.toHaveBeenCalled();
    expect(stored(d)).toBe('undo');
    expect(d.cancelSentCheck).toHaveBeenCalledWith(NID);
  });

  it('3: the mark is the one asked about → unmarkPaid(me) once, then stores "undo" and cancels', async () => {
    const d = deps();
    await expect(runSentCheckUndo(input, d)).resolves.toEqual({ kind: 'unmarked' });
    expect(d.fetchBill).toHaveBeenCalledWith(BILL);
    expect(d.unmarkPaid).toHaveBeenCalledTimes(1);
    expect(d.unmarkPaid).toHaveBeenCalledWith(BILL, B, A);
    expect(stored(d)).toBe('undo');
    expect(d.cancelSentCheck).toHaveBeenCalledWith(NID);
  });

  it.each<[string, Mark]>([
    ['another amount', { cents: 1620, at: AT, method: 'venmo', toUserId: A }],
    ['a newer send', { cents: 1510, at: '2026-11-26T20:05:00.000Z', method: 'venmo', toUserId: A }],
    ['cash', { cents: 1510, at: AT, method: 'cash', toUserId: A }],
  ])('4: the mark changed since (%s) → stores "undo", nothing undone, the "changed" text with the payer name', async (_n, mark) => {
    const d = deps({ fetchBill: jest.fn(async () => ({ ok: true as const, ...bill(mark) })) });
    await expect(runSentCheckUndo(input, d)).resolves.toEqual({
      kind: 'changed',
      text: 'Your payment to Hana changed since then, so nothing was undone. Check below.',
    });
    expect(d.unmarkPaid).not.toHaveBeenCalled();
    expect(stored(d)).toBe('undo');
  });

  it('a payment only to someone else (Cy) → the pair Sam → Hana has no mark: "silent", nothing undone', async () => {
    const d = deps({ fetchBill: jest.fn(async () => ({ ok: true as const, ...bill({ cents: 1510, at: AT, method: 'venmo', toUserId: C }) })) });
    await expect(runSentCheckUndo(input, d)).resolves.toEqual({ kind: 'silent' });
    expect(d.unmarkPaid).not.toHaveBeenCalled();
  });

  it('the re-read fails → "failed" with "Couldn\'t undo. Try again.", nothing stored or cancelled', async () => {
    const d = deps({ fetchBill: jest.fn(async () => ({ ok: false as const, error: 'network' as const })) });
    await expect(runSentCheckUndo(input, d)).resolves.toEqual({ kind: 'failed', text: "Couldn't undo. Try again." });
    expect(d.unmarkPaid).not.toHaveBeenCalled();
    expect(stored(d)).toBeNull();
    expect(d.cancelSentCheck).not.toHaveBeenCalled();
  });

  it('unmarkPaid fails → "failed", nothing stored, the check-in kept (the question stays)', async () => {
    const d = deps({ unmarkPaid: jest.fn(async () => ({ ok: false as const, error: 'network' as const })) });
    await expect(runSentCheckUndo(input, d)).resolves.toEqual({ kind: 'failed', text: "Couldn't undo. Try again." });
    expect(stored(d)).toBeNull();
    expect(d.cancelSentCheck).not.toHaveBeenCalled();
  });

  it('unmarkPaid busy (lock clash, delete-group A3.4) → "failed" with the retry copy, nothing stored', async () => {
    const d = deps({ unmarkPaid: jest.fn(async (): Promise<BillResult> => ({ ok: false, error: 'busy' })) });
    await expect(runSentCheckUndo(input, d)).resolves.toEqual({ kind: 'failed', text: "That didn't go through. Please try again." });
    expect(stored(d)).toBeNull();
    expect(d.cancelSentCheck).not.toHaveBeenCalled();
  });

  it('invalid ids give "failed" with no read and no write', async () => {
    const d = deps();
    await expect(runSentCheckUndo({ ...input, billId: 'nope' }, d)).resolves.toEqual({ kind: 'failed', text: "Couldn't undo. Try again." });
    expect(d.fetchBill).not.toHaveBeenCalled();
    expect(d.unmarkPaid).not.toHaveBeenCalled();
  });
});

describe('runSentCheckUndo marks the undo as the viewer\'s own (review R8)', () => {
  beforeEach(() => resetOwnUndosForTests());

  it('unmarked → noted before the write and announced once it landed', async () => {
    const landed: string[] = [];
    const off = subscribeOwnUndo((b, u) => landed.push(`${b}|${u}`));
    let notedDuringWrite = false;
    const d = deps({
      unmarkPaid: jest.fn(async (): Promise<BillResult> => {
        // A live refetch can show the mark gone before unmarkPaid returns: it's already noted.
        notedDuringWrite = takeOwnUndo(BILL, B, NOW);
        return { ok: true };
      }),
    });
    await expect(runSentCheckUndo(input, d)).resolves.toEqual({ kind: 'unmarked' });
    off();
    expect(notedDuringWrite).toBe(true);
    expect(landed).toEqual([`${BILL}|${B}`]);
  });

  it('unmarkPaid fails → nothing noted, nothing announced', async () => {
    const landed: string[] = [];
    const off = subscribeOwnUndo((b) => landed.push(b));
    const d = deps({ unmarkPaid: jest.fn(async (): Promise<BillResult> => ({ ok: false, error: 'network' })) });
    await expect(runSentCheckUndo(input, d)).resolves.toMatchObject({ kind: 'failed' });
    off();
    expect(takeOwnUndo(BILL, B, NOW)).toBe(false);
    expect(landed).toEqual([]);
  });

  it('changed / silent never unmark, so nothing is noted', async () => {
    const d = deps({ fetchBill: jest.fn(async (): Promise<BillResult<BillData>> => ({ ok: true, ...bill(null) })) });
    await expect(runSentCheckUndo(input, d)).resolves.toEqual({ kind: 'silent' });
    expect(takeOwnUndo(BILL, B, NOW)).toBe(false);
  });
});

describe('runSentCheckUndo on a pair to a co-payer who isn\'t the lead (A-43b, review R2)', () => {
  // Sam (B) sent Cy (C) $15.10; Hana (A) is the lead, so participants[B].mark (toward A) never
  // shows this send. The fresh mark must come from the pair B → C in bill_payments.
  const toCy = { ...input, payerId: C };
  const KEY_C = sentCheckKey(BILL, C, AT_MS) ?? '';
  const storedC = (d: ReturnType<typeof deps>) => parseSentCheckBlob(d.storage.data.get(sentCheckBlobKey(B) ?? '') ?? null)[KEY_C]?.a ?? null;
  const cyMark: Mark = { cents: 1510, at: AT, method: 'venmo', toUserId: C };

  it('no mark to the lead: unmarks exactly Sam → Cy, stores "undo" and cancels that check-in', async () => {
    const d = deps({ fetchBill: jest.fn(async () => ({ ok: true as const, ...bill(cyMark) })) });
    await expect(runSentCheckUndo(toCy, d)).resolves.toEqual({ kind: 'unmarked' });
    expect(d.unmarkPaid).toHaveBeenCalledTimes(1);
    expect(d.unmarkPaid).toHaveBeenCalledWith(BILL, B, C);
    expect(storedC(d)).toBe('undo');
    expect(d.cancelSentCheck).toHaveBeenCalledWith(sentCheckNotificationId(B, BILL, C, AT_MS));
  });

  it('with a different mark to the lead too: still unmarks only Sam → Cy, never Sam → Hana', async () => {
    const lead: Pay = { to: A, cents: 900, at: '2026-11-26T19:00:00.000Z', method: 'cash' };
    const d = deps({ fetchBill: jest.fn(async () => ({ ok: true as const, ...bill(cyMark, [lead]) })) });
    await expect(runSentCheckUndo(toCy, d)).resolves.toEqual({ kind: 'unmarked' });
    expect(d.unmarkPaid).toHaveBeenCalledTimes(1);
    expect(d.unmarkPaid).toHaveBeenCalledWith(BILL, B, C);
  });

  it('with the same-looking mark to the lead: still Sam → Cy only (the lead mark never stands in)', async () => {
    const lead: Pay = { to: A, cents: 1510, at: AT, method: 'venmo' };
    const d = deps({ fetchBill: jest.fn(async () => ({ ok: true as const, ...bill(cyMark, [lead]) })) });
    await expect(runSentCheckUndo(toCy, d)).resolves.toEqual({ kind: 'unmarked' });
    expect(d.unmarkPaid).toHaveBeenCalledTimes(1);
    expect(d.unmarkPaid).toHaveBeenCalledWith(BILL, B, C);
  });

  it('the Cy pair is gone but a matching lead mark exists: "silent", nothing undone (not the lead\'s)', async () => {
    const d = deps({ fetchBill: jest.fn(async () => ({ ok: true as const, ...bill({ cents: 1510, at: AT, method: 'venmo', toUserId: A }) })) });
    await expect(runSentCheckUndo(toCy, d)).resolves.toEqual({ kind: 'silent' });
    expect(d.unmarkPaid).not.toHaveBeenCalled();
  });

  it('the Cy pair changed (a top-up in cash): "changed" naming Cy, nothing undone', async () => {
    const topUp: Pay = { to: C, cents: 200, at: '2026-11-26T20:03:00.000Z', method: 'cash' };
    const d = deps({ fetchBill: jest.fn(async () => ({ ok: true as const, ...bill(cyMark, [topUp]) })) });
    await expect(runSentCheckUndo(toCy, d)).resolves.toEqual({
      kind: 'changed',
      text: 'Your payment to Cy changed since then, so nothing was undone. Check below.',
    });
    expect(d.unmarkPaid).not.toHaveBeenCalled();
  });
});
