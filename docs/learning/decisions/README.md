# Design decisions (ADRs)

An **Architecture Decision Record** captures one significant decision: the context, what we chose, what we rejected, and the consequences. Code shows *what* the system does. ADRs record *why*, which is the part people forget six months later.

Rules:
- One decision per file, numbered, never renumbered.
- Don't edit a past decision to change it. Write a new ADR that **supersedes** it, and mark the old one `Superseded by NNNN`. The history of how thinking changed is useful.
- Status is one of: Proposed, Accepted, Superseded, Deprecated.

| # | Decision | Status |
|---|---|---|
| [0001](0001-expo-cross-platform.md) | One Expo/React Native codebase for iOS, Android and web | Accepted |
| [0002](0002-supabase-backend.md) | Supabase as the backend | Accepted |
| [0003](0003-two-repos.md) | Separate app and backend repos | Superseded by 0011 |
| [0004](0004-required-accounts.md) | Every participant signs in (one-tap) | Accepted |
| [0005](0005-integer-cents.md) | Money as integer cents with largest-remainder rounding | Accepted (amended by 0014) |
| [0006](0006-claude-structured-outputs.md) | Claude with structured outputs for receipt parsing | Superseded by 0010 |
| [0007](0007-payment-deep-links.md) | Settle through payment-app links, no in-app payments | Accepted (amended by 0015; notes 2026-11-24: handle on `profiles`; link format V1 confirmed on iPhone 2026-11-25; note 2026-11-25: request links (`txn=charge`) built, iPhone-verified only) |
| [0008](0008-google-only-sign-in.md) | Google is the only sign-in method (for now) | Accepted |
| [0009](0009-expo-sdk-57-node-20.md) | Pin Expo SDK 57 because this machine runs Node 20 | Accepted |
| [0010](0010-on-device-ocr-no-custom-backend.md) | Read receipts on device with our own parser; no custom backend | Accepted (one line amended by 0013) |
| [0011](0011-single-repo.md) | One repo: the app plus Supabase config in `supabase/` | Accepted |
| [0012](0012-receipt-capture-and-recognition-libraries.md) | Receipt photo via `expo-image-picker`; text via `expo-mlkit-ocr` (Vision) on iOS and Tesseract.js (provisional) on web; `ios/`/`android/` not committed | Accepted (D1 device gate pending) |
| [0013](0013-writes-through-database-functions.md) | Multi-table, host-only and other-people writes go through security-definer SQL functions (still no custom backend) | Accepted |
| [0014](0014-extras-split-proportional-or-equal.md) | Tax, tip, fees and bill-level discounts split proportionally (default) or equally | Accepted (amended by 0017) |
| [0015](0015-settling-one-payer-self-reported-marks.md) | Settling: the host picks one payer, people mark "I paid" themselves, Venmo links only for now | Accepted (Venmo link format V1 confirmed on iPhone 2026-11-25; note 2026-11-25: the Venmo note now lists the payer's item names; note 2026-11-25 (§8): per-row Request for the payer, owers pay from the bill footer) |
| [0016](0016-people-come-from-shared-bills.md) | "People you've split with" is worked out from shared bills (no friend requests); being added doesn't link you; the host adds only linked people; remove/leave never change a share; contacts stay on the device | Accepted |
| [0017](0017-claimable-discounts.md) | A bill-level discount can be marked "Claim like an item" (off by default): stored as a negative bill row, claimed and shared by parts like an item; shares aren't capped, so one can go negative | Accepted (CD-6, negative shares, awaiting the user's review) |
| [0018](0018-staged-scan-pipeline.md) | Every scan goes through one staged pipeline (locate → crop → size → enhance → read → quality check → one retry → "Retake photo / Type it in"), with per-platform stages, every step in config and shipped only after tuning + held-out measurement; native stages are stubs for now | Accepted (architecture); what ships on web pending the user's answer checks (S-1) |
| [0019](0019-opencv-on-web.md) | OpenCV on web: `@techstark/opencv-js@4.12.0-release.1` (10.9 MB), self-hosted, lazy, in a classic Web Worker, only to find, straighten and enhance (resizing stays on the canvas); off until the shipping decision; custom minimal build before production | Accepted (how it loads); switched off, shipping pending (S-1) |
