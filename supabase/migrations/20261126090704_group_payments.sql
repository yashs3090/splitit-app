-- Groups MVP, Task T4: payments between members (spec docs/specs/2026-11-26-groups-mvp.md T4 as
-- amended by Amendment A1 (A1.2 / B2a, A1.6 / S3) and Amendment A2 (A2.1, A2.3), plus GR-M6
-- (undone_reason); C-G7, C-G9, C-G10; criteria 22-24, 31 (payment part), 34, 101, 115, 116;
-- decisions GR-T4-... in docs/decisions-to-review.md). Earlier migrations are applied and are not
-- edited. Needs private.is_payment_method from 20261126080844_sent_via_venmo.sql.
--
--   public.group_payments   one payment between two members; id client-generated; soft undo
--   public.record_payment(p_id, p_group_id, p_from, p_to, p_cents, p_method, p_source)
--   public.undo_payment(p_id)
--   public.leave_group(p_group_id)   re-created from T3's version: adds the payment history
--                                    check (C-G10) before the membership delete
--
-- ===========================================================================================
-- Rules shared with lib/ (lib/groups.ts recordPayment / isAllowedPaymentPair, lib/paylinks.ts
-- isSettleCents, lib/paymentMethods.ts isPaymentMethod)
-- ===========================================================================================
-- cents:  integer 1..99,999,999 (rule C2).
-- method: how the money was sent; private.is_payment_method (venmo | cash | other). Never
--         spelled out here.
-- source: how the record was made: 'venmo_link' | 'manual' | 'bill_mark'. Clients may send only
--         'venmo_link' or 'manual'; 'bill_mark' rows are written by T5's attach_bill_to_group.
-- Allowed pairs (A2.1; lib isAllowedPaymentPair): venmo_link -> method venmo only; manual -> any
--         method; bill_mark -> any method. The table check repeats the pair rule.
-- Parties: from_user <> to_user, both current members, and the caller is one of them.
-- Retry (A1.6): same id + same (group, from, to, cents, method, source) recorded by the same
--         caller -> success, no write, no event; it stays undone if it was undone. Same id with
--         anything else -> 22023 id_conflict.
-- Undo (C-G9, A2.2, GR-M6): from_user or to_user. undone_reason is decided by who undoes:
--         the recipient (to_user) -> 'not_received' ("Not received"); the sender (from_user) ->
--         'sender' ("Didn't go through? Undo"). Same rule as lib/groupActivityText.ts, which
--         reads an undo by `to` as "didn't receive". A repeat -> no-op (first reason kept).
--
-- ===========================================================================================
-- LOCK ORDER (rule in 20261126082511_groups.sql; A1.2 / criterion 34)
-- ===========================================================================================
-- Money writes take NO explicit group lock and no membership lock (rule (a)).
--   record_payment  0. checks (no lock): signed out; caller membership -> 42501; id; cents;
--                      method/source; from <> to; caller is a party -> 42501; parties'
--                      membership -> not_member.
--                   1. INSERT group_payments ON CONFLICT (id) DO NOTHING: FKs (group_id,
--                      from_user), (group_id, to_user), (group_id, recorded_by) -> KEY SHARE on
--                      those group_members rows (recorded_by is one of the two). No bill_id from
--                      clients, so no bills lock. On a retry it waits for a concurrent insert of
--                      the same id, then reads it.
--                   2. INSERT group_events (private.log_group_event): KEY SHARE on the group row
--                      (compatible with the NO KEY UPDATE that membership functions hold) and on
--                      the caller's profile.
--                   A 23503 in 1 (a party left after step 0) -> 22023 not_member.
--   undo_payment    0. checks (no lock): signed out; the payment exists, the caller is from or
--                      to and a member of its group -> else 42501 not_allowed (one answer).
--                   1. SELECT group_payments ... FOR NO KEY UPDATE (the UPDATE changes no key
--                      column). Conflicts only with a concurrent undo of the same payment (and
--                      T5's bill-delete set-null on bill_id).
--                   2. already undone -> no-op. 3. UPDATE undone_at / undone_by / undone_reason
--                      (no FK column changes, so no new FK locks). 4. INSERT group_events.
--   leave_group     as in 20261126085945_group_expenses.sql, with the payment history check
--                   (from, to or recorder, undone included) added to step 3 after the expense
--                   checks, still before the $0 share delete and the membership delete. The
--                   membership delete (FOR UPDATE on that one group_members row) waits for any
--                   record_payment holding KEY SHARE on it; if that payment committed, the
--                   restrict FK fails with 23503 -> 22023 cannot_leave (the B2a worked example in
--                   the T2 header, with record_payment in place of edit_expense). T5 re-creates it
--                   again with the bill locks.
--
-- ===========================================================================================
-- Columns clients can't read
-- ===========================================================================================
-- None: members hold table-level SELECT on group_payments (every column, undone rows included,
-- so select('*') works for members). Rows of groups the caller isn't in are hidden by RLS (0
-- rows). No client role has INSERT, UPDATE or DELETE; service_role's INSERT/UPDATE/DELETE/
-- TRUNCATE are revoked as well (nothing legitimate writes payments outside these functions and
-- T5's attach; functions run as their owner).
--
-- ===========================================================================================
-- Errors
-- ===========================================================================================
--   42501 not_allowed     signed out; not a member of the group (or no such group / payment: same
--                         answer); record by a member who is neither from nor to; undo by anyone
--                         but from or to
--   42501 permission denied  anon executing any function; any direct table write
--   22023 invalid_id      record_payment with p_id null
--   22023 invalid_amount  cents null or outside 1..99,999,999
--   22023 invalid_payment from or to null, from = to, an unknown method, an unknown source,
--                         source 'bill_mark' from a client, or a pair A2.1 doesn't allow
--   22023 not_member      from or to isn't a current member of the group
--   22023 id_conflict     the id exists with other content, another group or another recorder
--   22023 cannot_leave    leave_group: from, to or recorder of any payment (undone included)
--
-- Events (group_events; kinds already in group_events_kind_known from T2):
--   payment_recorded {payment_id, from, to, cents, method, source}   actor = recorded_by
--   payment_undone   {payment_id, undone_reason}                     actor = undone_by
--   (The amount and parties of an undone payment are in its payment_recorded event and its row;
--   they're not repeated. undone_reason lets Activity word it without inferring, GR-M6.)

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table public.group_payments (
  -- Client-generated (A1.6): the retry key for record_payment.
  id uuid primary key,
  group_id uuid not null,
  from_user uuid not null,
  to_user uuid not null,
  cents integer not null
    constraint group_payments_cents_range check (cents between 1 and 99999999),
  method text not null
    constraint group_payments_method_known check (private.is_payment_method(method)),
  source text not null
    constraint group_payments_source_known check (source in ('venmo_link', 'manual', 'bill_mark')),
  recorded_by uuid not null,
  -- Set only for source 'bill_mark' (T5: the bill whose mark became this payment). Set null if
  -- that bill is ever deleted; the payment stays.
  bill_id uuid references public.bills (id) on delete set null,
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  undone_by uuid,
  undone_reason text,
  constraint group_payments_parties_differ check (from_user <> to_user),
  constraint group_payments_pair_allowed check (source <> 'venmo_link' or method = 'venmo'),
  constraint group_payments_bill_only_for_marks check (bill_id is null or source = 'bill_mark'),
  constraint group_payments_recorded_by_party check (recorded_by in (from_user, to_user)),
  constraint group_payments_undone_all_or_none check (
    (undone_at is null) = (undone_by is null) and (undone_at is null) = (undone_reason is null)),
  constraint group_payments_undone_by_party check (undone_by is null or undone_by in (from_user, to_user)),
  -- GR-M6: the reason follows who undid it.
  constraint group_payments_undone_reason check (
    undone_reason is null
    or (undone_reason = 'not_received' and undone_by = to_user)
    or (undone_reason = 'sender' and undone_by = from_user)),
  -- on delete restrict (C-G10, S8): payment history blocks leaving and account deletion.
  -- undone_by is from or to (check above), so it needs no FK of its own.
  constraint group_payments_from_member_fkey foreign key (group_id, from_user)
    references public.group_members (group_id, user_id) on delete restrict,
  constraint group_payments_to_member_fkey foreign key (group_id, to_user)
    references public.group_members (group_id, user_id) on delete restrict,
  constraint group_payments_recorder_member_fkey foreign key (group_id, recorded_by)
    references public.group_members (group_id, user_id) on delete restrict
);

comment on table public.group_payments is
  'Groups MVP (ADR 0022) payments between members. Written only by record_payment / undo_payment '
  '(and T5''s attach_bill_to_group for bill_mark rows); members read.';

-- Snapshot order (T6) and the restrict FKs' lookups when a membership row is deleted.
create index group_payments_group_created_idx on public.group_payments (group_id, created_at, id);
create index group_payments_group_from_idx on public.group_payments (group_id, from_user);
create index group_payments_group_to_idx on public.group_payments (group_id, to_user);
create index group_payments_group_recorder_idx on public.group_payments (group_id, recorded_by);
create index group_payments_bill_id_idx on public.group_payments (bill_id) where bill_id is not null;
-- T6's not_received list (GR-M6): recipient-undone payments of a group, recent first.
create index group_payments_not_received_idx on public.group_payments (group_id, undone_at desc)
  where undone_reason = 'not_received';

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------
alter table public.group_payments enable row level security;

revoke all on public.group_payments from anon, authenticated, public;
revoke insert, update, delete, truncate on public.group_payments from service_role;

grant select on public.group_payments to authenticated;

create policy "group_payments_select_member"
  on public.group_payments
  for select
  to authenticated
  using (private.is_group_member(group_id));

-- ---------------------------------------------------------------------------
-- public.record_payment (C-G7 as amended by A2.1)
-- ---------------------------------------------------------------------------
-- Check order: signed out / not a member -> 42501; p_id -> invalid_id; cents -> invalid_amount;
-- method, source, pair, from/to null or equal -> invalid_payment; caller not a party -> 42501;
-- a party not a member -> not_member; then the insert (retry or id_conflict).
create function public.record_payment(
  p_id uuid,
  p_group_id uuid,
  p_from uuid,
  p_to uuid,
  p_cents bigint,
  p_method text,
  p_source text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
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
  if p_cents is null or p_cents not between 1 and 99999999 then
    raise exception using errcode = '22023', message = 'invalid_amount';
  end if;
  if p_method is null or not private.is_payment_method(p_method)
     or p_source is null or p_source not in ('venmo_link', 'manual')
     or (p_source = 'venmo_link' and p_method <> 'venmo')
     or p_from is null or p_to is null or p_from = p_to then
    raise exception using errcode = '22023', message = 'invalid_payment';
  end if;
  if v_uid not in (p_from, p_to) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  if (select count(*) from public.group_members as gm
      where gm.group_id = p_group_id and gm.user_id in (p_from, p_to)) <> 2 then
    raise exception using errcode = '22023', message = 'not_member';
  end if;

  begin
    insert into public.group_payments
      (id, group_id, from_user, to_user, cents, method, source, recorded_by)
    values (p_id, p_group_id, p_from, p_to, p_cents::integer, p_method, p_source, v_uid)
    on conflict (id) do nothing
    returning id into v_inserted;
  exception when foreign_key_violation then
    -- A party left after the checks above.
    raise exception using errcode = '22023', message = 'not_member';
  end;

  if v_inserted is null then
    -- The id exists: a retry (stays as it is, undone included), or a clash.
    if exists (
      select 1 from public.group_payments as gp
      where gp.id = p_id
        and gp.group_id = p_group_id
        and gp.from_user = p_from
        and gp.to_user = p_to
        and gp.cents = p_cents
        and gp.method = p_method
        and gp.source = p_source
        and gp.recorded_by = v_uid
    ) then
      return;
    end if;
    raise exception using errcode = '22023', message = 'id_conflict';
  end if;

  perform private.log_group_event(p_group_id, v_uid, 'payment_recorded',
    jsonb_build_object('payment_id', p_id, 'from', p_from, 'to', p_to, 'cents', p_cents,
                       'method', p_method, 'source', p_source));
end;
$$;

-- ---------------------------------------------------------------------------
-- public.undo_payment (C-G9, A2.2, GR-M6)
-- ---------------------------------------------------------------------------
-- from_user or to_user, while a member (they always are: the restrict FKs keep them in). Soft:
-- the row stays with undone_at / undone_by / undone_reason. A repeat -> no-op.
create function public.undo_payment(p_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.group_payments%rowtype;
  v_reason text;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  -- Who may act, before any lock.
  if not exists (
    select 1 from public.group_payments as gp
    where gp.id = p_id
      and v_uid in (gp.from_user, gp.to_user)
      and exists (
        select 1 from public.group_members as gm
        where gm.group_id = gp.group_id and gm.user_id = v_uid
      )
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  select * into v_row from public.group_payments as gp where gp.id = p_id for no key update;

  if v_row.undone_at is not null then
    return; -- repeat: no-op, the first reason stays
  end if;

  v_reason := case when v_uid = v_row.to_user then 'not_received' else 'sender' end;

  update public.group_payments as gp
  set undone_at = now(), undone_by = v_uid, undone_reason = v_reason
  where gp.id = p_id;

  perform private.log_group_event(v_row.group_id, v_uid, 'payment_undone',
    jsonb_build_object('payment_id', p_id, 'undone_reason', v_reason));
end;
$$;

-- ---------------------------------------------------------------------------
-- public.leave_group (re-created from 20261126085945_group_expenses.sql; C-G10 payments)
-- ---------------------------------------------------------------------------
-- T3's version plus, under the group lock and after the expense checks: refused (cannot_leave)
-- when the caller is from_user, to_user or recorded_by of any payment of the group, undone ones
-- included (history never disappears). Everything else is unchanged. T5 re-creates it again.
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
  -- (d) step 5 (T5): the caller's participant rows on the group's bills.

  perform private.log_group_event(p_group_id, v_uid, 'member_left', '{}'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Execute grants: authenticated only (create or replace keeps leave_group's; restated)
-- ---------------------------------------------------------------------------
revoke execute on function public.record_payment(uuid, uuid, uuid, uuid, bigint, text, text)
  from public, anon, authenticated;
revoke execute on function public.undo_payment(uuid) from public, anon, authenticated;
revoke execute on function public.leave_group(uuid) from public, anon, authenticated;

grant execute on function public.record_payment(uuid, uuid, uuid, uuid, bigint, text, text) to authenticated;
grant execute on function public.undo_payment(uuid) to authenticated;
grant execute on function public.leave_group(uuid) to authenticated;
