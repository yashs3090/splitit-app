-- Usernames: groundwork (spec docs/specs/2026-11-28-usernames.md, Task 1; contracts V and R).
--
-- Adds:
--   profiles.username        text null, no default. Stored lowercase without '@' (lib/username.ts
--                            normalizes; the database does not, UN-3). Two named CHECK constraints
--                            hold rule V, written inline with no function call (UN-2), so no
--                            EXECUTE grant is needed by any writing role (lesson 2026-11-27).
--   profiles_username_lower_key  unique index on lower(username). Valid values are ASCII
--                            lowercase, so lower() is the identity on them; the index also catches
--                            a superuser write of 'Sam' if the format check were ever relaxed.
--   public.set_username(text) security definer RPC, the only client write path (UN-1). Maps the
--                            constraint violations to stable codes (contract R) and never passes
--                            raw constraint text to the client.
--
-- No backfill (UN-6): existing and new users start at null. handle_new_user is not touched.
-- No policy change: profiles_select_own_or_co_participant_or_co_member already scopes rows to the
-- owner, co-participants and co-members, so the new column-level SELECT grant exposes username to
-- exactly the people who can already read display_name. Anon gets nothing.
--
-- Client-readable columns of public.profiles after this migration (authenticated, SELECT):
--   id, display_name, venmo_username, username.
-- Client-UNREADABLE columns (no SELECT grant; anything that expands to * fails with 42501, so
-- name the columns, including in .select() after a write):
--   created_at, updated_at, venmo_prompt_dismissed_at.
-- Client-updatable columns (unchanged): display_name, venmo_username. username has NO client
-- UPDATE or INSERT grant; it is written only through set_username.
--
-- Locks (lock-order rule, implicit locks included):
--   set_username takes exactly one row lock: the caller's own profiles row, through its UPDATE.
--   The UPDATE changes username and (via the profiles_set_updated_at trigger) updated_at. Neither
--   is in a unique index usable by a foreign key (the only such index is the primary key on id;
--   an expression index can't back a foreign key), so Postgres takes FOR NO KEY UPDATE, not FOR
--   UPDATE. That doesn't conflict with the FOR KEY SHARE locks that FK checks (bill_participants,
--   bill_events.actor_id, group_members, group_events.actor_id, ...) take on the same profile, so
--   set_username never waits on or blocks bill or group writes. The plain SELECT before it takes
--   no row lock. The unique index can make a second caller choosing the same name wait for the
--   first transaction to finish (then 23505); that waits on no row lock and holds none, so it
--   can't form a cycle. Account deletion deletes the profile (FOR UPDATE) via the auth.users
--   cascade; a concurrent set_username then waits on that one row and, once the delete commits,
--   updates 0 rows and raises 42501 not_allowed. No other locks are taken, so there is no order to
--   keep. No trigger on profiles takes locks on other tables (profiles_set_updated_at and
--   profiles_stamp_venmo_prompt only assign NEW columns; the latter fires only on venmo_username).

begin;

-- ---------------------------------------------------------------------------
-- Column and rule V
-- ---------------------------------------------------------------------------
-- The regex text and the reserved array are copied verbatim into lib/username.ts
-- (USERNAME_PATTERN, RESERVED_USERNAMES); a Jest drift test reads this file and compares them.
-- Postgres bracket ranges compare code points, so 'é' is outside a-z; '$' matches only at the very
-- end (no newline-sensitive mode), so a trailing newline is rejected (pgTAP row B15). Length is
-- checked with char_length; the regex allows ASCII only, so it equals JS .length.
-- Postgres checks CHECK constraints in alphabetical order of name, so profiles_username_format
-- runs before profiles_username_reserved: a value failing both (e.g. 'me') reports the format
-- constraint, which gives "invalid beats reserved" (contract V, row B20). Keep the names sorted so.
alter table public.profiles
  add column username text null
    constraint profiles_username_format
    check (username is null or (char_length(username) between 3 and 20 and username ~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$'))
    constraint profiles_username_reserved
    check (username is null or username <> all (array['admin', 'administrator', 'splitit', 'split_it', 'support', 'help', 'helpdesk', 'root', 'system', 'sysadmin', 'null', 'undefined', 'nil', 'none', 'me', 'you', 'everyone', 'anonymous', 'guest', 'user', 'users', 'owner', 'host', 'staff', 'team', 'official', 'moderator', 'mod', 'security', 'billing', 'payments', 'venmo', 'paypal', 'cashapp', 'api', 'auth', 'login', 'signup', 'settings', 'account', 'profile', 'privacy', 'terms', 'test']));

comment on column public.profiles.username is
  'Unique @handle, stored lowercase without @ (3-20 of a-z 0-9 _ and single inner dots). '
  'Visible to the owner, co-participants and co-members. Written only through public.set_username.';

create unique index profiles_username_lower_key on public.profiles (lower(username));

-- ---------------------------------------------------------------------------
-- Grants: read like display_name; no direct write
-- ---------------------------------------------------------------------------
grant select (username) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- public.set_username(p_username text) returns text   (contract R)
-- ---------------------------------------------------------------------------
-- security definer because authenticated has no UPDATE grant on username (UN-1). It writes only
-- the caller's own row (id = auth.uid()). There's no "taken" pre-check: the unique index decides,
-- so two people choosing one name at once can't both win. Errors are re-raised with our own
-- message and no detail or hint, so the constraint name and the conflicting value never reach the
-- client. A username can't be cleared through it (null is username_invalid, UN-7). No activity
-- event is logged (UN-10).
create function public.set_username(p_username text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_current text;
  v_result text;
  v_constraint text;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if p_username is null then
    raise exception using errcode = '22023', message = 'username_invalid';
  end if;

  select p.username into v_current
    from public.profiles as p
   where p.id = v_uid;

  if not found then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  -- Same name again: no write, so updated_at stays as it was.
  if v_current = p_username then
    return v_current;
  end if;

  begin
    update public.profiles
       set username = p_username
     where id = v_uid
    returning username into v_result;
  exception
    when check_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'profiles_username_reserved' then
        raise exception using errcode = '22023', message = 'username_reserved';
      end if;
      raise exception using errcode = '22023', message = 'username_invalid';
    when unique_violation then
      raise exception using errcode = '23505', message = 'username_taken';
  end;

  -- The row vanished between the read and the update (account deleted meanwhile).
  if v_result is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  return v_result;
end;
$$;

comment on function public.set_username(text) is
  'Sets the caller''s username. Errors: 42501 not_allowed, 22023 username_invalid, '
  '22023 username_reserved, 23505 username_taken. The same name again is a no-op.';

revoke execute on function public.set_username(text) from public, anon, authenticated;
grant execute on function public.set_username(text) to authenticated;

commit;
