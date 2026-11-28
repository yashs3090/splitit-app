-- pgTAP tests for the Groups T3 migration (20261126085945_group_expenses.sql; spec
-- docs/specs/2026-11-26-groups-mvp.md criteria 16-21, 34, 95, 99, 100, 101, 113, Amendment A1).
--
-- Every assertion filters to the fixture users / groups / expenses below (the local DB may hold
-- real data). Fixture ids all start with e3.
-- Users (id order = name order): Ana ..01 (creates G1), Ben ..02, Cy ..03, Dee ..04, Eve ..05
--   (member, never creator or payer), Sam ..06 (stranger to G1; creates G2), Flo ..07 (leaves with
--   only a $0 share), Gus ..08 (has a $0.01 share, can't leave), Hal ..09 (payer of a deleted
--   expense), Ivy ..0a (share user of a deleted expense), Jo ..0b (creator of a deleted expense).
--   X01..X20 e3000000-0000-0000-0001-0000000000NN: the 20 members of G20 (A6).
-- Groups: G1 ..a1 'Tahoe trip'; G2 ..a2 (Sam's, for the composite FK); G20 ..a3.
-- Expenses: e3000000-0000-0000-0002-0000000000NN.
-- The shared rows (A1-A10, X1-X8, C-G6 and the A1.12 trim rows) are the same as
-- lib/groupExpense.test.ts.

begin;

create extension if not exists pgtap with schema extensions;

select plan(144);

create function pg_temp.act(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

create function pg_temp.signed_out() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
end $$;

-- The stored shares of one expense as an ordered array of cents by user id (read as postgres).
create function pg_temp.cents(p_expense uuid) returns integer[] language sql as $$
  select array_agg(s.cents order by s.user_id::text collate "C")
  from public.expense_shares as s where s.expense_id = p_expense
$$;

create function pg_temp.events(p_group uuid, p_kind text, p_expense uuid) returns integer
language sql as $$
  select count(*)::integer from public.group_events as e
  where e.group_id = p_group and e.kind = p_kind and e.details ->> 'expense_id' = p_expense::text
$$;

create function pg_temp.body(p regprocedure) returns text language sql as $$
  select lower(prosrc) from pg_proc where oid = p
$$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('e3000000-0000-0000-0000-000000000001', 'gexp-a@test.local', '{"full_name":"Ana"}'::jsonb),
  ('e3000000-0000-0000-0000-000000000002', 'gexp-b@test.local', '{"full_name":"Ben"}'::jsonb),
  ('e3000000-0000-0000-0000-000000000003', 'gexp-c@test.local', '{"full_name":"Cy"}'::jsonb),
  ('e3000000-0000-0000-0000-000000000004', 'gexp-d@test.local', '{"full_name":"Dee"}'::jsonb),
  ('e3000000-0000-0000-0000-000000000005', 'gexp-e@test.local', '{"full_name":"Eve"}'::jsonb),
  ('e3000000-0000-0000-0000-000000000006', 'gexp-s@test.local', '{"full_name":"Sam"}'::jsonb),
  ('e3000000-0000-0000-0000-000000000007', 'gexp-f@test.local', '{"full_name":"Flo"}'::jsonb),
  ('e3000000-0000-0000-0000-000000000008', 'gexp-g@test.local', '{"full_name":"Gus"}'::jsonb),
  ('e3000000-0000-0000-0000-000000000009', 'gexp-h@test.local', '{"full_name":"Hal"}'::jsonb),
  ('e3000000-0000-0000-0000-00000000000a', 'gexp-i@test.local', '{"full_name":"Ivy"}'::jsonb),
  ('e3000000-0000-0000-0000-00000000000b', 'gexp-j@test.local', '{"full_name":"Jo"}'::jsonb);

insert into auth.users (id, email, raw_user_meta_data)
select ('e3000000-0000-0000-0001-' || lpad(i::text, 12, '0'))::uuid,
       'gexp-x' || i || '@test.local',
       jsonb_build_object('full_name', 'X' || i)
from generate_series(1, 20) as i;

-- Groups through the real functions.
select pg_temp.act('e3000000-0000-0000-0000-000000000001');
set local role authenticated;
select public.create_group('e3000000-0000-0000-0000-0000000000a1', 'Tahoe trip');
reset role;
select pg_temp.act('e3000000-0000-0000-0000-000000000006');
set local role authenticated;
select public.create_group('e3000000-0000-0000-0000-0000000000a2', 'Other group');
reset role;
select pg_temp.act('e3000000-0000-0000-0001-000000000001');
set local role authenticated;
select public.create_group('e3000000-0000-0000-0000-0000000000a3', 'Twenty');
reset role;

select set_config('test.code1',
  (select join_code from public.groups where id = 'e3000000-0000-0000-0000-0000000000a1'), true);
select set_config('test.code20',
  (select join_code from public.groups where id = 'e3000000-0000-0000-0000-0000000000a3'), true);

create function pg_temp.join(p_user uuid, p_code text) returns void language plpgsql as $$
begin
  perform pg_temp.act(p_user);
  set local role authenticated;
  perform public.join_group(p_code);
  reset role;
end $$;

select pg_temp.join(u, current_setting('test.code1'))
from unnest(array[
  'e3000000-0000-0000-0000-000000000002', 'e3000000-0000-0000-0000-000000000003',
  'e3000000-0000-0000-0000-000000000004', 'e3000000-0000-0000-0000-000000000005',
  'e3000000-0000-0000-0000-000000000007', 'e3000000-0000-0000-0000-000000000008',
  'e3000000-0000-0000-0000-000000000009', 'e3000000-0000-0000-0000-00000000000a',
  'e3000000-0000-0000-0000-00000000000b']::uuid[]) as u;
select pg_temp.join(('e3000000-0000-0000-0001-' || lpad(i::text, 12, '0'))::uuid,
                    current_setting('test.code20'))
from generate_series(2, 20) as i;

-- ===========================================================================
-- Structure: RLS, grants, function settings
-- ===========================================================================
select ok(
  (select bool_and(c.relrowsecurity) and count(*) = 2 from pg_class as c
   where c.oid in ('public.expenses'::regclass, 'public.expense_shares'::regclass)),
  'RLS is enabled on expenses and expense_shares');

select ok(
  not exists (
    select 1 from unnest(array['public.expenses', 'public.expense_shares']) as t(name)
    where has_table_privilege('anon', t.name, 'select, insert, update, delete, truncate, references, trigger')
       or has_any_column_privilege('anon', t.name, 'select, insert, update, references')
       or has_table_privilege('public', t.name, 'select, insert, update, delete, truncate, references, trigger')),
  'anon and public hold no privilege on expenses or expense_shares');

select ok(
  has_table_privilege('authenticated', 'public.expenses', 'select')
  and has_table_privilege('authenticated', 'public.expense_shares', 'select')
  and not exists (
    select 1 from unnest(array['public.expenses', 'public.expense_shares']) as t(name)
    where has_table_privilege('authenticated', t.name, 'insert, update, delete, truncate, references, trigger')
       or has_any_column_privilege('authenticated', t.name, 'insert, update, references')),
  'authenticated has exactly SELECT on expenses and expense_shares');

select ok(
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']) and count(*) = 4
   from pg_proc as p
   where p.oid in ('public.add_expense(uuid, uuid, text, uuid, bigint, text, jsonb)'::regprocedure,
                   'public.edit_expense(uuid, integer, text, uuid, bigint, text, jsonb)'::regprocedure,
                   'public.delete_expense(uuid, integer)'::regprocedure,
                   'public.leave_group(uuid)'::regprocedure))
  and (select bool_and(not p.prosecdef and p.proconfig @> array['search_path=""']) and count(*) = 3
       from pg_proc as p
       where p.oid in ('private.allocate(bigint, integer[])'::regprocedure,
                       'private.expense_split(uuid, bigint, text, jsonb)'::regprocedure,
                       'private.check_expense_fields(text, bigint, text)'::regprocedure)),
  'public functions are security definer; private helpers are invoker; all have an empty search_path');

select ok(
  (select bool_and(has_function_privilege('authenticated', f, 'execute')
                   and not has_function_privilege('anon', f, 'execute'))
   from unnest(array['public.add_expense(uuid, uuid, text, uuid, bigint, text, jsonb)',
                     'public.edit_expense(uuid, integer, text, uuid, bigint, text, jsonb)',
                     'public.delete_expense(uuid, integer)', 'public.leave_group(uuid)']) as f)
  and not exists (
    select 1 from pg_proc as p, aclexplode(p.proacl) as a
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('add_expense', 'edit_expense', 'delete_expense', 'leave_group')
      and a.grantee in (0::oid, 'anon'::regrole::oid))
  and not exists (
    select 1 from unnest(array['private.allocate(bigint, integer[])',
                               'private.expense_split(uuid, bigint, text, jsonb)',
                               'private.check_expense_fields(text, bigint, text)']) as f
    where has_function_privilege('authenticated', f, 'execute')
       or has_function_privilege('anon', f, 'execute')),
  'only authenticated may execute the expense functions; no client may call the private helpers');

-- ===========================================================================
-- Criterion 16: private.allocate, A1-A10 (plus lib's sign and empty cases)
-- ===========================================================================
select is(private.allocate(100, '{1}'), '{100}'::integer[], 'A1: allocate(100, [1]) = [100]');
select is(private.allocate(100, '{1,1,1}'), '{34,33,33}'::integer[], 'A2: allocate(100, [1,1,1]) = [34,33,33]');
select is(private.allocate(1, '{1,1,1}'), '{1,0,0}'::integer[], 'A3: allocate(1, [1,1,1]) = [1,0,0]');
select is(private.allocate(24000, '{1,1,1,1}'), '{6000,6000,6000,6000}'::integer[], 'A4: 24000 among 4 = 6000 each');
select is(private.allocate(1001, '{1,1,1,1}'), '{251,250,250,250}'::integer[], 'A5: 1001 among 4 = [251,250,250,250]');
select is(private.allocate(99999999, array_fill(1, array[20])),
  array_fill(5000000, array[19]) || 4999999, 'A6: 99,999,999 among 20 = 19 x 5,000,000 then 4,999,999');
select is(private.allocate(99999999, '{1,1}'), '{50000000,49999999}'::integer[], 'A7: 99,999,999 among 2');
select is(private.allocate(3, '{1,0,1}'), '{2,0,1}'::integer[], 'A9: allocate(3, [1,0,1]) = [2,0,1]');
select throws_ok($$ select private.allocate(5, '{0,0}') $$, '22023', 'invalid_shares',
  'A10: allocate(5, [0,0]) is refused with 22023 invalid_shares');
select ok(
  private.allocate(-100, '{1,1,1}') = '{-34,-33,-33}'::integer[]
  and private.allocate(0, '{}') = '{}'::integer[]
  and private.allocate(0, '{0,0}') = '{0,0}'::integer[]
  and private.allocate(7, '{3,1,2}') = '{4,1,2}'::integer[]
  and private.allocate(10, '{1,1,1}') = '{4,3,3}'::integer[],
  'allocate matches lib: negative amounts mirror, 0 over [] and [0,0], weighted remainders');
select throws_ok($$ select private.allocate(5, '{1,-1}') $$, '22023', 'invalid_shares',
  'allocate refuses a negative weight');
select throws_ok($$ select private.allocate(5, '{}') $$, '22023', 'invalid_shares',
  'allocate refuses an amount over no weights');

-- ===========================================================================
-- Criterion 16: add_expense equal stores the A1-A8 cents, one row per chosen user
-- ===========================================================================
select pg_temp.act('e3000000-0000-0000-0000-000000000001');
set local role authenticated;
select lives_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000001',
  'e3000000-0000-0000-0000-0000000000a1', 'A1', 'e3000000-0000-0000-0000-000000000001', 100, 'equal',
  '{"e3000000-0000-0000-0000-000000000001": 1}') $$, 'A1 via add_expense');
select lives_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000002',
  'e3000000-0000-0000-0000-0000000000a1', 'A2', 'e3000000-0000-0000-0000-000000000001', 100, 'equal',
  '{"e3000000-0000-0000-0000-000000000001": 1, "e3000000-0000-0000-0000-000000000002": 1,
    "e3000000-0000-0000-0000-000000000003": 1}') $$, 'A2 via add_expense');
select lives_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000003',
  'e3000000-0000-0000-0000-0000000000a1', 'A3', 'e3000000-0000-0000-0000-000000000001', 1, 'equal',
  '{"e3000000-0000-0000-0000-000000000001": 1, "e3000000-0000-0000-0000-000000000002": 1,
    "e3000000-0000-0000-0000-000000000003": 1}') $$, 'A3 via add_expense');
select lives_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000004',
  'e3000000-0000-0000-0000-0000000000a1', 'Airbnb', 'e3000000-0000-0000-0000-000000000001', 24000, 'equal',
  '{"e3000000-0000-0000-0000-000000000001": 1, "e3000000-0000-0000-0000-000000000002": 1,
    "e3000000-0000-0000-0000-000000000003": 1, "e3000000-0000-0000-0000-000000000004": 1}') $$,
  'A4 (Airbnb) via add_expense');
select lives_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000005',
  'e3000000-0000-0000-0000-0000000000a1', 'A5', 'e3000000-0000-0000-0000-000000000002', 1001, 'equal',
  '{"e3000000-0000-0000-0000-000000000001": 1, "e3000000-0000-0000-0000-000000000002": 1,
    "e3000000-0000-0000-0000-000000000003": 1, "e3000000-0000-0000-0000-000000000004": 1}') $$,
  'A5 via add_expense (payer Ben)');
select lives_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000007',
  'e3000000-0000-0000-0000-0000000000a1', 'A7', 'e3000000-0000-0000-0000-000000000001', 99999999, 'equal',
  '{"e3000000-0000-0000-0000-000000000001": 1, "e3000000-0000-0000-0000-000000000002": 1}') $$,
  'A7 via add_expense');
select lives_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000008',
  'e3000000-0000-0000-0000-0000000000a1', 'A8', 'e3000000-0000-0000-0000-000000000001', 100, 'equal',
  '{"e3000000-0000-0000-0000-000000000003": 1, "e3000000-0000-0000-0000-000000000002": 1,
    "e3000000-0000-0000-0000-000000000001": 1}') $$, 'A8 via add_expense (users sent in reverse)');
reset role;

select pg_temp.act('e3000000-0000-0000-0001-000000000001');
set local role authenticated;
select lives_ok(format($f$ select public.add_expense('e3000000-0000-0000-0002-000000000006',
  'e3000000-0000-0000-0000-0000000000a3', 'A6', 'e3000000-0000-0000-0001-000000000001', 99999999,
  'equal', %L) $f$,
  (select jsonb_object_agg('e3000000-0000-0000-0001-' || lpad(i::text, 12, '0'), 1)
   from generate_series(1, 20) as i)), 'A6 via add_expense (20 members)');
reset role;

select is(pg_temp.cents('e3000000-0000-0000-0002-000000000001'), '{100}'::integer[], 'c16: A1 stored [100]');
select is(pg_temp.cents('e3000000-0000-0000-0002-000000000002'), '{34,33,33}'::integer[], 'c16: A2 stored [34,33,33]');
select is(pg_temp.cents('e3000000-0000-0000-0002-000000000003'), '{1,0,0}'::integer[],
  'c16: A3 stored [1,0,0] (three rows, two of them $0)');
select is(pg_temp.cents('e3000000-0000-0000-0002-000000000004'), '{6000,6000,6000,6000}'::integer[], 'c16: A4 stored 6000 each');
select is(pg_temp.cents('e3000000-0000-0000-0002-000000000005'), '{251,250,250,250}'::integer[], 'c16: A5 stored');
select is(pg_temp.cents('e3000000-0000-0000-0002-000000000006'),
  array_fill(5000000, array[19]) || 4999999, 'c16: A6 stored 19 x 5,000,000 then 4,999,999');
select is(pg_temp.cents('e3000000-0000-0000-0002-000000000007'), '{50000000,49999999}'::integer[], 'c16: A7 stored');
select is(
  (select array_agg(s.user_id || ':' || s.cents order by s.user_id::text collate "C")
   from public.expense_shares as s where s.expense_id = 'e3000000-0000-0000-0002-000000000008'),
  array['e3000000-0000-0000-0000-000000000001:34', 'e3000000-0000-0000-0000-000000000002:33',
        'e3000000-0000-0000-0000-000000000003:33'],
  'c16: A8 gives A2 by user id (Ana 34, Ben 33, Cy 33)');
select ok(
  (select bool_and(s.group_id = x.group_id) from public.expenses as x
   join public.expense_shares as s on s.expense_id = x.id
   where x.id::text like 'e3000000-0000-0000-0002-%'),
  'S10: every share row carries its expense''s group_id');

-- equal payloads with a bad value
select pg_temp.act('e3000000-0000-0000-0000-000000000001');
set local role authenticated;
select throws_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000020',
  'e3000000-0000-0000-0000-0000000000a1', 'x', 'e3000000-0000-0000-0000-000000000001', 100, 'equal',
  '{"e3000000-0000-0000-0000-000000000001": 2}') $$, '22023', 'invalid_shares',
  'equal: a value other than 1 -> invalid_shares');
select throws_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000020',
  'e3000000-0000-0000-0000-0000000000a1', 'x', 'e3000000-0000-0000-0000-000000000001', 100, 'equal',
  '{"e3000000-0000-0000-0000-000000000001": 0}') $$, '22023', 'invalid_shares',
  'equal: a 0 weight -> invalid_shares (A10 via the caller)');
select throws_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000020',
  'e3000000-0000-0000-0000-0000000000a1', 'x', 'e3000000-0000-0000-0000-000000000001', 100, 'equal',
  '{}') $$, '22023', 'invalid_shares', 'equal: nobody chosen -> invalid_shares');
select throws_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000020',
  'e3000000-0000-0000-0000-0000000000a1', 'x', 'e3000000-0000-0000-0000-000000000001', 100, 'equal',
  '[1]') $$, '22023', 'invalid_shares', 'a non-object p_shares -> invalid_shares');
select throws_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000020',
  'e3000000-0000-0000-0000-0000000000a1', 'x', 'e3000000-0000-0000-0000-000000000001', 100, 'equal',
  '{"E3000000-0000-0000-0000-000000000001": 1}') $$, '22023', 'invalid_shares',
  'a key that isn''t a lowercase canonical uuid -> invalid_shares');

-- ===========================================================================
-- Criterion 17: exact payloads X1-X8 (add_expense)
-- ===========================================================================
select lives_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000011',
  'e3000000-0000-0000-0000-0000000000a1', 'Rental car', 'e3000000-0000-0000-0000-000000000004', 30000, 'exact',
  '{"e3000000-0000-0000-0000-000000000001": 8572, "e3000000-0000-0000-0000-000000000002": 8571,
    "e3000000-0000-0000-0000-000000000003": 8571, "e3000000-0000-0000-0000-000000000004": 4286}') $$,
  'X1: Rental car exact {8572, 8571, 8571, 4286} -> ok (Ana adds it, Dee paid)');
select throws_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000020',
  'e3000000-0000-0000-0000-0000000000a1', 'x', 'e3000000-0000-0000-0000-000000000004', 30000, 'exact',
  '{"e3000000-0000-0000-0000-000000000001": 8572, "e3000000-0000-0000-0000-000000000002": 8571,
    "e3000000-0000-0000-0000-000000000003": 8571, "e3000000-0000-0000-0000-000000000004": 4287}') $$,
  '22023', 'invalid_shares', 'X2: sum 30001 -> invalid_shares');
select throws_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000020',
  'e3000000-0000-0000-0000-0000000000a1', 'x', 'e3000000-0000-0000-0000-000000000004', 30000, 'exact',
  '{"e3000000-0000-0000-0000-000000000001": 8572, "e3000000-0000-0000-0000-000000000002": 8571,
    "e3000000-0000-0000-0000-000000000003": 8571, "e3000000-0000-0000-0000-000000000004": 4285}') $$,
  '22023', 'invalid_shares', 'X3: sum 29999 -> invalid_shares');
select lives_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000012',
  'e3000000-0000-0000-0000-0000000000a1', 'X4', 'e3000000-0000-0000-0000-000000000004', 30000, 'exact',
  '{"e3000000-0000-0000-0000-000000000001": 30000}') $$, 'X4: {Ana 30000} -> ok');
select throws_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000020',
  'e3000000-0000-0000-0000-0000000000a1', 'x', 'e3000000-0000-0000-0000-000000000004', 30000, 'exact',
  '{"e3000000-0000-0000-0000-000000000001": 30000, "e3000000-0000-0000-0000-000000000002": 0}') $$,
  '22023', 'invalid_shares', 'X5: {Ana 30000, Ben 0} -> invalid_shares');
select lives_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000013',
  'e3000000-0000-0000-0000-0000000000a1', 'X6', 'e3000000-0000-0000-0000-000000000001', 99999999, 'exact',
  '{"e3000000-0000-0000-0000-000000000001": 99999999}') $$, 'X6: {Ana 99,999,999} -> ok');
select throws_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000020',
  'e3000000-0000-0000-0000-0000000000a1', 'x', 'e3000000-0000-0000-0000-000000000001', 100, 'exact',
  '{"e3000000-0000-0000-0000-000000000001": 50, "e3000000-0000-0000-0000-000000000002": 50.5}') $$,
  '22023', 'invalid_shares', 'X7: {Ana 50, Ben 50.5} -> invalid_shares');
select throws_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000020',
  'e3000000-0000-0000-0000-0000000000a1', 'x', 'e3000000-0000-0000-0000-000000000001', 100, 'exact',
  '{"e3000000-0000-0000-0000-000000000001": "100"}') $$,
  '22023', 'invalid_shares', 'X7: {Ana "100"} -> invalid_shares');
select throws_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000020',
  'e3000000-0000-0000-0000-0000000000a1', 'x', 'e3000000-0000-0000-0000-000000000001', 100, 'exact',
  '{"e3000000-0000-0000-0000-000000000001": 100.0}') $$,
  '22023', 'invalid_shares', 'exact: 100.0 is not a JSON integer -> invalid_shares');
select throws_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000020',
  'e3000000-0000-0000-0000-0000000000a1', 'x', 'e3000000-0000-0000-0000-000000000001', 100, 'exact',
  '{"e3000000-0000-0000-0000-000000000006": 100}') $$,
  '22023', 'not_member', 'X8: a non-member key -> not_member');
reset role;

select is(pg_temp.cents('e3000000-0000-0000-0002-000000000011'), '{8572,8571,8571,4286}'::integer[],
  'c17: X1 stored exactly as sent');
select is(
  (select count(*)::integer from public.expenses where id = 'e3000000-0000-0000-0002-000000000020'),
  0, 'c17: none of the refused payloads wrote an expense');

-- ===========================================================================
-- Criterion 18 + 113: C-G6 fields and the shared trim rows
-- ===========================================================================
create function pg_temp.try_title(p_id uuid, p_title text) returns text language plpgsql as $$
begin
  perform public.add_expense(p_id, 'e3000000-0000-0000-0000-0000000000a1', p_title,
    'e3000000-0000-0000-0000-000000000001', 100, 'equal', '{"e3000000-0000-0000-0000-000000000001": 1}');
  return (select title from public.expenses where id = p_id);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;

select pg_temp.act('e3000000-0000-0000-0000-000000000001');
set local role authenticated;
select is(pg_temp.try_title('e3000000-0000-0000-0002-000000000031', ''), '22023 invalid_expense',
  'c18: title of 0 code points -> invalid_expense');
select is(pg_temp.try_title('e3000000-0000-0000-0002-000000000031', null), '22023 invalid_expense',
  'c18: null title -> invalid_expense');
select is(pg_temp.try_title('e3000000-0000-0000-0002-000000000031', repeat('x', 101)), '22023 invalid_expense',
  'c18: title of 101 code points -> invalid_expense');
select is(pg_temp.try_title('e3000000-0000-0000-0002-000000000031', repeat('🍕', 101)), '22023 invalid_expense',
  'c18: 101 emoji -> invalid_expense');
select is(pg_temp.try_title('e3000000-0000-0000-0002-000000000032', 'x'), 'x', 'c18: title of 1 code point is valid');
select is(pg_temp.try_title('e3000000-0000-0000-0002-000000000033', repeat('x', 100)), repeat('x', 100),
  'c18: title of 100 code points is valid');
select is(pg_temp.try_title('e3000000-0000-0000-0002-000000000034', repeat('🍕', 100)), repeat('🍕', 100),
  'c18: 100 emoji is valid');
select is(pg_temp.try_title('e3000000-0000-0000-0002-000000000035', '  ' || repeat('x', 100) || '  '),
  repeat('x', 100), 'c18: 100 code points after trimming is valid');
-- A1.12 shared rows
select is(pg_temp.try_title('e3000000-0000-0000-0002-000000000031', E'\t\n'), '22023 invalid_expense',
  'c113: a title of only "\t\n" -> invalid_expense');
select is(pg_temp.try_title('e3000000-0000-0000-0002-000000000031', '   '), '22023 invalid_expense',
  'c113: only spaces -> invalid_expense');
select is(pg_temp.try_title('e3000000-0000-0000-0002-000000000036', E'  Airbnb\t'), 'Airbnb',
  'c113: "  Airbnb\t" is stored as "Airbnb"');
select is(pg_temp.try_title('e3000000-0000-0000-0002-000000000037', E'Airbnb '), E'Airbnb ',
  'c113: a trailing non-breaking space is kept');
select is(pg_temp.try_title('e3000000-0000-0000-0002-000000000031', repeat('x', 100) || E' '),
  '22023 invalid_expense', 'c113: 100 x plus a non-breaking space is 101 code points -> invalid_expense');
select is(pg_temp.try_title('e3000000-0000-0000-0002-000000000038', E' '), E' ',
  'c113: a title of only a non-breaking space is valid');
select is(pg_temp.try_title('e3000000-0000-0000-0002-000000000039', E' \t\n\r\u000b\fGas \t\n\r\u000b\f'), 'Gas',
  'c113: trims exactly space, tab, newline, CR, VT and FF');
select is(pg_temp.try_title('e3000000-0000-0000-0002-00000000003a', E'　Gas '), E'　Gas ',
  'c113: U+3000 and U+2003 are kept');
select is(pg_temp.try_title('e3000000-0000-0000-0002-00000000003b', E'﻿Gas'), E'﻿Gas',
  'c113: U+FEFF is kept');
select is(pg_temp.try_title('e3000000-0000-0000-0002-00000000003c', 'Gas  station'), 'Gas  station',
  'c113: inside spaces are untouched');

create function pg_temp.try_amount(p_id uuid, p_amount bigint, p_method text default 'equal')
returns text language plpgsql as $$
begin
  perform public.add_expense(p_id, 'e3000000-0000-0000-0000-0000000000a1', 'Amount', 'e3000000-0000-0000-0000-000000000001',
    p_amount, p_method, '{"e3000000-0000-0000-0000-000000000001": 1}');
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;

select is(pg_temp.try_amount('e3000000-0000-0000-0002-000000000041', 0), '22023 invalid_expense', 'c18: amount 0 -> invalid_expense');
select is(pg_temp.try_amount('e3000000-0000-0000-0002-000000000041', 100000000), '22023 invalid_expense',
  'c18: amount 100,000,000 -> invalid_expense');
select is(pg_temp.try_amount('e3000000-0000-0000-0002-000000000041', -1), '22023 invalid_expense', 'c18: amount -1 -> invalid_expense');
select is(pg_temp.try_amount('e3000000-0000-0000-0002-000000000041', null), '22023 invalid_expense', 'c18: null amount -> invalid_expense');
select is(pg_temp.try_amount('e3000000-0000-0000-0002-000000000042', 1), 'ok', 'c18: amount 1 is valid');
select is(pg_temp.try_amount('e3000000-0000-0000-0002-000000000043', 99999999), 'ok', 'c18: amount 99,999,999 is valid');
select is(pg_temp.try_amount('e3000000-0000-0000-0002-000000000041', 100, 'shares'), '22023 invalid_expense',
  'c18: split method ''shares'' -> invalid_expense');
select throws_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000041',
  'e3000000-0000-0000-0000-0000000000a1', 'x', 'e3000000-0000-0000-0000-000000000006', 100, 'equal',
  '{"e3000000-0000-0000-0000-000000000001": 1}') $$, '22023', 'not_member',
  'c18: a payer who isn''t a member -> not_member');
select throws_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000041',
  'e3000000-0000-0000-0000-0000000000a1', 'x', 'e3000000-0000-0000-0000-000000000001', 100, 'equal',
  '{"e3000000-0000-0000-0000-000000000001": 1, "e3000000-0000-0000-0000-000000000006": 1}') $$, '22023', 'not_member',
  'c18: an equal share user who isn''t a member -> not_member');
select throws_ok($$ select public.add_expense(null,
  'e3000000-0000-0000-0000-0000000000a1', 'x', 'e3000000-0000-0000-0000-000000000001', 100, 'equal',
  '{"e3000000-0000-0000-0000-000000000001": 1}') $$, '22023', 'invalid_id', 'add_expense with a null id -> invalid_id');
reset role;

-- ===========================================================================
-- Who may call (C-G9)
-- ===========================================================================
select pg_temp.act('e3000000-0000-0000-0000-000000000006');
set local role authenticated;
select throws_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000051',
  'e3000000-0000-0000-0000-0000000000a1', 'x', 'e3000000-0000-0000-0000-000000000006', 100, 'equal',
  '{"e3000000-0000-0000-0000-000000000006": 1}') $$, '42501', 'not_allowed', 'a non-member can''t add an expense');
select throws_ok($$ select public.edit_expense('e3000000-0000-0000-0002-000000000011', 1, 'x',
  'e3000000-0000-0000-0000-000000000004', 30000, 'exact', '{"e3000000-0000-0000-0000-000000000004": 30000}') $$,
  '42501', 'not_allowed', 'a non-member can''t edit an expense');
select throws_ok($$ select public.delete_expense('e3000000-0000-0000-0002-000000000011', 1) $$,
  '42501', 'not_allowed', 'a non-member can''t delete an expense');
select is((select count(*)::integer from public.expenses where group_id = 'e3000000-0000-0000-0000-0000000000a1'), 0,
  'RLS: a non-member reads 0 expense rows of the group');
select is((select count(*)::integer from public.expense_shares where group_id = 'e3000000-0000-0000-0000-0000000000a1'), 0,
  'RLS: a non-member reads 0 share rows of the group');
select throws_ok($$ select public.edit_expense('e3000000-0000-0000-0002-0000000000ff', 1, 'x',
  'e3000000-0000-0000-0000-000000000006', 100, 'equal', '{"e3000000-0000-0000-0000-000000000006": 1}') $$,
  '42501', 'not_allowed', 'an expense that doesn''t exist gives the same 42501 not_allowed');
reset role;

select pg_temp.signed_out();
set local role authenticated;
select throws_ok($$ select public.delete_expense('e3000000-0000-0000-0002-000000000011', 1) $$,
  '42501', 'not_allowed', 'signed out -> 42501 not_allowed');
reset role;
set local role anon;
select throws_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000051',
  'e3000000-0000-0000-0000-0000000000a1', 'x', 'e3000000-0000-0000-0000-000000000001', 100, 'equal',
  '{"e3000000-0000-0000-0000-000000000001": 1}') $$, '42501', null, 'anon can''t execute add_expense');
reset role;

select pg_temp.act('e3000000-0000-0000-0000-000000000005');
set local role authenticated;
select is((select count(*)::integer from public.expenses where id = 'e3000000-0000-0000-0002-000000000011'), 1,
  'RLS: a member reads the group''s expenses');
select throws_ok($$ insert into public.expenses (id, group_id, title, payer_id, amount_cents, split_method, created_by)
  values ('e3000000-0000-0000-0002-000000000052', 'e3000000-0000-0000-0000-0000000000a1', 'x',
          'e3000000-0000-0000-0000-000000000005', 1, 'equal', 'e3000000-0000-0000-0000-000000000005') $$,
  '42501', null, 'a direct INSERT into expenses fails with 42501');
select throws_ok($$ update public.expense_shares set cents = 0
  where expense_id = 'e3000000-0000-0000-0002-000000000011' $$,
  '42501', null, 'a direct UPDATE of expense_shares fails with 42501');
select throws_ok($$ delete from public.expenses where id = 'e3000000-0000-0000-0002-000000000011' $$,
  '42501', null, 'a direct DELETE from expenses fails with 42501');
select throws_ok($$ select public.edit_expense('e3000000-0000-0000-0002-000000000011', 1, 'Rental car',
  'e3000000-0000-0000-0000-000000000004', 30000, 'exact', '{"e3000000-0000-0000-0000-000000000004": 30000}') $$,
  '42501', 'not_allowed', 'c20: a member who is neither creator nor payer can''t edit');
select throws_ok($$ select public.delete_expense('e3000000-0000-0000-0002-000000000011', 1) $$,
  '42501', 'not_allowed', 'c20: a member who is neither creator nor payer can''t delete');
reset role;

-- ===========================================================================
-- Criterion 19 + 101: retries of add_expense
-- ===========================================================================
select pg_temp.act('e3000000-0000-0000-0000-000000000001');
set local role authenticated;
select lives_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000004',
  'e3000000-0000-0000-0000-0000000000a1', E'Airbnb\t', 'e3000000-0000-0000-0000-000000000001', 24000, 'equal',
  '{"e3000000-0000-0000-0000-000000000004": 1, "e3000000-0000-0000-0000-000000000003": 1,
    "e3000000-0000-0000-0000-000000000002": 1, "e3000000-0000-0000-0000-000000000001": 1}') $$,
  'c19: add_expense retried with the same id and content succeeds');
select throws_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000004',
  'e3000000-0000-0000-0000-0000000000a1', 'Airbnb', 'e3000000-0000-0000-0000-000000000001', 24001, 'equal',
  '{"e3000000-0000-0000-0000-000000000001": 1, "e3000000-0000-0000-0000-000000000002": 1,
    "e3000000-0000-0000-0000-000000000003": 1, "e3000000-0000-0000-0000-000000000004": 1}') $$,
  '22023', 'id_conflict', 'c19: same id with a different amount -> id_conflict');
select throws_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000004',
  'e3000000-0000-0000-0000-0000000000a1', 'Airbnb', 'e3000000-0000-0000-0000-000000000001', 24000, 'equal',
  '{"e3000000-0000-0000-0000-000000000001": 1, "e3000000-0000-0000-0000-000000000002": 1,
    "e3000000-0000-0000-0000-000000000003": 1}') $$,
  '22023', 'id_conflict', 'c19: same id with other people -> id_conflict');
reset role;
select pg_temp.act('e3000000-0000-0000-0000-000000000002');
set local role authenticated;
select throws_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000004',
  'e3000000-0000-0000-0000-0000000000a1', 'Airbnb', 'e3000000-0000-0000-0000-000000000001', 24000, 'equal',
  '{"e3000000-0000-0000-0000-000000000001": 1, "e3000000-0000-0000-0000-000000000002": 1,
    "e3000000-0000-0000-0000-000000000003": 1, "e3000000-0000-0000-0000-000000000004": 1}') $$,
  '22023', 'id_conflict', 'c19: same id and content from another member -> id_conflict');
reset role;
select is(
  (select count(*)::integer from public.expenses where id = 'e3000000-0000-0000-0002-000000000004')
  * 10 + pg_temp.events('e3000000-0000-0000-0000-0000000000a1', 'expense_added', 'e3000000-0000-0000-0002-000000000004'),
  11, 'c19: one Airbnb expense and one expense_added after the retries');
select is(
  (select details from public.group_events where group_id = 'e3000000-0000-0000-0000-0000000000a1'
     and kind = 'expense_added' and details ->> 'expense_id' = 'e3000000-0000-0000-0002-000000000004'),
  jsonb_build_object('expense_id', 'e3000000-0000-0000-0002-000000000004', 'title', 'Airbnb', 'amount_cents', 24000),
  'expense_added details are {expense_id, title, amount_cents}');
select is(
  (select actor_id from public.group_events where group_id = 'e3000000-0000-0000-0000-0000000000a1'
     and kind = 'expense_added' and details ->> 'expense_id' = 'e3000000-0000-0000-0002-000000000004'),
  'e3000000-0000-0000-0000-000000000001'::uuid, 'expense_added actor is the caller');

-- ===========================================================================
-- Criterion 20 + 100: edit_expense
-- ===========================================================================
-- Rental car (..11): created by Ana, paid by Dee, version 1. Backdate created_at.
update public.expenses set created_at = now() - interval '1 day' where id = 'e3000000-0000-0000-0002-000000000011';

select pg_temp.act('e3000000-0000-0000-0000-000000000004');
set local role authenticated;
select lives_ok($$ select public.edit_expense('e3000000-0000-0000-0002-000000000011', 1, 'Rental car',
  'e3000000-0000-0000-0000-000000000004', 30000, 'equal',
  '{"e3000000-0000-0000-0000-000000000001": 1, "e3000000-0000-0000-0000-000000000002": 1,
    "e3000000-0000-0000-0000-000000000003": 1, "e3000000-0000-0000-0000-000000000004": 1}') $$,
  'c20: the payer (not the creator) edits: exact -> equal among 4');
reset role;
select is(
  (select array[version::text, (edited_at is not null)::text, split_method]
   from public.expenses where id = 'e3000000-0000-0000-0002-000000000011'),
  array['2', 'true', 'equal'], 'c20: version 2, edited_at set, method equal');
select is(pg_temp.cents('e3000000-0000-0000-0002-000000000011'), '{7500,7500,7500,7500}'::integer[],
  'c20: shares replaced with the recomputed equal split');
select is(
  (select details from public.group_events where group_id = 'e3000000-0000-0000-0000-0000000000a1'
     and kind = 'expense_edited' and details ->> 'expense_id' = 'e3000000-0000-0000-0002-000000000011'),
  jsonb_build_object('expense_id', 'e3000000-0000-0000-0002-000000000011',
    'before', jsonb_build_object('title', 'Rental car', 'amount_cents', 30000,
                                 'payer_id', 'e3000000-0000-0000-0000-000000000004', 'split_method', 'exact'),
    'after', jsonb_build_object('title', 'Rental car', 'amount_cents', 30000,
                                'payer_id', 'e3000000-0000-0000-0000-000000000004', 'split_method', 'equal')),
  'c20: one expense_edited with before / after');

-- c100: a retry with the old version and the saved fields succeeds with no new event.
update public.expenses set edited_at = now() - interval '1 hour' where id = 'e3000000-0000-0000-0002-000000000011';
select set_config('test.edited_at',
  (select edited_at::text from public.expenses where id = 'e3000000-0000-0000-0002-000000000011'), true);
select pg_temp.act('e3000000-0000-0000-0000-000000000004');
set local role authenticated;
select lives_ok($$ select public.edit_expense('e3000000-0000-0000-0002-000000000011', 1, ' Rental car ',
  'e3000000-0000-0000-0000-000000000004', 30000, 'equal',
  '{"e3000000-0000-0000-0000-000000000004": 1, "e3000000-0000-0000-0000-000000000003": 1,
    "e3000000-0000-0000-0000-000000000002": 1, "e3000000-0000-0000-0000-000000000001": 1}') $$,
  'c100: retry with the old version and the already-saved fields succeeds');
select throws_ok($$ select public.edit_expense('e3000000-0000-0000-0002-000000000011', 1, 'Rental car',
  'e3000000-0000-0000-0000-000000000004', 30001, 'equal',
  '{"e3000000-0000-0000-0000-000000000004": 1}') $$,
  '22023', 'version_changed', 'c20/c100: the old version with different fields -> version_changed');
select lives_ok($$ select public.edit_expense('e3000000-0000-0000-0002-000000000011', 2, 'Rental car',
  'e3000000-0000-0000-0000-000000000004', 30000, 'equal',
  '{"e3000000-0000-0000-0000-000000000001": 1, "e3000000-0000-0000-0000-000000000002": 1,
    "e3000000-0000-0000-0000-000000000003": 1, "e3000000-0000-0000-0000-000000000004": 1}') $$,
  'c20: identical fields with the current version succeed');
reset role;
select is(
  (select array[version::text, edited_at::text] from public.expenses where id = 'e3000000-0000-0000-0002-000000000011'),
  array['2', current_setting('test.edited_at')],
  'c20: identical fields -> no write (version and backdated edited_at unchanged)');
select is(pg_temp.events('e3000000-0000-0000-0000-0000000000a1', 'expense_edited', 'e3000000-0000-0000-0002-000000000011'), 1,
  'c20/c100: still exactly one expense_edited');

-- The creator (Ana) edits back to exact X1 (X-table through edit_expense, criterion 17).
select pg_temp.act('e3000000-0000-0000-0000-000000000001');
set local role authenticated;
select throws_ok($$ select public.edit_expense('e3000000-0000-0000-0002-000000000011', 2, 'Rental car',
  'e3000000-0000-0000-0000-000000000004', 30000, 'exact',
  '{"e3000000-0000-0000-0000-000000000001": 8572, "e3000000-0000-0000-0000-000000000002": 8571,
    "e3000000-0000-0000-0000-000000000003": 8571, "e3000000-0000-0000-0000-000000000004": 4287}') $$,
  '22023', 'invalid_shares', 'c17 edit: X2 -> invalid_shares');
select throws_ok($$ select public.edit_expense('e3000000-0000-0000-0002-000000000011', 2, 'Rental car',
  'e3000000-0000-0000-0000-000000000004', 30000, 'exact',
  '{"e3000000-0000-0000-0000-000000000001": 8572, "e3000000-0000-0000-0000-000000000002": 8571,
    "e3000000-0000-0000-0000-000000000003": 8571, "e3000000-0000-0000-0000-000000000004": 4285}') $$,
  '22023', 'invalid_shares', 'c17 edit: X3 -> invalid_shares');
select throws_ok($$ select public.edit_expense('e3000000-0000-0000-0002-000000000011', 2, 'Rental car',
  'e3000000-0000-0000-0000-000000000004', 30000, 'exact',
  '{"e3000000-0000-0000-0000-000000000001": 30000, "e3000000-0000-0000-0000-000000000002": 0}') $$,
  '22023', 'invalid_shares', 'c17 edit: X5 -> invalid_shares');
select throws_ok($$ select public.edit_expense('e3000000-0000-0000-0002-000000000011', 2, 'Rental car',
  'e3000000-0000-0000-0000-000000000004', 100, 'exact',
  '{"e3000000-0000-0000-0000-000000000001": 50, "e3000000-0000-0000-0000-000000000002": 50.5}') $$,
  '22023', 'invalid_shares', 'c17 edit: X7 -> invalid_shares');
select throws_ok($$ select public.edit_expense('e3000000-0000-0000-0002-000000000011', 2, 'Rental car',
  'e3000000-0000-0000-0000-000000000004', 100, 'exact',
  '{"e3000000-0000-0000-0000-000000000006": 100}') $$,
  '22023', 'not_member', 'c17 edit: X8 -> not_member');
select throws_ok($$ select public.edit_expense('e3000000-0000-0000-0002-000000000011', 2, '',
  'e3000000-0000-0000-0000-000000000004', 30000, 'exact', '{"e3000000-0000-0000-0000-000000000001": 30000}') $$,
  '22023', 'invalid_expense', 'c18 edit: an empty title -> invalid_expense');
select throws_ok($$ select public.edit_expense('e3000000-0000-0000-0002-000000000011', 2, 'Rental car',
  'e3000000-0000-0000-0000-000000000006', 30000, 'exact', '{"e3000000-0000-0000-0000-000000000001": 30000}') $$,
  '22023', 'not_member', 'c18 edit: a non-member payer -> not_member');
select lives_ok($$ select public.edit_expense('e3000000-0000-0000-0002-000000000011', 2, 'Rental car',
  'e3000000-0000-0000-0000-000000000004', 30000, 'exact',
  '{"e3000000-0000-0000-0000-000000000001": 8572, "e3000000-0000-0000-0000-000000000002": 8571,
    "e3000000-0000-0000-0000-000000000003": 8571, "e3000000-0000-0000-0000-000000000004": 4286}') $$,
  'c17/c20 edit: the creator edits to X1 -> ok');
select throws_ok($$ select public.edit_expense('e3000000-0000-0000-0002-000000000011', 2, 'Rental car',
  'e3000000-0000-0000-0000-000000000004', 30000, 'exact',
  '{"e3000000-0000-0000-0000-000000000001": 30000}') $$,
  '22023', 'version_changed', 'c20: a stale p_expected_version -> version_changed');
reset role;
select is(
  (select version from public.expenses where id = 'e3000000-0000-0000-0002-000000000011') * 10
  + pg_temp.events('e3000000-0000-0000-0000-0000000000a1', 'expense_edited', 'e3000000-0000-0000-0002-000000000011'),
  32, 'c20: version 3 and two expense_edited after two real edits (refused ones wrote nothing)');
select is(pg_temp.cents('e3000000-0000-0000-0002-000000000011'), '{8572,8571,8571,4286}'::integer[],
  'c17 edit: X1 stored');

-- ===========================================================================
-- Criterion 21 + 101: delete_expense
-- ===========================================================================
select pg_temp.act('e3000000-0000-0000-0000-000000000004');
set local role authenticated;
select throws_ok($$ select public.delete_expense('e3000000-0000-0000-0002-000000000011', 2) $$,
  '22023', 'version_changed', 'c21: delete with a stale version -> version_changed');
select lives_ok($$ select public.delete_expense('e3000000-0000-0000-0002-000000000011', 3) $$,
  'c21: the payer deletes the Rental car');
select lives_ok($$ select public.delete_expense('e3000000-0000-0000-0002-000000000011', 3) $$,
  'c21: a repeat delete is a no-op');
select throws_ok($$ select public.edit_expense('e3000000-0000-0000-0002-000000000011', 3, 'Rental car',
  'e3000000-0000-0000-0000-000000000004', 30000, 'exact', '{"e3000000-0000-0000-0000-000000000001": 30000}') $$,
  '22023', 'version_changed', 'editing a deleted expense -> version_changed');
reset role;
select is(
  (select array[(deleted_at is not null)::text, deleted_by::text, version::text]
   from public.expenses where id = 'e3000000-0000-0000-0002-000000000011'),
  array['true', 'e3000000-0000-0000-0000-000000000004', '3'],
  'c21: soft-deleted (row kept, deleted_at and deleted_by set, version unchanged)');
select is(pg_temp.cents('e3000000-0000-0000-0002-000000000011'), '{8572,8571,8571,4286}'::integer[],
  'c21: the shares are kept');
select is(pg_temp.events('e3000000-0000-0000-0000-0000000000a1', 'expense_deleted', 'e3000000-0000-0000-0002-000000000011'), 1,
  'c21: one expense_deleted after delete + repeat');

select pg_temp.act('e3000000-0000-0000-0000-000000000001');
set local role authenticated;
select lives_ok($$ select public.add_expense('e3000000-0000-0000-0002-000000000011',
  'e3000000-0000-0000-0000-0000000000a1', 'Rental car', 'e3000000-0000-0000-0000-000000000004', 30000, 'exact',
  '{"e3000000-0000-0000-0000-000000000001": 8572, "e3000000-0000-0000-0000-000000000002": 8571,
    "e3000000-0000-0000-0000-000000000003": 8571, "e3000000-0000-0000-0000-000000000004": 4286}') $$,
  'c101: add_expense with a deleted expense''s id and the same content returns success');
reset role;
select ok(
  (select deleted_at is not null from public.expenses where id = 'e3000000-0000-0000-0002-000000000011')
  and pg_temp.events('e3000000-0000-0000-0000-0000000000a1', 'expense_added', 'e3000000-0000-0000-0002-000000000011') = 1,
  'c101: the expense stays deleted and no new expense_added');

-- ===========================================================================
-- Criterion 99 (S10) and the restrict FKs
-- ===========================================================================
select throws_ok($$ insert into public.expense_shares (expense_id, group_id, user_id, cents)
  values ('e3000000-0000-0000-0002-000000000001', 'e3000000-0000-0000-0000-0000000000a2',
          'e3000000-0000-0000-0000-000000000006', 0) $$,
  '23503', null, 'c99: a share pointing at an expense of another group fails the composite FK (as postgres)');
select throws_ok($$ delete from public.group_members
  where group_id = 'e3000000-0000-0000-0000-0000000000a1' and user_id = 'e3000000-0000-0000-0000-000000000002' $$,
  '23503', null, 'restrict: deleting the membership of a share user fails (as postgres)');

-- ===========================================================================
-- Criterion 95 + C-G10: leave_group with expense history
-- ===========================================================================
-- Fixtures (ids Ana 01 < Flo 07 < Gus 08):
--   ..61 Gum: 1 cent equally among Ana, Flo -> Ana 1, Flo 0 (Flo's only history is a $0 share)
--   ..62 Mint: 1 cent exact for Gus (a $0.01 share)
--   ..63 Gas: created by Jo, paid by Hal, then deleted
--   ..64 Snack: Ivy's 5-cent share, then deleted
select pg_temp.act('e3000000-0000-0000-0000-000000000001');
set local role authenticated;
select public.add_expense('e3000000-0000-0000-0002-000000000061', 'e3000000-0000-0000-0000-0000000000a1',
  'Gum', 'e3000000-0000-0000-0000-000000000001', 1, 'equal',
  '{"e3000000-0000-0000-0000-000000000001": 1, "e3000000-0000-0000-0000-000000000007": 1}');
select public.add_expense('e3000000-0000-0000-0002-000000000062', 'e3000000-0000-0000-0000-0000000000a1',
  'Mint', 'e3000000-0000-0000-0000-000000000001', 1, 'exact', '{"e3000000-0000-0000-0000-000000000008": 1}');
select public.add_expense('e3000000-0000-0000-0002-000000000064', 'e3000000-0000-0000-0000-0000000000a1',
  'Snack', 'e3000000-0000-0000-0000-000000000001', 5, 'exact', '{"e3000000-0000-0000-0000-00000000000a": 5}');
select public.delete_expense('e3000000-0000-0000-0002-000000000064', 1);
reset role;
select pg_temp.act('e3000000-0000-0000-0000-00000000000b');
set local role authenticated;
select public.add_expense('e3000000-0000-0000-0002-000000000063', 'e3000000-0000-0000-0000-0000000000a1',
  'Gas', 'e3000000-0000-0000-0000-000000000009', 500, 'exact', '{"e3000000-0000-0000-0000-000000000001": 500}');
select public.delete_expense('e3000000-0000-0000-0002-000000000063', 1);
reset role;

create function pg_temp.try_leave(p_user uuid) returns text language plpgsql as $$
begin
  perform pg_temp.act(p_user);
  set local role authenticated;
  perform public.leave_group('e3000000-0000-0000-0000-0000000000a1');
  reset role;
  return 'left';
exception when others then
  reset role;
  return sqlstate || ' ' || sqlerrm;
end $$;

select is(pg_temp.cents('e3000000-0000-0000-0002-000000000061'), '{1,0}'::integer[], 'c95 fixture: Gum is Ana 1, Flo 0');
select is(pg_temp.try_leave('e3000000-0000-0000-0000-000000000008'), '22023 cannot_leave',
  'c95: a member with a $0.01 share can''t leave');
select is(pg_temp.try_leave('e3000000-0000-0000-0000-000000000009'), '22023 cannot_leave',
  'C-G10: the payer of a deleted expense can''t leave');
select is(pg_temp.try_leave('e3000000-0000-0000-0000-00000000000a'), '22023 cannot_leave',
  'C-G10: a share user of a deleted expense can''t leave');
select is(pg_temp.try_leave('e3000000-0000-0000-0000-00000000000b'), '22023 cannot_leave',
  'C-G10: the creator of a deleted expense can''t leave');
select is(pg_temp.try_leave('e3000000-0000-0000-0000-000000000004'), '22023 cannot_leave',
  'C-G10: a payer of a live expense (Dee) can''t leave');
select is(pg_temp.try_leave('e3000000-0000-0000-0000-000000000007'), 'left',
  'c95: a member whose only history is a $0 equal share can leave');
select ok(
  not exists (select 1 from public.group_members where group_id = 'e3000000-0000-0000-0000-0000000000a1'
              and user_id = 'e3000000-0000-0000-0000-000000000007')
  and (select count(*) from public.group_events where group_id = 'e3000000-0000-0000-0000-0000000000a1'
         and kind = 'member_left' and actor_id = 'e3000000-0000-0000-0000-000000000007') = 1,
  'c95: Flo''s membership is gone and one member_left is logged');
select is(
  (select array_agg(s.user_id || ':' || s.cents order by s.user_id::text collate "C")
   from public.expense_shares as s where s.expense_id = 'e3000000-0000-0000-0002-000000000061'),
  array['e3000000-0000-0000-0000-000000000001:1'],
  'N3: only Flo''s $0 row went; Ana''s 1 cent (the whole amount) stays');
select ok(
  (select count(*) from public.group_members where group_id = 'e3000000-0000-0000-0000-0000000000a1'
     and user_id in ('e3000000-0000-0000-0000-000000000004', 'e3000000-0000-0000-0000-000000000008',
                     'e3000000-0000-0000-0000-000000000009', 'e3000000-0000-0000-0000-00000000000a',
                     'e3000000-0000-0000-0000-00000000000b')) = 5
  and pg_temp.cents('e3000000-0000-0000-0002-000000000062') = '{1}'::integer[],
  'C-G10: the refused leaves changed nothing');

-- ===========================================================================
-- Criterion 34: lock order, from the function bodies
-- ===========================================================================
-- Delete group (20261128100232, A2.5): each money write now takes the group row FOR KEY SHARE
-- once, as its first lock. Apart from that one statement, the old rule holds.
select ok(
  (select bool_and((select count(*) from regexp_matches(pg_temp.body(f::regprocedure), 'perform 1 from public\.groups as g where g\.id = [pv]_group_id for key share;', 'g')) = 1
                   and r.b not like '%public.groups%'
                   and r.b not like '%for update%'
                   and r.b not like '%for share%'
                   and r.b not like '%for key share%'
                   and (length(r.b) - length(replace(r.b, 'for no key update', ''))) <= length('for no key update'))
   from unnest(array['public.add_expense(uuid, uuid, text, uuid, bigint, text, jsonb)',
                     'public.edit_expense(uuid, integer, text, uuid, bigint, text, jsonb)',
                     'public.delete_expense(uuid, integer)']) as f
   cross join lateral (select regexp_replace(pg_temp.body(f::regprocedure), 'perform 1 from public\.groups as g where g\.id = [pv]_group_id for key share;', '') as b) as r),
  'c34(a) as amended by delete group: money writes take one explicit group lock (FOR KEY SHARE) and no membership lock');
select ok(
  position('for no key update' in pg_temp.body('public.edit_expense(uuid, integer, text, uuid, bigint, text, jsonb)'))
    between 1 and position('delete from public.expense_shares'
      in pg_temp.body('public.edit_expense(uuid, integer, text, uuid, bigint, text, jsonb)')) - 1
  and position('delete from public.expense_shares'
      in pg_temp.body('public.edit_expense(uuid, integer, text, uuid, bigint, text, jsonb)'))
    < position('insert into public.expense_shares'
      in pg_temp.body('public.edit_expense(uuid, integer, text, uuid, bigint, text, jsonb)'))
  and position('insert into public.expense_shares'
      in pg_temp.body('public.edit_expense(uuid, integer, text, uuid, bigint, text, jsonb)'))
    < position('update public.expenses'
      in pg_temp.body('public.edit_expense(uuid, integer, text, uuid, bigint, text, jsonb)'))
  and position('for no key update' in pg_temp.body('public.delete_expense(uuid, integer)'))
    between 1 and position('update public.expenses' in pg_temp.body('public.delete_expense(uuid, integer)')) - 1,
  'c34: edit locks the expense row, then deletes shares, then inserts, then updates; delete locks before updating');
select ok(
  position('for no key update' in pg_temp.body('public.leave_group(uuid)'))
    < position('from public.expenses' in pg_temp.body('public.leave_group(uuid)'))
  and position('from public.expenses' in pg_temp.body('public.leave_group(uuid)'))
    < position('delete from public.expense_shares' in pg_temp.body('public.leave_group(uuid)'))
  and position('delete from public.expense_shares' in pg_temp.body('public.leave_group(uuid)'))
    < position('delete from public.group_members' in pg_temp.body('public.leave_group(uuid)'))
  and pg_temp.body('public.leave_group(uuid)') !~ 'for update\s*;',
  'c34(d): leave_group locks the group, checks expense history, drops $0 shares, then deletes membership');

select * from finish();
rollback;
