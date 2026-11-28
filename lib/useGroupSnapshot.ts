// A group screen's data: one group_snapshot read, refetched on focus, when the app comes back to
// the front, and after each write (spec docs/specs/2026-11-26-groups-mvp.md T14; no Realtime on
// group screens, GR-21).
//
// Same numbering as lib/useBill.ts: every refetch has a number, only the newest response is
// applied, `version` is the number of the data shown, and `finished` is the newest number that has
// ended either way. A screen waiting for "the refetch after my write" stops waiting when
// `finished` reaches it; if `version` didn't, that refetch failed (lessons 2026-11-24/25).
//
// A refetch that a newer one has superseded never moves `finished` (review R1, GR-RV-1): its answer
// is ignored, so counting it as finished made a waiter read "my refetch ended without landing" and
// show "Couldn't refresh" while the newer refetch, which includes the write, was still on its way.
// The newest refetch always ends (each read gives up after GROUP_REQUEST_TIMEOUT_MS, R2), and its
// number is above every older one, so a waiter for any of them is released when it does.
//
// Delete group (docs/specs/2026-11-28-delete-group.md T4, A2.9): a hard-deleted group has no rows,
// so group_snapshot answers 42501 like "not a member". Once this screen has shown the group, that
// answer means the group is gone: `deleted` (C8). A first load that answers it stays `not_allowed`.
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { TIMED_OUT, within } from './asyncTimeout';
import { fetchGroupSnapshot, GROUP_REQUEST_TIMEOUT_MS, type GroupSnapshot } from './groups';

export type GroupLoad =
  | { status: 'loading' }
  /** Not a member (left, never joined) or a malformed id: one answer, it reveals nothing. */
  | { status: 'not_allowed' }
  | { status: 'error' }
  | { status: 'ready'; snapshot: GroupSnapshot }
  /** Shown, then answered not_allowed: the group was deleted (or the viewer left it elsewhere). Sticky. */
  | { status: 'deleted' };

export type UseGroupSnapshot = {
  load: GroupLoad;
  version: number;
  finished: number;
  /** Starts a refetch and returns its number. */
  refetch: () => number;
};

export function useGroupSnapshot(groupId: string): UseGroupSnapshot {
  const [load, setLoad] = useState<GroupLoad>({ status: 'loading' });
  const [version, setVersion] = useState(0);
  const [finished, setFinished] = useState(0);
  const mounted = useRef(true);
  const started = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refetch = useCallback((): number => {
    const mine = ++started.current;
    // fetchGroupSnapshot's rpc has the same limit; this one also covers the parse and any stand-in.
    void within(fetchGroupSnapshot(groupId), GROUP_REQUEST_TIMEOUT_MS).then((answer) => {
      const res = answer === TIMED_OUT ? ({ ok: false, error: 'network' } as const) : answer;
      if (!mounted.current) return;
      // Superseded: ignored, and not "finished" either (R1). The newer refetch ends the wait.
      if (mine !== started.current) return;
      setFinished((f) => Math.max(f, mine));
      if (res.ok) {
        setLoad({ status: 'ready', snapshot: res.snapshot });
        setVersion(mine);
      } else if (res.error === 'not_allowed') {
        setLoad((prev) => (prev.status === 'ready' || prev.status === 'deleted' ? { status: 'deleted' } : { status: 'not_allowed' }));
      } else {
        // A failed refetch keeps what's on screen (the group, or that it's gone); the screen decides
        // whether to say so.
        setLoad((prev) => (prev.status === 'ready' || prev.status === 'deleted' ? prev : { status: 'error' }));
      }
    });
    return mine;
  }, [groupId]);

  // Runs on first focus too, so this is also the first load.
  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch]),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refetch();
    });
    // jest-expo's AppState mock returns no subscription; the real one always does.
    return () => sub?.remove();
  }, [refetch]);

  return { load, version, finished, refetch };
}
