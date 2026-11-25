// Contact picker + SMS composer: the web and default build, and the shared types.
// Spec: docs/specs/2026-11-24-people-and-invites.md, Task 8.
//
// Metro and Jest resolve `contactPicker.native.ts` on iOS/Android; web and TypeScript use this
// file. It must never import `expo-contacts` or `expo-sms`, so neither reaches the web bundle
// (criterion 54). The screen hides "From contacts" when `contactsSupported` is false.
//
// Privacy: only phone numbers and their labels ever leave the native module. No names, ids,
// photos or other contact fields, and nothing is stored.

import type { PhoneChoice } from './contactInvite';

/** One number from the picked contact, as the contact has it. Same shape `phoneChoices` takes. */
export type PickedPhone = PhoneChoice;

export type PickContactResult =
  | { status: 'picked'; phones: PickedPhone[] }
  | { status: 'cancelled' }
  | { status: 'denied' }
  | { status: 'error' };

export type SendSmsResult = 'done' | 'error';

/** What the contacts flow needs. Every function resolves; none throws. Inject a fake in tests. */
export type ContactPicker = {
  /** Opens the system contact picker and returns the chosen contact's numbers. */
  pickContactPhones(): Promise<PickContactResult>;
  /** Whether this device can open the SMS composer (false on the iOS simulator and on web). */
  smsAvailable(): Promise<boolean>;
  /** Opens the composer with the number and message filled in. Sent, cancelled or unknown are all 'done'. */
  sendSms(number: string, message: string): Promise<SendSmsResult>;
};

export const contactsSupported: boolean = false;

export async function pickContactPhones(): Promise<PickContactResult> {
  return { status: 'error' };
}

export async function smsAvailable(): Promise<boolean> {
  return false;
}

export async function sendSms(_number: string, _message: string): Promise<SendSmsResult> {
  return 'error';
}
