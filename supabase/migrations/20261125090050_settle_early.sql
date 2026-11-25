-- Settle early, Task 1 (spec docs/specs/2026-11-25-settle-early-and-differences.md, Amendment A1;
-- D2 contract E, D3, D10; criteria 1-6). Earlier migrations are applied and are not edited.
--
--   private.settle_state(bill, user)  rule E: 'all_zero' | 'final' | 'early' | 'not_complete'
--   private.bill_all_zero(bill)       rule Z (true exactly when settle_state says 'all_zero')
--   public.mark_paid                  re-created (same signature and grants) with the D3 order
--
-- Rule E (D2), for bill B and user U:
--   itemSum = sum of total_cents of B's kind = 'item' rows; rowSum = sum over all B's rows
--   (discount rows are negative); extras = bills.total_cents - rowSum. All three are bigint (sum()
--   of an integer column is bigint) and nothing casts them back to integer: 500 rows x 9,999,999
--   overflows int4.
--   allZero = extras_split = 'proportional' and itemSum = 0 and extras <> 0
--   complete = every line_items row of B has at least one claim (C1, same as bill_is_complete)
--   hasItemClaim = U has a claim on a kind = 'item' row of B (parts >= 1 always, claims_parts_range)
--   settle_state = 'all_zero' if allZero; else 'final' if complete; else 'early' if proportional
--   and hasItemClaim; else 'not_complete'. Null for a bill that doesn't exist.
-- settle_state is ONE language sql statement (CTEs), so all its reads see one snapshot. In plpgsql
-- under READ COMMITTED each select takes a new snapshot, and a claim committing between two of
-- them could give an answer that matches no real state. bill_all_zero is defined through
-- settle_state, so the two can't drift apart.
--
-- K6 closed (SE-3): a proportional bill whose rows are all $0.00 with a total > 0 is complete
-- (bill_is_complete, unchanged) but settle_state says 'all_zero', so mark_paid now refuses it with
-- 22023 all_zero, matching lib/settle.ts (blocked_all_zero). Existing marks are not touched.
--
-- mark_paid check order (D3; the app's error mapping relies on it):
--   0 signed out                                                    42501 not_allowed
--   1 caller not a participant of an existing bill (plain read, NO lock; R4 rule)
--                                                                   42501 not_allowed
--   2 bills row FOR SHARE, participation re-checked under the lock  42501 not_allowed
--   3 p_cents null or outside 1..99,999,999 (C2)                    22023 invalid_amount
--   4 p_payer_id isn't the current payer                            22023 payer_changed
--   5 caller is the payer                                           22023 is_payer
--   6 settle_state (one call) = 'all_zero'                          22023 all_zero
--   7 settle_state not 'final' / 'early'                            22023 not_complete
--   8 already marked: no-op, no event (the first mark wins; differences go through
--     settle_difference)
--   9 settled_at = now(), settled_cents = p_cents; one marked_paid { payer_id, cents } event,
--     actor = caller (details unchanged)
--
-- Lock order of mark_paid (D10), explicit and implicit, in the order taken:
--   0 none         participation read on bill_participants (step 1)
--   1 FOR SHARE    bills row (step 2). Serializes with set_payer, update_bill, set_extras_split,
--                  remove_participant, leave_bill (they take FOR UPDATE on bills)
--   2 none         line_items, claims (settle_state, one call). set_claim takes FOR KEY SHARE on
--                  bills, which doesn't conflict with FOR SHARE, so rule E can be one claim out of
--                  date; harmless (the same as "Sam unclaimed after paying", W3)
--   3 FOR NO KEY UPDATE (implicit) the caller's bill_participants row, taken by the conditional
--                  UPDATE (settled_at / settled_cents aren't key columns). Serializes with
--                  unmark_paid, settle_difference and a second mark_paid; doesn't conflict with
--                  the FOR KEY SHARE a claim's foreign key takes on the same row
--   4 FOR KEY SHARE (implicit) bills row (already held, compatible) through
--                  bill_events_bill_id_fkey, and the caller's profiles row through
--                  bill_events_actor_id_fkey, both from the private.log_event insert. The profiles
--                  lock conflicts only with account deletion (the existing M3 R9 gap, in
--                  docs/before-production.md)
--   5 none         statement-level bill_participants_broadcast_update -> one Realtime message
-- Bill row first, then participant row, then the event insert: the same direction as every other
-- path (20261124094656_people_review_fixes.sql). No cycle with any existing function.
--
-- Grants: unchanged. bill_all_zero and settle_state are not executable by public, anon or
-- authenticated (they are only called from security definer functions, as their owner).
-- mark_paid: execute for authenticated only (restated below).
-- Columns clients can't read: none changed (bills and bill_participants keep table-level SELECT
-- for authenticated, nothing for anon).

-- ---------------------------------------------------------------------------
-- private.settle_state (rule E)
-- ---------------------------------------------------------------------------
-- security invoker, like private.bill_is_complete: it reads past RLS only when called from a
-- security definer function (as postgres); no client role may execute it.
create function private.settle_state(p_bill_id uuid, p_user_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  with bill as (
    select b.total_cents::bigint as total_cents, b.extras_split
    from public.bills as b
    where b.id = p_bill_id
  ),
  item_rows as (
    select
      li.kind,
      li.total_cents,
      exists (select 1 from public.claims as c where c.line_item_id = li.id) as claimed,
      exists (
        select 1 from public.claims as c
        where c.line_item_id = li.id and c.user_id = p_user_id
      ) as mine
    from public.line_items as li
    where li.bill_id = p_bill_id
  ),
  sums as (
    select
      coalesce(sum(r.total_cents) filter (where r.kind = 'item'), 0) as item_sum,
      coalesce(sum(r.total_cents), 0) as row_sum,
      coalesce(bool_and(r.claimed), true) as complete,
      coalesce(bool_or(r.mine and r.kind = 'item'), false) as has_item_claim
    from item_rows as r
  )
  select case
    when bill.extras_split = 'proportional'
         and s.item_sum = 0
         and bill.total_cents - s.row_sum <> 0 then 'all_zero'
    when s.complete then 'final'
    when bill.extras_split = 'proportional' and s.has_item_claim then 'early'
    else 'not_complete'
  end
  from bill cross join sums as s;
$$;

revoke execute on function private.settle_state(uuid, uuid) from public, anon, authenticated;

comment on function private.settle_state(uuid, uuid) is
  'Rule E (spec 2026-11-25 settle early, D2): all_zero | final | early | not_complete for this '
  'user on this bill; null if the bill does not exist. One SQL statement (one snapshot), bigint '
  'sums. Same rule as maySettle in lib/settle.ts.';

-- ---------------------------------------------------------------------------
-- private.bill_all_zero (rule Z)
-- ---------------------------------------------------------------------------
-- 'all_zero' is settle_state's first branch and doesn't depend on the user, so asking with a null
-- user answers rule Z alone. False for a bill that doesn't exist.
create function private.bill_all_zero(p_bill_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(private.settle_state(p_bill_id, null) = 'all_zero', false);
$$;

revoke execute on function private.bill_all_zero(uuid) from public, anon, authenticated;

comment on function private.bill_all_zero(uuid) is
  'Rule Z (spec 2026-11-25 settle early, D2): proportional, every item row $0.00, and the bill '
  'total differs from the sum of its rows. Same rule as allZero in lib/settle.ts.';

-- ---------------------------------------------------------------------------
-- public.mark_paid (D3)
-- ---------------------------------------------------------------------------
create or replace function public.mark_paid(p_bill_id uuid, p_payer_id uuid, p_cents integer)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_payer uuid;
  v_state text;
  v_updated integer;
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
  set settled_at = now(), settled_cents = p_cents
  where bp.bill_id = p_bill_id and bp.user_id = v_uid and bp.settled_at is null;
  get diagnostics v_updated = row_count;

  if v_updated > 0 then
    perform private.log_event(
      p_bill_id, v_uid, 'marked_paid', null,
      jsonb_build_object('payer_id', v_payer, 'cents', p_cents)
    );
  end if;
end;
$$;

revoke execute on function public.mark_paid(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.mark_paid(uuid, uuid, integer) to authenticated;
