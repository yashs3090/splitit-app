// The share a feed line shows (docs/specs/2026-11-28-tab-bar-and-activity.md, Contract H).
//
// The current share only ("Your share is now $X", never before → after), read through the bill
// screen's own split path: splitInputFor → displayShares (which runs computeShares). No arithmetic
// of its own, so the feed can never show a figure the bill screen doesn't. Integer cents.

import type { BillData } from './bills';
import { splitInputFor } from './billView';
import { displayShares } from './split';

/**
 * My current share of the bill in integer cents, or null when the feed should show none:
 * - the data didn't load (null / undefined);
 * - even mode and not every row is claimed (displayShares hides totals then, as the bill screen does);
 * - I have no share: I'm not on the bill, or I claim no row;
 * - the share is negative (a claimed discount bigger than my items): "Your share is now −$5.00"
 *   isn't a sentence the feed makes, and feedText refuses negative amounts anyway;
 * - the split math refuses the data (it throws on malformed amounts).
 * Never throws.
 */
export function feedShareCents(data: BillData | null | undefined, myId: string): number | null {
  if (data === null || data === undefined) return null;
  try {
    if (!data.claims.some((c) => c.user_id === myId)) return null;
    const shares = displayShares(splitInputFor(data, data.claims));
    if (!shares.totalsVisible) return null;
    const mine = shares.people.find((p) => p.userId === myId)?.totalCents;
    return typeof mine === 'number' && Number.isSafeInteger(mine) && mine >= 0 ? mine : null;
  } catch {
    return null;
  }
}
