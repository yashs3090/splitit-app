import {
  describeAuthError,
  describeOAuthCallbackError,
  exchangeCodeOnce,
  parseOAuthCallback,
  signInWithGoogleNative,
  signInWithGoogleWeb,
  type OAuthAuthClient,
} from './oauth';

describe('parseOAuthCallback', () => {
  it('extracts the PKCE code from a native callback URL', () => {
    expect(parseOAuthCallback('splitit://auth/callback?code=34e770dd-9ff9-416c')).toEqual({
      kind: 'code',
      code: '34e770dd-9ff9-416c',
    });
  });

  it('extracts the code from an Expo Go / web callback URL with other params', () => {
    expect(parseOAuthCallback('exp://192.168.1.5:8081/--/auth/callback?foo=1&code=abc123#')).toEqual({
      kind: 'code',
      code: 'abc123',
    });
    expect(parseOAuthCallback('http://localhost:8081/?code=xyz')).toEqual({ kind: 'code', code: 'xyz' });
  });

  it('decodes percent-encoded values', () => {
    expect(parseOAuthCallback('splitit://auth/callback?code=a%2Bb')).toEqual({ kind: 'code', code: 'a+b' });
  });

  it('returns an error for error / error_description in the query', () => {
    expect(
      parseOAuthCallback(
        'splitit://auth/callback?error=access_denied&error_code=403&error_description=User+denied+access',
      ),
    ).toEqual({ kind: 'error', error: 'access_denied', description: 'User denied access' });
  });

  it('returns an error for error params in the fragment', () => {
    expect(parseOAuthCallback('http://localhost:8081/#error=server_error&error_description=Oops%21')).toEqual({
      kind: 'error',
      error: 'server_error',
      description: 'Oops!',
    });
  });

  it('prefers the error over a code if both are present', () => {
    expect(parseOAuthCallback('splitit://auth/callback?code=abc&error=access_denied')).toMatchObject({
      kind: 'error',
      error: 'access_denied',
    });
  });

  it('handles an error with no description', () => {
    expect(parseOAuthCallback('splitit://auth/callback?error=access_denied')).toEqual({
      kind: 'error',
      error: 'access_denied',
      description: null,
    });
  });

  it.each([
    'splitit://b/abcdefghij12',
    'http://localhost:8081/',
    'http://localhost:8081/?foo=bar#baz',
    'splitit://auth/callback',
    'splitit://auth/callback?code=',
    'not a url at all',
    '',
  ])('returns null for the unrelated URL %p', (url) => {
    expect(parseOAuthCallback(url)).toBeNull();
  });

  it('does not throw on malformed percent-encoding', () => {
    expect(() => parseOAuthCallback('splitit://auth/callback?code=%E0%A4%A')).not.toThrow();
    expect(parseOAuthCallback('splitit://auth/callback?code=%E0%A4%A')).toBeNull();
  });
});

describe('describeOAuthCallbackError', () => {
  it('treats access_denied as a cancellation', () => {
    expect(describeOAuthCallbackError('access_denied')).toBe('Sign-in was cancelled.');
  });

  it.each(['server_error', 'temporarily_unavailable', 'invalid_request'])('shows the allow-listed code %s', (code) => {
    expect(describeOAuthCallbackError(code)).toBe(`Google sign-in failed (${code}). Please try again.`);
  });

  it.each(['call_555_0100_for_help', 'your_account_is_locked', 'unauthorized_client', '<script>', ''])(
    'shows the generic message for the unlisted code %p',
    (code) => {
      expect(describeOAuthCallbackError(code)).toBe('Google sign-in failed. Please try again.');
    },
  );
});

describe('describeAuthError', () => {
  it('maps a disabled provider', () => {
    expect(describeAuthError({ name: 'AuthApiError', message: 'Unsupported provider: provider is not enabled' })).toMatch(
      /isn't set up/i,
    );
  });

  it('maps network failures', () => {
    expect(describeAuthError({ name: 'AuthRetryableFetchError', message: 'Failed to fetch' })).toMatch(
      /couldn't reach/i,
    );
    expect(describeAuthError(new TypeError('Network request failed'))).toMatch(/couldn't reach/i);
  });

  it('maps a missing PKCE verifier / bad flow state', () => {
    expect(describeAuthError({ name: 'AuthPKCECodeVerifierMissingError', message: 'PKCE code verifier not found' })).toMatch(
      /try again/i,
    );
  });

  it('falls back to a generic message for anything else', () => {
    expect(describeAuthError('weird')).toBe('Sign-in failed. Please try again.');
    expect(describeAuthError(undefined)).toBe('Sign-in failed. Please try again.');
  });
});

type Calls = { signIn: unknown[]; exchange: string[] };

function fakeAuth(
  overrides: Partial<{
    signInWithOAuth: OAuthAuthClient['signInWithOAuth'];
    exchangeCodeForSession: OAuthAuthClient['exchangeCodeForSession'];
  }> = {},
): { auth: OAuthAuthClient; calls: Calls } {
  const calls: Calls = { signIn: [], exchange: [] };
  const auth = {
    signInWithOAuth: async (credentials: unknown) => {
      calls.signIn.push(credentials);
      return { data: { provider: 'google', url: 'https://supabase.local/auth/v1/authorize?provider=google' }, error: null };
    },
    exchangeCodeForSession: async (code: string) => {
      calls.exchange.push(code);
      return { data: { session: {}, user: {} }, error: null };
    },
    ...overrides,
  } as unknown as OAuthAuthClient; // Test double: only the two methods we use are implemented.
  return { auth, calls };
}

describe('signInWithGoogleWeb', () => {
  it('starts the Google OAuth redirect back to the app origin', async () => {
    const { auth, calls } = fakeAuth();
    await expect(signInWithGoogleWeb(auth, 'http://localhost:8081')).resolves.toEqual({ status: 'redirecting' });
    expect(calls.signIn).toEqual([{ provider: 'google', options: { redirectTo: 'http://localhost:8081/' } }]);
  });

  it('returns a friendly error when the provider call fails', async () => {
    const { auth } = fakeAuth({
      signInWithOAuth: (async () => ({
        data: { provider: 'google', url: null },
        error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch' },
      })) as unknown as OAuthAuthClient['signInWithOAuth'],
    });
    await expect(signInWithGoogleWeb(auth, 'http://localhost:8081')).resolves.toMatchObject({
      status: 'error',
      message: expect.stringMatching(/couldn't reach/i),
    });
  });
});

describe('signInWithGoogleNative', () => {
  const redirectTo = 'splitit://auth/callback';

  it('opens the auth session and exchanges the returned code', async () => {
    const { auth, calls } = fakeAuth();
    const opened: [string, string][] = [];
    const result = await signInWithGoogleNative({
      auth,
      redirectTo,
      openAuthSession: async (url, redirect) => {
        opened.push([url, redirect]);
        return { type: 'success', url: `${redirectTo}?code=the-code` };
      },
    });
    expect(result).toEqual({ status: 'signed-in' });
    expect(calls.signIn).toEqual([{ provider: 'google', options: { redirectTo, skipBrowserRedirect: true } }]);
    expect(opened).toEqual([['https://supabase.local/auth/v1/authorize?provider=google', redirectTo]]);
    expect(calls.exchange).toEqual(['the-code']);
  });

  it.each(['cancel', 'dismiss'])('reports a %s as cancelled without exchanging', async (type) => {
    const { auth, calls } = fakeAuth();
    const result = await signInWithGoogleNative({ auth, redirectTo, openAuthSession: async () => ({ type }) });
    expect(result).toEqual({ status: 'cancelled' });
    expect(calls.exchange).toEqual([]);
  });

  it('reports an error returned on the callback URL', async () => {
    const { auth, calls } = fakeAuth();
    const result = await signInWithGoogleNative({
      auth,
      redirectTo,
      openAuthSession: async () => ({ type: 'success', url: `${redirectTo}?error=access_denied` }),
    });
    expect(result).toEqual({ status: 'cancelled' });
    expect(calls.exchange).toEqual([]);
  });

  it('reports an error when the callback has no code', async () => {
    const { auth } = fakeAuth();
    const result = await signInWithGoogleNative({
      auth,
      redirectTo,
      openAuthSession: async () => ({ type: 'success', url: redirectTo }),
    });
    expect(result).toMatchObject({ status: 'error' });
  });

  it('reports a failed code exchange', async () => {
    const { auth } = fakeAuth({
      exchangeCodeForSession: (async () => ({
        data: { session: null, user: null },
        error: { name: 'AuthPKCECodeVerifierMissingError', message: 'PKCE code verifier not found in storage' },
      })) as unknown as OAuthAuthClient['exchangeCodeForSession'],
    });
    const result = await signInWithGoogleNative({
      auth,
      redirectTo,
      openAuthSession: async () => ({ type: 'success', url: `${redirectTo}?code=c` }),
    });
    expect(result).toMatchObject({ status: 'error', message: expect.stringMatching(/try again/i) });
  });

  it('never throws, even if the browser throws', async () => {
    const { auth } = fakeAuth();
    const result = await signInWithGoogleNative({
      auth,
      redirectTo,
      openAuthSession: async () => {
        throw new Error('no browser');
      },
    });
    expect(result).toMatchObject({ status: 'error' });
  });
});

describe('exchangeCodeOnce', () => {
  it('exchanges a given code at most once and shares the result', async () => {
    const { auth, calls } = fakeAuth();
    const [a, b] = await Promise.all([exchangeCodeOnce(auth, 'once-1'), exchangeCodeOnce(auth, 'once-1')]);
    const c = await exchangeCodeOnce(auth, 'once-1');
    expect(calls.exchange).toEqual(['once-1']);
    expect([a, b, c]).toEqual([{ status: 'signed-in' }, { status: 'signed-in' }, { status: 'signed-in' }]);
  });

  it('exchanges different codes separately', async () => {
    const { auth, calls } = fakeAuth();
    await exchangeCodeOnce(auth, 'once-2');
    await exchangeCodeOnce(auth, 'once-3');
    expect(calls.exchange).toEqual(['once-2', 'once-3']);
  });

  it('never throws when the exchange throws', async () => {
    const { auth } = fakeAuth({
      exchangeCodeForSession: (async () => {
        throw new TypeError('Network request failed');
      }) as unknown as OAuthAuthClient['exchangeCodeForSession'],
    });
    await expect(exchangeCodeOnce(auth, 'once-4')).resolves.toMatchObject({ status: 'error' });
  });
});
