-- Groups MVP, Task T5: bills in groups (spec docs/specs/2026-11-26-groups-mvp.md T5 as amended by
-- Amendment A1 (A1.1-A1.4, A1.6, A1.7, A1.9, A1.11) and Amendment A2 (A2.3: marks become payments
-- with the mark's method); engineering review docs/specs/2026-11-26-groups-mvp-eng.md B1, B2(a)-(d),
-- B3, B4, S1, S3, S5, S8, S14, N3, N6, N7; criteria 25-34, 91-98, 117; decisions GR-T5-... in
-- docs/decisions-to-review.md). Earlier migrations are applied and are not edited.
--
--   bills.group_id                    null, -> groups ON DELETE RESTRICT (+ index)
--   bills_group_payer_member_fkey     (group_id, payer_id) -> group_members ON DELETE RESTRICT
--                                     (A1.9, S8; MATCH SIMPLE, so non-group bills are unaffected)
--   bill_events_kind_known            the list from 20261126080844_sent_via_venmo.sql (the latest
--                                     definition on disk) plus moved_to_group, removed_from_group
--   triggers on bill_participants     (GR-10) refuse, with 22023 in_group: a mark on a group bill;
--                                     inserting a non-member on a group bill; deleting a member's
--                                     row on a group bill
--   public.attach_bill_to_group(p_bill_id, p_group_id)   host + member; marks -> group payments
--   public.detach_bill_from_group(p_bill_id)             host; refused while bill_mark payments live
--   public.join_group(p_code)          re-created from 20261126082511_groups.sql: also adds the
--                                      joiner to every bill of the group; a repeat join repairs
--                                      missing participant rows (N6)
--   public.leave_group(p_group_id)     re-created from 20261126090704_group_payments.sql: bill
--                                      locks (B2d), bill history checks, participant row deletes
--   public.add_participant             re-created from 20261124091041_people.sql: 22023 in_group on
--                                      a group bill (its no-op path would never reach the trigger)
--   public.my_bills()                  re-created from 20261126080844_sent_via_venmo.sql (same
--                                      columns incl. seen_at, same order) plus `b.group_id is null`
--   private.my_links()                 co-members of any of the caller's groups are linked (U-G5)
--   public.people_i_split_with()       shared_bills = distinct shared bills (0 for a group-only
--                                      link); last_shared_at includes the later joined_at
--
-- Split-paying (several payers, who-paid / GR-M5): no bill_payers table exists when this migration
-- was written (checked 2026-11-26), so attach has no several-payers refusal; the who-paid session
-- adds it when it adds the table.
--
-- ===========================================================================================
-- LOCK ORDER (rule in 20261126082511_groups.sql; A1.2, criterion 34)
-- ===========================================================================================
-- Group row FOR NO KEY UPDATE first, then bills FOR UPDATE (or KEY SHARE in join_group) in
-- ascending id, then bill_participants, then claims; implicit FK locks listed.
--   attach_bill_to_group
--     0. checks without locks: signed out; the bill exists, the caller hosts it and is a member of
--        p_group_id -> else 42501 not_allowed (one answer).
--     1. SELECT groups FOR NO KEY UPDATE (a)/(b): before reading members.
--     2. SELECT bills FOR UPDATE (c): mark_paid / settle_difference / mark_not_received /
--        unmark_paid hold FOR SHARE on the bill, so no mark can land between reading and clearing
--        marks; join_bill / set_claim (KEY SHARE) and remove / leave_bill (FOR UPDATE) wait too.
--     3. re-checks under the locks; same group -> no-op; other group -> already_in_group;
--        participants_not_members; not_complete (marks on an incomplete or all-$0 bill).
--     4. UPDATE bills.group_id: FKs -> KEY SHARE on the group row (held, compatible) and on the
--        payer's group_members row (composite FK). bills_broadcast_update (statement).
--     5. INSERT bill_participants for members not on it: FKs -> KEY SHARE on the bill (held) and
--        each profile; BEFORE INSERT trigger reads group_members (the joiner is a member).
--     6. INSERT group_payments (one per mark): FKs -> KEY SHARE on group_members rows of from / to
--        / recorded_by, on the bill row (held).
--     7. UPDATE bill_participants (clear the six mark columns): FOR NO KEY UPDATE on those rows.
--     8. INSERT group_events (KEY SHARE group row, held) and bill_events (KEY SHARE bill, held).
--   detach_bill_from_group
--     0. checks without locks: signed out; the bill exists and the caller hosts it -> else 42501;
--        bills.group_id read unlocked (null -> no-op success).
--     1. SELECT groups FOR NO KEY UPDATE (c). 2. SELECT bills FOR UPDATE; re-check group_id (a
--        change while waiting -> start over, at most 3 times).
--     3. live bill_mark payments of this bill -> has_bill_payments.
--     4. UPDATE bills.group_id = null (no FK check for a null key). 5. both events.
--   join_group
--     0. signed out / code format (no lock). 1. SELECT groups ... FOR NO KEY UPDATE (a)/(b).
--     2. group_members reads under that lock (already a member; the 50 cap).
--     3. INSERT group_members (new joiner only) + group_events (as in T2).
--     4. SELECT the group's bills FOR KEY SHARE, ascending id (the lock the participant insert's
--        FK takes anyway, taken in one known order).
--     5. INSERT bill_participants for every group bill missing the caller (new joiner, or a
--        member's repair, N6): BEFORE INSERT trigger passes (member). No bill events.
--   leave_group (d)
--     0. checks without locks (as T2-T4). 1. SELECT groups FOR NO KEY UPDATE.
--     2. SELECT the group's bills FOR UPDATE OF b, ascending id: set_claim / assign_item (KEY
--        SHARE via lock_bill_key_share), mark_paid (FOR SHARE), set_payer and the payer-reset
--        trigger (FOR UPDATE) all wait, so no claim or payer role can appear behind the checks.
--        Taken before deleting anything (B2d: the reverse of bill_participants_reset_payer's
--        order would be the R9 shape).
--     3. history checks: last member; hosts or pays a group bill; a claim on a group bill;
--        expenses (T3); payments (T4).
--     4. DELETE the caller's 0-cent expense_shares (N3, T3).
--     5. DELETE group_members row (FOR UPDATE on it; 23503 -> cannot_leave).
--     6. DELETE the caller's bill_participants rows on the group's bills: BEFORE DELETE trigger
--        passes (no longer a member); AFTER DELETE reset-payer trigger does nothing (not the payer;
--        its bill lock is held). bill_participants_broadcast_delete (statement).
--     7. INSERT group_events.
--   add_participant: unchanged order (bills FOR SHARE first); the group check reads the locked row.
--   Triggers (row, BEFORE): read bills / group_members without locks; see S14 below.
--
-- S14: why the BEFORE INSERT trigger's unlocked read of group_members is safe. Every path that
-- inserts a participant row holds a lock on the bill row that conflicts with attach's FOR UPDATE
-- and with leave_group's FOR UPDATE on the group's bills: join_bill (FOR KEY SHARE), add_participant
-- (FOR SHARE), join_group and attach (group lock + bill lock). So the trigger runs either before
-- attach/leave take the bill (and attach then sees the new participant and refuses or includes
-- it) or after they commit; plpgsql runs each statement with a fresh snapshot taken after the lock
-- wait, so the trigger reads the committed group_id and membership.
-- The mark trigger relies on the same: every mark writer holds FOR SHARE on the bill, which waits
-- for attach's FOR UPDATE, then sees group_id set.
--
-- ===========================================================================================
-- Columns clients can't read
-- ===========================================================================================
-- None new. bills.group_id is readable through the existing table-level SELECT on bills (every
-- column; select('*') still works on bills). No client role writes bills, bill_participants or
-- group_payments; attach writes bill_mark payments as the function owner.
--
-- ===========================================================================================
-- Errors
-- ===========================================================================================
--   42501 not_allowed     signed out; not the bill's host; not a member of the group; no such
--                         bill or group (one answer)
--   22023 already_in_group     attach: the bill is in another group (same group = no-op success)
--   22023 participants_not_members  attach: someone on the bill isn't a member
--   22023 not_complete    attach: the bill has a mark and isn't complete or is all-$0 (S1b)
--   22023 has_bill_payments    detach: a live bill_mark payment from this bill remains (GR-9)
--   22023 in_group        a mark on a group bill (mark_paid on a complete bill); inserting a
--                         non-member (join_bill); deleting a member's row (remove_participant,
--                         leave_bill); add_participant on any group bill
--   22023 cannot_leave    leave_group: hosts or pays a group bill, or has a claim on one (new),
--                         plus T2-T4's reasons
--   22023 group_full / P0002 invalid_code   join_group, unchanged
--
-- Events:
--   group_events  bill_added   {bill_id, converted}      actor = host
--                 bill_removed {bill_id}                 actor = host
--   bill_events   moved_to_group     {group_id, converted}  actor = host (lib/activityText.ts)
--                 removed_from_group {group_id}             actor = host
--   No participant_added / joined bill events for members the group adds (GR-11).

-- ---------------------------------------------------------------------------
-- bills.group_id and the payer membership FK
-- ---------------------------------------------------------------------------
alter table public.bills
  add column group_id uuid null references public.groups (id) on delete restrict;

comment on column public.bills.group_id is
  'The group this bill belongs to (Groups MVP, ADR 0022), or null. Set only by '
  'attach_bill_to_group, cleared only by detach_bill_from_group. A group bill settles in the group '
  '(no per-bill marks) and every group member is a participant.';

-- Also serves the group_id FK lookups (leading column) and the restrict check below.
create index bills_group_id_payer_id_idx on public.bills (group_id, payer_id);

alter table public.bills
  add constraint bills_group_payer_member_fkey
    foreign key (group_id, payer_id)
    references public.group_members (group_id, user_id)
    on delete restrict;

-- ---------------------------------------------------------------------------
-- Activity kinds (B4): the latest list on disk plus the two this task writes
-- ---------------------------------------------------------------------------
alter table public.bill_events drop constraint bill_events_kind_known;
alter table public.bill_events
  add constraint bill_events_kind_known check (kind in (
    'bill_created', 'joined', 'claimed', 'unclaimed', 'split_changed', 'item_added',
    'item_removed', 'item_changed', 'amounts_changed', 'link_rotated', 'extras_split_changed',
    'payer_changed', 'marked_paid', 'unmarked_paid',
    'participant_added', 'participant_removed', 'left',
    'paid_difference', 'paid_back',
    'not_received',
    'moved_to_group', 'removed_from_group'
  ));

-- ---------------------------------------------------------------------------
-- Invariant triggers on bill_participants (GR-10)
-- ---------------------------------------------------------------------------
-- security definer (owner postgres): judged on the real tables, whoever's statement fires them.

-- No mark on a group bill: any row write that leaves a mark or a not-received flag on a group
-- bill. attach clears marks AFTER setting group_id, and its clearing UPDATE leaves all null, so
-- it passes. Covers mark_paid, settle_difference, mark_not_received, unmark_paid (whatever their
-- signatures) and any future writer.
create function private.bill_participants_no_group_marks()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.settled_at is not null or new.settled_cents is not null
      or new.not_received_cents is not null)
     and exists (
       select 1 from public.bills as b where b.id = new.bill_id and b.group_id is not null
     ) then
    raise exception using errcode = '22023', message = 'in_group';
  end if;
  return new;
end;
$$;

-- Only members on a group bill (covers join_bill by a non-member, and add_participant).
create function private.bill_participants_members_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.bills as b
    where b.id = new.bill_id
      and b.group_id is not null
      and not exists (
        select 1 from public.group_members as gm
        where gm.group_id = b.group_id and gm.user_id = new.user_id
      )
  ) then
    raise exception using errcode = '22023', message = 'in_group';
  end if;
  return new;
end;
$$;

-- A member stays on every group bill while they are a member (covers remove_participant and
-- leave_bill). Passes when: the bill is gone or not in a group (cascades from a bill delete); the
-- person is no longer a member (leave_group deletes membership first); the profile is gone
-- (account deletion; membership's restrict FK blocks that today, so this is a backstop).
create function private.bill_participants_keep_members()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.bills as b
    join public.group_members as gm on gm.group_id = b.group_id and gm.user_id = old.user_id
    where b.id = old.bill_id
  ) and exists (select 1 from public.profiles as p where p.id = old.user_id) then
    raise exception using errcode = '22023', message = 'in_group';
  end if;
  return old;
end;
$$;

alter function private.bill_participants_no_group_marks() owner to postgres;
alter function private.bill_participants_members_only() owner to postgres;
alter function private.bill_participants_keep_members() owner to postgres;
revoke execute on function private.bill_participants_no_group_marks() from public, anon, authenticated;
revoke execute on function private.bill_participants_members_only() from public, anon, authenticated;
revoke execute on function private.bill_participants_keep_members() from public, anon, authenticated;

create trigger bill_participants_no_group_marks
  before update on public.bill_participants
  for each row
  execute function private.bill_participants_no_group_marks();

create trigger bill_participants_members_only
  before insert on public.bill_participants
  for each row
  execute function private.bill_participants_members_only();

create trigger bill_participants_keep_members
  before delete on public.bill_participants
  for each row
  execute function private.bill_participants_keep_members();

-- ---------------------------------------------------------------------------
-- public.attach_bill_to_group(p_bill_id, p_group_id)
-- ---------------------------------------------------------------------------
-- Check order: signed out / no such bill / not its host / not a member of the group -> 42501
-- not_allowed; (under the locks) already in p_group_id -> no-op success (A1.6); in another group
-- -> already_in_group; a participant isn't a member -> participants_not_members; a mark on an
-- incomplete or all-$0 bill -> not_complete (S1b). Then, in this order: group_id; every missing
-- member as a participant (added = false); one bill_mark payment per mark (participant -> payer,
-- settled_cents, the mark's settled_method or 'other', recorded_by = the participant); every mark
-- column cleared on every row (settled_at, settled_cents, settled_method, not_received_cents,
-- not_received_method, not_received_by; B1); bill_added and moved_to_group, each once.
create function public.attach_bill_to_group(p_bill_id uuid, p_group_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_bill public.bills%rowtype;
  v_converted integer;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  -- Who may act, before any lock (lessons 2026-11-24, R4).
  if not exists (
    select 1 from public.bills as b where b.id = p_bill_id and b.host_id = v_uid
  ) or not exists (
    select 1 from public.group_members as gm
    where gm.group_id = p_group_id and gm.user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  -- (a)/(b)/(c): the group, then the bill.
  perform 1 from public.groups as g where g.id = p_group_id for no key update;
  select b.* into v_bill from public.bills as b where b.id = p_bill_id for update of b;

  if v_bill.id is null or v_bill.host_id <> v_uid or not exists (
    select 1 from public.group_members as gm
    where gm.group_id = p_group_id and gm.user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if v_bill.group_id = p_group_id then
    return; -- a retry (A1.6, S3): nothing changes, no event, no payment
  end if;
  if v_bill.group_id is not null then
    raise exception using errcode = '22023', message = 'already_in_group';
  end if;

  if exists (
    select 1 from public.bill_participants as bp
    where bp.bill_id = p_bill_id
      and not exists (
        select 1 from public.group_members as gm
        where gm.group_id = p_group_id and gm.user_id = bp.user_id
      )
  ) then
    raise exception using errcode = '22023', message = 'participants_not_members';
  end if;

  -- S1b: marks never become payments for a bill that wouldn't count in the group. A deliberate
  -- DB check about moving bills, not a copy of C-G1 (which is lib only).
  if exists (
    select 1 from public.bill_participants as bp
    where bp.bill_id = p_bill_id and bp.settled_at is not null
  ) and (not private.bill_is_complete(p_bill_id) or private.bill_all_zero(p_bill_id)) then
    raise exception using errcode = '22023', message = 'not_complete';
  end if;

  update public.bills as b set group_id = p_group_id where b.id = p_bill_id;

  -- Every member is a participant (GR-11: added = false, no per-bill events).
  insert into public.bill_participants (bill_id, user_id, added)
  select p_bill_id, gm.user_id, false
  from public.group_members as gm
  where gm.group_id = p_group_id
  order by gm.user_id
  on conflict (bill_id, user_id) do nothing;

  -- U-G1 / A2.3: each mark becomes a group payment to the bill's payer. (A mark on the payer's own
  -- row can't exist: mark_paid refuses is_payer and set_payer clears marks; the filter keeps the
  -- parties_differ check from failing if one ever did. It is still cleared below.)
  insert into public.group_payments
    (id, group_id, from_user, to_user, cents, method, source, recorded_by, bill_id)
  select gen_random_uuid(), p_group_id, bp.user_id, v_bill.payer_id, bp.settled_cents,
         coalesce(bp.settled_method, 'other'), 'bill_mark', bp.user_id, p_bill_id
  from public.bill_participants as bp
  where bp.bill_id = p_bill_id
    and bp.settled_at is not null
    and bp.user_id <> v_bill.payer_id
  order by bp.user_id;
  get diagnostics v_converted = row_count;

  -- B1: every mark column on the latest schema.
  update public.bill_participants as bp
  set settled_at = null, settled_cents = null, settled_method = null,
      not_received_cents = null, not_received_method = null, not_received_by = null
  where bp.bill_id = p_bill_id
    and (bp.settled_at is not null or bp.settled_cents is not null
         or bp.settled_method is not null or bp.not_received_cents is not null
         or bp.not_received_method is not null or bp.not_received_by is not null);

  perform private.log_group_event(p_group_id, v_uid, 'bill_added',
    jsonb_build_object('bill_id', p_bill_id, 'converted', v_converted));
  perform private.log_event(p_bill_id, v_uid, 'moved_to_group', null,
    jsonb_build_object('group_id', p_group_id, 'converted', v_converted));
end;
$$;

-- ---------------------------------------------------------------------------
-- public.detach_bill_from_group(p_bill_id)
-- ---------------------------------------------------------------------------
-- Host only. Not in a group -> no-op success (a retry after a lost response). Live bill_mark
-- payments from this bill (bill_id = X, source 'bill_mark', undone_at is null) -> has_bill_payments
-- (GR-9). Otherwise group_id = null; participants stay (N7); bill_removed and removed_from_group.
create function public.detach_bill_from_group(p_bill_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_group uuid;
  v_locked uuid;
  v_attempt integer := 0;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  loop
    v_attempt := v_attempt + 1;
    -- (c): read group_id without a lock, then the group, then the bill, then re-check.
    select b.group_id into v_group
    from public.bills as b
    where b.id = p_bill_id and b.host_id = v_uid;
    if not found then
      raise exception using errcode = '42501', message = 'not_allowed';
    end if;
    if v_group is null then
      return;
    end if;

    perform 1 from public.groups as g where g.id = v_group for no key update;
    select b.group_id into v_locked from public.bills as b where b.id = p_bill_id for update of b;

    exit when v_locked is not distinct from v_group;
    if v_locked is null then
      return; -- detached by a concurrent call
    end if;
    if v_attempt >= 3 then
      raise exception using errcode = '40001', message = 'bill_changed';
    end if;
  end loop;

  if exists (
    select 1 from public.group_payments as gp
    where gp.bill_id = p_bill_id and gp.source = 'bill_mark' and gp.undone_at is null
  ) then
    raise exception using errcode = '22023', message = 'has_bill_payments';
  end if;

  update public.bills as b set group_id = null where b.id = p_bill_id;

  perform private.log_group_event(v_group, v_uid, 'bill_removed',
    jsonb_build_object('bill_id', p_bill_id));
  perform private.log_event(p_bill_id, v_uid, 'removed_from_group', null,
    jsonb_build_object('group_id', v_group));
end;
$$;

-- ---------------------------------------------------------------------------
-- public.join_group(p_code) -> uuid  (re-created from 20261126082511_groups.sql)
-- ---------------------------------------------------------------------------
-- T2's check order is kept: signed out -> format -> group lock by code -> already a member (no
-- cap) -> 50 cap -> insert + member_joined. New: the caller is then put on every bill of the group
-- that lacks them (added = false, no bill events). A current member's repeat call does the same
-- repair (N6) and still logs nothing.
create or replace function public.join_group(p_code text)
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

  -- (a)/(b): the group lock before reading members or bills. Holding the code is the permission.
  select g.id into v_group_id
  from public.groups as g
  where g.join_code = p_code
  for no key update;

  if v_group_id is null then
    raise exception using errcode = 'P0002', message = 'invalid_code';
  end if;

  if not exists (
    select 1 from public.group_members as gm
    where gm.group_id = v_group_id and gm.user_id = v_uid
  ) then
    if (select count(*) from public.group_members as gm where gm.group_id = v_group_id) >= 50 then
      raise exception using errcode = '22023', message = 'group_full';
    end if;

    begin
      insert into public.group_members (group_id, user_id) values (v_group_id, v_uid);
    exception when foreign_key_violation then
      raise exception using errcode = '42501', message = 'not_allowed';
    end;
    perform private.log_group_event(v_group_id, v_uid, 'member_joined', '{}'::jsonb);
  end if;

  -- Bills of the group, ascending id, then the missing participant rows in one statement.
  perform 1
  from public.bills as b
  where b.group_id = v_group_id
  order by b.id
  for key share of b;

  insert into public.bill_participants (bill_id, user_id, added)
  select b.id, v_uid, false
  from public.bills as b
  where b.group_id = v_group_id
  order by b.id
  on conflict (bill_id, user_id) do nothing;

  return v_group_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- public.leave_group(p_group_id)  (re-created from 20261126090704_group_payments.sql)
-- ---------------------------------------------------------------------------
-- T4's version plus (B2d): every bill of the group FOR UPDATE in ascending id right after the
-- group lock and before any check or delete; refused (cannot_leave) when the caller hosts or pays
-- a group bill or has a claim on one; after the membership delete, the caller's participant rows
-- on the group's bills are deleted. The expense and payment checks and their order are unchanged.
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
  -- (d) step 2: the group's bills, ascending id, before any check or delete.
  perform 1
  from public.bills as b
  where b.group_id = p_group_id
  order by b.id
  for update of b;

  -- (d) step 3: re-check and history checks under the locks.
  if not exists (
    select 1 from public.group_members as gm
    where gm.group_id = p_group_id and gm.user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  if (select count(*) from public.group_members as gm where gm.group_id = p_group_id) <= 1 then
    raise exception using errcode = '22023', message = 'cannot_leave';
  end if;
  -- T5: group bills hosted or paid by the caller, or claimed on.
  if exists (
    select 1 from public.bills as b
    where b.group_id = p_group_id and (b.host_id = v_uid or b.payer_id = v_uid)
  ) or exists (
    select 1 from public.claims as c
    join public.bills as b on b.id = c.bill_id
    where b.group_id = p_group_id and c.user_id = v_uid
  ) then
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
  -- T4: payment history (undone included).
  if exists (
    select 1 from public.group_payments as gp
    where gp.group_id = p_group_id
      and (gp.from_user = v_uid or gp.to_user = v_uid or gp.recorded_by = v_uid)
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
  -- (d) step 5: the caller's participant rows on the group's bills (bills already locked; the
  -- keep-members trigger passes because the membership is gone). No bill events (GR-11).
  delete from public.bill_participants as bp
  using public.bills as b
  where b.id = bp.bill_id and b.group_id = p_group_id and bp.user_id = v_uid;

  perform private.log_group_event(p_group_id, v_uid, 'member_left', '{}'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- public.add_participant (re-created from 20261124091041_people.sql)
-- ---------------------------------------------------------------------------
-- Unchanged except: on a group bill -> 22023 in_group, right after the host check, for any target
-- (the host invites people to the group instead; A1.8). Without this, adding a member who is
-- already on the bill would be a silent no-op that never reaches the members-only trigger.
create or replace function public.add_participant(p_bill_id uuid, p_user_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_group uuid;
  v_inserted integer;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  select b.group_id into v_group
  from public.bills as b
  where b.id = p_bill_id and b.host_id = v_uid
  for share;
  if not found then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if v_group is not null then
    raise exception using errcode = '22023', message = 'in_group';
  end if;

  if exists (
    select 1 from public.bill_participants as bp
    where bp.bill_id = p_bill_id and bp.user_id = p_user_id
  ) then
    return;
  end if;

  if not exists (select 1 from private.my_links() as l where l.user_id = p_user_id) then
    raise exception using errcode = '22023', message = 'not_linked';
  end if;

  insert into public.bill_participants (bill_id, user_id, added)
  values (p_bill_id, p_user_id, true)
  on conflict (bill_id, user_id) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted > 0 then
    perform private.log_event(
      p_bill_id, v_uid, 'participant_added', null,
      jsonb_build_object('user_id', p_user_id)
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- public.my_bills()  (re-created from 20261126080844_sent_via_venmo.sql)
-- ---------------------------------------------------------------------------
-- Same columns (seen_at included), same order and limit; only `b.group_id is null` is added
-- (GR-19, A1 S12): group bills live on the group screen and don't use up Home's 20.
create or replace function public.my_bills()
returns table (
  bill_id uuid,
  host_id uuid,
  host_name text,
  payer_id uuid,
  total_cents integer,
  created_at timestamptz,
  joined_at timestamptz,
  added boolean,
  seen boolean,
  claimed_any boolean,
  complete boolean,
  seen_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  return query
  select
    b.id,
    b.host_id,
    p.display_name,
    b.payer_id,
    b.total_cents,
    b.created_at,
    bp.joined_at,
    bp.added,
    s.seen_at is not null,
    exists (
      select 1 from public.claims as c
      where c.bill_id = b.id and c.user_id = v_uid
    ),
    private.bill_is_complete(b.id),
    s.seen_at
  from public.bill_participants as bp
  join public.bills as b on b.id = bp.bill_id
  left join public.profiles as p on p.id = b.host_id
  left join public.bill_seen as s on s.bill_id = b.id and s.user_id = v_uid
  where bp.user_id = v_uid
    and b.group_id is null
  order by bp.joined_at desc, b.created_at desc, b.id asc
  limit 20;
end;
$$;

-- ---------------------------------------------------------------------------
-- private.my_links()  (rule L1, plus co-members; U-G5)
-- ---------------------------------------------------------------------------
-- Same columns. Bill links are unchanged. New: one row per (co-member, shared group) with
-- bill_id null and bill_created_at = the later of the two joined_at values (when the link began).
-- Callers count distinct non-null bill_id for "shared bills".
create or replace function private.my_links()
returns table (user_id uuid, bill_id uuid, bill_created_at timestamptz)
language sql
stable
set search_path = ''
as $$
  with my_bills as (
    select bp.bill_id
    from public.bill_participants as bp
    where bp.user_id = (select auth.uid())
  ),
  -- The L1 "active" predicate, once.
  active as (
    select bp.bill_id, bp.user_id
    from public.bill_participants as bp
    where bp.bill_id in (select mb.bill_id from my_bills as mb)
      and (
        not bp.added
        or exists (
          select 1 from public.claims as c
          where c.bill_id = bp.bill_id and c.user_id = bp.user_id
        )
      )
  )
  select theirs.user_id, b.id, b.created_at
  from active as mine
  join active as theirs
    on theirs.bill_id = mine.bill_id and theirs.user_id <> mine.user_id
  join public.bills as b on b.id = mine.bill_id
  where mine.user_id = (select auth.uid())
  union all
  select theirs.user_id, null::uuid, greatest(mine.joined_at, theirs.joined_at)
  from public.group_members as mine
  join public.group_members as theirs
    on theirs.group_id = mine.group_id and theirs.user_id <> mine.user_id
  where mine.user_id = (select auth.uid());
$$;

revoke execute on function private.my_links() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- public.people_i_split_with()  (shared_bills = distinct bills; may be 0 for a group-only link)
-- ---------------------------------------------------------------------------
-- Ranking keys unchanged (shared_bills desc, last_shared_at desc, name, id), computed from the
-- widened my_links().
create or replace function public.people_i_split_with()
returns table (
  user_id uuid,
  display_name text,
  venmo_username text,
  shared_bills integer,
  last_shared_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  return query
  select l.user_id, p.display_name, p.venmo_username,
         count(distinct l.bill_id)::integer as shared_bills,
         max(l.bill_created_at) as last_shared_at
  from private.my_links() as l
  join public.profiles as p on p.id = l.user_id
  group by l.user_id, p.display_name, p.venmo_username
  -- Spelled as expressions, not output names: inside plpgsql, the RETURNS TABLE column names are
  -- variables and would shadow the aliases.
  order by count(distinct l.bill_id) desc, max(l.bill_created_at) desc,
           lower(p.display_name) asc nulls last, l.user_id asc
  limit 200;
end;
$$;

-- ---------------------------------------------------------------------------
-- Owners and execute grants (restated: authenticated only)
-- ---------------------------------------------------------------------------
alter function public.attach_bill_to_group(uuid, uuid) owner to postgres;
alter function public.detach_bill_from_group(uuid) owner to postgres;

revoke execute on function public.attach_bill_to_group(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.detach_bill_from_group(uuid) from public, anon, authenticated;
revoke execute on function public.join_group(text) from public, anon, authenticated;
revoke execute on function public.leave_group(uuid) from public, anon, authenticated;
revoke execute on function public.add_participant(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.my_bills() from public, anon, authenticated;
revoke execute on function public.people_i_split_with() from public, anon, authenticated;

grant execute on function public.attach_bill_to_group(uuid, uuid) to authenticated;
grant execute on function public.detach_bill_from_group(uuid) to authenticated;
grant execute on function public.join_group(text) to authenticated;
grant execute on function public.leave_group(uuid) to authenticated;
grant execute on function public.add_participant(uuid, uuid) to authenticated;
grant execute on function public.my_bills() to authenticated;
grant execute on function public.people_i_split_with() to authenticated;

notify pgrst, 'reload schema';
