// docs/specs/2026-11-24-people-and-invites.md § L5 (Task 9, criterion 55).
import { INVITE_MESSAGE_PREFIX, inviteMessage, phoneChoices, whatsAppUrl } from './contactInvite';

const URL = 'splitit://b/abc';
const MESSAGE = inviteMessage(URL);
const TEXT = `text=${encodeURIComponent(MESSAGE)}`;

describe('inviteMessage', () => {
  it('is the share text plus the link', () => {
    expect(inviteMessage('')).toBe(INVITE_MESSAGE_PREFIX);
    expect(inviteMessage('splitit://b/abc')).toBe('Claim what you had on SplitIt: splitit://b/abc');
  });
});

describe('whatsAppUrl (W1–W5)', () => {
  it.each<[string, string, string]>([
    ['W1', '+1 (415) 555-0100', `https://wa.me/14155550100?${TEXT}`],
    ['W2', '0044 20 7946 0000', `https://wa.me/442079460000?${TEXT}`],
    ['W3', '(415) 555-0100', `https://wa.me/?${TEXT}`],
    ['W4', '  +44 7700 900123 ', `https://wa.me/447700900123?${TEXT}`],
    ['W5 "+"', '+', `https://wa.me/?${TEXT}`],
    ['W5 empty', '', `https://wa.me/?${TEXT}`],
  ])('%s: %p', (_id, number, expected) => {
    expect(whatsAppUrl(number, MESSAGE)).toBe(expected);
  });

  it('"00" alone, or "+" with no digits after it, opens the chat picker', () => {
    expect(whatsAppUrl('00', MESSAGE)).toBe(`https://wa.me/?${TEXT}`);
    expect(whatsAppUrl(' + - ', MESSAGE)).toBe(`https://wa.me/?${TEXT}`);
  });

  it('a "+" or "00" in the middle of a local number does not make it international', () => {
    expect(whatsAppUrl('415 +555 0100', MESSAGE)).toBe(`https://wa.me/?${TEXT}`);
    expect(whatsAppUrl('4150 0555', MESSAGE)).toBe(`https://wa.me/?${TEXT}`);
  });

  it('text= is encodeURIComponent of the message (spaces, colon and slashes escaped)', () => {
    const url = whatsAppUrl('+14155550100', MESSAGE);
    expect(url).toBe(`https://wa.me/14155550100?text=${encodeURIComponent(MESSAGE)}`);
    expect(url).toContain('Claim%20what%20you%20had%20on%20SplitIt%3A%20splitit%3A%2F%2Fb%2Fabc');
    expect(decodeURIComponent(url.split('text=')[1] ?? '')).toBe(MESSAGE);
  });

  it('escapes characters that would break out of the query string', () => {
    const url = whatsAppUrl('+1 415', 'a&b=c#d?e');
    expect(url).toBe('https://wa.me/1415?text=a%26b%3Dc%23d%3Fe');
  });
});

describe('phoneChoices (L5)', () => {
  it('drops a digit-less entry, de-duplicates by digits (first wins) and keeps order and labels', () => {
    expect(
      phoneChoices([
        { number: '+1 415 555 0100', label: 'mobile' },
        { number: 'n/a', label: 'work' },
        { number: '(415) 555-0199', label: 'home' },
        { number: '+14155550100', label: 'iPhone' },
      ]),
    ).toEqual([
      { number: '+1 415 555 0100', label: 'mobile' },
      { number: '(415) 555-0199', label: 'home' },
    ]);
  });

  it('keeps the number exactly as the contact has it', () => {
    expect(phoneChoices([{ number: '  +44 7700 900123 ', label: null }])).toEqual([
      { number: '  +44 7700 900123 ', label: null },
    ]);
  });

  it('a missing or blank label becomes null; a label is trimmed', () => {
    expect(
      phoneChoices([
        { number: '111', label: null },
        { number: '222', label: '   ' },
        { number: '333', label: ' mobile ' },
        { number: '444' },
      ]),
    ).toEqual([
      { number: '111', label: null },
      { number: '222', label: null },
      { number: '333', label: 'mobile' },
      { number: '444', label: null },
    ]);
  });

  it('a local and an international form of one number are different choices (different digits)', () => {
    expect(phoneChoices([{ number: '(415) 555-0100', label: null }, { number: '+1 415 555 0100', label: null }])).toHaveLength(2);
  });

  it('returns only number and label, never other fields the picker might carry', () => {
    const input = [{ number: '111', label: 'mobile', name: 'Sam Lee', id: 'c1' }];
    const [only] = phoneChoices(input);
    expect(Object.keys(only ?? {}).sort()).toEqual(['label', 'number']);
  });

  it('an empty list, or only digit-less entries, gives no choices', () => {
    expect(phoneChoices([])).toEqual([]);
    expect(phoneChoices([{ number: '', label: 'home' }, { number: '+', label: null }])).toEqual([]);
  });
});
