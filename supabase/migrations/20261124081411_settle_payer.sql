-- M3 Task 1: who gets paid (bills.payer_id), the "I paid" mark columns, invariant P, set_payer,
-- a broadcast on bill_participants updates, and three new Activity kinds.
-- Spec: docs/specs/2026-11-24-m3-settle-venmo.md (D1, C2, C3, C4; criteria 1-13).
-- Earlier migrations are applied and are not edited.
--
-- Invariant P ("the payer is always a current participant") mechanism:
--   * a composite foreign key bills (id, payer_id) -> bill_participants (bill_id, user_id),
--     DEFERRABLE INITIALLY DEFERRED, because create_bill inserts the bill before the host's
--     participant row. A payer that isn't a participant fails with 23503
--     (foreign_key_violation) at commit, or at `set constraints bills_payer_participant_fkey
--     immediate`.
--   * an AFTER DELETE row trigger on bill_participants (bill_participants_reset_payer). When the
--     deleted row is the payer's and the payer isn't the host (account deletion cascades from
--     profiles), it hands the bill back to the host, clears every mark on the bill and logs one
--     payer_changed with actor_id null, all before the deferred check runs, so the deletion
--     succeeds. If the host is the one deleted, the whole bill cascades as before and the
--     trigger does nothing.
--   * a BEFORE INSERT trigger on bills sets payer_id = host_id, so create_bill is not re-created.
--
-- Client access (unchanged; restated below): authenticated has table-level SELECT on bills and
-- bill_participants, so payer_id, settled_at and settled_cents are readable by every participant
-- (Q5 A: everyone on the bill sees who has paid). No client UPDATE on either table: payer_id
-- changes only through set_payer, marks only through mark_paid / unmark_paid (next migration).
-- No column on either table is hidden from authenticated, so `select *` still works on them.
--
-- Event details written here (lib/activityText.ts parses them):
--   payer_changed { before: uid, after: uid, cleared: int >= 0 }   actor = host, or null when an
--                 account deletion caused it. `cleared` counts every mark the bill lost,
--                 including one on the deleted payer's own row.
-- marked_paid { payer_id: uid, cents: int } and unmarked_paid { user_id: uid, cents: int } are
-- allowed by the constraint here and written by 20261124081412_settle_marks.sql.

-- ---------------------------------------------------------------------------
-- Columns and constraints (D1, C2)
-- ---------------------------------------------------------------------------
alter table public.bills add column payer_id uuid;

update public.bills set payer_id = host_id where payer_id is null;

alter table public.bills alter column payer_id set not null;

comment on column public.bills.payer_id is
  'Who paid the restaurant and collects from everyone else. Always a participant (invariant P). '
  'Defaults to host_id; changes only through set_payer.';

-- Validates existing rows (every local bill has its host's participant row).
alter table public.bills
  add constraint bills_payer_participant_fkey
    foreign key (id, payer_id)
    references public.bill_participants (bill_id, user_id)
    deferrable initially deferred;

alter table public.bill_participants
  add column settled_at timestamptz null,
  add column settled_cents integer null
    constraint bill_participants_settled_cents_range
      check (settled_cents between 1 and 99999999),
  add constraint bill_participants_mark_complete
    check ((settled_at is null) = (settled_cents is null));

comment on column public.bill_participants.settled_at is
  'When this person tapped "I paid" (self-reported). Null = not marked.';
comment on column public.bill_participants.settled_cents is
  'The amount the Settle screen showed when they tapped "I paid" (1..99999999 cents).';

-- ---------------------------------------------------------------------------
-- New bills: the host is the payer
-- ---------------------------------------------------------------------------
-- Always overrides: no client role can insert into bills, and create_bill passes no payer.
create function private.bills_default_payer()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.payer_id := new.host_id;
  return new;
end;
$$;

revoke execute on function private.bills_default_payer() from public, anon, authenticated;

create trigger bills_default_payer
  before insert on public.bills
  for each row
  execute function private.bills_default_payer();

-- ---------------------------------------------------------------------------
-- The payer's participant row is deleted (account deletion): hand back to the host
-- ---------------------------------------------------------------------------
-- security definer (owner postgres): it updates bills / bill_participants and calls
-- private.log_event, whatever role the delete ran as. It only acts when the deleted row is the
-- current payer's and the bill still exists with a different host.
create function private.bill_participants_reset_payer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_host uuid;
  v_payer uuid;
  v_cleared integer;
begin
  select b.host_id, b.payer_id into v_host, v_payer
  from public.bills as b
  where b.id = old.bill_id
  for update;
  -- Bill gone (it is being deleted: host account deletion) or not the payer's row.
  if not found or v_payer is distinct from old.user_id or old.user_id = v_host then
    return null;
  end if;

  with cleared as (
    update public.bill_participants as bp
    set settled_at = null, settled_cents = null
    where bp.bill_id = old.bill_id and bp.settled_at is not null
    returning 1
  )
  select count(*)::integer into v_cleared from cleared;

  if old.settled_at is not null then
    v_cleared := v_cleared + 1;
  end if;

  update public.bills as b set payer_id = v_host where b.id = old.bill_id;

  perform private.log_event(
    old.bill_id, null, 'payer_changed', null,
    jsonb_build_object('before', old.user_id, 'after', v_host, 'cleared', v_cleared)
  );
  return null;
end;
$$;

alter function private.bill_participants_reset_payer() owner to postgres;
revoke execute on function private.bill_participants_reset_payer() from public, anon, authenticated;

create trigger bill_participants_reset_payer
  after delete on public.bill_participants
  for each row
  execute function private.bill_participants_reset_payer();

-- ---------------------------------------------------------------------------
-- Activity kinds (C4)
-- ---------------------------------------------------------------------------
alter table public.bill_events drop constraint bill_events_kind_known;
alter table public.bill_events
  add constraint bill_events_kind_known check (kind in (
    'bill_created', 'joined', 'claimed', 'unclaimed', 'split_changed', 'item_added',
    'item_removed', 'item_changed', 'amounts_changed', 'link_rotated', 'extras_split_changed',
    'payer_changed', 'marked_paid', 'unmarked_paid'
  ));

-- ---------------------------------------------------------------------------
-- Realtime: one hint per statement when bill_participants rows are updated (marks)
-- ---------------------------------------------------------------------------
-- broadcast_bill_change already handles any table with a bill_id column
-- (20261121075448_bill_edit_realtime.sql).
create trigger bill_participants_broadcast_update
  after update on public.bill_participants
  referencing new table as new_rows
  for each statement
  execute function private.broadcast_bill_change();

-- ---------------------------------------------------------------------------
-- Grants, restated: no new client privileges
-- ---------------------------------------------------------------------------
revoke all on public.bills from anon, authenticated, public;
revoke all on public.bill_participants from anon, authenticated, public;
grant select on public.bills to authenticated;
grant select on public.bill_participants to authenticated;

-- ---------------------------------------------------------------------------
-- public.set_payer (C3)
-- ---------------------------------------------------------------------------
-- security definer: clients have no UPDATE on bills or bill_participants, and log_event isn't
-- client-executable.
-- Errors: signed out, not the host, or no such bill: 42501 not_allowed (one error, so a
-- non-host can't probe bill ids). Payer null or not a participant: 22023 not_participant.
-- Current payer again: no-op (no update, no event, marks kept), checked before
-- p_expected_cleared. Mark count differs from p_expected_cleared (or it is null):
-- 22023 marks_changed, nothing changes.
-- The bill row lock (for update) serializes this with mark_paid / unmark_paid (for share), so
-- the count it checks is the count it clears.
create function public.set_payer(p_bill_id uuid, p_payer_id uuid, p_expected_cleared integer)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_current uuid;
  v_marks integer;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  select b.payer_id into v_current
  from public.bills as b
  where b.id = p_bill_id and b.host_id = v_uid
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if p_payer_id is null or not exists (
    select 1 from public.bill_participants as bp
    where bp.bill_id = p_bill_id and bp.user_id = p_payer_id
  ) then
    raise exception using errcode = '22023', message = 'not_participant';
  end if;

  if p_payer_id = v_current then
    return;
  end if;

  select count(*)::integer into v_marks
  from public.bill_participants as bp
  where bp.bill_id = p_bill_id and bp.settled_at is not null;

  if p_expected_cleared is null or p_expected_cleared <> v_marks then
    raise exception using errcode = '22023', message = 'marks_changed';
  end if;

  if v_marks > 0 then
    update public.bill_participants as bp
    set settled_at = null, settled_cents = null
    where bp.bill_id = p_bill_id and bp.settled_at is not null;
  end if;

  update public.bills as b set payer_id = p_payer_id where b.id = p_bill_id;

  perform private.log_event(
    p_bill_id, v_uid, 'payer_changed', null,
    jsonb_build_object('before', v_current, 'after', p_payer_id, 'cleared', v_marks)
  );
end;
$$;

revoke execute on function public.set_payer(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.set_payer(uuid, uuid, integer) to authenticated;
