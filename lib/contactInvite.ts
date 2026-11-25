// The words and links for inviting someone by text or WhatsApp. Pure: no contacts access, no I/O.
// Spec: docs/specs/2026-11-24-people-and-invites.md § L5 (Task 9).
//
// Privacy: nothing here takes or returns a contact's name. The message is the share text plus the
// link only, never a name, number, item or amount.

/** The share text. "Share…" and "From contacts" send the same words (PI-15). */
export const INVITE_MESSAGE_PREFIX = 'Claim what you had on SplitIt: ';

export type PhoneChoice = { number: string; label: string | null };

export function inviteMessage(url: string): string {
  return INVITE_MESSAGE_PREFIX + url;
}

const digitsOf = (s: string): string => s.replace(/[^0-9]/g, '');

/**
 * WhatsApp's click-to-chat link (https://whatsapp.com/faq/en/general/26000030). An international
 * number (starting with "+", or "00", which is dropped) opens that chat; anything else opens
 * WhatsApp's chat picker with the text filled in. We never guess a country code (PI-14).
 */
export function whatsAppUrl(number: string, message: string): string {
  const text = `text=${encodeURIComponent(message)}`;
  const trimmed = number.trim();
  let international: string | null = null;
  if (trimmed.startsWith('+')) international = trimmed.slice(1);
  else if (trimmed.startsWith('00')) international = trimmed.slice(2);
  const digits = international === null ? '' : digitsOf(international);
  return digits === '' ? `https://wa.me/?${text}` : `https://wa.me/${digits}?${text}`;
}

/**
 * The numbers to offer for one contact: entries with no digits dropped, repeats (same digits)
 * dropped with the first kept, order kept. The number stays exactly as the contact has it; a blank
 * label becomes null. Only `number` and `label` come out, whatever else the input carries.
 */
export function phoneChoices(phones: readonly { number: string; label?: string | null }[]): PhoneChoice[] {
  const seen = new Set<string>();
  const out: PhoneChoice[] = [];
  for (const { number, label } of phones) {
    const digits = digitsOf(number);
    if (digits === '' || seen.has(digits)) continue;
    seen.add(digits);
    const trimmedLabel = label?.trim() ?? '';
    out.push({ number, label: trimmedLabel === '' ? null : trimmedLabel });
  }
  return out;
}
