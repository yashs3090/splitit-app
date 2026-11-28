// "I wasn't part of this" on the bill screen of a group bill (spec
// docs/specs/2026-11-27-group-claim-status.md T6, C3): reads my own bill_not_part row with
// lib/groups.ts's fetchNotPart when the screen comes into focus, only while the bill is known to be
// a group bill (`enabled`), and writes it with setNotPart.
//
// - Reads are numbered like lib/useBillGroup.ts: only the newest is applied; `read` is 'loading'
//   until the first answer, 'failed' if none has succeeded yet, then 'ready'. A later failed read
//   keeps the last answer.
// - `set(notPart)`: one write at a time (a ref, so a double tap sends one call). It stays busy until
//   the reread after it has ended. If that reread fails, `refreshFailed` says so and `retry` reads
//   again (lesson 2026-11-24: the write and the refetch are two steps with their own endings).
//   A refusal (has_claims, not_in_group, not_allowed) shows its error, rereads and calls
//   `onRefused` (the screen refetches the bill: its data was out of date). `network` only shows it.
// - The server deletes the opt-out when I get a claim (C3's trigger); this mirrors it: as soon as
//   the server's claims include me, the read resets to "not part: false".
// - A different viewer (sign-out, another account) or `enabled` turning off starts over: nothing
//   carries over, and an answer for the old one is dropped. No state is set after unmount.
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ClaimRowLike } from './groupClaimStatus';
import { fetchNotPart, setNotPart, type GroupError } from './groups';
import { hasClaimOn, nextNotPartError, notPartView, type NotPartError, type NotPartRead, type NotPartView } from './notPartView';

export type UseNotPart = {
  read: NotPartRead;
  /** What the screen shows: the tint switch and the line (lib/notPartView.ts). */
  view: NotPartView;
  /** Sets (true) or clears (false) the opt-out. Ignored while a write is running. */
  set: (notPart: boolean) => void;
  /** A write is running, or waiting for the reread after it. */
  busy: boolean;
  /**
   * The last write's error, until the next write or until the line it was raised under changes
   * (review R1, nextNotPartError): words about facts that have since changed aren't shown.
   */
  error: GroupError | null;
  /** A write landed but the reread after it failed; cleared by the next read that lands. */
  refreshFailed: boolean;
  /** Reads again (the refresh-failed line's Refresh); `reading` is its busy state. */
  retry: () => void;
  /** A read is in flight. */
  reading: boolean;
};

type Options = {
  billId: string;
  viewerId: string;
  /** The bill is known to be in a group. No read or write otherwise. */
  enabled: boolean;
  /** The server's rows and their claimers (rowsOfBillData of the loaded data), never optimistic ones. */
  serverRows: readonly ClaimRowLike[];
  /** A write was refused: the screen's data is out of date. */
  onRefused?: () => void;
};

export function useNotPart({ billId, viewerId, enabled, serverRows, onRefused }: Options): UseNotPart {
  const serverHasMyClaim = hasClaimOn(serverRows, viewerId);
  const [read, setRead] = useState<NotPartRead>({ status: 'loading' });
  const [landed, setLanded] = useState(0);
  const [finished, setFinished] = useState(0);
  const [newest, setNewest] = useState(0);
  /** The write in flight: waitFor is the reread's number once the write has landed. */
  const [busy, setBusy] = useState<{ waitFor: number | null } | null>(null);
  const [error, setError] = useState<NotPartError | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const started = useRef(0);
  const writing = useRef(false);
  /** Bumped when the viewer changes or the hook is turned off: anything older is dropped. */
  const epoch = useRef(0);
  const mounted = useRef(true);
  const refused = useRef(onRefused);
  refused.current = onRefused;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Start over for another bill or viewer, or when the bill is no longer known to be a group bill.
  const scope = enabled ? `${billId}:${viewerId}` : null;
  const lastScope = useRef(scope);
  useEffect(() => {
    if (lastScope.current === scope) return;
    lastScope.current = scope;
    epoch.current += 1;
    started.current += 1;
    // Review R6: the dropped read will never finish, so nothing counts as reading any more.
    setNewest(started.current);
    setFinished(started.current);
    writing.current = false;
    setRead({ status: 'loading' });
    setBusy(null);
    setError(null);
    setRefreshFailed(false);
  }, [scope]);

  const reload = useCallback((): number => {
    const mine = ++started.current;
    setNewest(mine);
    void fetchNotPart(billId).then((res) => {
      if (!mounted.current || mine !== started.current) return;
      if (res.ok) {
        setRead({ status: 'ready', notPart: res.notPart });
        setLanded(mine);
        setRefreshFailed(false);
      } else {
        setRead((r) => (r.status === 'ready' ? r : { status: 'failed' }));
      }
      setFinished(mine);
    });
    return mine;
    // viewerId: a new viewer is a new focus read (useFocusEffect reruns when this changes).
  }, [billId, viewerId]);

  useFocusEffect(
    useCallback(() => {
      if (enabled) reload();
    }, [enabled, reload]),
  );

  // Mirrors C3's trigger: a claim of mine on the server clears the opt-out.
  useEffect(() => {
    if (serverHasMyClaim && read.status === 'ready' && read.notPart) setRead({ status: 'ready', notPart: false });
  }, [serverHasMyClaim, read]);

  const view = useMemo(() => notPartView({ inGroup: enabled, read, serverRows, viewerId }), [enabled, read, serverRows, viewerId]);
  const line = useRef(view.line);
  line.current = view.line;
  // Review R1: the error lasts only while the line it was raised under does.
  useEffect(() => {
    setError((e) => nextNotPartError(e, view.line));
  }, [view.line]);

  // The reread after a write has ended: release the link, and say so if it failed.
  useEffect(() => {
    if (busy === null || busy.waitFor === null || finished < busy.waitFor) return;
    if (landed < busy.waitFor) setRefreshFailed(true);
    writing.current = false;
    setBusy(null);
  }, [busy, finished, landed]);

  const set = useCallback(
    (notPart: boolean) => {
      if (writing.current || !enabled) return;
      writing.current = true;
      const mine = epoch.current;
      const under = line.current;
      setBusy({ waitFor: null });
      setError(null);
      setRefreshFailed(false);
      void setNotPart(billId, notPart).then((res) => {
        if (!mounted.current || mine !== epoch.current) return;
        if (!res.ok) {
          writing.current = false;
          setBusy(null);
          setError({ error: res.error, under });
          if (res.error !== 'network') {
            reload();
            refused.current?.();
          }
          return;
        }
        setBusy({ waitFor: reload() });
      });
    },
    [billId, enabled, reload],
  );

  // The line stays until a read lands (reload clears it then), so a failed retry keeps it up.
  const retry = useCallback(() => {
    reload();
  }, [reload]);

  return { read, view, set, busy: busy !== null, error: error?.error ?? null, refreshFailed, retry, reading: newest > finished };
}
