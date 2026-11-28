-- Group claim status, Task T1 (spec docs/specs/2026-11-27-group-claim-status.md C3, C4;
-- criteria 1-11; decisions GCS-1 ... GCS-14 in docs/decisions-to-review.md). Earlier migrations
-- are applied and are not edited.
--
--   public.bill_not_part              owner-only "I wasn't part of this" per (bill, person) (C3)
--   public.set_not_part               the only writer (the caller's own row)
--   private.claims_clear_not_part()   AFTER INSERT ON claims: a claim removes the claimer's row
--                                     ("claims win", C1 / GCS-4)
--   public.group_snapshot             re-created from 20261127061004_group_snapshot.sql (the
--                                     newest definition on disk, and the live one, checked with
--                                     pg_get_functiondef before writing this): `me` gains
--                                     "not_part_bill_ids" (C4). Every other key is unchanged.
--
-- "Not part of this" changes no money and no shared row: no bills, line_items, claims,
-- bill_participants, bill_events, group_events, group_payments or expenses row is written by
-- set_not_part (criterion 9). Only claims inserts touch bill_not_part, through the trigger.
--
-- ===========================================================================================
-- Columns clients can't read
-- ===========================================================================================
-- None hidden. authenticated has SELECT on all three columns (bill_id, user_id, created_at),
-- limited by RLS to its own rows, so `select('*')` works on this table. No client role has
-- INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER, so any direct write (including an
-- upsert) fails with 42501. anon has nothing: its select fails with 42501.
--
-- ===========================================================================================
-- Nothing here logs or broadcasts (GCS-3)
-- ===========================================================================================
-- Private state about a shared bill, like bill_seen (lesson 2026-11-24 "Per-person state about a
-- shared bill went in an owner-only table"). No bill_events / group_events row, no Realtime
-- broadcast trigger, and the table isn't in any publication (supabase_realtime is not FOR ALL
-- TABLES). Other people can't learn that someone said "not part of this".
--
-- ===========================================================================================
-- LOCK ORDER (rules in 20261124094656_people_review_fixes.sql "the bills row first" and
-- 20261126082511_groups.sql: group, bills, bill_participants, claims; implicit locks count)
-- ===========================================================================================
-- set_not_part, in order (both directions take the same locks):
--   0. signed-out / null-argument checks, then the participation check: a plain read of
--      bill_participants, NO lock. A stranger or a missing bill gets 42501 not_allowed without
--      making the bill's writers wait (lesson 2026-11-24 R4).
--   1. private.lock_bill_key_share(bill): FOR KEY SHARE on the bills row. Queues behind
--      attach_bill_to_group / detach_bill_from_group / leave_group / update_bill / set_payer /
--      remove_participant / leave_bill (FOR UPDATE on bills), so bills.group_id and the caller's
--      participation can't change while this runs. Runs alongside claims and marks.
--   2. SELECT the caller's own bill_participants row FOR UPDATE (also the re-check under the
--      lock: gone -> 42501 not_allowed). FOR UPDATE is the one row lock that conflicts with
--      FOR KEY SHARE, which every claims insert takes on this same row through
--      claims_participant_fkey (set_claim, set_item_split, assign_item assigning the caller, a
--      direct insert). So step 4's "no claims" read and step 5's insert can't interleave with a
--      claim insert for the same person:
--        * a claim insert that got its KEY SHARE first makes step 2 wait until it commits; plpgsql
--          takes a fresh snapshot per statement, so step 4 then sees the claim -> has_claims;
--        * if step 2 got the row first, the claim insert's FK check waits until this commits;
--          its claims_clear_not_part trigger (a later statement, new snapshot) then deletes the
--          row this call wrote.
--      FOR NO KEY UPDATE would not do: it doesn't conflict with FOR KEY SHARE.
--   3. read bills.group_id (true only; the bill lock from step 1 holds it still).
--   4. read claims for (bill, caller) (true only), no lock (see step 2).
--   5. INSERT ... ON CONFLICT DO NOTHING into bill_not_part (true): its FK takes FOR KEY SHARE on
--      the participant row, already held FOR UPDATE; a repeat finds the existing row.
--      DELETE from bill_not_part (false): a row lock on the caller's row only.
--   No event insert, so no further FK lock on bills or profiles.
-- Order: bills -> bill_participants -> (claims read) -> bill_not_part, the same direction as
-- every other path.
--
-- claims_clear_not_part (inside any claims insert): the insert has already taken bills (the
-- claims_lock_bill_first BEFORE trigger, when the inserter is a participant), the line item and
-- the participant row (FK KEY SHARE); the trigger then row-locks and deletes at most one
-- bill_not_part row. Same direction: bills -> bill_participants -> bill_not_part.
-- assign_item (Ana assigning Ben) holds bills (KEY SHARE) and the line item (FOR UPDATE), then
-- waits for Ben's participant row; set_not_part never waits for a line item, so no cycle.
--
-- New cascade: bill_not_part (bill_id, user_id) -> bill_participants ON DELETE CASCADE, the same
-- shape as bill_seen. remove_participant / leave_bill / leave_group take the bill FOR UPDATE
-- first, and step 1 conflicts with that, so they never run at the same time as set_not_part on
-- one bill. Bill deletion goes through the bills row first. Account deletion of a participant
-- cascades auth.users -> profiles -> bill_participants without locking the bill first: the
-- existing R9 gap (docs/before-production.md); this table adds one more row to that cascade and
-- no new ordering. If it races set_not_part, step 2 finds the row gone (42501), or the insert's FK
-- check fails (23503), mapped to 42501 not_allowed. No FK to profiles or auth.users is added, so
-- account deletion isn't blocked (lesson 2026-11-27).
--
-- Not testable in pgTAP (one session): a real two-session race. bill_not_part.test.sql checks
-- the order of the statements in the function body instead (as people_review_fixes.test.sql).
--
-- ===========================================================================================
-- set_not_part: checks, in this order
-- ===========================================================================================
--   1. signed out, p_bill_id null, p_not_part null                  -> 42501 not_allowed
--   2. no such bill, or the caller isn't a participant (one answer)  -> 42501 not_allowed
--   -- locks --
--   3. the caller's participant row is gone under the lock           -> 42501 not_allowed
--   p_not_part = false: delete the caller's row if any; success, group or not (a stale opt-out
--      can always be cleared).
--   p_not_part = true:
--   4. bills.group_id is null                                         -> 22023 not_in_group
--   5. the caller has any claims row on the bill (a split row too)   -> 22023 has_claims
--   6. insert on conflict do nothing (a repeat is a no-op success).
--
-- ===========================================================================================
-- Trigger functions and EXECUTE (lesson 2026-11-27 "A function used in a CHECK constraint needs
-- EXECUTE for every role that writes")
-- ===========================================================================================
-- Verified on the installed Postgres 17 before writing: Postgres checks EXECUTE on a trigger
-- function only at CREATE TRIGGER, not when the trigger fires. private.claims_lock_bill_first()
-- has EXECUTE for postgres only, and authenticated / service_role claim inserts work. So
-- claims_clear_not_part's EXECUTE is revoked from every client role; bill_not_part.test.sql
-- (criterion 8) proves inserts by authenticated (set_claim, assign_item) and by service_role
-- (a direct insert) still succeed and clear the row.

-- ---------------------------------------------------------------------------
-- public.bill_not_part (C3)
-- ---------------------------------------------------------------------------
create table public.bill_not_part (
  bill_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  constraint bill_not_part_pkey primary key (bill_id, user_id),
  constraint bill_not_part_participant_fkey foreign key (bill_id, user_id)
    references public.bill_participants (bill_id, user_id) on delete cascade
);
-- The primary key indexes the foreign key's columns (the cascade is an index scan). The RLS
-- policy and group_snapshot look rows up by user_id, so it gets its own index.
create index bill_not_part_user_idx on public.bill_not_part (user_id, bill_id);

comment on table public.bill_not_part is
  'Owner-only "I wasn''t part of this" (spec group-claim-status C3, GCS-3). A row means this '
  'person said they had nothing on this group bill. Written only by set_not_part; deleted by '
  'set_not_part(false), by any claim for the same person (claims_clear_not_part) and with the '
  'participant row (cascade). Readable only by its owner. Changes no money. No events, no broadcast.';

alter table public.bill_not_part enable row level security;
revoke all on table public.bill_not_part from anon, authenticated, public;
grant select (bill_id, user_id, created_at) on table public.bill_not_part to authenticated;

create policy bill_not_part_select_own on public.bill_not_part
  for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- public.set_not_part (C3)
-- ---------------------------------------------------------------------------
create function public.set_not_part(p_bill_id uuid, p_not_part boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_group uuid;
begin
  -- 1. Signed out or null arguments.
  if v_uid is null or p_bill_id is null or p_not_part is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  -- 2. Who may act, without a lock.
  if not exists (
    select 1 from public.bill_participants as bp
    where bp.bill_id = p_bill_id and bp.user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  -- Lock order: the bills row first (FOR KEY SHARE) ...
  perform private.lock_bill_key_share(p_bill_id);

  -- ... then the caller's own participant row FOR UPDATE (3. the re-check under the lock).
  perform 1 from public.bill_participants as bp
  where bp.bill_id = p_bill_id and bp.user_id = v_uid
  for update of bp;
  if not found then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if not p_not_part then
    delete from public.bill_not_part as np
    where np.bill_id = p_bill_id and np.user_id = v_uid;
    return;
  end if;

  -- 4. Only a group bill can be opted out of.
  select b.group_id into v_group from public.bills as b where b.id = p_bill_id;
  if v_group is null then
    raise exception using errcode = '22023', message = 'not_in_group';
  end if;

  -- 5. Claims win.
  if exists (
    select 1 from public.claims as c
    where c.bill_id = p_bill_id and c.user_id = v_uid
  ) then
    raise exception using errcode = '22023', message = 'has_claims';
  end if;

  -- 6. The write (FK KEY SHARE on the participant row, already held FOR UPDATE).
  begin
    insert into public.bill_not_part (bill_id, user_id)
    values (p_bill_id, v_uid)
    on conflict (bill_id, user_id) do nothing;
  exception
    when foreign_key_violation then
      raise exception using errcode = '42501', message = 'not_allowed';
  end;
end;
$$;

comment on function public.set_not_part(uuid, boolean) is
  'Group claim status (C3): the caller says they were (false) or weren''t (true) part of a group '
  'bill. 42501 not_allowed; 22023 not_in_group / has_claims (true only). Changes no money.';

alter function public.set_not_part(uuid, boolean) owner to postgres;
revoke execute on function public.set_not_part(uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_not_part(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- private.claims_clear_not_part (C3, GCS-4): a claim for a person removes their opt-out
-- ---------------------------------------------------------------------------
create function private.claims_clear_not_part()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.bill_not_part as np
  where np.bill_id = new.bill_id and np.user_id = new.user_id;
  return null;
end;
$$;

alter function private.claims_clear_not_part() owner to postgres;
revoke execute on function private.claims_clear_not_part() from public, anon, authenticated, service_role;

create trigger claims_clear_not_part
  after insert on public.claims
  for each row execute function private.claims_clear_not_part();

-- ---------------------------------------------------------------------------
-- public.group_snapshot (C4): re-created; only `me` changes
-- ---------------------------------------------------------------------------
-- Shape as documented in 20261127061004_group_snapshot.sql, except:
--   "me": { "hidden": boolean, "not_part_bill_ids": [ uuid ] }
--     the caller's own bill_not_part.bill_id values for bills with group_id = G, ordered by
--     bill_id; [] when none. Never another person's rows. Every id is one of "bills"[].id (the
--     same bills.group_id = G condition, in the same statement and snapshot).
-- Still one statement, no row locks, security definer (bill_not_part has an own-rows policy,
-- but the function runs as its owner like the rest of the payload), execute: authenticated only.
create or replace function public.group_snapshot(p_group_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_out jsonb;
begin
  -- One statement: the membership check and the payload read one snapshot. (A stable plpgsql
  -- function also runs every statement on the calling query's snapshot.)
  select jsonb_build_object(
    'group', jsonb_build_object(
      'id', g.id,
      'name', g.name,
      'join_code', g.join_code,
      'created_by', g.created_by,
      'created_at', g.created_at),
    'me', jsonb_build_object(
      'hidden', exists (
        select 1 from public.group_hidden as h
        where h.group_id = g.id and h.user_id = v_uid),
      'not_part_bill_ids', coalesce((
        select jsonb_agg(np.bill_id order by np.bill_id)
        from public.bill_not_part as np
        join public.bills as nb on nb.id = np.bill_id
        where np.user_id = v_uid and nb.group_id = g.id), '[]'::jsonb)),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', m.user_id,
               'display_name', p.display_name,
               'venmo_username', p.venmo_username,
               'joined_at', m.joined_at)
             order by m.joined_at, m.user_id)
      from public.group_members as m
      join public.profiles as p on p.id = m.user_id
      where m.group_id = g.id), '[]'::jsonb),
    'bills', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', b.id,
               'host_id', b.host_id,
               'payer_id', b.payer_id,
               'total_cents', b.total_cents,
               'extras_split', b.extras_split,
               'created_at', b.created_at,
               'rows', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'id', li.id,
                          'total_cents', li.total_cents,
                          'kind', li.kind,
                          'name', case when rc.claims is null then li.name end,
                          'claims', coalesce(rc.claims, '{}'::jsonb))
                        order by li.group_position, li.unit_index)
                 from public.line_items as li
                 left join lateral (
                   select jsonb_object_agg(c.user_id::text, c.parts) as claims
                   from public.claims as c
                   where c.line_item_id = li.id
                 ) as rc on true
                 where li.bill_id = b.id), '[]'::jsonb),
               'participant_ids', coalesce((
                 select jsonb_agg(bp.user_id order by bp.user_id)
                 from public.bill_participants as bp
                 where bp.bill_id = b.id), '[]'::jsonb))
             order by b.created_at, b.id)
      from public.bills as b
      where b.group_id = g.id), '[]'::jsonb),
    'expenses', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', e.id,
               'title', e.title,
               'payer_id', e.payer_id,
               'amount_cents', e.amount_cents,
               'split_method', e.split_method,
               'created_by', e.created_by,
               'created_at', e.created_at,
               'edited_at', e.edited_at,
               'version', e.version,
               'shares', coalesce((
                 select jsonb_agg(jsonb_build_object('user_id', s.user_id, 'cents', s.cents)
                                  order by s.user_id)
                 from public.expense_shares as s
                 where s.expense_id = e.id), '[]'::jsonb))
             order by e.created_at, e.id)
      from public.expenses as e
      where e.group_id = g.id and e.deleted_at is null), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', gp.id,
               'from_user', gp.from_user,
               'to_user', gp.to_user,
               'cents', gp.cents,
               'method', gp.method,
               'source', gp.source,
               'recorded_by', gp.recorded_by,
               'bill_id', gp.bill_id,
               'created_at', gp.created_at)
             order by gp.created_at, gp.id)
      from public.group_payments as gp
      where gp.group_id = g.id and gp.undone_at is null), '[]'::jsonb),
    'not_received', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', nr.id,
               'from', nr.from_user,
               'to', nr.to_user,
               'cents', nr.cents,
               'method', nr.method,
               'undone_at', nr.undone_at)
             order by nr.undone_at desc, nr.id)
      from public.group_payments as nr
      where nr.group_id = g.id
        and nr.undone_reason = 'not_received'
        and nr.undone_at > now() - interval '30 days'
        and (nr.from_user = v_uid or nr.to_user = v_uid)), '[]'::jsonb)
  )
  into v_out
  from public.groups as g
  where g.id = p_group_id
    and v_uid is not null
    and exists (
      select 1 from public.group_members as me
      where me.group_id = g.id and me.user_id = v_uid);

  if v_out is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  return v_out;
end;
$$;

comment on function public.group_snapshot(uuid) is
  'Groups MVP (C-G11 + A1.7 + GR-M6) + group claim status (C4: me.not_part_bill_ids): one jsonb '
  'snapshot of a group for a member; 42501 otherwise.';

revoke execute on function public.group_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.group_snapshot(uuid) to authenticated;
