# 0008: Google is the only sign-in method (for now)

**Status:** Accepted (2026-11-19). Narrows the sign-in methods listed in [0004](0004-required-accounts.md); the "everyone signs in" part of 0004 still stands.

## Context
ADR 0004 planned Apple, Google and email magic-link sign-in. While specifying M0, the user decided that email sign-in isn't worth setting up yet. Sending real email needs an email provider (SMTP), a sending domain and deliverability work. Most of our users already have a Google account.

## Decision
"Continue with Google" is the only way to sign in, using Supabase's Google OAuth provider with the **PKCE** flow. Email sign-up is disabled in the Supabase config.

## How it works (OAuth 2.0 authorization code + PKCE)
1. The app generates a random secret (the **code verifier**) and sends a hash of it (the **code challenge**) when it redirects the user to Google, by way of Supabase.
2. The user picks their Google account. Google sends them back to Supabase, and then to our app, with a one-time **authorization code**.
3. The app exchanges the code *plus the original verifier* for a session. Even if another app intercepts the code (a real risk with custom URL schemes on phones), it can't use it without the verifier.

## Consequences
- **Nobody can sign in, even locally, until a Google OAuth client exists.** The user creates one in Google Cloud (free). Steps are in `docs/setup/google-oauth.md`. Automated tests mock the Google step.
- While the Google consent screen is in "Testing" mode, only Gmail accounts listed as test users can sign in. Publishing the app for everyone needs Google's verification review.
- **iOS:** App Store guideline 4.8 requires a privacy-focused equivalent, in practice Sign in with Apple, when an app offers Google sign-in. Apple must be added before App Store submission, which needs the $99/yr developer membership.
- People without a Google account can't join a bill. We'll watch for this in the real-dinner tests. If it hurts, adding Apple or email later is a config change plus one button.
- Display names come from the Google profile (`full_name`/`name`), so the "what should friends call you?" screen in M2 can be pre-filled.

## Learn more
- https://supabase.com/docs/guides/auth/social-login/auth-google
- https://oauth.net/2/pkce/
- https://developer.apple.com/app-store/review/guidelines/#login-services
