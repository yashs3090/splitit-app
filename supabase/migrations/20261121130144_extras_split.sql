-- M1b + M2, Task 18: the bill's extras split mode and the host-only set_extras_split.
-- Spec: docs/specs/2026-11-20-m1b-m2-share-and-claim.md (A1.7, A2.1, design decision 9,
-- Functions table, criteria 143-147).
--
-- bill_events.kind already allows 'extras_split_changed' (added up front in
-- 20261121080352_bill_events.sql), so no constraint change is needed here.
--
-- Event written: kind 'extras_split_changed', actor = the host, item_name null,
--   details { "before": 'proportional' | 'equal', "after": 'proportional' | 'equal' }
-- which is the shape lib/activityText.ts reads.

-- ---------------------------------------------------------------------------
-- Column. A constant default doesn't rewrite the table (Postgres 11+).
-- ---------------------------------------------------------------------------
alter table public.bills
  add column extras_split text not null default 'proportional'
    constraint bills_extras_split_known check (extras_split in ('proportional', 'equal'));

comment on column public.bills.extras_split is
  'How tax, tip, fees and bill-level discounts are allocated: proportional (default) or equal.';

-- authenticated already has table-level SELECT on bills (so fetchBill can read the new column)
-- and no UPDATE; this column is written only by set_extras_split. Restated for clarity.
revoke all on public.bills from anon, authenticated, public;
grant select on public.bills to authenticated;

-- ---------------------------------------------------------------------------
-- public.set_extras_split
-- ---------------------------------------------------------------------------
-- security definer: clients have no UPDATE on bills, and log_event isn't client-executable.
-- No user, not the host, or no such bill: 42501 not_allowed (the same error, so a non-host
-- can't probe which bill ids exist). Unknown mode: 22023 invalid_mode. Same mode again: no-op
-- (no update, so no broadcast; no event). The update fires the existing bills_broadcast_update
-- trigger. edited_at is left alone: Activity shows the change, not the "updated the bill" notice.
create function public.set_extras_split(p_bill_id uuid, p_mode text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_current text;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  -- Lock the row so two concurrent changes log a correct before/after each.
  select b.extras_split into v_current
  from public.bills as b
  where b.id = p_bill_id and b.host_id = v_uid
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if p_mode is null or p_mode not in ('proportional', 'equal') then
    raise exception using errcode = '22023', message = 'invalid_mode';
  end if;

  if p_mode = v_current then
    return;
  end if;

  update public.bills as b set extras_split = p_mode where b.id = p_bill_id;

  perform private.log_event(
    p_bill_id, v_uid, 'extras_split_changed', null,
    jsonb_build_object('before', v_current, 'after', p_mode)
  );
end;
$$;

revoke execute on function public.set_extras_split(uuid, text) from public, anon, authenticated;
grant execute on function public.set_extras_split(uuid, text) to authenticated;
