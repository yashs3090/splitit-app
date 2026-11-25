// The bill screen's data: fetch, live hints, refetch on focus and app foreground, edited_at tracking.
// Spec: docs/specs/2026-11-20-m1b-m2-share-and-claim.md (Task 10; "Realtime" client rules).
//
// Every refetch is numbered. Only the newest response is applied, so a slow, older response can
// never overwrite newer data. `version` is the number of the response currently shown; the screen
// uses it to drop optimistic claims once a refetch started after the write has landed.
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { subscribeToBill, type LiveStatus } from './billLive';
import { fetchBill, type BillData } from './bills';
import { supabase } from './supabase';

/** How long the channel may be down before the screen says "Live updates paused". */
export const LIVE_PAUSED_AFTER_MS = 5000;

export type BillLoad =
  | { status: 'loading' }
  | { status: 'not_found' }
  | { status: 'error' }
  | { status: 'ready'; data: BillData };

export type UseBill = {
  load: BillLoad;
  /** The refetch number of the data in `load` (0 before the first success). */
  version: number;
  /**
   * The newest refetch number that has finished, whether it succeeded or failed (0 before any).
   * A failed refetch never advances `version`, so a screen waiting for "the refetch after my write"
   * compares against this to stop waiting (it then shows what `load` still holds).
   */
  finished: number;
  /** Starts a refetch and returns its number. */
  refetch: () => number;
  /** The live channel has been down for more than LIVE_PAUSED_AFTER_MS. */
  livePaused: boolean;
  /** A refetch brought a newer `edited_at` than this screen had shown. */
  edited: boolean;
  dismissEdited: () => void;
};

export function useBill(id: string): UseBill {
  const [load, setLoad] = useState<BillLoad>({ status: 'loading' });
  const [version, setVersion] = useState(0);
  const [finished, setFinished] = useState(0);
  const [livePaused, setLivePaused] = useState(false);
  const [edited, setEdited] = useState(false);

  const mounted = useRef(true);
  const started = useRef(0);
  /** edited_at of the data shown; undefined before the first load. */
  const shownEditedAt = useRef<string | null | undefined>(undefined);
  const pausedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (pausedTimer.current !== null) clearTimeout(pausedTimer.current);
      pausedTimer.current = null;
    };
  }, []);

  const refetch = useCallback((): number => {
    const mine = ++started.current;
    void fetchBill(id).then((res) => {
      if (!mounted.current) return;
      setFinished((f) => Math.max(f, mine));
      if (mine !== started.current) return;
      if (res.ok) {
        const data: BillData = { bill: res.bill, rows: res.rows, participants: res.participants, claims: res.claims };
        const before = shownEditedAt.current;
        if (before !== undefined && data.bill.edited_at !== null && data.bill.edited_at !== before) setEdited(true);
        shownEditedAt.current = data.bill.edited_at;
        setLoad({ status: 'ready', data });
        setVersion(mine);
      } else if (res.error === 'not_found' || res.error === 'not_allowed') {
        setLoad({ status: 'not_found' });
      } else {
        // A failed background refetch keeps what's on screen; the next hint or focus tries again.
        setLoad((prev) => (prev.status === 'ready' ? prev : { status: 'error' }));
      }
    });
    return mine;
  }, [id]);

  // Runs on first focus too, so this is also the initial load.
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

  useEffect(() => {
    const onStatus = (status: LiveStatus) => {
      if (status === 'SUBSCRIBED') {
        if (pausedTimer.current !== null) clearTimeout(pausedTimer.current);
        pausedTimer.current = null;
        if (mounted.current) setLivePaused(false);
        return;
      }
      if (pausedTimer.current !== null) return;
      pausedTimer.current = setTimeout(() => {
        pausedTimer.current = null;
        if (mounted.current) setLivePaused(true);
      }, LIVE_PAUSED_AFTER_MS);
    };
    // The message is only a hint: we re-read through RLS and never look at its payload.
    return subscribeToBill(supabase, id, () => refetch(), onStatus);
  }, [id, refetch]);

  const dismissEdited = useCallback(() => setEdited(false), []);

  return { load, version, finished, refetch, livePaused, edited, dismissEdited };
}
