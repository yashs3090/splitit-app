-- Groups MVP, Task T2: groups core (spec docs/specs/2026-11-26-groups-mvp.md, T2 as amended by
-- Amendment A1; engineering review docs/specs/2026-11-26-groups-mvp-eng.md B2, S3, S5, S8, N4;
-- criteria 8-15, 34, 102, 113; decisions "2026-11-26 · Groups" GR-T2-… in
-- docs/decisions-to-review.md). Earlier migrations are applied and are not edited.
--
--   public.groups             a group: name (C-G8), currency 'USD', join_code, created_by
--   public.group_members      who is in it (PK group_id, user_id); user_id ON DELETE RESTRICT (S8)
--   public.group_hidden       owner-only "Hide for me" rows; no client access at all
--   public.group_events       group Activity, append-only, ordered by seq (identity)
--   private.is_group_member   RLS helper: is the CALLER a member of this group
--   private.shares_group_with RLS helper: are the caller and this user members of one group
--   private.group_name        the one name normaliser in SQL (same six characters as the app)
--   public.create_group(p_id, p_name) -> uuid          caller becomes the only member
--   public.join_group(p_code) -> uuid                  idempotent; 50-member cap
--   public.rename_group(p_group_id, p_name)            any member; same name = no-op
--   public.rotate_group_code(p_group_id) -> text       any member
--   public.set_group_hidden(p_group_id, p_hidden)      the caller's own row only
--   public.my_groups()                                  the caller's groups
--   public.leave_group(p_group_id)                     only-member refusal here; T3-T5 add the
--                                                       history checks (C-G10) by re-creating it
--   profiles SELECT policy: own row, co-participants (unchanged) OR co-members (U-G5).
--
-- Later Groups migrations (T3 expenses, T4 payments, T5 bills in groups, T6 snapshot, T7
-- assign_item) follow the lock rule below and list their own paths in their headers.
--
-- ===========================================================================================
-- Name trimming (C-G8, A1.12 GR-T8-6)
-- ===========================================================================================
-- Group names are trimmed of exactly the six characters lib/groupExpense.ts normalizeTitle
-- trims: space, \t, \n, \r, \v (U+000B), \f (U+000C), and nothing else, then must be 1..60 code
-- points (char_length). The pattern is '^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$' in a STANDARD string
-- (not E''), so the backslash escapes go to the regex engine, which reads \v as U+000B (an E''
-- string has no \v escape and would turn it into a plain "v").
-- POSIX [[:space:]] is NOT used: checked on the local Postgres 17.12 (en_US.UTF-8) on
-- 2026-11-26, it also strips U+00A0, U+3000, U+0085 and U+2028, which normalizeTitle keeps, so
-- a name ending in a non-breaking space would be stored differently from what the app checks.
-- The groups_name_trimmed check repeats the same pattern so no row can hold an untrimmed name.
--
-- ===========================================================================================
-- LOCK ORDER (the rule for every Groups function and trigger, T2-T7; A1.2, criterion 34)
-- ===========================================================================================
-- Order: the GROUP ROW first, then BILLS in ascending id, then bill_participants, then claims.
-- Implicit locks count (lessons 2026-11-24): an INSERT or a key UPDATE takes FOR KEY SHARE on
-- every row its foreign keys point at; a DELETE takes FOR UPDATE on the row and the cascades
-- lock the children; an UPDATE that changes a column covered by a unique index takes FOR UPDATE
-- on that row, any other UPDATE takes FOR NO KEY UPDATE.
--
-- (a) Membership-changing functions (join_group, leave_group, and in T5
--     attach_bill_to_group, detach_bill_from_group) take the group row FOR NO KEY UPDATE
--     first. FOR NO KEY UPDATE conflicts with itself (so membership changes of one group run one
--     at a time) but NOT with FOR KEY SHARE, which is what every FK check on the group row takes.
--     Money writes (T3 add_expense, edit_expense, delete_expense; T4 record_payment,
--     undo_payment) take NO explicit group lock. leave_group maps 23503 from its group_members
--     delete to 22023 cannot_leave.
-- (b) join_group (and T5's attach_bill_to_group) hold the group lock before reading members or
--     bills, so a join and an attach can't each miss the other.
-- (c) T5: detach_bill_from_group reads bills.group_id unlocked, locks the group, then the bill
--     FOR UPDATE, then re-checks group_id; attach locks the group, then the bill FOR UPDATE.
-- (d) leave_group: the group lock, then (from T5) ALL the group's bills FOR UPDATE in ascending
--     id, then the history checks, then DELETE group_members, then the participant rows. (Here
--     in T2 bills have no group_id yet, so step 2 is empty; T5 re-creates leave_group with it.)
--
-- Worked example: the deadlock this avoids (leave_group x edit_expense, A1.B2a). Suppose
-- leave_group took the group row FOR UPDATE (or plain-UPDATEd it) and edit_expense took no
-- group lock:
--   T1 edit_expense (by Ana) inserts expense_shares for Xi: the FK (group_id, user_id) ->
--      group_members takes FOR KEY SHARE on Xi's group_members row.
--   T2 leave_group (by Xi) takes the group row FOR UPDATE; its history check can't see T1's
--      uncommitted share; it DELETEs Xi's group_members row and waits for T1's KEY SHARE.
--   T1 inserts its group_events row: the FK group_id -> groups takes FOR KEY SHARE on the group
--      row and waits for T2's FOR UPDATE.  -> each waits for the other: 40P01.
-- With rule (a), T2 holds FOR NO KEY UPDATE, which does not block T1's FOR KEY SHARE on the
-- group row. T1 finishes and commits; T2's delete then proceeds. If T1 committed a share for
-- Xi, the delete fails the FK (restrict, T3) with 23503, and leave_group answers cannot_leave.
-- record_payment / add_expense (FKs on from/to/recorded_by/payer/created_by) have the same shape
-- and the same answer.
--
-- Per function in this migration (explicit, then implicit, in order):
--   create_group      0. signed-out / id / name checks (no lock).
--                     1. INSERT groups ... ON CONFLICT (id) DO NOTHING (a new row; on a retry,
--                        waits for a concurrent insert of the same id, then reads it).
--                        FK created_by -> profiles: KEY SHARE on the caller's profile.
--                     2. INSERT group_members: KEY SHARE on the new group row and the profile.
--                     3. INSERT group_events: KEY SHARE on the group row and the profile.
--   join_group        0. signed-out / code format checks (no lock).
--                     1. SELECT groups WHERE join_code = p_code FOR NO KEY UPDATE (a). Under READ
--                        COMMITTED the WHERE is re-checked on the newest row version after a
--                        wait, so a rotate that committed first makes this "not found".
--                     2. reads group_members (count, already a member) under that lock (b).
--                     3. INSERT group_members: KEY SHARE on the group row (held) and the profile.
--                     4. INSERT group_events: same.
--   rename_group      0. checks; membership read (no lock) -> 42501 for a non-member.
--                     1. SELECT groups FOR NO KEY UPDATE (the UPDATE below would take the same).
--                     2. membership re-checked under the lock.
--                     3. UPDATE groups.name (not a key column: NO KEY UPDATE, already held).
--                     4. INSERT group_events: KEY SHARE on the group row (held) and the profile.
--   rotate_group_code 0. checks; membership read (no lock).
--                     1. SELECT groups FOR UPDATE: join_code has a unique index, so its UPDATE
--                        needs FOR UPDATE anyway; taking it first avoids a lock upgrade. FOR
--                        UPDATE waits for in-flight FK inserts that hold KEY SHARE on the group
--                        row (money writes' event inserts); rotate itself holds nothing they
--                        wait for while it waits, so there's no cycle.
--                     2. membership re-checked; 3. UPDATE join_code; 4. INSERT group_events.
--   set_group_hidden  0. checks; membership read (no lock). No group lock.
--                     1. INSERT ... ON CONFLICT DO NOTHING / DELETE on group_hidden: the FK
--                        (group_id, user_id) -> group_members takes KEY SHARE on the caller's
--                        member row. A concurrent leave_group's delete of that row makes this
--                        wait, then fail the FK: mapped to 42501 not_allowed. No event.
--   my_groups         no locks.
--   leave_group       0. checks; membership read (no lock) -> 42501 for a non-member.
--                     1. SELECT groups FOR NO KEY UPDATE (a).
--                     2. (T5) bills of the group FOR UPDATE, ascending id (d).
--                     3. membership re-checked; history checks (here: the last member).
--                     4. DELETE group_members row: FOR UPDATE on it (waits for any FK KEY SHARE
--                        held by an in-flight money write, rule (a)); cascades to the caller's
--                        group_hidden row. 23503 (a restrict FK from T3/T4/T5 rows) ->
--                        22023 cannot_leave.
--                     5. (T5) DELETE the caller's bill_participants rows on the group's bills.
--                     6. INSERT group_events: KEY SHARE on the group row (held) and the profile.
--   RLS helpers       no locks.
--
-- ===========================================================================================
-- Columns clients can't read
-- ===========================================================================================
-- * public.group_hidden: ALL columns. anon, authenticated and public hold no privilege on it, so
--   any select (select('*') or a bare .select() included), insert, update or delete fails with
--   42501. RLS is on with no policy as a second layer. The only read is my_groups() (the
--   caller's own `hidden`); the only write is set_group_hidden (the caller's own row). Hiding a
--   group is invisible to the other members (no event, no shared row changes).
-- * public.groups, public.group_members, public.group_events: every column is readable by
--   members (table-level SELECT), so select('*') works on these three. Members can read
--   groups.join_code (they share the link; before-production item).
-- * public.profiles: unchanged column grants (id, display_name, venmo_username). Only the row
--   policy widens to co-members. select('*') on profiles still fails with 42501 for everyone.
-- No client role has INSERT, UPDATE or DELETE on any of the four tables. Every write goes
-- through the security-definer functions below.
--
-- ===========================================================================================
-- Errors
-- ===========================================================================================
--   42501 not_allowed     signed out; not a member (or the group doesn't exist: same answer);
--                         set_group_hidden racing the caller's own leave
--   42501 permission denied  anon executing any function; any direct table write
--   42501 group_events_append_only  UPDATE / DELETE / TRUNCATE on group_events, any role
--   22023 invalid_name    name null, or 0 or > 60 code points after trimming (C-G8)
--   22023 invalid_id      create_group with p_id null
--   22023 id_conflict     create_group: the id exists with another name or creator
--   22023 invalid_hidden  set_group_hidden with p_hidden null
--   22023 group_full      join_group on a group with 50 members (A1.7, S5)
--   22023 cannot_leave    leave_group: the only member, or (later tasks) has history
--   P0002 invalid_code    join_group: malformed, unknown or rotated-away code
--
-- Event kinds (group_events_kind_known): this migration writes group_created, member_joined,
-- renamed, link_rotated, member_left. The list also holds the kinds T3-T5 write
-- (expense_added, expense_edited, expense_deleted, payment_recorded, payment_undone,
-- bill_added, bill_removed), so those tasks needn't re-create the constraint. Nothing can write
-- them until those functions exist (only security-definer functions insert events).
-- Details: group_created {name}, renamed {from, to}, member_joined {}, member_left {},
-- link_rotated {} (never the code).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null
    constraint groups_name_length check (char_length(name) between 1 and 60)
    constraint groups_name_trimmed
      check (name = regexp_replace(name, '^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$', '', 'g')),
  currency text not null default 'USD'
    constraint groups_currency_usd check (currency = 'USD'),
  join_code text not null
    constraint groups_join_code_key unique
    constraint groups_join_code_format check (join_code ~ '^[0-9a-f]{20}$'),
  -- set null, not restrict: a creator who has left (no history) can still delete their account.
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.groups is
  'Groups MVP (ADR 0022). Written only by security-definer functions; members read.';

create table public.group_members (
  group_id uuid not null references public.groups (id) on delete cascade,
  -- restrict (A1.9, S8): membership blocks account deletion until the person leaves.
  user_id uuid not null references public.profiles (id) on delete restrict,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create index group_members_user_id_idx on public.group_members (user_id);

create table public.group_hidden (
  group_id uuid not null,
  user_id uuid not null,
  hidden_at timestamptz not null default now(),
  primary key (group_id, user_id),
  -- Leaving deletes the member row and, with it, the hidden row.
  foreign key (group_id, user_id)
    references public.group_members (group_id, user_id) on delete cascade
);

create table public.group_events (
  id uuid primary key default gen_random_uuid(),
  -- Insertion order: every event of one call shares created_at (now() is the transaction start;
  -- lessons 2026-11-24), so lists order by seq.
  seq bigint generated always as identity
    constraint group_events_seq_key unique,
  group_id uuid not null references public.groups (id) on delete cascade,
  actor_id uuid references public.profiles (id) on delete set null,
  kind text not null
    constraint group_events_kind_known check (kind in (
      'group_created', 'member_joined', 'member_left', 'renamed', 'link_rotated',
      'expense_added', 'expense_edited', 'expense_deleted',
      'payment_recorded', 'payment_undone',
      'bill_added', 'bill_removed'
    )),
  details jsonb not null default '{}'::jsonb
    constraint group_events_details_object check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default now()
);

create index group_events_group_seq_idx on public.group_events (group_id, seq desc);
create index group_events_actor_id_idx on public.group_events (actor_id);
create index groups_created_by_idx on public.groups (created_by);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- The one name normaliser (see "Name trimming" above). Immutable: no table access.
create function private.group_name(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(p_name, '^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$', '', 'g');
$$;

revoke execute on function private.group_name(text) from public, anon, authenticated;

-- RLS helpers. security definer: they read group_members past its own RLS (a policy on
-- group_members that queried group_members under RLS would recurse). Both compare against the
-- caller's own auth.uid(), so they reveal only facts about groups the caller is in.
create function private.is_group_member(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.group_members as gm
    where gm.group_id = p_group_id
      and gm.user_id = (select auth.uid())
  );
$$;

create function private.shares_group_with(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.group_members as mine
    join public.group_members as theirs on theirs.group_id = mine.group_id
    where mine.user_id = (select auth.uid())
      and theirs.user_id = p_user_id
  );
$$;

revoke execute on function private.is_group_member(uuid) from public, anon, authenticated;
revoke execute on function private.shares_group_with(uuid) from public, anon, authenticated;
grant execute on function private.is_group_member(uuid) to authenticated;
grant execute on function private.shares_group_with(uuid) to authenticated;

-- The single insert path for group_events. Not executable by any client role.
create function private.log_group_event(
  p_group_id uuid,
  p_actor uuid,
  p_kind text,
  p_details jsonb
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.group_events (group_id, actor_id, kind, details)
  values (p_group_id, p_actor, p_kind, coalesce(p_details, '{}'::jsonb));
$$;

revoke execute on function private.log_group_event(uuid, uuid, text, jsonb)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Append-only guard on group_events (same shape as bill_events, m2_review_fixes R2)
-- ---------------------------------------------------------------------------
-- Blocks UPDATE, DELETE and TRUNCATE for every role (postgres included), except two foreign-key
-- actions: DELETE when the event's group no longer exists (the cascade from groups), and an
-- UPDATE that only sets actor_id to null when that profile no longer exists (the set null from
-- profiles). security definer (owner postgres) so "is the parent gone" is judged on the real
-- tables, not through the caller's RLS.
create function private.group_events_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.groups as g where g.id = old.group_id) then
      return old;
    end if;
  elsif tg_op = 'UPDATE' then
    if old.actor_id is not null
       and new.actor_id is null
       and (new.id, new.seq, new.group_id, new.kind, new.details, new.created_at)
           is not distinct from
           (old.id, old.seq, old.group_id, old.kind, old.details, old.created_at)
       and not exists (select 1 from public.profiles as p where p.id = old.actor_id) then
      return new;
    end if;
  end if;
  raise exception using errcode = '42501', message = 'group_events_append_only';
end;
$$;

revoke execute on function private.group_events_append_only() from public, anon, authenticated;

create trigger group_events_append_only
  before update or delete on public.group_events
  for each row
  execute function private.group_events_append_only();

create trigger group_events_no_truncate
  before truncate on public.group_events
  for each statement
  execute function private.group_events_append_only();

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.group_hidden enable row level security;
alter table public.group_events enable row level security;

revoke all on public.groups from anon, authenticated, public;
revoke all on public.group_members from anon, authenticated, public;
revoke all on public.group_hidden from anon, authenticated, public;
revoke all on public.group_events from anon, authenticated, public;

-- Members read; no client role writes (no grant, no policy).
grant select on public.groups to authenticated;
grant select on public.group_members to authenticated;
grant select on public.group_events to authenticated;
-- group_hidden: nothing for any client role (read through my_groups()).

-- Nothing legitimate writes the audit trail as service_role; only private.log_group_event
-- (security definer, owner postgres) inserts. Cascades run as the table owner.
revoke insert, update, delete, truncate on public.group_events from service_role;

create policy "groups_select_member"
  on public.groups
  for select
  to authenticated
  using (private.is_group_member(id));

create policy "group_members_select_member"
  on public.group_members
  for select
  to authenticated
  using (private.is_group_member(group_id));

create policy "group_events_select_member"
  on public.group_events
  for select
  to authenticated
  using (private.is_group_member(group_id));

-- ---------------------------------------------------------------------------
-- profiles: one SELECT policy, now also co-members (U-G5)
-- ---------------------------------------------------------------------------
-- Column grants are unchanged (id, display_name, venmo_username), so a co-member sees exactly
-- what a co-participant sees.
drop policy "profiles_select_own_or_co_participant" on public.profiles;

create policy "profiles_select_own_or_co_participant_or_co_member"
  on public.profiles
  for select
  to authenticated
  using (
    id = (select auth.uid())
    or private.shares_bill_with(id)
    or private.shares_group_with(id)
  );

-- ---------------------------------------------------------------------------
-- public.create_group(p_id, p_name) -> uuid
-- ---------------------------------------------------------------------------
-- p_id is client-generated (A1.6, S3): the same id and the same trimmed name from the same
-- caller is a retry and returns the id with no new row or event; the same id with anything else
-- is 22023 id_conflict.
create function public.create_group(p_id uuid, p_name text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_name text := private.group_name(p_name);
  v_inserted uuid;
  v_code text;
  v_attempt integer := 0;
  v_constraint text;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  if p_id is null then
    raise exception using errcode = '22023', message = 'invalid_id';
  end if;
  if v_name is null or char_length(v_name) not between 1 and 60 then
    raise exception using errcode = '22023', message = 'invalid_name';
  end if;

  loop
    v_attempt := v_attempt + 1;
    v_code := encode(extensions.gen_random_bytes(10), 'hex');
    begin
      insert into public.groups (id, name, join_code, created_by)
      values (p_id, v_name, v_code, v_uid)
      on conflict (id) do nothing
      returning id into v_inserted;
      exit;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint <> 'groups_join_code_key' or v_attempt >= 3 then
        raise;
      end if;
    when foreign_key_violation then
      -- The caller has no profile row (account being deleted).
      raise exception using errcode = '42501', message = 'not_allowed';
    end;
  end loop;

  if v_inserted is null then
    -- The id exists: a retry, or a clash.
    if exists (
      select 1 from public.groups as g
      where g.id = p_id and g.created_by = v_uid and g.name = v_name
    ) then
      return p_id;
    end if;
    raise exception using errcode = '22023', message = 'id_conflict';
  end if;

  insert into public.group_members (group_id, user_id) values (p_id, v_uid);
  perform private.log_group_event(p_id, v_uid, 'group_created', jsonb_build_object('name', v_name));
  return p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- public.join_group(p_code) -> uuid
-- ---------------------------------------------------------------------------
-- Idempotent: a current member gets the id back with no write and no event. T5 re-creates it
-- to also add the joiner to every bill of the group (and repair missing participant rows, N6).
create function public.join_group(p_code text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_group_id uuid;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  if p_code is null or p_code !~ '^[0-9a-f]{20}$' then
    raise exception using errcode = 'P0002', message = 'invalid_code';
  end if;

  -- (a)/(b): the group lock before reading members. Holding the code is the permission.
  select g.id into v_group_id
  from public.groups as g
  where g.join_code = p_code
  for no key update;

  if v_group_id is null then
    raise exception using errcode = 'P0002', message = 'invalid_code';
  end if;

  if exists (
    select 1 from public.group_members as gm
    where gm.group_id = v_group_id and gm.user_id = v_uid
  ) then
    return v_group_id;
  end if;

  if (select count(*) from public.group_members as gm where gm.group_id = v_group_id) >= 50 then
    raise exception using errcode = '22023', message = 'group_full';
  end if;

  begin
    insert into public.group_members (group_id, user_id) values (v_group_id, v_uid);
  exception when foreign_key_violation then
    raise exception using errcode = '42501', message = 'not_allowed';
  end;
  perform private.log_group_event(v_group_id, v_uid, 'member_joined', '{}'::jsonb);
  return v_group_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- public.rename_group(p_group_id, p_name)
-- ---------------------------------------------------------------------------
create function public.rename_group(p_group_id uuid, p_name text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_name text := private.group_name(p_name);
  v_old text;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  -- Who may act, before any lock (lessons 2026-11-24, R4).
  if not exists (
    select 1 from public.group_members as gm
    where gm.group_id = p_group_id and gm.user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  if v_name is null or char_length(v_name) not between 1 and 60 then
    raise exception using errcode = '22023', message = 'invalid_name';
  end if;

  select g.name into v_old from public.groups as g where g.id = p_group_id for no key update;

  if not exists (
    select 1 from public.group_members as gm
    where gm.group_id = p_group_id and gm.user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if v_old = v_name then
    return; -- N4: same trimmed name, no write, no event.
  end if;

  update public.groups as g set name = v_name where g.id = p_group_id;
  perform private.log_group_event(
    p_group_id, v_uid, 'renamed', jsonb_build_object('from', v_old, 'to', v_name));
end;
$$;

-- ---------------------------------------------------------------------------
-- public.rotate_group_code(p_group_id) -> text
-- ---------------------------------------------------------------------------
create function public.rotate_group_code(p_group_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_code text;
  v_attempt integer := 0;
  v_constraint text;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  if not exists (
    select 1 from public.group_members as gm
    where gm.group_id = p_group_id and gm.user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  perform 1 from public.groups as g where g.id = p_group_id for update;

  if not exists (
    select 1 from public.group_members as gm
    where gm.group_id = p_group_id and gm.user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  loop
    v_attempt := v_attempt + 1;
    v_code := encode(extensions.gen_random_bytes(10), 'hex');
    begin
      update public.groups as g set join_code = v_code where g.id = p_group_id;
      exit;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint <> 'groups_join_code_key' or v_attempt >= 3 then
        raise;
      end if;
    end;
  end loop;

  perform private.log_group_event(p_group_id, v_uid, 'link_rotated', '{}'::jsonb);
  return v_code;
end;
$$;

-- ---------------------------------------------------------------------------
-- public.set_group_hidden(p_group_id, p_hidden)
-- ---------------------------------------------------------------------------
-- Writes or deletes only the caller's own group_hidden row. No event; no shared row changes.
create function public.set_group_hidden(p_group_id uuid, p_hidden boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  if not exists (
    select 1 from public.group_members as gm
    where gm.group_id = p_group_id and gm.user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  if p_hidden is null then
    raise exception using errcode = '22023', message = 'invalid_hidden';
  end if;

  if p_hidden then
    begin
      insert into public.group_hidden (group_id, user_id)
      values (p_group_id, v_uid)
      on conflict (group_id, user_id) do nothing;
    exception when foreign_key_violation then
      -- The caller's own leave_group committed after the check above.
      raise exception using errcode = '42501', message = 'not_allowed';
    end;
  else
    delete from public.group_hidden as h
    where h.group_id = p_group_id and h.user_id = v_uid;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- public.my_groups()
-- ---------------------------------------------------------------------------
-- The caller's groups, newest membership first. No arguments, so it only answers about the
-- caller. security definer to read the caller's own group_hidden row (no client grant on it).
create function public.my_groups()
returns table (id uuid, name text, member_count integer, joined_at timestamptz, hidden boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select
    g.id,
    g.name,
    (select count(*)::integer from public.group_members as m where m.group_id = g.id),
    me.joined_at,
    exists (
      select 1 from public.group_hidden as h
      where h.group_id = g.id and h.user_id = me.user_id
    )
  from public.group_members as me
  join public.groups as g on g.id = me.group_id
  where me.user_id = (select auth.uid())
  order by me.joined_at desc, g.id;
$$;

-- ---------------------------------------------------------------------------
-- public.leave_group(p_group_id)
-- ---------------------------------------------------------------------------
-- C-G10. In this migration the only refusal is "the only member": expenses, payments and group
-- bills don't exist yet. T3-T5 re-create this function with the history checks (and T5 with
-- the bill locks and participant deletes, rule (d)). Until then, rows those tasks add that
-- reference group_members with ON DELETE RESTRICT also make the delete fail with 23503, which
-- is answered as cannot_leave. A non-member (including someone who already left) gets 42501.
create function public.leave_group(p_group_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  if not exists (
    select 1 from public.group_members as gm
    where gm.group_id = p_group_id and gm.user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  -- (a)/(d) step 1: the group lock.
  perform 1 from public.groups as g where g.id = p_group_id for no key update;
  -- (d) step 2 (T5): the group's bills FOR UPDATE in ascending id.

  -- (d) step 3: re-check and history checks under the lock.
  if not exists (
    select 1 from public.group_members as gm
    where gm.group_id = p_group_id and gm.user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  if (select count(*) from public.group_members as gm where gm.group_id = p_group_id) <= 1 then
    raise exception using errcode = '22023', message = 'cannot_leave';
  end if;

  -- (d) step 4.
  begin
    delete from public.group_members as gm
    where gm.group_id = p_group_id and gm.user_id = v_uid;
  exception when foreign_key_violation then
    raise exception using errcode = '22023', message = 'cannot_leave';
  end;
  -- (d) step 5 (T5): the caller's participant rows on the group's bills.

  perform private.log_group_event(p_group_id, v_uid, 'member_left', '{}'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Execute grants: authenticated only
-- ---------------------------------------------------------------------------
revoke execute on function public.create_group(uuid, text) from public, anon, authenticated;
revoke execute on function public.join_group(text) from public, anon, authenticated;
revoke execute on function public.rename_group(uuid, text) from public, anon, authenticated;
revoke execute on function public.rotate_group_code(uuid) from public, anon, authenticated;
revoke execute on function public.set_group_hidden(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.my_groups() from public, anon, authenticated;
revoke execute on function public.leave_group(uuid) from public, anon, authenticated;

grant execute on function public.create_group(uuid, text) to authenticated;
grant execute on function public.join_group(text) to authenticated;
grant execute on function public.rename_group(uuid, text) to authenticated;
grant execute on function public.rotate_group_code(uuid) to authenticated;
grant execute on function public.set_group_hidden(uuid, boolean) to authenticated;
grant execute on function public.my_groups() to authenticated;
grant execute on function public.leave_group(uuid) to authenticated;
