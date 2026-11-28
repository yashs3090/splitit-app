-- Sent via Venmo and choosing how you paid, Task 2 (spec docs/specs/2026-11-26-sent-via-venmo.md,
-- Amendment A1; D1 contract M, D4 contract N, D6, D7, D8; criteria 1-21, 49-50; engineering review
-- docs/specs/2026-11-26-sent-via-venmo-eng.md sections 3 and 11). Earlier migrations are applied and
-- are not edited.
--
--   private.is_payment_method(text)   THE one list of payment methods in SQL (D1). Every check and
--                                     function below calls it; nothing else in SQL spells the list.
--                                     lib/paymentMethods.ts PAYMENT_METHODS must match it (drift
--                                     test). Adding a method = create or replace this function in a
--                                     new migration, plus one lib line.
--   bill_participants columns         settled_method, not_received_cents, not_received_method,
--                                     not_received_by (+ checks). Existing marks backfilled 'other'.
--   public.mark_paid                  dropped (uuid, uuid, integer); re-created with p_method,
--                                     returns table (settled_at, created)
--   public.settle_difference          dropped (5 args); re-created with p_method (6 args)
--   public.mark_not_received          new (D4)
--   public.unmark_paid, public.set_payer, private.bill_participants_reset_payer
--                                     create or replace, same signatures: every statement that
--                                     clears a mark also nulls settled_method; set_payer and the
--                                     reset trigger also null the three not_received_* columns
--   public.my_bills                   dropped and re-created with seen_at appended
--   bill_events_kind_known            the list from 20261125090051_settle_difference.sql (the latest
--                                     definition on disk) plus 'not_received'
--
-- Statements that clear a mark (grep of every migration for "settled_cents = null"), each changed
-- here to null settled_method in the same UPDATE:
--   20261124081411_settle_payer.sql   private.bill_participants_reset_payer (the cleared CTE)
--   20261124081411_settle_payer.sql   public.set_payer
--   20261124081412_settle_marks.sql   public.unmark_paid
--   20261125090051_settle_difference.sql  public.settle_difference, pay back to 0
--   (new)                             public.mark_not_received
--
-- ---------------------------------------------------------------------------
-- What the new columns mean (each row = one transfer from user_id to bills.payer_id, eng §11)
-- ---------------------------------------------------------------------------
--   settled_method       how the current mark was paid; null exactly when there is no mark
--                        (bill_participants_method_with_mark). Self-reported, like the mark.
--   not_received_cents   } the payer said this mark never arrived. All three set or all null
--   not_received_method  } (bill_participants_not_received_complete). Set only by
--   not_received_by      } mark_not_received; cleared by mark_paid, set_payer and the payer-reset
--                          trigger. not_received_by is the person the money was owed to (the
--                          to_user). It has NO foreign key on purpose: no profiles lock taken on
--                          writes and no cascade to follow on account deletion.
--
-- ---------------------------------------------------------------------------
-- Grants and columns clients can't read
-- ---------------------------------------------------------------------------
-- No table grant changes. authenticated keeps table-level SELECT on bill_participants, so the new
-- columns are readable by every participant (the same fact is in Activity); `select *` still works
-- on this table. NO client role can write any of these columns: bill_participants has no client
-- INSERT/UPDATE/DELETE grant, so a direct write fails with 42501. They change only through the
-- security definer functions here. Columns clients can't read: none on bills or bill_participants.
-- Every created or re-created function below restates revoke execute from public, anon,
-- authenticated (Postgres grants EXECUTE to PUBLIC on create) and grants authenticated where a
-- client calls it. private.is_payment_method is executable by no client role.
--
-- ---------------------------------------------------------------------------
-- Event details written here (lib/activityText.ts parses them; D6)
-- ---------------------------------------------------------------------------
--   marked_paid      { payer_id, cents, method }               actor = the person who marked
--   paid_difference  { payer_id, from, to, method }            method = p_method (this payment)
--   paid_back        { user_id, payer_id, from, to, method }   method = the mark's stored method
--                                                              before the change (p_method is
--                                                              ignored for pay-backs)
--   not_received     { user_id, payer_id, cents, method }      actor = the payer; cents and method
--                                                              are the cleared mark's
--   unmarked_paid    unchanged { user_id, cents }
--
-- ---------------------------------------------------------------------------
-- Lock order (rule: the BILLS ROW FIRST; implicit locks listed)
-- ---------------------------------------------------------------------------
-- mark_paid:
--   0 none               participation read on bill_participants (no lock)
--   1 FOR SHARE          bills row
--   2 none               line_items, claims (private.settle_state, one call)
--   3 FOR NO KEY UPDATE  (implicit) the caller's bill_participants row, by the conditional UPDATE
--                        (no key or FK column changes; not_received_by has no FK)
--   4 FOR KEY SHARE      (implicit) bills row (held, compatible) via bill_events_bill_id_fkey and
--                        the caller's profiles row via bill_events_actor_id_fkey (log_event)
--   5 none               statement-level bill_participants_broadcast_update
--   The no-op path ("already marked") reads the row with a plain select (no lock, no event, no
--   broadcast).
-- settle_difference: unchanged from 20261125090051 (steps 0-2 as above, then an explicit FOR NO
--   KEY UPDATE on p_user_id's row, the UPDATE, the event insert's FOR KEY SHARE on bills and the
--   caller's profiles row, the broadcast). payer_id in details is jsonb, so no lock on the payer's
--   profiles row.
-- mark_not_received:
--   0 none               participation read (no lock)
--   1 FOR SHARE          bills row
--   2 FOR NO KEY UPDATE  p_user_id's bill_participants row (explicit)
--   3 none extra         the UPDATE (row already locked; no FK column changes)
--   4 FOR KEY SHARE      (implicit) bills row and the caller's profiles row (log_event)
--   5 none               broadcast (only when the UPDATE ran; the idempotent retry runs none)
-- unmark_paid: unchanged (FOR SHARE bills, then FOR UPDATE on the target row, the event insert).
-- set_payer: unchanged (FOR UPDATE bills, then the UPDATE of this bill's participant rows, the
--   bills UPDATE, the event insert). The clearing UPDATE now also matches rows that only carry a
--   not-received flag; same rows, same table, same order.
-- bill_participants_reset_payer (AFTER DELETE, inside the deleting statement): unchanged (FOR
--   UPDATE bills, then the clearing UPDATE, the bills UPDATE, the event insert with actor null).
-- my_bills: no locks.
-- Bill row first, then the participant row, then the event insert, in every path: no new cycle.
-- The account-deletion cascade gap (M3 R9) is unchanged.
--
-- ---------------------------------------------------------------------------
-- Direct API callers (honor system, D8)
-- ---------------------------------------------------------------------------
-- A caller may set any known method on their own mark (it is self-reported, like the mark). The
-- payer may mark anyone's CURRENT mark not received, given its exact cents and settled_at (no
-- stronger than unmark_paid, which the payer already has; logged with the actor). A replayed old
-- mark_not_received is refused by p_expected_at. The payer's silent unmark_paid stays (SV-26).
-- Nobody sets settled_method or not_received_* on another person's row except through these
-- functions. my_bills.seen_at is the caller's own.
--
-- Deploy: old signatures are dropped, so `supabase db push` and the web deploy go out together
-- (SV-2, SV-ENG-23).

-- ---------------------------------------------------------------------------
-- private.is_payment_method (D1): the one list
-- ---------------------------------------------------------------------------
-- Null in, null out (callers treat null as "not a method"). security invoker, immutable.
create function private.is_payment_method(p text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p in ('venmo','cash','other');
$$;

revoke execute on function private.is_payment_method(text) from public, anon, authenticated;

comment on function private.is_payment_method(text) is
  'The one list of payment methods (spec 2026-11-26 sent via Venmo, D1). Every SQL check calls '
  'this; lib/paymentMethods.ts PAYMENT_METHODS must match it (drift test).';

-- ---------------------------------------------------------------------------
-- Columns, backfill, checks (D1, D4)
-- ---------------------------------------------------------------------------
alter table public.bill_participants
  add column settled_method text null,
  add column not_received_cents integer null,
  add column not_received_method text null,
  add column not_received_by uuid null;

-- Existing marks become 'other' (today's "I paid" copy) before the checks are added. This UPDATE
-- fires bill_participants_broadcast_update once (one hint per bill that has a mark).
update public.bill_participants as bp
set settled_method = 'other'
where bp.settled_at is not null and bp.settled_method is null;

alter table public.bill_participants
  add constraint bill_participants_settled_method_known
    check (settled_method is null or private.is_payment_method(settled_method)),
  add constraint bill_participants_method_with_mark
    check ((settled_at is null) = (settled_method is null)),
  add constraint bill_participants_not_received_complete
    check (
      (not_received_cents is null and not_received_method is null and not_received_by is null)
      or (
        not_received_cents is not null
        and not_received_cents between 1 and 99999999
        and not_received_by is not null
        and not_received_method is not null
        and coalesce(private.is_payment_method(not_received_method), false)
      )
    );

comment on column public.bill_participants.settled_method is
  'How the current mark was paid (private.is_payment_method). Null exactly when there is no mark. '
  'Self-reported; "venmo" means it was recorded around opening Venmo. Set by mark_paid / '
  'settle_difference only.';
comment on column public.bill_participants.not_received_cents is
  'The payer said this mark never arrived: the cleared mark''s cents (1..99999999). All three '
  'not_received_* are set together by mark_not_received; cleared by mark_paid, set_payer and the '
  'payer-reset trigger.';
comment on column public.bill_participants.not_received_method is
  'The cleared mark''s method (private.is_payment_method). See not_received_cents.';
comment on column public.bill_participants.not_received_by is
  'The person the money was owed to (the to_user; today always the payer who said it did not '
  'arrive). No foreign key on purpose: writes take no lock on profiles and nothing cascades.';

-- ---------------------------------------------------------------------------
-- Activity kinds
-- ---------------------------------------------------------------------------
alter table public.bill_events drop constraint bill_events_kind_known;
alter table public.bill_events
  add constraint bill_events_kind_known check (kind in (
    'bill_created', 'joined', 'claimed', 'unclaimed', 'split_changed', 'item_added',
    'item_removed', 'item_changed', 'amounts_changed', 'link_rotated', 'extras_split_changed',
    'payer_changed', 'marked_paid', 'unmarked_paid',
    'participant_added', 'participant_removed', 'left',
    'paid_difference', 'paid_back',
    'not_received'
  ));

-- ---------------------------------------------------------------------------
-- private.bill_participants_reset_payer: also nulls settled_method and not_received_*
-- ---------------------------------------------------------------------------
-- Same behaviour as 20261124081411_settle_payer.sql otherwise. `cleared` still counts marks only
-- (a flag isn't a mark), counted before the clearing UPDATE under the bills row lock.
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
    return null;
  end if;

  select count(*)::integer into v_cleared
  from public.bill_participants as bp
  where bp.bill_id = old.bill_id and bp.settled_at is not null;

  update public.bill_participants as bp
  set settled_at = null, settled_cents = null, settled_method = null,
      not_received_cents = null, not_received_method = null, not_received_by = null
  where bp.bill_id = old.bill_id
    and (bp.settled_at is not null or bp.not_received_cents is not null);

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

-- ---------------------------------------------------------------------------
-- public.set_payer: also nulls settled_method and not_received_* (SV-ENG-14, reverses SV-25)
-- ---------------------------------------------------------------------------
-- Same checks, order and errors as 20261124081411_settle_payer.sql. The one clearing UPDATE
-- covers marks and flags; a statement that touches no row sends no broadcast.
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
  from public.bill_participants as bp
  where bp.bill_id = p_bill_id and bp.settled_at is not null;

  if p_expected_cleared is null or p_expected_cleared <> v_marks then
    raise exception using errcode = '22023', message = 'marks_changed';
  end if;

  update public.bill_participants as bp
  set settled_at = null, settled_cents = null, settled_method = null,
      not_received_cents = null, not_received_method = null, not_received_by = null
  where bp.bill_id = p_bill_id
    and (bp.settled_at is not null or bp.not_received_cents is not null);

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
-- public.unmark_paid: also nulls settled_method (permission rule unchanged)
-- ---------------------------------------------------------------------------
create or replace function public.unmark_paid(p_bill_id uuid, p_user_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_host uuid;
  v_payer uuid;
  v_cents integer;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  select b.host_id, b.payer_id into v_host, v_payer
  from public.bills as b
  where b.id = p_bill_id
  for share;
  if not found
     or not exists (
       select 1 from public.bill_participants as bp
       where bp.bill_id = p_bill_id and bp.user_id = v_uid
     )
     or (v_uid <> v_host and v_uid <> v_payer and v_uid is distinct from p_user_id) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  select bp.settled_cents into v_cents
  from public.bill_participants as bp
  where bp.bill_id = p_bill_id and bp.user_id = p_user_id and bp.settled_at is not null
  for update;
  if not found then
    return;
  end if;

  update public.bill_participants as bp
  set settled_at = null, settled_cents = null, settled_method = null
  where bp.bill_id = p_bill_id and bp.user_id = p_user_id;

  perform private.log_event(
    p_bill_id, v_uid, 'unmarked_paid', null,
    jsonb_build_object('user_id', p_user_id, 'cents', v_cents)
  );
end;
$$;

revoke execute on function public.unmark_paid(uuid, uuid) from public, anon, authenticated;
grant execute on function public.unmark_paid(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- public.mark_paid (D8 item 3; F3)
-- ---------------------------------------------------------------------------
-- Check order (0021 D3 plus invalid_method right after invalid_amount; the app's error mapping
-- relies on it):
--   0 signed out                                                    42501 not_allowed
--   1 caller not a participant of an existing bill (plain read, no lock)
--                                                                   42501 not_allowed
--   2 bills row FOR SHARE, participation re-checked under the lock  42501 not_allowed
--   3 p_cents null or outside 1..99,999,999                         22023 invalid_amount
--   4 p_method null or not a payment method                         22023 invalid_method
--   5 p_payer_id isn't the current payer                            22023 payer_changed
--   6 caller is the payer                                           22023 is_payer
--   7 settle_state (one call) = 'all_zero'                          22023 all_zero
--   8 settle_state not 'final' / 'early'                            22023 not_complete
--   9 already marked: no-op, returns (the stored settled_at, false); no write, no event, no
--     broadcast. settled_at is null if a racing unmark committed between the UPDATE and the read.
--  10 settled_at = now(), settled_cents = p_cents, settled_method = p_method, not_received_* null
--     (same UPDATE); one marked_paid { payer_id, cents, method }, actor = caller; returns
--     (settled_at, true).
drop function public.mark_paid(uuid, uuid, integer);

create function public.mark_paid(p_bill_id uuid, p_payer_id uuid, p_cents integer, p_method text)
returns table (settled_at timestamptz, created boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := (select auth.uid());
  v_payer uuid;
  v_state text;
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

  select b.payer_id into v_payer
  from public.bills as b
  where b.id = p_bill_id
  for share;
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

  if p_payer_id is distinct from v_payer then
    raise exception using errcode = '22023', message = 'payer_changed';
  end if;

  if v_uid = v_payer then
    raise exception using errcode = '22023', message = 'is_payer';
  end if;

  v_state := private.settle_state(p_bill_id, v_uid);
  if v_state = 'all_zero' then
    raise exception using errcode = '22023', message = 'all_zero';
  end if;
  if v_state is null or v_state not in ('final', 'early') then
    raise exception using errcode = '22023', message = 'not_complete';
  end if;

  update public.bill_participants as bp
  set settled_at = now(), settled_cents = p_cents, settled_method = p_method,
      not_received_cents = null, not_received_method = null, not_received_by = null
  where bp.bill_id = p_bill_id and bp.user_id = v_uid and bp.settled_at is null
  returning bp.settled_at into v_at;

  if found then
    perform private.log_event(
      p_bill_id, v_uid, 'marked_paid', null,
      jsonb_build_object('payer_id', v_payer, 'cents', p_cents, 'method', p_method)
    );
    return query select v_at, true;
    return;
  end if;

  select bp.settled_at into v_at
  from public.bill_participants as bp
  where bp.bill_id = p_bill_id and bp.user_id = v_uid;
  return query select v_at, false;
end;
$$;

alter function public.mark_paid(uuid, uuid, integer, text) owner to postgres;
revoke execute on function public.mark_paid(uuid, uuid, integer, text) from public, anon, authenticated;
grant execute on function public.mark_paid(uuid, uuid, integer, text) to authenticated;

comment on function public.mark_paid(uuid, uuid, integer, text) is
  'Records the caller''s own "I paid" mark with how they paid (spec 2026-11-26 sent via Venmo, D8). '
  'Returns one row (settled_at, created): created is false when a mark already existed (nothing '
  'changed; the app must not open Venmo then).';

-- ---------------------------------------------------------------------------
-- public.settle_difference (D8 item 4)
-- ---------------------------------------------------------------------------
-- Check order: 20261125090051_settle_difference.sql D4, plus invalid_method right after
-- invalid_amount (step 3b). p_method is validated in both directions (a client always sends one),
-- but only "more" uses it:
--   more (p_new_cents > p_expected_cents): settled_method kept when equal to p_method, else 'other'
--        (SV-4: never claims the net went one way). paid_difference { payer_id, from, to, method:
--        p_method }.
--   back (p_new_cents < p_expected_cents, >= 1): settled_method unchanged, whatever p_method says.
--        to 0: the mark is cleared (settled_at, settled_cents, settled_method null).
--        paid_back { user_id, payer_id, from, to, method: the stored method before the change }.
-- The idempotent retry (step 9) is unchanged: no write, no event, no broadcast.
drop function public.settle_difference(uuid, uuid, uuid, integer, integer);

create function public.settle_difference(
  p_bill_id uuid,
  p_user_id uuid,
  p_payer_id uuid,
  p_expected_cents integer,
  p_new_cents integer,
  p_method text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_payer uuid;
  v_more boolean;
  v_state text;
  v_marked boolean;
  v_cents integer;
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

  select b.payer_id into v_payer
  from public.bills as b
  where b.id = p_bill_id
  for share;
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

  if p_payer_id is distinct from v_payer then
    raise exception using errcode = '22023', message = 'payer_changed';
  end if;

  v_more := p_new_cents > p_expected_cents;
  if p_user_id is null
     or p_user_id = v_payer
     or (v_more and v_uid <> p_user_id)
     or (not v_more and v_uid <> v_payer) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  v_state := private.settle_state(p_bill_id, p_user_id);
  if v_state = 'all_zero' then
    raise exception using errcode = '22023', message = 'all_zero';
  end if;
  if v_state is distinct from 'final' then
    raise exception using errcode = '22023', message = 'not_complete';
  end if;

  select bp.settled_at is not null, bp.settled_cents, bp.settled_method
    into v_marked, v_cents, v_method
  from public.bill_participants as bp
  where bp.bill_id = p_bill_id and bp.user_id = p_user_id
  for no key update;
  if not found then
    raise exception using errcode = '22023', message = 'mark_changed';
  end if;

  if (p_new_cents >= 1 and v_cents = p_new_cents) or (p_new_cents = 0 and not v_marked) then
    return;
  end if;

  if not v_marked or v_cents is distinct from p_expected_cents then
    raise exception using errcode = '22023', message = 'mark_changed';
  end if;

  if v_more then
    update public.bill_participants as bp
    set settled_cents = p_new_cents,
        settled_method = case when bp.settled_method = p_method then bp.settled_method else 'other' end
    where bp.bill_id = p_bill_id and bp.user_id = p_user_id;
  elsif p_new_cents >= 1 then
    update public.bill_participants as bp
    set settled_cents = p_new_cents
    where bp.bill_id = p_bill_id and bp.user_id = p_user_id;
  else
    update public.bill_participants as bp
    set settled_at = null, settled_cents = null, settled_method = null
    where bp.bill_id = p_bill_id and bp.user_id = p_user_id;
  end if;

  if v_more then
    perform private.log_event(
      p_bill_id, v_uid, 'paid_difference', null,
      jsonb_build_object('payer_id', v_payer, 'from', p_expected_cents, 'to', p_new_cents,
                         'method', p_method)
    );
  else
    perform private.log_event(
      p_bill_id, v_uid, 'paid_back', null,
      jsonb_build_object('user_id', p_user_id, 'payer_id', v_payer, 'from', p_expected_cents,
                         'to', p_new_cents, 'method', v_method)
    );
  end if;
end;
$$;

alter function public.settle_difference(uuid, uuid, uuid, integer, integer, text) owner to postgres;
revoke execute on function public.settle_difference(uuid, uuid, uuid, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.settle_difference(uuid, uuid, uuid, integer, integer, text)
  to authenticated;

comment on function public.settle_difference(uuid, uuid, uuid, integer, integer, text) is
  'Records a difference on a mark (spec 2026-11-25 settle early, D4; 2026-11-26 sent via Venmo, '
  'D1): the person raises their own mark (paid more, with how) or the payer lowers it (paid back; '
  '0 clears the mark; p_method ignored). p_expected_cents is the stale-state token; an identical '
  'retry is a no-op.';

-- ---------------------------------------------------------------------------
-- public.mark_not_received (D4 contract N; F5; eng §11)
-- ---------------------------------------------------------------------------
-- The payer says a mark never arrived: clears it and stores the flag, so the sender is told.
-- Check order (the app's error mapping relies on it):
--   0  signed out                                                     42501 not_allowed
--   1  caller not a participant of an existing bill (plain read, no lock)
--                                                                     42501 not_allowed
--   2  bills row FOR SHARE, participation re-checked under the lock   42501 not_allowed
--   3a caller isn't p_payer_id                                        42501 not_allowed
--   3b p_payer_id isn't the bill's current payer                      22023 payer_changed
--   3c p_user_id null or the payer                                    42501 not_allowed
--   4  p_expected_cents null or outside 1..99,999,999, or p_expected_at null
--                                                                     22023 invalid_amount
--   5  p_user_id's row FOR NO KEY UPDATE; no such row                 22023 mark_changed
--   6  idempotent retry: row unmarked, not_received_cents = p_expected_cents and
--      not_received_by = caller: return; no write, no event, no broadcast. Never skips 0-5.
--   7  row unmarked, or settled_cents <> p_expected_cents, or settled_at <> p_expected_at
--      (the stale-state tokens; p_expected_at closes the ABA case of a mark cleared and re-made
--      at the same amount)                                            22023 mark_changed
--   8  clear settled_at / settled_cents / settled_method; not_received_cents / _method from the
--      cleared mark, not_received_by = caller; one not_received { user_id, payer_id, cents,
--      method }, actor = caller.
create function public.mark_not_received(
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
  v_payer uuid;
  v_at timestamptz;
  v_cents integer;
  v_method text;
  v_nr_cents integer;
  v_nr_by uuid;
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

  select b.payer_id into v_payer
  from public.bills as b
  where b.id = p_bill_id
  for share;
  if not found or not exists (
    select 1 from public.bill_participants as bp
    where bp.bill_id = p_bill_id and bp.user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if p_payer_id is distinct from v_uid then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if p_payer_id is distinct from v_payer then
    raise exception using errcode = '22023', message = 'payer_changed';
  end if;

  if p_user_id is null or p_user_id = v_payer then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if p_expected_cents is null or p_expected_cents < 1 or p_expected_cents > 99999999
     or p_expected_at is null then
    raise exception using errcode = '22023', message = 'invalid_amount';
  end if;

  select bp.settled_at, bp.settled_cents, bp.settled_method, bp.not_received_cents,
         bp.not_received_by
    into v_at, v_cents, v_method, v_nr_cents, v_nr_by
  from public.bill_participants as bp
  where bp.bill_id = p_bill_id and bp.user_id = p_user_id
  for no key update;
  if not found then
    raise exception using errcode = '22023', message = 'mark_changed';
  end if;

  if v_at is null and v_nr_cents = p_expected_cents and v_nr_by = v_uid then
    return;
  end if;

  if v_at is null or v_cents is distinct from p_expected_cents or v_at <> p_expected_at then
    raise exception using errcode = '22023', message = 'mark_changed';
  end if;

  update public.bill_participants as bp
  set settled_at = null, settled_cents = null, settled_method = null,
      not_received_cents = v_cents, not_received_method = v_method, not_received_by = v_uid
  where bp.bill_id = p_bill_id and bp.user_id = p_user_id;

  perform private.log_event(
    p_bill_id, v_uid, 'not_received', null,
    jsonb_build_object('user_id', p_user_id, 'payer_id', v_payer, 'cents', v_cents,
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
  'The payer says a mark never arrived (spec 2026-11-26 sent via Venmo, D4): clears the mark, '
  'stores not_received_* and logs not_received. p_expected_cents and p_expected_at are the mark''s '
  'settled_cents and settled_at (stale-state tokens); an identical retry is a no-op.';

-- ---------------------------------------------------------------------------
-- public.my_bills: seen_at appended (D7, F8)
-- ---------------------------------------------------------------------------
-- Same as 20261124144925_bill_seen.sql plus seen_at = the caller's own bill_seen.seen_at (null
-- with no row). The column is appended, so an old web build still parses (parseSummary ignores
-- unknown fields). No locks.
drop function public.my_bills();

create function public.my_bills()
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
  order by bp.joined_at desc, b.created_at desc, b.id asc
  limit 20;
end;
$$;

alter function public.my_bills() owner to postgres;
revoke execute on function public.my_bills() from public, anon, authenticated;
grant execute on function public.my_bills() to authenticated;

-- ---------------------------------------------------------------------------
-- PostgREST: pick up the dropped and new signatures now
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';
