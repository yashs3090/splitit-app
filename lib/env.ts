/**
 * Validates the public Supabase config baked into the app bundle.
 *
 * Call it with direct member accesses, e.g.
 *   readSupabaseEnv({ url: process.env.EXPO_PUBLIC_SUPABASE_URL, key: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY })
 * because Expo only inlines static `process.env.EXPO_PUBLIC_*` references at build time.
 */
export type SupabaseEnv = { url: string; key: string };

const URL_VAR = 'EXPO_PUBLIC_SUPABASE_URL';
const KEY_VAR = 'EXPO_PUBLIC_SUPABASE_ANON_KEY';

export function readSupabaseEnv(input: { url: string | undefined; key: string | undefined }): SupabaseEnv {
  const url = input.url?.trim() ?? '';
  const key = input.key?.trim() ?? '';

  if (!url) throw new Error(`${URL_VAR} is missing. Copy .env.example to .env and fill it in.`);
  if (!key) throw new Error(`${KEY_VAR} is missing. Copy .env.example to .env and fill it in.`);

  if (!/^https?:\/\/[^\s/]+/i.test(url)) {
    throw new Error(`${URL_VAR} must be an http(s) URL, e.g. http://127.0.0.1:54321.`);
  }

  // Never echo the key itself in an error: it may be a secret pasted by mistake.
  // These checks avoid spelling the secret-key prefix / service role as literals so the
  // bundle stays clean for the `grep -rE "service_role|sb_secret_" dist/` leak check.
  const [prefix, kind] = key.split('_');
  if (prefix === 'sb' && kind === 'secret') {
    throw new Error(
      `${KEY_VAR} looks like a secret key. Use the publishable/anon key; secret keys must never ship in the app.`,
    );
  }
  if (jwtRole(key)?.split('_').join('-') === 'service-role') {
    throw new Error(
      `${KEY_VAR} is a service-role JWT. Use the anon key; the service-role key must never ship in the app.`,
    );
  }

  return { url, key };
}

/** Returns the `role` claim of a JWT-shaped string, or null if it isn't a decodable JWT. */
function jwtRole(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload: unknown = JSON.parse(atob(padded));
    if (payload && typeof payload === 'object' && 'role' in payload) {
      const role = (payload as { role: unknown }).role;
      return typeof role === 'string' ? role : null;
    }
    return null;
  } catch {
    return null;
  }
}

const WEB_URL_VAR = 'EXPO_PUBLIC_WEB_URL';
// One DNS label: letters, digits and inner hyphens, 1–63 characters.
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const WEB_ORIGIN_RE = new RegExp(`^https://(${LABEL}(?:\\.${LABEL})*)(?::(\\d{1,5}))?$`);

/**
 * Validates the optional public web origin that share/invite links point at (e.g. the Vercel
 * deploy). Returns null when unset or blank, so links keep the dev behaviour (`Linking.createURL`).
 * Otherwise returns the origin, lowercased, with trailing slashes trimmed, or throws: it must be
 * `https://host[:port]` with no path, query, hash or credentials.
 *
 * Parsed with a regex, not `new URL()`: React Native's URL polyfill doesn't implement the getters
 * (pathname, search, …) on native.
 *
 * Call it with a direct member access, `readWebUrl(process.env.EXPO_PUBLIC_WEB_URL)`, so Expo inlines it.
 */
export function readWebUrl(value: string | undefined): string | null {
  const raw = value?.trim() ?? '';
  if (!raw) return null;
  const origin = raw.replace(/\/+$/, '').toLowerCase();
  const match = WEB_ORIGIN_RE.exec(origin);
  const port = match?.[2] === undefined ? null : Number(match[2]);
  if (!match || (port !== null && (port < 1 || port > 65535))) {
    throw new Error(
      `${WEB_URL_VAR} must be an https origin with no path, query or hash, e.g. https://splitit-xyz.vercel.app ` +
        `(got ${JSON.stringify(raw)}). Leave it empty to use dev links.`,
    );
  }
  return origin;
}
