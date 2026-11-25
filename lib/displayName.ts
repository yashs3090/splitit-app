type UserLike = { email?: string | null; user_metadata?: Record<string, unknown> | null } | null | undefined;

/** What to call the signed-in user: Google's full_name, then name, then email. */
export function displayNameFor(user: UserLike): string {
  const meta = user?.user_metadata ?? {};
  for (const candidate of [meta.full_name, meta.name, user?.email]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return 'your account';
}
