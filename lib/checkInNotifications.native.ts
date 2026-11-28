// The "Did your $15.10 go through?" check-in notification on iOS/Android
// (docs/specs/2026-11-26-sent-via-venmo.md § D3, Task 8; facts from the installed
// expo-notifications 57.0.26, recorded in docs/specs/2026-11-26-sent-via-venmo-notifications-check.md).
//
// The only file in the app that imports expo-notifications (criterion 45). Local notifications only:
// nothing here asks for, reads or registers a push token (criterion 56), and the push entitlement
// is stripped at prebuild (plugins/withoutPushEntitlement.js).
//
// Facts this file relies on (installed source):
// - Permission: read `ios.status` (0 not determined, 1 denied, 2 authorized, 3 provisional,
//   4 ephemeral); the root `status`/`granted` report provisional as undetermined.
// - Android 13+ shows the permission prompt only once a channel exists, so the channel comes first.
// - `cancelScheduledNotificationAsync` removes only pending requests; one that already fired stays
//   in Notification Center until `dismissNotificationAsync`. So every cancel does both.
// - iOS adds `.foreground` to an action only when `opensAppToForeground === true`, whatever the docs'
//   default says, so both actions pass it explicitly (SENT_CHECK_ACTIONS).
// - The hidden-preview text is the category option `previewPlaceholder` (iOS
//   `hiddenPreviewsBodyPlaceholder`).
// - No `setNotificationHandler`: a check-in that fires while SplitIt is in front isn't shown.
//
// Every call resolves (never rejects), and each native await has a time limit.

import * as Notifications from 'expo-notifications';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import type { KeyValueStorage } from './chunkedStorage';
import {
  NOTIFICATION_CALL_TIMEOUT_MS,
  PERMISSION_PROMPT_TIMEOUT_MS,
  SCHEDULE_TIMEOUT_MS,
  SENT_CHECK_CHANNEL_ID,
  SENT_CHECK_CHANNEL_NAME,
  SENT_CHECK_ID_PREFIX,
  type CheckInNotifications,
  type NotificationPermission,
  type SentCheckAction,
  type SentCheckResponse,
  type SentCheckResponseHandler,
} from './checkInNotifications.types';
import {
  DEVICE_KEY_RE,
  NOTIF_ASKED_KEY,
  SENT_CHECK_ACTIONS,
  SENT_CHECK_CATEGORY_ID,
  SENT_CHECK_PREVIEW_PLACEHOLDER,
  type SentCheckNotification,
} from './sentCheck';
import { storage as deviceStorage } from './storage';

export type {
  CheckInNotifications,
  NotificationPermission,
  SentCheckAction,
  SentCheckResponse,
  SentCheckResponseHandler,
} from './checkInNotifications.types';

/** The request this module schedules, before the enum mapping in the default wiring. */
export type SentCheckRequest = {
  identifier: string;
  content: {
    title: string;
    body: string;
    sound: false;
    categoryIdentifier: string;
    data: Record<string, unknown>;
  };
  trigger: { type: 'timeInterval'; seconds: number; repeats: false; channelId?: string };
};

/** The parts of expo-notifications we use (loosely typed so tests can pass a fake). */
export type NativeNotifications = {
  getPermissionsAsync(): Promise<unknown>;
  requestPermissionsAsync(request: { ios: { allowAlert: true; allowSound: true } }): Promise<unknown>;
  setNotificationCategoryAsync(
    identifier: string,
    actions: Array<{ identifier: string; buttonTitle: string; options: { opensAppToForeground: boolean; isDestructive?: boolean } }>,
    options: { previewPlaceholder: string },
  ): Promise<unknown>;
  setNotificationChannelAsync(
    id: string,
    channel: { name: string; importance: 'high'; sound: null; showBadge: false },
  ): Promise<unknown>;
  scheduleNotificationAsync(request: SentCheckRequest): Promise<string>;
  cancelScheduledNotificationAsync(identifier: string): Promise<void>;
  dismissNotificationAsync(identifier: string): Promise<void>;
  getAllScheduledNotificationsAsync(): Promise<unknown[]>;
  getPresentedNotificationsAsync(): Promise<unknown[]>;
  addNotificationResponseReceivedListener(listener: (response: unknown) => void): { remove(): void };
  getLastNotificationResponse(): unknown;
  clearLastNotificationResponse(): void;
};

export type CheckInNotificationsDeps = {
  notifications: NativeNotifications;
  storage: KeyValueStorage;
  platform: 'ios' | 'android';
  /** `Notifications.DEFAULT_ACTION_IDENTIFIER`: a tap on the notification's body. */
  defaultActionIdentifier: string;
};

const TIMED_OUT: unique symbol = Symbol('timed out');
type TimedOut = typeof TIMED_OUT;

/** Runs `fn` (a sync throw counts as a rejection) and resolves with its value or TIMED_OUT. */
function limited<T>(fn: () => Promise<T> | T, ms: number): Promise<T | TimedOut> {
  return new Promise<T | TimedOut>((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    new Promise<T>((r) => r(fn())).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isSentCheckId(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(SENT_CHECK_ID_PREFIX) && DEVICE_KEY_RE.test(v);
}

const ACTION_IDS: ReadonlySet<string> = new Set(SENT_CHECK_ACTIONS.map((a) => a.identifier));

/** How many response keys the hook remembers for dedupe (one launch rarely sees more than a few). */
const SEEN_MAX = 100;

export function createCheckInNotifications(deps: CheckInNotificationsDeps): CheckInNotifications {
  const { notifications: n, storage, platform, defaultActionIdentifier } = deps;

  function toPermission(raw: unknown): NotificationPermission {
    if (!isRecord(raw)) return 'denied';
    if (platform === 'ios' && isRecord(raw.ios)) {
      const status = raw.ios.status;
      if (status === 0) return 'undetermined';
      if (status === 1) return 'denied';
      if (status === 2 || status === 3 || status === 4) return 'granted';
      return 'denied';
    }
    if (raw.status === 'granted') return 'granted';
    if (raw.status === 'undetermined') return 'undetermined';
    return 'denied';
  }

  async function notificationPermission(): Promise<NotificationPermission> {
    try {
      const raw = await limited(() => n.getPermissionsAsync(), NOTIFICATION_CALL_TIMEOUT_MS);
      // Unknown means silence: no note, no prompt, no schedule.
      return raw === TIMED_OUT ? 'denied' : toPermission(raw);
    } catch {
      return 'denied';
    }
  }

  let channel: Promise<boolean> | null = null;
  function ensureAndroidChannel(): Promise<boolean> {
    if (platform !== 'android') return Promise.resolve(true);
    if (channel === null) {
      const attempt = limited(
        () =>
          n.setNotificationChannelAsync(SENT_CHECK_CHANNEL_ID, {
            name: SENT_CHECK_CHANNEL_NAME,
            importance: 'high', // heads-up banner (Unverified on a device, spec R4)
            sound: null,
            showBadge: false,
          }),
        NOTIFICATION_CALL_TIMEOUT_MS,
      ).then(
        (r) => r !== TIMED_OUT,
        () => false,
      );
      channel = attempt;
      void attempt.then((ok) => {
        if (!ok && channel === attempt) channel = null;
      });
    }
    return channel;
  }

  let category: Promise<boolean> | null = null;
  function ensureSentCheckCategory(): Promise<boolean> {
    if (category === null) {
      const attempt = limited(
        () =>
          n.setNotificationCategoryAsync(
            SENT_CHECK_CATEGORY_ID,
            SENT_CHECK_ACTIONS.map((a) => ({ identifier: a.identifier, buttonTitle: a.buttonTitle, options: { ...a.options } })),
            { previewPlaceholder: SENT_CHECK_PREVIEW_PLACEHOLDER },
          ),
        NOTIFICATION_CALL_TIMEOUT_MS,
      ).then(
        (r) => r !== TIMED_OUT,
        () => false,
      );
      category = attempt;
      void attempt.then((ok) => {
        if (!ok && category === attempt) category = null;
      });
    }
    return category;
  }

  async function askOnce(): Promise<NotificationPermission> {
    // Warm the category now, so it's registered by the time the check-in is scheduled.
    void ensureSentCheckCategory();
    const current = await notificationPermission();
    if (current !== 'undetermined') return current;
    try {
      const asked = await limited(() => storage.getItem(NOTIF_ASKED_KEY), NOTIFICATION_CALL_TIMEOUT_MS);
      if (asked !== null) return 'undetermined'; // asked before (or unreadable): never re-ask
      if (platform === 'android') await ensureAndroidChannel();
      // The flag goes first, so a prompt that is interrupted still counts as the one ask.
      const wrote = await limited(() => storage.setItem(NOTIF_ASKED_KEY, '1'), NOTIFICATION_CALL_TIMEOUT_MS);
      if (wrote === TIMED_OUT) return 'undetermined';
    } catch {
      return 'undetermined';
    }
    try {
      const raw = await limited(
        () => n.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true } }),
        PERMISSION_PROMPT_TIMEOUT_MS,
      );
      return raw === TIMED_OUT ? 'undetermined' : toPermission(raw);
    } catch {
      return notificationPermission();
    }
  }

  let asking: Promise<NotificationPermission> | null = null;
  function askNotificationPermissionOnce(): Promise<NotificationPermission> {
    if (asking === null) {
      asking = askOnce().finally(() => {
        asking = null;
      });
    }
    return asking;
  }

  function cancelOne(identifier: string): Promise<void> {
    const quiet = (fn: () => Promise<void>) =>
      limited(fn, NOTIFICATION_CALL_TIMEOUT_MS).then(
        () => undefined,
        () => undefined,
      );
    return Promise.all([
      quiet(() => n.cancelScheduledNotificationAsync(identifier)),
      quiet(() => n.dismissNotificationAsync(identifier)),
    ]).then(() => undefined);
  }

  async function cancelSentCheck(identifier: string): Promise<void> {
    if (!isSentCheckId(identifier)) return;
    await cancelOne(identifier);
  }

  async function list(fn: () => Promise<unknown[]>): Promise<unknown[]> {
    try {
      const r = await limited(fn, NOTIFICATION_CALL_TIMEOUT_MS);
      return Array.isArray(r) ? r : [];
    } catch {
      return [];
    }
  }

  /** The identifier and data of a NotificationRequest-shaped value, if it's one of our check-ins. */
  function ours(request: unknown): { identifier: string; data: unknown } | null {
    if (!isRecord(request) || !isSentCheckId(request.identifier)) return null;
    const content = isRecord(request.content) ? request.content : {};
    return { identifier: request.identifier, data: content.data };
  }

  async function cancelWhere(match: (identifier: string, data: unknown) => boolean): Promise<void> {
    const [scheduled, presented] = await Promise.all([
      list(() => n.getAllScheduledNotificationsAsync()),
      list(() => n.getPresentedNotificationsAsync()),
    ]);
    const quiet = (fn: () => Promise<void>) =>
      limited(fn, NOTIFICATION_CALL_TIMEOUT_MS).then(
        () => undefined,
        () => undefined,
      );
    const jobs: Array<Promise<void>> = [];
    for (const r of scheduled) {
      const m = ours(r);
      if (m !== null && match(m.identifier, m.data)) jobs.push(quiet(() => n.cancelScheduledNotificationAsync(m.identifier)));
    }
    for (const p of presented) {
      const m = ours(isRecord(p) ? p.request : null);
      if (m !== null && match(m.identifier, m.data)) jobs.push(quiet(() => n.dismissNotificationAsync(m.identifier)));
    }
    await Promise.all(jobs);
  }

  async function cancelSentChecks(userId: string): Promise<void> {
    if (typeof userId !== 'string' || userId === '' || !DEVICE_KEY_RE.test(userId)) return;
    const idPrefix = `${SENT_CHECK_ID_PREFIX}${userId}.`;
    await cancelWhere(
      (identifier, data) => identifier.startsWith(idPrefix) || (isRecord(data) && data.userId === userId),
    );
  }

  async function cancelAllSentChecks(): Promise<void> {
    await cancelWhere(() => true);
  }

  function validToSchedule(sent: SentCheckNotification): boolean {
    const seconds = sent.trigger.seconds;
    return isSentCheckId(sent.identifier) && Number.isInteger(seconds) && seconds > 0;
  }

  function requestFor(sent: SentCheckNotification): SentCheckRequest {
    const { title, body, categoryIdentifier, data } = sent.content;
    return {
      identifier: sent.identifier,
      // No badge key at all (SV-UX-6); sound off.
      content: { title, body, sound: false, categoryIdentifier, data: { ...data } },
      trigger: {
        type: 'timeInterval',
        seconds: sent.trigger.seconds,
        repeats: false,
        ...(platform === 'android' ? { channelId: SENT_CHECK_CHANNEL_ID } : {}),
      },
    };
  }

  async function scheduleSentCheck(sent: SentCheckNotification): Promise<boolean> {
    if (!validToSchedule(sent)) return false;
    let abandoned = false;
    const work = (async (): Promise<boolean> => {
      if (platform === 'android') await ensureAndroidChannel();
      // A missing category only loses the two buttons; a body tap still opens Settle up.
      await ensureSentCheckCategory();
      if (abandoned) return false;
      await n.scheduleNotificationAsync(requestFor(sent));
      return true;
    })().catch(() => false);
    const result = await limited(() => work, SCHEDULE_TIMEOUT_MS);
    if (result !== TIMED_OUT) return result;
    abandoned = true;
    // The caller now acts as if nothing was scheduled; make that true if the OS accepts it later.
    void work.then((ok) => (ok ? cancelOne(sent.identifier) : undefined));
    return false;
  }

  function toResponse(raw: unknown, source: SentCheckResponse['source']): SentCheckResponse | null {
    if (!isRecord(raw) || typeof raw.actionIdentifier !== 'string') return null;
    const notification = isRecord(raw.notification) ? raw.notification : null;
    const m = ours(notification?.request);
    if (m === null) return null;
    const actionId = raw.actionIdentifier;
    let action: SentCheckAction;
    if (actionId === defaultActionIdentifier) action = 'open';
    else if (ACTION_IDS.has(actionId)) action = actionId as 'yes' | 'undo'; // ACTION_IDS holds exactly these two
    else return null;
    return { key: `${m.identifier}|${actionId}`, identifier: m.identifier, action, data: m.data ?? null, source };
  }

  function subscribeSentCheckResponses(handler: SentCheckResponseHandler): () => void {
    let sub: { remove(): void };
    try {
      sub = n.addNotificationResponseReceivedListener((raw) => {
        const r = toResponse(raw, 'live');
        if (r === null) return;
        try {
          handler(r);
        } catch {
          // A handler bug must not break the next response.
        }
      });
    } catch {
      return () => {};
    }
    return () => {
      try {
        sub.remove();
      } catch {
        // Already removed.
      }
    };
  }

  function lastSentCheckResponse(): SentCheckResponse | null {
    try {
      return toResponse(n.getLastNotificationResponse(), 'cold');
    } catch {
      return null;
    }
  }

  function clearLastSentCheckResponse(): void {
    try {
      n.clearLastNotificationResponse();
    } catch {
      // Nothing to clear.
    }
  }

  // Dedupe for the app's lifetime: one response is handled once, across re-mounts (sign-out/in).
  const seen: string[] = [];
  function firstTime(key: string): boolean {
    if (seen.includes(key)) return false;
    seen.push(key);
    if (seen.length > SEEN_MAX) seen.shift();
    return true;
  }

  function useSentCheckResponses(handler: SentCheckResponseHandler): void {
    const latest = useRef(handler);
    useEffect(() => {
      latest.current = handler;
    }, [handler]);
    useEffect(() => {
      let active = true;
      const deliver = (r: SentCheckResponse) => {
        if (!active || !firstTime(r.key)) return;
        clearLastSentCheckResponse();
        try {
          latest.current(r);
        } catch {
          // A handler bug must not break the next response.
        }
      };
      // Subscribe first, then read the cold one: a response landing in between is deduped.
      const unsubscribe = subscribeSentCheckResponses(deliver);
      const cold = lastSentCheckResponse();
      if (cold !== null) deliver(cold);
      return () => {
        active = false;
        unsubscribe();
      };
    }, []);
  }

  return {
    supported: true,
    notificationPermission,
    askNotificationPermissionOnce,
    ensureSentCheckCategory,
    ensureAndroidChannel,
    scheduleSentCheck,
    cancelSentCheck,
    cancelSentChecks,
    cancelAllSentChecks,
    subscribeSentCheckResponses,
    lastSentCheckResponse,
    clearLastSentCheckResponse,
    useSentCheckResponses,
  };
}

// The real package, mapped onto NativeNotifications. Enum values are read at call time.
const expoNotifications: NativeNotifications = {
  getPermissionsAsync: () => Notifications.getPermissionsAsync(),
  requestPermissionsAsync: (request) => Notifications.requestPermissionsAsync(request),
  setNotificationCategoryAsync: (identifier, actions, options) =>
    Notifications.setNotificationCategoryAsync(identifier, actions, options),
  setNotificationChannelAsync: (id, { name, sound, showBadge }) =>
    Notifications.setNotificationChannelAsync(id, {
      name,
      importance: Notifications.AndroidImportance.HIGH,
      sound,
      showBadge,
    }),
  scheduleNotificationAsync: ({ identifier, content, trigger }) =>
    Notifications.scheduleNotificationAsync({
      identifier,
      content,
      trigger: { ...trigger, type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL },
    }),
  cancelScheduledNotificationAsync: (identifier) => Notifications.cancelScheduledNotificationAsync(identifier),
  dismissNotificationAsync: (identifier) => Notifications.dismissNotificationAsync(identifier),
  getAllScheduledNotificationsAsync: () => Notifications.getAllScheduledNotificationsAsync(),
  getPresentedNotificationsAsync: () => Notifications.getPresentedNotificationsAsync(),
  addNotificationResponseReceivedListener: (listener) => Notifications.addNotificationResponseReceivedListener(listener),
  getLastNotificationResponse: () => Notifications.getLastNotificationResponse(),
  clearLastNotificationResponse: () => Notifications.clearLastNotificationResponse(),
};

export const checkInNotifications = createCheckInNotifications({
  notifications: expoNotifications,
  storage: deviceStorage,
  platform: Platform.OS === 'android' ? 'android' : 'ios',
  defaultActionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
}) satisfies CheckInNotifications;

export const {
  supported,
  notificationPermission,
  askNotificationPermissionOnce,
  ensureSentCheckCategory,
  ensureAndroidChannel,
  scheduleSentCheck,
  cancelSentCheck,
  cancelSentChecks,
  cancelAllSentChecks,
  subscribeSentCheckResponses,
  lastSentCheckResponse,
  clearLastSentCheckResponse,
  useSentCheckResponses,
} = checkInNotifications;
