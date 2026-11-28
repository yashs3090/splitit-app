# Local notifications (the "Did it go through?" check-in)

## The idea
A phone notification is the banner that slides down from the top of the screen, even when the app isn't open. There are two kinds, and they work very differently:

- **A push notification** is sent **from a server**. Your server asks Apple's push service (APNs) or Google's (FCM) to deliver a message to a device. That needs a server, a push key, each device's push token, and on iOS a **push entitlement**: a permission baked into the signed app that only paid Apple Developer accounts can sign.
- **A local notification** is scheduled **by the app on the same phone**. The app says to the operating system: "in 60 seconds, show this text". From then on the **OS** owns the timer. The app can be in the background, paused or even killed, and the banner still appears. No server, no push service, no token, no entitlement.

An everyday comparison: push is someone phoning you; local is setting an alarm on your own phone.

Two more words you'll see:
- **Permission.** On iOS (and Android 13+), an app must ask before it may show notifications. iOS shows its own "Allow / Don't Allow" prompt, once. After "Don't Allow", only the Settings app can change it.
- **Category and actions.** A notification can carry buttons (long-press it on iOS). The app registers a **category** (a named set of buttons) once, then tags each notification with it.

## Why it matters here
Sam taps **Pay Hana $15.10 on Venmo**. SplitIt records "Sent via Venmo" and opens Venmo ([ADR 0024](../decisions/0024-sent-via-venmo-and-payment-methods.md)). But maybe he never pressed Pay inside Venmo. Someone has to ask. Sam is inside Venmo at that moment, not in SplitIt, so an in-app card can't reach him. A banner can.

The question only concerns Sam, only on Sam's phone, about something Sam just did. That's exactly what a local notification is for. Push would need a server, which SplitIt deliberately doesn't have ([ADR 0010](../decisions/0010-on-device-ocr-no-custom-backend.md)), and a paid Apple account, which the user doesn't have yet.

So: **one minute** after Venmo opens (the user's number, `SENT_CHECK_DELAY_SECONDS = 60`), Sam's phone shows "Did your $15.10 to Hana go through?" with **Yes** and **No, undo**. Hana, the payer, gets no notification at all; she sees "Sam sent you $15.10" on Home ([in-app notices](in-app-notices.md)).

## How we use it
Spec: `docs/specs/2026-11-26-sent-via-venmo.md` (D3, Task 8). The facts about the library were checked in the installed package source: `docs/specs/2026-11-26-sent-via-venmo-notifications-check.md`.

### The files
- `lib/checkInNotifications.native.ts`: the **only** file that imports `expo-notifications` (`createCheckInNotifications`, exported as `checkInNotifications`).
- `lib/checkInNotifications.ts`: the **web** version. It does nothing and never imports the package. On web, `expo-notifications` would throw on some calls (one of them during render) and `requestPermissionsAsync` would pop up the browser's real notification prompt. Both files `satisfies` the type in `lib/checkInNotifications.types.ts`, so they can't drift apart ([platform-specific files](platform-specific-files.md)).
- `lib/sentCheck.ts`: pure rules with no package import: the content (`sentCheckNotification`), the device keys, the inline question (`sentCheckInline`) and the undo rule (`undoDecision`).
- `components/SentCheckResponder.tsx`: listens for taps on the notification. Mounted once in `app/(app)/_layout.tsx`.
- `test-utils/jestSetup.ts`: a stand-in for `expo-notifications` whose every call fails with "expo-notifications not mocked in this test", so a test that forgets its own mock can never schedule anything.

### 1. Push entitlement removed, for the free Apple account
`expo-notifications`' config plugin **always** adds `aps-environment` (the push entitlement) to the iOS app. It has no option to turn that off, and it runs even if `app.json` doesn't list it. A free Apple ID (a "Personal Team") can't sign that entitlement, so the build would fail. Local notifications don't need it.

The fix is our own tiny config plugin, `plugins/withoutPushEntitlement.js`. It deletes `aps-environment` during prebuild (`ios/` is generated, so we never edit it by hand; [ADR 0012](../decisions/0012-receipt-capture-and-recognition-libraries.md)).

**The order in `app.json` is backwards from what you'd guess.** Expo's config mods run in reverse: a plugin listed **later** runs **earlier**. So our deleting plugin must be listed **before** `"expo-notifications"`:

```json
"plugins": [
  …,
  "./plugins/withoutPushEntitlement",
  "expo-notifications"
]
```

Then `expo-notifications` adds the key first, and ours removes it afterwards. The Task 8 agent proved it by running both orders: the reversed order kept `aps-environment: development`; this order left an empty entitlements file. `__tests__/appConfig.test.ts` checks both the order and the result. `app.json` can't hold comments, so the rule is written in ADR 0024 and in the plugin's header.

Status: whether a Personal Team build really **signs and installs** with the key removed has only been shown by reading the source, not on a device (user check U1(a)). If remote push is ever added (paid account plus an APNs key), delete the plugin.

### 2. Asking permission, once, at the right moment
- **When:** the first time Sam taps a Venmo Pay button on this device, before Venmo opens. "Ask when first needed" (the user's rule). While the answer is still unknown, the card shows "We'll check back in a minute to make sure it went through." (native only).
- **What we ask for:** alert and sound, nothing else: `requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true } })`. Not "provisional" permission, which iOS delivers quietly to Notification Center with no banner. That would defeat the point.
- **How we read the answer:** from `ios.status` (0 not asked, 1 denied, 2 allowed, 3 provisional, 4 ephemeral), not from the top-level `granted`. The package reports provisional as "not granted", which is misleading.
- **Once per device:** the flag `splitit.notifAsked.v1` is written before the prompt. If storage fails, we don't ask.
- **Denied:** nothing changes on screen. No nagging, no "turn it on" link. The inline question (below) still works.
- **Android 13+:** the prompt only appears once a notification channel exists, so the app creates the `sent_check` channel first. *Unverified on a device.*

### 3. Scheduling, with a time limit, before Venmo opens
The send order on a phone is **record → schedule → open** (`useVenmoSend` in `lib/useVenmoSend.ts`). The schedule happens **before** Venmo opens because, once Venmo is in front, iOS may pause SplitIt's JavaScript within seconds, and a schedule that hasn't reached the OS yet is lost. Once the OS has it, SplitIt can be paused or killed and the banner still shows.

- It only schedules if the mark was just created and permission is granted.
- It has a 1-second limit (`SCHEDULE_TIMEOUT_MS`). A slow schedule never holds up Pay. One that lands after the limit is cancelled again, so "no notification" stays true.
- The notification: title `SplitIt`, body `Did your $15.10 to Hana go through?`, **no sound, no badge**. Its `data` holds only ids, cents and a time, never item names or the bill name. People who hide previews on the lock screen see `Check your SplitIt payment` instead (the category's `previewPlaceholder` option).
- Its id names the user, the bill, the payer and the mark's time: `sentcheck.<userId>.<billId>.<payerId>.<markAtMs>`. Ids may only use letters, digits, `.`, `-` and `_`, because SecureStore keys can't contain `:` (pitfall below).
- "More" sends (`Pay Hana $1.10 more`) get **no** check-in.
- No notifications on web, and none for cash.

### 4. The buttons
The `sent_check` category has two actions:
- **Yes** (`opensAppToForeground: false`): doesn't open the app and writes nothing to the server. If our code gets to run, it stores `'yes'` on the device so the inline question doesn't ask again. A lost "Yes" is harmless: the question may show once more.
- **No, undo** (`opensAppToForeground: true`, `isDestructive: true`): opens SplitIt, runs the undo rule, then goes to the bill's Settle page.

We always pass `opensAppToForeground` explicitly. The package's type docs say it defaults to `true`, but its iOS code only opens the app when it's explicitly `true`.

Tapping the notification's body just opens the Settle page.

### 5. Cancel **and** dismiss when Sam comes back
If Sam returns to SplitIt before the minute is up, the notification is pointless: SplitIt shows the same question inline on his card ("Did it go through?", Yes / No, undo). So when the app goes from **background → active**, `useVenmoSend` cancels every pending check-in for the signed-in user.

"Cancel" needs two calls:
- `cancelScheduledNotificationAsync(id)` removes a notification that **hasn't fired yet**;
- `dismissNotificationAsync(id)` removes one that **already fired** and is sitting in Notification Center.

Cancel alone would leave an old banner behind. Both also run on sign-out (`signOutThisDevice` in `lib/signOut.ts` calls `cancelAllSentChecks`) and when Sam undoes that mark in the app.

There's deliberately **no** `setNotificationHandler`. Without one, a notification that fires while SplitIt is already in front isn't shown at all, which is what we want: the inline question is right there.

### 6. The inline question and the one undo rule
The inline question shows on Sam's card when the mark is `venmo`, it's to the current payer, nobody has answered for this mark's key, and the mark is at most 30 minutes old (`SENT_CHECK_INLINE_MAX_MINUTES`, a starting value). It's shown once: leaving the screen stores `'shown'`. Answers live in one small blob per user on the device (`splitit.sentcheck.v1.<userId>`), pruned after 2 days.

"No, undo" from the card, the bill footer or the notification all run the same steps (`runSentCheckUndo` in `lib/sentCheckUndo.ts`, which uses `undoDecision`):
1. Already undone for this key → do nothing.
2. Re-read the bill. The mark is gone → remember "undone", say nothing.
3. The mark is still exactly this send (method, cents, time, payer) → clear it ("Undone. Not marked as sent.").
4. Anything else → clear nothing, and say "Your payment to Hana changed since then, so nothing was undone. Check below."

Re-reading first is what makes a late tap safe. If Hana already marked it "Not received", or Sam paid again since, step 4 stops the old notification from undoing something new.

### 7. Cold start and the resume gate
If SplitIt was **killed** and Sam taps "No, undo", iOS launches the app and hands it the tap. The notifications module reads it with the package's synchronous `getLastNotificationResponse()` (the async getter is deprecated) and, while the app is running, listens with `addNotificationResponseReceivedListener`. Both feed one hook, `useSentCheckResponses` in `lib/checkInNotifications.native.ts`, which marks each response as `cold` (it launched the app) or live. It handles each response once and then calls `clearLastNotificationResponse()`, so a remount doesn't handle it twice.

But at launch, another piece of code may also want to navigate: the **sign-in resume** in `app/_layout.tsx` (`ResumeAfterSignIn`), which sends you to an invite you opened before signing in. Two pieces of code both calling `router.push` at launch fight each other. The project rule from an earlier bug: **only the single resume effect navigates at launch** (lessons log, 2026-11-19).

So there's a small **resume gate**, `lib/resumeGate.ts`:
- `ResumeAfterSignIn` calls `settleResume('none')` when it had nothing to do, or `settleResume('signed_in')` when it navigated (or the app started signed out).
- The responder waits on `whenResumed()`. For a **cold-start** response it continues only if the answer is `'none'`. If the resume navigated, the cold-start response is dropped; Sam just sees the app, and the inline question still covers it.
- It never hangs: after 5 s (`RESUME_GATE_TIMEOUT_MS`) it answers `'timed_out'`, treated like `'signed_in'`.

Every response is checked before it's used: the ids must be UUIDs, cents a whole number in range, and `userId` must be the person signed in now. A notification for someone who has since signed out, or for another account on a shared phone, is ignored. The only navigation is `/bills/<billId>/settle`, built from the id, never from a URL in the data.

### 8. A new native module needs a new build
Adding `expo-notifications` adds native code, so the existing development build can't run it. Rebuild with `npx expo run:ios --device` ([CLAUDE.md](../../../CLAUDE.md), Commands).

### Why no server
Everything above runs on Sam's phone. The OS keeps the timer, the app keeps the answers on the device, and the only server calls are a re-read of the bill and the same `unmark_paid` the Undo button already uses. A push to Hana ("Sam sent you money") would need a server holding device tokens and an APNs key, plus a paid Apple account. The user chose not to notify Hana (decision 3), so none of that is needed.

## Pitfalls
- **Calling a push-token API "to be ready".** `getDevicePushTokenAsync` / `getExpoPushTokenAsync` register for remote push, which needs the entitlement we removed. The rule for this app: never call them (criterion 56 greps for them).
- **Listing the entitlement plugin after `expo-notifications`.** Mods run in reverse order, so it would run first, find nothing to delete, and the key would be added afterwards. The build then fails to sign with a free account.
- **Trying to remove the entitlement through `ios.entitlements` in `app.json`.** That merge can only add keys, and an empty value gets overwritten by the plugin.
- **Scheduling after opening Venmo.** iOS can pause JavaScript as soon as another app is in front; the schedule may never reach the OS.
- **Cancel without dismiss.** Cancelling only stops pending notifications. One that already fired stays in Notification Center until you dismiss it too.
- **Trusting the top-level `granted`.** It says "not granted" for provisional permission. Read `ios.status`.
- **Relying on default action options.** `opensAppToForeground` behaves differently from its documented default on iOS. Pass it every time.
- **Importing `expo-notifications` in shared code.** On web it throws (one call during render) or shows the browser's permission prompt. Keep it in the `.native.ts` file.
- **Navigating from a notification at launch while another effect also navigates.** Two `router.push` calls at start-up race. Wait for the resume gate.
- **Trusting `data` in a notification.** Check every field against an allow-list and against the signed-in user. Never navigate to a URL taken from it.
- **Device keys with `:`** like `sentcheck:bill:123`. SecureStore throws. Use `.`.
- **Assuming a "Yes" from a killed app runs your code.** The package's docs say listeners don't fire for a non-opening action when the app was killed. Design "Yes" so that losing it is harmless.

## Check yourself
1. What's the difference between a local and a push notification? Which one needs a server, and which needs a paid Apple account?
2. `withoutPushEntitlement` is listed before `expo-notifications` in `app.json`. Why before and not after? What test catches a wrong order?
3. Why does the phone schedule the check-in **before** opening Venmo, and why does scheduling have a 1-second limit?
4. Sam comes back to SplitIt 20 seconds after paying. What happens to the notification, and where does the question show instead? Why are two calls needed to get rid of a notification?
5. SplitIt was killed. Sam taps "No, undo" on the notification, and at the same moment the app has a pending invite to resume. What does the resume gate decide, and what does Sam see?
6. Sam taps "No, undo" an hour later, after Hana already marked his payment "Not received" and he paid again in cash. Which step of the undo rule applies, and why is that the safe answer?
7. Why does the app ask for alert + sound permission and not "provisional"?

## Learn more
- Expo, Notifications (SDK 57): https://docs.expo.dev/versions/v57.0.0/sdk/notifications/
- Expo, iOS capabilities (push notifications and `aps-environment`): https://docs.expo.dev/build-reference/ios-capabilities/
- Expo, config plugins and mods: https://docs.expo.dev/config-plugins/introduction/
- Expo, SecureStore (allowed key characters): https://docs.expo.dev/versions/latest/sdk/securestore/
- Apple, `UNUserNotificationCenter` (local scheduling): https://developer.apple.com/documentation/usernotifications/unusernotificationcenter
- Apple, asking permission to use notifications: https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications
- Android, notification runtime permission (Android 13+): https://developer.android.com/develop/ui/views/notifications/notification-permission
