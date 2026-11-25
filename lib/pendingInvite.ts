import type { KeyValueStorage } from './chunkedStorage';

/**
 * A "pending invite" remembers which bill a signed-out invitee was trying to open,
 * so we can send them back to it after sign-in. It is one-shot (taking it removes it)
 * and expires after a TTL so a shared device doesn't resume someone else's invite days later.
 */

export const PENDING_INVITE_KEY = 'splitit.pendingInvite';
export const PENDING_INVITE_TTL_MS = 24 * 60 * 60 * 1000;

const INVITE_CODE_RE = /^[A-Za-z0-9_-]{10,64}$/;

/** Returns the trimmed code if it is a well-formed invite code, else null. Case is preserved. */
export function normalizeInviteCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim();
  return INVITE_CODE_RE.test(code) ? code : null;
}

/** Stores `{ code, savedAt }`, replacing any older invite. Invalid codes are ignored. */
export async function savePendingInvite(storage: KeyValueStorage, code: string, now: number): Promise<void> {
  const valid = normalizeInviteCode(code);
  if (valid === null) return;
  await storage.setItem(PENDING_INVITE_KEY, JSON.stringify({ code: valid, savedAt: now }));
}

/**
 * Returns the pending invite code and removes it. Returns null (and removes the entry)
 * if it is expired, corrupt, or no longer valid. Never throws.
 */
export async function takePendingInvite(
  storage: KeyValueStorage,
  now: number,
  ttlMs: number = PENDING_INVITE_TTL_MS,
): Promise<string | null> {
  let raw: string | null;
  try {
    raw = await storage.getItem(PENDING_INVITE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;

  await clearPendingInvite(storage);
  return parseStoredInvite(raw, now, ttlMs);
}

/** Removes any pending invite. Never throws. */
export async function clearPendingInvite(storage: KeyValueStorage): Promise<void> {
  try {
    await storage.removeItem(PENDING_INVITE_KEY);
  } catch {
    // Best effort: a stale entry still expires via the TTL.
  }
}

/** The only places sign-in can send you: home, or a validated invite. No free-form return URLs. */
export function postSignInRoute(code: string | null): '/' | `/b/${string}` {
  const valid = normalizeInviteCode(code);
  return valid === null ? '/' : `/b/${valid}`;
}

function parseStoredInvite(raw: string, now: number, ttlMs: number): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { code, savedAt } = parsed as { code?: unknown; savedAt?: unknown };
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return null;
  // Expired, or saved "in the future" (clock change or tampering): drop it.
  if (savedAt > now || now - savedAt >= ttlMs) return null;
  return normalizeInviteCode(code);
}
