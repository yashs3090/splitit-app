import { cancelAllSentChecks } from './checkInNotifications';
import { clearPendingInvite } from './pendingInvite';
import { clearGroupReceipt, clearScanResult } from './scanSession';
import { storage } from './storage';
import { supabase } from './supabase';

/**
 * Signs out on this device only. 'local' scope, so signing out on a borrowed laptop doesn't end
 * the user's sessions on their phone. Per-user state goes first: the in-memory scan result (so
 * the next person on this device doesn't see the last receipt, review finding N5), the group a
 * receipt was going into and any failed attach (groups T17, criterion 82), any
 * pending invite, and every "did it go through?" check-in on the device, pending or shown
 * (sent-via-Venmo D3; the module never rejects and every call has a time limit). The answers blob is
 * keyed by user and stays. The session change then sends the app to /sign-in via the (app) layout.
 */
export async function signOutThisDevice(): Promise<{ ok: boolean }> {
  clearScanResult();
  clearGroupReceipt();
  await clearPendingInvite(storage);
  await cancelAllSentChecks();
  try {
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    return { ok: !error };
  } catch {
    return { ok: false };
  }
}
