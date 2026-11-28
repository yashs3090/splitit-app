// Home's one-shot notice after the viewer's own group delete (docs/specs/2026-11-28-delete-group.md
// T4, C9, DG-7): the group screen sets it just before `router.replace('/')`, and Home takes it once
// on mount. In memory only (an app restart drops it, which is fine for a "just happened" line).
// Keyed to the account, so a sign-out and a different account never see it.

export type GroupDeletedNotice = { name: string };

let pending: { name: string; userId: string } | null = null;

/** Replaces any earlier notice (only the newest delete is announced). */
export function setGroupDeletedNotice(notice: { name: string; userId: string }): void {
  pending = { name: notice.name, userId: notice.userId };
}

/**
 * The notice for this account, once; null afterwards. A take by another account (or signed out,
 * `null`) returns null and leaves the notice in place.
 */
export function takeGroupDeletedNotice(userId: string | null): GroupDeletedNotice | null {
  if (pending === null || userId === null || pending.userId !== userId) return null;
  const { name } = pending;
  pending = null;
  return { name };
}

/** Drops any notice (sign-out; tests). */
export function clearGroupDeletedNotice(): void {
  pending = null;
}
