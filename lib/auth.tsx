import type { Session } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';

import { describeOAuthCallbackError, parseOAuthCallback } from './oauth';
import { supabase } from './supabase';

type AuthState = {
  session: Session | null;
  /** True until the stored session (or a web OAuth redirect) has been read. */
  loading: boolean;
  /** Web only: an `error=` the OAuth provider sent back on the landing URL. */
  oauthError: string | null;
};

const AuthContext = createContext<AuthState>({ session: null, loading: true, oauthError: null });

function readWebOAuthError(): string | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const href = window.location?.href;
  if (typeof href !== 'string') return null;
  const callback = parseOAuthCallback(href);
  return callback?.kind === 'error' ? describeOAuthCallbackError(callback.error) : null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [oauthError] = useState(readWebOAuthError);

  useEffect(() => {
    let mounted = true;

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!mounted) return;
        setSession(data.session);
        setLoading(false);
      })
      .catch(() => {
        if (mounted) setLoading(false);
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted) return;
      setSession(nextSession);
      setLoading(false);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  return <AuthContext.Provider value={{ session, loading, oauthError }}>{children}</AuthContext.Provider>;
}

export function useSession(): AuthState {
  return useContext(AuthContext);
}
