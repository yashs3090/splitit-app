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
