# 0004: Every participant signs in (one-tap)

**Status:** Accepted (2026-11-19). Sign-in methods narrowed to Google only by [0008](0008-google-only-sign-in.md). Revisit after real-dinner tests.

## Context
Splitwise Itemize lets friends join by QR code with no account. Requiring sign-in adds friction, but gives us a stable identity per person: claims can't be spoofed by typing someone else's name, history works across bills, and payment handles (Venmo username, etc.) can be saved once.

## Decision
Everyone signs in, but only through **passwordless** methods: Sign in with Apple, Google, or an email magic link. The invite link must survive sign-in, so after authenticating, the user lands straight on the bill they were invited to.

## Consequences
- The biggest product risk is invitees dropping off at the sign-in screen. Track this: invite opened → signed in → claimed at least one item.
- The kill criterion in the plan (under 40% of invitees complete) would trigger a new ADR to allow guest claiming that converts to an account later.
- Apple requires Sign in with Apple if an iOS app offers other third-party sign-ins like Google.

## Learn more
- https://supabase.com/docs/guides/auth/social-login/auth-apple
- https://developer.apple.com/app-store/review/guidelines/#sign-in-with-apple
