-- Groups MVP, Task T3: simple expenses (spec docs/specs/2026-11-26-groups-mvp.md T3 as amended by
-- Amendment A1: C-G4, C-G5, C-G6, C-G9, C-G10/N3, A1.6 (S3), A1.9 (S10), A1.12 (GR-T8-6);
-- criteria 16-21, 34, 95, 99, 100, 101, 113; engineering review
-- docs/specs/2026-11-26-groups-mvp-eng.md B2a, S3, S10, N3; decisions GR-T3-... in
-- docs/decisions-to-review.md). Earlier migrations are applied and are not edited.
--
--   private.allocate(p_amount bigint, p_weights integer[]) -> integer[]
--                              largest remainder, the same algorithm as lib/split.ts allocate
--   private.expense_split(p_group_id, p_amount_cents, p_method, p_shares) -> jsonb
--                              validates p_shares (C-G4 / C-G5) and returns {uid: cents}
--   public.expenses            one cost; id client-generated; soft delete; version
--   public.expense_shares      (expense_id, user_id) -> cents, with group_id (S10)
--   public.add_expense(p_id, p_group_id, p_title, p_payer_id, p_amount_cents, p_method, p_shares)
--   public.edit_expense(p_id, p_expected_version, p_title, p_payer_id, p_amount_cents, p_method,
--                       p_shares)      no p_group_id: an expense can't move groups (GR-T9-7)
--   public.delete_expense(p_id, p_expected_version)   soft delete
--   public.leave_group(p_group_id)     re-created: adds the expense history checks (C-G10) and
--                                      drops the leaver's $0 share rows (N3)
--
-- ===========================================================================================
-- Rules shared with lib/ (CLAUDE.md: same rule both sides, same boundary rows in both tests)
-- ===========================================================================================
-- Title (C-G6, A1.12): private.group_name() trims exactly space, \t, \n, \r, \v, \f from both
-- ends (lib/groupExpense.ts normalizeTitle), then 1..100 code points (char_length). Stored
-- trimmed; expenses_title_trimmed repeats the pattern so no row holds an untrimmed title.
-- Amount: integer 1..99,999,999. Method: 'equal' | 'exact'.
-- p_shares (C-G4 / C-G5): a JSON object whose keys are lowercase canonical uuids of current
-- members.
--   equal: every value is the JSON integer 1, 1..50 keys; cents = private.allocate(amount,
--          [1, ...]) over the keys sorted by user_id::text collate "C" (lib: sortUserIds +
--          allocate). Every chosen user gets a row, $0 included (A3).
--   exact: every value a JSON integer 1..99,999,999 (not 1.5, not 1.0, not "100", not 0);
--          sum = amount exactly.
-- Duplicate keys can't be detected: PostgREST parses the body into jsonb, which keeps the last
-- one. lib never sends one (sortUserIds over a Set-checked list).
--
-- ===========================================================================================
-- LOCK ORDER (rule in 20261126082511_groups.sql; A1.2 / criterion 34)
-- ===========================================================================================
-- Money writes take NO explicit group lock (rule (a)). Each locks at most one expenses row.
-- Implicit locks listed in order:
--   add_expense     0. checks: signed out; caller membership (unlocked) -> 42501; fields;
--                      payer and share users' membership (unlocked) -> not_member.
--                   1. INSERT expenses ON CONFLICT (id) DO NOTHING: FK (group_id, payer_id) and
--                      (group_id, created_by) -> KEY SHARE on those group_members rows.
--                   2. INSERT expense_shares: FK (expense_id, group_id) -> KEY SHARE on the new
--                      expense row; FK (group_id, user_id) -> KEY SHARE on each share user's
--                      group_members row.
--                   3. INSERT group_events (private.log_group_event): KEY SHARE on the group row
--                      (compatible with the NO KEY UPDATE membership functions hold) and on the
--                      caller's profile.
--                   A 23503 in 1-2 (someone left after step 0) -> 22023 not_member.
--   edit_expense    0. checks (unlocked): the expense and the caller's membership of its group ->
--                      42501; creator or current payer -> 42501; fields; membership -> not_member.
--                   1. SELECT expenses ... FOR NO KEY UPDATE (the UPDATE below changes no
--                      unique-indexed column, so it needs no more). Conflicts with a concurrent
--                      edit/delete of the same expense only.
--                   2. re-check membership and creator/payer on the locked row; deleted ->
--                      version_changed; same fields -> success (retry, A1.6); version -> stale.
--                   3. DELETE expense_shares of this expense (row locks on those share rows).
--                   4. INSERT expense_shares: KEY SHARE on the expense row (held) and members.
--                   5. UPDATE expenses: FK checks on a changed payer -> KEY SHARE on the new
--                      payer's group_members row.
--                   6. INSERT group_events: KEY SHARE on the group row and profile.
--                   Deletes come before every insert, so while edit_expense waits on a share row
--                   leave_group deleted (its $0 rows), it holds no KEY SHARE leave_group's
--                   membership delete would wait for: no cycle.
--   delete_expense  0. checks as edit. 1. SELECT expenses FOR NO KEY UPDATE. 2. re-check;
--                      already deleted -> no-op; stale version -> version_changed.
--                   3. UPDATE deleted_at / deleted_by (no FK column changes). 4. INSERT event.
--   leave_group     as in 20261126082511_groups.sql, with in step 3 the expense history checks,
--                   then the leaver's $0 expense_shares rows of this group deleted (row locks on
--                   them; waits for an edit that deleted them first), then the group_members
--                   delete (FOR UPDATE on that row; waits for any money write holding KEY SHARE
--                   on it, then fails 23503 if that write committed a row naming the leaver ->
--                   22023 cannot_leave). T5 re-creates it again with the bill locks.
--
-- ===========================================================================================
-- Columns clients can't read
-- ===========================================================================================
-- None on these two tables: members hold table-level SELECT on expenses and expense_shares
-- (every column, deleted rows included, so select('*') works for members). Rows of groups the
-- caller isn't in are hidden by RLS (0 rows). No client role has INSERT, UPDATE or DELETE on
-- either table; every write goes through the functions below.
--
-- ===========================================================================================
-- Errors
-- ===========================================================================================
--   42501 not_allowed     signed out; not a member of the group (or the expense / group doesn't
--                         exist: same answer); edit/delete by someone who is neither the creator
--                         nor the current payer
--   42501 permission denied  anon executing any function; any direct table write
--   22023 invalid_id      add_expense with p_id null
--   22023 invalid_expense title, amount or method invalid (C-G6)
--   22023 invalid_shares  p_shares badly shaped, values wrong for the method, exact sum <> amount
--                         (also raised by private.allocate for negative weights or weights
--                         summing to 0 with an amount <> 0, A10)
--   22023 not_member      the payer or a share user isn't a current member (X8)
--   22023 id_conflict     add_expense: the id exists with other content, another group or another
--                         creator
--   22023 version_changed edit/delete: stale p_expected_version (or null); edit of a deleted
--                         expense
--   22023 cannot_leave    leave_group: payer or creator of an expense (deleted included), or a
--                         share user with cents > 0 (deleted included); the last member
--
-- Events (group_events; kinds already in group_events_kind_known from T2):
--   expense_added   {expense_id, title, amount_cents}
--   expense_edited  {expense_id, before: {title, amount_cents, payer_id, split_method},
--                                after:  {title, amount_cents, payer_id, split_method}}
--   expense_deleted {expense_id, title, amount_cents}
-- title is added to added/deleted so Activity can name a deleted expense (the snapshot omits
-- deleted rows; GR-T3-3).

-- ---------------------------------------------------------------------------
-- private.allocate (C-G4): the SQL twin of lib/split.ts allocate
-- ---------------------------------------------------------------------------
-- Floors of amount * w / sum(w), then the leftover cents one each to the largest remainders,
-- ties to the lower index. A negative amount is the negated allocation of its absolute value
-- (as lib). Sum of weights 0: all zeros if the amount is 0, else refused. Negative or null
-- weights, a null amount or a null array: refused. Arithmetic in numeric (exact integers, so the
-- same results as bigint floors without an overflow path); results cast to integer.
create function private.allocate(p_amount bigint, p_weights integer[])
returns integer[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_total numeric;
  v_left numeric;
  v_result integer[];
begin
  if p_amount is null or p_weights is null
     or exists (select 1 from unnest(p_weights) as w(v) where w.v is null or w.v < 0) then
    raise exception using errcode = '22023', message = 'invalid_shares';
  end if;
  if p_amount < 0 then
    return (select coalesce(array_agg(-a.v order by a.i), '{}'::integer[])
            from unnest(private.allocate(-p_amount, p_weights)) with ordinality as a(v, i));
  end if;

  select coalesce(sum(w.v), 0) into v_total from unnest(p_weights) as w(v);
  if v_total = 0 then
    if p_amount <> 0 then
      raise exception using errcode = '22023', message = 'invalid_shares';
    end if;
    return (select coalesce(array_agg(0), '{}'::integer[]) from unnest(p_weights));
  end if;

  select p_amount - sum(div(p_amount::numeric * w.v, v_total))
  into v_left
  from unnest(p_weights) as w(v);

  select array_agg((r.fl + case when r.rn <= v_left then 1 else 0 end)::integer order by r.i)
  into v_result
  from (
    select w.i,
           div(p_amount::numeric * w.v, v_total) as fl,
           row_number() over (order by mod(p_amount::numeric * w.v, v_total) desc, w.i) as rn
    from unnest(p_weights) with ordinality as w(v, i)
  ) as r;
  return v_result;
end;
$$;

revoke execute on function private.allocate(bigint, integer[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- private.expense_split: p_shares -> {uid: cents} (C-G4 / C-G5), or raises
-- ---------------------------------------------------------------------------
-- Order: shape (invalid_shares), membership (not_member), sum (invalid_shares). Called only from
-- the security-definer functions below (it then runs as their owner and reads group_members past
-- RLS). Not executable by clients.
create function private.expense_split(
  p_group_id uuid,
  p_amount_cents bigint,
  p_method text,
  p_shares jsonb
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_count integer;
  v_ids uuid[];
  v_cents integer[];
begin
  if p_shares is null or jsonb_typeof(p_shares) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_shares';
  end if;
  select count(*) into v_count from jsonb_object_keys(p_shares);
  if v_count < 1 or (p_method = 'equal' and v_count > 50) then
    raise exception using errcode = '22023', message = 'invalid_shares';
  end if;
  if exists (
    select 1 from jsonb_each(p_shares) as e
    where e.key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or (p_method = 'equal' and not private.jsonb_int_between(e.value, 1, 1))
       or (p_method = 'exact' and not private.jsonb_int_between(e.value, 1, 99999999))
  ) then
    raise exception using errcode = '22023', message = 'invalid_shares';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_shares) as k(key)
    where not exists (
      select 1 from public.group_members as gm
      where gm.group_id = p_group_id and gm.user_id = k.key::uuid
    )
  ) then
    raise exception using errcode = '22023', message = 'not_member';
  end if;

  if p_method = 'exact' then
    if (select sum((e.value #>> '{}')::bigint) from jsonb_each(p_shares) as e) <> p_amount_cents then
      raise exception using errcode = '22023', message = 'invalid_shares';
    end if;
    return (select jsonb_object_agg(e.key, (e.value #>> '{}')::integer) from jsonb_each(p_shares) as e);
  end if;

  -- equal: user id order in code-unit order of the lowercase uuid text (C-G4).
  select array_agg(k.key::uuid order by k.key collate "C")
  into v_ids
  from jsonb_object_keys(p_shares) as k(key);
  v_cents := private.allocate(p_amount_cents, array_fill(1, array[v_count]));
  return (select jsonb_object_agg(v_ids[i]::text, v_cents[i]) from generate_subscripts(v_ids, 1) as i);
end;
$$;

revoke execute on function private.expense_split(uuid, bigint, text, jsonb)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.expenses (
  -- Client-generated (A1.6): the retry key for add_expense.
  id uuid primary key,
  group_id uuid not null,
  title text not null
    constraint expenses_title_length check (char_length(title) between 1 and 100)
    constraint expenses_title_trimmed
      check (title = regexp_replace(title, '^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$', '', 'g')),
  payer_id uuid not null,
  amount_cents integer not null
    constraint expenses_amount_range check (amount_cents between 1 and 99999999),
  split_method text not null
    constraint expenses_split_method_known check (split_method in ('equal', 'exact')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  version integer not null default 1
    constraint expenses_version_positive check (version >= 1),
  deleted_at timestamptz,
  deleted_by uuid,
  constraint expenses_deleted_pair check ((deleted_at is null) = (deleted_by is null)),
  -- Only the creator or the payer deletes, and a deleted expense is never edited, so deleted_by
  -- is always one of the two (both restrict-referenced below). No extra FK lock needed.
  constraint expenses_deleted_by_party check (deleted_by is null or deleted_by in (created_by, payer_id)),
  -- Target of expense_shares' composite FK (A1.9, S10).
  constraint expenses_id_group_key unique (id, group_id),
  -- on delete restrict (T3, S8): history blocks leaving (C-G10) and account deletion.
  constraint expenses_payer_member_fkey foreign key (group_id, payer_id)
    references public.group_members (group_id, user_id) on delete restrict,
  constraint expenses_creator_member_fkey foreign key (group_id, created_by)
    references public.group_members (group_id, user_id) on delete restrict
);

comment on table public.expenses is
  'Groups MVP (ADR 0022) simple expenses. Written only by add/edit/delete_expense; members read.';

create index expenses_group_created_idx on public.expenses (group_id, created_at, id);
create index expenses_group_payer_idx on public.expenses (group_id, payer_id);
create index expenses_group_creator_idx on public.expenses (group_id, created_by);

create table public.expense_shares (
  expense_id uuid not null,
  group_id uuid not null,
  user_id uuid not null,
  cents integer not null
    constraint expense_shares_cents_range check (cents between 0 and 99999999),
  primary key (expense_id, user_id),
  -- A share can't point at another group's expense (S10).
  constraint expense_shares_expense_fkey foreign key (expense_id, group_id)
    references public.expenses (id, group_id) on delete cascade,
  constraint expense_shares_member_fkey foreign key (group_id, user_id)
    references public.group_members (group_id, user_id) on delete restrict
);

create index expense_shares_group_user_idx on public.expense_shares (group_id, user_id);

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------
alter table public.expenses enable row level security;
alter table public.expense_shares enable row level security;

revoke all on public.expenses from anon, authenticated, public;
revoke all on public.expense_shares from anon, authenticated, public;

grant select on public.expenses to authenticated;
grant select on public.expense_shares to authenticated;

create policy "expenses_select_member"
  on public.expenses
  for select
  to authenticated
  using (private.is_group_member(group_id));

create policy "expense_shares_select_member"
  on public.expense_shares
  for select
  to authenticated
  using (private.is_group_member(group_id));

-- ---------------------------------------------------------------------------
-- private.check_expense_fields: the C-G6 checks shared by add and edit (raises invalid_expense)
-- ---------------------------------------------------------------------------
create function private.check_expense_fields(p_title text, p_amount_cents bigint, p_method text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_title is null or char_length(p_title) not between 1 and 100
     or p_amount_cents is null or p_amount_cents not between 1 and 99999999
     or p_method is null or p_method not in ('equal', 'exact') then
    raise exception using errcode = '22023', message = 'invalid_expense';
  end if;
end;
$$;

revoke execute on function private.check_expense_fields(text, bigint, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- public.add_expense
-- ---------------------------------------------------------------------------
-- Any member. Same id + same content (group, creator, title, payer, amount, method, stored
-- shares) -> success with no write and no event, even if the expense was deleted (it stays
-- deleted, A1.6). Same id with anything else -> 22023 id_conflict.
create function public.add_expense(
  p_id uuid,
  p_group_id uuid,
  p_title text,
  p_payer_id uuid,
  p_amount_cents bigint,
  p_method text,
  p_shares jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_title text := private.group_name(p_title);
  v_split jsonb;
  v_inserted uuid;
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
  if p_id is null then
    raise exception using errcode = '22023', message = 'invalid_id';
  end if;
  perform private.check_expense_fields(v_title, p_amount_cents, p_method);
  if not exists (
    select 1 from public.group_members as gm
    where gm.group_id = p_group_id and gm.user_id = p_payer_id
  ) then
    raise exception using errcode = '22023', message = 'not_member';
  end if;
  v_split := private.expense_split(p_group_id, p_amount_cents, p_method, p_shares);

  begin
    insert into public.expenses (id, group_id, title, payer_id, amount_cents, split_method, created_by)
    values (p_id, p_group_id, v_title, p_payer_id, p_amount_cents::integer, p_method, v_uid)
    on conflict (id) do nothing
    returning id into v_inserted;

    if v_inserted is not null then
      insert into public.expense_shares (expense_id, group_id, user_id, cents)
      select p_id, p_group_id, e.key::uuid, (e.value #>> '{}')::integer
      from jsonb_each(v_split) as e;
    end if;
  exception when foreign_key_violation then
    -- The payer, a share user or the caller left after the checks above.
    raise exception using errcode = '22023', message = 'not_member';
  end;

  if v_inserted is null then
    -- The id exists: a retry, or a clash.
    if exists (
      select 1 from public.expenses as x
      where x.id = p_id
        and x.group_id = p_group_id
        and x.created_by = v_uid
        and x.title = v_title
        and x.payer_id = p_payer_id
        and x.amount_cents = p_amount_cents
        and x.split_method = p_method
        and (select jsonb_object_agg(s.user_id::text, s.cents)
             from public.expense_shares as s where s.expense_id = x.id) = v_split
    ) then
      return;
    end if;
    raise exception using errcode = '22023', message = 'id_conflict';
  end if;

  perform private.log_group_event(p_group_id, v_uid, 'expense_added',
    jsonb_build_object('expense_id', p_id, 'title', v_title, 'amount_cents', p_amount_cents));
end;
$$;

-- ---------------------------------------------------------------------------
-- public.edit_expense
-- ---------------------------------------------------------------------------
-- The creator or the current payer (C-G9). If the stored fields already equal the requested
-- ones -> success with no write and no event, before the version check (a retry after a lost
-- response, A1.6). Else a stale p_expected_version -> version_changed. Else the shares are
-- replaced, version + 1, edited_at = now(), one expense_edited event.
create function public.edit_expense(
  p_id uuid,
  p_expected_version integer,
  p_title text,
  p_payer_id uuid,
  p_amount_cents bigint,
  p_method text,
  p_shares jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_title text := private.group_name(p_title);
  v_group_id uuid;
  v_split jsonb;
  v_row public.expenses%rowtype;
  v_stored jsonb;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  -- Who may act, before any lock.
  select x.group_id into v_group_id
  from public.expenses as x
  where x.id = p_id
    and (x.created_by = v_uid or x.payer_id = v_uid)
    and exists (
      select 1 from public.group_members as gm
      where gm.group_id = x.group_id and gm.user_id = v_uid
    );
  if v_group_id is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  perform private.check_expense_fields(v_title, p_amount_cents, p_method);
  if not exists (
    select 1 from public.group_members as gm
    where gm.group_id = v_group_id and gm.user_id = p_payer_id
  ) then
    raise exception using errcode = '22023', message = 'not_member';
  end if;
  v_split := private.expense_split(v_group_id, p_amount_cents, p_method, p_shares);

  select * into v_row from public.expenses as x where x.id = p_id for no key update;

  -- Re-check on the locked row (the payer may have changed meanwhile).
  if not (v_row.created_by = v_uid or v_row.payer_id = v_uid)
     or not exists (
       select 1 from public.group_members as gm
       where gm.group_id = v_group_id and gm.user_id = v_uid
     ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  if v_row.deleted_at is not null then
    raise exception using errcode = '22023', message = 'version_changed';
  end if;

  select jsonb_object_agg(s.user_id::text, s.cents) into v_stored
  from public.expense_shares as s where s.expense_id = p_id;

  if v_row.title = v_title
     and v_row.payer_id = p_payer_id
     and v_row.amount_cents = p_amount_cents
     and v_row.split_method = p_method
     and v_stored = v_split then
    return; -- nothing to change (or a retry of an edit that already landed)
  end if;

  if p_expected_version is null or v_row.version <> p_expected_version then
    raise exception using errcode = '22023', message = 'version_changed';
  end if;

  begin
    delete from public.expense_shares as s where s.expense_id = p_id;
    insert into public.expense_shares (expense_id, group_id, user_id, cents)
    select p_id, v_group_id, e.key::uuid, (e.value #>> '{}')::integer
    from jsonb_each(v_split) as e;
    update public.expenses as x
    set title = v_title,
        payer_id = p_payer_id,
        amount_cents = p_amount_cents::integer,
        split_method = p_method,
        version = x.version + 1,
        edited_at = now()
    where x.id = p_id;
  exception when foreign_key_violation then
    raise exception using errcode = '22023', message = 'not_member';
  end;

  perform private.log_group_event(v_group_id, v_uid, 'expense_edited',
    jsonb_build_object(
      'expense_id', p_id,
      'before', jsonb_build_object('title', v_row.title, 'amount_cents', v_row.amount_cents,
                                   'payer_id', v_row.payer_id, 'split_method', v_row.split_method),
      'after', jsonb_build_object('title', v_title, 'amount_cents', p_amount_cents,
                                  'payer_id', p_payer_id, 'split_method', p_method)));
end;
$$;

-- ---------------------------------------------------------------------------
-- public.delete_expense
-- ---------------------------------------------------------------------------
-- Soft delete by the creator or the current payer. Already deleted -> no-op (whatever the
-- version). A stale version on a live expense -> version_changed. Delete doesn't bump version.
create function public.delete_expense(p_id uuid, p_expected_version integer)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_group_id uuid;
  v_row public.expenses%rowtype;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  select x.group_id into v_group_id
  from public.expenses as x
  where x.id = p_id
    and (x.created_by = v_uid or x.payer_id = v_uid)
    and exists (
      select 1 from public.group_members as gm
      where gm.group_id = x.group_id and gm.user_id = v_uid
    );
  if v_group_id is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  select * into v_row from public.expenses as x where x.id = p_id for no key update;

  if not (v_row.created_by = v_uid or v_row.payer_id = v_uid)
     or not exists (
       select 1 from public.group_members as gm
       where gm.group_id = v_group_id and gm.user_id = v_uid
     ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  if v_row.deleted_at is not null then
    return; -- repeat: no-op
  end if;
  if p_expected_version is null or v_row.version <> p_expected_version then
    raise exception using errcode = '22023', message = 'version_changed';
  end if;

  update public.expenses as x
  set deleted_at = now(), deleted_by = v_uid
  where x.id = p_id;

  perform private.log_group_event(v_group_id, v_uid, 'expense_deleted',
    jsonb_build_object('expense_id', p_id, 'title', v_row.title, 'amount_cents', v_row.amount_cents));
end;
$$;

-- ---------------------------------------------------------------------------
-- public.leave_group (re-created; C-G10 expense history, N3)
-- ---------------------------------------------------------------------------
-- Same as 20261126082511_groups.sql plus, under the group lock: refused (cannot_leave) when the
-- caller is payer or creator of any expense of the group, or has a share with cents > 0, deleted
-- expenses included. Shares of 0 cents (an equal split smaller than the people in it, A3) are
-- not history (N3): the caller's 0-cent rows are deleted just before the membership row (the
-- restrict FK would refuse otherwise). This never changes money: the rows are 0, and dropping
-- 0-cent users from an equal split leaves every other share as it was (with amount < n the
-- 0-cent users are the highest ids, and allocate gives 1 cent to each of the lowest `amount`
-- ids either way). T4 and T5 re-create this function again (payments; bills).
create or replace function public.leave_group(p_group_id uuid)
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
  -- (d) step 2 (T5): the group's bills, ascending id.

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
  if exists (
    select 1 from public.expenses as x
    where x.group_id = p_group_id and (x.payer_id = v_uid or x.created_by = v_uid)
  ) or exists (
    select 1 from public.expense_shares as s
    where s.group_id = p_group_id and s.user_id = v_uid and s.cents > 0
  ) then
    raise exception using errcode = '22023', message = 'cannot_leave';
  end if;

  -- N3: the caller's 0-cent shares are not history.
  delete from public.expense_shares as s
  where s.group_id = p_group_id and s.user_id = v_uid and s.cents = 0;

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
-- Execute grants: authenticated only (create or replace keeps leave_group's; restated)
-- ---------------------------------------------------------------------------
revoke execute on function public.add_expense(uuid, uuid, text, uuid, bigint, text, jsonb)
  from public, anon, authenticated;
revoke execute on function public.edit_expense(uuid, integer, text, uuid, bigint, text, jsonb)
  from public, anon, authenticated;
revoke execute on function public.delete_expense(uuid, integer) from public, anon, authenticated;
revoke execute on function public.leave_group(uuid) from public, anon, authenticated;

grant execute on function public.add_expense(uuid, uuid, text, uuid, bigint, text, jsonb) to authenticated;
grant execute on function public.edit_expense(uuid, integer, text, uuid, bigint, text, jsonb) to authenticated;
grant execute on function public.delete_expense(uuid, integer) to authenticated;
grant execute on function public.leave_group(uuid) to authenticated;
