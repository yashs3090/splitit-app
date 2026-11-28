// The check-in notification module on web (and what TypeScript resolves for `./checkInNotifications`).
// docs/specs/2026-11-26-sent-via-venmo.md § D3, Task 8.
//
// Web has no local scheduler, so this does nothing and never imports expo-notifications
// (criteria 45, 46): on web the package's calls reject or throw synchronously, and its permission
// request shows the browser's real Notification prompt. The inline "Did it go through?" question
// covers every platform. Metro and Jest pick lib/checkInNotifications.native.ts on iOS/Android.

import type {
  CheckInNotifications,
  NotificationPermission,
  SentCheckResponse,
  SentCheckResponseHandler,
} from './checkInNotifications.types';
import type { SentCheckNotification } from './sentCheck';

export type {
  CheckInNotifications,
  NotificationPermission,
  SentCheckAction,
  SentCheckResponse,
  SentCheckResponseHandler,
} from './checkInNotifications.types';

export const checkInNotifications = {
  supported: false,
  notificationPermission: async (): Promise<NotificationPermission> => 'unsupported',
  askNotificationPermissionOnce: async (): Promise<NotificationPermission> => 'unsupported',
  ensureSentCheckCategory: async (): Promise<boolean> => false,
  ensureAndroidChannel: async (): Promise<boolean> => false,
  scheduleSentCheck: async (_notification: SentCheckNotification): Promise<boolean> => false,
  cancelSentCheck: async (_identifier: string): Promise<void> => {},
  cancelSentChecks: async (_userId: string): Promise<void> => {},
  cancelAllSentChecks: async (): Promise<void> => {},
  subscribeSentCheckResponses: (_handler: SentCheckResponseHandler): (() => void) => () => {},
  lastSentCheckResponse: (): SentCheckResponse | null => null,
  clearLastSentCheckResponse: (): void => {},
  // Not a real hook (it calls none), so it's safe to call on every render.
  useSentCheckResponses: (_handler: SentCheckResponseHandler): void => {},
} satisfies CheckInNotifications;

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
