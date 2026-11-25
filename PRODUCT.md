# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

One Expo (React Native + Expo Router) codebase ships to iOS, Android and web. For the friend test, most people use the web build in a phone browser (hosted on Vercel); native builds are development builds for now.

## Users

- **The host:** the friend who paid the bill (a group-dinner organizer, often a student, like the plan's "Priya, 21"). They photograph the receipt, check the items, share a link, and then chase everyone for money. They want that last part to be painless.
- **The friends at the table:** they open the shared link, sign in with Google, and claim what they ordered on their own phone, ideally in under 30 seconds. They then pay their share on Venmo.
- **The usage scene:** a restaurant table or right after it: one hand, often dim light, friends waiting, a phone in the other hand or on the table.

## Product Purpose

SplitIt splits an itemized bill fairly. The host takes a photo of the receipt; the phone reads the text on the device and our parser turns it into line items. Everyone claims their own items, and each person's share (with tax, tip, fees and discounts) is worked out exactly. Settling up opens Venmo with the amount and a note already filled in. No money moves in the app.

Success: the host stops doing maths and chasing people; each friend knows exactly what they owe and pays it in a couple of taps.

## Positioning

Splitwise Itemize and Venmo's receipt scan already itemize receipts for free. SplitIt's difference:
- **Each friend claims their own items, live**, on their own phone, instead of the host assigning everything.
- **Shares are exact to the cent.** Tax, tip, fees and bill-level discounts are split proportionally (the default) or evenly, with largest-remainder rounding, so the shares always add up to the bill total.
- **Venmo opens pre-filled** with the amount and what it's for.

## Operating Context

- Flow: sign in with Google → scan or type a receipt → review and fix items → share a link (or text it to contacts) → friends join and claim items live → the host picks who gets paid → each person pays on Venmo and marks "I paid".
- Receipts are read on the device (Apple Vision / ML Kit on phones, Tesseract.js in the browser); "Enter items" by hand is always available.
- Bills, claims and people live in Supabase; only participants can see a bill.

## Capabilities and Constraints

- Money is integer cents everywhere. The bill's totals check and the split rules are the same in the app and the database.
- Venmo only for now (PayPal and Cash App later). "I paid" is self-reported; the app can't check Venmo.
- Sign-in is Google only; every participant needs an account.
- No custom backend: the app plus Supabase only. No in-app payments.
- Not built yet (undecided or deferred): receipt-link import, bill history beyond Home, push notifications and reminders, multiple receipts per outing, a paid tier.

## Brand Commitments

- Name: **SplitIt**.
- The user's stated taste: clean and pretty, calm, simple and uncluttered, "not over the top". One clear main action per screen; rare options folded away.
- Voice: plain, friendly, short. Says what happened and what to do next, in words, not just colour.

## Evidence on Hand

- No testimonials, customers, usage numbers or press exist. Don't invent any.
- No logo or brand assets beyond the default app icon and splash (`assets/images/`).
- Receipt-reading accuracy is still being measured (`/receipt-eval`); don't claim an accuracy figure.

## Product Principles

1. **Fair to the cent.** Every share is exact, and the shares always add up to the total. Anything that could make the numbers wrong is shown, not hidden.
2. **Fast at the table.** A friend can join and claim in under 30 seconds, one-handed.
3. **Calm over clever.** One obvious next step per screen; nothing decorative competes with the money.
4. **Honest about what we know.** Unchecked totals, unclaimed items and self-reported payments are labelled as such.
5. **Private by default.** Only the people on a bill see it; receipts are read on the device.

## Accessibility & Inclusion

- Text contrast at least 4.5:1 (3:1 for large text and control borders) in light and dark mode; status never shown by colour alone.
- Touch targets at least 44×44 pt; Dynamic Type / font scaling stays on.
- Screen-reader labels on every interactive element; visible keyboard focus on web.
