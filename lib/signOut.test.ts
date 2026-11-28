// lib/signOut.ts: criterion 25 in docs/specs/2026-11-24-profile-venmo.md (Task 3).
import { type FakeSupabase, type MemoryStorage } from '@/test-utils/fakes';

import { cancelAllSentChecks } from './checkInNotifications';
import { getFixture } from './fixtures/receipts';
import { PENDING_INVITE_KEY } from './pendingInvite';
import { parseReceipt } from './receiptText';
import { getAttachFailure, getScanGroup, getScanResult, setAttachFailure, setScanGroup, setScanResult } from './scanSession';
import { signOutThisDevice } from './signOut';
import { storage as realStorage } from './storage';
import { supabase as realSupabase } from './supabase';

jest.mock('./supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
// Sent via Venmo D3 (Task 9b): sign-out cancels every check-in on the device. The module never rejects.
jest.mock('./checkInNotifications', () => ({ cancelAllSentChecks: jest.fn(async () => {}) }));
jest.mock('./storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});

const supabase = realSupabase as unknown as FakeSupabase;
const storage = realStorage as unknown as MemoryStorage;

beforeEach(() => {
  jest.clearAllMocks();
  storage.data.clear();
});

describe('signOutThisDevice', () => {
  it('25: clears the scan result and the pending invite, then signs out this device only', async () => {
    setScanResult(parseReceipt(getFixture('modifiers').text));
    storage.data.set(PENDING_INVITE_KEY, JSON.stringify({ code: '0123456789abcdef0123', savedAt: Date.now() }));
    // Record what was already cleared at the moment signOut runs (N5: scan result goes first).
    let clearedBeforeSignOut: { scan: boolean; invite: boolean } | null = null;
    supabase.auth.signOut.mockImplementationOnce(async () => {
      clearedBeforeSignOut = { scan: getScanResult() === null, invite: !storage.data.has(PENDING_INVITE_KEY) };
      return { error: null };
    });

    await expect(signOutThisDevice()).resolves.toEqual({ ok: true });

    expect(supabase.auth.signOut).toHaveBeenCalledTimes(1);
    expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(clearedBeforeSignOut).toEqual({ scan: true, invite: true });
    expect(getScanResult()).toBeNull();
    expect(storage.data.has(PENDING_INVITE_KEY)).toBe(false);
  });

  it('groups 82: clears the group a receipt was going into and any failed attach before signing out', async () => {
    const bill = '11111111-2222-4333-8444-555555555555';
    const group = '99999999-0000-4000-8000-000000000009';
    setScanGroup({ groupId: group, name: 'Tahoe trip' });
    setAttachFailure({ billId: bill, groupId: group, groupName: 'Tahoe trip' });
    let clearedBeforeSignOut = false;
    supabase.auth.signOut.mockImplementationOnce(async () => {
      clearedBeforeSignOut = getScanGroup() === null && getAttachFailure(bill) === null;
      return { error: null };
    });
    await expect(signOutThisDevice()).resolves.toEqual({ ok: true });
    expect(clearedBeforeSignOut).toBe(true);
  });

  it('sent via Venmo D3: cancels every pending and shown check-in before signing out, and keeps the answers', async () => {
    const blobKey = 'splitit.sentcheck.v1.00000000-0000-4000-8000-00000000000b';
    storage.data.set(blobKey, '{}');
    let cancelledBeforeSignOut = false;
    supabase.auth.signOut.mockImplementationOnce(async () => {
      cancelledBeforeSignOut = (cancelAllSentChecks as jest.Mock).mock.calls.length === 1;
      return { error: null };
    });
    await expect(signOutThisDevice()).resolves.toEqual({ ok: true });
    expect(cancelAllSentChecks).toHaveBeenCalledTimes(1);
    expect(cancelledBeforeSignOut).toBe(true);
    // The answers blob is keyed by user, so it stays for the next sign-in (eng §2).
    expect(storage.data.get(blobKey)).toBe('{}');
  });

  it('25: returns { ok: false } when signOut errors', async () => {
    supabase.auth.signOut.mockImplementationOnce(async () => ({ error: { message: 'boom' } }) as never);
    await expect(signOutThisDevice()).resolves.toEqual({ ok: false });
  });

  it('returns { ok: false } when signOut throws', async () => {
    supabase.auth.signOut.mockImplementationOnce(async () => {
      throw new Error('network');
    });
    await expect(signOutThisDevice()).resolves.toEqual({ ok: false });
  });
});
