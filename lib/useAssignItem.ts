// The writes behind "Who had this?" and the parts stepper on a group bill's item sheet (spec
// docs/specs/2026-11-26-groups-mvp.md T18, criterion 84; A1.6 retries; A3.2 claims_changed).
//
// One write at a time per sheet. Each write is assign_item(row, next, shown) and then a refetch of
// the bill; the control that started it stays busy until that refetch finishes. The refetch
// numbering is lib/useBill.ts's: `refetch()` returns n, and the screen passes back `version` (the
// number of the data shown) and `finished` (the newest number that ended, ok or not). Endings:
// - ok, refetch landed → done (`onDone`); the screen's new map is on the sheet.
// - claims_changed → refetch at once and say "Someone changed this item. Check and try again.".
// - any other error → fixed copy (GROUP_ERROR_COPY through an allow-list), no refetch.
// - the refetch failed → "Couldn't refresh this item. Try again." with a retry that refetches.
// A refetch that never answers isn't timed out (the user's open choice from lesson 2026-11-24).
import { useCallback, useEffect, useRef, useState } from 'react';

import { assignItem, GROUP_ERROR_COPY, type GroupError } from './groups';
import { ASSIGN_COPY, type PartsMap } from './itemAssign';

export type AssignSource = {
  lineItemId: string;
  /** The claimer map the sheet shows: sent as `p_expected`. */
  current: PartsMap;
  /** useBill's numbered refetch. */
  refetch: () => number;
  version: number;
  finished: number;
};

export type AssignMessage = { text: string; retry: boolean };

/** What a write was for: a member's chip (their id), the stepper's save, or a retried refetch. */
export type AssignKey = string;
export const SPLIT_KEY = 'split';
const REFRESH_KEY = 'refresh';

type Pending = { key: AssignKey; next: PartsMap | null; waitFor: number | null; wrote: boolean };

/** The errors assign_item can give, with the words shown; anything else reads as `network`. */
const SHOWN: ReadonlySet<GroupError> = new Set<GroupError>(['claims_changed', 'not_allowed', 'invalid_parts', 'busy', 'network']);
const copyFor = (e: GroupError): string => GROUP_ERROR_COPY[SHOWN.has(e) ? e : 'network'];

export function useAssignItem(
  source: AssignSource | null,
  onDone: (key: AssignKey, next: PartsMap) => void,
): {
  /** The key of the write in progress (its control shows busy; every other one is disabled). */
  busy: AssignKey | null;
  message: AssignMessage | null;
  send: (key: AssignKey, next: PartsMap) => void;
  retry: () => void;
} {
  const [pending, setPending] = useState<Pending | null>(null);
  const [message, setMessage] = useState<AssignMessage | null>(null);
  /** Blocks a second tap before React has re-rendered with `pending`. */
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const latest = useRef(source);
  latest.current = source;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const finished = source?.finished ?? 0;
  const version = source?.version ?? 0;
  useEffect(() => {
    if (pending === null || pending.waitFor === null || finished < pending.waitFor) return;
    const landed = version >= pending.waitFor;
    inFlight.current = false;
    setPending(null);
    if (!landed) setMessage({ text: ASSIGN_COPY.refreshFailed, retry: true });
    else if (pending.wrote && pending.next !== null) doneRef.current(pending.key, pending.next);
  }, [pending, finished, version]);

  const send = useCallback((key: AssignKey, next: PartsMap) => {
    const s = latest.current;
    if (s === null || inFlight.current) return;
    inFlight.current = true;
    const expected = s.current;
    setMessage(null);
    setPending({ key, next, waitFor: null, wrote: false });
    void assignItem(s.lineItemId, next, expected).then((res) => {
      // The bill screen outlives the sheet: refetch even if the sheet closed meanwhile.
      const refetch = latest.current?.refetch ?? s.refetch;
      if (res.ok || res.error === 'claims_changed') {
        const n = refetch();
        if (!mounted.current) return;
        if (!res.ok) setMessage({ text: copyFor(res.error), retry: false });
        setPending({ key, next, waitFor: n, wrote: res.ok });
        return;
      }
      if (!mounted.current) return;
      inFlight.current = false;
      setPending(null);
      setMessage({ text: copyFor(res.error), retry: false });
    });
  }, []);

  const retry = useCallback(() => {
    const s = latest.current;
    if (s === null || inFlight.current) return;
    inFlight.current = true;
    setMessage(null);
    setPending({ key: REFRESH_KEY, next: null, waitFor: s.refetch(), wrote: false });
  }, []);

  return { busy: pending?.key ?? null, message, send, retry };
}
