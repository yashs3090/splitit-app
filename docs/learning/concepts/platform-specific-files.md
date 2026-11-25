# Platform-specific files (`.native.ts` vs `.ts`)

## The idea
SplitIt is one codebase for iOS, Android and web ([ADR 0001](../decisions/0001-expo-cross-platform.md)). Most code runs everywhere. Some can't: the phone's contact picker and text-message composer exist only on iOS and Android, and their libraries (`expo-contacts`, `expo-sms`) contain native code a browser can't run.

The bundler can pick a different file per platform, based on the file name. You write two files with the same base name:

```
lib/contactPicker.native.ts   ← used on iOS and Android
lib/contactPicker.ts          ← used on web (and anywhere else)
```

and every caller imports the base name, with no extension:

```ts
import { contactsSupported } from '@/lib/contactPicker';
```

**Metro**, the bundler Expo uses, decides which file that means while it builds. For each file extension it tries, in order (Metro docs, "Resolution"):
1. `contactPicker.ios.ts` (or `.android.ts`): the exact platform,
2. `contactPicker.native.ts`: "any phone", when there's no exact-platform file,
3. `contactPicker.ts`: the plain file.

The first one that exists wins. So an iOS build gets the `.native.ts` file, and the web build gets the plain `.ts` file. The file that isn't picked is **not in that bundle at all**, and neither is anything only it imports.

Think of it as two versions of one tool, with a label on each box. The packer reads the label and puts only the right box in each suitcase.

## Why it matters here
"From contacts" lets you pick a friend from your phone's contacts and text them the bill link ([ADR 0016](../decisions/0016-people-come-from-shared-bills.md)). It's iOS and Android only. If `expo-contacts` or `expo-sms` ended up in the web bundle:
- every web visitor would download code that can't run in a browser,
- and the import itself could fail at load time and break the whole page.

So the rule is: **only one file in the app imports `expo-contacts` and `expo-sms`, and the web build never picks that file.**

## How we use it
**The two contact-picker files:**
- `lib/contactPicker.native.ts`: the only file that imports the native libraries (`:13-14`). It sets `contactsSupported = true` (`:36`). It returns only phone numbers and their labels, never the contact's name or id.
- `lib/contactPicker.ts`: the web and default version. No import of either library. `contactsSupported = false` (`:34`), and the functions return "error" / `false` without doing anything. It also holds the shared types (`PickContactResult`, `ContactPicker`).
- The bill screen's Invite card shows "From contacts" only when `contactsSupported` is true (`components/SharePanel.tsx:108`). On web it's false, so the button never appears.

**Keeping the two files' shapes the same.** TypeScript doesn't know about platform file names. When `tsc` sees `import ... from '@/lib/contactPicker'`, it reads only the plain `contactPicker.ts` (our `tsconfig.json` sets no `moduleSuffixes`). So callers are type-checked against the web file. To make sure the native file matches, it imports the shared types from the plain file and builds its functions with `createContactPicker(...): ContactPicker` (`lib/contactPicker.native.ts:16`, `:61`). If the native file's shape drifted, `npm run typecheck` would fail.

**Other pairs in the repo use the same idea** in slightly different shapes:

| Module | Files | Where the shared type lives |
|---|---|---|
| Contact picker | `.native.ts` + plain `.ts` (the plain file *is* the web version) | `lib/contactPicker.ts` |
| Text recognition, photo capture, image prep, scanning | `.native.ts` + `.web.ts` + a plain `.ts` with the contract | the plain `.ts` (e.g. `lib/textRecognition.ts`) |
| Session storage | `.native.ts` + `.web.ts` + a `.d.ts` with only types | `lib/storage.d.ts` |

The receipt-reading pair is explained in [ADR 0012](../decisions/0012-receipt-capture-and-recognition-libraries.md#concept-platform-specific-files-behind-one-contract). Its web side also uses a second trick: a heavy web-only library (Tesseract.js) is loaded with `await import()` only when you scan, so it sits in its own chunk instead of the main bundle ([on-device OCR](on-device-ocr.md)).

**Tests.** Jest (with the `jest-expo` preset) also picks files by platform, and its default is iOS. So a screen test that renders the Invite card loads `contactPicker.native.ts`, which imports the real native libraries, which throw under Jest. `test-utils/jestSetup.ts` gives every test safe stand-ins for both libraries, which fail loudly if a test taps "From contacts" without its own mock. To test the web file directly, `lib/contactPicker.test.ts` loads it by its full name (`jest.requireActual('./contactPicker.ts')`). `__tests__/contactInvite.test.tsx` checks the button with `Platform.OS` set to `'ios'` and to `'web'`.

### How we checked the web bundle (criterion 54, 2026-11-24)
A source search only shows which file imports the libraries (criterion 53: `grep -rnE "from 'expo-(contacts|sms)'" app lib components` matches only `lib/contactPicker.native.ts`). Criterion 54 checks what actually matters: **what ends up in the built web files**.

The check is "search the web build for two names that only the native libraries contain, `presentPicker` and `sendSMSAsync`, and find nothing". A search that finds nothing proves nothing unless you've shown it *can* find something (lessons log, 2026-11-21). So QA did it in three steps (decisions PI-N-9 and PI-C-8 in `docs/decisions-to-review.md`):
1. **Show the strings exist somewhere.** `npx expo export -p ios` into a scratch folder. The iOS bundle is Hermes bytecode (a `.hbc` file), which is binary. The shell's default `grep` on this Mac is ugrep, and it **silently skips binary files**, so the first search found nothing. `/usr/bin/grep -a -c` (`-a` = treat binary as text) found `presentPicker` once and `sendSMSAsync` once. So the search works, and the strings really are in the native bundle.
2. **Search the web build.** A fresh `npm run export:web`, then the same search over every file in `dist/_expo/static/js/web/`: no match for either string.
3. **Show the web search can find things too.** The same search for `Claim what you had on SplitIt` (the invite message, which the web app does use) matched the web entry bundle.

Before Task 10, nothing imported `lib/contactPicker` yet, so neither bundle contained the strings and the check would have passed for the wrong reason. It was marked "not verifiable yet" and run again after Task 10 (PI-N-9).

## Pitfalls
- **Importing the native library anywhere else.** One stray `import ... from 'expo-contacts'` in a component puts it back in the web bundle. Keep all native imports in the `.native.ts` file, and keep criterion 53's search passing.
- **Importing the platform file by its full name.** `import ... from './contactPicker.native'` skips Metro's choice and puts the native file in every build. Always import the base name.
- **Putting shared constants in the native file.** If web code needs a constant or type, it must live in the plain file (or another shared file). Otherwise the web side has to import the native file to get it.
- **Mixing `.ts` and `.tsx`.** Metro tries extensions before platforms (Metro docs: with the default extension order, `Button.js` wins over `Button.ios.ts`). Give every file of a pair the same extension.
- **Trusting TypeScript to check both files.** `tsc` only reads the plain file for callers. Tie the native file to the shared type explicitly, as `createContactPicker(...): ContactPicker` does.
- **Trusting an empty search.** Binary bundles, skipped files and untracked files all make a search return nothing. Show it can find a known string first, on the same files, with the same tool.
- **Forgetting the Jest platform.** Jest picks the native file by default, so a native library that can't load under Jest breaks unrelated screen tests. Give it a stand-in in the shared Jest setup.

## Check yourself
1. `components/ContactInvite.tsx` imports `@/lib/contactPicker`. Which file does an iPhone build get? A web build? `npm run typecheck`?
2. Why does `lib/contactPicker.ts` exist at all, if web never shows "From contacts"?
3. A new component adds `import * as SMS from 'expo-sms'` to send a reminder. What breaks, and how would criteria 53 and 54 catch it?
4. QA's first search of the iOS bundle for `presentPicker` found nothing. What was wrong, and why did that matter for trusting the web result?
5. Why did a screen test that never taps "From contacts" still need the stand-ins in `test-utils/jestSetup.ts`?

## Learn more
- Metro, module resolution (the order of platform, `.native` and plain files; `preferNativePlatform`): https://metrobundler.dev/docs/resolution/
- React Native, platform-specific code (`.ios.js`, `.android.js`, `.native.js`): https://reactnative.dev/docs/platform-specific-code
- Expo Router, platform-specific modules (extensions outside the `app/` folder): https://docs.expo.dev/router/advanced/platform-specific-modules/
- Expo, Contacts (SDK 57): https://docs.expo.dev/versions/v57.0.0/sdk/contacts/
- Expo, SMS (SDK 57): https://docs.expo.dev/versions/v57.0.0/sdk/sms/
