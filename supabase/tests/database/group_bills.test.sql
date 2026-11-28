-- pgTAP tests for the Groups T5 migration (20261127060131_group_bills.sql; spec
-- docs/specs/2026-11-26-groups-mvp.md criteria 25-34, 91-98, 117, Amendments A1 and A2; eng review
-- B1-B4, S1, S3, S8, S14, N3, N6).
--
-- Every assertion filters to the fixture users / groups / bills below (the local DB may hold real
-- data). Fixture user ids start with e5000000.
-- Users: Ana ..01 (creates G1, hosts B1/B2/B3/B4), Ben ..02 (B1's payer), Cy ..03 (marks B1, cash),
--   Dee ..04 (marks B1, then "not received"), Lee ..05 (member, no history; leaves), Sam ..06
--   (stranger to G1; creates G2), Kim ..07 (joins G1 after two bills are in), Max ..08 (claim-only
--   on B7), Hal ..0b (hosts B7 only), Pia ..0c (pays B7 only), Ned ..0d ($0.01 equal share),
--   Oz ..0e ($0 equal share), Uma ..0f / Vic ..10 (G4, no bills), Wes ..11 (G5, 50 members),
--   Xan ..12 (51st), 49 bulk users e5000000-0000-0000-0001-0000000000NN.
-- Groups: G1 ..a1 'Tahoe trip' (Ana), G2 ..a2 (Sam; Ana joins), G3 ..a3 (Sam only), G4 ..a4, G5 ..a5.

begin;

create extension if not exists pgtap with schema extensions;

select plan(97);

-- Who paid 4a (20261127140001): the mark columns moved off bill_participants into
-- public.bill_payments / bill_payment_flags. This temp view gives each participant's old columns
-- (their pair toward the bill's current payer, contract P; the flag to that payer) so the
-- readbacks below keep their shape. Read as the owner only (it is not granted to client roles).
create temp view bp_marks as
select bp.bill_id, bp.user_id, bp.added, bp.joined_at,
       case when ps.net > 0 then ps.mark_at end as settled_at,
       case when ps.net > 0 then ps.net::integer end as settled_cents,
       case when ps.net > 0 then ps.method end as settled_method,
       f.cents as not_received_cents, f.method as not_received_method, f.to_user as not_received_by
from public.bill_participants as bp
join public.bills as b on b.id = bp.bill_id
cross join lateral private.pair_state(bp.bill_id, bp.user_id, b.payer_id) as ps
left join public.bill_payment_flags as f
  on f.bill_id = bp.bill_id and f.from_user = bp.user_id and f.to_user = b.payer_id;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function pg_temp.u(p text) returns uuid language sql immutable as $$
  select ('e5000000-0000-0000-0000-0000000000' || p)::uuid
$$;
create function pg_temp.g(p text) returns uuid language sql immutable as $$
  select ('e5000000-0000-0000-0000-0000000000' || p)::uuid
$$;

create function pg_temp.act(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

create function pg_temp.body(p regprocedure) returns text language sql as $$
  select lower(prosrc) from pg_proc where oid = p
$$;

create function pg_temp.it(p_pos integer, p_name text, p_cents integer) returns jsonb
language sql immutable as $$
  select jsonb_build_object('name', p_name, 'note', null, 'group_position', p_pos,
    'unit_index', 0, 'group_size', 1, 'total_cents', p_cents);
$$;

create function pg_temp.bid(p_tag text) returns uuid language sql stable as
  $$ select current_setting('test.bill_' || p_tag)::uuid $$;
create function pg_temp.bcode(p_tag text) returns text language sql stable as
  $$ select b.join_code from public.bills as b where b.id = pg_temp.bid(p_tag) $$;
create function pg_temp.li(p_tag text, p_name text) returns uuid language sql stable as $$
  select li.id from public.line_items as li
  where li.bill_id = pg_temp.bid(p_tag) and li.name = p_name;
$$;
create function pg_temp.gcode(p_group uuid) returns text language sql stable as
  $$ select g.join_code from public.groups as g where g.id = p_group $$;

-- As p_user (authenticated): create a bill, then let each of p_joiners join it by link.
create function pg_temp.mk(p_tag text, p_host uuid, p_rows jsonb, p_tax integer, p_total integer,
                           p_joiners uuid[]) returns void language plpgsql as $$
declare r record; j uuid;
begin
  perform pg_temp.act(p_host);
  set local role authenticated;
  select * into r from public.create_bill(p_rows, null, p_tax, 0, 0, 0, 0, p_total);
  reset role;
  perform set_config('test.bill_' || p_tag, r.bill_id::text, true);
  foreach j in array coalesce(p_joiners, '{}'::uuid[]) loop
    perform pg_temp.act(j);
    set local role authenticated;
    perform public.join_bill(r.join_code);
    reset role;
  end loop;
end $$;

create function pg_temp.claim(p_user uuid, p_tag text, p_name text) returns void
language plpgsql as $$
begin
  perform pg_temp.act(p_user);
  set local role authenticated;
  perform public.set_claim(pg_temp.li(p_tag, p_name), true);
  reset role;
end $$;

create function pg_temp.join(p_user uuid, p_group uuid) returns void language plpgsql as $$
declare v_code text := pg_temp.gcode(p_group);
begin
  perform pg_temp.act(p_user);
  set local role authenticated;
  perform public.join_group(v_code);
  reset role;
end $$;

-- Run p_sql as p_user (authenticated). Used by lives_ok / throws_ok through pg_temp.as_sql.
create function pg_temp.as_sql(p_user uuid, p_sql text) returns text language sql immutable as $$
  select format(
    'select set_config(''request.jwt.claims'', %L, true); set local role authenticated; %s',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, p_sql)
$$;

create function pg_temp.bill_events(p_tag text, p_kind text) returns integer language sql as $$
  select count(*)::integer from public.bill_events as e
  where e.bill_id = pg_temp.bid(p_tag) and e.kind = p_kind
$$;
create function pg_temp.group_events(p_group uuid, p_kind text) returns integer language sql as $$
  select count(*)::integer from public.group_events as e
  where e.group_id = p_group and e.kind = p_kind
$$;
-- A fingerprint of every participant row of a bill (any column change shows).
-- (Who paid 4a: marks and flags live in bill_payments / bill_payment_flags, so the fingerprint
-- covers those rows too.)
create function pg_temp.bp_state(p_tag text) returns text language sql as $$
  select coalesce(md5(string_agg(bp::text, '|' order by bp.user_id)
                      || '#' || coalesce((select string_agg(e::text, '|' order by e.id)
                                          from public.bill_payments as e
                                          where e.bill_id = pg_temp.bid(p_tag)), '')
                      || '#' || coalesce((select string_agg(f::text, '|' order by f.from_user, f.to_user)
                                          from public.bill_payment_flags as f
                                          where f.bill_id = pg_temp.bid(p_tag)), '')), 'none')
  from public.bill_participants as bp where bp.bill_id = pg_temp.bid(p_tag)
$$;
-- Every member of p_group is a participant of the bill, and nobody else is.
create function pg_temp.members_are_participants(p_tag text, p_group uuid) returns boolean
language sql as $$
  select (select array_agg(gm.user_id order by gm.user_id) from public.group_members as gm
          where gm.group_id = p_group)
       = (select array_agg(bp.user_id order by bp.user_id) from public.bill_participants as bp
          where bp.bill_id = pg_temp.bid(p_tag))
$$;

-- ---------------------------------------------------------------------------
-- Fixture
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data)
select pg_temp.u(t.k), 'gbill-' || t.k || '@test.local', jsonb_build_object('full_name', t.n)
from (values ('01','Ana'),('02','Ben'),('03','Cy'),('04','Dee'),('05','Lee'),('06','Sam'),
             ('07','Kim'),('08','Max'),('0b','Hal'),('0c','Pia'),('0d','Ned'),('0e','Oz'),
             ('0f','Uma'),('10','Vic'),('11','Wes'),('12','Xan')) as t(k, n);
insert into auth.users (id, email, raw_user_meta_data)
select ('e5000000-0000-0000-0001-' || lpad(n::text, 12, '0'))::uuid,
       'gbill-bulk-' || n || '@test.local', jsonb_build_object('full_name', 'Bulk ' || n)
from generate_series(1, 49) as n;

-- Groups.
select pg_temp.act(pg_temp.u('01'));
set local role authenticated;
select public.create_group(pg_temp.g('a1'), 'Tahoe trip');
reset role;
select pg_temp.act(pg_temp.u('06'));
set local role authenticated;
select public.create_group(pg_temp.g('a2'), 'Sam group');
select public.create_group(pg_temp.g('a3'), 'Sam only');
reset role;
select pg_temp.act(pg_temp.u('0f'));
set local role authenticated;
select public.create_group(pg_temp.g('a4'), 'No bills');
reset role;
select pg_temp.act(pg_temp.u('11'));
set local role authenticated;
select public.create_group(pg_temp.g('a5'), 'Big group');
reset role;

select pg_temp.join(x, pg_temp.g('a1'))
from unnest(array[pg_temp.u('02'), pg_temp.u('03'), pg_temp.u('04'), pg_temp.u('05'),
                  pg_temp.u('08'), pg_temp.u('0b'), pg_temp.u('0c'), pg_temp.u('0d'),
                  pg_temp.u('0e')]) as x;
select pg_temp.join(pg_temp.u('01'), pg_temp.g('a2'));
select pg_temp.join(pg_temp.u('10'), pg_temp.g('a4'));
select pg_temp.join(('e5000000-0000-0000-0001-' || lpad(n::text, 12, '0'))::uuid, pg_temp.g('a5'))
from generate_series(1, 49) as n;

-- B1 (W5 brunch): Ana hosts; Ben pays; everything claimed; Cy marks 950 in cash; Dee marks 1300
-- by Venmo and Ben says it didn't arrive (Dee's row then carries not_received_*).
select pg_temp.mk('b1', pg_temp.u('01'),
  jsonb_build_array(pg_temp.it(0, 'A', 900), pg_temp.it(1, 'B', 1100), pg_temp.it(2, 'C', 700),
                    pg_temp.it(3, 'D', 1300)), 0, 4000,
  array[pg_temp.u('02'), pg_temp.u('03'), pg_temp.u('04')]);
select pg_temp.claim(pg_temp.u('01'), 'b1', 'A');
select pg_temp.claim(pg_temp.u('02'), 'b1', 'B');
select pg_temp.claim(pg_temp.u('03'), 'b1', 'C');
select pg_temp.claim(pg_temp.u('04'), 'b1', 'D');
select pg_temp.act(pg_temp.u('01'));
set local role authenticated;
select public.set_payer(pg_temp.bid('b1'), pg_temp.u('02'));
reset role;
select pg_temp.act(pg_temp.u('03'));
set local role authenticated;
select public.mark_paid(pg_temp.bid('b1'), pg_temp.u('02'), 950, 'cash');
reset role;
select pg_temp.act(pg_temp.u('04'));
set local role authenticated;
select public.mark_paid(pg_temp.bid('b1'), pg_temp.u('02'), 1300, 'venmo');
reset role;
select set_config('test.dee_at', (select bp.settled_at::text from pg_temp.bp_marks as bp
  where bp.bill_id = pg_temp.bid('b1') and bp.user_id = pg_temp.u('04')), true);
select pg_temp.act(pg_temp.u('02'));
set local role authenticated;
select public.mark_not_received(pg_temp.bid('b1'), pg_temp.u('04'), pg_temp.u('02'), 1300,
                                current_setting('test.dee_at')::timestamptz);
reset role;

-- B2: Ana hosts, Sam (not in G1) joined by link.
select pg_temp.mk('b2', pg_temp.u('01'), jsonb_build_array(pg_temp.it(0, 'Fries', 500)), 0, 500,
  array[pg_temp.u('06')]);

-- B3: Ana hosts, Ben joined; X claimed by Ana, Y unclaimed (incomplete). A mark is written as
-- postgres (mark_paid refuses incomplete bills), backdated so a rewrite would show.
select pg_temp.mk('b3', pg_temp.u('01'),
  jsonb_build_array(pg_temp.it(0, 'X', 1000), pg_temp.it(1, 'Y', 1000)), 0, 2000,
  array[pg_temp.u('02')]);
select pg_temp.claim(pg_temp.u('01'), 'b3', 'X');
insert into public.bill_payments (bill_id, from_user, to_user, cents, method, recorded_at, recorded_by)
values (pg_temp.bid('b3'), pg_temp.u('02'), pg_temp.u('01'), 1000, 'other',
        '2026-01-01 00:00:00+00', pg_temp.u('02'));

-- B4: all $0 rows, total 500 (tax), all claimed: rule Z. Ben's mark written as postgres.
select pg_temp.mk('b4', pg_temp.u('01'), jsonb_build_array(pg_temp.it(0, 'Water', 0)), 500, 500,
  array[pg_temp.u('02')]);
select pg_temp.claim(pg_temp.u('02'), 'b4', 'Water');
insert into public.bill_payments (bill_id, from_user, to_user, cents, method, recorded_at, recorded_by)
values (pg_temp.bid('b4'), pg_temp.u('02'), pg_temp.u('01'), 250, 'venmo',
        '2026-01-01 00:00:00+00', pg_temp.u('02'));

-- B7: Hal hosts, Pia pays, Max claims the only item (each a single history kind).
select pg_temp.mk('b7', pg_temp.u('0b'), jsonb_build_array(pg_temp.it(0, 'M', 800)), 0, 800,
  array[pg_temp.u('0c'), pg_temp.u('08')]);
select pg_temp.claim(pg_temp.u('08'), 'b7', 'M');
select pg_temp.act(pg_temp.u('0b'));
set local role authenticated;
select public.set_payer(pg_temp.bid('b7'), pg_temp.u('0c'));
reset role;

-- B6: a pre-SV mark without a method (Cy -> Ana), on a complete bill with Ana and Cy. Since who
-- paid 4a a ledger entry always has a method; 20261127140000's copy gave such marks 'other'
-- (coalesce), so the row is built the way the copy leaves it.
select pg_temp.mk('b6', pg_temp.u('01'), jsonb_build_array(pg_temp.it(0, 'Tea', 300)), 0, 300,
  array[pg_temp.u('03')]);
select pg_temp.claim(pg_temp.u('03'), 'b6', 'Tea');
insert into public.bill_payments (bill_id, from_user, to_user, cents, method, recorded_at, recorded_by)
values (pg_temp.bid('b6'), pg_temp.u('03'), pg_temp.u('01'), 300, 'other',
        '2026-01-01 00:00:00+00', pg_temp.u('03'));

-- ===========================================================================
-- Structure
-- ===========================================================================
select ok(
  (select a.attnotnull = false from pg_attribute as a
   where a.attrelid = 'public.bills'::regclass and a.attname = 'group_id')
  and exists (
    select 1 from pg_constraint as c
    where c.conrelid = 'public.bills'::regclass and c.contype = 'f'
      and c.confrelid = 'public.groups'::regclass and c.confdeltype = 'r'),
  'bills.group_id is nullable and references groups ON DELETE RESTRICT');

select ok(
  exists (
    select 1 from pg_constraint as c
    where c.conrelid = 'public.bills'::regclass and c.conname = 'bills_group_payer_member_fkey'
      and c.confrelid = 'public.group_members'::regclass and c.confdeltype = 'r'
      and pg_get_constraintdef(c.oid) like 'FOREIGN KEY (group_id, payer_id)%'),
  'S8: bills (group_id, payer_id) -> group_members ON DELETE RESTRICT');

select ok(
  exists (select 1 from pg_index as i where i.indrelid = 'public.bills'::regclass
          and (select a.attname from pg_attribute as a
               where a.attrelid = i.indrelid and a.attnum = i.indkey[0]) = 'group_id'),
  'bills has an index led by group_id');

select ok(
  (select count(*) = 4 and bool_and(t.tgtype & 2 = 2 and t.tgtype & 1 = 1)
   from pg_trigger as t
   where (t.tgrelid = 'public.bill_participants'::regclass
          and t.tgname in ('bill_participants_members_only', 'bill_participants_keep_members'))
      or (t.tgrelid = 'public.bill_payments'::regclass and t.tgname = 'bill_payments_no_group')
      or (t.tgrelid = 'public.bill_payment_flags'::regclass and t.tgname = 'bill_payment_flags_no_group')),
  'GR-10: the invariant triggers are BEFORE, ROW (two on bill_participants; the no-marks one moved to bill_payments and bill_payment_flags by who paid 4a)');

select ok(
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']) and count(*) = 10
   from pg_proc as p
   where p.oid in ('public.attach_bill_to_group(uuid, uuid)'::regprocedure,
                   'public.detach_bill_from_group(uuid)'::regprocedure,
                   'public.join_group(text)'::regprocedure,
                   'public.leave_group(uuid)'::regprocedure,
                   'public.add_participant(uuid, uuid)'::regprocedure,
                   'public.my_bills()'::regprocedure,
                   'public.people_i_split_with()'::regprocedure,
                   'private.bill_payments_no_group()'::regprocedure,
                   'private.bill_participants_members_only()'::regprocedure,
                   'private.bill_participants_keep_members()'::regprocedure)),
  'new and re-created functions are security definer with an empty search_path');

select ok(
  (select bool_and(has_function_privilege('authenticated', f, 'execute')
                   and not has_function_privilege('anon', f, 'execute'))
   from unnest(array['public.attach_bill_to_group(uuid, uuid)', 'public.detach_bill_from_group(uuid)',
                     'public.join_group(text)', 'public.leave_group(uuid)',
                     'public.add_participant(uuid, uuid)', 'public.my_bills()',
                     'public.people_i_split_with()']) as f)
  and (select bool_and(not has_function_privilege('authenticated', f, 'execute')
                       and not has_function_privilege('anon', f, 'execute'))
       from unnest(array['private.bill_payments_no_group()',
                         'private.bill_participants_members_only()',
                         'private.bill_participants_keep_members()', 'private.my_links()']) as f),
  'client functions: authenticated only; trigger functions and my_links: no client role');

select ok(
  pg_get_function_result('public.my_bills()'::regprocedure) =
    'TABLE(bill_id uuid, host_id uuid, host_name text, payer_id uuid, total_cents integer, '
    'created_at timestamp with time zone, joined_at timestamp with time zone, added boolean, '
    'seen boolean, claimed_any boolean, complete boolean, seen_at timestamp with time zone)',
  'criterion 91/32: my_bills() returns the same columns as Sent via Venmo''s version, seen_at included');

-- B4 (criterion 96): one bill_events row of every kind used anywhere in the migrations on disk.
-- Re-run by T7 (A1.11 S15): T7's assign_item migration adds assigned and unassigned (24 kinds).
select lives_ok(
  $$ insert into public.bill_events (bill_id, actor_id, kind, details)
     select current_setting('test.bill_b2')::uuid, null, k, '{}'::jsonb
     from unnest(array[
       'bill_created', 'joined', 'claimed', 'unclaimed', 'split_changed', 'item_added',
       'item_removed', 'item_changed', 'amounts_changed', 'link_rotated', 'extras_split_changed',
       'payer_changed', 'marked_paid', 'unmarked_paid',
       'participant_added', 'participant_removed', 'left',
       'paid_difference', 'paid_back', 'not_received',
       'moved_to_group', 'removed_from_group',
       'assigned', 'unassigned',
       'payers_changed']) as k $$,
  'criterion 96: a bill_events row of every known kind (25, incl. not_received, T5''s two, T7''s assigned / unassigned and who-paid''s payers_changed) inserts');

select throws_ok(
  $$ insert into public.bill_events (bill_id, actor_id, kind, details)
     values (current_setting('test.bill_b2')::uuid, null, 'no_such_kind', '{}'::jsonb) $$,
  '23514', null,
  'criterion 96 control: an unknown kind still fails bill_events_kind_known');

-- ===========================================================================
-- Criterion 34: lock order in the function bodies (static, as people_review_fixes.test.sql)
-- ===========================================================================
select ok(
  position('from public.group_members' in pg_temp.body('public.attach_bill_to_group(uuid, uuid)'))
    < position('for no key update' in pg_temp.body('public.attach_bill_to_group(uuid, uuid)'))
  and position('for no key update' in pg_temp.body('public.attach_bill_to_group(uuid, uuid)'))
    < position('for update of b' in pg_temp.body('public.attach_bill_to_group(uuid, uuid)'))
  and position('for update of b' in pg_temp.body('public.attach_bill_to_group(uuid, uuid)'))
    < position('from public.bill_payments' in pg_temp.body('public.attach_bill_to_group(uuid, uuid)'))
  and position('for update of b' in pg_temp.body('public.attach_bill_to_group(uuid, uuid)'))
    < position('update public.bills' in pg_temp.body('public.attach_bill_to_group(uuid, uuid)'))
  and position('update public.bills' in pg_temp.body('public.attach_bill_to_group(uuid, uuid)'))
    < position('insert into public.bill_participants' in pg_temp.body('public.attach_bill_to_group(uuid, uuid)'))
  and position('insert into public.group_payments' in pg_temp.body('public.attach_bill_to_group(uuid, uuid)'))
    < position('delete from public.bill_payments' in pg_temp.body('public.attach_bill_to_group(uuid, uuid)')),
  'criterion 34 (b)/(c): attach checks who may act, then locks the group, then the bill FOR UPDATE, then reads marks and writes');

select ok(
  position('from public.bills' in pg_temp.body('public.detach_bill_from_group(uuid)'))
    < position('for no key update' in pg_temp.body('public.detach_bill_from_group(uuid)'))
  and position('for no key update' in pg_temp.body('public.detach_bill_from_group(uuid)'))
    < position('for update of b' in pg_temp.body('public.detach_bill_from_group(uuid)'))
  and position('for update of b' in pg_temp.body('public.detach_bill_from_group(uuid)'))
    < position('from public.group_payments' in pg_temp.body('public.detach_bill_from_group(uuid)'))
  and position('from public.group_payments' in pg_temp.body('public.detach_bill_from_group(uuid)'))
    < position('update public.bills' in pg_temp.body('public.detach_bill_from_group(uuid)')),
  'criterion 34 (c): detach reads group_id unlocked, locks the group, then the bill, then checks and writes');

select ok(
  position('for no key update' in pg_temp.body('public.join_group(text)'))
    < position('for key share of b' in pg_temp.body('public.join_group(text)'))
  and position('for key share of b' in pg_temp.body('public.join_group(text)'))
    < position('insert into public.bill_participants' in pg_temp.body('public.join_group(text)')),
  'criterion 34 (b): join_group locks the group, then the bills in order, then inserts participant rows');

select ok(
  position('for no key update' in pg_temp.body('public.leave_group(uuid)'))
    < position('for update of b' in pg_temp.body('public.leave_group(uuid)'))
  and position('for update of b' in pg_temp.body('public.leave_group(uuid)'))
    < position('from public.claims' in pg_temp.body('public.leave_group(uuid)'))
  and position('from public.claims' in pg_temp.body('public.leave_group(uuid)'))
    < position('from public.expenses' in pg_temp.body('public.leave_group(uuid)'))
  and position('from public.expenses' in pg_temp.body('public.leave_group(uuid)'))
    < position('from public.group_payments' in pg_temp.body('public.leave_group(uuid)'))
  and position('from public.group_payments' in pg_temp.body('public.leave_group(uuid)'))
    < position('delete from public.group_members' in pg_temp.body('public.leave_group(uuid)'))
  and position('delete from public.group_members' in pg_temp.body('public.leave_group(uuid)'))
    < position('delete from public.bill_participants' in pg_temp.body('public.leave_group(uuid)')),
  'criterion 34 (d): leave_group locks the group, then all its bills, then checks history, then deletes membership, then participant rows');

-- ===========================================================================
-- Criterion 25: who may attach, and refusals
-- ===========================================================================
select throws_ok(
  pg_temp.as_sql(pg_temp.u('02'), format('select public.attach_bill_to_group(%L, %L)',
    pg_temp.bid('b1'), pg_temp.g('a1'))),
  '42501', 'not_allowed', 'criterion 25: a non-host member can''t attach the bill');

select throws_ok(
  pg_temp.as_sql(pg_temp.u('01'), format('select public.attach_bill_to_group(%L, %L)',
    pg_temp.bid('b1'), pg_temp.g('a3'))),
  '42501', 'not_allowed', 'criterion 25: the host can''t attach to a group they aren''t in');

select throws_ok(
  format('set local role anon; select public.attach_bill_to_group(%L, %L)',
    pg_temp.bid('b1'), pg_temp.g('a1')),
  '42501', null, 'anon can''t execute attach_bill_to_group');
reset role;

select throws_ok(
  pg_temp.as_sql(pg_temp.u('01'), format('select public.attach_bill_to_group(%L, %L)',
    pg_temp.bid('b2'), pg_temp.g('a1'))),
  '22023', 'participants_not_members', 'criterion 25: a bill with a participant outside the group');

-- Criterion 92 (S1b): marks on an incomplete or all-$0 bill.
select set_config('test.b3_before', pg_temp.bp_state('b3'), true);
select throws_ok(
  pg_temp.as_sql(pg_temp.u('01'), format('select public.attach_bill_to_group(%L, %L)',
    pg_temp.bid('b3'), pg_temp.g('a1'))),
  '22023', 'not_complete', 'criterion 92: an incomplete bill with a mark is refused');
select ok(
  (select b.group_id is null from public.bills as b where b.id = pg_temp.bid('b3'))
  and pg_temp.bp_state('b3') = current_setting('test.b3_before')
  and not exists (select 1 from public.group_payments as gp where gp.bill_id = pg_temp.bid('b3')),
  'criterion 92: nothing changes after the not_complete refusal');
select throws_ok(
  pg_temp.as_sql(pg_temp.u('01'), format('select public.attach_bill_to_group(%L, %L)',
    pg_temp.bid('b4'), pg_temp.g('a1'))),
  '22023', 'not_complete', 'criterion 92: an all-$0 bill with a mark is refused');

-- The same incomplete bill without marks attaches (B3, after clearing the mark as postgres).
delete from public.bill_payments as e where e.bill_id = pg_temp.bid('b3');
select lives_ok(
  pg_temp.as_sql(pg_temp.u('01'), format('select public.attach_bill_to_group(%L, %L)',
    pg_temp.bid('b3'), pg_temp.g('a1'))),
  'criterion 92: the incomplete bill without marks attaches');
reset role;
select ok(pg_temp.members_are_participants('b3', pg_temp.g('a1')),
  'criterion 94: after attach every member of the group is a participant of B3 (and nobody else)');

-- ===========================================================================
-- Criterion 26 / 91 / 117: attach W5 (B1)
-- ===========================================================================
select set_config('test.b1_joined', pg_temp.bill_events('b1', 'joined')::text, true);
select set_config('test.b1_added', pg_temp.bill_events('b1', 'participant_added')::text, true);

select lives_ok(
  pg_temp.as_sql(pg_temp.u('01'), format('select public.attach_bill_to_group(%L, %L)',
    pg_temp.bid('b1'), pg_temp.g('a1'))),
  'criterion 26: the host attaches the brunch bill to Tahoe trip');
reset role;

select is(
  (select b.group_id from public.bills as b where b.id = pg_temp.bid('b1')),
  pg_temp.g('a1'), 'criterion 26: group_id is set');

select ok(pg_temp.members_are_participants('b1', pg_temp.g('a1')),
  'criterion 26/94: after attach every member is a participant of B1');

select ok(
  (select bool_and(not bp.added) and count(*) = 6 from public.bill_participants as bp
   where bp.bill_id = pg_temp.bid('b1')
     and bp.user_id in (pg_temp.u('05'), pg_temp.u('08'), pg_temp.u('0b'), pg_temp.u('0c'),
                        pg_temp.u('0d'), pg_temp.u('0e'))),
  'criterion 26: members the group added are participants with added = false (GR-11)');

select ok(
  not exists (select 1 from public.bill_payments as e where e.bill_id = pg_temp.bid('b1'))
  and not exists (select 1 from public.bill_payment_flags as f where f.bill_id = pg_temp.bid('b1')),
  'criterion 91: B1 has no bill_payments entry and no flag left (Cy''s cash mark and Dee''s not-received flag included)');

select results_eq(
  format($$ select gp.group_id, gp.from_user, gp.to_user, gp.cents, gp.method, gp.source,
                   gp.recorded_by, gp.undone_at
            from public.group_payments as gp where gp.bill_id = %L $$, pg_temp.bid('b1')),
  format($$ values (%L::uuid, %L::uuid, %L::uuid, 950, 'cash'::text, 'bill_mark'::text, %L::uuid,
                    null::timestamptz) $$,
    pg_temp.g('a1'), pg_temp.u('03'), pg_temp.u('02'), pg_temp.u('03')),
  'criterion 26/117: exactly one payment: Cy -> Ben 950, method cash, source bill_mark, recorded by Cy');

select is(
  (select count(*)::integer from public.group_events as e
   where e.group_id = pg_temp.g('a1') and e.kind = 'bill_added'
     and e.details = jsonb_build_object('bill_id', pg_temp.bid('b1'), 'converted', 1)
     and e.actor_id = pg_temp.u('01')),
  1, 'criterion 26: one bill_added {bill_id, converted: 1} group event by the host');

select is(
  (select count(*)::integer from public.bill_events as e
   where e.bill_id = pg_temp.bid('b1') and e.kind = 'moved_to_group'
     and e.details = jsonb_build_object('group_id', pg_temp.g('a1'), 'converted', 1)
     and e.actor_id = pg_temp.u('01')),
  1, 'criterion 26: one moved_to_group {group_id, converted: 1} bill event by the host');

select ok(
  pg_temp.bill_events('b1', 'joined') = current_setting('test.b1_joined')::integer
  and pg_temp.bill_events('b1', 'participant_added') = current_setting('test.b1_added')::integer,
  'criterion 26: no joined / participant_added bill events for the members the group added');

select is(
  (select e.details from public.bill_events as e
   where e.bill_id = pg_temp.bid('b3') and e.kind = 'moved_to_group'),
  jsonb_build_object('group_id', pg_temp.g('a1'), 'converted', 0),
  'B3 logged moved_to_group with converted 0');

-- Criterion 117: a pre-SV mark without a method converts with method 'other'.
select lives_ok(
  pg_temp.as_sql(pg_temp.u('01'), format('select public.attach_bill_to_group(%L, %L)',
    pg_temp.bid('b6'), pg_temp.g('a1'))),
  'criterion 117: a bill whose mark has no method attaches');
reset role;
select is(
  (select gp.method from public.group_payments as gp where gp.bill_id = pg_temp.bid('b6')),
  'other', 'criterion 117: the payment from a mark without a method has method other');

-- Criterion 93 (S3): retries.
select set_config('test.b1_state', pg_temp.bp_state('b1'), true);
select lives_ok(
  pg_temp.as_sql(pg_temp.u('01'), format('select public.attach_bill_to_group(%L, %L)',
    pg_temp.bid('b1'), pg_temp.g('a1'))),
  'criterion 93: attaching to the same group again succeeds');
reset role;
select ok(
  pg_temp.bill_events('b1', 'moved_to_group') = 1
  and (select count(*) from public.group_events as e where e.group_id = pg_temp.g('a1')
       and e.kind = 'bill_added' and e.details ->> 'bill_id' = pg_temp.bid('b1')::text) = 1
  and (select count(*) from public.group_payments as gp where gp.bill_id = pg_temp.bid('b1')) = 1
  and pg_temp.bp_state('b1') = current_setting('test.b1_state'),
  'criterion 93: the retry adds no event, no payment and changes no participant row');
select throws_ok(
  pg_temp.as_sql(pg_temp.u('01'), format('select public.attach_bill_to_group(%L, %L)',
    pg_temp.bid('b1'), pg_temp.g('a2'))),
  '22023', 'already_in_group', 'criterion 25/93: attaching to another group is refused');

-- ===========================================================================
-- Criterion 27 (B3): no call ever leaves a mark on a group bill
-- ===========================================================================
-- Backdate joined_at so any rewrite of a row shows in the fingerprint.
update public.bill_participants as bp set joined_at = '2026-01-02 00:00:00+00'
where bp.bill_id = pg_temp.bid('b1');
select set_config('test.b1_state', pg_temp.bp_state('b1'), true);

select throws_ok(
  pg_temp.as_sql(pg_temp.u('03'), format('select public.mark_paid(%L, %L, 950, ''venmo'')',
    pg_temp.bid('b1'), pg_temp.u('02'))),
  '22023', 'in_group', 'criterion 27: mark_paid on a complete group bill raises in_group');
select throws_ok(
  pg_temp.as_sql(pg_temp.u('03'), format(
    'select public.settle_difference(%L, %L, %L, 950, 1000, ''venmo'')',
    pg_temp.bid('b1'), pg_temp.u('03'), pg_temp.u('02'))),
  '22023', 'mark_changed', 'criterion 27: settle_difference (more) on a group bill raises mark_changed');
select lives_ok(
  pg_temp.as_sql(pg_temp.u('02'), format(
    'select public.settle_difference(%L, %L, %L, 950, 0, ''venmo'')',
    pg_temp.bid('b1'), pg_temp.u('03'), pg_temp.u('02'))),
  'criterion 27: settle_difference back to 0 on a group bill is a no-op');
reset role;
select lives_ok(
  pg_temp.as_sql(pg_temp.u('03'), format('select public.unmark_paid(%L, %L, %L)',
    pg_temp.bid('b1'), pg_temp.u('03'), pg_temp.u('02'))),
  'criterion 27: unmark_paid on a group bill is a no-op');
reset role;
select throws_ok(
  pg_temp.as_sql(pg_temp.u('02'), format(
    'select public.mark_not_received(%L, %L, %L, 950, now())',
    pg_temp.bid('b1'), pg_temp.u('03'), pg_temp.u('02'))),
  '22023', 'mark_changed', 'criterion 27: mark_not_received on a group bill raises mark_changed');
select is(pg_temp.bp_state('b1'), current_setting('test.b1_state'),
  'criterion 27: no participant row of the group bill changed');
select throws_ok(
  format($$ insert into public.bill_payments (bill_id, from_user, to_user, cents, method, recorded_by)
            values (%L, %L, %L, 100, 'other', %L) $$,
    pg_temp.bid('b1'), pg_temp.u('03'), pg_temp.u('02'), pg_temp.u('03')),
  '22023', 'in_group', 'criterion 27: the trigger itself refuses a postgres-role payment on a group bill');
select throws_ok(
  format($$ insert into public.bill_payment_flags (bill_id, from_user, to_user, cents, method)
            values (%L, %L, %L, 100, 'venmo') $$,
    pg_temp.bid('b1'), pg_temp.u('03'), pg_temp.u('02')),
  '22023', 'in_group', 'the trigger also refuses a not-received flag on a group bill');

-- ===========================================================================
-- Criterion 28: membership functions on a group bill
-- ===========================================================================
select throws_ok(
  pg_temp.as_sql(pg_temp.u('06'), format('select public.join_bill(%L)', pg_temp.bcode('b1'))),
  '22023', 'in_group', 'criterion 28: join_bill by a non-member raises in_group');
select lives_ok(
  pg_temp.as_sql(pg_temp.u('05'), format('select public.join_bill(%L)', pg_temp.bcode('b1'))),
  'join_bill by a member already on the bill still succeeds (no-op)');
reset role;
select throws_ok(
  pg_temp.as_sql(pg_temp.u('01'), format('select public.add_participant(%L, %L)',
    pg_temp.bid('b1'), pg_temp.u('05'))),
  '22023', 'in_group', 'criterion 28: add_participant of a member raises in_group');
select throws_ok(
  pg_temp.as_sql(pg_temp.u('01'), format('select public.add_participant(%L, %L)',
    pg_temp.bid('b1'), pg_temp.u('06'))),
  '22023', 'in_group', 'criterion 28: add_participant of a non-member raises in_group');
select throws_ok(
  pg_temp.as_sql(pg_temp.u('01'), format('select public.remove_participant(%L, %L)',
    pg_temp.bid('b1'), pg_temp.u('05'))),
  '22023', 'in_group', 'criterion 28: remove_participant of a member raises in_group');
select throws_ok(
  pg_temp.as_sql(pg_temp.u('05'), format('select public.leave_bill(%L)', pg_temp.bid('b1'))),
  '22023', 'in_group', 'criterion 28: leave_bill by a member raises in_group');
select is(pg_temp.bp_state('b1'), current_setting('test.b1_state'),
  'criterion 28: no participant row changed');

-- Non-group bills keep the old behaviour (B2 is not in a group).
select lives_ok(
  pg_temp.as_sql(pg_temp.u('06'), format('select public.leave_bill(%L)', pg_temp.bid('b2'))),
  'leave_bill on a non-group bill still works');
reset role;

-- ===========================================================================
-- Criterion 29 / 94: joining a group with bills, and the repeat-join repair (N6)
-- ===========================================================================
select set_config('test.ev_b1', (select count(*)::text from public.bill_events as e
  where e.bill_id = pg_temp.bid('b1')), true);
select set_config('test.ev_b3', (select count(*)::text from public.bill_events as e
  where e.bill_id = pg_temp.bid('b3')), true);
select pg_temp.join(pg_temp.u('07'), pg_temp.g('a1'));

select ok(
  (select count(*) = 3 and bool_and(not bp.added) from public.bill_participants as bp
   where bp.user_id = pg_temp.u('07')
     and bp.bill_id in (pg_temp.bid('b1'), pg_temp.bid('b3'), pg_temp.bid('b6'))),
  'criterion 29: join_group adds the joiner to every bill of the group, added = false');
select ok(
  (select count(*) from public.bill_events as e where e.bill_id = pg_temp.bid('b1'))
    = current_setting('test.ev_b1')::bigint
  and (select count(*) from public.bill_events as e where e.bill_id = pg_temp.bid('b3'))
    = current_setting('test.ev_b3')::bigint,
  'criterion 29: no bill events for the joiner');
select is(
  (select count(*)::integer from public.group_events as e
   where e.group_id = pg_temp.g('a1') and e.kind = 'member_joined' and e.actor_id = pg_temp.u('07')),
  1, 'criterion 29: one member_joined for Kim');

select pg_temp.act(pg_temp.u('07'));
set local role authenticated;
select ok(
  (select count(*) from public.line_items as li
   where li.bill_id in (pg_temp.bid('b1'), pg_temp.bid('b3'))) = 6
  and (select count(*) from public.claims as c where c.bill_id = pg_temp.bid('b1')) = 4,
  'criterion 29: the joiner can read both bills'' rows and claims');
reset role;

select ok(pg_temp.members_are_participants('b1', pg_temp.g('a1'))
          and pg_temp.members_are_participants('b3', pg_temp.g('a1')),
  'criterion 94: still every member on every group bill after a join');

-- Repair: delete Kim's B1 row with triggers off (as postgres), then Kim joins again.
set constraints all immediate;
set constraints all deferred;
alter table public.bill_participants disable trigger bill_participants_keep_members;
delete from public.bill_participants as bp
where bp.bill_id = pg_temp.bid('b1') and bp.user_id = pg_temp.u('07');
set constraints all immediate;
set constraints all deferred;
alter table public.bill_participants enable trigger bill_participants_keep_members;
select set_config('test.gev', (select count(*)::text from public.group_events as e
  where e.group_id = pg_temp.g('a1')), true);
select pg_temp.join(pg_temp.u('07'), pg_temp.g('a1'));
select ok(
  exists (select 1 from public.bill_participants as bp
          where bp.bill_id = pg_temp.bid('b1') and bp.user_id = pg_temp.u('07') and not bp.added)
  and (select count(*) from public.group_events as e where e.group_id = pg_temp.g('a1'))
    = current_setting('test.gev')::bigint
  and (select count(*) from public.bill_events as e where e.bill_id = pg_temp.bid('b1'))
    = current_setting('test.ev_b1')::bigint,
  'criterion 94 (N6): a repeat join_group restores the missing participant row with no events');

-- ===========================================================================
-- Criterion 97: the 50-member cap
-- ===========================================================================
select is((select count(*)::integer from public.group_members as gm
           where gm.group_id = pg_temp.g('a5')), 50, 'G5 has 50 members');
select throws_ok(
  pg_temp.as_sql(pg_temp.u('12'), format('select public.join_group(%L)', pg_temp.gcode(pg_temp.g('a5')))),
  '22023', 'group_full', 'criterion 97: join_group on a 50-member group raises group_full');
select lives_ok(
  pg_temp.as_sql(pg_temp.u('11'), format('select public.join_group(%L)', pg_temp.gcode(pg_temp.g('a5')))),
  'a current member re-joining a full group still succeeds (T2 order kept)');
reset role;
select throws_ok(
  pg_temp.as_sql(pg_temp.u('12'), $$ select public.join_group('00000000000000000000') $$),
  'P0002', 'invalid_code', 'join_group with an unknown code is still P0002 invalid_code');

-- ===========================================================================
-- Criterion 31 / 95: leave_group with bill history
-- ===========================================================================
select lives_ok(
  pg_temp.as_sql(pg_temp.u('0b'), format('select public.attach_bill_to_group(%L, %L)',
    pg_temp.bid('b7'), pg_temp.g('a1'))),
  'Hal attaches B7 (host, no claims, Pia pays, Max claims)');
reset role;
select throws_ok(
  pg_temp.as_sql(pg_temp.u('0b'), format('select public.leave_group(%L)', pg_temp.g('a1'))),
  '22023', 'cannot_leave', 'criterion 31: the host of a group bill can''t leave');
select throws_ok(
  pg_temp.as_sql(pg_temp.u('0c'), format('select public.leave_group(%L)', pg_temp.g('a1'))),
  '22023', 'cannot_leave', 'criterion 31: the payer of a group bill can''t leave');
select throws_ok(
  pg_temp.as_sql(pg_temp.u('08'), format('select public.leave_group(%L)', pg_temp.g('a1'))),
  '22023', 'cannot_leave', 'criterion 31: someone with one claim on a group bill can''t leave');

-- N3 (criterion 95): Ana adds an equal $0.01 expense among Ned and Oz: Ned 1, Oz 0.
select lives_ok(
  pg_temp.as_sql(pg_temp.u('01'), format(
    $q$ select public.add_expense('e5000000-0000-0000-0002-000000000001', %L, 'Gum', %L, 1,
        'equal', jsonb_build_object(%L, 1, %L, 1)) $q$,
    pg_temp.g('a1'), pg_temp.u('01'), pg_temp.u('0d'), pg_temp.u('0e'))),
  'fixture: a $0.01 equal expense among Ned and Oz');
reset role;
select throws_ok(
  pg_temp.as_sql(pg_temp.u('0d'), format('select public.leave_group(%L)', pg_temp.g('a1'))),
  '22023', 'cannot_leave', 'criterion 95: a member with a $0.01 share can''t leave');

-- What must not change when people leave: other people's claims, shares and payments in G1.
select set_config('test.others', (
  select md5(
    coalesce((select string_agg(c::text, '|' order by c.line_item_id, c.user_id) from public.claims as c
              join public.bills as b on b.id = c.bill_id where b.group_id = pg_temp.g('a1')), '') ||
    coalesce((select string_agg(s::text, '|' order by s.expense_id, s.user_id) from public.expense_shares as s
              where s.group_id = pg_temp.g('a1') and s.user_id <> pg_temp.u('0e')), '') ||
    coalesce((select string_agg(gp::text, '|' order by gp.id) from public.group_payments as gp
              where gp.group_id = pg_temp.g('a1')), ''))), true);

select lives_ok(
  pg_temp.as_sql(pg_temp.u('0e'), format('select public.leave_group(%L)', pg_temp.g('a1'))),
  'criterion 95: a member whose only history is a $0 equal share can leave');
reset role;

select set_config('test.lee_events', pg_temp.group_events(pg_temp.g('a1'), 'member_left')::text, true);
select lives_ok(
  pg_temp.as_sql(pg_temp.u('05'), format('select public.leave_group(%L)', pg_temp.g('a1'))),
  'criterion 31: Lee (no history) leaves');
reset role;
select ok(
  not exists (select 1 from public.group_members as gm
              where gm.group_id = pg_temp.g('a1') and gm.user_id in (pg_temp.u('05'), pg_temp.u('0e')))
  and not exists (select 1 from public.bill_participants as bp
                  join public.bills as b on b.id = bp.bill_id
                  where b.group_id = pg_temp.g('a1') and bp.user_id in (pg_temp.u('05'), pg_temp.u('0e'))),
  'criterion 31: leaving deletes the membership and every participant row on the group''s bills');
select is(pg_temp.group_events(pg_temp.g('a1'), 'member_left')
            - current_setting('test.lee_events')::integer,
  1, 'criterion 31: one member_left for Lee');
select is(
  (select count(*)::integer from public.group_events as e where e.group_id = pg_temp.g('a1')
   and e.kind = 'member_left' and e.actor_id in (pg_temp.u('05'), pg_temp.u('0e'))),
  2, 'criterion 31: exactly one member_left each for Oz and Lee');
select is(
  (select md5(
    coalesce((select string_agg(c::text, '|' order by c.line_item_id, c.user_id) from public.claims as c
              join public.bills as b on b.id = c.bill_id where b.group_id = pg_temp.g('a1')), '') ||
    coalesce((select string_agg(s::text, '|' order by s.expense_id, s.user_id) from public.expense_shares as s
              where s.group_id = pg_temp.g('a1') and s.user_id <> pg_temp.u('0e')), '') ||
    coalesce((select string_agg(gp::text, '|' order by gp.id) from public.group_payments as gp
              where gp.group_id = pg_temp.g('a1')), ''))),
  current_setting('test.others'),
  'criterion 31: no other member''s claims, shares or payments changed');
select ok(pg_temp.members_are_participants('b1', pg_temp.g('a1'))
          and pg_temp.members_are_participants('b7', pg_temp.g('a1')),
  'criterion 94: after leaves, participants of each group bill are still exactly the members');

-- ===========================================================================
-- Criterion 98 (S8): restrict FKs
-- ===========================================================================
select throws_ok(
  format('delete from public.profiles where id = %L', pg_temp.u('0d')),
  '23503', null, 'criterion 98: a group member''s profile can''t be deleted');
select lives_ok(
  pg_temp.as_sql(pg_temp.u('01'), format('select public.set_payer(%L, %L)',
    pg_temp.bid('b3'), pg_temp.u('02'))),
  'criterion 98: set_payer on a group bill to a member works');
reset role;
select throws_ok(
  format('update public.bills set payer_id = %L where id = %L', pg_temp.u('06'), pg_temp.bid('b3')),
  '23503', null, 'criterion 98: the composite FK refuses a group bill payer who isn''t a member');
select lives_ok(
  format($$ update public.bills set payer_id = %L where id = %L;
            set constraints bills_payer_participant_fkey immediate $$,
    pg_temp.u('02'), pg_temp.bid('b4')),
  'criterion 98: the composite FK doesn''t affect non-group bills (Ben pays B4)');
set constraints bills_payer_participant_fkey deferred;

-- ===========================================================================
-- Criterion 33: people_i_split_with and group links
-- ===========================================================================
select pg_temp.act(pg_temp.u('0f'));
set local role authenticated;
select results_eq(
  format($$ select p.shared_bills, p.last_shared_at from public.people_i_split_with() as p
            where p.user_id = %L $$, pg_temp.u('10')),
  format($$ select 0, gm.joined_at from public.group_members as gm
            where gm.group_id = %L and gm.user_id = %L $$, pg_temp.g('a4'), pg_temp.u('10')),
  'criterion 33: a co-member with no shared bill shows with shared_bills = 0 and the later joined_at');
select is(
  (select count(*)::integer from public.people_i_split_with() as p where p.user_id = pg_temp.u('06')),
  0, 'criterion 33: a stranger doesn''t appear');
reset role;
select pg_temp.act(pg_temp.u('01'));
set local role authenticated;
select is(
  (select p.shared_bills from public.people_i_split_with() as p where p.user_id = pg_temp.u('02')),
  5, 'criterion 33: Ana and Ben: shared_bills counts the 5 distinct bills (B1, B3, B4, B6, B7); the group link adds nothing');
reset role;
select lives_ok(
  pg_temp.as_sql(pg_temp.u('10'), format('select public.leave_group(%L)', pg_temp.g('a4'))),
  'Vic leaves G4');
reset role;
select pg_temp.act(pg_temp.u('0f'));
set local role authenticated;
select is(
  (select count(*)::integer from public.people_i_split_with() as p where p.user_id = pg_temp.u('10')),
  0, 'criterion 33: after leaving the group (no shared bills) Vic no longer appears');
reset role;
select lives_ok(
  format('delete from public.profiles where id = %L', pg_temp.u('10')),
  'criterion 98: after leaving, Vic''s profile can be deleted');

-- ===========================================================================
-- Criterion 32: my_bills
-- ===========================================================================
select pg_temp.act(pg_temp.u('01'));
set local role authenticated;
select ok(
  not exists (select 1 from public.my_bills() as m
              where m.bill_id in (pg_temp.bid('b1'), pg_temp.bid('b3')))
  and exists (select 1 from public.my_bills() as m where m.bill_id = pg_temp.bid('b2')),
  'criterion 32: my_bills() hides group bills and still lists the non-group bill');
reset role;

-- ===========================================================================
-- Criterion 30: detach
-- ===========================================================================
select throws_ok(
  pg_temp.as_sql(pg_temp.u('02'), format('select public.detach_bill_from_group(%L)', pg_temp.bid('b1'))),
  '42501', 'not_allowed', 'criterion 30: a non-host can''t detach');
select throws_ok(
  pg_temp.as_sql(pg_temp.u('01'), format('select public.detach_bill_from_group(%L)', pg_temp.bid('b1'))),
  '22023', 'has_bill_payments', 'criterion 30: a live bill_mark payment from the bill blocks detach');
select lives_ok(
  pg_temp.as_sql(pg_temp.u('03'), format('select public.undo_payment(%L)',
    (select gp.id from public.group_payments as gp where gp.bill_id = pg_temp.bid('b1')))),
  'Cy undoes the converted payment');
reset role;
select set_config('test.b1_people', (select string_agg(bp.user_id::text, ',' order by bp.user_id)
  from public.bill_participants as bp where bp.bill_id = pg_temp.bid('b1')), true);
select lives_ok(
  pg_temp.as_sql(pg_temp.u('01'), format('select public.detach_bill_from_group(%L)', pg_temp.bid('b1'))),
  'criterion 30: after the undo, detach succeeds');
reset role;
select ok(
  (select b.group_id is null from public.bills as b where b.id = pg_temp.bid('b1'))
  and (select string_agg(bp.user_id::text, ',' order by bp.user_id)
       from public.bill_participants as bp where bp.bill_id = pg_temp.bid('b1'))
      = current_setting('test.b1_people'),
  'criterion 30: group_id is null and every participant stays (N7)');
select ok(
  (select count(*) from public.group_events as e where e.group_id = pg_temp.g('a1')
   and e.kind = 'bill_removed' and e.details = jsonb_build_object('bill_id', pg_temp.bid('b1'))
   and e.actor_id = pg_temp.u('01')) = 1
  and (select count(*) from public.bill_events as e where e.bill_id = pg_temp.bid('b1')
       and e.kind = 'removed_from_group' and e.details = jsonb_build_object('group_id', pg_temp.g('a1'))
       and e.actor_id = pg_temp.u('01')) = 1,
  'criterion 30: one bill_removed {bill_id} and one removed_from_group {group_id}');
select lives_ok(
  pg_temp.as_sql(pg_temp.u('01'), format('select public.detach_bill_from_group(%L)', pg_temp.bid('b1'))),
  'detach on a bill that is no longer in a group is a no-op success');
reset role;
select is(pg_temp.bill_events('b1', 'removed_from_group'), 1, 'the repeat detach logs nothing');

select pg_temp.act(pg_temp.u('01'));
set local role authenticated;
select ok(exists (select 1 from public.my_bills() as m where m.bill_id = pg_temp.bid('b1')),
  'criterion 32: after detach my_bills() lists the bill again');
reset role;

-- After detach the bill behaves like any bill: a mark is allowed again.
select lives_ok(
  pg_temp.as_sql(pg_temp.u('03'), format('select public.mark_paid(%L, %L, 950, ''venmo'')',
    pg_temp.bid('b1'), pg_temp.u('02'))),
  'after detach, mark_paid works on the bill again');
reset role;

select * from finish();
rollback;
