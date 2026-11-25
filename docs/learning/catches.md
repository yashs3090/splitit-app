# Important catches and caveats

One page of the things that are easy to get wrong in SplitIt, or that surprised us while building it. Each line points to the note or decision with the full story. Read this before demoing the app, onboarding someone, or starting a new feature. Last updated 2026-11-25 (after Profile + Venmo, M3 settle, People + invites, bill markers, settle early and differences).

## 1. Security: the database is the boundary
- **The app is not the only client.** The project URL and anon key ship in every copy of the app, and anyone can sign in with Google, so anyone can call the Data API directly. Only what the **database** refuses is prevented; the screens only decide what's convenient. → [row-level security](concepts/row-level-security.md), "The app is not the only client"
- **Accepted, caller-only risks** (the database allows them; they only affect the caller): direct claim writes that can deadlock against a host's save (PI-R-3, accepted by the user on the assumption nobody uses the API directly; not enforced), "I paid" when you owe nothing (PI-M-1), marks of any amount from $0.01 to $999,999.99, and raising your own mark to any amount with `settle_difference` ("I paid more"). (K6, marking paid on an all-$0 bill, is off this list since 2026-11-25: the database now refuses it.) → `docs/decisions-to-review.md`, `docs/before-production.md` §4
- **Two direct-caller cases that touch someone else, accepted on purpose** (2026-11-25, ADR 0021): (1) the payer can lower anyone's mark down to clearing it ("I paid you back"). That's weaker than Undo, which the payer already has, and Activity shows who did it. (2) Replaying an old `settle_difference` call can record a step twice if the mark went away and came back to the same amount (review R8): the token is an amount, not a version. The app never replays old calls. → [row-level security](concepts/row-level-security.md), [stale-state checks](concepts/stale-state-checks.md), `docs/before-production.md` §4
- **The anon key is public; the service-role key must never ship.** It bypasses RLS completely. `lib/env.ts` refuses it, and the leak check `grep -rE "service_role|sb_secret_" dist/` must print nothing. → [env vars and secrets](concepts/env-vars-and-secrets.md)
- **Grants + RLS, both, always.** A denied operation is `42501`; a row RLS hides is "0 rows". → [row-level security](concepts/row-level-security.md)
- **Tables with column grants: always name your columns.** `select *`, or a bare `.select()` after `.update()` (which means `returning *`), fails with `42501`, even for the owner. → [row-level security](concepts/row-level-security.md)
- **Every granted column is visible to everyone RLS shows the row to.** Owner-only data (the Venmo prompt flag, "when you opened a bill") gets no grant at all and goes through definer functions. → [row-level security](concepts/row-level-security.md), "Read state is owner-only"
- **Side effects can leak private data.** A write that broadcasts or logs an Activity event tells other people *when* you did it. That's why "seen" lives in its own table that never broadcasts: no read receipts. → [in-app notices](concepts/in-app-notices.md)
- **Don't let an error message reveal who exists.** `add_participant` gives the same `not_linked` for a made-up id and a real stranger. → [row-level security](concepts/row-level-security.md), "`not_linked`: a privacy story"

## 2. Sign-in and links
- **Two redirect allow-lists**, Google's and Supabase's. If the app's `redirectTo` isn't on Supabase's list, it silently falls back to the Site URL (that's the "stuck on localhost on my phone" bug). → [auth and deep links](concepts/auth-and-deep-links.md)
- **`localhost` and `127.0.0.1` mean "this device".** On a phone they point at the phone, never at your Mac.
- **`EXPO_PUBLIC_*` values are baked in at build time.** Changing `.env` needs a rebuild (`--clear` on web), or the app keeps talking to the old Supabase. → [env vars and secrets](concepts/env-vars-and-secrets.md)
- **Share links and texted invites don't open on friends' phones yet.** They're `localhost` or `splitit://` until the web app is hosted (Vercel) and links use its `https://` address.
- **Google's "Testing" mode** only lets listed test users sign in.
- **The root `.env` must hold only `EXPO_PUBLIC_*` values.** The two `google_oauth_webclient1_*` lines are still there (reported six times); delete them.

## 3. Money and settling (honor system)
- **Money is integer cents**, split with largest-remainder rounding so shares always add up to the total. → [money and rounding](concepts/money-and-rounding.md)
- **"I paid" is self-reported.** The app never sees Venmo. → [ADR 0015](decisions/0015-settling-one-payer-self-reported-marks.md)
- **A mistyped Venmo username sends money to a stranger.** We only check its format; the Pay screen shows "@handle" so people can check.
- **The Venmo link format is only partly confirmed** (Venmo removed its docs). The $0.01 check worked on an iPhone on 2026-11-25; Android and desktop are still unchecked. Switching formats is one setting.
- **Venmo notes can be public, and ours now names what you ordered** (since 2026-11-25, your request). Example: "SplitIt: Carnitas Bowl, Chicken Burrito + 3 more". It shows only your own items, never people's names or amounts. One constant, `VENMO_NOTE_INCLUDES_ITEMS` in `lib/paylinks.ts`, switches back to plain "SplitIt". This default is waiting for your review (VN-8). → [ADR 0015](decisions/0015-settling-one-payer-self-reported-marks.md), [before production](../before-production.md)
- **In a Venmo request link, the person named in the link is the one being asked, and the request comes from whoever is signed in to Venmo on the phone that opens it** (2026-11-25). That is why only the payer sees Request buttons: on a borrowed phone, the request would come from the wrong account. → [ADR 0007](decisions/0007-payment-deep-links.md)
- **App and database rules can differ on purpose**, but only written down: PI-M-1. CLAUDE.md says money rules should match on both sides, so it needs your review. (K6, all-$0 bills, was the other one; it's closed since 2026-11-25, both sides now use rule Z.)
- **On proportional bills you can pay before everyone has claimed** (2026-11-25), once you've claimed an item. Even-mode bills still wait. Others claiming can move your share by at most 1¢ (rounding), and the app ignores ±1¢ differences. → [ADR 0021](decisions/0021-settling-early-and-paying-differences.md), [money and rounding](concepts/money-and-rounding.md)
- **A mark is the net amount settled, and a pay-back to $0 clears it** (2026-11-25). There's no "Paid back" status; Activity has the history. After a pay-back to $0, no "undone" notice shows (the user's choice: never say something untrue about money). → [ADR 0021](decisions/0021-settling-early-and-paying-differences.md)
- **Pay-backs stop at $0.** If a share goes negative, the rest is still "settle that outside the app".
- **Degenerate inputs find bugs specs miss.** A 500-bill random test found the all-$0 case. → [money and rounding](concepts/money-and-rounding.md)

## 4. Concurrency
- **Send what you saw; let the database refuse if it changed** (stale-state tokens like `p_expected_cleared`, `p_payer_id`, `p_expected_cents`). A retry after a lost response should succeed, not fail the token check: `settle_difference` treats "already done" as success. → [stale-state checks](concepts/stale-state-checks.md)
- **A list read can be cut short without an error.** PostgREST's `max_rows` truncates silently, so Home's settle read asks for an exact count and fails when rows are missing. → [in-app notices](concepts/in-app-notices.md)
- **One lock order: the bill row first, everywhere.** Count the locks Postgres takes on its own: foreign-key checks, and the Activity insert that locks `bills`. Two deadlocks came from missing them. pgTAP can check the order but can't reproduce a real deadlock. → [database functions](concepts/database-functions.md), "One lock order for every bill"
- **Known gaps:** count-based payer-change check (a swap of marks passes), no token on Undo, and a lock-order risk when account deletion is built. → `docs/before-production.md`

## 5. Building screens
- **Every async action needs a failure path**, including "the write worked but the refresh failed" (buttons must come back). → lessons log
- **Guard writes against double taps with a `useRef`**, not state; two taps in one frame both see the old state. Taps that open another app (Venmo) need a short cooldown too.
- **Test copy with a count of 1 and with "You"** ("All 1 marked paid", "Hana changed who gets paid to Hana" both slipped through).
- **Test every way a screen can be reached**, on web and native: pushed, cold deep link, after the web OAuth redirect lands on `/`, with a pending invite. This slipped three times.
- **On web, open external links synchronously in the tap handler.** An `await` first makes popup blockers block Venmo. A blocked popup can't be detected, so always leave a fallback (the "@handle · $X" line and "I paid").
- **Web has no `Alert`.** Use inline confirms.
- **Nudges are dismissible cards on Home, never modals** (user preference).

## 6. Native and phones
- **Native features need a development build**, not Expo Go. New native packages (contacts, SMS) mean a rebuild (`npx expo run:ios`).
- **Keep native modules out of web** with `.native.ts` / `.ts` file pairs. → [platform-specific files](concepts/platform-specific-files.md)
- **Library facts must be checked in the installed source.** The SDK 57 contact picker returns only an id, so reading numbers needs contacts permission (PI-N-1), which overturned the plan.
- **Real devices haven't been tried** for Google sign-in with two accounts, the simulator, Android, VoiceOver or the Venmo link.

## 7. Environment and tooling
- **Check which database you're talking to.** Docker must be up for the local stack, and the dev server on :8081 points at the **hosted** project, which is several migrations behind until you run `npx supabase db push`. Bills won't load there until then.
- **Never `db reset` your local data**; apply new migrations with `npx supabase migration up`.
- **Restart Supabase after editing `supabase/.env` or `config.toml`.** It reads them only at start.
- **Search build output from a fresh build.** And this shell's `grep` is ugrep, which silently skips binary files like iOS `.hbc` bundles; use `/usr/bin/grep -a`. A "prints nothing" check is only trustworthy after you've shown it can match something.
- **Jest timeouts under heavy load are usually not real failures.** Run with `--maxWorkers=4`, check `uptime`, rerun the file on its own, and don't build or run QA at the same time as the full suite.
- **Native packages throw under Jest**, so `test-utils/jestSetup.ts` replaces expo-contacts and expo-sms with stand-ins that fail loudly if a test forgets its own mock.
- **Nothing is committed** since the initial commit. Commit to back the work up.

## 8. Process
- **Decisions made without asking are logged** in `docs/decisions-to-review.md` (the user reviews them later). Privacy changes and anything that breaks a CLAUDE.md rule should be read first.
- **"Can't happen" must name what prevents it.** "The app can't produce that" was wrong twice (PI-M-1); only a database check counts.
- **Give the docs writer the spec's docs task, not a summary.** It twice dropped items from a summary.
- **A staff-engineer review before screens** simplified M3 (no "return from Venmo" detection, one screen task instead of three).
- **A scan step ships only if it wins on receipts it wasn't tuned on.** Look at held-out once per experiment, never re-tune after it, and only score answer files a person marked `checked: yes`. Most steps (filters, Tesseract settings, zoom) measured no better and are switched off. With 5 checked receipts every verdict is still provisional. → [the scan pipeline](concepts/scan-pipeline.md)
- **Crop and size before any filter; never black-and-white.** Cropping put more pixels into each letter; filters didn't help, and binarizing throws away the grey detail Tesseract reads. The OCR harness is Chromium on a Mac, not a phone browser.
