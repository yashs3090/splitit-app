// Payment links (ADR 0007; spec docs/specs/2026-11-24-m3-settle-venmo.md § C2, C5).
// Request links (txn=charge): docs/specs/2026-11-25-venmo-request-buttons.md § R1.
//
// This is the only place in the app that builds a Venmo URL, and the only opener. Pay and request
// links come from the one private builder (venmoLink) and differ only in txn. Venmo no longer
// documents the link format (checked 2026-11-24), so the format sits behind one switch
// (VENMO_LINK_FORMAT) that the device check (criterion 64) settles.
import { Linking } from 'react-native';

import { formatCentsInput } from './money';
import { VENMO_USERNAME_PATTERN } from './venmo';

/**
 * The fixed start of every Venmo note, and the whole note when there are no item names to show
 * (or VENMO_NOTE_INCLUDES_ITEMS is off). Since 2026-11-25 the note can also carry the payer's own
 * claimed item names (docs/specs/2026-11-25-venmo-note-item-names.md, N2); it still never contains
 * people's names or amounts. venmoNote builds it; venmoPayUrl takes no free-form note from callers.
 */
export const SETTLE_NOTE = 'SplitIt';

/**
 * Kill switch for item names in the Venmo note (VN-8). false = the note is plain SETTLE_NOTE again.
 * Venmo payments can be public, so the names reveal what someone ordered (docs/before-production.md).
 */
export const VENMO_NOTE_INCLUDES_ITEMS: boolean = true;

/**
 * Longest note we build, in Unicode code points (starting value, VN-5). Venmo's help center says
 * notes are limited to 280 characters (checked 2026-11-25); how it counts emoji and how a
 * link-prefilled note is cut are unverified, so this leaves room.
 */
export const VENMO_NOTE_MAX = 100;

const NOTE_PREFIX = `${SETTLE_NOTE}: `;
const NOTE_SEP = ', ';
const NOTE_MAX_NAMES = 2; // U3
const ELLIPSIS = '\u2026';

/** Replaces every lone UTF-16 surrogate with U+FFFD, so encodeURIComponent can't throw. No regex lookbehind (Hermes). */
function withoutLoneSurrogates(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s.slice(i, i + 2);
        i++;
      } else {
        out += '\ufffd';
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      out += '\ufffd';
    } else {
      out += s.charAt(i);
    }
  }
  return out;
}

/** Length in code points (an emoji counts once). */
function codePoints(s: string): number {
  return Array.from(s).length;
}

/** Cleaned, non-empty, de-duplicated names in first-seen order (N2 steps 2–3). */
function cleanNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    if (typeof raw !== 'string') continue; // defensive: the type says string, the runtime may not
    const name = withoutLoneSurrogates(raw).replace(/\s+/gu, ' ').trim();
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * The note with the switch passed in (N2). venmoNote is this with VENMO_NOTE_INCLUDES_ITEMS;
 * exported so the switch-off case (B20) is testable.
 */
export function venmoNoteWith(names: readonly string[], includeItems: boolean): string {
  if (!includeItems) return SETTLE_NOTE;
  const clean = cleanNames(names);
  const n = clean.length;
  if (n === 0) return SETTLE_NOTE;
  const suffix = (more: number) => (more > 0 ? ` + ${more} more` : '');

  // U3, U4: as many whole names as fit (at most 2), then "+ N more" for the rest.
  for (let k = Math.min(NOTE_MAX_NAMES, n); k >= 1; k--) {
    const candidate = NOTE_PREFIX + clean.slice(0, k).join(NOTE_SEP) + suffix(n - k);
    if (codePoints(candidate) <= VENMO_NOTE_MAX) return candidate;
  }

  // U5: the first name alone doesn't fit; clip it by code points so the note is exactly the limit.
  const tail = ELLIPSIS + suffix(n - 1);
  const room = Math.max(0, VENMO_NOTE_MAX - codePoints(NOTE_PREFIX) - codePoints(tail));
  return NOTE_PREFIX + Array.from(clean[0] ?? '').slice(0, room).join('') + tail;
}

/**
 * The Venmo note for a payer's item names (spec N2): "SplitIt" alone, or
 * "SplitIt: A, B + N more" within VENMO_NOTE_MAX code points. Never throws.
 */
export function venmoNote(names: readonly string[]): string {
  return venmoNoteWith(names, VENMO_NOTE_INCLUDES_ITEMS);
}

/**
 * The names of the rows `userId` claimed (parts >= 1), in row order, raw (spec N1). Shared rows
 * count (U1); discount rows don't (U2); each claimed unit row appears once (venmoNote de-duplicates).
 * Other people's claims never contribute.
 */
export function claimedItemNames(
  rows: readonly { id: string; name: string; kind?: 'item' | 'discount' }[],
  claims: readonly { line_item_id: string; user_id: string; parts: number }[],
  userId: string,
): string[] {
  const mine = new Set(claims.filter((c) => c.user_id === userId && c.parts >= 1).map((c) => c.line_item_id));
  return rows.filter((r) => r.kind !== 'discount' && mine.has(r.id)).map((r) => r.name);
}

export type VenmoLinkFormat = 'v1' | 'v2';

/**
 * V1: https://venmo.com/?txn=<txn>&recipients=<username>&amount=<amount>&note=<note>
 * V2: https://venmo.com/<username>?txn=<txn>&amount=<amount>&note=<note> (fallback)
 * <txn> is pay or charge (a request). V1 pay confirmed on iPhone on 2026-11-25 (criterion 64),
 * V1 charge on iPhone the same day; Android, desktop and V2 not checked yet.
 */
export const VENMO_LINK_FORMAT: VenmoLinkFormat = 'v1';

/** Rule C2: the amount of a mark or a payment link is an integer from 1 to 99,999,999 cents. */
export const SETTLE_MIN_CENTS = 1;
export const SETTLE_MAX_CENTS = 99_999_999;

/** Rule C2. Same bounds as the `settled_cents` check and `mark_paid`'s `invalid_amount`. */
export function isSettleCents(cents: unknown): cents is number {
  return typeof cents === 'number' && Number.isInteger(cents) && cents >= SETTLE_MIN_CENTS && cents <= SETTLE_MAX_CENTS;
}

/** The note as it goes into the URL. Exported so tests can check the encoding with any text. */
export function encodeVenmoNote(note: string): string {
  return encodeURIComponent(note);
}

/** itemNames: the payer's own claimed item names for the note (absent = none, plain "SplitIt"). */
export type VenmoPayInput = { username: string | null; cents: number; itemNames?: readonly string[] };

/**
 * Venmo's txn kinds we build: 'pay' sends money to `username`; 'charge' opens Venmo's Request
 * screen asking `username` for money, from whichever Venmo account is signed in on the device.
 */
type VenmoTxn = 'pay' | 'charge';

/** Builds a Venmo link of one txn kind, or null (same rules as venmoPayUrlForFormat). The only venmo.com template. */
function venmoLink(format: VenmoLinkFormat, txn: VenmoTxn, { username, cents, itemNames }: VenmoPayInput): string | null {
  if (typeof username !== 'string' || !VENMO_USERNAME_PATTERN.test(username)) return null;
  if (!isSettleCents(cents)) return null;
  const recipient = encodeURIComponent(username); // a no-op for allowed characters; kept on purpose
  const amount = formatCentsInput(cents); // 1 → 0.01, 123450 → 1234.50
  const note = encodeVenmoNote(venmoNote(itemNames ?? []));
  return format === 'v2'
    ? `https://venmo.com/${recipient}?txn=${txn}&amount=${amount}&note=${note}`
    : `https://venmo.com/?txn=${txn}&recipients=${recipient}&amount=${amount}&note=${note}`;
}

/**
 * The Venmo pay link in a given format, or null when the username fails VENMO_USERNAME_PATTERN or
 * the cents fail C2. The note is venmoNote(itemNames). Prefer venmoPayUrl; this exists so both
 * formats are tested.
 */
export function venmoPayUrlForFormat(format: VenmoLinkFormat, input: VenmoPayInput): string | null {
  return venmoLink(format, 'pay', input);
}

/** The Venmo pay link in the app's current format (VENMO_LINK_FORMAT), or null (see above). */
export function venmoPayUrl(input: VenmoPayInput): string | null {
  return venmoPayUrlForFormat(VENMO_LINK_FORMAT, input);
}

/**
 * The Venmo request link (txn=charge) in a given format: the pay link for the same input with
 * txn=charge, null in exactly the same cases. `username` is the person being asked (who owes);
 * itemNames are that person's own claimed items. Prefer venmoRequestUrl; exported so both formats
 * are tested.
 */
export function venmoRequestUrlForFormat(format: VenmoLinkFormat, input: VenmoPayInput): string | null {
  return venmoLink(format, 'charge', input);
}

/** The Venmo request link in the app's current format (VENMO_LINK_FORMAT), or null (see above). */
export function venmoRequestUrl(input: VenmoPayInput): string | null {
  return venmoRequestUrlForFormat(VENMO_LINK_FORMAT, input);
}

/**
 * Opens a payment link with React Native's Linking on every platform: an https link opens the
 * Venmo app when installed, the browser otherwise; on web it is window.open(url, '_blank',
 * 'noopener'), which resolves even when a popup blocker stops it. Never throws, and never marks
 * anything as paid.
 */
export async function openPaymentLink(url: string): Promise<{ ok: boolean }> {
  try {
    await Linking.openURL(url);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Web opener (docs/specs/2026-11-26-sent-via-venmo.md D2 "Web", Amendment A1 eng §1; replaces SV-9)
// ---------------------------------------------------------------------------

/** What the web send needs from an opened tab. A real `Window` fits. */
export type OpenedTab = { closed: boolean; opener: unknown };

/**
 * Opens a payment link in a new tab, synchronously, so it runs inside the tap's user gesture
 * (popup blockers allow only that). window.open is the first statement: nothing may be awaited
 * before it. Not React Native's Linking, which passes 'noopener' and so always gets null back and
 * can't tell a blocked popup from an opened one.
 *
 * Returns the new tab with `opener` set to null (Venmo's page can't reach back into SplitIt), or
 * null when the popup was blocked, window.open threw, or there is no window.open (native). Never
 * throws, and never marks anything. Callers pass only venmoPayUrl output.
 */
export function openPaymentLinkWeb<W extends OpenedTab = Window>(url: string): W | null {
  let w: W | null;
  try {
    w = (window.open(url, '_blank') as W | null) ?? null;
  } catch {
    return null;
  }
  if (w === null) return null;
  try {
    w.opener = null;
  } catch {
    // Some browsers refuse the write on a cross-origin tab; it already has no usable opener then.
  }
  return w;
}

/** A tab we opened, as far as closing it goes (the real Window, or a test stand-in). */
export type ClosableTab = { close?: () => void };

/**
 * Closes a tab this app opened (review R1: the write was refused after Venmo opened, so the
 * pre-filled payment shouldn't stay up). A tab we opened may be closed by script. Never throws: a
 * browser that refuses, or a tab Venmo's app already took over, leaves it as it is.
 */
export function closeOpenedTab(w: ClosableTab | null): void {
  try {
    w?.close?.();
  } catch {
    // Nothing to do: the copy already says to check Venmo.
  }
}

/** The tab is still open. Reading `closed` throwing counts as closed (ask, never auto-mark). */
export function webOpenStillOpen(w: Pick<OpenedTab, 'closed'>): boolean {
  try {
    return !w.closed;
  } catch {
    return false;
  }
}

/**
 * How long mobile web waits after opening before it looks at the tab (starting value, A1 §1):
 * long enough for Venmo's universal link to take over and close it, short enough to feel instant.
 * Verify per browser in user check U3.
 */
export const WEB_OPEN_CHECK_MS = 300;

/**
 * What the web send does after openPaymentLinkWeb (A1 §1, contract O):
 * - 'blocked': nothing opened (null). No write; show the open-failed line.
 * - 'ask': show contract O ("Did you send Hana $15.10?") on return. Always on desktop web, where a
 *   venmo.com tab may not be able to pay; on mobile web when the tab closed during the wait.
 * - 'record': mobile web and the tab is still open after `waitMs`: record the send with 'venmo'.
 * `mobile` comes from detectMobileWeb (lib/appBanner.ts); this file doesn't test for phones itself.
 * Always settles: the only wait is a timer.
 */
export function webOpenOutcome(
  w: Pick<OpenedTab, 'closed'> | null,
  mobile: boolean,
  waitMs: number = WEB_OPEN_CHECK_MS,
): Promise<'blocked' | 'ask' | 'record'> {
  if (w === null) return Promise.resolve('blocked');
  if (!mobile) return Promise.resolve('ask');
  return new Promise((resolve) => {
    setTimeout(() => resolve(webOpenStillOpen(w) ? 'record' : 'ask'), waitMs);
  });
}
