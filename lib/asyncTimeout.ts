// A time limit on a promise, without cancelling it. Shared by the Venmo send hooks (bill and group)
// and anything else that must not wait forever on a write, a read or a storage call.

/** What `within` resolves with when the limit passed first. Compare with `===`. */
export const TIMED_OUT: unique symbol = Symbol('timed_out');

/**
 * Races `p` against `ms`. Resolves with p's value, or TIMED_OUT if the limit passes first; a
 * rejection passes through. `p` keeps running either way (attach `.then` to it for a late answer).
 * The timer is cleared once either side settles.
 */
export function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([p, limit]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
