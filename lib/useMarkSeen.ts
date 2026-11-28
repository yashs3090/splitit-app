// "Seen" for a bill while its screen is in front (sent-via-Venmo D7, A1 F7; criterion 43): after
// each new version of the data, debounced, and once more when the screen loses focus. Home's "sent"
// and other markers clear from it. Fire and forget: a failed or late answer changes nothing on screen.
// Used by the Settle page now and the bill screen in Task 9b.
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';

import { markBillSeen } from './bills';

/** Starting value (F7): a burst of live updates marks the bill seen once. */
export const SEEN_DEBOUNCE_MS = 2000;

/**
 * `version` is useBill's data version (it only grows on a successful load); `ready` is whether the
 * screen is showing that data. Nothing is marked before the first ready version.
 */
export function useMarkSeen(billId: string, version: number, ready: boolean): void {
  const focused = useRef(false);
  const shown = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      return () => {
        focused.current = false;
        clear();
        // Once on blur (and unmount), if this visit showed the bill at all.
        if (shown.current) void markBillSeen(billId);
      };
    }, [billId]),
  );

  useEffect(() => {
    if (!ready || version === 0 || !focused.current) return;
    shown.current = true;
    clear();
    timer.current = setTimeout(() => {
      timer.current = null;
      void markBillSeen(billId);
    }, SEEN_DEBOUNCE_MS);
  }, [billId, version, ready]);

  useEffect(() => clear, []);
}
