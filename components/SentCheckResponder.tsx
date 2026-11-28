// Answers to the "Did your $15.10 to Hana go through?" notification (docs/specs/2026-11-26-sent-via-venmo.md
// D3, A1 F10; criterion 41). Mounted once, in app/(app)/_layout.tsx, so it only runs while signed in.
// It renders nothing and never shows UI of its own.
//
// - useSentCheckResponses (lib/checkInNotifications) delivers each response once (deduped by
//   identifier|action for the app's lifetime) and clears the OS's last response; on web it's a no-op.
// - The data is allow-listed (parseSentCheckData): UUIDs, integer cents, a ms number, and the
//   signed-in user's id. Anything else, another user's response, or signed out → ignored.
// - Waits for the sign-in resume (lib/resumeGate). A cold-start response (the one that launched the
//   app) is dropped unless the resume found nothing to do ('none'): the resume owns navigation then
//   (lesson 2026-11-19). The inline question on the Settle page covers a dropped answer.
// - "Yes": store 'yes' and cancel; never navigates. Body tap: router.push to Settle up, nothing else.
//   "No, undo": the undo rule (lib/sentCheckUndo), then router.push to Settle up, so the page loads
//   after the undo has landed rather than seeing its mark vanish (which would read as someone else's undo).
//   Already on that Settle page: no push (no second copy of it; review R8). lib/sentCheckUndo notes the
//   undo in lib/ownUndo, so the open page refetches and knows the undo was the viewer's own.
import { usePathname, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

import { useSession } from '@/lib/auth';
import { cancelSentCheck, useSentCheckResponses, type SentCheckResponse } from '@/lib/checkInNotifications';
import { whenResumed } from '@/lib/resumeGate';
import { parseSentCheckData, sentCheckKey, storeSentCheckAnswer } from '@/lib/sentCheck';
import { runSentCheckUndo } from '@/lib/sentCheckUndo';
import { SETTLE_COPY } from '@/lib/settleView';
import { storage } from '@/lib/storage';

/** iOS and Android only: there's no visible Banner for an answer given outside the app. */
function announce(text: string) {
  if (Platform.OS !== 'web') AccessibilityInfo.announceForAccessibility(text);
}

export function SentCheckResponder(): null {
  const { session } = useSession();
  const router = useRouter();
  // The route in front right now (read after awaits, so a ref).
  const pathname = usePathname();
  const here = useRef(pathname);
  here.current = pathname;
  const userId = session?.user.id ?? null;
  // The signed-in user right now (a response is handled after awaits; the user may have changed).
  const current = useRef(userId);
  current.current = userId;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const handle = useCallback(
    async (r: SentCheckResponse) => {
      const resumed = await whenResumed();
      if (r.source === 'cold' && resumed !== 'none') return;
      const me = current.current;
      if (!mounted.current || me === null) return;
      const data = parseSentCheckData(r.data, me);
      if (data === null) return;
      const key = sentCheckKey(data.billId, data.payerId, data.markAtMs);
      if (key === null) return;
      const settle = `/bills/${data.billId}/settle`;
      const goToSettle = () => {
        if (here.current !== settle) router.push(settle);
      };

      if (r.action === 'yes') {
        await storeSentCheckAnswer(storage, me, key, 'yes', Date.now());
        void cancelSentCheck(r.identifier);
        return;
      }
      if (r.action === 'open') {
        goToSettle();
        return;
      }
      const outcome = await runSentCheckUndo({ ...data, userId: me });
      // Signed out (or someone else signed in) while it ran: don't take them anywhere.
      if (!mounted.current || current.current !== me) return;
      if (outcome.kind === 'unmarked') announce(SETTLE_COPY.undoneNotSent);
      else if (outcome.kind === 'changed' || outcome.kind === 'failed') announce(outcome.text);
      goToSettle();
    },
    [router],
  );

  useSentCheckResponses(
    useCallback(
      (r: SentCheckResponse) => {
        void handle(r);
      },
      [handle],
    ),
  );
  return null;
}
