-- M1b + M2, Task 1: bills, unit-row line items, participants and claims, with RLS helpers,
-- RLS policies, explicit grants and co-participant profile reads.
-- Spec: docs/specs/2026-11-20-m1b-m2-share-and-claim.md ("Data model", A1.2, A1.3, A2.3).
--
-- Money is integer cents everywhere (ADR 0005).
--
-- Write paths: clients get NO insert/update/delete on bills, line_items or bill_participants,
-- and no update on claims. Those writes go through SQL functions added in later migrations
-- (create_bill, update_bill, join_bill, rotate_join_code, set_claim, set_item_split; ADR 0013).
-- The only direct client writes are inserting and deleting your own claim, under RLS.
--
-- There is deliberately no claimer-change trigger: custom parts are kept when claimers join or
-- leave (A2.3), so the planned claims_reset_split trigger is not created.

-- ---------------------------------------------------------------------------
-- private schema for RLS helpers
-- ---------------------------------------------------------------------------
-- Not listed in config.toml [api] schemas, so nothing here is reachable through the Data API.
-- authenticated needs USAGE (and EXECUTE on the helpers below) because RLS policies run the
-- helpers with the privileges of the querying role. anon gets nothing.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------------------
-- bills
-- ---------------------------------------------------------------------------
create table public.bills (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.profiles (id) on delete cascade,
  currency text not null default 'USD'
    constraint bills_currency_usd check (currency = 'USD'),
  -- As printed on the receipt, for display only. Null when the receipt shows none.
  subtotal_cents integer null
    constraint bills_subtotal_cents_range check (subtotal_cents between 0 and 99999999),
  tax_cents integer not null default 0
    constraint bills_tax_cents_range check (tax_cents between 0 and 99999999),
  fees_cents integer not null default 0
    constraint bills_fees_cents_range check (fees_cents between 0 and 99999999),
  tip_cents integer not null default 0
    constraint bills_tip_cents_range check (tip_cents between 0 and 99999999),
  discount_cents integer not null default 0
    constraint bills_discount_cents_range check (discount_cents between 0 and 99999999),
  total_cents integer not null
    constraint bills_total_cents_range check (total_cents between 0 and 99999999),
  -- 20 lowercase hex chars (80 random bits), generated in the database (Task 3).
  join_code text not null unique
    constraint bills_join_code_format check (join_code ~ '^[0-9a-f]{20}$'),
  created_at timestamptz not null default now(),
  edited_at timestamptz null
);

comment on table public.bills is
  'One shared bill. Readable by its participants only; written only through SQL functions.';

create index bills_host_id_idx on public.bills (host_id);

-- ---------------------------------------------------------------------------
-- line_items: one row per UNIT (A1.3). "Beer x2 $14.00" is two rows of 700.
-- ---------------------------------------------------------------------------
create table public.line_items (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.bills (id) on delete cascade,
  -- The form row this unit came from (0..G-1), its index within the group, and the group size.
  group_position integer not null
    constraint line_items_group_position_nonneg check (group_position >= 0),
  unit_index integer not null
    constraint line_items_unit_index_nonneg check (unit_index >= 0),
  group_size integer not null
    constraint line_items_group_size_range check (group_size between 1 and 99),
  name text not null
    constraint line_items_name_length check (char_length(btrim(name)) between 1 and 100),
  note text null
    constraint line_items_note_length check (note is null or char_length(note) <= 200),
  -- This unit's price.
  total_cents integer not null
    constraint line_items_total_cents_range check (total_cents between 0 and 9999999),
  -- Who last set a custom split on this row (set_item_split, Task 5).
  split_set_by uuid null references public.profiles (id) on delete set null,
  split_set_at timestamptz null,
  constraint line_items_unit_in_group check (unit_index < group_size),
  -- Deferrable so update_bill can swap group positions inside one transaction.
  -- Its index also covers lookups by bill_id.
  constraint line_items_bill_group_unit_key
    unique (bill_id, group_position, unit_index) deferrable initially deferred,
  -- Target of the claims composite foreign key, which pins a claim's bill to its row's bill.
  constraint line_items_id_bill_key unique (id, bill_id)
);

comment on table public.line_items is
  'One row per unit of a receipt line. Readable by bill participants; written only through SQL functions.';

-- Covers the split_set_by foreign key, so deleting a profile doesn't scan every row.
create index line_items_split_set_by_idx on public.line_items (split_set_by)
  where split_set_by is not null;

-- ---------------------------------------------------------------------------
-- bill_participants
-- ---------------------------------------------------------------------------
create table public.bill_participants (
  bill_id uuid not null references public.bills (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (bill_id, user_id)
);

comment on table public.bill_participants is
  'Who is in a bill (the host included). Rows come only from create_bill and join_bill.';

create index bill_participants_user_id_idx on public.bill_participants (user_id);

-- ---------------------------------------------------------------------------
-- claims
-- ---------------------------------------------------------------------------
create table public.claims (
  bill_id uuid not null,
  line_item_id uuid not null,
  user_id uuid not null,
  -- Share of the row's price, in proportion to parts. Default 1 = even split (A1.2).
  parts integer not null default 1
    constraint claims_parts_range check (parts between 1 and 20),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (line_item_id, user_id),
  -- The row must belong to the same bill as the claim (a claim can't point at bill Y's row
  -- while saying bill X). Deleting the row deletes its claims.
  constraint claims_line_item_fkey
    foreign key (line_item_id, bill_id)
    references public.line_items (id, bill_id) on delete cascade,
  -- The claimer must be a participant of the bill. Leaving or account deletion removes claims.
  constraint claims_participant_fkey
    foreign key (bill_id, user_id)
    references public.bill_participants (bill_id, user_id) on delete cascade
);

comment on table public.claims is
  'Who claimed which unit row, with parts for custom splits. Clients insert/delete only their own claims.';

create index claims_bill_id_idx on public.claims (bill_id);
create index claims_user_id_idx on public.claims (user_id);

-- Reuse the M0 trigger function to keep updated_at current (set_item_split updates parts).
create trigger claims_set_updated_at
  before update on public.claims
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS helpers
-- ---------------------------------------------------------------------------
-- security definer: they read bill_participants past its own RLS. A policy on
-- bill_participants that queried bill_participants under RLS would recurse forever.
-- Both always compare against the caller's own auth.uid(), so they reveal only facts about
-- bills the caller is in. Empty search_path, every name schema-qualified.

-- True iff the caller is a participant of the bill.
create function private.is_bill_participant(p_bill_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.bill_participants bp
    where bp.bill_id = p_bill_id
      and bp.user_id = (select auth.uid())
  );
$$;

-- True iff the caller and p_user_id are both participants of at least one bill.
create function private.shares_bill_with(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.bill_participants mine
    join public.bill_participants theirs on theirs.bill_id = mine.bill_id
    where mine.user_id = (select auth.uid())
      and theirs.user_id = p_user_id
  );
$$;

-- Functions get EXECUTE for PUBLIC by default; remove it, then allow only authenticated
-- (RLS policies evaluated for authenticated users call these).
revoke execute on function private.is_bill_participant(uuid) from public, anon, authenticated;
revoke execute on function private.shares_bill_with(uuid) from public, anon, authenticated;
grant execute on function private.is_bill_participant(uuid) to authenticated;
grant execute on function private.shares_bill_with(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.bills enable row level security;
alter table public.line_items enable row level security;
alter table public.bill_participants enable row level security;
alter table public.claims enable row level security;

-- bills, line_items, bill_participants: participants read; no write policies (writes go
-- through SQL functions only).
create policy "bills_select_participant"
  on public.bills
  for select
  to authenticated
  using (private.is_bill_participant(id));

create policy "line_items_select_participant"
  on public.line_items
  for select
  to authenticated
  using (private.is_bill_participant(bill_id));

create policy "bill_participants_select_participant"
  on public.bill_participants
  for select
  to authenticated
  using (private.is_bill_participant(bill_id));

-- claims: participants read every claim in their bills (who claimed what is visible to all,
-- decision 3). You can insert and delete only your own claim. No update policy.
create policy "claims_select_participant"
  on public.claims
  for select
  to authenticated
  using (private.is_bill_participant(bill_id));

create policy "claims_insert_own"
  on public.claims
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and private.is_bill_participant(bill_id)
  );

create policy "claims_delete_own"
  on public.claims
  for delete
  to authenticated
  using (user_id = (select auth.uid()));

-- profiles: in addition to your own row (M0 policy), you can read the profiles of people you
-- share a bill with. profiles has no e-mail column (M0), so this exposes display_name only.
-- Policies are permissive, so this ORs with profiles_select_own. Update stays own-row only.
create policy "profiles_select_co_participant"
  on public.profiles
  for select
  to authenticated
  using (private.shares_bill_with(id));

-- ---------------------------------------------------------------------------
-- Explicit grants (defense in depth on top of RLS, like M0). Supabase's default privileges on
-- public grant everything to anon and authenticated, so revoke first.
--   anon: nothing on any of these tables.
--   authenticated:
--     bills, line_items, bill_participants: select only (RLS: participants).
--     claims: select; insert of (bill_id, line_item_id, user_id) only, so parts, created_at and
--     updated_at always take their defaults; delete. NO update on any column (A1.2): parts
--     change only through set_item_split.
-- Denied operations fail with 42501 (insufficient_privilege).
-- ---------------------------------------------------------------------------
revoke all on public.bills from anon, authenticated, public;
revoke all on public.line_items from anon, authenticated, public;
revoke all on public.bill_participants from anon, authenticated, public;
revoke all on public.claims from anon, authenticated, public;

grant select on public.bills to authenticated;
grant select on public.line_items to authenticated;
grant select on public.bill_participants to authenticated;
grant select, delete on public.claims to authenticated;
grant insert (bill_id, line_item_id, user_id) on public.claims to authenticated;
