-- Who paid, Task 4b: several payers (spec docs/specs/2026-11-26-who-paid.md D1 contract W, D5 rule
-- E', Amendment A1.2 contract M and A1.3 "(4b)" rows and "Other DB changes"; engineering review
-- B3, B4, B5(e)-(g), S8, S9, S13, S17, N6, N10). Builds on 20261127140000_bill_payments.sql and
-- 20261127140001_bill_payments_functions.sql (apply all three in one `supabase migration up`).
-- Earlier migrations are applied and are not edited.
--
--   public.bill_payers            split-mode amounts (contract W). One-person bills have no rows.
--   private.bill_payer_ids(bill)  redefined: the bill_payers users in split mode, else payer_id.
--   private.payers_valid(bill)    redefined: true in one-person mode; in split mode
--                                 sum(paid_cents) = bills.total_cents exactly (tolerance 0, WP-11).
--   private.settle_state          re-created from 20261125090050_settle_early.sql lines 77-125 with
--                                 rule E': a split bill that isn't complete -> 'not_complete'.
--   private.payers_json(bill)     the payer set as [{user_id, cents}], lead first (event details).
--   private.payments_moved(...)   contract M: pairs with net > 0 whose to_user leaves the set.
--   public.set_payers             new (D1's check order; A1.3: no token, step 1b in_group, N10).
--   public.set_payer              the 3-arg version is dropped; (p_bill_id, p_payer_id) clears no
--                                 payment (ledger), deletes flags to anyone not in the new set,
--                                 and logs payers_changed.
--   private.bill_participants_reset_payer  re-created (still BEFORE DELETE, B3): a deleted payer
--                                 (account deletion) -> one person = the host; that person's
--                                 entries and flags are lost (counted), everyone else's kept.
--   public.attach_bill_to_group   re-created from 20261127140001 with 22023 split_paying (B5f).
--   bill_events_kind_known        the 24 kinds of 20261127062139_assign_item.sql plus
--                                 payers_changed (B5g).
--
-- Because mark_paid, settle_difference and private.is_removable (20261127140001) call
-- private.bill_payer_ids / private.payers_valid / private.settle_state, redefining those three
-- gives them the split-mode behaviour: "p_payer_id in the payer set" (payer_changed), the
-- payers_stale check (after is_payer / the direction check, before all_zero; S8), rule E', and L3
-- "not in the payer set". They are not re-created here.
--
-- ===========================================================================================
-- Contract W, stored
-- ===========================================================================================
-- One person <=> no bill_payers rows: bills.payer_id paid the whole bill (amount = the current
-- total, never stored). Split <=> 2..50 rows; exactly one row is never written (set_payers refuses
-- it; set_payer and the reset trigger delete all rows). bills.payer_id = the lead: the largest
-- paid_cents, ties to the lower user_id (uuid byte order = lib's JS string order on lowercase
-- ids). Stale (split only): sum(paid_cents) <> total_cents, e.g. after update_bill changed the
-- total; mark_paid and settle_difference then refuse with 22023 payers_stale.
--
-- ===========================================================================================
-- set_payers(p_bill_id, p_payers jsonb) check order (lesson 2026-11-25: the order decides the error)
-- ===========================================================================================
--   0  signed out                                                   42501 not_allowed
--   1  bills row FOR UPDATE where host_id = caller; none            42501 not_allowed (one answer)
--   1b the bill is in a group (B5e; group bills keep one payer)     22023 in_group
--   2  p_payers not a JSON array of 2..50 objects each with a string user_id and a paid_cents key;
--      a user_id that doesn't cast to uuid; a duplicate user after the cast (N10)
--                                                                   22023 invalid_payers
--   3  any paid_cents not a JSON integer in 1..99,999,999 (private.jsonb_int_between: "6000" (a
--      string), 60.5, 6000.0 are refused; S9)                      22023 invalid_amount
--   4  any user not a participant                                   22023 not_participant
--   5  sum <> bills.total_cents                                     22023 payers_total
--   6  no-op: already split with exactly these users and amounts: no write, no event, no broadcast
--   7  replace the rows; payer_id = the lead; delete flags whose to_user isn't in the new set; one
--      payers_changed { before, after, moved }. Nothing in bill_payments is deleted (ledger).
-- Note (S9): jsonb normalizes numbers on input, so 6e3 arrives as 6000 and is accepted as 6000;
-- the original text isn't recoverable from jsonb. JSON.parse('6e3') is 6000 in lib too.
--
-- set_payer(p_bill_id, p_payer_id):
--   0 signed out / 1 not the host (bills FOR UPDATE)                42501 not_allowed
--   2 p_payer_id null or not a participant                          22023 not_participant
--   3 no-op: one-person bill already paid by p_payer_id (from split mode it is never a no-op, even
--     to the lead)
--   4 delete the bill_payers rows; payer_id = p_payer_id; delete flags whose to_user <> p_payer_id;
--     one payers_changed { before, after, moved }. Clears no payment.
--
-- ===========================================================================================
-- Event details (lib/activityText.ts parses them; WP-37)
-- ===========================================================================================
--   payers_changed { before: [{user_id, cents}], after: [{user_id, cents}],
--                    moved: [{from_user, to_user, cents}], lost?: int }
--     before / after: lead first (cents desc, user_id asc); a one-person side is one entry with
--     cents = the bill total at that moment. moved (contract M): every pair with contract P
--     net > 0 whose to_user was in the old payer set and isn't in the new one, ordered by
--     (from_user, to_user); cents = that net. lost: only from the reset trigger (account deletion):
--     the number of bill_payments entries deleted with the person.
--     actor = the host, or null for account deletion.
--   Old payer_changed events stay valid (the kind stays in the list).
--
-- ===========================================================================================
-- Lock order (bills row first; implicit locks listed)
-- ===========================================================================================
-- set_payers / set_payer:
--   1 FOR UPDATE         bills row (serializes with every mark path's FOR SHARE)
--   2 none               bill_participants / bill_payers reads
--   3 row locks          delete / insert bill_payers (the insert's deferred FK check takes FOR
--                        KEY SHARE on each payer's participant row at commit)
--   4 FOR NO KEY UPDATE  bills row (held) by the payer_id UPDATE (only when the lead changes)
--   5 row locks          delete bill_payment_flags rows
--   6 FOR KEY SHARE      bills row (held) and the caller's profiles row (log_event)
--   7 none               statement broadcasts (ledger: one hint per bill per statement; bills:
--                        one when payer_id changed)
-- bill_participants_reset_payer (BEFORE DELETE, account deletion): the deleting statement holds
--   the participant row; then FOR UPDATE bills; then the deletes of that person's bill_payments /
--   bill_payment_flags, of bill_payers, the bills UPDATE, the remaining flag deletes, the event
--   insert. S17: participant then bill is the reverse of set_payers / mark_paid (bill, then
--   key-share participants), the M3 R9 account-deletion class widened; docs/before-production.md.
-- attach_bill_to_group: unchanged (20261127140001); the split_paying check is a read under the
--   bills lock.
--
-- ===========================================================================================
-- Grants, RLS, columns clients can't read
-- ===========================================================================================
-- bill_payers: RLS on; one SELECT policy for authenticated (participants, N6); revoke all from
-- anon, authenticated, public, service_role; grant SELECT to authenticated. No client role writes
-- it (42501); anon can't select (42501). Columns clients can't read: none.
-- Every created or re-created function: execute revoked from public, anon, authenticated; granted
-- to authenticated only for set_payers / set_payer / attach_bill_to_group. The private helpers
-- are executable by no client role.
--
-- Direct API callers (honor system, recorded): the host can set any valid split (checked like the
-- UI, logged). Marks stay self-reported per pair (ADR 0015); a caller can stamp any well-formed
-- plan key (it can only re-plan routes; money stays exact); an ex-payer can pay back on a pair
-- they received. Nobody writes bill_payers, bill_payments or bill_payment_flags except through
-- these functions.
--
-- ===========================================================================================
-- Rollback (S13): LOSSY. Collapse each split bill to its lead (delete its bill_payers rows; payer_id
-- already is the lead), keep every ledger entry, drop set_payers, re-create set_payer(uuid, uuid,
-- integer), the reset trigger body, settle_state, attach and the two helpers from
-- 20261127140001 / 20261125090050, restore the 24-kind list, then drop bill_payers. Split amounts
-- are lost. Before production: snapshot the hosted DB before the push.
-- ===========================================================================================

-- Explicit transaction, like 20261127140000 / 140001. CLI 3.2.0 adds no BEGIN/COMMIT (its own
-- 25P01 hint says so): without a block it sends the file and its schema_migrations row in one
-- implicit transaction, which is atomic but is not a transaction block, so LOCK TABLE and the like
-- would fail. With this block, everything between begin and commit commits or rolls back together;
-- the CLI then records the version in its own transaction just after the commit.
begin;

-- ---------------------------------------------------------------------------
-- public.bill_payers (D1, B4)
-- ---------------------------------------------------------------------------
create table public.bill_payers (
  bill_id uuid not null references public.bills (id) on delete cascade,
  user_id uuid not null,
  paid_cents integer not null
    constraint bill_payers_paid_cents_range check (paid_cents between 1 and 99999999),
  primary key (bill_id, user_id),
  -- Invariant P for every payer: the same mechanism as bills_payer_participant_fkey (deferred, no
  -- cascade; the reset trigger deletes the rows on account deletion).
  constraint bill_payers_participant_fkey foreign key (bill_id, user_id)
    references public.bill_participants (bill_id, user_id)
    deferrable initially deferred
);

comment on table public.bill_payers is
  'Split-mode amounts (who-paid contract W): who paid the restaurant and how much. No rows = one '
  'person (bills.payer_id paid the whole total). Written only by set_payers / set_payer and the '
  'payer-reset trigger.';

alter table public.bill_payers enable row level security;
revoke all on public.bill_payers from anon, authenticated, public, service_role;
grant select on public.bill_payers to authenticated;

create policy bill_payers_select_participant on public.bill_payers
  for select to authenticated
  using (private.is_bill_participant(bill_id));

create trigger bill_payers_broadcast_insert
  after insert on public.bill_payers
  referencing new table as new_rows
  for each statement
  execute function private.broadcast_bill_ledger_change();
create trigger bill_payers_broadcast_update
  after update on public.bill_payers
  referencing new table as new_rows
  for each statement
  execute function private.broadcast_bill_ledger_change();
create trigger bill_payers_broadcast_delete
  after delete on public.bill_payers
  referencing old table as old_rows
  for each statement
  execute function private.broadcast_bill_ledger_change();

-- ---------------------------------------------------------------------------
-- Activity kinds (B5g): the latest list on disk (24) plus payers_changed
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
    'moved_to_group', 'removed_from_group',
    'assigned', 'unassigned',
    'payers_changed'
  ));

-- ---------------------------------------------------------------------------
-- Helpers (invoker, no client role)
-- ---------------------------------------------------------------------------
create or replace function private.bill_payer_ids(p_bill_id uuid)
returns setof uuid
language sql
stable
set search_path = ''
as $$
  select bp.user_id from public.bill_payers as bp where bp.bill_id = p_bill_id
  union all
  select b.payer_id from public.bills as b
  where b.id = p_bill_id
    and not exists (select 1 from public.bill_payers as bp where bp.bill_id = p_bill_id);
$$;

revoke execute on function private.bill_payer_ids(uuid) from public, anon, authenticated;

create or replace function private.payers_valid(p_bill_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select not exists (select 1 from public.bill_payers as bp where bp.bill_id = p_bill_id)
    or (select sum(bp.paid_cents)::bigint from public.bill_payers as bp where bp.bill_id = p_bill_id)
       = (select b.total_cents::bigint from public.bills as b where b.id = p_bill_id);
$$;

revoke execute on function private.payers_valid(uuid) from public, anon, authenticated;

comment on function private.payers_valid(uuid) is
  'Contract W (who-paid D1): true for a one-person bill; for a split bill, the amounts add up to '
  'the current total exactly. False = stale (payers_stale). Same rule as payersState in '
  'lib/payers.ts.';

create function private.payers_json(p_bill_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select jsonb_agg(jsonb_build_object('user_id', bp.user_id, 'cents', bp.paid_cents)
                      order by bp.paid_cents desc, bp.user_id asc)
     from public.bill_payers as bp where bp.bill_id = p_bill_id),
    (select jsonb_build_array(jsonb_build_object('user_id', b.payer_id, 'cents', b.total_cents))
     from public.bills as b where b.id = p_bill_id)
  );
$$;

revoke execute on function private.payers_json(uuid) from public, anon, authenticated;

create function private.payments_moved(p_bill_id uuid, p_old uuid[], p_new uuid[])
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(jsonb_build_object('from_user', pr.from_user, 'to_user', pr.to_user,
                                 'cents', ps.net)
              order by pr.from_user, pr.to_user),
    '[]'::jsonb)
  from (
    select distinct e.from_user, e.to_user
    from public.bill_payments as e
    where e.bill_id = p_bill_id
      and e.to_user = any (p_old)
      and not (e.to_user = any (p_new))
  ) as pr
  cross join lateral private.pair_state(p_bill_id, pr.from_user, pr.to_user) as ps
  where ps.net > 0;
$$;

revoke execute on function private.payments_moved(uuid, uuid[], uuid[]) from public, anon, authenticated;

comment on function private.payments_moved(uuid, uuid[], uuid[]) is
  'Contract M (who-paid A1.2): pairs with net > 0 whose to_user is in p_old and not in p_new, '
  'ordered by (from_user, to_user). Same rule as paymentsMovedBy in lib/payers.ts.';

-- ---------------------------------------------------------------------------
-- private.settle_state: rule E' (D5)
-- ---------------------------------------------------------------------------
-- Rule E unchanged for one-person bills. New branch after all_zero / final: a split bill that
-- isn't complete -> 'not_complete' (no early; WP-8). Still one SQL statement (one snapshot).
create or replace function private.settle_state(p_bill_id uuid, p_user_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  with bill as (
    select b.total_cents::bigint as total_cents, b.extras_split,
           exists (select 1 from public.bill_payers as bp where bp.bill_id = b.id) as split
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
    when bill.split then 'not_complete'
    when bill.extras_split = 'proportional' and s.has_item_claim then 'early'
    else 'not_complete'
  end
  from bill cross join sums as s;
$$;

revoke execute on function private.settle_state(uuid, uuid) from public, anon, authenticated;

comment on function private.settle_state(uuid, uuid) is
  'Rule E with E'' (settle early D2; who-paid D5): all_zero | final | early | not_complete for this '
  'user on this bill; a split-paying bill is never early. Null if the bill does not exist. One SQL '
  'statement, bigint sums. Same rule as maySettle in lib/settle.ts.';

-- ---------------------------------------------------------------------------
-- public.set_payers (D1, A1.3)
-- ---------------------------------------------------------------------------
create function public.set_payers(p_bill_id uuid, p_payers jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_bill public.bills%rowtype;
  v_elem jsonb;
  v_id uuid;
  v_ids uuid[] := '{}';
  v_cents integer[] := '{}';
  v_sum bigint := 0;
  v_n integer;
  v_lead uuid;
  v_old uuid[];
  v_before jsonb;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  select b.* into v_bill
  from public.bills as b
  where b.id = p_bill_id and b.host_id = v_uid
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if v_bill.group_id is not null then
    raise exception using errcode = '22023', message = 'in_group';
  end if;

  -- Step 2: shape, uuids, duplicates (after the cast).
  if p_payers is null or jsonb_typeof(p_payers) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_payers';
  end if;
  v_n := jsonb_array_length(p_payers);
  if v_n < 2 or v_n > 50 then
    raise exception using errcode = '22023', message = 'invalid_payers';
  end if;
  for v_elem in select a.value from jsonb_array_elements(p_payers) as a loop
    if jsonb_typeof(v_elem) <> 'object'
       or jsonb_typeof(v_elem -> 'user_id') is distinct from 'string'
       or not (v_elem ? 'paid_cents') then
      raise exception using errcode = '22023', message = 'invalid_payers';
    end if;
    begin
      v_id := (v_elem ->> 'user_id')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'invalid_payers';
    end;
    if v_id = any (v_ids) then
      raise exception using errcode = '22023', message = 'invalid_payers';
    end if;
    v_ids := v_ids || v_id;
  end loop;

  -- Step 3: amounts.
  for v_elem in select a.value from jsonb_array_elements(p_payers) as a loop
    if not private.jsonb_int_between(v_elem -> 'paid_cents', 1, 99999999) then
      raise exception using errcode = '22023', message = 'invalid_amount';
    end if;
    v_cents := v_cents || (v_elem ->> 'paid_cents')::integer;
    v_sum := v_sum + (v_elem ->> 'paid_cents')::bigint;
  end loop;

  -- Step 4: everyone is on the bill.
  if exists (
    select 1 from unnest(v_ids) as u(id)
    where not exists (
      select 1 from public.bill_participants as bp
      where bp.bill_id = p_bill_id and bp.user_id = u.id
    )
  ) then
    raise exception using errcode = '22023', message = 'not_participant';
  end if;

  -- Step 5: exact sum (tolerance 0).
  if v_sum <> v_bill.total_cents::bigint then
    raise exception using errcode = '22023', message = 'payers_total';
  end if;

  -- Step 6: no-op when already split with exactly these users and amounts.
  if (select count(*) from public.bill_payers as bp where bp.bill_id = p_bill_id) = v_n
     and not exists (
       select 1 from unnest(v_ids, v_cents) as n(id, cents)
       where not exists (
         select 1 from public.bill_payers as bp
         where bp.bill_id = p_bill_id and bp.user_id = n.id and bp.paid_cents = n.cents
       )
     ) then
    return;
  end if;

  -- Step 7.
  v_before := private.payers_json(p_bill_id);
  v_old := array(select private.bill_payer_ids(p_bill_id));
  select n.id into v_lead
  from unnest(v_ids, v_cents) as n(id, cents)
  order by n.cents desc, n.id asc
  limit 1;

  delete from public.bill_payers as bp where bp.bill_id = p_bill_id;
  insert into public.bill_payers (bill_id, user_id, paid_cents)
  select p_bill_id, n.id, n.cents
  from unnest(v_ids, v_cents) as n(id, cents)
  order by n.id;

  update public.bills as b set payer_id = v_lead
  where b.id = p_bill_id and b.payer_id is distinct from v_lead;

  delete from public.bill_payment_flags as f
  where f.bill_id = p_bill_id and not (f.to_user = any (v_ids));

  perform private.log_event(
    p_bill_id, v_uid, 'payers_changed', null,
    jsonb_build_object('before', v_before,
                       'after', private.payers_json(p_bill_id),
                       'moved', private.payments_moved(p_bill_id, v_old, v_ids))
  );
end;
$$;

alter function public.set_payers(uuid, jsonb) owner to postgres;
revoke execute on function public.set_payers(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.set_payers(uuid, jsonb) to authenticated;

comment on function public.set_payers(uuid, jsonb) is
  'The host says several people paid (who-paid D1): p_payers = [{user_id, paid_cents}], 2..50 '
  'participants, amounts adding up to the bill total exactly. payer_id becomes the lead. Clears '
  'no payment; flags to anyone no longer paying are deleted. Refused on group bills.';

-- ---------------------------------------------------------------------------
-- public.set_payer (2 args; A1.3, A-11)
-- ---------------------------------------------------------------------------
drop function public.set_payer(uuid, uuid, integer);

create function public.set_payer(p_bill_id uuid, p_payer_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_current uuid;
  v_split boolean;
  v_old uuid[];
  v_before jsonb;
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

  v_split := exists (select 1 from public.bill_payers as bp where bp.bill_id = p_bill_id);
  if not v_split and p_payer_id = v_current then
    return;
  end if;

  v_before := private.payers_json(p_bill_id);
  v_old := array(select private.bill_payer_ids(p_bill_id));

  delete from public.bill_payers as bp where bp.bill_id = p_bill_id;

  update public.bills as b set payer_id = p_payer_id
  where b.id = p_bill_id and b.payer_id is distinct from p_payer_id;

  delete from public.bill_payment_flags as f
  where f.bill_id = p_bill_id and f.to_user <> p_payer_id;

  perform private.log_event(
    p_bill_id, v_uid, 'payers_changed', null,
    jsonb_build_object('before', v_before,
                       'after', private.payers_json(p_bill_id),
                       'moved', private.payments_moved(p_bill_id, v_old, array[p_payer_id]))
  );
end;
$$;

alter function public.set_payer(uuid, uuid) owner to postgres;
revoke execute on function public.set_payer(uuid, uuid) from public, anon, authenticated;
grant execute on function public.set_payer(uuid, uuid) to authenticated;

comment on function public.set_payer(uuid, uuid) is
  'The host says one person paid the whole bill (who-paid A1.3). Clears no payment (ledger); '
  'from split mode deletes the bill_payers rows (never a no-op); deletes flags to anyone else; '
  'logs payers_changed with the moved payments (contract M).';

-- ---------------------------------------------------------------------------
-- private.bill_participants_reset_payer (BEFORE DELETE; A1.3, B3, WP-16)
-- ---------------------------------------------------------------------------
-- Only acts on account deletion in practice: L3 (is_removable) refuses to remove or let leave
-- anyone in the payer set, and leave_group refuses hosts and payers of group bills.
create or replace function private.bill_participants_reset_payer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_host uuid;
  v_old uuid[];
  v_before jsonb;
  v_lost integer;
begin
  -- Early returns without a lock: the bill is gone (host deletion cascades the bill), the row is
  -- the host's, or the person isn't paying.
  select b.host_id into v_host from public.bills as b where b.id = old.bill_id;
  if not found or old.user_id = v_host
     or old.user_id not in (select private.bill_payer_ids(old.bill_id)) then
    return old;
  end if;

  perform 1 from public.bills as b where b.id = old.bill_id for update;
  -- Re-check under the lock.
  if old.user_id not in (select private.bill_payer_ids(old.bill_id)) then
    return old;
  end if;

  v_before := private.payers_json(old.bill_id);
  v_old := array(select private.bill_payer_ids(old.bill_id));

  select count(*)::integer into v_lost
  from public.bill_payments as e
  where e.bill_id = old.bill_id and (e.from_user = old.user_id or e.to_user = old.user_id);

  delete from public.bill_payments as e
  where e.bill_id = old.bill_id and (e.from_user = old.user_id or e.to_user = old.user_id);
  delete from public.bill_payment_flags as f
  where f.bill_id = old.bill_id and (f.from_user = old.user_id or f.to_user = old.user_id);

  delete from public.bill_payers as bp where bp.bill_id = old.bill_id;

  update public.bills as b set payer_id = v_host
  where b.id = old.bill_id and b.payer_id is distinct from v_host;

  delete from public.bill_payment_flags as f
  where f.bill_id = old.bill_id and f.to_user <> v_host;

  perform private.log_event(
    old.bill_id, null, 'payers_changed', null,
    jsonb_build_object('before', v_before,
                       'after', private.payers_json(old.bill_id),
                       'moved', private.payments_moved(old.bill_id, v_old, array[v_host]),
                       'lost', v_lost)
  );
  return old;
end;
$$;

alter function private.bill_participants_reset_payer() owner to postgres;
revoke execute on function private.bill_participants_reset_payer() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- public.attach_bill_to_group: + split_paying (B5f)
-- ---------------------------------------------------------------------------
-- 20261127140001's body; a bill with bill_payers rows -> 22023 split_paying, right after the
-- already_in_group check (group bills keep one payer, GR-M5).
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

  if exists (select 1 from public.bill_payers as bp where bp.bill_id = p_bill_id) then
    raise exception using errcode = '22023', message = 'split_paying';
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
