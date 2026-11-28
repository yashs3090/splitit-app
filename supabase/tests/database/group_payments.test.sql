-- pgTAP tests for the Groups T4 migration (20261126090704_group_payments.sql; spec
-- docs/specs/2026-11-26-groups-mvp.md criteria 22-24, 31 (payment part), 34, 101, 115, 116,
-- Amendments A1 and A2, GR-M6).
--
-- Every assertion filters to the fixture users / groups / payments below (the local DB may hold
-- real data). Fixture ids all start with e4.
-- Users: Ana ..01 (creates G1), Ben ..02, Cy ..03, Dee ..04 (third member, never a party),
--   Lee ..05 (member with no history; leaves), Sam ..06 (stranger to G1; creates G2),
--   Fay ..07 (from of an undone payment only), Gil ..08 (to of a live payment only).
-- Groups: G1 ..a1 'Tahoe trip'; G2 ..a2 (Sam's).
-- Payments: e4000000-0000-0000-0003-0000000000NN.

begin;

create extension if not exists pgtap with schema extensions;

select plan(82);

create function pg_temp.act(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

create function pg_temp.signed_out() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
end $$;

create function pg_temp.body(p regprocedure) returns text language sql as $$
  select lower(prosrc) from pg_proc where oid = p
$$;

create function pg_temp.events(p_kind text, p_payment uuid) returns integer language sql as $$
  select count(*)::integer from public.group_events as e
  where e.group_id = 'e4000000-0000-0000-0000-0000000000a1'
    and e.kind = p_kind and e.details ->> 'payment_id' = p_payment::text
$$;

create function pg_temp.pid(n integer) returns uuid language sql immutable as $$
  select ('e4000000-0000-0000-0003-' || lpad(n::text, 12, '0'))::uuid
$$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('e4000000-0000-0000-0000-000000000001', 'gpay-a@test.local', '{"full_name":"Ana"}'::jsonb),
  ('e4000000-0000-0000-0000-000000000002', 'gpay-b@test.local', '{"full_name":"Ben"}'::jsonb),
  ('e4000000-0000-0000-0000-000000000003', 'gpay-c@test.local', '{"full_name":"Cy"}'::jsonb),
  ('e4000000-0000-0000-0000-000000000004', 'gpay-d@test.local', '{"full_name":"Dee"}'::jsonb),
  ('e4000000-0000-0000-0000-000000000005', 'gpay-l@test.local', '{"full_name":"Lee"}'::jsonb),
  ('e4000000-0000-0000-0000-000000000006', 'gpay-s@test.local', '{"full_name":"Sam"}'::jsonb),
  ('e4000000-0000-0000-0000-000000000007', 'gpay-f@test.local', '{"full_name":"Fay"}'::jsonb),
  ('e4000000-0000-0000-0000-000000000008', 'gpay-g@test.local', '{"full_name":"Gil"}'::jsonb);

select pg_temp.act('e4000000-0000-0000-0000-000000000001');
set local role authenticated;
select public.create_group('e4000000-0000-0000-0000-0000000000a1', 'Tahoe trip');
reset role;
select pg_temp.act('e4000000-0000-0000-0000-000000000006');
set local role authenticated;
select public.create_group('e4000000-0000-0000-0000-0000000000a2', 'Other group');
reset role;

select set_config('test.code1',
  (select join_code from public.groups where id = 'e4000000-0000-0000-0000-0000000000a1'), true);

create function pg_temp.join(p_user uuid, p_code text) returns void language plpgsql as $$
begin
  perform pg_temp.act(p_user);
  set local role authenticated;
  perform public.join_group(p_code);
  reset role;
end $$;

select pg_temp.join(u, current_setting('test.code1'))
from unnest(array[
  'e4000000-0000-0000-0000-000000000002', 'e4000000-0000-0000-0000-000000000003',
  'e4000000-0000-0000-0000-000000000004', 'e4000000-0000-0000-0000-000000000005',
  'e4000000-0000-0000-0000-000000000007', 'e4000000-0000-0000-0000-000000000008']::uuid[]) as u;

-- ===========================================================================
-- Structure: RLS, grants, function settings
-- ===========================================================================
select ok(
  (select c.relrowsecurity from pg_class as c where c.oid = 'public.group_payments'::regclass),
  'RLS is enabled on group_payments');

select ok(
  not has_table_privilege('anon', 'public.group_payments', 'select, insert, update, delete, truncate, references, trigger')
  and not has_any_column_privilege('anon', 'public.group_payments', 'select, insert, update, references')
  and not exists (
    select 1 from pg_class as c, aclexplode(c.relacl) as a
    where c.oid = 'public.group_payments'::regclass and a.grantee = 0::oid),
  'anon and public hold no privilege on group_payments');

select ok(
  has_table_privilege('authenticated', 'public.group_payments', 'select')
  and not has_table_privilege('authenticated', 'public.group_payments', 'insert, update, delete, truncate, references, trigger')
  and not has_any_column_privilege('authenticated', 'public.group_payments', 'insert, update, references'),
  'authenticated has exactly SELECT on group_payments');

select ok(
  not has_table_privilege('service_role', 'public.group_payments', 'insert, update, delete, truncate')
  and not has_any_column_privilege('service_role', 'public.group_payments', 'insert, update'),
  'service_role cannot write group_payments (payments cannot be forged outside the functions)');

select ok(
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']) and count(*) = 3
   from pg_proc as p
   where p.oid in ('public.record_payment(uuid, uuid, uuid, uuid, bigint, text, text)'::regprocedure,
                   'public.undo_payment(uuid)'::regprocedure,
                   'public.leave_group(uuid)'::regprocedure)),
  'record_payment, undo_payment and leave_group are security definer with an empty search_path');

select ok(
  (select bool_and(has_function_privilege('authenticated', f, 'execute')
                   and not has_function_privilege('anon', f, 'execute'))
   from unnest(array['public.record_payment(uuid, uuid, uuid, uuid, bigint, text, text)',
                     'public.undo_payment(uuid)', 'public.leave_group(uuid)']) as f)
  and not exists (
    select 1 from pg_proc as p, aclexplode(p.proacl) as a
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('record_payment', 'undo_payment', 'leave_group')
      and a.grantee in (0::oid, 'anon'::regrole::oid)),
  'only authenticated can execute the payment functions (no PUBLIC or anon grant)');

select has_index('public', 'group_payments', 'group_payments_not_received_idx',
  'GR-M6: a partial index serves T6''s not_received list');

-- Direct writes by a member fail with 42501.
select pg_temp.act('e4000000-0000-0000-0000-000000000001');
set local role authenticated;
select throws_ok($$
  insert into public.group_payments (id, group_id, from_user, to_user, cents, method, source, recorded_by)
  values ('e4000000-0000-0000-0003-0000000000ff', 'e4000000-0000-0000-0000-0000000000a1',
          'e4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000002',
          100, 'cash', 'manual', 'e4000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'authenticated cannot INSERT into group_payments directly');
select throws_ok($$ update public.group_payments set cents = 1
                    where group_id = 'e4000000-0000-0000-0000-0000000000a1' $$,
  '42501', null, 'authenticated cannot UPDATE group_payments directly');
select throws_ok($$ delete from public.group_payments
                    where group_id = 'e4000000-0000-0000-0000-0000000000a1' $$,
  '42501', null, 'authenticated cannot DELETE from group_payments directly');
reset role;

set local role anon;
select throws_ok($$ select public.record_payment('e4000000-0000-0000-0003-0000000000fe',
  'e4000000-0000-0000-0000-0000000000a1', 'e4000000-0000-0000-0000-000000000001',
  'e4000000-0000-0000-0000-000000000002', 100, 'cash', 'manual') $$,
  '42501', null, 'anon cannot execute record_payment');
select throws_ok($$ select public.undo_payment('e4000000-0000-0000-0003-0000000000fe') $$,
  '42501', null, 'anon cannot execute undo_payment');
reset role;

-- ===========================================================================
-- Criterion 22: C-G7 boundaries
-- ===========================================================================
select pg_temp.act('e4000000-0000-0000-0000-000000000001'); -- Ana
set local role authenticated;
select throws_ok($$ select public.record_payment(pg_temp.pid(90), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000002', 0, 'cash', 'manual') $$,
  '22023', 'invalid_amount', 'c22: cents 0 -> 22023 invalid_amount');
select throws_ok($$ select public.record_payment(pg_temp.pid(90), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000002', 100000000, 'cash', 'manual') $$,
  '22023', 'invalid_amount', 'c22: cents 100,000,000 -> 22023 invalid_amount');
select throws_ok($$ select public.record_payment(pg_temp.pid(90), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000002', null, 'cash', 'manual') $$,
  '22023', 'invalid_amount', 'c22: cents null -> 22023 invalid_amount');
select lives_ok($$ select public.record_payment(pg_temp.pid(1), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000002', 1, 'cash', 'manual') $$,
  'c22: cents 1 succeeds');
select lives_ok($$ select public.record_payment(pg_temp.pid(2), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000002', 99999999, 'cash', 'manual') $$,
  'c22: cents 99,999,999 succeeds');
select throws_ok($$ select public.record_payment(pg_temp.pid(90), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000001', 100, 'cash', 'manual') $$,
  '22023', 'invalid_payment', 'c22: from = to -> 22023 invalid_payment');
select throws_ok($$ select public.record_payment(pg_temp.pid(90), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000001', null, 100, 'cash', 'manual') $$,
  '22023', 'invalid_payment', 'c22: to null -> 22023 invalid_payment');
select throws_ok($$ select public.record_payment(pg_temp.pid(90), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000006', 100, 'cash', 'manual') $$,
  '22023', 'not_member', 'c22: a party who isn''t a member (Sam) -> 22023 not_member');
select throws_ok($$ select public.record_payment(pg_temp.pid(90), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000002', 100, 'other', 'bill_mark') $$,
  '22023', 'invalid_payment', 'c22/c115: source bill_mark from a client -> 22023 invalid_payment');
select throws_ok($$ select public.record_payment(null, 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000002', 100, 'cash', 'manual') $$,
  '22023', 'invalid_id', 'record_payment with p_id null -> 22023 invalid_id');
reset role;

select pg_temp.act('e4000000-0000-0000-0000-000000000004'); -- Dee, a third member
set local role authenticated;
select throws_ok($$ select public.record_payment(pg_temp.pid(90), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000002', 100, 'cash', 'manual') $$,
  '42501', 'not_allowed', 'c22: a member who is neither from nor to -> 42501 not_allowed');
reset role;

select pg_temp.act('e4000000-0000-0000-0000-000000000006'); -- Sam, not in G1
set local role authenticated;
select throws_ok($$ select public.record_payment(pg_temp.pid(90), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000006', 'e4000000-0000-0000-0000-000000000002', 100, 'cash', 'manual') $$,
  '42501', 'not_allowed', 'a non-member caller -> 42501 not_allowed');
reset role;

select pg_temp.signed_out();
set local role authenticated;
select throws_ok($$ select public.record_payment(pg_temp.pid(90), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000002', 100, 'cash', 'manual') $$,
  '42501', 'not_allowed', 'signed out -> 42501 not_allowed');
reset role;

select is(
  (select count(*)::integer from public.group_payments where id = pg_temp.pid(90)),
  0, 'c22: none of the refused calls wrote a row');

-- ===========================================================================
-- Criterion 115: method x source pairs (A2.1)
-- ===========================================================================
select pg_temp.act('e4000000-0000-0000-0000-000000000001'); -- Ana pays Ben
set local role authenticated;
select lives_ok($$ select public.record_payment(pg_temp.pid(3), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000002', 500, 'venmo', 'manual') $$,
  'c115: method venmo, source manual succeeds');
select lives_ok($$ select public.record_payment(pg_temp.pid(4), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000002', 500, 'other', 'manual') $$,
  'c115: method other, source manual succeeds');
select lives_ok($$ select public.record_payment(pg_temp.pid(5), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000003', 17497, 'venmo', 'venmo_link') $$,
  'c115: method venmo, source venmo_link succeeds');
select throws_ok($$ select public.record_payment(pg_temp.pid(91), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000002', 100, 'zelle', 'manual') $$,
  '22023', 'invalid_payment', 'c115: method zelle -> 22023 invalid_payment');
select throws_ok($$ select public.record_payment(pg_temp.pid(91), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000002', 100, 'cash', 'venmo_link') $$,
  '22023', 'invalid_payment', 'c115: source venmo_link with method cash -> 22023 invalid_payment');
select throws_ok($$ select public.record_payment(pg_temp.pid(91), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000002', 100, 'other', 'venmo_link') $$,
  '22023', 'invalid_payment', 'c115: source venmo_link with method other -> 22023 invalid_payment');
select throws_ok($$ select public.record_payment(pg_temp.pid(91), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000002', 100, 'venmo', 'venmo') $$,
  '22023', 'invalid_payment', 'the pre-A2 source value venmo -> 22023 invalid_payment');
select throws_ok($$ select public.record_payment(pg_temp.pid(91), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000002', 100, null, 'manual') $$,
  '22023', 'invalid_payment', 'method null -> 22023 invalid_payment');
reset role;

-- Either side can record: Ben (the recipient) records Cy -> Ben "Got paid another way".
select pg_temp.act('e4000000-0000-0000-0000-000000000002');
set local role authenticated;
select lives_ok($$ select public.record_payment(pg_temp.pid(6), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000003', 'e4000000-0000-0000-0000-000000000002', 13002, 'other', 'manual') $$,
  'C-G9: the recipient can record a payment to themselves');
reset role;

select results_eq(
  $$ select id, from_user, to_user, cents, method, source, recorded_by, bill_id, undone_at
     from public.group_payments where id in (pg_temp.pid(1), pg_temp.pid(2), pg_temp.pid(5), pg_temp.pid(6))
     order by id $$,
  $$ values
     (pg_temp.pid(1), 'e4000000-0000-0000-0000-000000000001'::uuid, 'e4000000-0000-0000-0000-000000000002'::uuid,
      1, 'cash', 'manual', 'e4000000-0000-0000-0000-000000000001'::uuid, null::uuid, null::timestamptz),
     (pg_temp.pid(2), 'e4000000-0000-0000-0000-000000000001'::uuid, 'e4000000-0000-0000-0000-000000000002'::uuid,
      99999999, 'cash', 'manual', 'e4000000-0000-0000-0000-000000000001'::uuid, null::uuid, null::timestamptz),
     (pg_temp.pid(5), 'e4000000-0000-0000-0000-000000000001'::uuid, 'e4000000-0000-0000-0000-000000000003'::uuid,
      17497, 'venmo', 'venmo_link', 'e4000000-0000-0000-0000-000000000001'::uuid, null::uuid, null::timestamptz),
     (pg_temp.pid(6), 'e4000000-0000-0000-0000-000000000003'::uuid, 'e4000000-0000-0000-0000-000000000002'::uuid,
      13002, 'other', 'manual', 'e4000000-0000-0000-0000-000000000002'::uuid, null::uuid, null::timestamptz) $$,
  'stored rows: the given fields, recorded_by = the caller, no bill, live');

select results_eq(
  $$ select e.actor_id, e.details from public.group_events as e
     where e.group_id = 'e4000000-0000-0000-0000-0000000000a1' and e.kind = 'payment_recorded'
       and e.details ->> 'payment_id' in (pg_temp.pid(5)::text, pg_temp.pid(6)::text)
     order by e.seq $$,
  $$ values
     ('e4000000-0000-0000-0000-000000000001'::uuid,
      jsonb_build_object('payment_id', pg_temp.pid(5), 'from', 'e4000000-0000-0000-0000-000000000001',
        'to', 'e4000000-0000-0000-0000-000000000003', 'cents', 17497, 'method', 'venmo', 'source', 'venmo_link')),
     ('e4000000-0000-0000-0000-000000000002'::uuid,
      jsonb_build_object('payment_id', pg_temp.pid(6), 'from', 'e4000000-0000-0000-0000-000000000003',
        'to', 'e4000000-0000-0000-0000-000000000002', 'cents', 13002, 'method', 'other', 'source', 'manual')) $$,
  'payment_recorded: one event each, actor = the recorder, details {payment_id, from, to, cents, method, source}');

select is(
  (select count(*)::integer from public.group_events as e
   where e.group_id = 'e4000000-0000-0000-0000-0000000000a1' and e.kind = 'payment_recorded'
     and e.details ->> 'payment_id' like 'e4000000-0000-0000-0003-%'),
  6, 'exactly one payment_recorded per successful record (6 payments)');

-- ===========================================================================
-- Criteria 23 / 116: retries and id conflicts
-- ===========================================================================
select pg_temp.act('e4000000-0000-0000-0000-000000000001');
set local role authenticated;
select lives_ok($$ select public.record_payment(pg_temp.pid(5), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000003', 17497, 'venmo', 'venmo_link') $$,
  'c23: the same id + same content again succeeds');
reset role;
select is(
  (select count(*)::integer from public.group_payments where id = pg_temp.pid(5))
  + pg_temp.events('payment_recorded', pg_temp.pid(5)) * 10,
  11, 'c23: still one row and one payment_recorded after the retry');

select pg_temp.act('e4000000-0000-0000-0000-000000000001');
set local role authenticated;
select throws_ok($$ select public.record_payment(pg_temp.pid(5), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000003', 17498, 'venmo', 'venmo_link') $$,
  '22023', 'id_conflict', 'c23: same id, other cents -> 22023 id_conflict');
select throws_ok($$ select public.record_payment(pg_temp.pid(5), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000003', 17497, 'venmo', 'manual') $$,
  '22023', 'id_conflict', 'c116: same id, other source -> 22023 id_conflict');
select throws_ok($$ select public.record_payment(pg_temp.pid(3), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000002', 500, 'cash', 'manual') $$,
  '22023', 'id_conflict', 'c116: same id, other method -> 22023 id_conflict');
select throws_ok($$ select public.record_payment(pg_temp.pid(5), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000002', 17497, 'venmo', 'venmo_link') $$,
  '22023', 'id_conflict', 'same id, other recipient -> 22023 id_conflict');
reset role;
select pg_temp.act('e4000000-0000-0000-0000-000000000003'); -- Cy, the recipient of pid(5)
set local role authenticated;
select throws_ok($$ select public.record_payment(pg_temp.pid(5), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000003', 17497, 'venmo', 'venmo_link') $$,
  '22023', 'id_conflict', 'same id and content from the other party -> 22023 id_conflict (another recorder)');
reset role;
select is(
  (select cents::text || method || source from public.group_payments where id = pg_temp.pid(5)),
  '17497venmovenmo_link', 'the conflicting calls changed nothing');

-- ===========================================================================
-- Criterion 24 + GR-M6: undo_payment
-- ===========================================================================
select pg_temp.act('e4000000-0000-0000-0000-000000000004'); -- Dee
set local role authenticated;
select throws_ok($$ select public.undo_payment(pg_temp.pid(5)) $$,
  '42501', 'not_allowed', 'c24: a third member can''t undo -> 42501 not_allowed');
reset role;
select pg_temp.act('e4000000-0000-0000-0000-000000000006'); -- Sam
set local role authenticated;
select throws_ok($$ select public.undo_payment(pg_temp.pid(5)) $$,
  '42501', 'not_allowed', 'a non-member can''t undo -> 42501 not_allowed');
select throws_ok($$ select public.undo_payment('e4000000-0000-0000-0003-0000000000ee') $$,
  '42501', 'not_allowed', 'an unknown payment id -> 42501 not_allowed (same answer)');
reset role;
select pg_temp.signed_out();
set local role authenticated;
select throws_ok($$ select public.undo_payment(pg_temp.pid(5)) $$,
  '42501', 'not_allowed', 'signed out undo -> 42501 not_allowed');
reset role;
select is((select undone_at from public.group_payments where id = pg_temp.pid(5)), null,
  'c24: refused undos left the payment live');

-- The sender's "Didn't go through? Undo".
select pg_temp.act('e4000000-0000-0000-0000-000000000001');
set local role authenticated;
select lives_ok($$ select public.undo_payment(pg_temp.pid(5)) $$, 'c24: the sender (from) can undo');
reset role;
select results_eq(
  $$ select undone_at is not null, undone_by, undone_reason from public.group_payments where id = pg_temp.pid(5) $$,
  $$ values (true, 'e4000000-0000-0000-0000-000000000001'::uuid, 'sender') $$,
  'c24/GR-M6: soft undo by the sender: row kept, undone_by = Ana, undone_reason = sender');
select results_eq(
  $$ select e.actor_id, e.details from public.group_events as e
     where e.group_id = 'e4000000-0000-0000-0000-0000000000a1' and e.kind = 'payment_undone'
       and e.details ->> 'payment_id' = pg_temp.pid(5)::text $$,
  $$ values ('e4000000-0000-0000-0000-000000000001'::uuid,
             jsonb_build_object('payment_id', pg_temp.pid(5), 'undone_reason', 'sender')) $$,
  'c24: one payment_undone, actor = the sender, details {payment_id, undone_reason: sender}');

-- Repeats: by the same person, and by the other party, are no-ops (first reason kept).
update public.group_payments set undone_at = undone_at - interval '1 hour' where id = pg_temp.pid(5);
select pg_temp.act('e4000000-0000-0000-0000-000000000001');
set local role authenticated;
select lives_ok($$ select public.undo_payment(pg_temp.pid(5)) $$, 'c24: a repeat undo succeeds');
reset role;
select pg_temp.act('e4000000-0000-0000-0000-000000000003');
set local role authenticated;
select lives_ok($$ select public.undo_payment(pg_temp.pid(5)) $$,
  'c24: an undo by the other party of an already-undone payment succeeds');
reset role;
select results_eq(
  $$ select undone_at < now() - interval '59 minutes', undone_by, undone_reason,
            pg_temp.events('payment_undone', pg_temp.pid(5))
     from public.group_payments where id = pg_temp.pid(5) $$,
  $$ values (true, 'e4000000-0000-0000-0000-000000000001'::uuid, 'sender', 1) $$,
  'c24: repeats are no-ops: undone_at (backdated) unchanged, first undoer and reason kept, one event');

-- The recipient's "Not received" (GR-M6): Ben undoes Ana -> Ben pid(1).
select pg_temp.act('e4000000-0000-0000-0000-000000000002');
set local role authenticated;
select lives_ok($$ select public.undo_payment(pg_temp.pid(1)) $$, 'c24: the recipient (to) can undo');
reset role;
select results_eq(
  $$ select p.undone_by, p.undone_reason, e.actor_id, e.details
     from public.group_payments as p
     join public.group_events as e
       on e.group_id = p.group_id and e.kind = 'payment_undone' and e.details ->> 'payment_id' = p.id::text
     where p.id = pg_temp.pid(1) $$,
  $$ values ('e4000000-0000-0000-0000-000000000002'::uuid, 'not_received',
             'e4000000-0000-0000-0000-000000000002'::uuid,
             jsonb_build_object('payment_id', pg_temp.pid(1), 'undone_reason', 'not_received')) $$,
  'GR-M6: an undo by the recipient stores and logs undone_reason = not_received');

-- A recipient-recorded payment undone by its sender: reason follows who undoes (sender).
select pg_temp.act('e4000000-0000-0000-0000-000000000003');
set local role authenticated;
select lives_ok($$ select public.undo_payment(pg_temp.pid(6)) $$,
  'the sender can undo a payment the recipient recorded');
reset role;
select is((select undone_reason from public.group_payments where id = pg_temp.pid(6)), 'sender',
  'GR-M6: the reason follows who undoes, not who recorded');

select ok(
  (select count(*) = 1 from public.group_payments
   where group_id = 'e4000000-0000-0000-0000-0000000000a1' and undone_reason = 'not_received'
     and id::text like 'e4000000-0000-0000-0003-%'),
  'GR-M6: exactly the recipient-undone fixture payment carries not_received (T6''s list)');

-- ===========================================================================
-- Criterion 101: reusing an undone payment's id
-- ===========================================================================
select pg_temp.act('e4000000-0000-0000-0000-000000000001');
set local role authenticated;
select lives_ok($$ select public.record_payment(pg_temp.pid(5), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000003', 17497, 'venmo', 'venmo_link') $$,
  'c101: record_payment with an undone payment''s id and the same content succeeds');
reset role;
select results_eq(
  $$ select undone_at is not null, undone_reason, pg_temp.events('payment_recorded', pg_temp.pid(5)),
            pg_temp.events('payment_undone', pg_temp.pid(5))
     from public.group_payments where id = pg_temp.pid(5) $$,
  $$ values (true, 'sender', 1, 1) $$,
  'c101: the row stays undone, and no new event');

-- ===========================================================================
-- RLS reads
-- ===========================================================================
select pg_temp.act('e4000000-0000-0000-0000-000000000004'); -- Dee, member, no party
set local role authenticated;
select is(
  (select count(*)::integer from (select * from public.group_payments
   where group_id = 'e4000000-0000-0000-0000-0000000000a1') as t),
  6, 'a member reads every payment of the group (undone included) with select *');
reset role;
select pg_temp.act('e4000000-0000-0000-0000-000000000006'); -- Sam
set local role authenticated;
select is(
  (select count(*)::integer from public.group_payments
   where group_id = 'e4000000-0000-0000-0000-0000000000a1'),
  0, 'a non-member reads 0 payments of the group');
reset role;

-- ===========================================================================
-- Table constraints (as postgres, the T5 attach path's role)
-- ===========================================================================
select throws_ok($$
  insert into public.group_payments (id, group_id, from_user, to_user, cents, method, source, recorded_by)
  values (pg_temp.pid(80), 'e4000000-0000-0000-0000-0000000000a1', 'e4000000-0000-0000-0000-000000000001',
          'e4000000-0000-0000-0000-000000000002', 100, 'cash', 'venmo_link', 'e4000000-0000-0000-0000-000000000001') $$,
  '23514', null, 'table check: venmo_link with method cash is refused');
select throws_ok($$
  insert into public.group_payments (id, group_id, from_user, to_user, cents, method, source, recorded_by)
  values (pg_temp.pid(80), 'e4000000-0000-0000-0000-0000000000a1', 'e4000000-0000-0000-0000-000000000001',
          'e4000000-0000-0000-0000-000000000002', 100, 'zelle', 'manual', 'e4000000-0000-0000-0000-000000000001') $$,
  '23514', null, 'table check: method is checked by private.is_payment_method');
select throws_ok($$
  insert into public.group_payments (id, group_id, from_user, to_user, cents, method, source, recorded_by,
                                     undone_at, undone_by, undone_reason)
  values (pg_temp.pid(80), 'e4000000-0000-0000-0000-0000000000a1', 'e4000000-0000-0000-0000-000000000001',
          'e4000000-0000-0000-0000-000000000002', 100, 'cash', 'manual', 'e4000000-0000-0000-0000-000000000001',
          now(), 'e4000000-0000-0000-0000-000000000001', 'not_received') $$,
  '23514', null, 'table check: not_received only when the recipient undid it');
select throws_ok($$
  insert into public.group_payments (id, group_id, from_user, to_user, cents, method, source, recorded_by)
  values (pg_temp.pid(80), 'e4000000-0000-0000-0000-0000000000a1', 'e4000000-0000-0000-0000-000000000001',
          'e4000000-0000-0000-0000-000000000002', 100, 'cash', 'manual', 'e4000000-0000-0000-0000-000000000004') $$,
  '23514', null, 'table check: recorded_by is from or to');
select lives_ok($$
  insert into public.group_payments (id, group_id, from_user, to_user, cents, method, source, recorded_by)
  values (pg_temp.pid(81), 'e4000000-0000-0000-0000-0000000000a1', 'e4000000-0000-0000-0000-000000000003',
          'e4000000-0000-0000-0000-000000000001', 950, 'cash', 'bill_mark', 'e4000000-0000-0000-0000-000000000003') $$,
  'table: a bill_mark row with method cash is allowed (T5''s conversion)');
select throws_ok($$
  delete from public.group_members
  where group_id = 'e4000000-0000-0000-0000-0000000000a1' and user_id = 'e4000000-0000-0000-0000-000000000003' $$,
  '23503', null, 'restrict FK: a membership with payment history can''t be deleted');

-- ===========================================================================
-- Criterion 31 (payment part): leave_group
-- ===========================================================================
-- Fay: from of an undone payment only. Gil: to of a live payment only (Fay records both).
select pg_temp.act('e4000000-0000-0000-0000-000000000007');
set local role authenticated;
select public.record_payment(pg_temp.pid(10), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000007', 'e4000000-0000-0000-0000-000000000004', 300, 'cash', 'manual');
select public.undo_payment(pg_temp.pid(10));
reset role;
select pg_temp.act('e4000000-0000-0000-0000-000000000004'); -- Dee pays Gil
set local role authenticated;
select public.record_payment(pg_temp.pid(11), 'e4000000-0000-0000-0000-0000000000a1',
  'e4000000-0000-0000-0000-000000000004', 'e4000000-0000-0000-0000-000000000008', 300, 'cash', 'manual');
reset role;

select pg_temp.act('e4000000-0000-0000-0000-000000000007');
set local role authenticated;
select throws_ok($$ select public.leave_group('e4000000-0000-0000-0000-0000000000a1') $$,
  '22023', 'cannot_leave', 'c31: from (and recorder) of an undone payment -> 22023 cannot_leave');
reset role;
select pg_temp.act('e4000000-0000-0000-0000-000000000008');
set local role authenticated;
select throws_ok($$ select public.leave_group('e4000000-0000-0000-0000-0000000000a1') $$,
  '22023', 'cannot_leave', 'c31: to of a payment (not the recorder) -> 22023 cannot_leave');
reset role;
-- "Recorder" alone can't exist (table check: recorded_by is from or to), so Fay's case covers
-- from + recorder, and Gil's covers to without being the recorder.
select results_eq(
  $$ select count(*)::integer from public.group_members
     where group_id = 'e4000000-0000-0000-0000-0000000000a1'
       and user_id in ('e4000000-0000-0000-0000-000000000007', 'e4000000-0000-0000-0000-000000000008') $$,
  $$ values (2) $$,
  'c31: the refused leaves changed nothing');
select ok(
  not exists (select 1 from public.group_events
              where group_id = 'e4000000-0000-0000-0000-0000000000a1' and kind = 'member_left'
                and actor_id in ('e4000000-0000-0000-0000-000000000007', 'e4000000-0000-0000-0000-000000000008')),
  'c31: refused leaves logged nothing');

select pg_temp.act('e4000000-0000-0000-0000-000000000005'); -- Lee, no history
set local role authenticated;
select lives_ok($$ select public.leave_group('e4000000-0000-0000-0000-0000000000a1') $$,
  'c31: a member with no payment (or expense) history can leave');
reset role;
select results_eq(
  $$ select (select count(*)::integer from public.group_members
             where group_id = 'e4000000-0000-0000-0000-0000000000a1'
               and user_id = 'e4000000-0000-0000-0000-000000000005'),
            (select count(*)::integer from public.group_events
             where group_id = 'e4000000-0000-0000-0000-0000000000a1' and kind = 'member_left'
               and actor_id = 'e4000000-0000-0000-0000-000000000005') $$,
  $$ values (0, 1) $$,
  'c31: Lee''s membership is gone and one member_left is logged');
select is(
  (select count(*)::integer from public.group_payments
   where group_id = 'e4000000-0000-0000-0000-0000000000a1' and id::text like 'e4000000-0000-0000-0003-%'),
  9, 'c31: no payment changed or disappeared through leaving');

-- ===========================================================================
-- Criterion 34: lock order, from the function bodies
-- ===========================================================================
-- Delete group (20261128100232, A2.5): both now take the group row FOR KEY SHARE once, as their
-- first lock. Apart from that one statement, the old rule holds.
select ok(
  (select bool_and((select count(*) from regexp_matches(pg_temp.body(f::regprocedure), 'perform 1 from public\.groups as g where g\.id = [pv]_group_id for key share;', 'g')) = 1
                   and r.b not like '%public.groups%'
                   and r.b not like '%for update%'
                   and r.b not like '%for share%'
                   and r.b not like '%for key share%')
   from unnest(array['public.record_payment(uuid, uuid, uuid, uuid, bigint, text, text)',
                     'public.undo_payment(uuid)']) as f
   cross join lateral (select regexp_replace(pg_temp.body(f::regprocedure), 'perform 1 from public\.groups as g where g\.id = [pv]_group_id for key share;', '') as b) as r)
  and pg_temp.body('public.record_payment(uuid, uuid, uuid, uuid, bigint, text, text)') not like '%for no key update%',
  'c34(a) as amended by delete group: record/undo take one explicit group lock (FOR KEY SHARE) and no membership lock; record no row lock');
select ok(
  position('from public.group_members' in pg_temp.body('public.undo_payment(uuid)'))
    between 1 and position('for no key update' in pg_temp.body('public.undo_payment(uuid)')) - 1
  and position('for no key update' in pg_temp.body('public.undo_payment(uuid)'))
    < position('update public.group_payments' in pg_temp.body('public.undo_payment(uuid)'))
  and (length(pg_temp.body('public.undo_payment(uuid)'))
       - length(replace(pg_temp.body('public.undo_payment(uuid)'), 'for no key update', ''))) = length('for no key update'),
  'c34: undo_payment checks who may act unlocked, then locks only the payment row, then updates');
select ok(
  position('for no key update' in pg_temp.body('public.leave_group(uuid)'))
    < position('from public.expenses' in pg_temp.body('public.leave_group(uuid)'))
  and position('from public.expenses' in pg_temp.body('public.leave_group(uuid)'))
    < position('from public.group_payments' in pg_temp.body('public.leave_group(uuid)'))
  and position('from public.group_payments' in pg_temp.body('public.leave_group(uuid)'))
    < position('delete from public.expense_shares' in pg_temp.body('public.leave_group(uuid)'))
  and position('delete from public.expense_shares' in pg_temp.body('public.leave_group(uuid)'))
    < position('delete from public.group_members' in pg_temp.body('public.leave_group(uuid)'))
  and pg_temp.body('public.leave_group(uuid)') !~ 'for update\s*;',
  'c34(d): leave_group locks the group, checks expense then payment history, drops $0 shares, then deletes membership');

select * from finish();
rollback;
