import { displayNameFor } from './displayName';

describe('displayNameFor', () => {
  it('prefers full_name, then name, then email', () => {
    expect(displayNameFor({ email: 'a@x.com', user_metadata: { full_name: ' Ada Lovelace ', name: 'Ada' } })).toBe(
      'Ada Lovelace',
    );
    expect(displayNameFor({ email: 'a@x.com', user_metadata: { full_name: '  ', name: 'Ada' } })).toBe('Ada');
    expect(displayNameFor({ email: 'a@x.com', user_metadata: { full_name: 42 } })).toBe('a@x.com');
    expect(displayNameFor({ email: 'a@x.com' })).toBe('a@x.com');
  });

  it('falls back when nothing usable is present', () => {
    expect(displayNameFor({})).toBe('your account');
    expect(displayNameFor(null)).toBe('your account');
  });
});
