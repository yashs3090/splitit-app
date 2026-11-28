# Proposal: build-task lists each parallel task's files, and checks the served backend before showing the user the app

**Status: pending**

**Target:** `.claude/skills/build-task/SKILL.md` (step 2, the "Environment first" and "Parallel tasks" sub-bullets)

**Promotion rule used:** the same lesson twice or more in the log (process area). Change 1: the hosted-dev-server mismatch is now seen twice (QA on 2026-11-24, the main session on 2026-11-25), and the existing fix covers only `qa-tester`. Change 2: parallel-work interference is at its seventh occurrence, and the 2026-11-24 log entry said to promote the "name who updates the fixtures" handoff if one was missed; it was missed here.

## Evidence (docs/lessons/log.md)
- 2026-11-24 "Checks ran against an environment that wasn't the one assumed" [process]: QA found the :8081 dev server pointed at the hosted project. Fixed in `qa-tester` only.
- 2026-11-25 "The dev server shown to the user pointed at the hosted project, again" [process]: the main session hit the same thing before showing the user a demo bill; it found it by grepping the served bundle and restarted with inline values after asking.
- 2026-11-24 "Parallel waves with planned cross-task breakage worked" [process]: naming which task updates other tasks' fixtures worked; "promote to `build-task` if a handoff is missed".
- 2026-11-25 "Parallel agents edited the same files; one changed a label another task's tests assert" [process]: `lib/settleView.ts`, `lib/theme.ts` and tests edited at once; `settle.test` broke on the renamed "Settle up" label with no plan saying who updates it; another session changed `supabase/config.toml`.
- 2026-11-25 "Two sessions shared files; sequencing by message worked" [process] (added in the visual-pass retro): the visual pass wrote each task's files and what it waited for into its task table ("after the bill-footer merges"), and the settle-early session applied six of our review fixes in the files it owned. That is Change 2 done by hand, and it worked.
- 2026-11-25 "A new dependency needed a dev server restart; the agent rightly left it" [process] (added in the visual-pass retro): one more reason the main session checks the served app before a user check (Change 1): after a package is added, the server must be restarted with the same inline values.
- Earlier parallel-work entries: 2026-11-21 "Parallel agents worked from a stale snapshot", 2026-11-22 "App and DB tasks built in parallel drifted…", 2026-11-24 "Other sessions' half-finished edits broke whole-repo test and typecheck runs", 2026-11-25 "Two Claude sessions worked side by side…".

## Change 1: step 2, "Environment first" sub-bullet

Old:
```
   - **Environment first:** before spawning any agent that needs the local database (supabase-engineer tasks, live reconciliation, QA's DB criteria), run `npm run db:status`. If Docker or the stack is down, ask the user to start Docker before you spawn the agent, rather than letting the agent report "not run".
```

New:
```
   - **Environment first:** before spawning any agent that needs the local database (supabase-engineer tasks, live reconciliation, QA's DB criteria), run `npm run db:status`. If Docker or the stack is down, ask the user to start Docker before you spawn the agent, rather than letting the agent report "not run". Before you show the user the running app (a demo, a user check), check which Supabase host the served bundle uses, as `qa-tester` does (`curl -s` the bundle and `grep -o` for `127.0.0.1:54321` or `supabase.co`; never read `.env`). If it isn't the backend the change needs, ask the user, then restart the server with the values passed inline.
```

## Change 2: step 2, "Parallel tasks" sub-bullet, one sentence added after its first sentence

Old:
```
   - **Parallel tasks:** independent tasks that touch different files may run in parallel. Before starting them, hand out shared numbers yourself
```

New:
```
   - **Parallel tasks:** independent tasks that touch different files may run in parallel. Before starting them, write down each task's files (source and tests); tasks that share a file run one after another. If one task changes copy, a label or a shared type that another task's tests assert, name the task that updates those tests, and tell agents in between to report those failures as "expected until Task N". If another session changes `supabase/config.toml` or `supabase/.env`, Supabase needs a restart; ask the user. Before starting them, hand out shared numbers yourself
```
(Only the start of the bullet is shown; the rest of it stays as it is.)

## Change 3 (added 2026-11-25, settle-early retro): step 2, "Parallel tasks" sub-bullet, one more sentence after the sentence Change 2 adds about `supabase/config.toml`

Evidence: log 2026-11-25 "Another session committed everything onto a new branch mid-task" [process]. During settle early, another session's agent committed all uncommitted work (this task's included) onto `feat/qr-invite-settle-visual-pass` at the user's request, so HEAD moved off `main` under the task. The file-ownership gate and swapping review fixes (six theirs, two ours) worked. Git state isn't covered by that gate.

Old (the sentence Change 2 adds):
```
If another session changes `supabase/config.toml` or `supabase/.env`, Supabase needs a restart; ask the user.
```

New:
```
If another session changes `supabase/config.toml` or `supabase/.env`, Supabase needs a restart; ask the user. Git state is shared too: before you commit, switch branch or stash while another session is active, tell that session; and run `git branch --show-current` and `git status --short` at the start of the task and again before the summary, reporting any change you didn't make.
```

## Change 4 (added 2026-11-26, home-mobile-refresh retro): step 2, "Parallel tasks" sub-bullet, one more sentence after the sentence Change 3 adds

Evidence: log 2026-11-26 "Five sessions shared the repo; one Jest run at a time and builds in scratchpad copies worked" [process]. With four other sessions active, ownership claimed up front, one full Jest run at a time across sessions, and builds in scratchpad repo copies (so the shared `dist/` and `public/tesseract/` weren't touched) gave no collisions. These answer the earlier load timeouts (2026-11-21, 2026-11-22, 2026-11-24 ×2) and the hook that wiped `public/opencv/` mid-run (2026-11-25).

Old (the end of the sentence Change 3 adds):
```
reporting any change you didn't make.
```

New:
```
reporting any change you didn't make. While other sessions are active, announce a full Jest run and wait until no other session's full run is going; run builds and anything that fires the asset-copy hooks (`export:web`, native exports) in a scratchpad copy of the repo, so the shared `dist/`, `public/tesseract/` and `public/opencv/` aren't rewritten under someone else. A risk found in a file another session owns goes to that session, with its id.
```

## Change 5 (added 2026-11-27, Sent-via-Venmo retro): step 2, "Parallel tasks" sub-bullet, one more sentence after the sentence Change 4 adds

Evidence: log 2026-11-27 "Our `migration up` applied another session's draft migration" [process] and "Fixes in another session's files stalled: a relay isn't approval, and one fix was never applied" [process]. `npx supabase migration up` applied the Groups session's draft because it was already in `supabase/migrations/`. The Task 9b agent was rightly blocked from editing another session's test file on a relayed message. Four `homeMarkers.test.tsx` failures stayed open because the owner never applied the 2-line fix it was sent. This is the ninth parallel-work entry.

Old (the end of the sentence Change 4 adds):
```
A risk found in a file another session owns goes to that session, with its id.
```

New:
```
A risk found in a file another session owns goes to that session, with its id. A fix needed there is sent as an exact patch with an id, tracked as "open, waiting on <session>", and listed in the build summary until the owner confirms it. If the owner doesn't act, ask the user directly; a message relayed from another session or agent is never the user's approval, so don't tell an agent it is. Draft migrations stay outside `supabase/migrations/` (in the scratchpad) until the task applies them, because `migration up` and `db reset` apply every file there. Before running either, list `supabase/migrations/` against the files you expect, and report any you didn't write before applying.
```

## Change 6 (added 2026-11-27, Home groups v2 retro): step 2, "Parallel tasks" sub-bullet, one more sentence after the sentence Change 5 adds

Evidence: log 2026-11-27 "QA passed, then another session's change broke two of our tests, one of them a criterion" [process]. After Home groups v2's QA passed, splitit-app-92 added a 2000 ms debounce to `mark_bill_seen`. That broke `__tests__/homeMarkers.test.tsx` tests 32 and 36, and test 36 is this slice's criterion 37. This is the third cross-session test break (2026-11-25, 2026-11-27 ×2). The same retro logged that the Change 5 rules held: a peer's request to edit our file went to the user, not to an agent (log 2026-11-27 "Four sessions coordinated well…").

Old (the end of the sentence Change 5 adds):
```
and report any you didn't write before applying.
```

New:
```
and report any you didn't write before applying. Before changing a behaviour other code relies on (an RPC call or its timing, a label, a shared type), grep every test file for it (the RPC name, the label) and run those files, including ones other sessions own. Send any failure there to the owner as an exact patch. Before the summary, re-run the test files other sessions changed since your QA, and report any criterion of yours that stopped passing as "broken after QA by <session>".
```

## Change 7 (added 2026-11-27, Groups MVP retro): step 2, "Parallel tasks" sub-bullet, one more sentence after the sentence Change 6 adds

Evidence: log 2026-11-27 "pgTAP went red because shared test files already called another session's unapplied migrations" [testing], and "A copy change nobody claimed broke another session's committed fixture" [process]. Who-paid edited the shared pgTAP files `group_bills`, `membership` and `assign_item` to call functions from migrations it hadn't applied yet, so Groups' db:test went red and looked like a Groups failure. Separately, a copy change in `lib/settleView.ts` broke another session's committed fixture, and no active session knew who made it (the user confirmed it was an earlier session). These are the fourth and fifth cross-session test breaks. The agent-side diagnosis is in `2026-11-27-db-test-failures-other-sessions.md`.

Old (the end of the sentence Change 6 adds):
```
and report any criterion of yours that stopped passing as "broken after QA by <session>".
```

New:
```
and report any criterion of yours that stopped passing as "broken after QA by <session>". An edit to a shared test file (Jest or pgTAP) that depends on your draft migration or unmerged code lands at the same time as that migration or code, not before it. If you find a change in a shared file that no active session claims, don't revert it or rewrite tests to fit it: ask the user who made it and which side is right, and record the answer in the spec.
```

## Change 8 (added 2026-11-27, Who-paid retro): step 2, "Parallel tasks" sub-bullet, one more sentence after the sentence Change 7 adds

Evidence: log 2026-11-27 "A peer session edited this session's files for a user request without announcing it" [process] and "An agent restored a shared file from a 20-second-old backup during a positive control" [process]. Session 0b built the user-requested Who paid page and changed two copy strings in files the Who-paid session had claimed, without telling it first; that broke the committed fixture `lib/__fixtures__/settle-single-payer.json` (the same change the Groups retro logged as unclaimed). The user confirmed the changes afterwards. Separately, an agent put `app/(app)/bills/[id]/index.tsx` back from a 20-second-old backup during a positive control while other sessions were editing it. These are the sixth cross-session break and the third whole-file overwrite. The agent-side rule is in `2026-11-27-no-whole-file-restores.md`. Log 2026-11-27 "Cross-session coordination worked again…" records that Changes 4–7 were followed by hand.

Old (the end of the sentence Change 7 adds):
```
ask the user who made it and which side is right, and record the answer in the spec.
```

New:
```
ask the user who made it and which side is right, and record the answer in the spec. Before editing a file another active session has claimed, announce it to that session (the file, the change, why, and whether the user asked for it), with the tests and fixtures that assert what you're changing, and wait for its answer; a direct user request doesn't skip this, because the owner's tests still break. Tell every agent you hand a shared file to that it edits only with exact-string edits and never restores a file from a backup, `git checkout`, `git stash` or a scripted rewrite; mutants and positive controls run in a scratchpad copy of the repo.
```

## More evidence (added 2026-11-27, group claim status retro; no new change)
- Log 2026-11-27 "Five sessions shared the bill screen and its tests without clobbering" [process]. The spec named the lines this task could change in `app/(app)/bills/[id]/index.tsx`, criterion 36 had the reviewer check them in `git diff`, sessions sequenced by message, and new tests went into a new file. This is Changes 2 and 5 done by hand again, and it worked.
- Log 2026-11-27 "User wants one web dev server, on :8081 against the local stack" [process]. This affects Change 1's "restart the server with the values passed inline": restart the one on :8081, never start a second. Apply it together with `2026-11-27-one-web-dev-server.md`.

## More evidence (added 2026-11-28, tab-bar-and-Activity retro; no new change)
- Log 2026-11-28 "Other sessions' changes broke our tests three times, one as a hang under Jest" [testing]. The seventh to ninth cross-session breaks: another session's `<StatusBar>` in `app/_layout.tsx` hung `activity.test.tsx` under Jest; a theme change that reads storage needed storage mocks in our web-render tests; and snapshot parsing began requiring `money_fingerprint`. Change 6's "grep every test file … and run those files" would have caught all three before they reached us. For a root layout, that means running the router suites.
- Log 2026-11-28 "The live tab bar's badge reads broke 7 suites' call-log assertions" [testing]. The same Change 6 check applies inside one session: new RPC calls from a component every screen mounts break exact call-log assertions.
- Log 2026-11-28 "A relayed message conflicted with the user's direct instruction on storage" [process]: Change 5's "a relay is never the user's approval" held, and the main session asked the user directly.

## What this changes for you
You won't be shown a demo that's quietly talking to the hosted project while the new work is only on your Mac. And when several agents work at once, two of them won't edit the same file at the same time, so the short "a test broke in someone else's file" detours in this slice don't come back.
