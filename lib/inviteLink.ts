// The shareable invite link for a bill: the existing M0 route /b/<code>.
// Spec: docs/specs/2026-11-20-m1b-m2-share-and-claim.md (Task 8); public origin: slice A1.1
// (docs/before-production.md §5).
// - EXPO_PUBLIC_WEB_URL set (e.g. the Vercel deploy): `<origin>/b/<code>` on every platform, so a link
//   texted from a phone opens for a friend who doesn't have the app.
// - Unset (dev): http://localhost:8081/b/<code> on web, splitit://b/<code> on native
//   (Linking.createURL picks the origin or scheme for the running platform).
import * as Linking from 'expo-linking';

import { readWebUrl } from './env';
import { normalizeInviteCode } from './pendingInvite';

// Read and validated once, when the module loads: a bad value fails at app start with an error
// naming the variable (like lib/supabase.ts), rather than silently hiding the share link.
// Direct member access: Expo only inlines static `process.env.EXPO_PUBLIC_*` references.
const WEB_ORIGIN = readWebUrl(process.env.EXPO_PUBLIC_WEB_URL);

/** Throws RangeError for a code that isn't a well-formed invite code (never builds a link from junk). */
export function inviteUrl(code: string): string {
  const valid = normalizeInviteCode(code);
  if (valid === null) throw new RangeError('inviteUrl: invalid invite code');
  return WEB_ORIGIN === null ? Linking.createURL(`/b/${valid}`) : `${WEB_ORIGIN}/b/${valid}`;
}
