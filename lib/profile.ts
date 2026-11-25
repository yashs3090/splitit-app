/**
 * The signed-in user's own profile: read it, save the Venmo username, and read or dismiss the
 * one-time "Add your Venmo" prompt. Spec: docs/specs/2026-11-24-profile-venmo.md (D3, Task 3).
 *
 * Every profile read and write in the app goes through this file (criterion 26). There is no
 * module-level state or cache, so nothing here survives sign-out.
 *
 * The prompt's "answered" timestamp is never read or written directly: clients have no grant on
 * that column (co-participants can see your row, so a column grant would show it to them). The
 * two RPCs below touch only the caller's own row.
 */
import { normalizeVenmoUsername } from './venmo';
import { supabase } from './supabase';

export type MyProfile = { ok: true; displayName: string | null; venmoUsername: string | null } | { ok: false };

export type SaveVenmoReason = 'invalid' | 'not_allowed' | 'error';
export type SaveVenmoResult = { ok: true; value: string | null; changed: boolean } | { ok: false; reason: SaveVenmoReason };

/**
 * Fixed copy for a failed save. Server text is never shown. 'invalid' has no entry: the screen
 * shows VENMO_USERNAME_ERROR on the field for it.
 */
export const SAVE_VENMO_ERROR_COPY: Record<Exclude<SaveVenmoReason, 'invalid'>, string> = {
  not_allowed: "Couldn't save to your profile. Sign out, sign back in, then try again.",
  error: "Couldn't save. Check your connection and try again.",
};

const isNullableString = (v: unknown): v is string | null => v === null || typeof v === 'string';

export async function getMyProfile(userId: string): Promise<MyProfile> {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('display_name, venmo_username')
      .eq('id', userId)
      .single();
    if (error || typeof data !== 'object' || data === null) return { ok: false };
    const row = data as { display_name?: unknown; venmo_username?: unknown };
    if (!isNullableString(row.display_name) || !isNullableString(row.venmo_username)) return { ok: false };
    return { ok: true, displayName: row.display_name, venmoUsername: row.venmo_username };
  } catch {
    return { ok: false };
  }
}

/**
 * Normalizes `rawInput` (lib/venmo.ts) and saves it. Makes no request when the input is invalid
 * or normalizes to `current`. On success, `value` is what the database returned: the new baseline.
 */
export async function saveVenmoUsername(userId: string, rawInput: string, current: string | null): Promise<SaveVenmoResult> {
  const normalized = normalizeVenmoUsername(rawInput);
  if (!normalized.ok) return { ok: false, reason: 'invalid' };
  if (normalized.value === current) return { ok: true, value: current, changed: false };

  try {
    const { data, error } = await supabase
      .from('profiles')
      .update({ venmo_username: normalized.value })
      .eq('id', userId)
      .select('venmo_username');
    if (error) {
      if (error.code === '23514') return { ok: false, reason: 'invalid' };
      if (error.code === '42501') return { ok: false, reason: 'not_allowed' };
      return { ok: false, reason: 'error' };
    }
    // Zero rows: RLS hid the row (not ours) or it doesn't exist. Postgres doesn't raise for that.
    if (!Array.isArray(data) || data.length === 0) return { ok: false, reason: 'not_allowed' };
    if (data.length !== 1) return { ok: false, reason: 'error' };
    const stored = (data[0] as { venmo_username?: unknown } | undefined)?.venmo_username;
    if (!isNullableString(stored)) return { ok: false, reason: 'error' };
    return { ok: true, value: stored, changed: true };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

/** True only when the server says so. Errors and odd values return false: never nag on an error. */
export async function isVenmoPromptPending(): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('venmo_prompt_pending');
    return !error && data === true;
  } catch {
    return false;
  }
}

/** Marks the prompt as answered for the signed-in user. Idempotent on the server. */
export async function dismissVenmoPrompt(): Promise<{ ok: boolean }> {
  try {
    const { error } = await supabase.rpc('dismiss_venmo_prompt');
    return { ok: !error };
  } catch {
    return { ok: false };
  }
}
