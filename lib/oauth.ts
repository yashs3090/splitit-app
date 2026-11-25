import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Google sign-in (PKCE). Pure helpers plus the web and native flows, with the
 * Supabase auth client and browser injected so they can be unit-tested.
 * Never log codes, tokens or sessions from here.
 */

export type OAuthAuthClient = Pick<SupabaseClient['auth'], 'signInWithOAuth' | 'exchangeCodeForSession'>;

export type OAuthCallback =
  | { kind: 'code'; code: string }
  | { kind: 'error'; error: string; description: string | null };

export type SignInOutcome =
  | { status: 'signed-in' }
  | { status: 'redirecting' }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

/** Parses `?code=` / `?error=` (query or fragment) from an OAuth callback URL. Null if it isn't one. */
export function parseOAuthCallback(url: string): OAuthCallback | null {
  const params = new Map<string, string>();
  const hashIndex = url.indexOf('#');
  const beforeHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? '' : url.slice(hashIndex + 1);
  const queryIndex = beforeHash.indexOf('?');
  const query = queryIndex === -1 ? '' : beforeHash.slice(queryIndex + 1);

  // Query wins over fragment when both set the same key.
  for (const part of [fragment, query]) {
    for (const pair of part.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const key = safeDecode(eq === -1 ? pair : pair.slice(0, eq));
      const value = safeDecode(eq === -1 ? '' : pair.slice(eq + 1));
      if (key !== null && value !== null) params.set(key, value);
    }
  }

  const error = params.get('error');
  if (error) {
    return { kind: 'error', error, description: params.get('error_description') || null };
  }
  const code = params.get('code');
  return code ? { kind: 'code', code } : null;
}

/**
 * A message for an `error=` returned on the callback. Built from the error code only:
 * the description comes from the URL, which anyone can craft, so it is not shown.
 */
// Codes we recognise from Google / Supabase Auth. Anything else is shown generically,
// because the callback URL can be crafted by anyone.
const KNOWN_CALLBACK_ERRORS = new Set(['server_error', 'temporarily_unavailable', 'invalid_request']);

export function describeOAuthCallbackError(error: string): string {
  if (error === 'access_denied') return 'Sign-in was cancelled.';
  return KNOWN_CALLBACK_ERRORS.has(error)
    ? `Google sign-in failed (${error}). Please try again.`
    : 'Google sign-in failed. Please try again.';
}

/** Maps an auth/network error to user-facing text. Never includes tokens. */
export function describeAuthError(err: unknown): string {
  const name = typeof err === 'object' && err !== null && 'name' in err ? String(err.name) : '';
  const message = typeof err === 'object' && err !== null && 'message' in err ? String(err.message) : '';

  if (/provider is not enabled|unsupported provider/i.test(message)) {
    return "Google sign-in isn't set up on the server yet.";
  }
  if (name === 'AuthRetryableFetchError' || /network request failed|failed to fetch|network/i.test(message)) {
    return "Couldn't reach the server. Check your connection and try again.";
  }
  if (name === 'AuthPKCECodeVerifierMissingError' || /code verifier|flow state|auth code/i.test(message)) {
    return 'That sign-in attempt expired. Please try again.';
  }
  return 'Sign-in failed. Please try again.';
}

/** Web: redirects the whole page to Google; the session is picked up on return (detectSessionInUrl). */
export async function signInWithGoogleWeb(auth: OAuthAuthClient, origin: string): Promise<SignInOutcome> {
  try {
    const { error } = await auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${origin}/` },
    });
    return error ? { status: 'error', message: describeAuthError(error) } : { status: 'redirecting' };
  } catch (err) {
    return { status: 'error', message: describeAuthError(err) };
  }
}

export type NativeOAuthDeps = {
  auth: OAuthAuthClient;
  /** e.g. Linking.createURL('/auth/callback') */
  redirectTo: string;
  /** e.g. WebBrowser.openAuthSessionAsync */
  openAuthSession: (url: string, redirectUrl: string) => Promise<{ type: string; url?: string }>;
};

/** Native: opens an in-app auth session, then exchanges the returned PKCE code. Never throws. */
export async function signInWithGoogleNative({
  auth,
  redirectTo,
  openAuthSession,
}: NativeOAuthDeps): Promise<SignInOutcome> {
  try {
    const { data, error } = await auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo, skipBrowserRedirect: true },
    });
    if (error || !data.url) return { status: 'error', message: describeAuthError(error) };

    const result = await openAuthSession(data.url, redirectTo);
    if (result.type !== 'success' || !result.url) return { status: 'cancelled' };

    const callback = parseOAuthCallback(result.url);
    if (callback === null) return { status: 'error', message: 'Sign-in did not complete. Please try again.' };
    if (callback.kind === 'error') {
      return callback.error === 'access_denied'
        ? { status: 'cancelled' }
        : { status: 'error', message: describeOAuthCallbackError(callback.error) };
    }

    return await exchangeCodeOnce(auth, callback.code);
  } catch (err) {
    return { status: 'error', message: describeAuthError(err) };
  }
}

// PKCE codes are single-use. On Android the same callback can reach both the
// openAuthSessionAsync result and the /auth/callback route, so every exchange goes
// through here and a given code is exchanged at most once (later callers share the result).
const exchanges = new Map<string, Promise<SignInOutcome>>();

/** Exchanges a PKCE code for a session, at most once per code. Never throws. */
export function exchangeCodeOnce(auth: OAuthAuthClient, code: string): Promise<SignInOutcome> {
  const existing = exchanges.get(code);
  if (existing) return existing;
  const attempt = (async (): Promise<SignInOutcome> => {
    try {
      const { error } = await auth.exchangeCodeForSession(code);
      return error ? { status: 'error', message: describeAuthError(error) } : { status: 'signed-in' };
    } catch (err) {
      return { status: 'error', message: describeAuthError(err) };
    }
  })();
  exchanges.set(code, attempt);
  return attempt;
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}
