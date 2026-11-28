-- Who paid, Task 4a-1: the payments ledger tables (spec docs/specs/2026-11-26-who-paid.md,
-- Amendment A1.3 "Tables (4a-1)" and "Data copy with a self-check (B6)"; engineering review
-- docs/specs/2026-11-26-who-paid-eng-review.md B1, B6, S6, S7, S13, N6). Earlier migrations are
-- applied and are not edited.
--
--   public.bill_payments        one row per recorded money movement (from_user -> to_user). Rows
--                               are never updated (trigger below); undo and not-received delete a
--                               mark's entries; everything else inserts.
--   public.bill_payment_flags   "not received" flags, one per (bill, from_user, to_user).
--   data copy                   every marked participant -> one entry; every flagged participant
--                               -> one flag. The copy checks itself and raises (rolling the whole
--                               migration back) on any mismatch.
--
-- The old mark columns on bill_participants (settled_at, settled_cents, settled_method,
-- not_received_cents, not_received_method, not_received_by) stay until the next migration
-- (20261127140001_bill_payments_functions.sql), which re-creates every function on the new tables,
-- checks nothing was written to the old columns after this copy, and drops them. Apply both in one
-- `supabase migration up`.
--
-- ---------------------------------------------------------------------------
-- What a row means
-- ---------------------------------------------------------------------------
--   bill_payments.cents        1..99,999,999, always positive; direction is from_user -> to_user.
--   bill_payments.method       private.is_payment_method (92's one list).
--   bill_payments.plan_key     the client's plan fingerprint when the payment was made
--                              (16 lowercase hex), or null = "made under an earlier state". The DB
--                              checks the format only (A1.2). Copied marks get null.
--   bill_payments.recorded_at  clock_timestamp(), so entries written in one transaction are
--                              ordered; ties are broken by id (contract P). Copied marks keep their
--                              settled_at.
--   bill_payments.recorded_by  who recorded it; always from_user in every writer (mark_paid,
--                              settle_difference "more" = the sender, "back" = the returner). No FK
--                              (like 92's not_received_by).
--   bill_payment_flags         cents / method of the mark the recipient said never arrived.
--
-- A pair's "mark" (contract P, private.pair_state, next migration) is derived from these rows; it
-- is never stored.
--
-- ---------------------------------------------------------------------------
-- Grants, RLS, columns clients can't read
-- ---------------------------------------------------------------------------
-- Both tables: RLS on; one SELECT policy for authenticated (participants of the bill, N6);
-- revoke all from anon, authenticated, public AND service_role, then grant SELECT to authenticated.
-- No client role can insert, update, delete or truncate (42501); anon can't even select (42501).
-- service_role loses every write too: nothing legitimate writes the ledger outside the security
-- definer functions (so payments can't be forged), as for bill_events / group_payments. It keeps
-- no SELECT either; nothing reads the ledger as service_role.
-- Columns clients can't read: none (every column is readable by participants, Q5). `select *`
-- works, but app code names its columns (PAYMENT_COLUMNS / FLAG_COLUMNS, Task 5).
-- The method / range CHECKs call private.is_payment_method, which no client role may execute;
-- every writer is a security definer function owned by postgres, so the CHECK runs fine (lesson
-- 2026-11-27 "A function used in a CHECK constraint needs EXECUTE..."): direct writes are blocked
-- by grants first anyway.
--
-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
-- Statement-level AFTER INSERT and AFTER DELETE triggers send the data-free 'bill:<id>' hint via
-- private.broadcast_bill_ledger_change(), which sends at most ONE hint per bill per client
-- statement (one rpc): a transaction-local setting remembers statement_timestamp() of the last
-- hint. One function call that deletes a run and upserts a flag (mark_not_received) therefore
-- still sends exactly one hint, as 92's single UPDATE did; the next client statement in the same
-- transaction (pgTAP runs a whole file in one) gets its own. Hints carry no data and are delivered
-- at commit, so nothing is lost. A statement that touches no row sends nothing (empty transition
-- table). Writes to other tables in the same call (bills, by set_payers) keep their own hints.
--
-- ---------------------------------------------------------------------------
-- Indexes (S7)
-- ---------------------------------------------------------------------------
--   bill_payments_pair_idx    (bill_id, from_user, to_user, recorded_at, id): contract P reads one
--                             pair in order; also serves the (bill_id, from_user) FK.
--   bill_payments_bill_to_idx (bill_id, to_user): "payments to X" and the (bill_id, to_user) FK
--                             cascade.
--   bill_payment_flags: the primary key serves (bill_id, from_user); bill_payment_flags_bill_to_idx
--                             serves (bill_id, to_user).
--
-- ---------------------------------------------------------------------------
-- Lock order of the copy
-- ---------------------------------------------------------------------------
-- LOCK bill_participants IN SHARE MODE first: no mark can be written while we copy (every mark
-- writer UPDATEs bill_participants, which needs ROW EXCLUSIVE, which conflicts with SHARE). The
-- next migration re-checks that the old columns still match the copy before dropping them, so a
-- mark written between the two migrations can't be lost silently.
--
-- ---------------------------------------------------------------------------
-- Rollback (S13)
-- ---------------------------------------------------------------------------
-- Reversible while the old columns exist (before 20261127140001 is applied): drop both tables
-- (`drop table public.bill_payment_flags, public.bill_payments;`) and the two functions below.
-- After 20261127140001: add the six columns and their checks back, then copy, per participant, the
-- latest mark toward bills.payer_id (contract P's net / markAt / method for the pair
-- (user, payer_id)) and each flag whose to_user is the payer, then restore the functions from
-- 20261126080844_sent_via_venmo.sql / 20261127060131_group_bills.sql. Entries toward anyone other
-- than the payer have no place in the old columns (they can exist only after 20261127140002).
-- Before production: snapshot the hosted DB before the push (docs/before-production.md).

-- Explicit transaction: the CLI runs a migration without BEGIN/COMMIT, and LOCK TABLE needs a
-- transaction block. Any error (including the self-check's raise) rolls the whole file back.
begin;

-- ---------------------------------------------------------------------------
-- public.bill_payments
-- ---------------------------------------------------------------------------
create table public.bill_payments (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.bills (id) on delete cascade,
  from_user uuid not null,
  to_user uuid not null,
  cents integer not null
    constraint bill_payments_cents_range check (cents between 1 and 99999999),
  method text not null
    constraint bill_payments_method_known check (private.is_payment_method(method)),
  plan_key text null
    constraint bill_payments_plan_key_format check (plan_key ~ '^[0-9a-f]{16}$'),
  recorded_at timestamptz not null default clock_timestamp(),
  recorded_by uuid not null,
  constraint bill_payments_parties_differ check (from_user <> to_user),
  constraint bill_payments_from_participant_fkey foreign key (bill_id, from_user)
    references public.bill_participants (bill_id, user_id) on delete cascade,
  constraint bill_payments_to_participant_fkey foreign key (bill_id, to_user)
    references public.bill_participants (bill_id, user_id) on delete cascade
);

comment on table public.bill_payments is
  'The payments ledger (who-paid spec A1.2/A1.3): one row per recorded money movement on a bill. '
  'Written only by security definer functions; never updated. A pair''s mark is derived '
  '(private.pair_state, contract P).';

create index bill_payments_pair_idx
  on public.bill_payments (bill_id, from_user, to_user, recorded_at, id);
create index bill_payments_bill_to_idx
  on public.bill_payments (bill_id, to_user);

-- ---------------------------------------------------------------------------
-- public.bill_payment_flags (not received)
-- ---------------------------------------------------------------------------
create table public.bill_payment_flags (
  bill_id uuid not null references public.bills (id) on delete cascade,
  from_user uuid not null,
  to_user uuid not null,
  cents integer not null
    constraint bill_payment_flags_cents_range check (cents between 1 and 99999999),
  method text not null
    constraint bill_payment_flags_method_known check (private.is_payment_method(method)),
  primary key (bill_id, from_user, to_user),
  constraint bill_payment_flags_parties_differ check (from_user <> to_user),
  constraint bill_payment_flags_from_participant_fkey foreign key (bill_id, from_user)
    references public.bill_participants (bill_id, user_id) on delete cascade,
  constraint bill_payment_flags_to_participant_fkey foreign key (bill_id, to_user)
    references public.bill_participants (bill_id, user_id) on delete cascade
);

comment on table public.bill_payment_flags is
  'Not-received flags (sent via Venmo D4, moved here by who-paid A1.3): to_user said the mark '
  'from from_user never arrived; cents / method are that mark''s. Written only by security '
  'definer functions.';

create index bill_payment_flags_bill_to_idx
  on public.bill_payment_flags (bill_id, to_user);

-- ---------------------------------------------------------------------------
-- Ledger rows are never updated (any caller, any RLS)
-- ---------------------------------------------------------------------------
create function private.bill_payments_no_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = '42501', message = 'payments_are_immutable';
end;
$$;

revoke execute on function private.bill_payments_no_update() from public, anon, authenticated;

create trigger bill_payments_no_update
  before update on public.bill_payments
  for each row
  execute function private.bill_payments_no_update();

-- ---------------------------------------------------------------------------
-- RLS and grants (N6)
-- ---------------------------------------------------------------------------
alter table public.bill_payments enable row level security;
alter table public.bill_payment_flags enable row level security;

revoke all on public.bill_payments from anon, authenticated, public, service_role;
revoke all on public.bill_payment_flags from anon, authenticated, public, service_role;
grant select on public.bill_payments to authenticated;
grant select on public.bill_payment_flags to authenticated;

create policy bill_payments_select_participant on public.bill_payments
  for select to authenticated
  using (private.is_bill_participant(bill_id));

create policy bill_payment_flags_select_participant on public.bill_payment_flags
  for select to authenticated
  using (private.is_bill_participant(bill_id));

-- ---------------------------------------------------------------------------
-- Realtime: at most one hint per bill per client statement
-- ---------------------------------------------------------------------------
-- Same message as private.broadcast_bill_change (payload {t: table}, event 'changed', private
-- topic 'bill:<id>'). The setting name carries the bill id without hyphens (setting names allow
-- letters, digits and underscores after the prefix).
create function private.broadcast_bill_ledger_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_bill_id uuid;
  v_key text;
begin
  -- Only the transition table of this event exists, so each branch names its own.
  if tg_op = 'DELETE' then
    select array_agg(distinct o.bill_id) into v_ids from old_rows as o;
  else
    select array_agg(distinct n.bill_id) into v_ids from new_rows as n;
  end if;

  foreach v_bill_id in array coalesce(v_ids, '{}'::uuid[]) loop
    v_key := 'splitit_ledger_hint.b' || replace(v_bill_id::text, '-', '');
    if coalesce(current_setting(v_key, true), '') <> statement_timestamp()::text then
      perform set_config(v_key, statement_timestamp()::text, true);
      perform realtime.send(
        jsonb_build_object('t', tg_table_name), 'changed', 'bill:' || v_bill_id::text, true
      );
    end if;
  end loop;
  return null;
end;
$$;

alter function private.broadcast_bill_ledger_change() owner to postgres;
revoke execute on function private.broadcast_bill_ledger_change() from public, anon, authenticated;

comment on function private.broadcast_bill_ledger_change() is
  'Statement trigger for the ledger tables: one data-free hint on bill:<id> per bill per client '
  'statement (who-paid A1.3).';

-- Transition tables can't be referenced by a trigger function that handles both INSERT and DELETE
-- in one trigger, so each event has its own trigger (both call the same function; the function
-- reads only the transition table that exists for its event).
create trigger bill_payments_broadcast_insert
  after insert on public.bill_payments
  referencing new table as new_rows
  for each statement
  execute function private.broadcast_bill_ledger_change();
create trigger bill_payments_broadcast_delete
  after delete on public.bill_payments
  referencing old table as old_rows
  for each statement
  execute function private.broadcast_bill_ledger_change();
create trigger bill_payment_flags_broadcast_insert
  after insert on public.bill_payment_flags
  referencing new table as new_rows
  for each statement
  execute function private.broadcast_bill_ledger_change();
create trigger bill_payment_flags_broadcast_delete
  after delete on public.bill_payment_flags
  referencing old table as old_rows
  for each statement
  execute function private.broadcast_bill_ledger_change();

-- ---------------------------------------------------------------------------
-- Data copy with a self-check (B6)
-- ---------------------------------------------------------------------------
lock table public.bill_participants in share mode;

do $$
declare
  v_marked integer;
  v_flagged integer;
  v_entries integer;
  v_flags integer;
begin
  -- (1) a mark on the payer's own row can't become an entry (from = to).
  if exists (
    select 1
    from public.bill_participants as bp
    join public.bills as b on b.id = bp.bill_id
    where bp.settled_at is not null and bp.user_id = b.payer_id
  ) then
    raise exception using errcode = 'P0001',
      message = 'bill_payments copy: a mark on the payer''s own row (user_id = payer_id)';
  end if;

  -- (2) a flag's recipient must be a participant of the bill (the flag's to_user FK).
  if exists (
    select 1
    from public.bill_participants as bp
    where bp.not_received_cents is not null
      and not exists (
        select 1 from public.bill_participants as r
        where r.bill_id = bp.bill_id and r.user_id = bp.not_received_by
      )
  ) then
    raise exception using errcode = 'P0001',
      message = 'bill_payments copy: a flag''s not_received_by is not a participant of its bill';
  end if;

  -- (3) a flag to oneself can't become a flag row (from = to).
  if exists (
    select 1 from public.bill_participants as bp
    where bp.not_received_cents is not null and bp.not_received_by = bp.user_id
  ) then
    raise exception using errcode = 'P0001',
      message = 'bill_payments copy: a flag whose not_received_by is the flagged participant';
  end if;

  select count(*)::integer into v_marked
  from public.bill_participants as bp where bp.settled_at is not null;
  select count(*)::integer into v_flagged
  from public.bill_participants as bp where bp.not_received_cents is not null;

  -- One entry per marked participant, toward the bill's payer. The join to bills and the
  -- user_id <> payer_id filter can only drop rows that check (1) already refused; the count check
  -- below is the backstop that any such drop (or a future edit of these statements) can't pass.
  insert into public.bill_payments
    (bill_id, from_user, to_user, cents, method, plan_key, recorded_at, recorded_by)
  select bp.bill_id, bp.user_id, b.payer_id, bp.settled_cents,
         coalesce(bp.settled_method, 'other'), null, bp.settled_at, bp.user_id
  from public.bill_participants as bp
  join public.bills as b on b.id = bp.bill_id
  where bp.settled_at is not null and bp.user_id <> b.payer_id
  order by bp.bill_id, bp.user_id;
  get diagnostics v_entries = row_count;

  insert into public.bill_payment_flags (bill_id, from_user, to_user, cents, method)
  select bp.bill_id, bp.user_id, bp.not_received_by, bp.not_received_cents, bp.not_received_method
  from public.bill_participants as bp
  where bp.not_received_cents is not null
    and bp.not_received_by <> bp.user_id
    and exists (
      select 1 from public.bill_participants as r
      where r.bill_id = bp.bill_id and r.user_id = bp.not_received_by
    )
  order by bp.bill_id, bp.user_id;
  get diagnostics v_flags = row_count;

  if v_entries <> v_marked then
    raise exception using errcode = 'P0001',
      message = format('bill_payments copy: %s entries inserted for %s marked participants',
                       v_entries, v_marked);
  end if;
  if v_flags <> v_flagged then
    raise exception using errcode = 'P0001',
      message = format('bill_payments copy: %s flags inserted for %s flagged participants',
                       v_flags, v_flagged);
  end if;

  raise notice 'bill_payments copy: % entries, % flags', v_entries, v_flags;
end $$;

commit;
