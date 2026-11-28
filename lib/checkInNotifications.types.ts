// The check-in notification module's contract (docs/specs/2026-11-26-sent-via-venmo.md § D3, Task 8).
//
// Two implementations, both `satisfies CheckInNotifications`:
// - lib/checkInNotifications.native.ts (iOS/Android): the only file that imports expo-notifications.
// - lib/checkInNotifications.ts (web, and what TypeScript resolves): does nothing, never imports it
//   (on web the package rejects, throws synchronously, or shows the browser's real prompt).
//
// Every function resolves (none rejects) and every native await has a time limit, so a call that
// never settles can't hold up the Pay flow. No function asks for or reads a push token.

import type { SentCheckNotification } from './sentCheck';

/**
 * What the OS lets us do. `granted` covers iOS authorized, provisional and ephemeral (it can
 * deliver). `unsupported` is web. Read from iOS `ios.status`, never the root `granted` field,
 * which misreports provisional.
 */
export type NotificationPermission = 'undetermined' | 'denied' | 'granted' | 'unsupported';

/** The tapped part of a check-in notification: one of the two actions, or the body ('open'). */
export type SentCheckAction = 'yes' | 'undo' | 'open';

/**
 * A response to one of our check-in notifications. `data` is the notification's raw data: the
 * caller must pass it through `parseSentCheckData(data, sessionUserId)` before using it.
 * `source` says whether it arrived while running ('live') or was the response that launched or
 * resumed the app before anything listened ('cold'; the responder gates it on the resume).
 */
export type SentCheckResponse = {
  /** `identifier|actionIdentifier`, the dedupe key. */
  key: string;
  identifier: string;
  action: SentCheckAction;
  data: unknown;
  source: 'live' | 'cold';
};

export type SentCheckResponseHandler = (response: SentCheckResponse) => void;

export type CheckInNotifications = {
  /** False on web: no notification is ever scheduled, and the inline question covers it. */
  readonly supported: boolean;
  /** The current permission, without asking. */
  notificationPermission(): Promise<NotificationPermission>;
  /**
   * Asks for full authorization (alert + sound; not provisional, no badge) only when it's
   * undetermined and the device flag `NOTIF_ASKED_KEY` is unset; sets the flag first. On Android
   * the channel is created before asking. Returns the permission afterwards.
   */
  askNotificationPermissionOnce(): Promise<NotificationPermission>;
  /** Registers the `sent_check` category (memoized; retried after a failure). True when registered. */
  ensureSentCheckCategory(): Promise<boolean>;
  /** Creates the Android `sent_check` channel (memoized). True on iOS (nothing to do) and when created. */
  ensureAndroidChannel(): Promise<boolean>;
  /**
   * Schedules the check-in built by `sentCheckNotification` (60 s, no sound, no badge). True when
   * the OS accepted it within `SCHEDULE_TIMEOUT_MS`; a schedule that lands after the limit is
   * cancelled, so the caller's "no notification" holds.
   */
  scheduleSentCheck(notification: SentCheckNotification): Promise<boolean>;
  /** Cancels a pending check-in and removes it from Notification Center if it already fired. */
  cancelSentCheck(identifier: string): Promise<void>;
  /** Same, for every check-in of this user (pending and presented, matched on `data.userId`). */
  cancelSentChecks(userId: string): Promise<void>;
  /** Same, for every check-in on the device, whoever it was for (sign-out). */
  cancelAllSentChecks(): Promise<void>;
  /** Live responses to check-in notifications. Returns the unsubscribe function. */
  subscribeSentCheckResponses(handler: SentCheckResponseHandler): () => void;
  /** The response that launched/resumed the app, if it was one of ours (`source: 'cold'`). */
  lastSentCheckResponse(): SentCheckResponse | null;
  /** Forgets the last response, so a re-mount doesn't handle it again. */
  clearLastSentCheckResponse(): void;
  /**
   * React hook: calls `handler` once per response (live, plus the cold-start one at mount), deduped
   * by `key` for the app's lifetime, clearing the last response after each. The handler can change
   * between renders; the latest one is called.
   */
  useSentCheckResponses(handler: SentCheckResponseHandler): void;
};

/** Starting value: how long the OS gets to accept a schedule (spec D2 step 3). */
export const SCHEDULE_TIMEOUT_MS = 1000;
/** Starting value: limit on any other single native notification call (permission read, cancel, ...). */
export const NOTIFICATION_CALL_TIMEOUT_MS = 2000;
/**
 * Starting value: limit on the permission prompt. The user is reading a system alert, so it's long;
 * after it the Pay flow goes on as if undetermined (no notification this time).
 */
export const PERMISSION_PROMPT_TIMEOUT_MS = 60000;
/** Android channel id, the same as the category id. */
export const SENT_CHECK_CHANNEL_ID = 'sent_check';
/** Android channel name, shown in the system's notification settings. */
export const SENT_CHECK_CHANNEL_NAME = 'Payment check-ins';
/** Every check-in identifier starts with this (`sentCheckNotificationId` in lib/sentCheck.ts). */
export const SENT_CHECK_ID_PREFIX = 'sentcheck.';
