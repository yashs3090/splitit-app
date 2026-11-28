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
import { TIMED_OUT, within } from './asyncTimeout';
import { normalizeUsername, validateUsername, type SetUsernameReason } from './username';
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

// ---------------------------------------------------------------------------
// Username (@handle). Spec: docs/specs/2026-11-28-usernames.md, contract L as amended by A3. The
// rule and the copy live in lib/username.ts. Every account has a provisional username from sign-up
// (A1); the person picks once through the set_username RPC, which locks it for good (A3.2).
// Whether it is locked isn't readable from the profiles table (owner-only), so getMyUsername uses
// the my_username_status RPC.
// ---------------------------------------------------------------------------

export type { SetUsernameReason } from './username';
/** Every account has a username from sign-up (Amendment A1), so the success case is a string. */
export type MyUsername = { ok: true; username: string; locked: boolean } | { ok: false };
export type SetUsernameResult = { ok: true; value: string; changed: boolean } | { ok: false; reason: SetUsernameReason };
export type UsernamesAvailableResult = { ok: true; available: string[] } | { ok: false };

/** Starting value (UN-9). Past it, the request reads as failed; a late commit is harmless. */
export const USERNAME_REQUEST_TIMEOUT_MS = 15_000;

/** The most candidates usernames_available takes in one call (A3.4). */
export const USERNAMES_AVAILABLE_MAX = 10;

/** The caller's own username and whether it is locked (picked). Gives up after 15 s, as { ok: false }. */
export async function getMyUsername(): Promise<MyUsername> {
  try {
    const res = await within(Promise.resolve(supabase.rpc('my_username_status')), USERNAME_REQUEST_TIMEOUT_MS);
    if (res === TIMED_OUT) return { ok: false };
    const { data, error } = res;
    // returns table (...): PostgREST sends an array; exactly one row for a signed-in user.
    if (error || !Array.isArray(data) || data.length !== 1) return { ok: false };
    const row: unknown = data[0];
    if (typeof row !== 'object' || row === null) return { ok: false };
    const { username, locked } = row as { username?: unknown; locked?: unknown };
    // NOT NULL in the database (A1.1); a null or any other non-string is a malformed response (A1.5).
    if (typeof username !== 'string' || typeof locked !== 'boolean') return { ok: false };
    return { ok: true, username, locked };
  } catch {
    return { ok: false };
  }
}

/**
 * Normalizes `rawInput` (N), validates it (V) and picks it through set_username, which locks it.
 * Makes no request when it's invalid. Input equal to `current` (the provisional name) is still sent,
 * because picking it is what locks it (A3.1, "Keep @name"); `changed` is false then. On success,
 * `value` is what the database returned.
 */
export async function setUsername(rawInput: string, current: string | null): Promise<SetUsernameResult> {
  const normalized = normalizeUsername(rawInput);
  const valid = validateUsername(normalized);
  if (!valid.ok) return { ok: false, reason: valid.reason };

  try {
    const res = await within(Promise.resolve(supabase.rpc('set_username', { p_username: normalized })), USERNAME_REQUEST_TIMEOUT_MS);
    if (res === TIMED_OUT) return { ok: false, reason: 'error' };
    const { data, error } = res;
    if (error) {
      switch (error.code) {
        case '23505':
          return { ok: false, reason: 'taken' };
        case '22023':
          return { ok: false, reason: error.message === 'username_reserved' ? 'reserved' : 'invalid' };
        case '23514':
          return { ok: false, reason: 'invalid' };
        case '42501':
          return { ok: false, reason: error.message === 'username_locked' ? 'locked' : 'not_allowed' };
        default:
          return { ok: false, reason: 'error' };
      }
    }
    if (typeof data !== 'string' || !validateUsername(data).ok) return { ok: false, reason: 'error' };
    return { ok: true, value: data, changed: data !== current };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

/**
 * Of `candidates` (stored form, e.g. from suggestTakenAlternatives), the ones that pass V and that no
 * one else holds right now (A3.4), in the order given. The save still decides: a name taken in
 * between gives 'taken'. Makes no request for an empty list, and refuses more than 10 without one.
 * A response that isn't a list of the candidates sent maps to { ok: false }.
 */
export async function usernamesAvailable(candidates: readonly string[]): Promise<UsernamesAvailableResult> {
  if (candidates.length === 0) return { ok: true, available: [] };
  if (candidates.length > USERNAMES_AVAILABLE_MAX) return { ok: false };
  try {
    const res = await within(
      Promise.resolve(supabase.rpc('usernames_available', { p_candidates: [...candidates] })),
      USERNAME_REQUEST_TIMEOUT_MS,
    );
    if (res === TIMED_OUT) return { ok: false };
    const { data, error } = res;
    if (error || !Array.isArray(data)) return { ok: false };
    const sent = new Set(candidates);
    if (!data.every((v): v is string => typeof v === 'string' && sent.has(v))) return { ok: false };
    return { ok: true, available: data };
  } catch {
    return { ok: false };
  }
}
