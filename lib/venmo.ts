/**
 * The Venmo username rule (D2 in docs/specs/2026-11-24-profile-venmo.md).
 *
 * This is the only place in the app that defines the pattern. The database
 * enforces the same rule with the `profiles_venmo_username_format` check
 * constraint; both sides test the same boundary cases (B1–B15).
 *
 * Stored value: null, or 5–30 ASCII letters, digits, `-` or `_`, case kept as
 * typed. Every allowed character is URL-safe, so the value can go into a
 * payment link without escaping.
 */
export const VENMO_USERNAME_PATTERN = /^[A-Za-z0-9_-]{5,30}$/;

export const VENMO_USERNAME_ERROR = 'Venmo usernames are 5–30 letters, numbers, - or _.';

export type VenmoUsernameResult = { ok: true; value: string | null } | { ok: false; message: string };

/**
 * Turn what the user typed into the value to store.
 * 1. Trim surrounding whitespace. 2. Remove exactly one leading `@`.
 * 3. Empty means "clear" (null). 4. Otherwise it must match the pattern.
 */
export function normalizeVenmoUsername(input: string): VenmoUsernameResult {
  const trimmed = input.trim();
  const candidate = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  if (candidate === '') return { ok: true, value: null };
  if (VENMO_USERNAME_PATTERN.test(candidate)) return { ok: true, value: candidate };
  return { ok: false, message: VENMO_USERNAME_ERROR };
}
