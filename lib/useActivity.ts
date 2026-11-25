// The Activity screen's data: fetch, live hints, refetch on focus and app foreground.
// Spec: docs/specs/2026-11-20-m1b-m2-share-and-claim.md ("Activity UX", Task 17).
//
// Mirrors lib/useBill.ts: every refetch is numbered and only the newest response is applied, so a
// slow, older response never overwrites newer data. Live updates share the bill's channel
// (subscribeToBill keeps one channel per bill, so the bill screen underneath and this screen don't
// subscribe twice); the hint is only a reason to re-read through RLS.
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { fetchActivity } from './activity';
import type { ActivityEvent } from './activityText';
import { subscribeToBill } from './billLive';
import type { BillParticipant } from './bills';
import { supabase } from './supabase';

export type ActivityLoad =
  | { status: 'loading' }
  | { status: 'not_found' }
  | { status: 'error' }
  | { status: 'ready'; events: ActivityEvent[]; participants: BillParticipant[] };

export function useActivity(billId: string): { load: ActivityLoad; refetch: () => void } {
  const [load, setLoad] = useState<ActivityLoad>({ status: 'loading' });
  const mounted = useRef(true);
  const started = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refetch = useCallback(() => {
    const mine = ++started.current;
    void fetchActivity(supabase, billId).then((res) => {
      if (!mounted.current || mine !== started.current) return;
      if (res.ok) setLoad({ status: 'ready', events: res.events, participants: res.participants });
      else if (res.error === 'not_found' || res.error === 'not_allowed') setLoad({ status: 'not_found' });
      // A failed background refetch keeps what's on screen; the next hint or focus tries again.
      else setLoad((prev) => (prev.status === 'ready' ? prev : { status: 'error' }));
    });
  }, [billId]);

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

  // Statuses aren't shown here: the bill screen already says when live updates pause.
  useEffect(() => subscribeToBill(supabase, billId, () => refetch(), () => {}), [billId, refetch]);

  return { load, refetch };
}
