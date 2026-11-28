// The group invite link: /g/<code> (docs/specs/2026-11-26-groups-mvp.md, T9). Same origin rule as
// lib/inviteLink.ts (bill links):
// - EXPO_PUBLIC_WEB_URL set (e.g. the Vercel deploy): `<origin>/g/<code>` on every platform, so a link
//   texted from a phone opens for a friend who doesn't have the app.
// - Unset (dev): http://localhost:8081/g/<code> on web, splitit://g/<code> on native
//   (Linking.createURL picks the origin or scheme for the running platform).
// `/g/*` is not in the Universal Links / App Links paths yet (docs/before-production.md §5).
import * as Linking from 'expo-linking';

import { readWebUrl } from './env';
import { normalizeGroupCode } from './pendingInvite';

// Read and validated once, when the module loads, like lib/inviteLink.ts. Direct member access:
// Expo only inlines static `process.env.EXPO_PUBLIC_*` references.
const WEB_ORIGIN = readWebUrl(process.env.EXPO_PUBLIC_WEB_URL);

/** Throws RangeError for a code that isn't a well-formed group code (never builds a link from junk). */
export function groupInviteUrl(code: string): string {
  const valid = normalizeGroupCode(code);
  if (valid === null) throw new RangeError('groupInviteUrl: invalid group code');
  return WEB_ORIGIN === null ? Linking.createURL(`/g/${valid}`) : `${WEB_ORIGIN}/g/${valid}`;
}
