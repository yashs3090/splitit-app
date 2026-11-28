/**
 * The signed-in user's username and whether it is locked (picked), for the "Choose your username"
 * gate in app/(app)/_layout.tsx and the Profile row. Spec: docs/specs/2026-11-28-usernames.md
 * A3.6–A3.10.
 *
 * One my_username_status read per signed-in user (lib/profile.getMyUsername, 15 s time limit),
 * kept in memory and shared by every caller, so Profile adds no read of its own. A null user id
 * (signed out) drops the kept answer, so nothing about one user survives into the next session and a
 * new sign-in reads again. An answer that arrives for an older read (a retry, a sign-out, another
 * user) is dropped.
 *
 * test-utils/jestSetup.ts mocks this module as "locked" for every suite; the gate's own tests unmock it.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { getMyUsername } from './profile';

export type UsernameState =
  { status: 'idle' } | { status: 'loading' } | { status: 'error' } | { status: 'ready'; username: string; locked: boolean };

export type UsernameStatus = UsernameState & {
  /** Reads again (after an error, or to check a lock made elsewhere). */
  retry: () => void;
  /** After a successful pick: locked, with the stored name, without a read. */
  markLocked: (username: string) => void;
};

type Entry = { userId: string; state: UsernameState; read: number };

const IDLE: UsernameState = { status: 'idle' };
const LOADING: UsernameState = { status: 'loading' };

let entry: Entry | null = null;
let reads = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function load(userId: string): void {
  const read = ++reads;
  entry = { userId, state: LOADING, read };
  emit();
  void getMyUsername().then(
    (res) => {
      if (entry === null || entry.read !== read) return;
      entry = { ...entry, state: res.ok ? { status: 'ready', username: res.username, locked: res.locked } : { status: 'error' } };
      emit();
    },
    () => {
      // getMyUsername never rejects; kept so a surprise can't leave the gate spinning.
      if (entry === null || entry.read !== read) return;
      entry = { ...entry, state: { status: 'error' } };
      emit();
    },
  );
}

/** After set_username succeeded for `userId`: locked, with the stored value. Another user's entry is left alone. */
export function markUsernameLocked(userId: string, username: string): void {
  if (entry === null || entry.userId !== userId) return;
  // Any read still in flight is older than the pick, so it is dropped.
  entry = { userId, state: { status: 'ready', username, locked: true }, read: ++reads };
  emit();
}

function clear(): void {
  if (entry === null) return;
  entry = null;
  reads += 1;
  emit();
}

export function useUsernameStatus(userId: string | null): UsernameStatus {
  const snapshot = useSyncExternalStore(subscribe, () => entry);
  // Never another user's answer, even for the render before the effect below starts this user's read.
  const state: UsernameState = userId === null ? IDLE : snapshot !== null && snapshot.userId === userId ? snapshot.state : LOADING;

  useEffect(() => {
    if (userId === null) clear();
    else if (entry === null || entry.userId !== userId) load(userId);
  }, [userId]);

  const retry = useCallback(() => {
    if (userId !== null) load(userId);
  }, [userId]);
  const markLocked = useCallback(
    (username: string) => {
      if (userId !== null) markUsernameLocked(userId, username);
    },
    [userId],
  );
  return { ...state, retry, markLocked };
}

/** Tests only: forget the kept answer, with no listeners notified. */
export function resetUsernameStatusForTests(): void {
  entry = null;
  reads += 1;
}
