// Web/default contact picker (spec: docs/specs/2026-11-24-people-and-invites.md, Task 8).
// Jest's jest-expo preset resolves `.native.ts` first on its default (ios) platform, so this test
// imports the default file by its full name.
// No @types/node in this project, so `fs` is typed by hand (same as __tests__/profile.test.tsx).
const fs = jest.requireActual<{ readFileSync(file: string, encoding: 'utf8'): string }>('fs');
const readLib = (name: string): string => fs.readFileSync(`${process.cwd()}/lib/${name}`, 'utf8');

// TypeScript resolves `./contactPicker` to this same default file, so the type matches.
const { contactsSupported, pickContactPhones, sendSms, smsAvailable } =
  jest.requireActual<typeof import('./contactPicker')>('./contactPicker.ts');

describe('contactPicker (web/default)', () => {
  it('has no contacts: unsupported, picker resolves error, no SMS', async () => {
    expect(contactsSupported).toBe(false);
    await expect(pickContactPhones()).resolves.toEqual({ status: 'error' });
    await expect(smsAvailable()).resolves.toBe(false);
    await expect(sendSms('1', 'm')).resolves.toBe('error');
  });

  it('never imports expo-contacts or expo-sms (they must stay out of the web bundle)', () => {
    const source = readLib('contactPicker.ts');
    expect(source).not.toMatch(/['"]expo-(contacts|sms)['"]/);
    // The check can find something: the native file does import both.
    const native = readLib('contactPicker.native.ts');
    expect(native).toMatch(/from ['"]expo-contacts['"]/);
    expect(native).toMatch(/from ['"]expo-sms['"]/);
  });
});
