-- Who paid, Task 4a-2: every mark function on the payments ledger, the Groups ports, and the drop of
-- the old mark columns (spec docs/specs/2026-11-26-who-paid.md, Amendment A1.2 contract P and A1.3
-- "Functions (4a-2)" and "Groups ports"; engineering review B1, B3, B5(a)-(d), S12, S16, S17,
-- N6, N7). Builds on 20261127140000_bill_payments.sql (apply both in one `supabase migration up`).
-- Earlier migrations are applied and are not edited.
--
-- Re-created from the latest body on disk (grep of supabase/migrations for
-- settled_at|settled_cents|settled_method|not_received_ on 2026-11-27), keeping every check and
-- error and changing only where the data lives, except where A1.3 says otherwise (marked "A1"):
--   public.mark_paid          from 20261126080844_sent_via_venmo.sql lines 389-480 (4 args);
--                             dropped, re-created with p_plan_key (5 args, default null) and the
--                             invalid_plan_key / payers_stale checks.
--   public.settle_difference  from 20261126080844_sent_via_venmo.sql lines 495-630 (6 args);
--                             dropped, re-created with p_plan_key (7 args, default null) and the
--                             payers_stale check. A1: "back" is the pair's recipient, who need not
--                             be a current payer (WP-35); only "more" checks payer_changed.
--   public.mark_not_received  from 20261126080844_sent_via_venmo.sql lines 655-756 (same
--                             signature). A1: the caller is the pair's recipient (p_payer_id), who
--                             need not be a current payer, so step 3b (payer_changed) is gone.
--   public.unmark_paid        from 20261126080844_sent_via_venmo.sql lines 317-367 (2 args);
--                             dropped, re-created with p_payer_id (3 args, S16).
--   public.set_payer          from 20261126080844_sent_via_venmo.sql lines 253-312 (same 3 args;
--                             same behaviour: clears every payment and flag of the bill; replaced
--                             by the 2-arg ledger version in 20261127140002_who_paid.sql).
--   private.bill_participants_reset_payer
--                             from 20261126080844_sent_via_venmo.sql lines 201-246; now a BEFORE
--                             DELETE row trigger returning old (B3), because the cascade from
--                             bill_participants to bill_payments runs before any AFTER trigger and
--                             would delete the payments to the payer before they could be counted.
--   private.is_removable      from 20261124091042_membership.sql lines 46-66 (rule L3 on pairs).
--   public.attach_bill_to_group  from 20261127060131_group_bills.sql lines 271-372 (B5c).
--   private.bill_participants_no_group_marks  (20261127060131_group_bills.sql lines 173-189):
--                             trigger and function dropped (B5a); replaced by
--                             private.bill_payments_no_group, BEFORE INSERT on bill_payments and
--                             bill_payment_flags (B5b).
-- Not touched: public.my_bills() (reads no mark column; S15), private.log_claim_event,
-- public.add_participant, private.settle_state (re-created in 4b), detach_bill_from_group (reads
-- group_payments only), the members-only / keep-members triggers (they stay on
-- bill_participants).
--
-- New:
--   private.pair_state(bill, u, v)   contract P, one SQL statement with a window sum.
--   private.bill_payer_ids(bill)     the current payer set. Here: { bills.payer_id }.
--                                    20261127140002_who_paid.sql widens it to bill_payers.
--   private.payers_valid(bill)       true here (one-person bills can't be stale); 4b redefines it.
--   The two helpers are why mark_paid / settle_difference / is_removable need no re-create in 4b:
--   their checks call the helpers, and 4b redefines the helpers.
--
-- ===========================================================================================
-- Contract P (private.pair_state)
-- ===========================================================================================
-- For the ordered pair (u, v): the entries between u and v ordered by (recorded_at, id); running
-- net r, u->v positive, v->u negative; net = r after the last entry. If net > 0: mark_at = the
-- recorded_at of the entry k that started the latest positive run (the last k with r(k-1) <= 0
-- and r(k) > 0), mark_id = that entry's id, method = the one method shared by the u->v entries
-- from k on, or 'other' if they differ. If net <= 0: mark_at, mark_id and method are null (u->v
-- has no mark; v->u may). A pair's 92-style mark = { cents: net, at: mark_at, method }: what the
-- tokens of settle_difference and mark_not_received carry. uuid order is byte order, which equals
-- lib's JS string order on lowercase ids.
-- "The run" of a mark = the pair's entries (both directions) with (recorded_at, id) >=
-- (mark_at, mark_id). unmark_paid and mark_not_received delete exactly those.
--
-- ===========================================================================================
-- Error check orders (the app's error mapping relies on them)
-- ===========================================================================================
-- mark_paid(p_bill_id, p_payer_id, p_cents, p_method, p_plan_key):
--   0 signed out                                                   42501 not_allowed
--   1 caller not a participant (plain read, no lock)               42501 not_allowed
--   2 bills FOR SHARE, participation re-checked                    42501 not_allowed
--   3 p_cents null or outside 1..99,999,999                        22023 invalid_amount
--   4 p_method not a payment method                                22023 invalid_method
--   5 p_plan_key not null and not 16 lowercase hex                 22023 invalid_plan_key
--   6 p_payer_id null or not in the current payer set              22023 payer_changed
--   7 caller = p_payer_id                                          22023 is_payer
--   8 not private.payers_valid (4b: split amounts don't add up)    22023 payers_stale
--   9 settle_state = 'all_zero'                                    22023 all_zero
--  10 settle_state not 'final' / 'early'                           22023 not_complete
--  11 caller's participant row FOR NO KEY UPDATE; pair (caller -> payer) already marked (P net > 0):
--     no-op, returns (mark_at, false); no write, no event, no broadcast
--  12 one entry (clock_timestamp(), p_plan_key, recorded_by = caller); the pair's flag deleted; one
--     marked_paid { payer_id, cents, method }; returns (recorded_at, true)
-- settle_difference(p_bill_id, p_user_id, p_payer_id, p_expected_cents, p_new_cents, p_method,
--                   p_plan_key), pair (p_user_id -> p_payer_id):
--   0-2 as mark_paid
--   3 expected outside 1..99,999,999, new outside 0..99,999,999, or new = expected
--                                                                  22023 invalid_amount
--   4 p_method not a payment method (validated both ways)          22023 invalid_method
--   5 p_plan_key bad format                                        22023 invalid_plan_key
--   6 more (new > expected) and p_payer_id not in the payer set    22023 payer_changed
--   7 p_user_id or p_payer_id null, p_user_id = p_payer_id, more by anyone but p_user_id, back by
--     anyone but p_payer_id                                        42501 not_allowed
--   8 not payers_valid                                             22023 payers_stale
--   9 settle_state(p_user_id) = 'all_zero'                         22023 all_zero
--  10 settle_state not 'final'                                     22023 not_complete
--  11 p_user_id's participant row FOR NO KEY UPDATE; none          22023 mark_changed
--  12 idempotent retry: (new >= 1 and net = new) or (new = 0 and net <= 0): no write, no event
--  13 no mark (net <= 0) or net <> expected                        22023 mark_changed
--  14 more: entry u->v (new - expected, p_method); back: entry v->u (expected - new, the mark's
--     method); one paid_difference / paid_back (92's details). Back to 0 leaves net 0: no mark,
--     the entries stay (they are real movements).
-- unmark_paid(p_bill_id, p_user_id, p_payer_id):
--   0 signed out; bills FOR SHARE; no bill, caller not a participant, or caller not the host,
--     p_user_id or p_payer_id                                      42501 not_allowed
--   1 p_user_id's participant row FOR NO KEY UPDATE; none, or no mark on the pair: no-op, no event
--   2 delete the mark's run; one unmarked_paid { user_id, cents } (92's details)
-- mark_not_received(p_bill_id, p_user_id, p_payer_id, p_expected_cents, p_expected_at):
--   0-2 as mark_paid
--   3 caller <> p_payer_id                                         42501 not_allowed
--   4 p_user_id null or = p_payer_id                               42501 not_allowed
--   5 expected cents outside 1..99,999,999 or p_expected_at null   22023 invalid_amount
--   6 p_user_id's participant row FOR NO KEY UPDATE; none          22023 mark_changed
--   7 idempotent retry: no mark and the pair's flag has cents = p_expected_cents: no-op
--   8 no mark, net <> p_expected_cents, or mark_at <> p_expected_at  22023 mark_changed
--   9 delete the run; upsert the flag (cents = net, method = the mark's); one not_received
--     { user_id, payer_id, cents, method }
--
-- ===========================================================================================
-- Lock order (bills row first; implicit locks listed; lessons 2026-11-24)
-- ===========================================================================================
-- mark_paid, settle_difference, unmark_paid, mark_not_received:
--   0 none               participation read (no lock)
--   1 FOR SHARE          bills row (serializes with set_payer(s), update_bill, attach,
--                        remove_participant, leave_bill, which take FOR UPDATE)
--   2 none               line_items, claims, bill_payers (settle_state / payers_valid)
--   3 FOR NO KEY UPDATE  the pair's p_user_id participant row (explicit), before reading contract
--                        P, so two writes on one pair serialize (A1.3)
--   4 FOR KEY SHARE      (implicit) the from / to participant rows via the bill_payments /
--                        bill_payment_flags FKs (row 3 already held by us; the other is the
--                        payer's row: KEY SHARE conflicts only with FOR UPDATE / delete, i.e.
--                        remove/leave, which hold the bill FOR UPDATE first and so can't be
--                        running while we hold FOR SHARE on the bill); bills row via the
--                        bill_id FKs (held)
--   5 FOR KEY SHARE      (implicit) bills row and the caller's profiles row (log_event)
--   6 none               statement broadcasts
-- set_payer: FOR UPDATE bills, then the deletes of bill_payments / bill_payment_flags (row locks
--   on those rows only), the bills UPDATE, the event insert.
-- bill_participants_reset_payer (BEFORE DELETE, inside the deleting statement): the deleting
--   statement already holds the participant row; then FOR UPDATE bills (S17: participant then
--   bill, the reverse of the paths above; the known M3 R9 account-deletion class, widened by the
--   ledger tables; docs/before-production.md), then the ledger deletes, the bills UPDATE, the
--   event insert.
-- attach_bill_to_group: unchanged order (group, bills FOR UPDATE, ...); step 6 now reads
--   bill_payments and step 7 deletes the bill's bill_payments / bill_payment_flags rows.
-- No new cycle among the client paths.
--
-- ===========================================================================================
-- Grants, columns clients can't read
-- ===========================================================================================
-- Every created or re-created function restates revoke execute from public, anon, authenticated
-- and grants authenticated where a client calls it. pair_state, bill_payer_ids, payers_valid and
-- the trigger functions are executable by no client role. Clients write neither ledger table
-- (20261127140000). Columns clients can't read: none.
--
-- Deploy: old signatures are dropped and the mark columns go away, so `supabase db push`, the web
-- deploy and lib/bills.ts (Task 5) go out together (S11).
--
-- ===========================================================================================
-- Rollback (S13): reversible. See 20261127140000_bill_payments.sql: add the six columns and checks
-- back, copy each pair (user, payer_id)'s contract P mark and flag into them, re-create the
-- functions and the GR-10 trigger from the migrations named above, then drop the new functions.
-- ===========================================================================================

-- Explicit transaction: the CLI runs a migration without BEGIN/COMMIT, and LOCK TABLE needs a
-- transaction block. Any error (including the self-check's raise) rolls the whole file back.
begin;

-- ---------------------------------------------------------------------------
-- The old columns must still match the copy (written in 20261127140000)
-- ---------------------------------------------------------------------------
lock table public.bill_participants in share mode;

do $$
begin
  if exists (
    select 1
    from public.bill_participants as bp
    join public.bills as b on b.id = bp.bill_id
    where bp.settled_at is not null
      and not exists (
        select 1 from public.bill_payments as e
        where e.bill_id = bp.bill_id and e.from_user = bp.user_id and e.to_user = b.payer_id
          and e.cents = bp.settled_cents and e.recorded_at = bp.settled_at
      )
  ) or exists (
    select 1
    from public.bill_participants as bp
    where bp.not_received_cents is not null
      and not exists (
        select 1 from public.bill_payment_flags as f
        where f.bill_id = bp.bill_id and f.from_user = bp.user_id
          and f.to_user = bp.not_received_by and f.cents = bp.not_received_cents
      )
  ) then
    raise exception using errcode = 'P0001',
      message = 'bill_payments_functions: a mark or flag on bill_participants is missing from the ledger copy';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Groups port (B5a, B5b): the no-marks-on-group-bills rule moves to the ledger tables
-- ---------------------------------------------------------------------------
drop trigger bill_participants_no_group_marks on public.bill_participants;
drop function private.bill_participants_no_group_marks();

-- Any entry or flag on a group bill -> 22023 in_group (a group bill settles in the group). Covers
-- mark_paid, settle_difference, mark_not_received and any future writer. attach deletes the
-- bill's rows after setting group_id; a delete doesn't fire this.
create function private.bill_payments_no_group()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.bills as b where b.id = new.bill_id and b.group_id is not null
  ) then
    raise exception using errcode = '22023', message = 'in_group';
  end if;
  return new;
end;
$$;

alter function private.bill_payments_no_group() owner to postgres;
revoke execute on function private.bill_payments_no_group() from public, anon, authenticated;

create trigger bill_payments_no_group
  before insert on public.bill_payments
  for each row
  execute function private.bill_payments_no_group();
create trigger bill_payment_flags_no_group
  before insert on public.bill_payment_flags
  for each row
  execute function private.bill_payments_no_group();

-- ---------------------------------------------------------------------------
-- Drop the old mark columns (D3 step 2)
-- ---------------------------------------------------------------------------
alter table public.bill_participants
  drop constraint bill_participants_settled_cents_range,
  drop constraint bill_participants_mark_complete,
  drop constraint bill_participants_settled_method_known,
  drop constraint bill_participants_method_with_mark,
  drop constraint bill_participants_not_received_complete,
  drop column settled_at,
  drop column settled_cents,
  drop column settled_method,
  drop column not_received_cents,
  drop column not_received_method,
  drop column not_received_by;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function private.pair_state(p_bill_id uuid, p_u uuid, p_v uuid)
returns table (net bigint, mark_at timestamptz, method text, mark_id uuid)
language sql
stable
set search_path = ''
as $$
  with e as (
    select bp.id, bp.recorded_at, bp.method, bp.from_user = p_u as outgoing,
           case when bp.from_user = p_u then bp.cents::bigint else -bp.cents::bigint end as signed
    from public.bill_payments as bp
    where bp.bill_id = p_bill_id
      and ((bp.from_user = p_u and bp.to_user = p_v) or (bp.from_user = p_v and bp.to_user = p_u))
  ),
  r as (
    select e.*,
           row_number() over w as n,
           sum(e.signed) over (w rows between unbounded preceding and current row) as run
    from e
    window w as (order by e.recorded_at, e.id)
  ),
  r2 as (
    select r.*, coalesce(lag(r.run) over (order by r.n), 0) as prev from r
  ),
  tot as (
    select coalesce((select r2.run from r2 order by r2.n desc limit 1), 0) as net
  ),
  k as (
    select max(r2.n) as k from r2 where r2.prev <= 0 and r2.run > 0
  )
  select
    tot.net,
    case when tot.net > 0 then (select r2.recorded_at from r2 where r2.n = k.k) end,
    case when tot.net > 0 then (
      select case when count(distinct r2.method) = 1 then min(r2.method) else 'other' end
      from r2 where r2.n >= k.k and r2.outgoing
    ) end,
    case when tot.net > 0 then (select r2.id from r2 where r2.n = k.k) end
  from tot cross join k;
$$;

revoke execute on function private.pair_state(uuid, uuid, uuid) from public, anon, authenticated;

comment on function private.pair_state(uuid, uuid, uuid) is
  'Contract P (who-paid A1.2): net of u->v minus v->u, and when net > 0 the mark''s start '
  '(mark_at, mark_id) and method. One statement, one snapshot. Same rule as pairState in '
  'lib/transfers.ts.';

-- The current payer set. One-person bills: { bills.payer_id }. Widened in 20261127140002.
create function private.bill_payer_ids(p_bill_id uuid)
returns setof uuid
language sql
stable
set search_path = ''
as $$
  select b.payer_id from public.bills as b where b.id = p_bill_id;
$$;

revoke execute on function private.bill_payer_ids(uuid) from public, anon, authenticated;

-- Do the payers' amounts add up to the bill total? Always true for one-person bills (the amount
-- isn't stored: it is the total, WP-10). Redefined in 20261127140002 for split bills.
create function private.payers_valid(p_bill_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select true;
$$;

revoke execute on function private.payers_valid(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- public.mark_paid (5 args)
-- ---------------------------------------------------------------------------
drop function public.mark_paid(uuid, uuid, integer, text);

create function public.mark_paid(
  p_bill_id uuid,
  p_payer_id uuid,
  p_cents integer,
  p_method text,
  p_plan_key text default null
)
returns table (settled_at timestamptz, created boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := (select auth.uid());
  v_state text;
  v_net bigint;
  v_at timestamptz;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if not exists (
    select 1 from public.bill_participants as bp
    where bp.bill_id = p_bill_id and bp.user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  perform 1 from public.bills as b where b.id = p_bill_id for share;
  if not found or not exists (
    select 1 from public.bill_participants as bp
    where bp.bill_id = p_bill_id and bp.user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if p_cents is null or p_cents < 1 or p_cents > 99999999 then
    raise exception using errcode = '22023', message = 'invalid_amount';
  end if;

  if not coalesce(private.is_payment_method(p_method), false) then
    raise exception using errcode = '22023', message = 'invalid_method';
  end if;

  if p_plan_key is not null and p_plan_key !~ '^[0-9a-f]{16}$' then
    raise exception using errcode = '22023', message = 'invalid_plan_key';
  end if;

  if p_payer_id is null
     or p_payer_id not in (select private.bill_payer_ids(p_bill_id)) then
    raise exception using errcode = '22023', message = 'payer_changed';
  end if;

  if v_uid = p_payer_id then
    raise exception using errcode = '22023', message = 'is_payer';
  end if;

  if not private.payers_valid(p_bill_id) then
    raise exception using errcode = '22023', message = 'payers_stale';
  end if;

  v_state := private.settle_state(p_bill_id, v_uid);
  if v_state = 'all_zero' then
    raise exception using errcode = '22023', message = 'all_zero';
  end if;
  if v_state is null or v_state not in ('final', 'early') then
    raise exception using errcode = '22023', message = 'not_complete';
  end if;

  perform 1 from public.bill_participants as bp
  where bp.bill_id = p_bill_id and bp.user_id = v_uid
  for no key update;

  select ps.net, ps.mark_at into v_net, v_at
  from private.pair_state(p_bill_id, v_uid, p_payer_id) as ps;
  if v_net > 0 then
    return query select v_at, false;
    return;
  end if;

  insert into public.bill_payments
    (bill_id, from_user, to_user, cents, method, plan_key, recorded_by)
  values (p_bill_id, v_uid, p_payer_id, p_cents, p_method, p_plan_key, v_uid)
  returning recorded_at into v_at;

  delete from public.bill_payment_flags as f
  where f.bill_id = p_bill_id and f.from_user = v_uid and f.to_user = p_payer_id;

  perform private.log_event(
    p_bill_id, v_uid, 'marked_paid', null,
    jsonb_build_object('payer_id', p_payer_id, 'cents', p_cents, 'method', p_method)
  );
  return query select v_at, true;
end;
$$;

alter function public.mark_paid(uuid, uuid, integer, text, text) owner to postgres;
revoke execute on function public.mark_paid(uuid, uuid, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.mark_paid(uuid, uuid, integer, text, text) to authenticated;

comment on function public.mark_paid(uuid, uuid, integer, text, text) is
  'Records the caller''s payment to p_payer_id (a current payer) in the ledger (who-paid A1.3). '
  'Returns (settled_at, created): created is false when the pair already has a mark (nothing '
  'changed; settled_at is that mark''s start). p_plan_key: the client''s plan fingerprint or null.';

-- ---------------------------------------------------------------------------
-- public.settle_difference (7 args)
-- ---------------------------------------------------------------------------
drop function public.settle_difference(uuid, uuid, uuid, integer, integer, text);

create function public.settle_difference(
  p_bill_id uuid,
  p_user_id uuid,
  p_payer_id uuid,
  p_expected_cents integer,
  p_new_cents integer,
  p_method text,
  p_plan_key text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_more boolean;
  v_state text;
  v_net bigint;
  v_method text;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if not exists (
    select 1 from public.bill_participants as bp
    where bp.bill_id = p_bill_id and bp.user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  perform 1 from public.bills as b where b.id = p_bill_id for share;
  if not found or not exists (
    select 1 from public.bill_participants as bp
    where bp.bill_id = p_bill_id and bp.user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if p_expected_cents is null or p_expected_cents < 1 or p_expected_cents > 99999999
     or p_new_cents is null or p_new_cents < 0 or p_new_cents > 99999999
     or p_new_cents = p_expected_cents then
    raise exception using errcode = '22023', message = 'invalid_amount';
  end if;

  if not coalesce(private.is_payment_method(p_method), false) then
    raise exception using errcode = '22023', message = 'invalid_method';
  end if;

  if p_plan_key is not null and p_plan_key !~ '^[0-9a-f]{16}$' then
    raise exception using errcode = '22023', message = 'invalid_plan_key';
  end if;

  v_more := p_new_cents > p_expected_cents;

  -- A1 (WP-35): paying more goes to a current payer; paying back is done by whoever received the
  -- money on this pair, payer or not.
  if v_more and (p_payer_id is null
                 or p_payer_id not in (select private.bill_payer_ids(p_bill_id))) then
    raise exception using errcode = '22023', message = 'payer_changed';
  end if;

  if p_user_id is null
     or p_payer_id is null
     or p_user_id = p_payer_id
     or (v_more and v_uid <> p_user_id)
     or (not v_more and v_uid <> p_payer_id) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if not private.payers_valid(p_bill_id) then
    raise exception using errcode = '22023', message = 'payers_stale';
  end if;

  v_state := private.settle_state(p_bill_id, p_user_id);
  if v_state = 'all_zero' then
    raise exception using errcode = '22023', message = 'all_zero';
  end if;
  if v_state is distinct from 'final' then
    raise exception using errcode = '22023', message = 'not_complete';
  end if;

  perform 1 from public.bill_participants as bp
  where bp.bill_id = p_bill_id and bp.user_id = p_user_id
  for no key update;
  if not found then
    raise exception using errcode = '22023', message = 'mark_changed';
  end if;

  select ps.net, ps.method into v_net, v_method
  from private.pair_state(p_bill_id, p_user_id, p_payer_id) as ps;

  if (p_new_cents >= 1 and v_net = p_new_cents) or (p_new_cents = 0 and v_net <= 0) then
    return;
  end if;

  if v_net <= 0 or v_net <> p_expected_cents then
    raise exception using errcode = '22023', message = 'mark_changed';
  end if;

  if v_more then
    insert into public.bill_payments
      (bill_id, from_user, to_user, cents, method, plan_key, recorded_by)
    values (p_bill_id, p_user_id, p_payer_id, p_new_cents - p_expected_cents, p_method,
            p_plan_key, v_uid);

    perform private.log_event(
      p_bill_id, v_uid, 'paid_difference', null,
      jsonb_build_object('payer_id', p_payer_id, 'from', p_expected_cents, 'to', p_new_cents,
                         'method', p_method)
    );
  else
    insert into public.bill_payments
      (bill_id, from_user, to_user, cents, method, plan_key, recorded_by)
    values (p_bill_id, p_payer_id, p_user_id, p_expected_cents - p_new_cents, v_method,
            p_plan_key, v_uid);

    perform private.log_event(
      p_bill_id, v_uid, 'paid_back', null,
      jsonb_build_object('user_id', p_user_id, 'payer_id', p_payer_id, 'from', p_expected_cents,
                         'to', p_new_cents, 'method', v_method)
    );
  end if;
end;
$$;

alter function public.settle_difference(uuid, uuid, uuid, integer, integer, text, text)
  owner to postgres;
revoke execute on function public.settle_difference(uuid, uuid, uuid, integer, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.settle_difference(uuid, uuid, uuid, integer, integer, text, text)
  to authenticated;

comment on function public.settle_difference(uuid, uuid, uuid, integer, integer, text, text) is
  'A difference on the pair (p_user_id -> p_payer_id) (settle early D4; who-paid A1.3): the '
  'sender pays more to a current payer, or the recipient pays back (to 0 leaves no mark). '
  'p_expected_cents is contract P''s net (the stale-state token); an identical retry is a no-op. '
  'Every movement is a new ledger entry.';

-- ---------------------------------------------------------------------------
-- public.unmark_paid (3 args, S16)
-- ---------------------------------------------------------------------------
drop function public.unmark_paid(uuid, uuid);

create function public.unmark_paid(p_bill_id uuid, p_user_id uuid, p_payer_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_host uuid;
  v_net bigint;
  v_at timestamptz;
  v_id uuid;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  select b.host_id into v_host
  from public.bills as b
  where b.id = p_bill_id
  for share;
  if not found
     or not exists (
       select 1 from public.bill_participants as bp
       where bp.bill_id = p_bill_id and bp.user_id = v_uid
     )
     or (v_uid <> v_host and v_uid is distinct from p_user_id
         and v_uid is distinct from p_payer_id) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  perform 1 from public.bill_participants as bp
  where bp.bill_id = p_bill_id and bp.user_id = p_user_id
  for no key update;
  if not found then
    return;
  end if;

  select ps.net, ps.mark_at, ps.mark_id into v_net, v_at, v_id
  from private.pair_state(p_bill_id, p_user_id, p_payer_id) as ps;
  if v_net is null or v_net <= 0 then
    return;
  end if;

  delete from public.bill_payments as e
  where e.bill_id = p_bill_id
    and ((e.from_user = p_user_id and e.to_user = p_payer_id)
         or (e.from_user = p_payer_id and e.to_user = p_user_id))
    and (e.recorded_at, e.id) >= (v_at, v_id);

  perform private.log_event(
    p_bill_id, v_uid, 'unmarked_paid', null,
    jsonb_build_object('user_id', p_user_id, 'cents', v_net)
  );
end;
$$;

alter function public.unmark_paid(uuid, uuid, uuid) owner to postgres;
revoke execute on function public.unmark_paid(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.unmark_paid(uuid, uuid, uuid) to authenticated;

comment on function public.unmark_paid(uuid, uuid, uuid) is
  'Undoes the mark on the pair (p_user_id -> p_payer_id): deletes the mark''s run (contract P). '
  'Host, p_user_id or p_payer_id. No mark: a no-op without an event.';

-- ---------------------------------------------------------------------------
-- public.mark_not_received (same signature)
-- ---------------------------------------------------------------------------
create or replace function public.mark_not_received(
  p_bill_id uuid,
  p_user_id uuid,
  p_payer_id uuid,
  p_expected_cents integer,
  p_expected_at timestamptz
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_net bigint;
  v_at timestamptz;
  v_id uuid;
  v_method text;
  v_flag integer;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if not exists (
    select 1 from public.bill_participants as bp
    where bp.bill_id = p_bill_id and bp.user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  perform 1 from public.bills as b where b.id = p_bill_id for share;
  if not found or not exists (
    select 1 from public.bill_participants as bp
    where bp.bill_id = p_bill_id and bp.user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if p_payer_id is distinct from v_uid then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if p_user_id is null or p_user_id = p_payer_id then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if p_expected_cents is null or p_expected_cents < 1 or p_expected_cents > 99999999
     or p_expected_at is null then
    raise exception using errcode = '22023', message = 'invalid_amount';
  end if;

  perform 1 from public.bill_participants as bp
  where bp.bill_id = p_bill_id and bp.user_id = p_user_id
  for no key update;
  if not found then
    raise exception using errcode = '22023', message = 'mark_changed';
  end if;

  select ps.net, ps.mark_at, ps.mark_id, ps.method into v_net, v_at, v_id, v_method
  from private.pair_state(p_bill_id, p_user_id, v_uid) as ps;

  select f.cents into v_flag
  from public.bill_payment_flags as f
  where f.bill_id = p_bill_id and f.from_user = p_user_id and f.to_user = v_uid;

  if v_net <= 0 and v_flag = p_expected_cents then
    return;
  end if;

  if v_net <= 0 or v_net <> p_expected_cents or v_at <> p_expected_at then
    raise exception using errcode = '22023', message = 'mark_changed';
  end if;

  delete from public.bill_payments as e
  where e.bill_id = p_bill_id
    and ((e.from_user = p_user_id and e.to_user = v_uid)
         or (e.from_user = v_uid and e.to_user = p_user_id))
    and (e.recorded_at, e.id) >= (v_at, v_id);

  insert into public.bill_payment_flags (bill_id, from_user, to_user, cents, method)
  values (p_bill_id, p_user_id, v_uid, v_net::integer, v_method)
  on conflict (bill_id, from_user, to_user)
  do update set cents = excluded.cents, method = excluded.method;

  perform private.log_event(
    p_bill_id, v_uid, 'not_received', null,
    jsonb_build_object('user_id', p_user_id, 'payer_id', v_uid, 'cents', v_net,
                       'method', v_method)
  );
end;
$$;

alter function public.mark_not_received(uuid, uuid, uuid, integer, timestamptz) owner to postgres;
revoke execute on function public.mark_not_received(uuid, uuid, uuid, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.mark_not_received(uuid, uuid, uuid, integer, timestamptz)
  to authenticated;

comment on function public.mark_not_received(uuid, uuid, uuid, integer, timestamptz) is
  'The recipient of the pair (p_user_id -> p_payer_id = caller) says its mark never arrived '
  '(sent via Venmo D4; who-paid A1.3): deletes the mark''s run, stores the flag, logs '
  'not_received. p_expected_cents / p_expected_at are the mark''s net and start (contract P); an '
  'identical retry is a no-op.';

-- ---------------------------------------------------------------------------
-- public.set_payer (3 args, 92's behaviour on the ledger; replaced in 20261127140002)
-- ---------------------------------------------------------------------------
-- cleared = the bill's marked pairs (contract P net > 0); every payment and flag of the bill is
-- deleted, as 92 cleared every mark and flag.
create or replace function public.set_payer(p_bill_id uuid, p_payer_id uuid, p_expected_cleared integer)
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
  from (select distinct e.from_user, e.to_user
        from public.bill_payments as e where e.bill_id = p_bill_id) as pr
  cross join lateral private.pair_state(p_bill_id, pr.from_user, pr.to_user) as ps
  where ps.net > 0;

  if p_expected_cleared is null or p_expected_cleared <> v_marks then
    raise exception using errcode = '22023', message = 'marks_changed';
  end if;

  delete from public.bill_payments as e where e.bill_id = p_bill_id;
  delete from public.bill_payment_flags as f where f.bill_id = p_bill_id;

  update public.bills as b set payer_id = p_payer_id where b.id = p_bill_id;

  perform private.log_event(
    p_bill_id, v_uid, 'payer_changed', null,
    jsonb_build_object('before', v_current, 'after', p_payer_id, 'cleared', v_marks)
  );
end;
$$;

revoke execute on function public.set_payer(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.set_payer(uuid, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- private.bill_participants_reset_payer: BEFORE DELETE (B3)
-- ---------------------------------------------------------------------------
-- Same behaviour as 92's (hand the bill back to the host, clear every payment and flag, one
-- payer_changed with actor null), counted before the FK cascade can delete the payer's entries.
create or replace function private.bill_participants_reset_payer()
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
    return old;
  end if;

  select count(*)::integer into v_cleared
  from (select distinct e.from_user, e.to_user
        from public.bill_payments as e where e.bill_id = old.bill_id) as pr
  cross join lateral private.pair_state(old.bill_id, pr.from_user, pr.to_user) as ps
  where ps.net > 0;

  delete from public.bill_payments as e where e.bill_id = old.bill_id;
  delete from public.bill_payment_flags as f where f.bill_id = old.bill_id;

  update public.bills as b set payer_id = v_host where b.id = old.bill_id;

  perform private.log_event(
    old.bill_id, null, 'payer_changed', null,
    jsonb_build_object('before', old.user_id, 'after', v_host, 'cleared', v_cleared)
  );
  return old;
end;
$$;

alter function private.bill_participants_reset_payer() owner to postgres;
revoke execute on function private.bill_participants_reset_payer() from public, anon, authenticated;

drop trigger bill_participants_reset_payer on public.bill_participants;
create trigger bill_participants_reset_payer
  before delete on public.bill_participants
  for each row
  execute function private.bill_participants_reset_payer();

-- ---------------------------------------------------------------------------
-- private.is_removable (L3 on the ledger)
-- ---------------------------------------------------------------------------
-- T is removable: a participant, not the host, not in the current payer set, no claims, and every
-- pair involving T nets to 0 (someone fully paid back may leave; WP-36). Flags don't block.
create or replace function private.is_removable(p_bill_id uuid, p_user_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.bill_participants as bp
    join public.bills as b on b.id = bp.bill_id
    where bp.bill_id = p_bill_id
      and bp.user_id = p_user_id
      and bp.user_id <> b.host_id
      and bp.user_id not in (select private.bill_payer_ids(p_bill_id))
      and not exists (
        select 1 from public.claims as c
        where c.bill_id = p_bill_id and c.user_id = p_user_id
      )
      and not exists (
        select 1
        from public.bill_payments as e
        where e.bill_id = p_bill_id and (e.from_user = p_user_id or e.to_user = p_user_id)
        group by case when e.from_user = p_user_id then e.to_user else e.from_user end
        having sum(case when e.from_user = p_user_id then e.cents::bigint
                        else -e.cents::bigint end) <> 0
      )
  );
$$;

revoke execute on function private.is_removable(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- public.attach_bill_to_group (B5c): ledger entries -> group payments
-- ---------------------------------------------------------------------------
-- Same checks and order as 20261127060131_group_bills.sql; "a mark" is now "a ledger entry".
-- Each bill_payments entry becomes one group_payments row (source 'bill_mark', its method,
-- recorded_by = the entry's recorded_by, which is always its from_user); then the bill's entries
-- and flags are deleted. converted = the number of entries converted.
create or replace function public.attach_bill_to_group(p_bill_id uuid, p_group_id uuid)
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
  if not exists (
    select 1 from public.bills as b where b.id = p_bill_id and b.host_id = v_uid
  ) or not exists (
    select 1 from public.group_members as gm
    where gm.group_id = p_group_id and gm.user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  perform 1 from public.groups as g where g.id = p_group_id for no key update;
  select b.* into v_bill from public.bills as b where b.id = p_bill_id for update of b;

  if v_bill.id is null or v_bill.host_id <> v_uid or not exists (
    select 1 from public.group_members as gm
    where gm.group_id = p_group_id and gm.user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if v_bill.group_id = p_group_id then
    return;
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

  if exists (
    select 1 from public.bill_payments as e where e.bill_id = p_bill_id
  ) and (not private.bill_is_complete(p_bill_id) or private.bill_all_zero(p_bill_id)) then
    raise exception using errcode = '22023', message = 'not_complete';
  end if;

  update public.bills as b set group_id = p_group_id where b.id = p_bill_id;

  insert into public.bill_participants (bill_id, user_id, added)
  select p_bill_id, gm.user_id, false
  from public.group_members as gm
  where gm.group_id = p_group_id
  order by gm.user_id
  on conflict (bill_id, user_id) do nothing;

  insert into public.group_payments
    (id, group_id, from_user, to_user, cents, method, source, recorded_by, bill_id)
  select gen_random_uuid(), p_group_id, e.from_user, e.to_user, e.cents, e.method, 'bill_mark',
         e.recorded_by, p_bill_id
  from public.bill_payments as e
  where e.bill_id = p_bill_id
  order by e.recorded_at, e.id;
  get diagnostics v_converted = row_count;

  delete from public.bill_payments as e where e.bill_id = p_bill_id;
  delete from public.bill_payment_flags as f where f.bill_id = p_bill_id;

  perform private.log_group_event(p_group_id, v_uid, 'bill_added',
    jsonb_build_object('bill_id', p_bill_id, 'converted', v_converted));
  perform private.log_event(p_bill_id, v_uid, 'moved_to_group', null,
    jsonb_build_object('group_id', p_group_id, 'converted', v_converted));
end;
$$;

alter function public.attach_bill_to_group(uuid, uuid) owner to postgres;
revoke execute on function public.attach_bill_to_group(uuid, uuid) from public, anon, authenticated;
grant execute on function public.attach_bill_to_group(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
