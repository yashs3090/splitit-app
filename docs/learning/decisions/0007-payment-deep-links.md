# 0007: Settle through payment-app links, no in-app payments

**Status:** Accepted (2026-11-19). Amended by [0015](0015-settling-one-payer-self-reported-marks.md) (2026-11-24).

> **Note (2026-11-24):** [0015](0015-settling-one-payer-self-reported-marks.md) changes three details of the Decision below. The link pays the bill's **payer** (picked by the host, default the host), not always the host. People mark themselves "paid" and **nobody confirms**; the host, the person or the payer can undo a mark. And only **Venmo** is built for now. The core decision (payment-app links, no money in-app, one link module) is unchanged. The text below is left as it was decided.

## Context
Moving money ourselves would mean a payments provider (e.g. Stripe), fees, fraud handling, and possibly money-transmitter regulation, all before we know whether anyone wants the core product.

## Decision
Show each person their exact amount and open their payment app pre-filled:
- Venmo: `https://venmo.com/?txn=pay&recipients=<host>&amount=12.34&note=Dinner` (documented at https://venmo.com/paymentlinks)
- PayPal: `https://paypal.me/<handle>/12.34`
- Cash App: `https://cash.app/$<tag>/12.34`

Participants mark themselves "paid" and the host confirms.

## Consequences
- We never see card or bank data, which is a big privacy and compliance win.
- We can't verify that a payment actually happened; "paid" is on the honor system.
- URL parameters must be URL-encoded (`encodeURIComponent`), and amounts formatted from cents with exactly 2 decimals.
- Link formats are controlled by third parties and can change. Keep the builders in one module (`lib/paylinks.ts`) with tests.

## Note (2026-11-24): where the Venmo username lives, and the link format source
This note adds facts. The decision above is unchanged.

**The handle is stored on `profiles.venmo_username`** (Profile + Venmo slice, `docs/specs/2026-11-24-profile-venmo.md`; migration `supabase/migrations/20261124072017_profile_venmo.sql:26-30`). Each person saves their own on the Profile screen. Co-participants can read it, so the link can be built for whoever is being paid. The app checks the value in `lib/venmo.ts` and the database checks it again with a constraint:
- It's stored **without** the leading `@`. The app strips one `@` if you type it.
- It must match `^[A-Za-z0-9_-]{5,30}$`: 5 to 30 ASCII letters, digits, `-` or `_`. The case is kept exactly as typed.
- **Verified:** the length and the allowed symbols come from Venmo's help page "Check or edit your username" (https://help.venmo.com/cs/articles/check-or-edit-your-username-vhel208, checked 2026-11-24 by the spec).
- **Unverified:** whether Venmo allows accented letters (we reject them), whether it has a rule for the first character (we have none), and whether it treats case as the same (we store the case as typed and never compare without case).
- Every allowed character is URL-safe, so the handle can go into a link without changes. (Encoding it anyway is harmless and still recommended.)

**`venmo.com/paymentlinks` no longer documents the link format.** On 2026-11-24 that page shows Venmo Business Profile marketing (Tap to Pay, QR codes, fees) and no `txn`, `recipients`, `amount` or `note` parameters. So the Venmo URL in the Decision section is now **unverified**: it's what the page said on 2026-11-19, not something we can cite today. The M3 settle slice (`docs/specs/2026-11-24-m3-settle-venmo.md`, criterion 64) checks the format on a real phone with the Venmo app before we rely on it.

## Note (2026-11-24, M3 built): how the Venmo link is built and opened
This note adds facts. The decision above is unchanged (0015 amends the parts it names).
- **One module.** `lib/paylinks.ts` builds every Venmo URL (`venmoPayUrl`) and opens it (`openPaymentLink`). No other app file contains `venmo.com` (only its test, `lib/paylinks.test.ts`; checked 2026-11-24).
- **Two formats behind one switch.** V1 is the Decision's format, `https://venmo.com/?txn=pay&recipients=<username>&amount=<amount>&note=SplitIt`. V2 is a fallback, `https://venmo.com/<username>?txn=pay&amount=<amount>&note=SplitIt`. `VENMO_LINK_FORMAT` picks one; it is `'v1'` (`lib/paylinks.ts:25`).
- **Which format works is not confirmed yet.** The real-phone check (spec criterion 64) hadn't been run when this note was written. Until it is, both formats are unverified. When it's done, add a dated line here saying which format filled in Venmo's fields.
  - **Update (2026-11-25):** confirmed on the user's iPhone: the V1 link (`https://venmo.com/?txn=pay&recipients=<username>&amount=0.01&note=SplitIt`) opens Venmo's Pay screen. `VENMO_LINK_FORMAT` stays `'v1'`. Android and desktop are still unchecked.
  - **Update (2026-11-25):** the request form also works on the user's iPhone: `https://venmo.com/?txn=charge&recipients=<username>&amount=0.01&note=SplitIt` opens Venmo's Request screen, sent from the account signed in on that phone. Not built into the app yet. *(Built later the same day: see the note "Request links are built" at the end.)*
- **`https`, not `venmo://`.** On a phone, an `https` link opens the Venmo app when it's installed (a "universal link" on iOS, an "app link" on Android) and the browser otherwise. A `venmo://` scheme link would fail when Venmo isn't installed, needs an `LSApplicationQueriesSchemes` entry on iOS to check for the app first, and isn't documented by Venmo. *(That the https link opens the app is unverified until criterion 64.)*
- **On web**, `openPaymentLink` calls React Native's `Linking.openURL`, which in the installed `react-native-web` runs `window.open(url, '_blank', 'noopener')`. It reports success even when a popup blocker stops it, so the screen always shows "@handle · $X" as a fallback.
- **The note is the fixed word "SplitIt"**, and amounts are whole cents from 1 to 99,999,999 formatted with exactly two decimals (`formatCentsInput`), as the Consequences above require.
  - **Update (2026-11-25):** the note now also lists the payer's own claimed item names (e.g. `SplitIt: Carnitas Bowl, Chicken Burrito + 3 more`). Plain "SplitIt" is still what you get with no claimed items, or with `VENMO_NOTE_INCLUDES_ITEMS` off. Details and the privacy trade-off: [ADR 0015](0015-settling-one-payer-self-reported-marks.md) §5 and `docs/specs/2026-11-25-venmo-note-item-names.md`.

## Note (2026-11-25): request links are built
This note adds facts. The decision above is unchanged: no money moves in SplitIt, and every Venmo link is still built in one module. Spec: `docs/specs/2026-11-25-venmo-request-buttons.md` (with its Amendment A1).

**What a request link is.** A pay link (`txn=pay`) opens Venmo's **Pay** screen: "send this person money". A request link (`txn=charge`) opens Venmo's **Request** screen: "ask this person for money". Everything else in the URL is the same.
- Pay, as before: `https://venmo.com/?txn=pay&recipients=hana-1&amount=15.10&note=SplitIt%3A%20Salad%2C%20Fries`
- Request: `https://venmo.com/?txn=charge&recipients=Tejesh-Bhaumik&amount=15.10&note=SplitIt%3A%20Carnitas%20Bowl%2C%20Chicken%20Burrito%20%2B%201%20more`

**How it's built.** `lib/paylinks.ts` has one private builder, `venmoLink(format, txn, input)`. It's the only code that writes a `venmo.com` URL. Pay and request both call it:
- `venmoPayUrl(input)` passes `'pay'`.
- `venmoRequestUrl(input)` passes `'charge'`. It takes the **same input** as `venmoPayUrl` (username, cents, item names) and returns `null` in exactly the same cases (a bad username, or cents outside 1 to 99,999,999).
- `venmoRequestUrlForFormat(format, input)` does the same for a chosen format, so tests can try V2. The app uses `VENMO_LINK_FORMAT`, still `'v1'`.

So a request link can't get a different amount format, username check or note than a pay link. A test checks that, for the same input, the request URL is the pay URL with `txn=pay` swapped for `txn=charge`.

**Who is who in a request link.** This is the easy part to get backwards:
- `recipients` is the person being **asked** (the one who owes), not the person collecting.
- The request is sent **from whichever Venmo account is signed in on the phone that opens the link**. SplitIt can't choose that. On the payer's own phone that's the payer, which is why only the payer sees Request buttons ([ADR 0015](0015-settling-one-payer-self-reported-marks.md), note of 2026-11-25).
- The note lists the **asked person's** own claimed items, not the payer's. A person's note only ever lists their own items, the same rule as the pay link.

**What's verified, and what isn't.**
- **Verified (2026-11-25, the user's iPhone):** the V1 request link with `note=SplitIt` at $0.01 opened Venmo's Request screen with the recipient and amount filled in.
- **Unverified:** V2 with `txn=charge`; Android; a desktop browser; and a request whose note lists item names (spec user check U1). Until U1 runs, treat those as guesses. `docs/before-production.md` §5 tracks the re-check.
