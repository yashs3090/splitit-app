-- People you've split with, Task 1: bill_participants.added, rule L1 ("linked"),
-- people_i_split_with(), add_participant, and three new Activity kinds.
-- Spec: docs/specs/2026-11-24-people-and-invites.md (D1, D2 L1/L2, D3; criteria 1-14).
-- Earlier migrations are applied and are not edited.
--
-- Rule L1 lives in exactly one function body: private.my_links(). It returns one row
-- (user_id, bill_id, bill_created_at) for every other user the caller is linked with through a
-- bill. A participant row is "active" when added = false (the host, or joined with the link) or
-- that person has at least one claims row on that bill. The caller and U are linked through
-- bill X when both have an active row on X. people_i_split_with() and add_participant both read
-- my_links(); nothing else re-implements the rule. It is computed from current rows, so an
-- unclaim or a leave can unlink people again (spec P6, P9).
--
-- L2 ranking: shared_bills desc, last_shared_at desc, lower(display_name) asc nulls last,
-- user_id asc. LIMIT 200 (the spec's starting value, unchanged; no evidence yet to change it).
--
-- Columns clients can't read: none on bill_participants (table-level SELECT; `select *` works).
-- profiles is unchanged: clients read (id, display_name, venmo_username) only, so a bare
-- `.select()` / `select('*')` on profiles still fails with 42501.
--
-- Locks: add_participant takes FOR SHARE on the bill row (the host check). That serializes it
-- with remove_participant / leave_bill (FOR UPDATE on the bill row, next migration) and with
-- set_payer, and lets it run alongside mark_paid. Lock order everywhere: bill row first, then
-- participant rows.
--
-- Event details written here and in 20261124091042_membership.sql (lib/activityText.ts parses
-- them; ids only, no names):
--   participant_added   { user_id: uid }   actor = host
--   participant_removed { user_id: uid }   actor = host
--   left                {}                 actor = the person who left

-- ---------------------------------------------------------------------------
-- D1: bill_participants.added
-- ---------------------------------------------------------------------------
-- Existing rows all came from create_bill or join_bill, so the default false is correct for them.
alter table public.bill_participants
  add column added boolean not null default false;

comment on column public.bill_participants.added is
  'True when the row was created by add_participant (the host added this person). Rows from '
  'create_bill and join_bill are false. Never changes after insert. Used only by rule L1.';

comment on table public.bill_participants is
  'Who is in a bill (the host included). Rows come only from create_bill, join_bill and '
  'add_participant; removed only by remove_participant, leave_bill or a cascade.';

-- ---------------------------------------------------------------------------
-- Grants, restated: no client writes; every column readable by participants
-- ---------------------------------------------------------------------------
revoke all on public.bill_participants from anon, authenticated, public;
grant select on public.bill_participants to authenticated;

-- ---------------------------------------------------------------------------
-- Activity kinds (all three now, so the membership migration needs no constraint change)
-- ---------------------------------------------------------------------------
alter table public.bill_events drop constraint bill_events_kind_known;
alter table public.bill_events
  add constraint bill_events_kind_known check (kind in (
    'bill_created', 'joined', 'claimed', 'unclaimed', 'split_changed', 'item_added',
    'item_removed', 'item_changed', 'amounts_changed', 'link_rotated', 'extras_split_changed',
    'payer_changed', 'marked_paid', 'unmarked_paid',
    'participant_added', 'participant_removed', 'left'
  ));

-- ---------------------------------------------------------------------------
-- L1: private.my_links()
-- ---------------------------------------------------------------------------
-- security invoker, and no client role may execute it: it is only called from the security
-- definer functions below, which run as their owner (postgres) and so read past RLS. It always
-- answers about auth.uid(), never about an arbitrary user. Signed out: no rows.
create function private.my_links()
returns table (user_id uuid, bill_id uuid, bill_created_at timestamptz)
language sql
stable
set search_path = ''
as $$
  with my_bills as (
    select bp.bill_id
    from public.bill_participants as bp
    where bp.user_id = (select auth.uid())
  ),
  -- The L1 "active" predicate, once.
  active as (
    select bp.bill_id, bp.user_id
    from public.bill_participants as bp
    where bp.bill_id in (select mb.bill_id from my_bills as mb)
      and (
        not bp.added
        or exists (
          select 1 from public.claims as c
          where c.bill_id = bp.bill_id and c.user_id = bp.user_id
        )
      )
  )
  select theirs.user_id, b.id, b.created_at
  from active as mine
  join active as theirs
    on theirs.bill_id = mine.bill_id and theirs.user_id <> mine.user_id
  join public.bills as b on b.id = mine.bill_id
  where mine.user_id = (select auth.uid());
$$;

revoke execute on function private.my_links() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- public.people_i_split_with()
-- ---------------------------------------------------------------------------
-- No arguments: it can only answer about the caller. Every row is someone the caller shares a
-- bill with, so profiles_select_own_or_co_participant already lets the caller read that
-- profile's display_name and venmo_username; nothing new is revealed.
create function public.people_i_split_with()
returns table (
  user_id uuid,
  display_name text,
  venmo_username text,
  shared_bills integer,
  last_shared_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  return query
  select l.user_id, p.display_name, p.venmo_username,
         count(*)::integer as shared_bills,
         max(l.bill_created_at) as last_shared_at
  from private.my_links() as l
  join public.profiles as p on p.id = l.user_id
  group by l.user_id, p.display_name, p.venmo_username
  -- Spelled as expressions, not output names: inside plpgsql, the RETURNS TABLE column names are
  -- variables and would shadow the aliases.
  order by count(*) desc, max(l.bill_created_at) desc, lower(p.display_name) asc nulls last,
           l.user_id asc
  limit 200;
end;
$$;

revoke execute on function public.people_i_split_with() from public, anon, authenticated;
grant execute on function public.people_i_split_with() to authenticated;

-- ---------------------------------------------------------------------------
-- public.add_participant(p_bill_id, p_user_id)
-- ---------------------------------------------------------------------------
-- Checks, in this order:
--   signed out, no such bill, or caller not the host      42501 not_allowed
--   p_user_id already a participant (the host included)    no-op: no row, no event
--   caller and p_user_id not linked (L1), including an id
--   that isn't a user, or null                             22023 not_linked (same either way)
-- Otherwise inserts (bill_id, user_id, added = true) and logs one participant_added. The insert
-- fires bill_participants_broadcast_insert, so open bill screens refetch.
-- "on conflict do nothing" + row_count: two concurrent adds of the same person give one row and
-- one event.
create function public.add_participant(p_bill_id uuid, p_user_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_inserted integer;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  perform 1
  from public.bills as b
  where b.id = p_bill_id and b.host_id = v_uid
  for share;
  if not found then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  if exists (
    select 1 from public.bill_participants as bp
    where bp.bill_id = p_bill_id and bp.user_id = p_user_id
  ) then
    return;
  end if;

  if not exists (select 1 from private.my_links() as l where l.user_id = p_user_id) then
    raise exception using errcode = '22023', message = 'not_linked';
  end if;

  insert into public.bill_participants (bill_id, user_id, added)
  values (p_bill_id, p_user_id, true)
  on conflict (bill_id, user_id) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted > 0 then
    perform private.log_event(
      p_bill_id, v_uid, 'participant_added', null,
      jsonb_build_object('user_id', p_user_id)
    );
  end if;
end;
$$;

revoke execute on function public.add_participant(uuid, uuid) from public, anon, authenticated;
grant execute on function public.add_participant(uuid, uuid) to authenticated;
