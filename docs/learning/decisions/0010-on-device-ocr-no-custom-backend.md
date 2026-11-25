# 0010: Read receipts on device with our own parser; no custom backend

**Status:** Accepted (2026-11-20). Supersedes [0006](0006-claude-structured-outputs.md). One line amended by [0013](0013-writes-through-database-functions.md) (2026-11-21).

> **Note (2026-11-22):** [0013](0013-writes-through-database-functions.md) replaces the Decision bullet "The app writes `line_items` directly". Bills, items and participants are now written only through SQL functions in the database (`create_bill`, `update_bill` and others). That's still not a custom backend: the functions are SQL in the managed Supabase Postgres, versioned in `supabase/migrations/`. The rest of this ADR is unchanged.

> **Note (2026-11-20):** corrected paths only. The `splitit-backend` repo was deleted and its Supabase files moved into this repo's `supabase/` folder ([0011](0011-single-repo.md)). The two bullets under "What 'no custom backend' means" used to say the backend repo held the config and `splitit-backend/supabase/.env` held the Google secret; they now point to `supabase/` and `supabase/.env`. The decision itself is unchanged.

> **Note (2026-11-21):** the open points below (which library, and what web does) are now settled in [0012](0012-receipt-capture-and-recognition-libraries.md): the iOS/Android library is `expo-mlkit-ocr` 0.2.7 (Vision engine on iOS), and web uses Tesseract.js in the browser (the user's choice, provisional until the receipt eval) instead of manual entry only. The text below is left as it was decided.

## Context
[0006](0006-claude-structured-outputs.md) planned to send each receipt photo to Claude from a Supabase Edge Function. That design needs server code that holds a paid API key, costs money per scan, and requires uploading the photo before anything can be parsed.

The user wants SplitIt to run with **no custom backend service**: the app plus Supabase (Auth, Postgres with RLS, Storage, Realtime) and nothing else. The user also pointed out that iOS ships Apple Vision, which reads text **on the device** for free.

Receipt *links* (Toast, Square, delivery emails) were the other reason for a server. A browser can't fetch most third-party pages (CORS), and a server-side fetch needs SSRF protections. With no backend, that feature has no safe home, so it is deferred.

### What "no custom backend" means (and doesn't)
- **We still have a backend: Supabase.** It is a *managed* backend. Supabase runs the servers for Auth (Google sign-in), Postgres (our tables + RLS), Storage and Realtime. We only **configure** it: `config.toml`, SQL migrations, RLS policies.
- **What we dropped is a *custom* backend:** code *we* write that runs on a server, like an Edge Function, a Node API, or a cron job. Edge Functions are still available in Supabase; we just don't use any right now.
- **Where that config lives:** `supabase/` in this repo (`config.toml`, `migrations/`, `tests/database/`). Those files are the "backend" we own, even though they're config and SQL, not a server program. See [0011](0011-single-repo.md).
- **Why the Google OAuth secret lives there:** during sign-in, Google sends a one-time code, and **Supabase Auth** (running on Supabase's servers, not in our app) swaps it for the user's identity using the client secret. So the secret belongs to Supabase's config (`supabase/.env` locally, the Supabase dashboard when hosted), never to the app.

## Options
| Option | Cost per scan | Needs our own server code? | Accuracy on messy receipts | Notes |
|---|---|---|---|---|
| Claude vision in an Edge Function (0006) | ~$0.001–0.04 | Yes (holds the API key) | Best | Understands layout and modifiers without rules |
| Cloud OCR (Google Cloud Vision, AWS Textract) | ~$0.0015 | Yes (holds credentials) | Good text, but we still write the parser | Two problems: a server *and* a parser |
| **On-device text recognition + our parser** | **$0** | **No** | Good text; parser quality is on us | Works offline; photo never has to leave the phone to be parsed |

## Decision
- **iOS:** Apple Vision (`VNRecognizeTextRequest`) via an Expo-compatible library.
- **Android:** Google ML Kit text recognition (on-device model).
- **Web:** manual entry for now (the host types the items). Tesseract.js in the browser is a possible later option; that choice is the user's.
- Recognized text goes into **our own parser, `lib/receiptText.ts`**, a pure function with unit tests. It finds item lines and prices, quantities, modifiers ("+ avocado"), discounts, and the subtotal / tax / tip / total lines.
- The result goes through the **totals check** (items add up to the subtotal, and subtotal + tax + tip − discounts = total, within 1¢). If it fails, the bill is flagged and the host fixes it on the review screen. The host can always edit.
- The app writes `line_items` directly. RLS plus explicit grants make sure only the host can do that, so no Edge Function is needed.
- **Receipt-link import is deferred** until we decide whether a backend is worth it.

Library choice (e.g. `expo-text-extractor`, `@react-native-ml-kit/text-recognition`) is **not decided yet**. M1 starts by checking which ones work with Expo SDK 57.

## Consequences
- **No API key, no per-scan cost, works offline.** The receipt photo doesn't need to be uploaded to be parsed. (We may still store it so participants can look at it.)
- **Native code means a development build.** Expo Go can't load these libraries. Use `npx expo run:ios` (needs Xcode) or `npx expo run:android` (needs Android Studio), or an EAS build.
- **We own the parser.** Receipt layouts vary, so the parser will need tuning. The receipt eval (`.claude/skills/receipt-eval`) measures it against saved text-recognition output, which is free to run.
- **Fallback:** if parser accuracy stays under 85% of line items after tuning, revisit Claude in an Edge Function (0006's design). That would bring back a backend and a per-scan cost, so it's the user's decision.
- Web hosts type items by hand until a web option is chosen.

**Revisit when:** parser accuracy is under 85%; link import becomes a priority; or we need server-side rate limiting or abuse protection that RLS can't express.

## Concept: on-device ML vs. cloud APIs
Phones now ship small ML models built into the OS. Running a model **on device** means no network round trip, no per-call cost, and the data never leaves the phone. That's a privacy win and a security win, because there is no secret key to protect. The trade-off is capability: an on-device text recognizer gives you *text*, but understanding *what the text means* (which line is an item, which is the tax) is up to your code. A large cloud model does both, but needs a server to hold its key. See [on-device OCR](../concepts/on-device-ocr.md).
