import { readSupabaseEnv, readWebUrl } from './env';

// Builds an unsigned JWT-shaped string with the given payload (signature is irrelevant here).
function fakeJwt(payload: Record<string, unknown>): string {
  // Payloads here are ASCII, so btoa is safe.
  const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.sig`;
}

const LOCAL_URL = 'http://127.0.0.1:54321';
const ANON_JWT = fakeJwt({ iss: 'supabase-demo', role: 'anon', exp: 1983812996 });

describe('readSupabaseEnv', () => {
  it('accepts a local URL with an anon-role JWT', () => {
    expect(readSupabaseEnv({ url: LOCAL_URL, key: ANON_JWT })).toEqual({ url: LOCAL_URL, key: ANON_JWT });
  });

  it('accepts an sb_publishable_ key and an https URL', () => {
    const env = readSupabaseEnv({ url: 'https://abc.supabase.co', key: 'sb_publishable_abc123' });
    expect(env).toEqual({ url: 'https://abc.supabase.co', key: 'sb_publishable_abc123' });
  });

  it('trims surrounding whitespace', () => {
    expect(readSupabaseEnv({ url: ` ${LOCAL_URL} `, key: ' sb_publishable_x\n' })).toEqual({
      url: LOCAL_URL,
      key: 'sb_publishable_x',
    });
  });

  it.each([undefined, '', '   '])('throws naming EXPO_PUBLIC_SUPABASE_URL when the URL is %p', (url) => {
    expect(() => readSupabaseEnv({ url, key: ANON_JWT })).toThrow(/EXPO_PUBLIC_SUPABASE_URL/);
  });

  it.each([undefined, '', '   '])('throws naming EXPO_PUBLIC_SUPABASE_ANON_KEY when the key is %p', (key) => {
    expect(() => readSupabaseEnv({ url: LOCAL_URL, key })).toThrow(/EXPO_PUBLIC_SUPABASE_ANON_KEY/);
  });

  it('throws for an sb_secret_ key', () => {
    expect(() => readSupabaseEnv({ url: LOCAL_URL, key: 'sb_secret_abc123' })).toThrow(/secret/i);
  });

  it('throws for a JWT whose payload role is service_role', () => {
    const key = fakeJwt({ iss: 'supabase-demo', role: 'service_role', exp: 1983812996 });
    expect(() => readSupabaseEnv({ url: LOCAL_URL, key })).toThrow(/service-role/);
  });

  it.each(['ftp://127.0.0.1:54321', 'javascript:alert(1)', '127.0.0.1:54321', 'not a url', 'file:///etc/passwd'])(
    'throws for the non-http(s) URL %p',
    (url) => {
      expect(() => readSupabaseEnv({ url, key: ANON_JWT })).toThrow(/EXPO_PUBLIC_SUPABASE_URL/);
    },
  );

  it('does not include the key value in error messages', () => {
    const key = 'sb_secret_supersecretvalue';
    expect(() => readSupabaseEnv({ url: LOCAL_URL, key })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('supersecretvalue') }),
    );
  });
});

describe('readWebUrl (EXPO_PUBLIC_WEB_URL, the public web origin for share links)', () => {
  it.each([undefined, '', '   ', '\n'])('returns null when unset or blank (%p): links keep the dev behaviour', (value) => {
    expect(readWebUrl(value)).toBeNull();
  });

  it.each([
    ['a bare https origin', 'https://splitit-xyz.vercel.app', 'https://splitit-xyz.vercel.app'],
    ['one trailing slash', 'https://splitit-xyz.vercel.app/', 'https://splitit-xyz.vercel.app'],
    ['several trailing slashes', 'https://splitit-xyz.vercel.app//', 'https://splitit-xyz.vercel.app'],
    ['surrounding whitespace', '  https://splitit-xyz.vercel.app/ \n', 'https://splitit-xyz.vercel.app'],
    ['upper case scheme and host (lowercased)', 'HTTPS://SplitIt-XYZ.Vercel.App', 'https://splitit-xyz.vercel.app'],
    ['a port', 'https://splitit.example:8443', 'https://splitit.example:8443'],
    ['a single-label host', 'https://localhost', 'https://localhost'],
  ])('accepts %s', (_label, value, expected) => {
    expect(readWebUrl(value)).toBe(expected);
  });

  it.each([
    ['http (not https)', 'http://splitit-xyz.vercel.app'],
    ['the native scheme', 'splitit://b'],
    ['no scheme', 'splitit-xyz.vercel.app'],
    ['protocol-relative', '//splitit-xyz.vercel.app'],
    ['javascript:', 'javascript:alert(1)'],
    ['no host', 'https://'],
    ['a path', 'https://splitit-xyz.vercel.app/app'],
    ['a path with trailing slash', 'https://splitit-xyz.vercel.app/app/'],
    ['a query', 'https://splitit-xyz.vercel.app?x=1'],
    ['a query after a slash', 'https://splitit-xyz.vercel.app/?x=1'],
    ['a hash', 'https://splitit-xyz.vercel.app#top'],
    ['credentials', 'https://user:pass@splitit-xyz.vercel.app'],
    ['a space inside', 'https://splitit xyz.vercel.app'],
    ['an empty label', 'https://splitit..vercel.app'],
    ['a label starting with a hyphen', 'https://-splitit.vercel.app'],
    ['an empty port', 'https://splitit.example:'],
    ['a port out of range', 'https://splitit.example:70000'],
    ['a backslash', 'https://splitit.example\\evil.com'],
  ])('refuses %s with an error naming EXPO_PUBLIC_WEB_URL', (_label, value) => {
    expect(() => readWebUrl(value)).toThrow(/EXPO_PUBLIC_WEB_URL/);
  });

  it('says what a good value looks like', () => {
    expect(() => readWebUrl('http://x.example')).toThrow(/https origin with no path, query or hash, e.g. https:\/\/splitit-xyz\.vercel\.app/);
  });
});
