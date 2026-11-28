# Proposal: CLAUDE.md notes the notifications plugin order and the new dev build

**Status: pending**

**Target:** `CLAUDE.md` § Commands, the "Native features … need a **development build**" bullet

**Promotion rule used:** none of the repeat rules apply. This is a fact the next agent needs and could easily break, like the Jest-setup line in `2026-11-24-bundle-checks-jest-setup-tracked-items.md`. The docs-writer suggested it.

## Evidence (docs/lessons/log.md)
- 2026-11-27 "expo-notifications always adds the push entitlement; a local plugin listed before it strips it" [expo]:
  - A read-only spike found the `expo-notifications` config plugin always adds `aps-environment`, and the free Personal Team can't sign that.
  - `plugins/withoutPushEntitlement.js` deletes it. It has to be listed **before** `"expo-notifications"` in `app.json` `plugins`, because mods registered earlier run later (the file's header comment).
  - `__tests__/appConfig.test.ts` guards the order and the result.
  - Signing with the Personal Team is still **unverified on a device** (spec R1, docs/specs/2026-11-26-sent-via-venmo.md).

## Change: `CLAUDE.md` § Commands, one sentence added after the existing sentence ending "…Expo Go can't load that native code."

Old:
```
- Native features (camera + on-device text recognition) need a **development build**; Expo Go can't load that native code.
```

New:
```
- Native features (camera, on-device text recognition, local notifications) need a **development build**; Expo Go can't load that native code. Adding or changing a native module or an `app.json` plugin needs a new dev build. In `app.json` `plugins`, `./plugins/withoutPushEntitlement` must stay listed **before** `"expo-notifications"`: that package always adds the push entitlement, which the free Personal Team can't sign, and plugins listed earlier run later (`__tests__/appConfig.test.ts` checks the order). The app uses only local notifications; remove the plugin if remote push is ever added.
```
(Only the first sentence of the bullet changes; the rest of the bullet, from "Run `npx expo run:ios --device`…", stays as it is.)

**Before applying:** if the first device build in Task 8 showed that the Personal Team still can't sign, reword or drop the "free Personal Team can't sign" reason to match what happened.

## What this changes for you
Someone tidying `app.json` later won't reorder the plugins and quietly break free-team iPhone builds. And it's written down that notifications, like the camera, need a fresh dev build.
