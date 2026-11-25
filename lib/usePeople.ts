// The signed-in user's "People you've split with", for Profile and the Add people screen.
// Spec: docs/specs/2026-11-24-people-and-invites.md (D6, D7; Tasks 6 and 7).
//
// Only the newest request's answer is applied, and nothing is set after unmount (criterion 41).
// The list is per user: a different `userId` starts over from "loading".
import { useCallback, useEffect, useRef, useState } from 'react';

import { listPeople, type Person } from './people';

export type PeopleLoad = { status: 'loading' } | { status: 'error' } | { status: 'ready'; people: Person[] };

export type UsePeople = {
  load: PeopleLoad;
  /**
   * Loads the list again. While a list is on screen it stays there until the new answer arrives,
   * and a failed reload keeps it (no flash to a spinner or an error over a list that still works).
   */
  reload: () => void;
};

export function usePeople(userId: string): UsePeople {
  const [load, setLoad] = useState<PeopleLoad>({ status: 'loading' });
  const latest = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(() => {
    const mine = ++latest.current;
    setLoad((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }));
    void listPeople().then((res) => {
      if (!mounted.current || mine !== latest.current) return;
      if (res.ok) setLoad({ status: 'ready', people: res.people });
      else setLoad((prev) => (prev.status === 'ready' ? prev : { status: 'error' }));
    });
  }, []);

  useEffect(() => {
    if (userId === '') return;
    // A different person signed in on this device: never show the previous person's list.
    latest.current++;
    setLoad({ status: 'loading' });
    reload();
  }, [userId, reload]);

  return { load, reload };
}
