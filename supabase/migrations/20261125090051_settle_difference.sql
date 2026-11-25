-- Settle the difference, Task 2 (spec docs/specs/2026-11-25-settle-early-and-differences.md,
-- Amendment A1; D4 contract D, D8, D9, D10; criteria 7-15). Earlier migrations are applied and are
-- not edited. Builds on 20261125090050_settle_early.sql (private.settle_state).
--
--   public.settle_difference(p_bill_id, p_user_id, p_payer_id, p_expected_cents, p_new_cents)
--   bill_events_kind_known: the list from 20261124091041_people.sql (the latest definition) plus
--   'paid_difference' and 'paid_back'
--
-- What a mark stores (A1.1, SE-ENG-1): bill_participants.settled_cents is the NET amount settled
-- between this person and the payer (marked, plus differences paid, minus what the payer paid
-- back). The constraints are unchanged (bill_participants_settled_cents_range 1..99,999,999,
-- bill_participants_mark_complete), so $0 is never stored: a pay-back to exactly 0 clears the mark
-- (settled_at and settled_cents both null). settled_at is otherwise unchanged by a difference: it
-- stays the time of the first mark.
--
-- Who may call, by direction (D4): p_new_cents > p_expected_cents (paying more): only p_user_id
-- themself. p_new_cents < p_expected_cents (paying back): only the current payer. Nobody else, the
-- host included. p_user_id may never be the payer.
--
-- Check order (D4; the app's error mapping relies on it):
--    0 signed out                                                         42501 not_allowed
--    1 caller not a participant of an existing bill (plain read, NO lock)  42501 not_allowed
--    2 bills row FOR SHARE, participation re-checked under the lock       42501 not_allowed
--    3 p_expected_cents null or outside 1..99,999,999; p_new_cents null or outside 0..99,999,999;
--      or the two equal                                                   22023 invalid_amount
--    4 p_payer_id isn't the current payer                                 22023 payer_changed
--    5 wrong caller for the direction, or p_user_id is the payer (or null) 42501 not_allowed
--    6 settle_state(bill, p_user_id) (one call) = 'all_zero'              22023 all_zero
--    7 settle_state <> 'final' (differences only once complete, SE-6)     22023 not_complete
--    8 p_user_id's participant row locked FOR NO KEY UPDATE; no such row  22023 mark_changed
--    9 idempotent retry (A1.3): the row already holds the requested state (p_new_cents >= 1 and
--      settled_cents = p_new_cents, or p_new_cents = 0 and no mark): return, no write, no event,
--      no broadcast. Never skips steps 0-7
--   10 the row isn't marked, or settled_cents is distinct from p_expected_cents (the stale-state
--      token)                                                             22023 mark_changed
--   11 p_new_cents >= 1: settled_cents = p_new_cents. p_new_cents = 0: settled_at and
--      settled_cents set to null. One event, actor = caller:
--        paid_difference { payer_id: uid, from: int >= 1, to: int >= 2 }  (to > from; more)
--        paid_back       { user_id: uid, from: int >= 1, to: int >= 0 }   (to < from; to = 0 is the
--                                                                          pay-back that cleared
--                                                                          the mark)
--      The token can't detect the share changing again between screen load and tap (the DB can't
--      compute shares). The record says what was actually paid (from -> to).
--
-- Lock order of settle_difference (D10), explicit and implicit, in the order taken:
--   0 none               participation read on bill_participants (step 1; R4 rule)
--   1 FOR SHARE          bills row (step 2). Serializes with set_payer, update_bill,
--                        set_extras_split, remove_participant, leave_bill (FOR UPDATE on bills)
--   2 none               line_items, claims (settle_state, one call). A claim's FOR KEY SHARE on
--                        bills doesn't conflict with FOR SHARE, so rule E can be one claim out of
--                        date; harmless (W3)
--   3 FOR NO KEY UPDATE  p_user_id's bill_participants row (step 8, explicit). Not FOR UPDATE: that
--                        conflicts with the FOR KEY SHARE every claim's foreign key takes on this
--                        row, so it would queue behind the person's own claim taps. NO KEY UPDATE
--                        still serializes with mark_paid, unmark_paid and another settle_difference
--   4 none extra         the UPDATE of settled_at / settled_cents (row already locked; no key or
--                        foreign-key columns change)
--   5 FOR KEY SHARE      (implicit) the bills row (already held, compatible) through
--                        bill_events_bill_id_fkey, and the caller's profiles row through
--                        bill_events_actor_id_fkey, from the private.log_event insert. The profiles
--                        lock conflicts only with account deletion (the existing M3 R9 gap)
--   6 none               statement-level bill_participants_broadcast_update -> one Realtime
--                        message. The idempotent return (step 9) runs no UPDATE, so no broadcast
-- Bill row first, then the participant row, then the event insert: the same direction as
-- mark_paid, unmark_paid and every other path. No cycle with any existing function.
--
-- Honor system (D9): a direct API caller can only raise their OWN mark (up to 99,999,999), or, as
-- the payer, lower others' marks down to clearing them (strictly weaker than unmark_paid, which
-- the payer already has). Both are logged with the actor.
--
-- Grants: settle_difference is security definer (it writes bill_participants, which clients can't
-- write) with an empty search_path; execute revoked from public and anon, granted to
-- authenticated. No table grant or constraint changes. Columns clients can't read: none changed
-- (bills and bill_participants keep table-level SELECT for authenticated, nothing for anon).

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
    'paid_difference', 'paid_back'
  ));

-- ---------------------------------------------------------------------------
-- public.settle_difference
-- ---------------------------------------------------------------------------
create function public.settle_difference(
  p_bill_id uuid,
  p_user_id uuid,
  p_payer_id uuid,
  p_expected_cents integer,
  p_new_cents integer
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

  select bp.settled_at is not null, bp.settled_cents into v_marked, v_cents
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

  if p_new_cents >= 1 then
    update public.bill_participants as bp
    set settled_cents = p_new_cents
    where bp.bill_id = p_bill_id and bp.user_id = p_user_id;
  else
    update public.bill_participants as bp
    set settled_at = null, settled_cents = null
    where bp.bill_id = p_bill_id and bp.user_id = p_user_id;
  end if;

  if v_more then
    perform private.log_event(
      p_bill_id, v_uid, 'paid_difference', null,
      jsonb_build_object('payer_id', v_payer, 'from', p_expected_cents, 'to', p_new_cents)
    );
  else
    perform private.log_event(
      p_bill_id, v_uid, 'paid_back', null,
      jsonb_build_object('user_id', p_user_id, 'from', p_expected_cents, 'to', p_new_cents)
    );
  end if;
end;
$$;

revoke execute on function public.settle_difference(uuid, uuid, uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.settle_difference(uuid, uuid, uuid, integer, integer)
  to authenticated;

comment on function public.settle_difference(uuid, uuid, uuid, integer, integer) is
  'Records a difference on a mark (spec 2026-11-25 settle early, D4): the person raises their own '
  'mark (paid more) or the payer lowers it (paid back; 0 clears the mark). p_expected_cents is the '
  'stale-state token; an identical retry is a no-op.';
