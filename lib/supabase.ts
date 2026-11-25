import { createClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

import { readSupabaseEnv } from './env';
import { storage } from './storage';

// Direct member accesses: Expo only inlines static `process.env.EXPO_PUBLIC_*` references.
const env = readSupabaseEnv({
  url: process.env.EXPO_PUBLIC_SUPABASE_URL,
  key: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
});

export const supabase = createClient(env.url, env.key, {
  auth: {
    storage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: Platform.OS === 'web',
    flowType: 'pkce',
  },
});

// On native, only refresh tokens while the app is in the foreground (Supabase Expo guide).
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      void supabase.auth.startAutoRefresh();
    } else {
      void supabase.auth.stopAutoRefresh();
    }
  });
}
