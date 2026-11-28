# Sent via Venmo: expo-notifications check (Task 1, read-only)

Date: 2026-11-26. Agent: native-mobile. Companion to `docs/specs/2026-11-26-sent-via-venmo.md` (Task 1, Risk R1).

**Scope.** This is a read-only check. Nothing was installed. `package.json`, `app.json` and the code are unchanged, and no prebuild or device build was run. Sources used:

- **[PKG]**: the published `expo-notifications@57.0.26` tarball (`npm pack`), read from the scratchpad. File paths below are relative to the package root.
- **[PREBUILD]**: the project's installed `@expo/prebuild-config@57.0.21` and `@expo/config-plugins@57.0.13` (`node_modules/`), which run the plugins during prebuild.
- **[DOCS]**: the Expo SDK 57 docs, https://docs.expo.dev/versions/v57.0.0/sdk/notifications/ and https://docs.expo.dev/build-reference/ios-capabilities/.

Anything that only a device build can show is marked **Unverified (device)**. Anything these sources don't state is marked **Unverified (source)**.

## Verdict

**GO, with one condition.** The plugin always adds `aps-environment`, and there is no option to turn that off. A small local config plugin can remove the entitlement during prebuild, and local notifications don't need it. Whether the Personal Team build then signs and installs is **Unverified (device)**. It is the first thing Task 8 checks on the phone.

---

## 1. Version, development build, web

| Question | Answer | Source |
|---|---|---|
| Version `npx expo install` picks | SDK 57 pins `"expo-notifications": "~57.0.25"`. On npm today that range resolves to **57.0.26** (the `sdk-57` dist-tag, published 2026-11-23, "no user-facing changes"). The install writes `~57.0.25` (or the current `~57.0.x`) to `package.json`. | `node_modules/expo/bundledNativeModules.json` line 73 (expo 57.0.33); `npm view expo-notifications dist-tags`; [PKG] `CHANGELOG.md` |
| Needs a development build? | **For this app, yes**: SplitIt already ships native modules that Expo Go can't load (`expo-mlkit-ocr`). The docs say local notifications themselves still work in Expo Go: "Local notifications (in-app notifications) remain available in Expo Go"; only remote push is gone from Expo Go on Android. Adding the package changes native code, so a **new** dev build is needed. | [DOCS] notifications page |
| Web support for local scheduled notifications | **No.** The docs list only Android and iOS. The web build of the package has no scheduler. | [DOCS]; [PKG] `src/NotificationScheduler.ts` (only `addListener`/`removeListeners`) |
| On web: does it do nothing, or throw? | **It does different things per call.** These reject with `UnavailabilityError`: `scheduleNotificationAsync`, `cancelScheduledNotificationAsync` and `setNotificationCategoryAsync` ([PKG] `src/scheduleNotificationAsync.ts` lines 81-82, `src/cancelScheduledNotificationAsync.ts`, `src/NotificationCategoriesModule.ts`). `getLastNotificationResponse()` (so also `useLastNotificationResponse`) **throws synchronously** (`src/NotificationsEmitter.ts` lines 125-128), which would crash a render. `addNotificationResponseReceivedListener` only `console.warn`s once and has no effect (`src/NotificationsEmitterModule.ts`). `requestPermissionsAsync` **shows the browser's real Notification prompt** (`src/NotificationPermissionsModule.ts`, `Notification.requestPermission`). | [PKG] |

**Consequence for Task 8:** keep the spec's split: `lib/checkInNotifications.native.ts` imports `expo-notifications`, and `lib/checkInNotifications.ts` is a web no-op that never imports it. Importing it on web would crash the hook and could prompt the user.

## 2. Free Apple ID (Personal Team) and the push entitlement

**Does the plugin add `aps-environment` unconditionally? Yes.** From [PKG] `plugin/src/withNotificationsIOS.ts`:

```ts
16 export const withNotificationsIOS: ConfigPlugin<NotificationsPluginProps> = (
17   config,
18   { mode = 'development', sounds = [], enableBackgroundRemoteNotifications }
19 ) => {
20   config = withEntitlementsPlist(config, (config) => {
21     if (!config.modResults['aps-environment']) {
22       config.modResults['aps-environment'] = mode;
23     }
24     return config;
25   });
```

The docs say the same: "The iOS APNs entitlement is *always* set to 'development'." No plugin option skips it. The full option list is `icon`, `color`, `defaultChannel`, `sounds`, `mode` and `enableBackgroundRemoteNotifications` ([PKG] `plugin/src/withNotifications.ts` lines 8-46). `mode` only picks `'development'` or `'production'`.

**It runs even if `app.json` doesn't list it.** `expo-notifications` is one of the "versioned" auto plugins. Prebuild applies them to every autolinked package ([PREBUILD] `withDefaultPlugins.js` line 171, `versionedExpoSDKPackages` includes `'expo-notifications'`; `getPrebuildConfig.js` line 56 `withVersionedExpoSDKPlugins`; `createLegacyPlugin.js` → `withStaticPlugin({ plugin: 'expo-notifications' })`). Leaving it out of `plugins` doesn't avoid the entitlement.

**Can a Personal Team sign it? No (Unverified (source)).** The Expo docs don't mention Personal Teams or free accounts, and the capabilities page only maps Push Notifications to `aps-environment`. The belief that a free team can't sign `aps-environment` comes from Xcode's signing error for personal teams ("Personal development teams … do not support the Push Notifications capability"). That is Apple behaviour, not covered by the allowed sources. Confirm it on the first device build.

**Supported ways to use local notifications without the push entitlement:**

| Option | Works? | Why |
|---|---|---|
| A plugin option | **No** | None exists (see the option list above). |
| `app.json` `ios.entitlements` | **No** | The entitlements provider merges `ios.entitlements` over the file, and that merge can only add keys. Its own comment says "This will enable people to actually remove values" is a TODO ([PREBUILD] `@expo/config-plugins/build/plugins/withIosBaseMods.js` lines 352-358). A falsy value such as `""` or `false` gets overwritten by line 21 above (`if (!config.modResults['aps-environment'])`). |
| **A small local config plugin that deletes the key** | **Yes (by source reading; Unverified (device))** | It uses `withEntitlementsPlist` with `delete config.modResults['aps-environment']`. This is the normal config-plugin mechanism; `ios/` is never edited (CNG, ADR 0012). |
| Editing `ios/*.entitlements` by hand | Not allowed | `ios/` is generated and gitignored. Prebuild would undo the edit. |

**Order matters, and it runs opposite to what you'd expect.** A `withMod` action runs its own step first and then calls the mod registered **before** it ([PREBUILD] `@expo/config-plugins/build/plugins/withMod.js` lines 186-202: `const results = await action(...); return nextMod(results);`). So mods registered **later run earlier**. Because of that, the deleting plugin must be **registered before** expo-notifications so that it runs **after** it:

- If `expo-notifications` is listed in `app.json` `plugins`, put the local plugin **earlier in the array** than `"expo-notifications"`.
- If it isn't listed, the auto plugin registers after every `app.json` plugin, so any position in `plugins` runs after it.

I wanted to confirm this order by running a scratch simulation (`compileModsAsync` with introspection, using the project's `@expo/config-plugins` and the extracted plugin). The sandbox denied that run, so this conclusion comes from reading the source and has not been executed. Task 8 must prove it in two ways:

1. a unit test in `__tests__/appConfig.test.ts` that introspects the iOS entitlements (`getPrebuildConfigAsync` and `compileModsAsync` with `introspect: true`) and asserts `aps-environment` is absent;
2. after `npx expo prebuild --platform ios --no-install` in a scratch copy, `ios/SplitIt/SplitIt.entitlements` has no `aps-environment`.

**Nothing in the package needs the entitlement for local notifications.** It calls `registerForRemoteNotifications()` only inside `getDevicePushTokenAsync` ([PKG] `ios/ExpoNotifications/PushToken/PushTokenModule.swift` line 44). The auto-registration side effect runs only if `setAutoServerRegistrationEnabledAsync(true)` was called earlier (`src/DevicePushTokenAutoRegistration.fx.ts`). Scheduling uses `UNUserNotificationCenter.current().add(request)` (`ios/.../Scheduling/SchedulerModule.swift` line 46), which needs no entitlement. Rule for the slice: **never call `getDevicePushTokenAsync` / `getExpoPushTokenAsync`.**

## 3. Local scheduling API on SDK 57

All of it comes from [PKG] `src/`, via `import * as Notifications from 'expo-notifications'`.

**Schedule N seconds from now.** This is the current form. `repeats` defaults to `false` (`scheduleNotificationAsync.ts` lines 298-319), and iOS maps it to `UNTimeIntervalNotificationTrigger(timeInterval: seconds, repeats:)` (`ios/.../TriggerRecords.swift` lines 79-92).
```ts
await Notifications.scheduleNotificationAsync({
  identifier: key,                       // optional; else a uuid. Returned as the id.
  content: { title, body, data, categoryIdentifier: 'sent_check' },
  trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 60, repeats: false },
});
```
`SchedulableTriggerInputTypes.TIME_INTERVAL === 'timeInterval'` (`Notifications.types.ts` line 270). An `undefined` trigger throws; `null` fires immediately (lines 97-105). Android's inexact fallback (next paragraph) is **Unverified (device)**.

On Android the trigger uses `setExactAndAllowWhileIdle` only when exact alarms are allowed. Otherwise it falls back to `setAndAllowWhileIdle`, which is inexact (`android/.../ExpoSchedulingDelegate.kt` lines 105-121), so the 60 s can drift.

**Cancel by identifier.** Call `Notifications.cancelScheduledNotificationAsync(identifier)`. On iOS this is `removePendingNotificationRequests(withIdentifiers:)` (`SchedulerModule.swift` line 141). It removes **pending** requests only. A notification that already **fired** stays in Notification Center. To clear that one too, also call `Notifications.dismissNotificationAsync(identifier)`. The spec's "cancel on return to active" should do both. Use `getAllScheduledNotificationsAsync()` to cancel every pending `sent_check` for a user (filter on `content.data.userId`).

**Categories with action buttons.** Register the category once, before scheduling (for example at startup on native):
```ts
await Notifications.setNotificationCategoryAsync('sent_check', [
  { identifier: 'yes',  buttonTitle: 'Yes',       options: { opensAppToForeground: false } },
  { identifier: 'undo', buttonTitle: 'No, undo',  options: { opensAppToForeground: true, isDestructive: true } },
]);
```
`isDestructive` is iOS-only (`Notifications.types.ts` lines 715-734).

**The docs and the iOS code disagree on the default.** The type doc says `opensAppToForeground` "@default true". The iOS native code adds `.foreground` only when the value is explicitly `true` (`TriggerRecords.swift` lines 271-274: `if optionsParams.opensAppToForeground == true { notificationOptions.insert(.foreground) }`). **Always pass it explicitly.**

**How an action response reaches JS:**
- Listener: `Notifications.addNotificationResponseReceivedListener(r => …)`. `r.actionIdentifier` is `'yes'` / `'undo'`, or `Notifications.DEFAULT_ACTION_IDENTIFIER` (`'expo.modules.notifications.actions.DEFAULT'`) for a tap on the body. `r.notification.request.identifier` is the key, and `r.notification.request.content.data` is the data.
- Cold start: `Notifications.getLastNotificationResponse()` is synchronous. `getLastNotificationResponseAsync()` is `@deprecated` in the source (`NotificationsEmitter.ts` lines 112-129). The hook is `Notifications.useLastNotificationResponse()`; it returns `undefined` until it knows, then `null` or the response. Use `clearLastNotificationResponse()` after handling, so that a re-mount doesn't handle the same response twice.
- **Natively**, if no JS-side delegate exists yet, iOS responses are queued in `pendingResponses`. When the emitter module is created they are delivered and stored as `lastResponse` (`NotificationCenterManager.swift` lines 124-131 and 170-182; `EmitterModule.swift` lines 35-40).
- **App in the foreground or suspended in memory:** the listener fires. For a background action (`opensAppToForeground: false`), whether the JS thread actually runs in the short time iOS wakes the app is **Unverified (device)**.
- **App killed, background action ("Yes"):** the docs (type comment, lines 728-731) say: "If `false` and your app is killed (not just backgrounded), `NotificationResponseReceived` listeners will not be triggered." `registerTaskAsync` doesn't help on iOS: "Only on Android, the task also runs in response to a notification action tap when the app is backgrounded or terminated" (`registerTaskAsync.ts` line 7). From the native queueing above, a killed-app "Yes" *may* show up later as the last response when the user next opens the app. **Unverified (device).** Task 5/8 must treat "yes" as idempotent and non-navigating. The spec already has "Yes writes nothing to the server", so a lost or late "Yes" is harmless, and a "Yes" action needs **no JS to run** for correctness.
- **App killed, foreground action ("No, undo") or a body tap:** the app launches, and the response is available from `getLastNotificationResponse()` / the hook.

**Deep link on tap.** The documented Expo Router pattern ([DOCS]) is: in the root (here, the signed-in) layout, read `getLastNotificationResponse()` once and add `addNotificationResponseReceivedListener`, then `router.push(...)` from the response's `data`. For SplitIt, build the route from `data.billId`, never from a URL in `data`. Map it through an allow-list (lesson 2026-11-19, "Never echo URL-supplied text"), and run it only after the resume effect (lesson 2026-11-19, "Only the single resume effect navigates").

**Foreground presentation.** Scheduling alone doesn't show a notification while the app is in front. You need `setNotificationHandler`, and "the default behavior when the handler is not set or does not respond in time is not to show the notification" ([DOCS]; `scheduleNotificationAsync.ts` lines 19-22). The slice cancels on return to `active`, so it can leave the handler unset. If the notification fires while SplitIt is in front, nothing shows, which is what we want.

## 4. Permissions

**iOS.** The call is `Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true } })`. With no argument it asks for alert + badge + sound (`NotificationPermissions.ts` lines 59-66). To ask for provisional authorization, pass `ios: { allowProvisional: true }` (`NotificationPermissions.types.ts` line 87). Provisional authorization asks the user nothing, and notifications are posted quietly. The docs describe `PROVISIONAL` as "quiet, non-interruptive". Notifications then go to Notification Center **without a banner** (Apple behaviour; **Unverified (source)** beyond the docs' "non-interruptive"). That would defeat the purpose of the check-in, so **ask for full authorization** (alert + sound, no badge).

The root `status` / `granted` fields map only `.authorized` → granted and `.denied` → denied. **Provisional and ephemeral come back as `undetermined` / `granted: false`** (`ios/.../ExpoNotificationsPermissionsRequester.swift` lines 37-45). The docs say to "rely on the `NotificationPermissionsStatus`'s `ios.status` field" (`IosAuthorizationStatus`: 0 not determined, 1 denied, 2 authorized, 3 provisional, 4 ephemeral). iOS needs no usage-description string for notifications ([DOCS]). Denied means only Settings can change it, so offer `Linking.openSettings()`. For SplitIt the notification is optional and the inline question covers a denial, so no blocking UI is needed.

**Android 13+ (API 33) `POST_NOTIFICATIONS`.**
- The package's own manifest declares `<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>` and `RECEIVE_BOOT_COMPLETED`; manifest merge adds them ([PKG] `android/src/main/AndroidManifest.xml` lines 2-3). No `app.json` change is needed. Don't add it to `android.blockedPermissions`.
- It's a runtime permission. `requestPermissionsAsync()` triggers the OS prompt, but per the docs the prompt "will not appear until at least one notification channel is created". So call `setNotificationChannelAsync('sent_check', { name, importance: AndroidImportance.HIGH })` first. A HIGH importance channel is what makes a heads-up banner appear (Unverified (device)).
- Android isn't in the user's test plan (iPhone). Treat everything Android here as **Unverified (device)**.

## 5. Will iOS deliver a 60-second local notification while Venmo is in front?

**Yes, by design; Unverified (device).** `scheduleNotificationAsync` hands the request to `UNUserNotificationCenter` (`SchedulerModule.swift` line 46). From then on the **OS** owns the trigger. SplitIt doesn't need to be running, and suspension or termination don't cancel it. The foreground-presentation hook (`willPresent` → `setNotificationHandler`) is only consulted when **SplitIt** is the foreground app (`NotificationCenterManager.swift` lines 155-166). With Venmo in front, iOS presents the notification itself, with a banner, provided **all** of these hold:

- the user granted **full** (not provisional) authorization with alerts;
- banners are on for SplitIt in Settings → Notifications, and no Focus / Do Not Disturb or Scheduled Summary is holding it back;
- the request was **added before SplitIt was suspended**.

That last point matters for implementation. Once `Linking.openURL(venmo…)` runs, SplitIt goes to the background, and JS can be suspended within seconds. **Await `scheduleNotificationAsync` first, then open Venmo** (or schedule in the same tick as the open, and accept that a slow schedule can be lost). The spec's D2 step order should put scheduling before the open, with a short time limit so a hung schedule never blocks the Pay tap.

---

## Recommendation for the Personal Team question (R1)

Take option (a) from the spec's "Needs your look" item 1: **strip the entitlement with a local config plugin.** No paid account is needed.

1. Task 8 adds `plugins/withoutPushEntitlement.js` (CommonJS, about 10 lines). It uses `withEntitlementsPlist` with `delete config.modResults['aps-environment']`. A header comment says why: local-only notifications, free Personal Team, ADR reference.
2. In `app.json` `plugins`, list it **before** `"expo-notifications"`, or don't list `expo-notifications` at all. `app.json` can't hold comments, so record the ordering rule in the sent-via-Venmo ADR. A test guards the order regardless.
3. Add an `__tests__/appConfig.test.ts` case that introspects iOS entitlements and asserts there is no `aps-environment`. Also check that the existing `app.config.ts` Universal Links path (`APPLE_TEAM_ID` set) still has `associated-domains` and still has no `aps-environment`.
4. Never call push-token APIs. If push ever arrives (it would need a paid team and APNs keys), delete the plugin then. Add an item to `docs/before-production.md`: "push entitlement stripped for the free team; remove if remote push is added".
5. First device step in Task 8: `npx expo run:ios --device` with the Personal Team. Expected result: it signs, installs, and the 60 s check-in banner shows over Venmo. If Xcode still refuses, stop and take it to the user (options (b) paid account or (c) inline-only). The rest of the slice ships either way, because the inline question covers every platform.

## What still needs a device

- That the Personal Team build signs with the entitlement removed, and that the plugin order works in a real prebuild.
- That the banner appears over Venmo after 60 s, and that cancel + dismiss on return removes it.
- Background "Yes" with the app suspended vs. killed: does the listener run, and does a stale last response show up on the next launch?
- "No, undo" from a killed app arrives through `getLastNotificationResponse()` and routes after the resume effect.
- Everything on Android (channel, POST_NOTIFICATIONS prompt, inexact alarm drift).
