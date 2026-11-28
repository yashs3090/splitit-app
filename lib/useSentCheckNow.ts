// The clock the inline "Did it go through?" is judged by (docs/specs/2026-11-26-sent-via-venmo.md D3;
// review R10). The question shows while `now − markAt ≤ 30 min`. A `Date.now()` read only inside a
// useMemo would keep it up past that until something else re-rendered, so the clock moves:
// - on a timer set for the moment the window ends (sentCheckInlineEndsInMs),
// - when the screen gets focus again, and when the app comes back to the front,
// - when the viewer's mark changes.
// Used by the Settle page and the bill screen.
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { sentCheckInlineEndsInMs } from './sentCheck';

/** `markAt`: the viewer's mark `settled_at` as fetched, or null. Returns the `now` to judge it by. */
export function useSentCheckNow(markAt: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  const tick = useCallback(() => setNow(Date.now()), []);

  useEffect(() => {
    tick();
  }, [markAt, tick]);

  useEffect(() => {
    const left = sentCheckInlineEndsInMs(markAt, now);
    if (left === null) return;
    const t = setTimeout(tick, left);
    return () => clearTimeout(t);
  }, [markAt, now, tick]);

  useFocusEffect(
    useCallback(() => {
      tick();
    }, [tick]),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') tick();
    });
    // jest-expo's AppState mock returns no subscription; the real one always does.
    return () => sub?.remove();
  }, [tick]);

  return now;
}
