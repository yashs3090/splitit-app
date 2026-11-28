// Delete group criterion 38: Home's one-shot "<name> was deleted." notice, keyed to the account.
import { clearGroupDeletedNotice, setGroupDeletedNotice, takeGroupDeletedNotice } from './groupDeletedNotice';

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';

afterEach(() => clearGroupDeletedNotice());

describe('groupDeletedNotice', () => {
  it('take returns the notice once, then null', () => {
    setGroupDeletedNotice({ name: 'Tahoe trip', userId: ME });
    expect(takeGroupDeletedNotice(ME)).toEqual({ name: 'Tahoe trip' });
    expect(takeGroupDeletedNotice(ME)).toBeNull();
  });

  it('a take for another user returns null and does not consume it', () => {
    setGroupDeletedNotice({ name: 'Tahoe trip', userId: ME });
    expect(takeGroupDeletedNotice(OTHER)).toBeNull();
    expect(takeGroupDeletedNotice(ME)).toEqual({ name: 'Tahoe trip' });
  });

  it('a second set replaces the first', () => {
    setGroupDeletedNotice({ name: 'Tahoe trip', userId: ME });
    setGroupDeletedNotice({ name: 'Ski weekend', userId: ME });
    expect(takeGroupDeletedNotice(ME)).toEqual({ name: 'Ski weekend' });
    expect(takeGroupDeletedNotice(ME)).toBeNull();
  });

  it('a set by another account replaces it, so the first account never sees it', () => {
    setGroupDeletedNotice({ name: 'Tahoe trip', userId: ME });
    setGroupDeletedNotice({ name: 'Ski weekend', userId: OTHER });
    expect(takeGroupDeletedNotice(ME)).toBeNull();
    expect(takeGroupDeletedNotice(OTHER)).toEqual({ name: 'Ski weekend' });
  });

  it('nothing set: null; a null user (signed out) never takes one', () => {
    expect(takeGroupDeletedNotice(ME)).toBeNull();
    setGroupDeletedNotice({ name: 'Tahoe trip', userId: ME });
    expect(takeGroupDeletedNotice(null)).toBeNull();
    expect(takeGroupDeletedNotice(ME)).toEqual({ name: 'Tahoe trip' });
  });

  it('clear drops it (e.g. on sign-out)', () => {
    setGroupDeletedNotice({ name: 'Tahoe trip', userId: ME });
    clearGroupDeletedNotice();
    expect(takeGroupDeletedNotice(ME)).toBeNull();
  });
});
