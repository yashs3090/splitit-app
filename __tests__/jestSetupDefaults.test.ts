// Guards review finding R5 (people-and-invites): the global expo-contacts / expo-sms mocks in
// test-utils/jestSetup.ts must fail loudly, so a screen test that forgets to mock
// '@/lib/contactPicker' sees the error result instead of a silent "cancelled".
import { pickContactPhones, sendSms, smsAvailable } from '@/lib/contactPicker';

describe('global native-module mocks (test-utils/jestSetup.ts)', () => {
  it('rejects the contacts permission request and the picker', async () => {
    const contacts = jest.requireMock<{
      requestPermissionsAsync: () => Promise<unknown>;
      Contact: { presentPicker: () => Promise<unknown> };
    }>('expo-contacts');
    await expect(contacts.requestPermissionsAsync()).rejects.toThrow('expo-contacts not mocked in this test');
    await expect(contacts.Contact.presentPicker()).rejects.toThrow('expo-contacts not mocked in this test');
  });

  it('rejects sendSMSAsync', async () => {
    const sms = jest.requireMock<{ sendSMSAsync: (to: string[], body: string) => Promise<unknown> }>('expo-sms');
    await expect(sms.sendSMSAsync(['5551234567'], 'hi')).rejects.toThrow('expo-sms not mocked in this test');
  });

  it('surfaces as an error through lib/contactPicker, not as cancelled or sent', async () => {
    await expect(pickContactPhones()).resolves.toEqual({ status: 'error' });
    await expect(sendSms('5551234567', 'hi')).resolves.toBe('error');
    await expect(smsAvailable()).resolves.toBe(false);
  });
});
