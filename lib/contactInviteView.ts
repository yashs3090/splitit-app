// Copy for "From contacts" in the Invite card. Pure.
// Spec: docs/specs/2026-11-24-people-and-invites.md (D6 contacts flow, Task 10).
//
// Privacy: nothing here takes or returns a contact's name; only a number and its label.
import type { PhoneChoice } from './contactInvite';

export const CONTACT_COPY = {
  button: 'From contacts',
  hint: 'Pick a contact and text them the link',
  noPhone: 'That contact has no phone number.',
  whichNumber: 'Text which number?',
  sendWith: 'Send with:',
  messages: 'Messages',
  messagesHint: 'Opens a text with the bill link filled in',
  whatsApp: 'WhatsApp',
  whatsAppHint: 'Opens WhatsApp with the bill link filled in',
  cancel: 'Cancel',
  error: "Couldn't open your contacts. Use Share… instead.",
  denied: "SplitIt can't open your contacts. You can allow it in Settings.",
  whatsAppError: "Couldn't open WhatsApp. Use Share… instead.",
} as const;

// The label keys expo-contacts passes through (Task 8, PI-N-4), as they read on screen. Keys are
// compared ignoring case; anything else is a label the person typed and is shown as typed.
const LABELS: Readonly<Record<string, string>> = {
  mobile: 'Mobile',
  home: 'Home',
  work: 'Work',
  iphone: 'iPhone',
  main: 'Main',
  other: 'Other',
  pager: 'Pager',
  faxhome: 'Home fax',
  homefax: 'Home fax',
  faxwork: 'Work fax',
  workfax: 'Work fax',
  faxother: 'Other fax',
  otherfax: 'Other fax',
};

/** "mobile" → "Mobile", "faxHome" → "Home fax"; a custom label as typed; none → null. */
export function phoneLabelText(label: string | null): string | null {
  const trimmed = label?.trim() ?? '';
  if (trimmed === '') return null;
  return LABELS[trimmed.toLowerCase()] ?? trimmed;
}

/** "Text Mobile, +1 (415) 555-0100" for a number button. */
export function phoneChoiceA11yLabel(choice: PhoneChoice): string {
  const label = phoneLabelText(choice.label);
  return label === null ? `Text ${choice.number}` : `Text ${label}, ${choice.number}`;
}
