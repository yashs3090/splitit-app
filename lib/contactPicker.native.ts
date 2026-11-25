// Contact picker + SMS composer on iOS/Android (spec: docs/specs/2026-11-24-people-and-invites.md,
// Task 8). The only file in the app that imports `expo-contacts` or `expo-sms` (criterion 53).
//
// Permission (verified in node_modules/expo-contacts 57.0.9; see docs/decisions-to-review.md):
// `Contact.presentPicker()` itself needs none, but it returns only the contact's id, and reading
// its numbers with `getPhones()` goes through the contacts store (iOS `CNContactStore`, Android
// `ContactsContract.Data`), which does. So we ask at the moment "From contacts" is tapped, never
// at launch, and only for reading: WRITE_CONTACTS is blocked in app.json.
//
// Privacy: only `number` and `label` leave this module. The contact's name, id and every other
// field stay in the native object, which we drop as soon as the numbers are read.

import { Contact, requestPermissionsAsync } from 'expo-contacts';
import { isAvailableAsync, sendSMSAsync } from 'expo-sms';

import type { ContactPicker, PickContactResult, PickedPhone, SendSmsResult } from './contactPicker';

export type { ContactPicker, PickContactResult, PickedPhone, SendSmsResult } from './contactPicker';

/** The parts of `expo-contacts` we use, so tests can pass a fake. */
export type NativeContacts = {
  requestPermissionsAsync(): Promise<{
    granted: boolean;
    canAskAgain: boolean;
    accessPrivileges?: 'all' | 'limited' | 'none';
  }>;
  presentPicker(): Promise<{ getPhones(): Promise<unknown> } | null>;
};

/** The parts of `expo-sms` we use. */
export type NativeSms = {
  isAvailableAsync(): Promise<unknown>;
  sendSMSAsync(addresses: string[], message: string): Promise<unknown>;
};

export const contactsSupported: boolean = true;

// iOS hands back system labels it has no name for as "_$!<Name>!$_" (ContactLabelMapper.swift).
const IOS_SYSTEM_LABEL = /^_\$!<(.+)>!\$_$/;

function cleanLabel(label: unknown): string | null {
  if (typeof label !== 'string') return null;
  const trimmed = label.trim();
  if (trimmed === '') return null;
  return IOS_SYSTEM_LABEL.exec(trimmed)?.[1] ?? trimmed;
}

/** Copies only `number` and `label` out of whatever the module returned. */
function toPhones(raw: unknown): PickedPhone[] | null {
  if (!Array.isArray(raw)) return null;
  const phones: PickedPhone[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { number, label } = entry as { number?: unknown; label?: unknown };
    if (typeof number !== 'string') continue;
    phones.push({ number, label: cleanLabel(label) });
  }
  return phones;
}

export function createContactPicker(contacts: NativeContacts, sms: NativeSms): ContactPicker {
  async function pickContactPhones(): Promise<PickContactResult> {
    let limited: boolean;
    try {
      const permission = await contacts.requestPermissionsAsync();
      if (!permission.granted) return { status: 'denied' };
      limited = permission.accessPrivileges === 'limited';
    } catch {
      return { status: 'error' };
    }

    let picked: Awaited<ReturnType<NativeContacts['presentPicker']>>;
    try {
      picked = await contacts.presentPicker();
    } catch {
      return { status: 'error' };
    }
    if (picked === null || picked === undefined) return { status: 'cancelled' };

    try {
      const phones = toPhones(await picked.getPhones());
      return phones === null ? { status: 'error' } : { status: 'picked', phones };
    } catch {
      // With iOS 18 "limited" access, a contact outside the shared set can be picked but not read.
      // The fix is in Settings, so say so instead of a generic error.
      return limited ? { status: 'denied' } : { status: 'error' };
    }
  }

  async function smsAvailable(): Promise<boolean> {
    try {
      return (await sms.isAvailableAsync()) === true;
    } catch {
      return false;
    }
  }

  async function sendSms(number: string, message: string): Promise<SendSmsResult> {
    try {
      await sms.sendSMSAsync([number], message);
      return 'done';
    } catch {
      return 'error';
    }
  }

  return { pickContactPhones, smsAvailable, sendSms };
}

const picker = createContactPicker(
  {
    requestPermissionsAsync: () => requestPermissionsAsync(),
    presentPicker: () => Contact.presentPicker(),
  },
  { isAvailableAsync: () => isAvailableAsync(), sendSMSAsync: (to, message) => sendSMSAsync(to, message) },
);

export const { pickContactPhones, smsAvailable, sendSms } = picker;
