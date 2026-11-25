# Realtime (live claiming)

## The idea
Normally a client **pulls** data: it asks the server, gets an answer, and is out of date a second later. For live claiming we want the server to **push** news of changes. Supabase Realtime keeps a **WebSocket** (a long-lived two-way connection) open between each phone and Supabase, and sends messages over named **channels**.

Supabase Realtime has three features:
- **Postgres Changes:** stream row changes (`INSERT`/`UPDATE`/`DELETE`) from tables.
- **Broadcast:** send small messages to everyone on a channel. The database itself can send them, from a trigger, with `realtime.send(...)`.
- **Presence:** track who's online. We don't use it.

**SplitIt uses Broadcast from the database, and the messages carry no data.** A message only says "something in this bill changed". Each phone then **re-reads the bill through the normal RLS-protected queries**. The message is a doorbell, not a parcel.

```ts
// lib/billLive.ts (simplified)
await client.realtime.setAuth();                       // send the user's token first
client.channel(`bill:${billId}`, { config: { private: true } })
  .on('broadcast', { event: 'changed' }, () => refetchSoon())   // payload ignored
  .subscribe((status) => { if (status === 'SUBSCRIBED') refetchSoon(); });
```

## Why it matters here
Five friends are claiming items at the same table. Everyone should see "Ben took the fries" within a second or two, and see the host's edits without pulling to refresh.

We chose data-free broadcasts over `postgres_changes` because:
- **They leak nothing.** The message is `{"t": "claims"}` (the table name). No ids, names or amounts. Even if the wrong person somehow got it, they'd learn nothing.
- **Deletes are awkward with `postgres_changes`.** Its delete events can't be filtered by `bill_id`, and under RLS the old record of a delete carries only the primary key *(spec-era reading of the Supabase docs; unverified against the current docs, and the decision stands either way)*.
- **Who may listen is an RLS policy we can test with pgTAP** (see below).
- **The data we show is always what the database returns now**, not something pieced together from a stream of events.

## How we use it
### 1. The database sends a hint
Triggers on `claims` (insert, update, delete), `bill_participants` (insert; update since M3; delete since People; see below) and `bills` (update) call `private.broadcast_bill_change()` (`supabase/migrations/20261121075448_bill_edit_realtime.sql:152-182`, triggers at `:188-216`). It sends event `changed` on the **private topic `bill:<bill id>`**:

```sql
perform realtime.send(jsonb_build_object('t', tg_table_name), 'changed', 'bill:' || v_bill_id::text, true);
```

- The triggers are **statement-level**, so one edit that deletes ten claims sends one hint, not ten.
- There's **no trigger on `line_items`**. Every item change happens inside `update_bill`, which also updates `bills.edited_at`, so the `bills` trigger fires.
- Activity events need no trigger of their own: they're always written together with one of these changes ([audit log](audit-log.md)).
- `realtime.send` turns its own errors into warnings, so a failed broadcast never fails the user's claim (checked against the installed stack; see the migration's header comment).

#### Added in M3 (2026-11-24): a hint when participant rows are updated
"I paid" marks live on `bill_participants` rows (`settled_at`, `settled_cents`). Until M3, nothing ever *updated* those rows, so only inserts (someone joining) sent a hint. M3 adds one more trigger that reuses the same function (`supabase/migrations/20261124081411_settle_payer.sql:160-164`):

```sql
create trigger bill_participants_broadcast_update
  after update on public.bill_participants
  referencing new table as new_rows
  for each statement
  execute function private.broadcast_bill_change();
```

- `referencing new table as new_rows` gives the trigger a **transition table**: every row the statement changed, after the change. The function loops over the distinct `bill_id`s in it and sends one hint per bill.
- So when `set_payer` clears 3 marks with one `UPDATE`, phones get **one** `{"t": "bill_participants"}` hint, not three (pgTAP: `supabase/tests/database/settle_payer.test.sql:295-311`, criterion 11).
- An `UPDATE` that matches **no rows** sends nothing, because the loop has no bill ids. That's what happens when someone taps "I paid" twice: the second `mark_paid` updates 0 rows, so there's no event and no hint.
- No client can update `bill_participants` directly (no grant), so these hints only come from `mark_paid`, `unmark_paid`, `set_payer` and the payer-deletion trigger. *(Since 2026-11-24 also from `join_bill`, when someone who was added opens the link and their row turns from "added" to "joined", review R6.)*

#### Added for People (2026-11-24): a hint when participant rows are deleted
Until now nobody could leave a bill, so participant rows were only ever inserted or updated. The People slice added `remove_participant` (the host takes someone off) and `leave_bill` (you take yourself off), both [database functions](database-functions.md). Each deletes one `bill_participants` row. Without a hint, Hana's screen would keep showing Sam until she pulled to refresh.

So there's a third participant trigger, again reusing the same function (`supabase/migrations/20261124091042_membership.sql:177-181`):

```sql
create trigger bill_participants_broadcast_delete
  after delete on public.bill_participants
  referencing old table as old_rows
  for each statement
  execute function private.broadcast_bill_change();
```

- For a delete there are no "new" rows, so this one references the **old** table: the rows as they were before the delete. `broadcast_bill_change` already had a `DELETE` branch that reads `old_rows` (`20261121075448_bill_edit_realtime.sql:161-166`, written for claim deletes), so no change to the function was needed.
- Postgres only allows a transition table on a trigger for one kind of event, which is why `bill_participants` has three separate triggers (insert, update, delete) instead of one.
- **What each phone sees when Sam leaves:**
  - Hana's and Cy's phones get `{"t": "bill_participants"}`, refetch, and Sam's row disappears. If the Activity screen is open, it refetches on the same hint and shows "Sam left" (usually "Someone left", because the app can't read Sam's name once he's off the bill).
  - Sam's own phone may get the hint too, because channel access is checked when you join, not per message (see "Only participants may listen" below). His refetch now goes through RLS as a non-participant, so `fetchBill` returns `not_found`, and `useBill` switches the screen to its "not found" state (`lib/useBill.ts:78-79`). The hint itself told him nothing. In practice Sam usually isn't on that screen any more: after "Leave", the app goes to Home.
- A bill deleted outright also cascades its participant rows through this trigger. The hint goes to a topic nobody can read any more, and it carries no data, so that's harmless (migration header, `:174-176`).
- pgTAP checks the trigger's shape (after delete, per statement, `old_rows`), that one remove sends exactly one hint on `bill:<id>`, and that the insert and update triggers are still there (`supabase/tests/database/membership.test.sql:226-229`, `:324-342`, criterion 20).

### 2. Only participants may listen
A channel created with `{ config: { private: true } }` is a **private channel**. Supabase decides whether you may join by checking RLS policies on the `realtime.messages` table, and `realtime.topic()` tells the policy which topic you're asking for. Our policy (`20261121075448_bill_edit_realtime.sql:251-258`):

```sql
create policy "bill_topic_participants_receive" on realtime.messages
  for select to authenticated
  using (topic = (select realtime.topic())
         and private.can_listen_bill_topic((select realtime.topic())));
```

- `private.can_listen_bill_topic` (`:229-241`) checks the topic is exactly `bill:<uuid>` and that you're a participant. A malformed topic returns false instead of raising an error.
- There's **no insert policy**, so clients can't send messages on these channels. Only our triggers can.
- Supabase checks permissions **when you join the channel**, not on every message. If someone is removed from a bill, they could keep receiving hints until their token is refreshed. That's harmless here, because the hint has no data and the refetch goes through RLS. *(Since 2026-11-24 this really happens: people can be removed or leave. See the delete hint above.)*
- For production, private channels must be enforced by turning off "Allow public access" in the Realtime settings (`docs/before-production.md` §4).

### 3. The phone refetches
`subscribeToBill` (`lib/billLive.ts:130-177`):
- **Calls `setAuth()` before joining** (`:97-102`). supabase-js only passes a new token to Realtime when you sign in or the token refreshes, **not when a saved session is restored** at app start. Without this, a private join after an app restart would go out with the anon key and be refused. (Found while building against supabase-js 2.109; see the file's header comment.)
- **Ignores the message body** (`:110-112`). Every message just schedules a refetch.
- **Debounces** for 300 ms (`LIVE_DEBOUNCE_MS`, `:26`, used at `:83-89`). Three claims in quick succession give one refetch, not three.

#### How several raw messages become one refetch
"Debounce" means: when a message arrives, start a 300 ms timer; if another message arrives before it fires, **restart** the timer. The refetch runs only once things have been quiet for 300 ms (`scheduleRefetch`, `lib/billLive.ts:83-89`: `clearTimeout`, then a new `setTimeout`).

One tap can cause several raw messages, because each changed table sends its own hint. Example: the host changes who gets paid while Sam and Dee have marked.
1. `set_payer` clears the marks with one `UPDATE` on `bill_participants`: hint `{"t": "bill_participants"}`.
2. It sets the new payer with one `UPDATE` on `bills`: hint `{"t": "bills"}`.
3. Sam's phone gets both within milliseconds. The first starts the timer, the second restarts it, and 300 ms later Sam's phone runs **one** `fetchBill`. That single read already has the new payer *and* the cleared marks, so the Settle screen never shows a half-changed state like "new payer, old marks".

The same happens when a claim and a mark land close together, or when several people tap "I paid" at once. The test `lib/billLive.test.ts:86-105` sends hints from `claims`, `bills` and `bill_participants` 100 ms apart and checks there's exactly one refetch. The Settle screen uses the same `useBill` hook and channel as the bill screen, so it gets this for free (`__tests__/settle.test.tsx:203-206` drives it with a fake broadcast).
- **Refetches on every `SUBSCRIBED`** (`:119-120`). That covers reconnects, when messages may have been missed.
- **Keeps one channel per bill**, shared by every screen showing that bill (the bill screen stays mounted under Activity), and removes it when the last screen leaves.

`lib/useBill.ts` also refetches when the screen gains focus (`:80-84`) and when the app comes back to the foreground (`:86-92`). If the channel is in error for more than 5 s, it shows "Live updates paused" with a Refresh link (`:94-110`). The Activity screen uses the same hint (`lib/useActivity.ts:63`).

Tests: `supabase/tests/database/bill_edit_realtime.test.sql` (messages, payload shape, topic policy), `supabase/tests/database/settle_payer.test.sql` (the participant-update hint), `lib/billLive.test.ts` (fake channel and timers), `__tests__/billScreen.test.tsx` and `__tests__/settle.test.tsx` (live refetch on the screens).

### Home doesn't use Realtime (2026-11-24, decision BM-11)
Home now shows a card when someone adds you to a bill ("Hana added you to a bill"), and "New" on that bill's row (spec `docs/specs/2026-11-24-bill-markers-and-notices.md`). You might expect that card to arrive live, like claims do on the bill screen. It doesn't. Home has no channel at all. Instead it **reloads its list at two moments** (`app/(app)/index.tsx`, the `useFocusEffect` around `loadBills`):
1. **When Home comes into view**, for example when you come back from a bill. (Home already did this.)
2. **When the app comes back to the foreground while Home is in view.** React Native's `AppState` reports `'active'` when the app returns from the background. The listener is added when Home gains focus and removed when it loses focus, so other screens don't trigger Home reloads.

**On web** there's no "background" in the phone sense, so react-native-web's `AppState` follows the browser tab instead. It listens for the page's `visibilitychange` event and reports `'active'` when the tab becomes visible again (checked in the installed `node_modules/react-native-web/dist/exports/AppState/index.js`). So switching to another tab and back reloads Home.

**What this gives up.** If Sam is *looking at* Home, with the app open, at the moment Hana adds him, nothing changes on his screen. The card appears only when he opens something and comes back, switches apps (or tabs) and returns, or reopens the app. For the common case (Hana adds Sam while his phone is in his pocket) the card is there the next time he opens SplitIt.

**Why not Realtime here?** The bill channels are per bill (`bill:<id>`), and Sam isn't on the bill until Hana adds him, so he isn't listening to it. A live card would need something new:
- a **per-user** private topic (`user:<id>`) with its own `realtime.messages` policy ("only you may listen to your topic");
- a trigger or a line in `add_participant` that sends a hint on that topic;
- Home subscribing to it, with the same `setAuth`, debounce and reconnect handling as `subscribeToBill`.

That's a new topic, policy and trigger to build and test, for a gap that only exists while someone is staring at Home. Polling (reloading every N seconds) was also rejected: it runs queries all the time, mostly for nothing. The per-user topic is the upgrade if testers miss adds (`docs/before-production.md` §8).

**Seen state never broadcasts.** The other direction matters for privacy: when Sam opens a bill, `mark_bill_seen` sends **no** hint on `bill:<id>`, so Hana's open screen doesn't even refetch. A refetch at that moment would tell her "Sam just opened it" ([row level security](row-level-security.md#read-state-is-owner-only-bill_seen-2026-11-24)).

Tests: `__tests__/homeMarkers.test.tsx` (criterion 35: an `'active'` change reloads Home while it's focused, and not after it's blurred or unmounted).

## Pitfalls
- **Treating messages as the truth.** Connections drop and messages get missed. Refetch on reconnect, focus and foreground.
- **Putting data in the message.** Then the channel's access rules become as important as RLS, and harder to test. Our messages carry nothing.
- **Forgetting `private: true`.** A public channel can be joined by anyone who knows the topic name.
- **Joining before the token is set.** After an app restart the join uses the anon key and is refused. Call `realtime.setAuth()` first.
- **Refetching on every single message.** Debounce, or a burst of claims becomes a burst of queries.
- **Race conditions belong in the database, not the UI.** Example: someone claims an item while another claimer saves a custom split. `set_item_split` locks the item, checks the claimer set is unchanged, and otherwise returns `claimers_changed` so the app refetches ([database functions](database-functions.md)).
- **Optimistic UI without rollback.** Show the tap immediately, but undo it and show a message if the write fails.
- **Not unsubscribing.** Channels pile up. `subscribeToBill` returns an unsubscribe function, which the hooks call on unmount.
- **Reaching for Realtime by default.** A reload on focus and on return to the app is often enough, and has no topic, policy or trigger to secure. Write down what it gives up (as BM-11 does), so you know when to upgrade.
- **Broadcasting a private write.** A hint carries no data, but its *timing* still says "something just happened". Writes that must stay private (like "I opened this bill") send no hint.

## Check yourself
1. Why do we re-fetch after reconnecting instead of trusting the message stream?
   - *Answer:* messages sent while you were disconnected are simply lost. Re-reading the database after every `SUBSCRIBED` is the only way to be sure the screen matches reality.
2. Where should a rule like "a split must name exactly the current claimers" be enforced, and why?
   - *Answer:* in the database, inside a transaction with a lock (`set_item_split`). Two phones can act at the same moment, and only the database sees both.
3. Our messages carry no data. What does a phone do when one arrives, and why is that safe even if an outsider somehow received it?
4. What decides whether a user may join the `bill:<id>` channel, and when is it checked?
5. Why does `subscribeToBill` call `realtime.setAuth()` before joining?
6. The host changes who gets paid, which updates `bill_participants` and then `bills`. How many hints does Sam's phone get, and how many times does it refetch? Why does that matter for what the Settle screen shows?
7. Sam taps "I paid" twice. Why does the second tap send no hint at all?
8. Why does the delete trigger say `referencing old table as old_rows` while the insert and update ones use `new table`? What would be missing otherwise?
9. Sam leaves a bill while his phone is still subscribed to `bill:<id>`. Can the hint leak anything to him? What does his phone show after it refetches?
10. Sam is looking at Home in a browser tab when Hana adds him to a bill. When does the "Hana added you to a bill" card appear? Name two things he could do to make it appear sooner.
11. Why can't Home just listen on the bill's existing `bill:<id>` channel to learn that Sam was added? What would a live card need instead?

## Learn more
- Supabase, Realtime Authorization (private channels, `realtime.messages` policies, `realtime.topic()`): https://supabase.com/docs/guides/realtime/authorization
- Supabase, Broadcast (including sending from the database): https://supabase.com/docs/guides/realtime/broadcast
- Supabase, Postgres Changes (the option we didn't use): https://supabase.com/docs/guides/realtime/postgres-changes
- React Native, `AppState` (`active` / `background` and the `change` event): https://reactnative.dev/docs/appstate
- MDN, `visibilitychange` (what react-native-web's `AppState` follows on web): https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilitychange_event
- PostgreSQL, `CREATE TRIGGER` (transition tables: `OLD TABLE` only for `UPDATE`/`DELETE`, `NEW TABLE` only for `UPDATE`/`INSERT`, and no combined events when you ask for them): https://www.postgresql.org/docs/current/sql-createtrigger.html
