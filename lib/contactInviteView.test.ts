// Copy for "From contacts" (spec docs/specs/2026-11-24-people-and-invites.md, D6 contacts flow, Task 10).
import { CONTACT_COPY, phoneChoiceA11yLabel, phoneLabelText } from './contactInviteView';

describe('phoneLabelText (PI-C-1)', () => {
  it.each([
    ['mobile', 'Mobile'],
    ['home', 'Home'],
    ['work', 'Work'],
    ['iPhone', 'iPhone'],
    ['main', 'Main'],
    ['other', 'Other'],
    ['pager', 'Pager'],
    ['faxHome', 'Home fax'],
    ['homeFax', 'Home fax'],
    ['faxWork', 'Work fax'],
    ['workFax', 'Work fax'],
    ['faxOther', 'Other fax'],
    ['otherFax', 'Other fax'],
    ['MOBILE', 'Mobile'],
  ])('%s reads "%s"', (raw, shown) => {
    expect(phoneLabelText(raw)).toBe(shown);
  });

  it('keeps a label the person typed themself, as typed', () => {
    expect(phoneLabelText("Mom's cell")).toBe("Mom's cell");
  });

  it('no label is null', () => {
    expect(phoneLabelText(null)).toBeNull();
    expect(phoneLabelText('  ')).toBeNull();
  });
});

describe('phoneChoiceA11yLabel', () => {
  it('reads the label, then the number', () => {
    expect(phoneChoiceA11yLabel({ number: '+1 (415) 555-0100', label: 'mobile' })).toBe('Text Mobile, +1 (415) 555-0100');
  });
  it('without a label reads only the number', () => {
    expect(phoneChoiceA11yLabel({ number: '415 555 0100', label: null })).toBe('Text 415 555 0100');
  });
});

describe('CONTACT_COPY (spec D6)', () => {
  it('uses the spec wording', () => {
    expect(CONTACT_COPY.button).toBe('From contacts');
    expect(CONTACT_COPY.hint).toBe('Pick a contact and text them the link');
    expect(CONTACT_COPY.noPhone).toBe('That contact has no phone number.');
    expect(CONTACT_COPY.whichNumber).toBe('Text which number?');
    expect(CONTACT_COPY.sendWith).toBe('Send with:');
    expect(CONTACT_COPY.error).toBe("Couldn't open your contacts. Use Share… instead.");
    expect(CONTACT_COPY.denied).toBe("SplitIt can't open your contacts. You can allow it in Settings.");
  });
});
