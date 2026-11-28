// Web/default check-in notifications (docs/specs/2026-11-26-sent-via-venmo.md, Task 8).
// jest-expo resolves `.native.ts` first on its default (ios) platform, so this test imports the
// default file by its full name (same as lib/contactPicker.test.ts).
const fs = jest.requireActual<{ readFileSync(file: string, encoding: 'utf8'): string }>('fs');
const readLib = (name: string): string => fs.readFileSync(`${process.cwd()}/lib/${name}`, 'utf8');

const web = jest.requireActual<typeof import('./checkInNotifications')>('./checkInNotifications.ts');

describe('checkInNotifications (web/default)', () => {
  it('does nothing: unsupported, never schedules, every call resolves', async () => {
    expect(web.supported).toBe(false);
    expect(web.checkInNotifications.supported).toBe(false);
    await expect(web.notificationPermission()).resolves.toBe('unsupported');
    await expect(web.askNotificationPermissionOnce()).resolves.toBe('unsupported');
    await expect(web.ensureSentCheckCategory()).resolves.toBe(false);
    await expect(web.ensureAndroidChannel()).resolves.toBe(false);
    await expect(
      web.scheduleSentCheck({
        identifier: 'sentcheck.x',
        content: {
          title: 'SplitIt',
          body: 'b',
          sound: false,
          categoryIdentifier: 'sent_check',
          data: { billId: 'b', userId: 'u', payerId: 'p', cents: 1, markAtMs: 1 },
        },
        trigger: { seconds: 60, repeats: false },
      }),
    ).resolves.toBe(false);
    await expect(web.cancelSentCheck('sentcheck.x')).resolves.toBeUndefined();
    await expect(web.cancelSentChecks('u')).resolves.toBeUndefined();
    await expect(web.cancelAllSentChecks()).resolves.toBeUndefined();
    const off = web.subscribeSentCheckResponses(() => {});
    expect(() => off()).not.toThrow();
    expect(web.lastSentCheckResponse()).toBeNull();
    expect(() => web.clearLastSentCheckResponse()).not.toThrow();
    expect(() => web.useSentCheckResponses(() => {})).not.toThrow();
  });

  it('never imports expo-notifications; the native file does (criterion 45)', () => {
    const IMPORT = /from ['"]expo-notifications['"]|require\(['"]expo-notifications['"]\)/;
    expect(readLib('checkInNotifications.ts')).not.toMatch(IMPORT);
    expect(readLib('checkInNotifications.types.ts')).not.toMatch(IMPORT);
    // The check can find something.
    expect(readLib('checkInNotifications.native.ts')).toMatch(IMPORT);
  });
});
