// Runs before every test file (package.json "jest.setupFilesAfterEnv").
//
// expo-contacts and expo-sms are native modules: importing the real packages under Jest throws
// ("Super expression must either be null or a function"). On Jest's default iOS platform,
// lib/contactPicker resolves to contactPicker.native.ts, which imports both, so every screen test
// that renders the Invite card ("From contacts", people-and-invites Task 10) would crash.
//
// These stand-ins fail loudly (review finding R5): the permission request, the picker and the SMS
// composer all reject, which contactPicker.native.ts turns into its 'error' result, so a screen test
// that taps "From contacts" without mocking '@/lib/contactPicker' shows the error copy instead of
// silently doing nothing. Tests that exercise the flow mock '@/lib/contactPicker' themselves
// (__tests__/contactInvite.test.tsx), and lib/contactPicker.native.test.ts mocks these two modules
// with its own fakes, which win over these.
// isAvailableAsync stays a plain `false`: contactPicker treats a rejection there as `false` anyway,
// and "no SMS on this device" is the safe default for screens that only render the card.
// (The reject helper is defined inside each factory: babel-plugin-jest-hoist moves jest.mock()
// above everything else and refuses factories that reference outer variables.)
jest.mock('expo-contacts', () => {
  const notMocked = () => Promise.reject(new Error('expo-contacts not mocked in this test'));
  return {
    Contact: { presentPicker: jest.fn(notMocked) },
    requestPermissionsAsync: jest.fn(notMocked),
  };
});
jest.mock('expo-sms', () => {
  const notMocked = () => Promise.reject(new Error('expo-sms not mocked in this test'));
  return {
    isAvailableAsync: jest.fn(async () => false),
    sendSMSAsync: jest.fn(notMocked),
  };
});
// expo-notifications (sent-via-Venmo Task 8): the same rule. Only lib/checkInNotifications.native.ts
// imports it, and that module turns every rejection or throw into "no notification" (false, null,
// 'denied'), so a screen test that forgets to mock '@/lib/checkInNotifications' never schedules
// anything by accident. lib/checkInNotifications.native.test.ts injects its own fakes. The constants
// the module reads when it loads are the package's real values.
jest.mock('expo-notifications', () => {
  const notMocked = () => Promise.reject(new Error('expo-notifications not mocked in this test'));
  const notMockedSync = () => {
    throw new Error('expo-notifications not mocked in this test');
  };
  return {
    DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
    SchedulableTriggerInputTypes: { TIME_INTERVAL: 'timeInterval' },
    AndroidImportance: { HIGH: 6 },
    getPermissionsAsync: jest.fn(notMocked),
    requestPermissionsAsync: jest.fn(notMocked),
    setNotificationCategoryAsync: jest.fn(notMocked),
    setNotificationChannelAsync: jest.fn(notMocked),
    scheduleNotificationAsync: jest.fn(notMocked),
    cancelScheduledNotificationAsync: jest.fn(notMocked),
    dismissNotificationAsync: jest.fn(notMocked),
    getAllScheduledNotificationsAsync: jest.fn(notMocked),
    getPresentedNotificationsAsync: jest.fn(notMocked),
    addNotificationResponseReceivedListener: jest.fn(notMockedSync),
    getLastNotificationResponse: jest.fn(notMockedSync),
    clearLastNotificationResponse: jest.fn(notMockedSync),
  };
});

// expo-status-bar (Appearance setting, 2026-11-28): app/_layout.tsx renders <StatusBar style=…>.
// Under Jest's iOS platform the real component leaves async native work pending, so any router
// test that switches to fake timers mid-test (e.g. __tests__/activity.test.tsx "139: a live hint")
// ran its last line and then never finished. This stand-in renders nothing and records its props,
// so a test can still read the style the layout asked for: (StatusBar as jest.Mock).mock.calls.
jest.mock('expo-status-bar', () => ({
  StatusBar: jest.fn(() => null),
  setStatusBarStyle: jest.fn(),
  setStatusBarHidden: jest.fn(),
  setStatusBarBackgroundColor: jest.fn(),
  setStatusBarTranslucent: jest.fn(),
  setStatusBarNetworkActivityIndicatorVisible: jest.fn(),
}));

// lib/useUsernameStatus (usernames A3.8): app/(app)/_layout.tsx gates every signed-in route on a
// picked (locked) username, and that read is an RPC. Every suite runs as a locked user, so the gate
// never shows and my_username_status never joins a call log. The gate's tests (__tests__/chooseUsername*.test.tsx,
// lib/useUsernameStatus.test.ts) call jest.unmock('@/lib/useUsernameStatus') to get the real hook.
jest.mock('@/lib/useUsernameStatus', () =>
  jest.requireActual<typeof import('@/test-utils/username')>('@/test-utils/username').lockedUsernameStatus(),
);
