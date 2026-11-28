/**
 * The username (@handle) rule, shared with the database. Spec: docs/specs/2026-11-28-usernames.md
 * (contracts V, N, S and the copy table; ADR 0026).
 *
 * The stored form is lowercase ASCII without '@'. The database checks exactly the same rule V in
 * two CHECK constraints in supabase/migrations/*_usernames.sql; lib/username.test.ts reads that file
 * and fails if the regex, the length bounds or the reserved list drift from the copies here.
 * Only lib normalizes (N); the database stores and checks the exact value (UN-3).
 */

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;

/** Rule V (2). The text must equal the migration's regex; `$` matches only at the very end. */
export const USERNAME_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;

/** Rule V (3), exact match (UN-5). Same members and order as the migration's array. */
export const RESERVED_USERNAMES = [
  'admin',
  'administrator',
  'splitit',
  'split_it',
  'support',
  'help',
  'helpdesk',
  'root',
  'system',
  'sysadmin',
  'null',
  'undefined',
  'nil',
  'none',
  'me',
  'you',
  'everyone',
  'anonymous',
  'guest',
  'user',
  'users',
  'owner',
  'host',
  'staff',
  'team',
  'official',
  'moderator',
  'mod',
  'security',
  'billing',
  'payments',
  'venmo',
  'paypal',
  'cashapp',
  'api',
  'auth',
  'login',
  'signup',
  'settings',
  'account',
  'profile',
  'privacy',
  'terms',
  'test',
] as const;

const RESERVED_SET: ReadonlySet<string> = new Set(RESERVED_USERNAMES);

export type UsernameInvalidReason = 'too_short' | 'too_long' | 'invalid_chars' | 'bad_dots' | 'reserved';
export type UsernameValidation = { ok: true } | { ok: false; reason: UsernameInvalidReason };

/**
 * Every way `setUsername` (lib/profile.ts) can fail. 'locked': the username was already picked and
 * can't change (Amendment A3.2, `42501 username_locked`).
 */
export type SetUsernameReason = UsernameInvalidReason | 'taken' | 'invalid' | 'locked' | 'not_allowed' | 'error';

/** Fixed copy for each failure. Server text is never shown. */
export const USERNAME_ERROR_COPY: Record<SetUsernameReason, string> = {
  too_short: 'Usernames are at least 3 characters.',
  too_long: 'Usernames are at most 20 characters.',
  invalid_chars: 'Use only letters, numbers, _ and .',
  bad_dots: "A dot can't come first, last, or next to another dot.",
  reserved: 'That username is reserved. Try another one.',
  taken: 'That username is taken. Try another one.',
  invalid: "That username isn't allowed. Try another one.",
  locked: "Your username is already set, and it can't be changed.",
  not_allowed: "Couldn't save to your profile. Sign out, sign back in, then try again.",
  error: "Couldn't save. Check your connection and try again.",
};

/** ASCII A–Z to a–z only, so a character like 'İ' or 'K' (Kelvin) stays non-ASCII and fails V. */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** Contract N: trim, drop one leading '@', ASCII-lowercase. Apply before V and before any request. */
export function normalizeUsername(raw: string): string {
  const trimmed = raw.trim();
  const noAt = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  return asciiLower(noAt);
}

/**
 * Contract V on the stored form (no normalizing). The first failing check wins: length, then
 * characters, then dots, then reserved, so 'me' is too_short rather than reserved.
 */
export function validateUsername(s: string): UsernameValidation {
  if (s.length < USERNAME_MIN_LENGTH) return { ok: false, reason: 'too_short' };
  if (s.length > USERNAME_MAX_LENGTH) return { ok: false, reason: 'too_long' };
  if (/[^a-z0-9_.]/.test(s)) return { ok: false, reason: 'invalid_chars' };
  if (!USERNAME_PATTERN.test(s)) return { ok: false, reason: 'bad_dots' };
  if (RESERVED_SET.has(s)) return { ok: false, reason: 'reserved' };
  return { ok: true };
}

/**
 * Contract S: a handle suggested from a display name, or null if none fits. Every non-null result
 * passes V. Used by the later "Pick your username" gate.
 */
export function suggestUsername(displayName: string | null): string | null {
  if (displayName === null || displayName.trim() === '') return null;
  let s = displayName.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  s = asciiLower(s);
  s = s.replace(/[\s\-._]+/g, '_');
  s = s.replace(/[^a-z0-9_]/g, '');
  s = s.replace(/__+/g, '_').replace(/^_+|_+$/g, '');
  s = s.slice(0, USERNAME_MAX_LENGTH).replace(/_+$/, '');
  return validateUsername(s).ok ? s : null;
}

const assertIntIn = (n: number, min: number, max: number, name: string): void => {
  if (!Number.isInteger(n) || n < min || n > max) throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
};

/**
 * Contract S (amended 2026-11-28, review R1): `base` (a valid handle) cut so that `n` fits in 20
 * characters, trailing '_' trimmed unless that would leave the result under 3 characters, then `n`
 * appended. `n` is an integer from 1 to 9999. Throws RangeError on an invalid base (a reserved base
 * is fine: `admin` → `admin1`).
 */
export function withNumberSuffix(base: string, n: number): string {
  assertIntIn(n, 1, 9999, 'n');
  const check = validateUsername(base);
  if (!check.ok && check.reason !== 'reserved') throw new RangeError('withNumberSuffix needs a valid base');
  const digits = String(n);
  const cut = base.slice(0, USERNAME_MAX_LENGTH - digits.length);
  const trimmed = cut.replace(/_+$/, '');
  return (trimmed.length + digits.length >= USERNAME_MIN_LENGTH ? trimmed : cut) + digits;
}

/** Contract S: 'user' plus `n` padded to 4 digits. `n` is an integer from 0 to 9999. */
export function fallbackUsername(n: number): string {
  assertIntIn(n, 0, 9999, 'n');
  return 'user' + String(n).padStart(4, '0');
}

/** A random number source returning values in [0, 1), like `Math.random`. Injected so tests are deterministic. */
export type Rng = () => number;

const SUGGESTION_ATTEMPTS = 50;

/**
 * Amendment A3.5: alternatives for a taken `base`, each `base` plus 3 or 4 random digits, cut to
 * fit 20 characters by withNumberSuffix's rule. Every result passes V; they are distinct and none
 * equals `base`. Returns `count` candidates (3 to 5, default 5): random tries first, then, if the
 * RNG keeps repeating itself, the lowest unused 3-digit numbers, so the count always holds. Pure.
 * Throws RangeError on an invalid base (as withNumberSuffix does) or a count outside 3–5.
 * The screen shows only the ones `usernamesAvailable` (lib/profile.ts) reports free.
 */
export function suggestTakenAlternatives(base: string, rng: Rng, count = 5): string[] {
  assertIntIn(count, 3, 5, 'count');
  const out: string[] = [];
  const seen = new Set<string>([base]);
  const add = (n: number): void => {
    const candidate = withNumberSuffix(base, n);
    if (seen.has(candidate) || !validateUsername(candidate).ok) return;
    seen.add(candidate);
    out.push(candidate);
  };
  const unit = (): number => {
    const r = rng();
    // A broken RNG (NaN, out of range) can't make a number outside 100–9999.
    return Number.isFinite(r) ? Math.min(Math.max(r, 0), 1 - Number.EPSILON) : 0;
  };
  for (let i = 0; i < SUGGESTION_ATTEMPTS && out.length < count; i++) {
    const fourDigits = unit() < 0.5;
    add(fourDigits ? 1000 + Math.floor(unit() * 9000) : 100 + Math.floor(unit() * 900));
  }
  for (let n = 100; n <= 9999 && out.length < count; n++) add(n);
  return out;
}

/** How a username is shown: always with its '@' (stored without it). */
export const atUsername = (username: string): string => `@${username}`;

/**
 * Fixed copy for the "Choose your username" step (components/ChooseUsername.tsx, A3.6–A3.10) and the
 * Profile row (A3.9). Field errors and save failures use USERNAME_ERROR_COPY. No text from the
 * server or a URL is ever shown.
 */
export const USERNAME_GATE_COPY = {
  title: 'Choose your username',
  intro: "It's how friends tell you apart. You can't change it later.",
  fieldLabel: 'Username',
  /** The one-tap way through with the name already in the field (the provisional one). */
  keep: (username: string): string => `Keep ${atUsername(username)}`,
  /** The primary action once the field holds another name. */
  use: (username: string): string => `Use ${atUsername(username)}`,
  /** The primary action, disabled, while the field doesn't hold a valid username. */
  useInvalid: 'Use this username',
  saveHint: "Saves your username. You can't change it later.",
  invalidHint: 'Fix the username first.',
  /** Announced on iOS and Android as the step closes (web has no surviving live region). */
  saved: 'Username saved',
  suggestionsTitle: 'These are free:',
  suggestionLabel: (username: string): string => `Fill in ${atUsername(username)}`,
  suggestionHint: 'Puts it in the username field',
  loadError: "Couldn't check your username. Check your connection and try again.",
  tryAgain: 'Try again',
  tryAgainHint: 'Checks your username again',
  signOut: 'Sign out',
  signOutHint: 'Signs you out on this device',
  signOutError: 'Sign-out failed. Please try again.',
  /** The Profile row (A3.9). */
  profileLabel: 'Username',
  profileRow: (username: string): string => `Username, ${atUsername(username)}`,
  choose: 'Choose',
  chooseLabel: 'Choose your username',
  chooseHint: 'Opens the step to pick your username',
} as const;
