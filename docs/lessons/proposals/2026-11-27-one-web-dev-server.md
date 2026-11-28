# Proposal: one web dev server, on :8081, against the local stack

**Status: pending**

**Targets:** `.claude/agents/qa-tester.md` (step 2, the "Check which backend the app talks to" bullet); `CLAUDE.md` (§ Commands, the "Web dev server" bullet)

**Promotion rule used:** a rule that caused a wrong result gets reworded. `qa-tester` tells QA to start its own server on :8082 and leave the user's running. That left two apps on two ports, and the user couldn't tell which one had the new work. The user corrected it: one server, on :8081, against the local stack.

## Evidence (docs/lessons/log.md)
- 2026-11-27 "User wants one web dev server, on :8081 against the local stack" [process]: user correction (d) during docs/specs/2026-11-27-group-claim-status.md. The user's own request used `localhost:8082`, so they were looking at the second server.
- 2026-11-24 "QA's own dev server worked; shell values override the root `.env`" [testing]: where the :8082 rule came from. The inline-values technique stays; only the second port goes.
- 2026-11-24 "Checks ran against an environment that wasn't the one assumed" and 2026-11-25 "The dev server shown to the user pointed at the hosted project, again" [process]: why the backend check itself stays.

## Change 1: `.claude/agents/qa-tester.md`, step 2

Old:
```
If it isn't local, start your own on a free port with local values passed inline: `node scripts/copy-tesseract-assets.mjs && set -a && eval "$(npx supabase status -o env)" && set +a && EXPO_PUBLIC_SUPABASE_URL="$API_URL" EXPO_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY" npx expo start --web --port 8082 --clear`. (Verify: that shell values override the root `.env`, and that real Google sign-in redirects back to that port; if not, report the sign-in part as a user check.) Leave the user's server running.
```

New:
```
The user wants **one** web dev server, on :8081, against the local stack (2026-11-27). Don't start a second server on another port. If :8081 isn't running or isn't local, stop and report "dev server on :8081 needs a restart against the local stack". The main session restarts it with local values passed inline: `node scripts/copy-tesseract-assets.mjs && set -a && eval "$(npx supabase status -o env)" && set +a && EXPO_PUBLIC_SUPABASE_URL="$API_URL" EXPO_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY" npx expo start --web --port 8081 --clear` (shell values override the root `.env`; never print the keys). Then QA re-checks the served bundle. Checks that need no running server (Jest, pgTAP, live-db-smoke scripts, a scratchpad `export:web` build) go ahead meanwhile.
```

## Change 2: `CLAUDE.md`, § Commands, the "Web dev server" bullet, one sentence appended at the end

Old:
```
Needs `.env` and, for real sign-in, the local Supabase running with Google configured.
```

New:
```
Needs `.env` and, for real sign-in, the local Supabase running with Google configured. Keep **one** web dev server, on :8081, against the local stack (user's choice): agents never start a second one on another port. If :8081 is down or points at the hosted project, the main session restarts it on :8081 with the local URL and anon key passed inline, and tells the user.
```

## Change 3 (added 2026-11-27, Who-paid retro): `CLAUDE.md`, § Commands, the "Web dev server" bullet, after the sentence Change 2 appends

Evidence: log 2026-11-27 "The main session served the hosted backend for an hour, because the root `.env` now points at hosted" [process]. The main session restarted :8081 with a plain start; the root `.env` now points at the hosted project, so the user's app talked to hosted for about an hour. When the user asked for one server, the main session killed the :8082 server, which was the local one. This is the third hosted-server mismatch shown to someone (2026-11-24, 2026-11-25, now). Nothing in an applied file told the main session to check, because Change 1 of `2026-11-25-build-task-shared-files-and-served-backend.md` and this proposal are both still pending.

Old (the sentence Change 2 appends, its end):
```
the main session restarts it on :8081 with the local URL and anon key passed inline, and tells the user.
```

New:
```
the main session restarts it on :8081 with the local URL and anon key passed inline, and tells the user. The root `.env` may point at the hosted project, so a plain `npm run web` or `npx expo start --web` can serve hosted: every start or restart passes the local values inline, and is followed by a check of the Supabase host in the served bundle (`curl -s` the bundle and `grep -o` for `127.0.0.1:54321` or `supabase.co`) before anyone uses it. Before stopping a server (for example, to keep only one), check which backend each running server serves, and keep or recreate the local one on :8081.
```

## Compatibility
- The pending `2026-11-25-build-task-shared-files-and-served-backend.md` Change 1 ("restart the server with the values passed inline") fits this: the server it restarts is the one on :8081. Apply them together.
- The pending `2026-11-26-dont-print-local-keys.md` covers how `supabase status -o env` is loaded without echoing keys. This proposal doesn't change that.

## What this changes for you
You'll only ever have localhost:8081, and it will always talk to your local database, so you never have to wonder which tab has the new work.
