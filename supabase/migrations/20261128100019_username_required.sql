-- Usernames are mandatory (spec docs/specs/2026-11-28-usernames.md, Amendment A1).
--
-- Adds:
--   private.assign_username(text)  picks a free, valid username from a display name (A1.2).
--                                  security definer, search_path '', no client role may execute it.
--   private.fill_username()        BEFORE INSERT trigger function on public.profiles: a row inserted
--                                  without a username gets private.assign_username(display_name)
--                                  (A1.3). Direct inserts (the demo seed, pgTAP fixtures, a
--                                  service_role insert) keep working without listing a username.
--   public.handle_new_user()       replaced: the same display-name rule as before, plus a username
--                                  in the same insert, retried on a username collision, so sign-up
--                                  never fails on a username (A1.2).
--   Backfill of every profile with no username, in created_at order, then username NOT NULL (A1.1).
--
-- Why a BEFORE INSERT trigger and not a column default (A1.3): a default can't read display_name
-- (a default expression can't reference other columns), and it would run as the inserting role, so
-- every writing role would need EXECUTE on the helper (lesson 2026-11-27). The trigger function is
-- security definer, so it calls the helper as its owner and no role needs EXECUTE. NOT NULL is
-- checked before INSERT ... ON CONFLICT looks for a conflict, so the seed's
-- "insert ... on conflict (id) do update" needs the value filled even when it ends up updating.
--
-- Why handle_new_user still changes (A1.2): a BEFORE trigger can't catch the unique violation,
-- because the unique index raises it after the trigger returns. Two sign-ups with the same name at
-- the same moment can both see the base as free; the second insert then waits for the first and
-- gets 23505 on profiles_username_lower_key. Only a begin ... exception block around the INSERT can
-- catch that, so handle_new_user wraps its insert in one (5 attempts, each picking again; under
-- read committed each attempt sees the row that beat it), then inserts the uuid fallback, which
-- can't collide in practice. The retry block lives here, not inside assign_username, because the
-- helper only picks a name; it can't hold the INSERT (it is shared with the fill trigger and the
-- backfill). Any other unique violation (a profile already existing for the id) is re-raised as
-- before.
--
-- SQL base rule versus lib suggestUsername (contract S). Both outputs pass V; they are not a money
-- rule, so small differences are allowed (A1.2). Same on common names (pgTAP + Jest pair:
-- 'Yash Saraiya' -> yash_saraiya, 'Zoë Smith' -> zoe_smith, 'José Núñez' -> jose_nunez,
-- 'Mary-Jane O''Brien' -> mary_jane_obrien). Differences:
--   1. No usable base (blank, non-Latin, too short, reserved): lib returns null; SQL uses the base
--      'user' and always adds a number ('user' alone is reserved), e.g. user4821.
--   2. Taken base: lib's withNumberSuffix takes n from the caller; SQL picks n at random from
--      1-9999 (10 tries), then falls back to 'u' + 12 hex characters of gen_random_uuid().
--   3. Whitespace: JS \s and Postgres \s disagree on two code points. U+FEFF is whitespace in JS
--      (-> '_') and not in Postgres (dropped); U+0085 is the reverse. Everything else tested
--      (space, U+00A0, U+1680, U+2028, U+3000; U+180E and U+200B are neither) matches.
--   4. Fold: both use NFKD and strip U+0300-U+036F (Postgres normalize(), no unaccent extension).
--      Letters NFKD doesn't split are dropped by both ('Łukasz' -> ukasz, 'Straße' -> strae).
-- The reserved array in assign_username is a copy of the profiles_username_reserved constraint.
-- pgTAP (username_required.test.sql) reads the constraint and checks that assign_username never
-- returns any of its words, so a drift fails a test.
--
-- Grants and columns: unchanged. Client-readable columns of public.profiles (authenticated,
-- SELECT): id, display_name, venmo_username, username. Client-UNREADABLE columns (no SELECT grant;
-- anything that expands to * fails with 42501, so name the columns, including in .select() after a
-- write): created_at, updated_at, venmo_prompt_dismissed_at. username is still written only through
-- set_username (unchanged; null stays username_invalid and can never clear the column, A1.4).
--
-- Locks (lock-order rule, implicit locks included):
--   assign_username: reads only (index lookups on profiles_username_lower_key); no row locks.
--   fill_username: assigns NEW.username only; no locks.
--   handle_new_user: the profiles INSERT takes FOR KEY SHARE on the new auth.users row (FK check),
--     a row this transaction just inserted. A unique-index conflict with an uncommitted insert or
--     set_username of the same name makes it wait for that transaction to end, holding no lock the
--     other side wants, so no cycle; 23505 is then caught and the next attempt picks again.
--   Backfill: takes ACCESS EXCLUSIVE on public.profiles first (SET NOT NULL needs it anyway; taking
--     it up front avoids a lock upgrade deadlock with a concurrent reader), then updates each
--     username-less row in created_at order. Each UPDATE fires profiles_set_updated_at, so those
--     rows' updated_at becomes the migration time (triggers stay on). No other table is locked.

begin;

lock table public.profiles in access exclusive mode;

-- ---------------------------------------------------------------------------
-- private.assign_username(p_display_name text) returns text
-- ---------------------------------------------------------------------------
-- Never raises: any error while building the base (for example from normalize()) falls back to
-- the 'user' base, and any error after that returns the uuid fallback.
create function private.assign_username(p_display_name text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_base text;
  v_bare_ok boolean;
  v_digits text;
  v_cut text;
  v_candidate text;
begin
  begin
    -- Contract S steps 2-7: NFKD, strip combining marks, ASCII-lowercase, separators -> '_',
    -- drop anything outside [a-z0-9_], collapse '__', trim '_', cut to 20, trim a trailing '_'.
    v_base := regexp_replace(normalize(coalesce(p_display_name, ''), NFKD), '[̀-ͯ]', '', 'g');
    v_base := translate(v_base, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz');
    v_base := regexp_replace(v_base, '[\s\-._]+', '_', 'g');
    v_base := regexp_replace(v_base, '[^a-z0-9_]', '', 'g');
    v_base := btrim(regexp_replace(v_base, '_{2,}', '_', 'g'), '_');
    v_base := rtrim(left(v_base, 20), '_');
  exception when others then
    v_base := '';
  end;

  -- Rule V on the bare base (same regex and reserved list as the profiles constraints).
  v_bare_ok := char_length(v_base) between 3 and 20
    and v_base ~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$'
    and v_base <> all (array['admin', 'administrator', 'splitit', 'split_it', 'support', 'help', 'helpdesk', 'root', 'system', 'sysadmin', 'null', 'undefined', 'nil', 'none', 'me', 'you', 'everyone', 'anonymous', 'guest', 'user', 'users', 'owner', 'host', 'staff', 'team', 'official', 'moderator', 'mod', 'security', 'billing', 'payments', 'venmo', 'paypal', 'cashapp', 'api', 'auth', 'login', 'signup', 'settings', 'account', 'profile', 'privacy', 'terms', 'test']);

  begin
    if v_bare_ok then
      if not exists (select 1 from public.profiles as p where lower(p.username) = v_base) then
        return v_base;
      end if;
    else
      v_base := 'user'; -- reserved on its own, so it always gets a number
    end if;

    -- withNumberSuffix's cut rule: cut so the number fits in 20, trim a trailing '_' only if at
    -- least 3 characters remain, append the number.
    for v_attempt in 1..10 loop
      v_digits := (1 + floor(random() * 9999))::int::text;
      v_cut := left(v_base, 20 - char_length(v_digits));
      v_candidate := case when char_length(rtrim(v_cut, '_')) + char_length(v_digits) >= 3
                          then rtrim(v_cut, '_') else v_cut end || v_digits;
      if not exists (select 1 from public.profiles as p where lower(p.username) = v_candidate) then
        return v_candidate;
      end if;
    end loop;
  exception when others then
    null;
  end;

  return 'u' || left(replace(gen_random_uuid()::text, '-', ''), 12);
end;
$$;

comment on function private.assign_username(text) is
  'A free, valid username from a display name (Amendment A1.2): the suggestUsername-like base, '
  'else base plus a random number, else u + 12 hex. Never raises. Not callable by clients.';

revoke execute on function private.assign_username(text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- BEFORE INSERT fill trigger (A1.3)
-- ---------------------------------------------------------------------------
create function private.fill_username()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.username is null then
    new.username := private.assign_username(new.display_name);
  end if;
  return new;
end;
$$;

revoke execute on function private.fill_username() from public, anon, authenticated, service_role;

create trigger profiles_fill_username
  before insert on public.profiles
  for each row
  execute function private.fill_username();

-- ---------------------------------------------------------------------------
-- handle_new_user: same display name rule, plus a username that can't block sign-up (A1.2)
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Unchanged rule: full_name, else name (a blank full_name also falls back), trimmed, cut to 50,
  -- blank -> null, so it can never violate the display_name length check.
  v_display_name text := nullif(
    left(
      coalesce(
        nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
        btrim(new.raw_user_meta_data ->> 'name')
      ),
      50
    ),
    ''
  );
  v_constraint text;
begin
  for v_attempt in 1..5 loop
    begin
      insert into public.profiles (id, display_name, username)
      values (new.id, v_display_name, private.assign_username(v_display_name));
      return new;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint is distinct from 'profiles_username_lower_key' then
        raise;
      end if;
      -- Someone took the name between the pick and the insert: pick again.
    end;
  end loop;

  insert into public.profiles (id, display_name, username)
  values (new.id, v_display_name, 'u' || left(replace(gen_random_uuid()::text, '-', ''), 12));
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Backfill, then NOT NULL (A1.1, A1.3)
-- ---------------------------------------------------------------------------
-- The table is locked, so nothing else writes a username meanwhile and each pick is final.
do $$
declare
  r record;
begin
  for r in
    select p.id, p.display_name from public.profiles as p
     where p.username is null
     order by p.created_at, p.id
  loop
    update public.profiles
       set username = private.assign_username(r.display_name)
     where id = r.id;
  end loop;
end $$;

alter table public.profiles alter column username set not null;

comment on column public.profiles.username is
  'Unique @handle, stored lowercase without @ (3-20 of a-z 0-9 _ and single inner dots). Never null: '
  'assigned at sign-up (private.assign_username). Visible to the owner, co-participants and '
  'co-members. Changed only through public.set_username.';

commit;
