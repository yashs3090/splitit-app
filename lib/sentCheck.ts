// Check-in rules for "Sent via Venmo" (docs/specs/2026-11-26-sent-via-venmo.md § D3, contract C).
//
// After Sam's Venmo send for his share, the app asks once whether it went through: a local
// notification a minute later on phones (Task 8 schedules it from `sentCheckNotification`), or the
// same question inline on his card if he's back first (`sentCheckInline`). Answers live on the
// device in one JSON blob per user (A1 F1: SecureStore keys must match `^[\w.-]+$` and can't be
// listed). "No, undo" follows `undoDecision` after re-reading the bill.
//
// Pure apart from `readSentCheckBlob` / `storeSentCheckAnswer`, which take the storage as an
// argument. No expo-notifications import here (criterion 45), no clock (callers pass `now`).

import type { KeyValueStorage } from './chunkedStorage';
import { formatCents } from './money';
import { isSettleCents } from './paylinks';
import type { SettleMark } from './settle';

/** The viewer's mark (A1 `SettleMark`): amount, `settled_at`, how, and to whom. */
export type SentCheckMark = SettleMark;

// ---------------------------------------------------------------------------------------------
// Constants.

/** User value (U-A1.2, 2026-11-26): not tunable without asking. */
export const SENT_CHECK_DELAY_SECONDS = 60;
/** Starting value: the inline question stops showing this long after the mark. */
export const SENT_CHECK_INLINE_MAX_MINUTES = 30;
/** Answers older than this are pruned from the blob on every write (D3: 2 days). */
export const SENT_CHECK_KEEP_MS = 2 * 24 * 60 * 60 * 1000;
/** Starting value: a storage read or write that takes longer is given up on. */
export const SENT_CHECK_STORAGE_TIMEOUT_MS = 2000;

export const SENT_CHECK_CATEGORY_ID = 'sent_check';
/** iOS hidden-preview text (SV-UX-6). Task 8 verifies the category option's name in the package. */
export const SENT_CHECK_PREVIEW_PLACEHOLDER = 'Check your SplitIt payment';
/**
 * The notification's two actions. `opensAppToForeground` is always explicit (the iOS default
 * differs from the docs). Task 8 maps these onto `setNotificationCategoryAsync`.
 */
export const SENT_CHECK_ACTIONS = [
  { identifier: 'yes', buttonTitle: 'Yes', options: { opensAppToForeground: false } },
  { identifier: 'undo', buttonTitle: 'No, undo', options: { opensAppToForeground: true, isDestructive: true } },
] as const;

/** Device flag: notification permission was asked once (SV-17, never re-asked). */
export const NOTIF_ASKED_KEY = 'splitit.notifAsked.v1';
/** Every device key matches this (SecureStore rejects anything else). */
export const DEVICE_KEY_RE = /^[\w.-]+$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTRY_KEY_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.\d+$/i;
const INLINE_MAX_MS = SENT_CHECK_INLINE_MAX_MINUTES * 60 * 1000;
const NAME_MAX = 40; // code points of the payer's name in the notification body

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/** A mark time in ms: a non-negative safe integer (what `Date.parse` gives for a real `settled_at`). */
function isMs(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Only returns strings that match DEVICE_KEY_RE; anything else is null (belt and braces). */
function deviceKey(s: string): string | null {
  return DEVICE_KEY_RE.test(s) ? s : null;
}

// ---------------------------------------------------------------------------------------------
// Keys (A1 F1 + §11). Each builder checks its inputs and returns null rather than a bad key.

/** `Date.parse(settled_at)`, or null when it can't be parsed. Compared as numbers, never as strings. */
export function markAtMsOf(settledAt: string): number | null {
  if (typeof settledAt !== 'string') return null;
  const ms = Date.parse(settledAt);
  return Number.isFinite(ms) ? ms : null;
}

/** The answer's key inside the blob: `<billId>.<payerId>.<markAtMs>`. */
export function sentCheckKey(billId: string, payerId: string, markAtMs: number): string | null {
  if (!isUuid(billId) || !isUuid(payerId) || !isMs(markAtMs)) return null;
  return deviceKey(`${billId}.${payerId}.${markAtMs}`);
}

/** The notification identifier: `sentcheck.<userId>.<billId>.<payerId>.<markAtMs>`. */
export function sentCheckNotificationId(userId: string, billId: string, payerId: string, markAtMs: number): string | null {
  if (!isUuid(userId)) return null;
  const key = sentCheckKey(billId, payerId, markAtMs);
  return key === null ? null : deviceKey(`sentcheck.${userId}.${key}`);
}

/** Storage key of a user's answers blob: `splitit.sentcheck.v1.<userId>`. */
export function sentCheckBlobKey(userId: string): string | null {
  return isUuid(userId) ? deviceKey(`splitit.sentcheck.v1.${userId}`) : null;
}

/** Storage key of a user's remembered Venmo/Cash choice: `splitit.payMethod.v1.<userId>`. */
export function payMethodKey(userId: string): string | null {
  return isUuid(userId) ? deviceKey(`splitit.payMethod.v1.${userId}`) : null;
}

// ---------------------------------------------------------------------------------------------
// The answers blob: `{ "<key>": { a: 'yes' | 'undo' | 'shown', t: ms } }`.

export type SentCheckAnswer = 'yes' | 'undo' | 'shown';
export type SentCheckEntry = { a: SentCheckAnswer; t: number };
export type SentCheckBlob = Readonly<Record<string, Readonly<SentCheckEntry>>>;

/** Higher wins: 'undo' beats 'yes', and neither is ever overwritten by 'shown'. */
const RANK: Record<SentCheckAnswer, number> = { shown: 0, yes: 1, undo: 2 };

function isAnswer(v: unknown): v is SentCheckAnswer {
  return v === 'yes' || v === 'undo' || v === 'shown';
}

function parseEntry(v: unknown): SentCheckEntry | null {
  if (!isPlainObject(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 2 || !isAnswer(v.a) || !isMs(v.t)) return null;
  return { a: v.a, t: v.t };
}

/** The stored blob. Not JSON, not an object, or missing → empty. Malformed entries are dropped. */
export function parseSentCheckBlob(raw: string | null | undefined): SentCheckBlob {
  if (typeof raw !== 'string' || raw === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isPlainObject(parsed)) return {};
  const out: Record<string, SentCheckEntry> = {};
  for (const key of Object.keys(parsed)) {
    if (!ENTRY_KEY_RE.test(key)) continue;
    const entry = parseEntry(parsed[key]);
    if (entry) out[key] = entry;
  }
  return out;
}

export function serializeSentCheckBlob(blob: SentCheckBlob): string {
  return JSON.stringify(blob);
}

/** The stored answer for a key, or null. Own entries only (a key like `__proto__` is never an answer). */
export function answerFor(blob: SentCheckBlob, key: string): SentCheckAnswer | null {
  if (!Object.prototype.hasOwnProperty.call(blob, key)) return null;
  const entry = blob[key];
  return entry && isAnswer(entry.a) ? entry.a : null;
}

/** Drops entries older than SENT_CHECK_KEEP_MS (exactly that old is kept). Returns a new object. */
export function pruneSentCheckBlob(blob: SentCheckBlob, now: number): SentCheckBlob {
  const out: Record<string, SentCheckEntry> = {};
  for (const key of Object.keys(blob)) {
    const entry = blob[key];
    if (entry && now - entry.t <= SENT_CHECK_KEEP_MS) out[key] = { a: entry.a, t: entry.t };
  }
  return out;
}

/**
 * The blob with `answer` recorded for `key` at `now`, then pruned. A weaker answer than the one
 * stored changes nothing (see RANK). An invalid key is refused (the blob comes back pruned, unchanged
 * otherwise). Never mutates its input.
 */
export function withAnswer(blob: SentCheckBlob, key: string, answer: SentCheckAnswer, now: number): SentCheckBlob {
  const out: Record<string, SentCheckEntry> = { ...pruneSentCheckBlob(blob, now) };
  if (!ENTRY_KEY_RE.test(key) || !isAnswer(answer) || !isMs(now)) return out;
  const stored = answerFor(out, key);
  if (stored === null || RANK[answer] >= RANK[stored]) out[key] = { a: answer, t: now };
  return out;
}

// ---------------------------------------------------------------------------------------------
// Reading and writing the blob. Each storage call has a time limit; a read that fails or times out
// reads as empty; a write that fails or times out returns false. Writes for one user run one at a
// time, so two answers given at once (card and footer) both land.

const TIMED_OUT = Symbol('timed_out');

async function timed<T>(p: Promise<T>): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), SENT_CHECK_STORAGE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([p, limit]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const queues = new Map<string, Promise<unknown>>();

function serialised<T>(key: string, run: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(run, run);
  const tail = next.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return next;
}

/** The user's answers. Never throws; anything wrong reads as empty. */
export async function readSentCheckBlob(storage: KeyValueStorage, userId: string): Promise<SentCheckBlob> {
  const blobKey = sentCheckBlobKey(userId);
  if (blobKey === null) return {};
  try {
    const raw = await timed(storage.getItem(blobKey));
    return raw === TIMED_OUT ? {} : parseSentCheckBlob(raw);
  } catch {
    return {};
  }
}

/**
 * Records an answer (with precedence and pruning) in the user's blob. Returns whether it was saved.
 * Never throws. If the stored blob can't be read (error or timeout) nothing is written, so other
 * answers aren't lost; a stored blob that is malformed is replaced.
 */
export function storeSentCheckAnswer(
  storage: KeyValueStorage,
  userId: string,
  key: string,
  answer: SentCheckAnswer,
  now: number,
): Promise<boolean> {
  const blobKey = sentCheckBlobKey(userId);
  if (blobKey === null || !ENTRY_KEY_RE.test(key) || !isAnswer(answer)) return Promise.resolve(false);
  return serialised(blobKey, async () => {
    try {
      const raw = await timed(storage.getItem(blobKey));
      if (raw === TIMED_OUT) return false;
      const next = withAnswer(parseSentCheckBlob(raw), key, answer, now);
      const wrote = await timed(storage.setItem(blobKey, serializeSentCheckBlob(next)));
      return wrote !== TIMED_OUT;
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------------------------
// The inline question (D3; criterion 25).

export type SentCheckInlineInput = {
  billId: string;
  /** The current plan's payer (`plan.payerId`): the payer in the key. */
  payerId: string;
  /** The viewer's own mark, or null. */
  mark: SentCheckMark | null;
  /** A more or back difference is due: the card is a difference card, which never asks. */
  hasDifference: boolean;
  /**
   * The send this screen just made, if it knows. 'more' never asks (A1 F4). A later visit doesn't
   * know, so after a "more" send the caller also stores 'shown' for the mark's key (the "more" call
   * keeps the first `settled_at`, so the key is the original send's).
   */
  lastSend?: 'share' | 'more';
};

/** What the card and footer need to ask, and what the undo rule checks against. Copy is Task 6's. */
export type SentCheckInline = { key: string; billId: string; payerId: string; cents: number; markAtMs: number };

/**
 * The inline question for the viewer's send, or null. Shows when all hold: the mark exists, is
 * `venmo` and is to the plan's payer; it isn't a "more" send or a difference card; no answer is
 * stored for its key; and `now − markAt ≤ 30 min` (a mark slightly in the future, from clock skew,
 * still shows).
 */
export function sentCheckInline(input: SentCheckInlineInput, store: SentCheckBlob, now: number): SentCheckInline | null {
  const { billId, payerId, mark } = input;
  if (mark === null || mark.method !== 'venmo' || mark.toUserId !== payerId) return null;
  if (input.hasDifference || input.lastSend === 'more') return null;
  const markAtMs = markAtMsOf(mark.at);
  if (markAtMs === null) return null;
  const key = sentCheckKey(billId, payerId, markAtMs);
  if (key === null || answerFor(store, key) !== null) return null;
  if (now - markAtMs > INLINE_MAX_MS) return null;
  return { key, billId, payerId, cents: mark.cents, markAtMs };
}

/**
 * How long until the inline question for this mark has to go (`now − markAt` passes 30 min), in ms,
 * or null if it already has or the time is unreadable. Screens re-check on a timer set from this
 * (review R10), so a question doesn't outstay its window while nothing else re-renders.
 */
export function sentCheckInlineEndsInMs(markAt: string | null, now: number): number | null {
  const ms = markAt === null ? null : markAtMsOf(markAt);
  if (ms === null) return null;
  const left = ms + INLINE_MAX_MS + 1 - now;
  return left > 0 ? left : null;
}

/**
 * How far behind the phone the server's clock may be when matching a late mark to a tap. Starting
 * value; a mark from another device in this window for the same amount is treated as this send.
 */
export const LATE_SEND_SKEW_MS = 60 * 1000;

/**
 * Review R4: the write's outcome was unknown and Venmo didn't open. Is the viewer's mark, as re-read,
 * this send landing anyway? A `venmo` mark to the payer for the same cents, made at or after the tap
 * (less LATE_SEND_SKEW_MS). If so it says "Sent" for a Venmo that never opened, and is cleared.
 */
export function isLateOwnSend(mark: SentCheckMark | null, sent: { cents: number; payerId: string; tapAtMs: number }): boolean {
  if (mark === null || mark.method !== 'venmo' || mark.toUserId !== sent.payerId || mark.cents !== sent.cents) return false;
  const ms = markAtMsOf(mark.at);
  return ms !== null && ms >= sent.tapAtMs - LATE_SEND_SKEW_MS;
}

// ---------------------------------------------------------------------------------------------
// The undo rule (A1 F6; criterion 27).

/**
 * What a "No, undo" does, after re-reading the bill. First match wins:
 * - `noop`: the stored answer is already 'undo'. Nothing shown.
 * - `silent`: the mark is gone. Store 'undo', cancel the check-in, show nothing.
 * - `unmark`: the mark is the one asked about. `unmarkPaid(me)`, then store 'undo', cancel, announce
 *   `Undone. Not marked as sent.` (If unmarkPaid fails, store nothing and keep the question.)
 * - `changed`: anything else. Store 'undo', Banner `Your payment to <payer> changed since then…`.
 */
export type UndoDecision = 'noop' | 'silent' | 'unmark' | 'changed';

export function undoDecision(
  stored: SentCheckAnswer | null,
  fresh: SentCheckMark | null,
  data: { cents: number; markAtMs: number; payerId: string },
): UndoDecision {
  if (stored === 'undo') return 'noop';
  if (fresh === null) return 'silent';
  const freshAt = markAtMsOf(fresh.at);
  const matches =
    fresh.method === 'venmo' &&
    fresh.cents === data.cents &&
    freshAt !== null &&
    freshAt === data.markAtMs &&
    fresh.toUserId === data.payerId;
  return matches ? 'unmark' : 'changed';
}

// ---------------------------------------------------------------------------------------------
// The notification (D3; criterion 26). Plain data: Task 8 maps it onto expo-notifications.

/** What the notification carries: UUIDs, integer cents and a number. Never names or the bill name. */
export type SentCheckData = { billId: string; userId: string; payerId: string; cents: number; markAtMs: number };

export type SentCheckNotification = {
  identifier: string;
  content: {
    title: string;
    body: string;
    /** No sound (SV-UX-6). There is deliberately no `badge`. */
    sound: false;
    categoryIdentifier: typeof SENT_CHECK_CATEGORY_ID;
    data: SentCheckData;
  };
  trigger: { seconds: number; repeats: false };
};

/**
 * The payer's name as it may leave the app (lock screen): whitespace collapsed, control, format and
 * lone surrogate characters removed, at most NAME_MAX code points. '' if nothing is left.
 */
function notificationName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw
    .replace(/\s+/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return Array.from(cleaned).slice(0, NAME_MAX).join('').trim();
}

/** The check-in to schedule for a share sent via Venmo, or null if the facts aren't valid. */
export function sentCheckNotification(input: { payerName: string } & SentCheckData): SentCheckNotification | null {
  const { billId, userId, payerId, cents, markAtMs } = input;
  if (!isSettleCents(cents)) return null;
  const identifier = sentCheckNotificationId(userId, billId, payerId, markAtMs);
  if (identifier === null) return null;
  const name = notificationName(input.payerName);
  const amount = formatCents(cents);
  const body = name === '' ? `Did your ${amount} go through?` : `Did your ${amount} to ${name} go through?`;
  return {
    identifier,
    content: {
      title: 'SplitIt',
      body,
      sound: false,
      categoryIdentifier: SENT_CHECK_CATEGORY_ID,
      data: { billId, userId, payerId, cents, markAtMs },
    },
    trigger: { seconds: SENT_CHECK_DELAY_SECONDS, repeats: false },
  };
}

const DATA_KEYS = ['billId', 'userId', 'payerId', 'cents', 'markAtMs'] as const;

/**
 * Allow-list for a notification response's `data` (criterion 52): exactly the five keys, UUID ids,
 * settle-range integer cents, a ms number, and `userId` equal to the signed-in user. Anything else,
 * or signed out, → null (ignored, no error).
 */
export function parseSentCheckData(raw: unknown, sessionUserId: string | null): SentCheckData | null {
  if (!isPlainObject(raw) || !isUuid(sessionUserId)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== DATA_KEYS.length || !DATA_KEYS.every((k) => keys.includes(k))) return null;
  const { billId, userId, payerId, cents, markAtMs } = raw;
  if (!isUuid(billId) || !isUuid(userId) || !isUuid(payerId)) return null;
  if (!isSettleCents(cents) || !isMs(markAtMs)) return null;
  if (userId !== sessionUserId) return null;
  return { billId, userId, payerId, cents, markAtMs };
}
