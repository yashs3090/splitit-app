-- Delete group, Task T1 as replaced by Amendment A2 (hard delete; spec
-- docs/specs/2026-11-28-delete-group.md contracts D, F, L, W and A2.1-A2.11; decisions DG-1 ...
-- DG-14 in docs/decisions-to-review.md). Earlier migrations are applied and are not edited.
--
--   private.group_bill_waiting(p_bill_id) -> boolean      contract W, the same rule as lib C-G1
--   private.group_money_fingerprint(p_group_id) -> text   contract F (md5 hex, 32 characters)
--   public.group_snapshot(p_group_id)   re-created from 20261127150000_bill_not_part.sql (the
--                                       newest on disk; its body matched the live one, compared
--                                       before writing this): adds "money_fingerprint". Every
--                                       other key is unchanged.
--   public.delete_group(p_group_id, p_fingerprint)   any member; hard delete (A2.1, A2.2)
--   public.add_expense, edit_expense, delete_expense (from 20261126085945_group_expenses.sql) and
--   public.record_payment, undo_payment (from 20261126090704_group_payments.sql): re-created with
--   one change each: FOR KEY SHARE on the group row as their first lock, then "the group still
--   exists" (else 42501 not_allowed). Their bodies on disk matched the live ones (compared before
--   writing this). No other behaviour changes. See "Why the money writes now lock the group".
--
-- No table, column, policy or grant on a table changes. No event is logged by delete_group (DG-14):
-- the group's events go with it.
--
-- ===========================================================================================
-- Contract W: private.group_bill_waiting matches lib, not `not bill_is_complete or bill_all_zero`
-- ===========================================================================================
-- lib (lib/groupBalance.ts groupBalances, C-G1): a bill waits when a row has no counted claim
-- (sharesComplete) or computeShares(...).unclaimedCents <> 0. On a fully claimed bill the second
-- part is "the extras (total - sum of every row) aren't 0 and nobody can carry them":
--   proportional: the item rows add up to 0 (every weight is 0);
--   equal:        nobody has a claim on an item row (on a complete bill: there is no item row).
-- private.bill_all_zero (settle_state = 'all_zero') is the proportional case only. So the old
-- pair said "not waiting" for an EQUAL bill with no item rows and extras <> 0 (no rows and a
-- total > $0; or only discount rows), where lib says waiting (A2.10). group_bill_waiting adds that
-- case; bill_is_complete and bill_all_zero are unchanged (other functions use them).
-- lib's answers, recorded with an esbuild bundle of lib/groupBalance.ts on 2026-11-28 (both modes):
--   W1 priced rows all claimed: no | W2 an item unclaimed: yes | W3 a discount unclaimed: yes
--   W4 every row $0 and claimed, total > $0: proportional yes, equal no | W4 with total $0: no
--   W5 a $0 row unclaimed: yes | W6 a split row (parts 1 + 2): no
--   W7 no rows, total > $0: yes (both modes) | W7 no rows, total $0: no
--   discount rows only, claimed, total - rows <> 0: yes (both modes)
-- delete_group_test.sql asserts every one of these against group_bill_waiting.
-- Claims the DB can hold are always counted by lib (parts 1..20 by claims_parts_range; claimers are
-- participants by claims_participant_fkey), so "has a claims row" is lib's "has a counted claim".
--
-- ===========================================================================================
-- Contract F: the money fingerprint
-- ===========================================================================================
-- md5 of the jsonb text of { members: [user_id] by user_id; bills: [{id, payer_id, total_cents,
-- extras_split, rows: [{id, total_cents, kind, claims: {user_id: parts}}] by row id}] by bill id,
-- bills.group_id = G; expenses: [{id, version}] live only, by id; payments: [id] not undone, by
-- id }. jsonb text is canonical (keys sorted), so the same data gives the same string. It covers
-- every input groupBalances reads; rename, a new link, hide and "not part of this" don't change
-- it. Participants of a group bill are the members (GR-10 triggers), so members cover them.
-- group_snapshot computes it inside its one statement: a STABLE function runs on the calling
-- query's snapshot, so the key describes exactly the payload around it. A staleness check, not a
-- security boundary (contract F).
--
-- ===========================================================================================
-- delete_group: checks, in this order (contract D as amended by A2.9 / A2.11)
-- ===========================================================================================
--   0. signed out, or p_group_id null                                  -> 42501 not_allowed
--   1. the caller isn't in group_members for it, or there's no such group (plain read, NO lock:
--      who may act comes before any lock)                               -> 42501 not_allowed
--   -- locks: 2. groups row FOR UPDATE (gone meanwhile -> 42501); 3. every bill of the group FOR
--      UPDATE, ascending id --
--   4. membership re-read under the locks; gone                         -> 42501 not_allowed
--   5. p_fingerprint null, not ^[0-9a-f]{32}$, or <> contract F now     -> 22023 group_changed
--   6. any bill of the group is waiting (contract W)                    -> 22023 receipts_waiting
--   7. the deletes (below). A 23503 there (a restrict row appeared that the locks should have
--      kept out; unreachable while every writer follows contract L) -> 22023 group_changed.
-- A retry after a lost answer finds no group: 42501 not_allowed, which the app reads as "the group
-- is gone" (A2.9, A2.11). There is no "already deleted by me" success any more.
--
-- Delete order (A2.1). Every FK into these tables, listed from pg_constraint on 2026-11-28:
--   expense_shares -> expenses (expense_id, group_id)            cascade
--   expense_shares -> group_members (group_id, user_id)          RESTRICT
--   expenses       -> group_members (group_id, payer_id)         RESTRICT
--   expenses       -> group_members (group_id, created_by)       RESTRICT
--   group_payments -> group_members (group_id, from/to/recorded_by)  RESTRICT x3
--   group_payments -> bills (bill_id)                            set null
--   bills          -> groups (group_id)                          RESTRICT
--   bills          -> group_members (group_id, payer_id)         RESTRICT
--   group_hidden   -> group_members (group_id, user_id)          cascade
--   group_members  -> groups (group_id)                          cascade
--   group_events   -> groups (group_id)                          cascade
--   bills' children: line_items, bill_participants, bill_events, bill_payers, bill_payments,
--   bill_payment_flags -> bills, cascade; claims -> line_items and -> bill_participants, cascade;
--   bill_seen, bill_not_part, bill_payments, bill_payment_flags -> bill_participants, cascade;
--   bills -> bill_participants (id, payer_id) and bill_payers -> bill_participants: no action,
--   DEFERRABLE INITIALLY DEFERRED (checked at commit, when both sides are gone).
--   Nothing references expenses, expense_shares, group_payments or group_hidden except the above.
-- RESTRICT is checked at each row delete, so the restrict children go first, in this order:
--   1. expense_shares  2. expenses  3. group_payments (before the bills: they point at them)
--   4. bills of the group (their children cascade)  5. group_hidden
--   6. groups (cascades group_members, whose restrict children are gone, and group_events).
-- Triggers on that path, each checked on its live body:
--   * group_events_append_only and bill_events_append_only allow a DELETE once the parent group /
--     bill row is gone, which is the case in a cascade from that parent. No new exception added,
--     and no trigger is disabled (A2.3).
--   * bill_participants_keep_members (BEFORE DELETE) passes when the bill is gone.
--   * bill_participants_reset_payer (BEFORE DELETE) returns at its first read when the bill is
--     gone, with no lock.
--   * log_claim_event (AFTER DELETE on claims) returns when the line item is gone, or when the
--     participant row is gone, whichever cascade deletes the claim. No bill_events insert.
--   * claims_lock_bill_first and claims_clear_not_part fire on INSERT only.
--   * The statement-level broadcast triggers on bill_participants, claims, bill_payers,
--     bill_payments and bill_payment_flags send one "changed" hint per bill topic. An open bill
--     screen refetches and gets no access.
--   * expenses, expense_shares, group_payments, group_hidden, groups, group_members: no triggers.
--
-- ===========================================================================================
-- LOCK ORDER (contract L; rule from 20261126082511_groups.sql: the group row, then bills
-- ascending, then bill_participants, then claims). Implicit locks count: an INSERT takes FOR KEY
-- SHARE on every row its FKs point at; a DELETE takes FOR UPDATE on its row and its cascades on
-- the children; FOR UPDATE conflicts with every row lock mode, FOR KEY SHARE with FOR UPDATE only.
-- ===========================================================================================
-- delete_group: 0-1 no lock. 2. groups row FOR UPDATE: waits for every transaction holding any
--   lock on it (rename/leave/join/attach/detach: NO KEY UPDATE; rotate: FOR UPDATE; the money
--   writes below: KEY SHARE; any group_events / group_members / bills.group_id insert's FK: KEY
--   SHARE), so the fingerprint read in step 5 sees what they committed. While it waits it holds
--   nothing. 3. bills of the group FOR UPDATE, ascending id: waits for the bill-level writers
--   (below). 5-6 reads. 7. row deletes; the last one (groups) cascades to the group_members rows.
--
-- Why the money writes now lock the group (B2a, the reason this migration re-creates them):
-- before, add_expense / edit_expense / delete_expense / record_payment / undo_payment took no group
-- lock. They first wrote their own rows (KEY SHARE on group_members rows through the FKs of the
-- expenses / expense_shares / group_payments inserts, or a row lock on the expense or payment)
-- and reached the group row only at the end, through the FK of their group_events insert. Against
-- a hard delete that is the B2a deadlock of 20261126082511_groups.sql: the writer holds a member
-- row (or its expense / payment row) and waits for the group row; delete_group holds the group row
-- FOR UPDATE and waits, in its deletes, for that member / expense / payment row -> 40P01. Its
-- fingerprint couldn't see the writer's uncommitted rows either. With the group row taken FOR
-- KEY SHARE first:
--   * a writer that got its KEY SHARE before delete_group's FOR UPDATE makes delete_group wait
--     until it commits; the fingerprint then includes it -> 22023 group_changed (A2.5);
--   * a writer that comes after waits for delete_group to commit; READ COMMITTED's locking read
--     then finds the row gone -> 42501 not_allowed (the existing "no such group" answer).
-- KEY SHARE doesn't conflict with leave_group's / join_group's / attach's NO KEY UPDATE, so the
-- B2a reasoning in the T2 header (leave_group x edit_expense) still holds: no new wait there.
-- rotate_group_code (FOR UPDATE) now makes a money write wait at its first lock instead of at its
-- event insert; rotate holds nothing a money write holds, so there's no cycle.
--
-- The walk: every function and trigger that locks a group row or a bill of a group, against
-- "delete_group holds the group FOR UPDATE, then waits for bills, then for its deletes' rows". A
-- cycle needs a path that holds a lock delete_group waits for and then waits for a lock
-- delete_group holds.
--   add_expense        0. checks (no lock). 1. groups KEY SHARE (new) -> waits for delete_group
--                      or makes it wait; holds nothing before. 2. INSERT expenses / expense_shares:
--                      KEY SHARE on group_members rows. 3. INSERT group_events (group row, held).
--                      No bill lock. No cycle.
--   edit_expense       0. checks (no lock). 1. groups KEY SHARE (new). 2. expenses row FOR NO
--                      KEY UPDATE. 3. expense_shares delete / insert (member rows KEY SHARE).
--                      4. UPDATE expenses. 5. event. No cycle.
--   delete_expense     0. checks. 1. groups KEY SHARE (new). 2. expenses row FOR NO KEY UPDATE.
--                      3. UPDATE. 4. event. No cycle.
--   record_payment     0. checks. 1. groups KEY SHARE (new). 2. INSERT group_payments (member rows
--                      KEY SHARE; bill_id is never sent by clients, so no bill lock). 3. event.
--   undo_payment       0. checks. 1. groups KEY SHARE (new). 2. group_payments row FOR NO KEY
--                      UPDATE. 3. UPDATE. 4. event. No cycle.
--   attach_bill_to_group  groups FOR NO KEY UPDATE first, then the bill FOR UPDATE, then members /
--                      participants / group_payments / events. Group first: waits for, or makes
--                      wait, delete_group at the group row; never holds a bill before. After a
--                      delete it re-checks membership under the locks -> 42501.
--   detach_bill_from_group  bills.group_id read unlocked, then groups FOR NO KEY UPDATE, then the
--                      bill FOR UPDATE. Group first. After a delete the bill is gone -> its loop
--                      finds no row -> 42501.
--   join_group         groups (by code) FOR NO KEY UPDATE first, then bills KEY SHARE ascending.
--                      Group first. After a delete the code finds no row -> P0002 invalid_code.
--   leave_group        groups FOR NO KEY UPDATE first, then bills FOR UPDATE ascending. Same order
--                      as delete_group; they queue at the group row.
--   rename_group       groups FOR NO KEY UPDATE first. rotate_group_code: groups FOR UPDATE first.
--   set_group_hidden   no group lock: INSERT group_hidden takes KEY SHARE on the caller's member
--                      row, and never waits for the group or a bill. delete_group's final cascade
--                      may wait for it to commit (then cascades the new hidden row). No cycle.
--   group_snapshot, my_groups, my_bills: no locks.
--   set_claim, set_item_split, assign_item, set_not_part, a direct claims insert (through
--   claims_lock_bill_first): the bill FOR KEY SHARE first, then line item / participant / claims
--   rows; they read group_members without a lock and never lock the group row or a member row.
--   update_bill, set_payer, set_payers, set_extras_split: the bill FOR UPDATE first (set_payers
--   refuses a group bill with 22023 in_group); set_payer's payer change takes KEY SHARE on the new
--   payer's group_members row through bills_group_payer_member_fkey, but delete_group touches
--   member rows only after it holds every bill, so it waits for set_payer at the bill, not the
--   reverse.
--   mark_paid and the other bill_payments writers: the bill FOR SHARE first; on a group bill the
--   bill_payments_no_group trigger refuses (22023 in_group).
--   So every bill-level writer either finishes before delete_group gets its bill, or waits at the
--   bill and then finds it gone (lock_bill_key_share locks no row, and the insert's FK fails:
--   the existing not-found answers, A2.5). None of them waits for the group row: no cycle.
--
-- Known cycle, accepted (the admin-only account-deletion path; before-production item): deleting
-- an auth user cascades profiles -> bill_participants first (constraint oid order), and the
-- payer-reset trigger then locks a bill FOR UPDATE when that person pays it; a later action of the
-- same cascade, groups.created_by set null, updates the group row (FOR NO KEY UPDATE). The cascade
-- then fails anyway at group_members' RESTRICT for a member. If the person created the group and
-- pays one of its bills, that path holds a group bill and then waits for the group row: a 40P01
-- with delete_group (group FOR UPDATE, then bills) and, already today, with leave_group (group FOR
-- NO KEY UPDATE, then bills FOR UPDATE). Postgres aborts one side; nothing half-applies, and the
-- loser can retry. No account-deletion feature exists yet; it must take group locks first (or
-- retry on 40P01). A hard delete removes the group's member rows, so the deleted group no longer
-- blocks its members' account deletion (A2.6).
--
-- Not testable in pgTAP (one session): a real two-session race. delete_group.test.sql checks the
-- order of the statements in each body instead; the two-connection race is run live (T1 report).
--
-- ===========================================================================================
-- Columns clients can't read
-- ===========================================================================================
-- None new and none changed. No table or grant changes; group_snapshot returns one more key.
--
-- ===========================================================================================
-- Errors (delete_group)
-- ===========================================================================================
--   42501 not_allowed       signed out; null id; not a member; no such group (deleted included)
--   42501 permission denied anon (or any role but authenticated) executing it
--   22023 group_changed     fingerprint null, malformed or stale; or a 23503 in the deletes
--   22023 receipts_waiting  a bill of the group is waiting (contract W)
-- The five money writes: unchanged, plus 42501 not_allowed when the group is deleted while they
-- wait for its row.

begin;

-- ---------------------------------------------------------------------------
-- private.group_bill_waiting (contract W)
-- ---------------------------------------------------------------------------
create function private.group_bill_waiting(p_bill_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select not private.bill_is_complete(p_bill_id)
      or private.bill_all_zero(p_bill_id)
      -- A2.10: equal mode, nobody can carry the extras (no claim on any item row), extras <> 0.
      or coalesce((
        select b.extras_split = 'equal'
           and b.total_cents::bigint
               - coalesce((select sum(li.total_cents)::bigint from public.line_items as li
                           where li.bill_id = b.id), 0) <> 0
           and not exists (
             select 1
             from public.claims as c
             join public.line_items as li on li.id = c.line_item_id
             where li.bill_id = b.id and li.kind = 'item')
        from public.bills as b
        where b.id = p_bill_id), false);
$$;

comment on function private.group_bill_waiting(uuid) is
  'Delete group, contract W: a group bill is waiting (lib C-G1: not fully claimed, or nobody can '
  'carry its extras). Not executable by clients.';

alter function private.group_bill_waiting(uuid) owner to postgres;
revoke execute on function private.group_bill_waiting(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.group_money_fingerprint (contract F)
-- ---------------------------------------------------------------------------
create function private.group_money_fingerprint(p_group_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(jsonb_build_object(
    'members', coalesce((
      select jsonb_agg(m.user_id order by m.user_id)
      from public.group_members as m
      where m.group_id = p_group_id), '[]'::jsonb),
    'bills', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', b.id,
               'payer_id', b.payer_id,
               'total_cents', b.total_cents,
               'extras_split', b.extras_split,
               'rows', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'id', li.id,
                          'total_cents', li.total_cents,
                          'kind', li.kind,
                          'claims', coalesce((
                            select jsonb_object_agg(c.user_id::text, c.parts)
                            from public.claims as c
                            where c.line_item_id = li.id), '{}'::jsonb))
                        order by li.id)
                 from public.line_items as li
                 where li.bill_id = b.id), '[]'::jsonb))
             order by b.id)
      from public.bills as b
      where b.group_id = p_group_id), '[]'::jsonb),
    'expenses', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'version', e.version) order by e.id)
      from public.expenses as e
      where e.group_id = p_group_id and e.deleted_at is null), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(gp.id order by gp.id)
      from public.group_payments as gp
      where gp.group_id = p_group_id and gp.undone_at is null), '[]'::jsonb)
  )::text);
$$;

comment on function private.group_money_fingerprint(uuid) is
  'Delete group, contract F: md5 of every input groupBalances reads for one group. Returned by '
  'group_snapshot as money_fingerprint and compared by delete_group. Not executable by clients.';

alter function private.group_money_fingerprint(uuid) owner to postgres;
revoke execute on function private.group_money_fingerprint(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- public.group_snapshot: re-created; adds "money_fingerprint" (contract F, criterion 11)
-- ---------------------------------------------------------------------------
-- Shape as documented in 20261127061004_group_snapshot.sql and 20261127150000_bill_not_part.sql,
-- plus the top-level key "money_fingerprint": 32 lowercase hex characters, computed in the same
-- statement as the rest. A deleted group no longer exists, so its former members get the existing
-- 42501 not_allowed (A2.4, A2.9). Still one statement, no row locks.
create or replace function public.group_snapshot(p_group_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_out jsonb;
begin
  -- One statement: the membership check and the payload read one snapshot. (A stable plpgsql
  -- function also runs every statement on the calling query's snapshot.)
  select jsonb_build_object(
    'group', jsonb_build_object(
      'id', g.id,
      'name', g.name,
      'join_code', g.join_code,
      'created_by', g.created_by,
      'created_at', g.created_at),
    'me', jsonb_build_object(
      'hidden', exists (
        select 1 from public.group_hidden as h
        where h.group_id = g.id and h.user_id = v_uid),
      'not_part_bill_ids', coalesce((
        select jsonb_agg(np.bill_id order by np.bill_id)
        from public.bill_not_part as np
        join public.bills as nb on nb.id = np.bill_id
        where np.user_id = v_uid and nb.group_id = g.id), '[]'::jsonb)),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', m.user_id,
               'display_name', p.display_name,
               'venmo_username', p.venmo_username,
               'joined_at', m.joined_at)
             order by m.joined_at, m.user_id)
      from public.group_members as m
      join public.profiles as p on p.id = m.user_id
      where m.group_id = g.id), '[]'::jsonb),
    'bills', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', b.id,
               'host_id', b.host_id,
               'payer_id', b.payer_id,
               'total_cents', b.total_cents,
               'extras_split', b.extras_split,
               'created_at', b.created_at,
               'rows', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'id', li.id,
                          'total_cents', li.total_cents,
                          'kind', li.kind,
                          'name', case when rc.claims is null then li.name end,
                          'claims', coalesce(rc.claims, '{}'::jsonb))
                        order by li.group_position, li.unit_index)
                 from public.line_items as li
                 left join lateral (
                   select jsonb_object_agg(c.user_id::text, c.parts) as claims
                   from public.claims as c
                   where c.line_item_id = li.id
                 ) as rc on true
                 where li.bill_id = b.id), '[]'::jsonb),
               'participant_ids', coalesce((
                 select jsonb_agg(bp.user_id order by bp.user_id)
                 from public.bill_participants as bp
                 where bp.bill_id = b.id), '[]'::jsonb))
             order by b.created_at, b.id)
      from public.bills as b
      where b.group_id = g.id), '[]'::jsonb),
    'expenses', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', e.id,
               'title', e.title,
               'payer_id', e.payer_id,
               'amount_cents', e.amount_cents,
               'split_method', e.split_method,
               'created_by', e.created_by,
               'created_at', e.created_at,
               'edited_at', e.edited_at,
               'version', e.version,
               'shares', coalesce((
                 select jsonb_agg(jsonb_build_object('user_id', s.user_id, 'cents', s.cents)
                                  order by s.user_id)
                 from public.expense_shares as s
                 where s.expense_id = e.id), '[]'::jsonb))
             order by e.created_at, e.id)
      from public.expenses as e
      where e.group_id = g.id and e.deleted_at is null), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', gp.id,
               'from_user', gp.from_user,
               'to_user', gp.to_user,
               'cents', gp.cents,
               'method', gp.method,
               'source', gp.source,
               'recorded_by', gp.recorded_by,
               'bill_id', gp.bill_id,
               'created_at', gp.created_at)
             order by gp.created_at, gp.id)
      from public.group_payments as gp
      where gp.group_id = g.id and gp.undone_at is null), '[]'::jsonb),
    'not_received', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', nr.id,
               'from', nr.from_user,
               'to', nr.to_user,
               'cents', nr.cents,
               'method', nr.method,
               'undone_at', nr.undone_at)
             order by nr.undone_at desc, nr.id)
      from public.group_payments as nr
      where nr.group_id = g.id
        and nr.undone_reason = 'not_received'
        and nr.undone_at > now() - interval '30 days'
        and (nr.from_user = v_uid or nr.to_user = v_uid)), '[]'::jsonb),
    -- Contract F, on this statement's snapshot (a stable function called here sees it).
    'money_fingerprint', private.group_money_fingerprint(g.id)
  )
  into v_out
  from public.groups as g
  where g.id = p_group_id
    and v_uid is not null
    and exists (
      select 1 from public.group_members as me
      where me.group_id = g.id and me.user_id = v_uid);

  if v_out is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  return v_out;
end;
$$;

comment on function public.group_snapshot(uuid) is
  'Groups MVP (C-G11 + A1.7 + GR-M6) + group claim status (C4: me.not_part_bill_ids) + delete '
  'group (contract F: money_fingerprint): one jsonb snapshot of a group for a member; 42501 '
  'otherwise.';

revoke execute on function public.group_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.group_snapshot(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- public.delete_group (contract D as amended by A2)
-- ---------------------------------------------------------------------------
create function public.delete_group(p_group_id uuid, p_fingerprint text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  -- 0. Signed out or no id.
  if v_uid is null or p_group_id is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  -- 1. Who may act, before any lock (lessons 2026-11-24, R4).
  if not exists (
    select 1 from public.group_members as gm
    where gm.group_id = p_group_id and gm.user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  -- 2. The group row FOR UPDATE (DG-13): waits for every in-flight group write, including the
  --    money writes' FOR KEY SHARE, so step 5 sees what they committed.
  perform 1 from public.groups as g where g.id = p_group_id for update;
  if not found then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  -- 3. Every bill of the group FOR UPDATE, ascending id (claims, edits, payer changes wait).
  perform 1
  from public.bills as b
  where b.group_id = p_group_id
  order by b.id
  for update of b;

  -- 4. Membership re-read under the locks.
  if not exists (
    select 1 from public.group_members as gm
    where gm.group_id = p_group_id and gm.user_id = v_uid
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  -- 5. The screen judged "settled" on exactly this money state (contract F).
  if p_fingerprint is null
     or p_fingerprint !~ '^[0-9a-f]{32}$'
     or p_fingerprint <> private.group_money_fingerprint(p_group_id) then
    raise exception using errcode = '22023', message = 'group_changed';
  end if;

  -- 6. No waiting receipt (contract W, the same rule as lib).
  if exists (
    select 1 from public.bills as b
    where b.group_id = p_group_id and private.group_bill_waiting(b.id)
  ) then
    raise exception using errcode = '22023', message = 'receipts_waiting';
  end if;

  -- 7. The deletes, restrict children first (A2.1; FK list in the header).
  begin
    delete from public.expense_shares as s where s.group_id = p_group_id;
    delete from public.expenses as x where x.group_id = p_group_id;
    delete from public.group_payments as gp where gp.group_id = p_group_id;
    delete from public.bills as b where b.group_id = p_group_id;
    delete from public.group_hidden as h where h.group_id = p_group_id;
    delete from public.groups as g where g.id = p_group_id;
  exception when foreign_key_violation then
    -- Unreachable while every writer follows contract L; a clean answer rather than a 23503.
    raise exception using errcode = '22023', message = 'group_changed';
  end;
end;
$$;

comment on function public.delete_group(uuid, text) is
  'Delete group (A2): any member, with the snapshot''s money_fingerprint; refused while a receipt '
  'is waiting. Removes the group, its expenses, payments, receipts, hidden rows, members and '
  'events. 42501 not_allowed; 22023 group_changed / receipts_waiting.';

alter function public.delete_group(uuid, text) owner to postgres;
-- service_role: revoked too. Nothing legitimate calls it without a signed-in member (auth.uid()
-- would be null -> 42501 anyway; lesson 2026-11-28 R3).
revoke execute on function public.delete_group(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.delete_group(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- public.add_expense (re-created from 20261126085945_group_expenses.sql; only the group lock added)
-- ---------------------------------------------------------------------------
create or replace function public.add_expense(
  p_id uuid,
  p_group_id uuid,
  p_title text,
  p_payer_id uuid,
  p_amount_cents bigint,
  p_method text,
  p_shares jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_title text := private.group_name(p_title);
  v_split jsonb;
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
  perform private.check_expense_fields(v_title, p_amount_cents, p_method);
  if not exists (
    select 1 from public.group_members as gm
    where gm.group_id = p_group_id and gm.user_id = p_payer_id
  ) then
    raise exception using errcode = '22023', message = 'not_member';
  end if;
  v_split := private.expense_split(p_group_id, p_amount_cents, p_method, p_shares);

  -- Lock order (delete group, A2.5): the group row first, in key-share mode; gone -> not_allowed.
  perform 1 from public.groups as g where g.id = p_group_id for key share;
  if not found then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  begin
    insert into public.expenses (id, group_id, title, payer_id, amount_cents, split_method, created_by)
    values (p_id, p_group_id, v_title, p_payer_id, p_amount_cents::integer, p_method, v_uid)
    on conflict (id) do nothing
    returning id into v_inserted;

    if v_inserted is not null then
      insert into public.expense_shares (expense_id, group_id, user_id, cents)
      select p_id, p_group_id, e.key::uuid, (e.value #>> '{}')::integer
      from jsonb_each(v_split) as e;
    end if;
  exception when foreign_key_violation then
    -- The payer, a share user or the caller left after the checks above.
    raise exception using errcode = '22023', message = 'not_member';
  end;

  if v_inserted is null then
    -- The id exists: a retry, or a clash.
    if exists (
      select 1 from public.expenses as x
      where x.id = p_id
        and x.group_id = p_group_id
        and x.created_by = v_uid
        and x.title = v_title
        and x.payer_id = p_payer_id
        and x.amount_cents = p_amount_cents
        and x.split_method = p_method
        and (select jsonb_object_agg(s.user_id::text, s.cents)
             from public.expense_shares as s where s.expense_id = x.id) = v_split
    ) then
      return;
    end if;
    raise exception using errcode = '22023', message = 'id_conflict';
  end if;

  perform private.log_group_event(p_group_id, v_uid, 'expense_added',
    jsonb_build_object('expense_id', p_id, 'title', v_title, 'amount_cents', p_amount_cents));
end;
$$;

-- ---------------------------------------------------------------------------
-- public.edit_expense (re-created from 20261126085945_group_expenses.sql; only the group lock added)
-- ---------------------------------------------------------------------------
create or replace function public.edit_expense(
  p_id uuid,
  p_expected_version integer,
  p_title text,
  p_payer_id uuid,
  p_amount_cents bigint,
  p_method text,
  p_shares jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_title text := private.group_name(p_title);
  v_group_id uuid;
  v_split jsonb;
  v_row public.expenses%rowtype;
  v_stored jsonb;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  -- Who may act, before any lock.
  select x.group_id into v_group_id
  from public.expenses as x
  where x.id = p_id
    and (x.created_by = v_uid or x.payer_id = v_uid)
    and exists (
      select 1 from public.group_members as gm
      where gm.group_id = x.group_id and gm.user_id = v_uid
    );
  if v_group_id is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  perform private.check_expense_fields(v_title, p_amount_cents, p_method);
  if not exists (
    select 1 from public.group_members as gm
    where gm.group_id = v_group_id and gm.user_id = p_payer_id
  ) then
    raise exception using errcode = '22023', message = 'not_member';
  end if;
  v_split := private.expense_split(v_group_id, p_amount_cents, p_method, p_shares);

  -- Lock order (delete group, A2.5): the group row first, in key-share mode; gone -> not_allowed.
  perform 1 from public.groups as g where g.id = v_group_id for key share;
  if not found then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  select * into v_row from public.expenses as x where x.id = p_id for no key update;

  -- Re-check on the locked row (the payer may have changed meanwhile).
  if not (v_row.created_by = v_uid or v_row.payer_id = v_uid)
     or not exists (
       select 1 from public.group_members as gm
       where gm.group_id = v_group_id and gm.user_id = v_uid
     ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  if v_row.deleted_at is not null then
    raise exception using errcode = '22023', message = 'version_changed';
  end if;

  select jsonb_object_agg(s.user_id::text, s.cents) into v_stored
  from public.expense_shares as s where s.expense_id = p_id;

  if v_row.title = v_title
     and v_row.payer_id = p_payer_id
     and v_row.amount_cents = p_amount_cents
     and v_row.split_method = p_method
     and v_stored = v_split then
    return; -- nothing to change (or a retry of an edit that already landed)
  end if;

  if p_expected_version is null or v_row.version <> p_expected_version then
    raise exception using errcode = '22023', message = 'version_changed';
  end if;

  begin
    delete from public.expense_shares as s where s.expense_id = p_id;
    insert into public.expense_shares (expense_id, group_id, user_id, cents)
    select p_id, v_group_id, e.key::uuid, (e.value #>> '{}')::integer
    from jsonb_each(v_split) as e;
    update public.expenses as x
    set title = v_title,
        payer_id = p_payer_id,
        amount_cents = p_amount_cents::integer,
        split_method = p_method,
        version = x.version + 1,
        edited_at = now()
    where x.id = p_id;
  exception when foreign_key_violation then
    raise exception using errcode = '22023', message = 'not_member';
  end;

  perform private.log_group_event(v_group_id, v_uid, 'expense_edited',
    jsonb_build_object(
      'expense_id', p_id,
      'before', jsonb_build_object('title', v_row.title, 'amount_cents', v_row.amount_cents,
                                   'payer_id', v_row.payer_id, 'split_method', v_row.split_method),
      'after', jsonb_build_object('title', v_title, 'amount_cents', p_amount_cents,
                                  'payer_id', p_payer_id, 'split_method', p_method)));
end;
$$;

-- ---------------------------------------------------------------------------
-- public.delete_expense (re-created from 20261126085945_group_expenses.sql; only the group lock added)
-- ---------------------------------------------------------------------------
create or replace function public.delete_expense(p_id uuid, p_expected_version integer)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_group_id uuid;
  v_row public.expenses%rowtype;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  select x.group_id into v_group_id
  from public.expenses as x
  where x.id = p_id
    and (x.created_by = v_uid or x.payer_id = v_uid)
    and exists (
      select 1 from public.group_members as gm
      where gm.group_id = x.group_id and gm.user_id = v_uid
    );
  if v_group_id is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  -- Lock order (delete group, A2.5): the group row first, in key-share mode; gone -> not_allowed.
  perform 1 from public.groups as g where g.id = v_group_id for key share;
  if not found then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  select * into v_row from public.expenses as x where x.id = p_id for no key update;

  if not (v_row.created_by = v_uid or v_row.payer_id = v_uid)
     or not exists (
       select 1 from public.group_members as gm
       where gm.group_id = v_group_id and gm.user_id = v_uid
     ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  if v_row.deleted_at is not null then
    return; -- repeat: no-op
  end if;
  if p_expected_version is null or v_row.version <> p_expected_version then
    raise exception using errcode = '22023', message = 'version_changed';
  end if;

  update public.expenses as x
  set deleted_at = now(), deleted_by = v_uid
  where x.id = p_id;

  perform private.log_group_event(v_group_id, v_uid, 'expense_deleted',
    jsonb_build_object('expense_id', p_id, 'title', v_row.title, 'amount_cents', v_row.amount_cents));
end;
$$;

-- ---------------------------------------------------------------------------
-- public.record_payment (re-created from 20261126090704_group_payments.sql; only the group lock added)
-- ---------------------------------------------------------------------------
create or replace function public.record_payment(
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

  -- Lock order (delete group, A2.5): the group row first, in key-share mode; gone -> not_allowed.
  perform 1 from public.groups as g where g.id = p_group_id for key share;
  if not found then
    raise exception using errcode = '42501', message = 'not_allowed';
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
-- public.undo_payment (re-created from 20261126090704_group_payments.sql; the group lock added,
-- and the unlocked who-may-act read now also returns the payment's group id to lock)
-- ---------------------------------------------------------------------------
create or replace function public.undo_payment(p_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_group_id uuid;
  v_row public.group_payments%rowtype;
  v_reason text;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  -- Who may act, before any lock (same condition as before; it also names the group).
  select gp.group_id into v_group_id
  from public.group_payments as gp
  where gp.id = p_id
    and v_uid in (gp.from_user, gp.to_user)
    and exists (
      select 1 from public.group_members as gm
      where gm.group_id = gp.group_id and gm.user_id = v_uid
    );
  if v_group_id is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  -- Lock order (delete group, A2.5): the group row first, in key-share mode; gone -> not_allowed.
  perform 1 from public.groups as g where g.id = v_group_id for key share;
  if not found then
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
-- Execute grants for the re-created money writes (create or replace keeps them; restated)
-- ---------------------------------------------------------------------------
revoke execute on function public.add_expense(uuid, uuid, text, uuid, bigint, text, jsonb)
  from public, anon, authenticated;
revoke execute on function public.edit_expense(uuid, integer, text, uuid, bigint, text, jsonb)
  from public, anon, authenticated;
revoke execute on function public.delete_expense(uuid, integer) from public, anon, authenticated;
revoke execute on function public.record_payment(uuid, uuid, uuid, uuid, bigint, text, text)
  from public, anon, authenticated;
revoke execute on function public.undo_payment(uuid) from public, anon, authenticated;

grant execute on function public.add_expense(uuid, uuid, text, uuid, bigint, text, jsonb) to authenticated;
grant execute on function public.edit_expense(uuid, integer, text, uuid, bigint, text, jsonb) to authenticated;
grant execute on function public.delete_expense(uuid, integer) to authenticated;
grant execute on function public.record_payment(uuid, uuid, uuid, uuid, bigint, text, text) to authenticated;
grant execute on function public.undo_payment(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
