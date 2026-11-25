// Native contact picker + SMS wrapper (spec: docs/specs/2026-11-24-people-and-invites.md, Task 8,
// criterion 52). The native modules are faked: no device needed.
jest.mock('expo-contacts', () => ({
  Contact: { presentPicker: jest.fn() },
  requestPermissionsAsync: jest.fn(),
}));
jest.mock('expo-sms', () => ({
  isAvailableAsync: jest.fn(),
  sendSMSAsync: jest.fn(),
}));

import {
  contactsSupported,
  createContactPicker,
  pickContactPhones,
  sendSms,
  smsAvailable,
  type NativeContacts,
  type NativeSms,
} from './contactPicker.native';

// Taken with requireMock, not imported, so criterion 53's grep matches only the native file.
const contactsMock = jest.requireMock<{
  Contact: { presentPicker: jest.Mock };
  requestPermissionsAsync: jest.Mock;
}>('expo-contacts');
const smsMock = jest.requireMock<{ isAvailableAsync: jest.Mock; sendSMSAsync: jest.Mock }>('expo-sms');
const presentPicker = contactsMock.Contact.presentPicker;
const requestPermission = contactsMock.requestPermissionsAsync;
const smsIsAvailable = smsMock.isAvailableAsync;
const smsSend = smsMock.sendSMSAsync;

type Perm = { granted: boolean; canAskAgain?: boolean; accessPrivileges?: 'all' | 'limited' | 'none' };

/** A picked contact as `Contact.presentPicker()` gives it: a native object with many more fields. */
function pickedContact(phones: unknown[] | Error) {
  return {
    id: 'contact-123',
    getPhones: jest.fn(() => (phones instanceof Error ? Promise.reject(phones) : Promise.resolve(phones))),
    getDetails: jest.fn(),
    getGivenName: jest.fn(() => Promise.resolve('Sam')),
  };
}

function fakes(perm: Perm = { granted: true, accessPrivileges: 'all' }) {
  const contacts: NativeContacts & { presentPicker: jest.Mock; requestPermissionsAsync: jest.Mock } = {
    requestPermissionsAsync: jest.fn(() => Promise.resolve({ canAskAgain: true, ...perm })),
    presentPicker: jest.fn(),
  };
  const sms: NativeSms & { isAvailableAsync: jest.Mock; sendSMSAsync: jest.Mock } = {
    isAvailableAsync: jest.fn(() => Promise.resolve(true)),
    sendSMSAsync: jest.fn(() => Promise.resolve({ result: 'sent' })),
  };
  return { contacts, sms, picker: createContactPicker(contacts, sms) };
}

beforeEach(() => jest.clearAllMocks());

describe('pickContactPhones', () => {
  it('picked, two numbers: only number and label per phone (no name, id or other keys)', async () => {
    const { contacts, picker } = fakes();
    const contact = pickedContact([
      { id: 'p1', number: '+1 415 555 0100', label: 'mobile' },
      { id: 'p2', number: '(415) 555-0199', label: 'home', extra: 'x' },
    ]);
    contacts.presentPicker.mockResolvedValue(contact);

    const result = await picker.pickContactPhones();

    expect(result).toEqual({
      status: 'picked',
      phones: [
        { number: '+1 415 555 0100', label: 'mobile' },
        { number: '(415) 555-0199', label: 'home' },
      ],
    });
    if (result.status !== 'picked') throw new Error('expected picked');
    expect(Object.keys(result)).toEqual(['status', 'phones']);
    for (const phone of result.phones) expect(Object.keys(phone).sort()).toEqual(['label', 'number']);
    expect(JSON.stringify(result)).not.toMatch(/contact-123|p1|p2|Sam/);
    expect(contact.getDetails).not.toHaveBeenCalled();
    expect(contact.getGivenName).not.toHaveBeenCalled();
  });

  it('asks for permission before opening the picker (both platforms need it to read the numbers)', async () => {
    const { contacts, picker } = fakes();
    const order: string[] = [];
    contacts.requestPermissionsAsync.mockImplementation(async () => {
      order.push('permission');
      return { granted: true, canAskAgain: true, accessPrivileges: 'all' };
    });
    contacts.presentPicker.mockImplementation(async () => {
      order.push('picker');
      return null;
    });
    await picker.pickContactPhones();
    expect(order).toEqual(['permission', 'picker']);
  });

  it('a missing or blank label becomes null; an unmapped iOS system label is unwrapped', async () => {
    const { contacts, picker } = fakes();
    contacts.presentPicker.mockResolvedValue(
      pickedContact([
        { id: 'a', number: '1' },
        { id: 'b', number: '2', label: '  ' },
        { id: 'c', number: '3', label: '_$!<FutureLabel>!$_' },
      ]),
    );
    await expect(picker.pickContactPhones()).resolves.toEqual({
      status: 'picked',
      phones: [
        { number: '1', label: null },
        { number: '2', label: null },
        { number: '3', label: 'FutureLabel' },
      ],
    });
  });

  it('no phone numbers: picked with an empty list (the screen says so)', async () => {
    const { contacts, picker } = fakes();
    contacts.presentPicker.mockResolvedValue(pickedContact([]));
    await expect(picker.pickContactPhones()).resolves.toEqual({ status: 'picked', phones: [] });
  });

  it('entries without a number string are dropped', async () => {
    const { contacts, picker } = fakes();
    contacts.presentPicker.mockResolvedValue(
      pickedContact([{ id: 'a', label: 'mobile' }, { id: 'b', number: 42 }, null, { id: 'c', number: '5' }]),
    );
    await expect(picker.pickContactPhones()).resolves.toEqual({
      status: 'picked',
      phones: [{ number: '5', label: null }],
    });
  });

  it('getPhones resolving something that is not a list is an error', async () => {
    const { contacts, picker } = fakes();
    contacts.presentPicker.mockResolvedValue({ getPhones: () => Promise.resolve('nope') });
    await expect(picker.pickContactPhones()).resolves.toEqual({ status: 'error' });
  });

  it('cancelled picker: cancelled', async () => {
    const { contacts, picker } = fakes();
    contacts.presentPicker.mockResolvedValue(null);
    await expect(picker.pickContactPhones()).resolves.toEqual({ status: 'cancelled' });
  });

  it('the picker throws: error, never a rejection', async () => {
    const { contacts, picker } = fakes();
    contacts.presentPicker.mockRejectedValue(new Error('ERR_CONTACT_PICKING_IN_PROGRESS'));
    await expect(picker.pickContactPhones()).resolves.toEqual({ status: 'error' });
  });

  it('reading the numbers throws with full access: error', async () => {
    const { contacts, picker } = fakes({ granted: true, accessPrivileges: 'all' });
    contacts.presentPicker.mockResolvedValue(pickedContact(new Error('ContactNotFound')));
    await expect(picker.pickContactPhones()).resolves.toEqual({ status: 'error' });
  });

  it('reading the numbers throws with iOS limited access: denied (the contact is outside the shared set)', async () => {
    const { contacts, picker } = fakes({ granted: true, accessPrivileges: 'limited' });
    contacts.presentPicker.mockResolvedValue(pickedContact(new Error('ContactNotFound')));
    await expect(picker.pickContactPhones()).resolves.toEqual({ status: 'denied' });
  });

  it('limited access that can read the picked contact still works', async () => {
    const { contacts, picker } = fakes({ granted: true, accessPrivileges: 'limited' });
    contacts.presentPicker.mockResolvedValue(pickedContact([{ id: 'a', number: '7', label: 'mobile' }]));
    await expect(picker.pickContactPhones()).resolves.toEqual({
      status: 'picked',
      phones: [{ number: '7', label: 'mobile' }],
    });
  });

  it.each([
    ['denied, can ask again', { granted: false, canAskAgain: true }],
    ['denied for good', { granted: false, canAskAgain: false }],
  ])('permission %s: denied, picker never opened', async (_name, perm) => {
    const { contacts, picker } = fakes(perm);
    await expect(picker.pickContactPhones()).resolves.toEqual({ status: 'denied' });
    expect(contacts.presentPicker).not.toHaveBeenCalled();
  });

  it('the permission request throws: error, picker never opened', async () => {
    const { contacts, picker } = fakes();
    contacts.requestPermissionsAsync.mockRejectedValue(new Error('E_PERMISSIONS'));
    await expect(picker.pickContactPhones()).resolves.toEqual({ status: 'error' });
    expect(contacts.presentPicker).not.toHaveBeenCalled();
  });
});

describe('smsAvailable', () => {
  it('passes the module answer through', async () => {
    const { sms, picker } = fakes();
    sms.isAvailableAsync.mockResolvedValue(false);
    await expect(picker.smsAvailable()).resolves.toBe(false);
    sms.isAvailableAsync.mockResolvedValue(true);
    await expect(picker.smsAvailable()).resolves.toBe(true);
  });

  it('a throw or a non-boolean is false', async () => {
    const { sms, picker } = fakes();
    sms.isAvailableAsync.mockRejectedValue(new Error('x'));
    await expect(picker.smsAvailable()).resolves.toBe(false);
    sms.isAvailableAsync.mockResolvedValue('yes');
    await expect(picker.smsAvailable()).resolves.toBe(false);
  });
});

describe('sendSms', () => {
  it('passes [number] and the message unchanged; any composer result is done', async () => {
    const { sms, picker } = fakes();
    const message = 'Claim what you had on SplitIt: splitit://b/abc';
    for (const result of ['sent', 'cancelled', 'unknown']) {
      sms.sendSMSAsync.mockResolvedValueOnce({ result });
      await expect(picker.sendSms('+1 415 555 0100', message)).resolves.toBe('done');
    }
    expect(sms.sendSMSAsync).toHaveBeenCalledTimes(3);
    for (const call of sms.sendSMSAsync.mock.calls) expect(call).toEqual([['+1 415 555 0100'], message]);
  });

  it('a throw is error', async () => {
    const { sms, picker } = fakes();
    sms.sendSMSAsync.mockRejectedValue(new Error('no composer'));
    await expect(picker.sendSms('1', 'm')).resolves.toBe('error');
  });
});

describe('default exports are wired to expo-contacts and expo-sms', () => {
  it('contactsSupported is true on native', () => {
    expect(contactsSupported).toBe(true);
  });

  it('pickContactPhones uses requestPermissionsAsync and Contact.presentPicker', async () => {
    requestPermission.mockResolvedValue({ granted: true, canAskAgain: true, accessPrivileges: 'all' });
    presentPicker.mockResolvedValue(pickedContact([{ id: 'a', number: '9', label: 'iPhone' }]));
    await expect(pickContactPhones()).resolves.toEqual({
      status: 'picked',
      phones: [{ number: '9', label: 'iPhone' }],
    });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(presentPicker).toHaveBeenCalledTimes(1);
  });

  it('smsAvailable and sendSms use expo-sms', async () => {
    smsIsAvailable.mockResolvedValue(true);
    smsSend.mockResolvedValue({ result: 'sent' });
    await expect(smsAvailable()).resolves.toBe(true);
    await expect(sendSms('5', 'hi')).resolves.toBe('done');
    expect(smsSend).toHaveBeenCalledWith(['5'], 'hi');
  });
});
