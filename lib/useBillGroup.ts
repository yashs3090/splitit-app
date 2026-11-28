// Which group a bill is in, for the bill screen, Settle and Add people (spec
// docs/specs/2026-11-26-groups-mvp.md T17 part 2). Read with lib/groups.ts's fetchBillGroup when the
// screen comes into focus (the first focus is the mount) and on demand (`reload`), never on the
// bill's live refetches: the group changes only through "Add to a group" / "Take out", which the
// host does on another screen, so coming back is when it can have changed.
//
// Numbered like lib/useBill.ts: `reload()` returns n; only the newest read is applied (an older
// answer is dropped and doesn't count as finished); `landed` is the newest n that succeeded and
// `finished` the newest n that ended either way, so a caller waiting for "the read after my write"
// is done when `finished >= n`, and it landed if `landed >= n`.
//
// `read` is 'loading' until the first answer, 'failed' if no read has succeeded yet, then 'ready'.
// A later failed read keeps the last group shown (the screens still have a group to show), except
// after `recheck()`: a write was refused with in_group, so the last answer is known to be wrong and
// the group counts as unknown ('failed') until a read succeeds (GR-T17-17).
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { BillGroupRef } from './billGroup';
import { fetchBillGroup } from './groups';

export type BillGroupRead = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; group: BillGroupRef | null };

export type UseBillGroup = {
  read: BillGroupRead;
  /** Starts a read and returns its number. */
  reload: () => number;
  /** Forgets the last answer (the group is unknown until a read succeeds), then reads. */
  recheck: () => number;
  landed: number;
  finished: number;
  /** A read is in flight (Try again shows busy). */
  reading: boolean;
};

export function useBillGroup(billId: string): UseBillGroup {
  const [read, setRead] = useState<BillGroupRead>({ status: 'loading' });
  const [landed, setLanded] = useState(0);
  const [finished, setFinished] = useState(0);
  const [newest, setNewest] = useState(0);
  const started = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback((): number => {
    const mine = ++started.current;
    setNewest(mine);
    void fetchBillGroup(billId).then((res) => {
      if (!mounted.current || mine !== started.current) return;
      if (res.ok) {
        setRead({ status: 'ready', group: res.group });
        setLanded(mine);
      } else {
        setRead((r) => (r.status === 'ready' ? r : { status: 'failed' }));
      }
      setFinished(mine);
    });
    return mine;
  }, [billId]);

  const recheck = useCallback((): number => {
    setRead({ status: 'failed' });
    return reload();
  }, [reload]);

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  return { read, reload, recheck, landed, finished, reading: newest > finished };
}

/** The group to show: null for a bill in no group, undefined while unknown (loading, or never read). */
export function knownGroup(read: BillGroupRead): BillGroupRef | null | undefined {
  return read.status === 'ready' ? read.group : undefined;
}
