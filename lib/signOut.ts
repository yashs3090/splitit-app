import { clearPendingInvite } from './pendingInvite';
import { clearScanResult } from './scanSession';
import { storage } from './storage';
import { supabase } from './supabase';

/**
 * Signs out on this device only. 'local' scope, so signing out on a borrowed laptop doesn't end
 * the user's sessions on their phone. Per-user state goes first: the in-memory scan result (so
 * the next person on this device doesn't see the last receipt, review finding N5) and any
 * pending invite. The session change then sends the app to /sign-in via the (app) layout.
 */
export async function signOutThisDevice(): Promise<{ ok: boolean }> {
  clearScanResult();
  await clearPendingInvite(storage);
  try {
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    return { ok: !error };
  } catch {
    return { ok: false };
  }
}
