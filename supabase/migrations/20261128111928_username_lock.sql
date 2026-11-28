-- Usernames: pick once, then locked (spec docs/specs/2026-11-28-usernames.md, Amendment A3, which
-- replaces A2's "drop set_username"; A2.8 Venmo stays editable).
--
-- Adds:
--   profiles.username_locked_at   timestamptz null. null = the username is provisional (sign-up,
--                                 the A1 backfill and the fill trigger leave it null, A3.1); set =
--                                 the person picked, and the username never changes again.
--   public.set_username(text)     replaced, same signature, now set-once (A3.2): allowed only while
--                                 username_locked_at is null; one UPDATE sets username and
--                                 username_locked_at = now(). Picking the provisional name again
--                                 locks it ("Keep @name"). Afterwards 42501 username_locked.
--   private.guard_username_lock() + trigger profiles_username_lock, BEFORE UPDATE (A3.3).
--   public.usernames_available(text[]) the candidates that pass rule V and are free (A3.4).
--   public.my_username_status()   the caller's own username and whether it is locked.
-- Replaces (review R6, no behaviour change):
--   private.assign_username(text) the same body as in 20261128100019, with the combining-mark range
--                                 written as '[\u0300-\u036f]' escapes, not invisible literals.
--
-- username_locked_at is readable by the owner only. A column grant can't do that (a column grant
-- applies to every row the row policy shows, and co-participants and co-members see your row), so
-- no client role gets any privilege on the column and the owner reads it through
-- my_username_status(), which returns only the caller's row.
--
-- Client-readable columns of public.profiles (authenticated, SELECT): id, display_name,
-- venmo_username, username. Client-UNREADABLE columns (no SELECT grant; anything that expands to *
-- fails with 42501, so name the columns, including in .select() after a write): created_at,
-- updated_at, venmo_prompt_dismissed_at, username_locked_at. Client-updatable columns (unchanged):
-- display_name, venmo_username (A2.8). username and username_locked_at have no client grant.
--
-- The immutability mechanism (A3.3). The trigger fires BEFORE every UPDATE of a profile (no column
-- list: "UPDATE OF username" would miss a change made by another BEFORE trigger) and compares OLD
-- with NEW:
--   * Locked row (old.username_locked_at is not null): any change to username or to
--     username_locked_at raises 42501 username_immutable, for every role, the owner included.
--   * Unlocked row: username or username_locked_at may change only (a) together with setting the
--     lock (new.username_locked_at is not null), and (b) when current_user is the owner of
--     public.set_username. The guard is SECURITY INVOKER on purpose: inside it, current_user is the
--     role running the UPDATE. Inside set_username (security definer) that is set_username's owner;
--     a direct UPDATE by service_role, authenticated (which has no grant anyway) or any other role
--     has a different current_user and is refused with 42501 username_immutable.
--   Limits, stated plainly: the owner role (postgres) running a direct UPDATE that also sets the
--   lock passes (b), exactly as set_username does; the same role can also drop or disable the
--   trigger, so no trigger can stop it. Other security definer functions owned by that role also
--   pass (b); none writes username or username_locked_at. session_replication_role = replica skips
--   the trigger (owner or superuser only). Operator fixes take a dedicated migration, on purpose.
--   The guard reads set_username's owner from pg_proc each time; if set_username were dropped, the
--   cast fails and every username change fails closed.
--   Inserts are not UPDATEs: handle_new_user, the fill trigger and direct inserts (the demo seed,
--   pgTAP fixtures) are unchanged (A2.3). A direct insert by service_role or postgres may set
--   username_locked_at itself; no client role can insert profiles. The demo seed's
--   "on conflict (id) do update set display_name, venmo_username" doesn't touch either column.
--   BEFORE triggers fire in name order: profiles_set_updated_at, profiles_stamp_venmo_prompt,
--   profiles_username_lock. The first two don't touch username or username_locked_at; any future
--   BEFORE UPDATE trigger on profiles must sort before profiles_username_lock.
--
-- usernames_available: the reserved array is a copy of the profiles_username_reserved constraint
-- (the third copy, with lib/username.ts and private.assign_username); pgTAP reads the constraint
-- and checks that none of its words is ever returned, so drift fails a test. The caller's own
-- current username counts as available to them (they can pick it to lock it). Free at the time of
-- the call only: the save (set_username) still decides, and a name taken in between gives
-- username_taken. Probing: any signed-in user learns whether up to 10 handles exist per call;
-- rate limiting is a before-production item.
--
-- Locks (lock-order rule, implicit locks included):
--   lock_timeout is 5 s (review R8): if a long transaction holds profiles, the push fails fast
--   instead of queueing every profiles read behind it; re-run it.
--   ALTER TABLE ADD COLUMN (nullable, no default: catalog-only) takes ACCESS EXCLUSIVE on
--   public.profiles; CREATE TRIGGER needs SHARE ROW EXCLUSIVE, already covered. Held for this short
--   transaction only; no rows are rewritten.
--   set_username: one row lock, the caller's own profiles row, through its UPDATE (the plain SELECT
--   before it takes none). It changes username, username_locked_at and (trigger) updated_at; none is
--   in a unique index usable by a foreign key (the expression index on lower(username) can't back
--   one), so the lock is FOR NO KEY UPDATE, which doesn't conflict with the FOR KEY SHARE locks FK
--   checks take on the profile (bill_participants, bill_events, group_members, group_events, ...).
--   Two set_username calls by the same person: the second waits on the row, then re-checks
--   "username_locked_at is null" on the new row version, updates 0 rows and raises username_locked.
--   Two people picking one name: the unique index makes the second wait for the first transaction,
--   holding no lock the first wants, then raises 23505. Account deletion (FOR UPDATE via the
--   auth.users cascade) makes a concurrent set_username wait, then update 0 rows: not_allowed.
--   usernames_available and my_username_status: reads only, no row locks.
--   The guard: reads OLD/NEW and one pg_proc row; no row locks.

begin;

-- Review R8: don't queue every profiles read behind the ACCESS EXCLUSIVE lock that ALTER TABLE
-- takes; fail fast instead, and re-run the push.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Review R6: private.assign_username, same body as 20261128100019, but the combining-mark range is
-- written as '[\u0300-\u036f]' (Postgres ARE escapes) instead of literal, invisible characters.
-- pgTAP (username_required.test.sql) and the dry run compared old and new outputs.
-- ---------------------------------------------------------------------------
create or replace function private.assign_username(p_display_name text)
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
    v_base := regexp_replace(normalize(coalesce(p_display_name, ''), NFKD), '[\u0300-\u036f]', '', 'g');
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
-- Column (A3.1)
-- ---------------------------------------------------------------------------
alter table public.profiles add column username_locked_at timestamptz null;

comment on column public.profiles.username_locked_at is
  'When the person picked their username (set_username). null = the username is provisional. '
  'Once set, neither it nor username can change (profiles_username_lock). Not readable by clients; '
  'the owner reads it through public.my_username_status().';

comment on column public.profiles.username is
  'Unique @handle, stored lowercase without @ (3-20 of a-z 0-9 _ and single inner dots). Never null: '
  'assigned at sign-up (private.assign_username), provisional until the person picks one through '
  'public.set_username, which locks it for good (username_locked_at). Visible to the owner, '
  'co-participants and co-members.';

-- ---------------------------------------------------------------------------
-- public.set_username(p_username text) returns text   (contract R as amended by A3.2)
-- ---------------------------------------------------------------------------
create or replace function public.set_username(p_username text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_locked_at timestamptz;
  v_result text;
  v_constraint text;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if p_username is null then
    raise exception using errcode = '22023', message = 'username_invalid';
  end if;

  select p.username_locked_at into v_locked_at
    from public.profiles as p
   where p.id = v_uid;

  if not found then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if v_locked_at is not null then
    raise exception using errcode = '42501', message = 'username_locked';
  end if;

  -- One UPDATE sets the name and the lock, so the guard trigger sees both change together. The
  -- same name as the provisional one changes only the lock ("Keep @name").
  begin
    update public.profiles
       set username = p_username,
           username_locked_at = now()
     where id = v_uid
       and username_locked_at is null
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

  if v_result is null then
    -- Locked by a concurrent call meanwhile, or the account was deleted meanwhile.
    if exists (select 1 from public.profiles as p where p.id = v_uid) then
      raise exception using errcode = '42501', message = 'username_locked';
    end if;
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  return v_result;
end;
$$;

comment on function public.set_username(text) is
  'Picks the caller''s username once and locks it (Amendment A3.2). Errors: 42501 not_allowed, '
  '42501 username_locked, 22023 username_invalid, 22023 username_reserved, 23505 username_taken.';

revoke execute on function public.set_username(text) from public, anon, authenticated, service_role;
grant execute on function public.set_username(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Guard trigger (A3.3). SECURITY INVOKER on purpose: see the header.
-- ---------------------------------------------------------------------------
create function private.guard_username_lock()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.username is not distinct from old.username
     and new.username_locked_at is not distinct from old.username_locked_at then
    return new;
  end if;

  if old.username_locked_at is not null then
    raise exception using errcode = '42501', message = 'username_immutable';
  end if;

  if new.username_locked_at is null
     or current_user <> (select pg_catalog.pg_get_userbyid(p.proowner)
                           from pg_catalog.pg_proc as p
                          where p.oid = 'public.set_username(text)'::pg_catalog.regprocedure) then
    raise exception using errcode = '42501', message = 'username_immutable';
  end if;

  return new;
end;
$$;

comment on function private.guard_username_lock() is
  'BEFORE UPDATE guard on public.profiles (Amendment A3.3): a locked username and its lock never '
  'change; an unlocked one changes only with the lock, through set_username. 42501 username_immutable.';

-- A trigger function needs no EXECUTE grant to fire.
revoke execute on function private.guard_username_lock() from public, anon, authenticated, service_role;

create trigger profiles_username_lock
  before update on public.profiles
  for each row
  execute function private.guard_username_lock();

-- ---------------------------------------------------------------------------
-- public.usernames_available(p_candidates text[]) returns text[]   (A3.4)
-- ---------------------------------------------------------------------------
-- Returns, in first-seen order and without duplicates, the candidates that pass rule V exactly as
-- given (no normalizing, UN-3: 'Yash' is invalid) and that no other profile holds (compared with
-- lower(), the unique index's expression). null elements are skipped; a null array gives '{}'.
create function public.usernames_available(p_candidates text[])
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if coalesce(cardinality(p_candidates), 0) > 10 then
    raise exception using errcode = '22023', message = 'too_many_candidates';
  end if;

  return coalesce((
    select array_agg(c.value order by c.first_ord)
      from (select u.value, min(u.ord) as first_ord
              from unnest(coalesce(p_candidates, '{}'::text[])) with ordinality as u(value, ord)
             where u.value is not null
               and char_length(u.value) between 3 and 20
               and u.value ~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$'
               and u.value <> all (array['admin', 'administrator', 'splitit', 'split_it', 'support', 'help', 'helpdesk', 'root', 'system', 'sysadmin', 'null', 'undefined', 'nil', 'none', 'me', 'you', 'everyone', 'anonymous', 'guest', 'user', 'users', 'owner', 'host', 'staff', 'team', 'official', 'moderator', 'mod', 'security', 'billing', 'payments', 'venmo', 'paypal', 'cashapp', 'api', 'auth', 'login', 'signup', 'settings', 'account', 'profile', 'privacy', 'terms', 'test'])
             group by u.value) as c
     where not exists (select 1 from public.profiles as p
                        where lower(p.username) = lower(c.value)
                          and p.id <> v_uid)
  ), '{}'::text[]);
end;
$$;

comment on function public.usernames_available(text[]) is
  'Of up to 10 candidate usernames, the ones that pass rule V and are free (the caller''s own counts '
  'as free). Errors: 42501 not_allowed, 22023 too_many_candidates. The save still decides.';

revoke execute on function public.usernames_available(text[]) from public, anon, authenticated, service_role;
grant execute on function public.usernames_available(text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- public.my_username_status()   the caller's own row only
-- ---------------------------------------------------------------------------
create function public.my_username_status()
returns table (username text, locked boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select p.username, p.username_locked_at is not null
    from public.profiles as p
   where p.id = (select auth.uid());
$$;

comment on function public.my_username_status() is
  'The caller''s username and whether it is locked (picked). One row, or none when signed out or '
  'without a profile.';

revoke execute on function public.my_username_status() from public, anon, authenticated, service_role;
grant execute on function public.my_username_status() to authenticated;

commit;
