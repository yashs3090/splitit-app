-- Bill markers and in-app notices, Task 1 (spec docs/specs/2026-11-24-bill-markers-and-notices.md,
-- D1-D3, criteria 1-16; decisions BM-1 to BM-18 in docs/decisions-to-review.md).
--
--   public.bill_seen        owner-only "I've opened this bill" state (D1)
--   public.mark_bill_seen   writes the caller's own row (D3)
--   public.my_bills         the caller's bills for Home, with added / seen / claimed_any /
--                           complete (D2)
--
-- ---------------------------------------------------------------------------
-- Columns clients can't read
-- ---------------------------------------------------------------------------
-- ALL of public.bill_seen (bill_id, user_id, seen_at). anon, authenticated and public hold no
-- privilege on it, so any select (including `select('*')` or a `.select()` after a write),
-- insert, update or delete through the Data API fails with 42501. RLS is enabled with no
-- policies as a second layer. The only read is my_bills() (the caller's own `seen`); the only
-- write is mark_bill_seen (the caller's own row). Nobody, the host included, can learn whether
-- someone else opened a bill (D8).
--
-- ---------------------------------------------------------------------------
-- Nothing here logs or broadcasts (BM-18)
-- ---------------------------------------------------------------------------
-- bill_seen has no triggers. mark_bill_seen writes no bill_events row, sends no Realtime
-- broadcast and changes no bill_participants row, so opening a bill is invisible to everyone
-- else (no read receipt by side channel: an UPDATE on bill_participants would fire
-- bill_participants_broadcast_update and every open bill screen would refetch).
--
-- ---------------------------------------------------------------------------
-- my_bills(): 20-row limit, order
-- ---------------------------------------------------------------------------
-- At most 20 rows. This is the only place the limit lives (lib/ doesn't slice). Order:
-- the caller's joined_at desc, then bills.created_at desc, then bill_id asc (BM-12). No
-- arguments, so it only ever answers about the caller. my_bills takes no row locks.
--
-- ---------------------------------------------------------------------------
-- Lock order (rule from 20261124094656_people_review_fixes.sql: the BILLS ROW FIRST)
-- ---------------------------------------------------------------------------
-- mark_bill_seen, in order:
--   0. Signed-out check, then the participation check: a plain read of bill_participants,
--      NO lock. A stranger or a missing bill gets 42501 not_allowed without making the bill's
--      writers wait (lessons log 2026-11-24, R4).
--   1. private.lock_bill_key_share(bill): FOR KEY SHARE on the bills row (taken only because
--      the caller is a participant). This queues behind remove_participant / leave_bill /
--      update_bill / set_payer (FOR UPDATE on bills) and runs alongside claims, marks and other
--      mark_bill_seen calls.
--   2. Participation re-checked under that lock (a remove or leave that committed between
--      step 0 and step 1 makes this 42501 not_allowed).
--   3. INSERT ... ON CONFLICT DO UPDATE on bill_seen:
--      a. the foreign key bill_seen -> bill_participants takes FOR KEY SHARE on the caller's
--         bill_participants row (implicit, on insert);
--      b. on a repeat call, the upsert takes a row lock on the existing bill_seen row and
--         updates it (the FK isn't re-checked: the key columns don't change).
--   No event insert, so no FOR KEY SHARE on bills through bill_events' foreign key. No trigger.
-- So the order is bills -> bill_participants -> bill_seen, the same direction as every other
-- path.
--
-- New cascade (D1): bill_seen (bill_id, user_id) -> bill_participants ON DELETE CASCADE. Every
-- delete of a participant row now also deletes that person's bill_seen row (a row lock on it):
--   * remove_participant / leave_bill: bills FOR UPDATE, participant row FOR UPDATE, then the
--     delete cascades to claims and bill_seen, then bill_participants_reset_payer, then the
--     event insert. bill_seen is last in the chain, after the bill and participant rows, the
--     same order mark_bill_seen uses; and mark_bill_seen's FOR KEY SHARE on bills conflicts
--     with their FOR UPDATE, so the two never run at the same time on one bill.
--   * Bill deletion (host account deletion cascades bills -> bill_participants -> bill_seen):
--     the bills row goes first.
--   * Account deletion of a participant (auth.users -> profiles -> bill_participants ->
--     bill_seen): the cascade deletes the participant row without locking the bill first. That
--     is the existing gap R9 of the settle spec (docs/before-production.md); bill_seen adds one
--     more row to the same cascade and no new ordering. If it races the same user's
--     mark_bill_seen, the insert's FK check fails (23503), which this function maps to 42501
--     not_allowed.
--
-- Not testable in pgTAP: a real two-session deadlock. bill_markers.test.sql checks the order
-- statically (the function body runs the participation check, then the lock helper, then the
-- upsert), as people_review_fixes.test.sql does.

-- ---------------------------------------------------------------------------
-- public.bill_seen (D1)
-- ---------------------------------------------------------------------------
create table public.bill_seen (
  bill_id uuid not null,
  user_id uuid not null,
  seen_at timestamptz not null default now(),
  constraint bill_seen_pkey primary key (bill_id, user_id),
  constraint bill_seen_participant_fkey foreign key (bill_id, user_id)
    references public.bill_participants (bill_id, user_id) on delete cascade
);
-- The primary key (bill_id, user_id) also indexes the foreign key's columns, so the cascade
-- from bill_participants and my_bills' lookup are both index scans.

comment on table public.bill_seen is
  'Owner-only read state (spec bill-markers-and-notices D1, BM-2). A row means this person has '
  'opened this bill or dismissed its notice; seen_at is the latest time. No client privileges: '
  'written only by mark_bill_seen, read only through my_bills (the caller''s own rows). Removed '
  'with the participant row (cascade). No triggers, no events, no broadcast (BM-18).';

alter table public.bill_seen enable row level security;
-- No policies on purpose: no client role has any privilege, and the two security definer
-- functions below run as the table owner.
revoke all on table public.bill_seen from anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- public.mark_bill_seen (D3)
-- ---------------------------------------------------------------------------
--   signed out                                             42501 not_allowed
--   no such bill, or the caller isn't a participant        42501 not_allowed (same message, BM-16)
--   participant (host included)                            upsert (bill, caller, now())
-- A repeat call keeps one row and moves seen_at forward (greatest of the stored value and
-- now(), so it never goes backwards if two calls overlap).
create function public.mark_bill_seen(p_bill_id uuid)
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

  -- Step 0: who may act, without a lock.
  if not exists (
    select 1 from public.bill_participants as bp
    where bp.bill_id = p_bill_id and bp.user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  -- Step 1: the bills row first (FOR KEY SHARE).
  perform private.lock_bill_key_share(p_bill_id);

  -- Step 2: re-check under the lock.
  if not exists (
    select 1 from public.bill_participants as bp
    where bp.bill_id = p_bill_id and bp.user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  -- Step 3: the upsert (FK takes FOR KEY SHARE on the participant row).
  begin
    insert into public.bill_seen as s (bill_id, user_id, seen_at)
    values (p_bill_id, v_uid, now())
    on conflict (bill_id, user_id)
    do update set seen_at = greatest(s.seen_at, excluded.seen_at);
  exception
    when foreign_key_violation then
      -- The participant row went away (account deletion cascade) after the re-check.
      raise exception using errcode = '42501', message = 'not_allowed';
  end;
end;
$$;

alter function public.mark_bill_seen(uuid) owner to postgres;
revoke execute on function public.mark_bill_seen(uuid) from public, anon, authenticated;
grant execute on function public.mark_bill_seen(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- public.my_bills (D2)
-- ---------------------------------------------------------------------------
-- One row per bill the caller has a bill_participants row on. host_name is the host's
-- profiles.display_name: the host always has a participant row on their bill, so it's a
-- co-participant's name that profiles RLS (profiles_select_own_or_co_participant) already lets
-- the caller read. added, seen and claimed_any describe only the caller. complete is
-- private.bill_is_complete, the same rule mark_paid uses (an unclaimed claimable discount row
-- counts as not complete).
--   signed out                                             42501 not_allowed
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
  complete boolean
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
    exists (
      select 1 from public.bill_seen as s
      where s.bill_id = b.id and s.user_id = v_uid
    ),
    exists (
      select 1 from public.claims as c
      where c.bill_id = b.id and c.user_id = v_uid
    ),
    private.bill_is_complete(b.id)
  from public.bill_participants as bp
  join public.bills as b on b.id = bp.bill_id
  left join public.profiles as p on p.id = b.host_id
  where bp.user_id = v_uid
  order by bp.joined_at desc, b.created_at desc, b.id asc
  limit 20;
end;
$$;

alter function public.my_bills() owner to postgres;
revoke execute on function public.my_bills() from public, anon, authenticated;
grant execute on function public.my_bills() to authenticated;
