-- pgTAP tests for Who paid Task 4b (spec docs/specs/2026-11-26-who-paid.md, amendment A1;
-- migration 20261127140002_who_paid.sql): public.bill_payers, set_payers (table W, error order),
-- set_payer (2 args), contract M (payers_changed.moved), stale amounts (payers_stale), rule E',
-- table L (leave/remove), account deletion of a co-payer or host, Groups (in_group, split_paying,
-- attach converting entries), grants, RLS, execute privileges and the event kind list.
-- Criteria: A-10, A-11, A-12, A-13 (E'), A-17, A-18, A-18b, A-18c, A-19 (bill_payers), A-20.
--
-- Every assertion filters to the fixture bills/users below (the local DB may hold real data).
-- The W12/W13 users are the literals shared with lib's Jest tests:
--   A = 9fffffff-ffff-4fff-8fff-ffffffffffff, B = a0000000-0000-4000-8000-000000000000 (A < B).
-- Other users are f2000000-0000-4000-8000-000000XXXXXX (pg_temp.u('XXXXXX')).
--
-- Bills: W (total 10021, host Wren, A and B joined), W13 (total 10020), W8 (total 99999999 set
-- by the owner: line items top out at 9999999, so create_bill can't make it), M (contract M),
-- S (stale, rule E'), Z (all $0 with tax: all_zero), L (table L), T (co-payer deleted),
-- U (host deleted), V and V2 (Groups).

begin;

create extension if not exists pgtap with schema extensions;

select plan(116);

create function pg_temp.u(p_suffix text) returns uuid language sql immutable as $$
  select ('f2000000-0000-4000-8000-000000' || p_suffix)::uuid
$$;
create function pg_temp.a() returns uuid language sql immutable as $$ select '9fffffff-ffff-4fff-8fff-ffffffffffff'::uuid $$;
create function pg_temp.b() returns uuid language sql immutable as $$ select 'a0000000-0000-4000-8000-000000000000'::uuid $$;

insert into auth.users (id, email, raw_user_meta_data)
select v.id, 'whopaid-' || v.name || '@test.local', jsonb_build_object('full_name', v.name)
from (values
  ('f2000000-0000-4000-8000-000000000001'::uuid, 'Wren'),
  ('9fffffff-ffff-4fff-8fff-ffffffffffff'::uuid, 'Ava'),
  ('a0000000-0000-4000-8000-000000000000'::uuid, 'Ben'),
  ('f2000000-0000-4000-8000-000000000003'::uuid, 'Cy'),
  ('f2000000-0000-4000-8000-0000000001a0'::uuid, 'Mia'),
  ('f2000000-0000-4000-8000-0000000001b0'::uuid, 'Max'),
  ('f2000000-0000-4000-8000-0000000001c0'::uuid, 'Moe'),
  ('f2000000-0000-4000-8000-000000000290'::uuid, 'Priya'),
  ('f2000000-0000-4000-8000-0000000002a0'::uuid, 'Ann'),
  ('f2000000-0000-4000-8000-0000000002d0'::uuid, 'Dee'),
  ('f2000000-0000-4000-8000-0000000002e0'::uuid, 'Sam'),
  ('f2000000-0000-4000-8000-0000000002f0'::uuid, 'Pat'),
  ('f2000000-0000-4000-8000-0000000003a0'::uuid, 'Sia'),
  ('f2000000-0000-4000-8000-0000000003b0'::uuid, 'Sol'),
  ('f2000000-0000-4000-8000-0000000003d0'::uuid, 'Sid'),
  ('f2000000-0000-4000-8000-0000000004a0'::uuid, 'Lee'),
  ('f2000000-0000-4000-8000-0000000004b0'::uuid, 'Lou'),
  ('f2000000-0000-4000-8000-0000000004c0'::uuid, 'Kit'),
  ('f2000000-0000-4000-8000-0000000004d0'::uuid, 'Gus'),
  ('f2000000-0000-4000-8000-0000000004e0'::uuid, 'Yan'),
  ('f2000000-0000-4000-8000-0000000004f0'::uuid, 'Flo'),
  ('f2000000-0000-4000-8000-000000000400'::uuid, 'Zed'),
  ('f2000000-0000-4000-8000-0000000005a0'::uuid, 'Tia'),
  ('f2000000-0000-4000-8000-0000000005b0'::uuid, 'Tom'),
  ('f2000000-0000-4000-8000-0000000005c0'::uuid, 'Tess'),
  ('f2000000-0000-4000-8000-0000000006a0'::uuid, 'Uma'),
  ('f2000000-0000-4000-8000-0000000006b0'::uuid, 'Udo'),
  ('f2000000-0000-4000-8000-0000000006c0'::uuid, 'Uri'),
  ('f2000000-0000-4000-8000-0000000007a0'::uuid, 'Gia'),
  ('f2000000-0000-4000-8000-0000000007b0'::uuid, 'Gil'),
  ('f2000000-0000-4000-8000-0000000007c0'::uuid, 'Gem')
) as v(id, name);

create function pg_temp.act(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

-- Runs p_sql as p_user in the authenticated role. An error inside rolls back with the caller's
-- subtransaction (throws_ok), which also reverts the role.
create function pg_temp.run(p_user uuid, p_sql text) returns void language plpgsql as $$
begin
  perform pg_temp.act(p_user);
  set local role authenticated;
  execute p_sql;
  reset role;
end $$;

-- The statement text for throws_ok / lives_ok that runs p_sql as p_user.
create function pg_temp.as_sql(p_user uuid, p_sql text) returns text language sql immutable as $$
  select format('select pg_temp.run(%L::uuid, %L)', p_user, p_sql)
$$;

create function pg_temp.bid(p_key text) returns uuid language sql stable as $$
  select current_setting('test.' || p_key || '_id')::uuid
$$;

create function pg_temp.mk(p_host uuid, p_key text, p_items jsonb, p_tax integer, p_total integer)
returns void language plpgsql as $$
declare r record;
begin
  perform pg_temp.act(p_host);
  set local role authenticated;
  select * into r from public.create_bill(p_items, null, p_tax, 0, 0, 0, 0, p_total);
  reset role;
  perform set_config('test.' || p_key || '_id', r.bill_id::text, true);
  perform set_config('test.' || p_key || '_code', r.join_code, true);
end $$;

create function pg_temp.item(p_name text, p_cents integer, p_pos integer default 0) returns jsonb
language sql immutable as $$
  select jsonb_build_object('name', p_name, 'note', null, 'group_position', p_pos,
    'unit_index', 0, 'group_size', 1, 'total_cents', p_cents)
$$;

create function pg_temp.join(p_user uuid, p_key text) returns void language sql as $$
  select pg_temp.run(p_user,
    format('select public.join_bill(%L)', current_setting('test.' || p_key || '_code')));
$$;

create function pg_temp.claim(p_user uuid, p_key text, p_name text) returns void language sql as $$
  select pg_temp.run(p_user, format('select public.set_claim(%L::uuid, true)',
    (select li.id from public.line_items as li
     where li.bill_id = pg_temp.bid(p_key) and li.name = p_name)));
$$;

-- set_payers as p_user; p_payers is the raw jsonb argument.
create function pg_temp.sp(p_user uuid, p_key text, p_payers jsonb) returns void language sql as $$
  select pg_temp.run(p_user, format('select public.set_payers(%L::uuid, %L::jsonb)',
    pg_temp.bid(p_key), p_payers));
$$;

-- [{user_id, paid_cents}] from parallel arrays.
create function pg_temp.pj(p_ids uuid[], p_cents integer[]) returns jsonb language sql immutable as $$
  select jsonb_agg(jsonb_build_object('user_id', i, 'paid_cents', c) order by n)
  from unnest(p_ids, p_cents) with ordinality as t(i, c, n)
$$;

-- An owner-inserted ledger entry / flag.
create function pg_temp.e(p_key text, p_from uuid, p_to uuid, p_cents integer) returns void
language sql as $$
  insert into public.bill_payments (bill_id, from_user, to_user, cents, method, recorded_by)
  values (pg_temp.bid(p_key), p_from, p_to, p_cents, 'other', p_from);
$$;
create function pg_temp.f(p_key text, p_from uuid, p_to uuid, p_cents integer) returns void
language sql as $$
  insert into public.bill_payment_flags (bill_id, from_user, to_user, cents, method)
  values (pg_temp.bid(p_key), p_from, p_to, p_cents, 'venmo');
$$;

-- The payers_changed events on a bill not returned before (each action's events, once).
create temp table seen_events (id uuid primary key);
create function pg_temp.fresh(p_key text) returns setof jsonb language plpgsql as $$
begin
  return query
    select e.details from public.bill_events as e
    where e.bill_id = pg_temp.bid(p_key) and e.kind = 'payers_changed'
      and e.id not in (select s.id from seen_events as s);
  insert into seen_events
    select e.id from public.bill_events as e
    where e.bill_id = pg_temp.bid(p_key) and e.kind = 'payers_changed'
    on conflict do nothing;
end $$;

create function pg_temp.lead(p_key text) returns uuid language sql stable as $$
  select b.payer_id from public.bills as b where b.id = pg_temp.bid(p_key)
$$;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
select pg_temp.mk(pg_temp.u('000001'), 'w', jsonb_build_array(pg_temp.item('Feast', 10021)), 0, 10021);
select pg_temp.mk(pg_temp.u('000001'), 'w13', jsonb_build_array(pg_temp.item('Feast', 10020)), 0, 10020);
select pg_temp.mk(pg_temp.u('000001'), 'w8', jsonb_build_array(pg_temp.item('Feast', 9999999)), 0, 9999999);
update public.bills set total_cents = 99999999 where id = pg_temp.bid('w8');
select pg_temp.join(u, k)
from unnest(array[pg_temp.a(), pg_temp.b()]) as u cross join unnest(array['w', 'w13', 'w8']) as k;

-- ---------------------------------------------------------------------------
-- bill_payers: structure, grants, RLS (A-19)
-- ---------------------------------------------------------------------------
select has_table('public', 'bill_payers', 'A-19: public.bill_payers exists');
select col_type_is('public', 'bill_payers', 'paid_cents', 'integer', 'D1: paid_cents is integer cents');
select table_privs_are('public', 'bill_payers', 'authenticated', array['SELECT'],
  'A-19: authenticated may only SELECT bill_payers');
select table_privs_are('public', 'bill_payers', 'anon', array[]::text[],
  'A-19: anon has no privilege on bill_payers');
select table_privs_are('public', 'bill_payers', 'service_role', array[]::text[],
  'A-19: service_role has no privilege on bill_payers');
select ok(
  (select c.relrowsecurity from pg_class as c join pg_namespace as n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'bill_payers'),
  'A-19: RLS is enabled on bill_payers');

-- ---------------------------------------------------------------------------
-- set_payers: who may call it (42501) and table W (total 10021)
-- ---------------------------------------------------------------------------
select throws_ok(
  format($f$ select pg_temp.sp(%L, 'w', %L) $f$, pg_temp.a(),
         pg_temp.pj(array[pg_temp.a(), pg_temp.b()], array[6000, 4021])),
  '42501', 'not_allowed', 'D1: a participant who is not the host gets not_allowed');
select throws_ok(
  format($f$ select pg_temp.sp(%L, 'w', %L) $f$, pg_temp.u('000003'),
         pg_temp.pj(array[pg_temp.a(), pg_temp.b()], array[6000, 4021])),
  '42501', 'not_allowed', 'D1: an outsider gets not_allowed');

set local role anon;
select throws_ok(
  format($f$ select public.set_payers(%L::uuid, '[]'::jsonb) $f$, pg_temp.bid('w')),
  '42501', null, 'A-20: anon cannot execute set_payers');
reset role;

create function pg_temp.w(p_payers jsonb) returns text language sql stable as $$
  select format($f$ select pg_temp.sp(%L, 'w', %L) $f$, pg_temp.u('000001'), p_payers)
$$;

select throws_ok(pg_temp.w(pg_temp.pj(array[pg_temp.a(), pg_temp.b()], array[6000, 4020])),
  '22023', 'payers_total', 'W2: a sum of total - 1 gives payers_total');
select throws_ok(pg_temp.w(pg_temp.pj(array[pg_temp.a(), pg_temp.b()], array[6000, 4022])),
  '22023', 'payers_total', 'W3: a sum of total + 1 gives payers_total');
select throws_ok(pg_temp.w(pg_temp.pj(array[pg_temp.a()], array[10021])),
  '22023', 'invalid_payers', 'W4: one entry gives invalid_payers');
select throws_ok(pg_temp.w(pg_temp.pj(array[pg_temp.a(), pg_temp.a()], array[6000, 4021])),
  '22023', 'invalid_payers', 'W5: a duplicate person gives invalid_payers');
select throws_ok(pg_temp.w(pg_temp.pj(array[pg_temp.a(), pg_temp.b()], array[10021, 0])),
  '22023', 'invalid_amount', 'W6: 0 gives invalid_amount');
select throws_ok(pg_temp.w(pg_temp.pj(array[pg_temp.a(), pg_temp.b()], array[10022, -1])),
  '22023', 'invalid_amount', 'W7: a negative amount gives invalid_amount');
select throws_ok(pg_temp.w(pg_temp.pj(array[pg_temp.a(), pg_temp.b()], array[100000000, 1])),
  '22023', 'invalid_amount', 'W9: 100000000 gives invalid_amount');
select throws_ok(pg_temp.w(pg_temp.pj(array[pg_temp.a(), pg_temp.u('000003')], array[6000, 4021])),
  '22023', 'not_participant', 'W10: a non-participant gives not_participant');
select throws_ok(pg_temp.w(
  '[{"user_id":"9fffffff-ffff-4fff-8fff-ffffffffffff","paid_cents":60.5},
    {"user_id":"a0000000-0000-4000-8000-000000000000","paid_cents":9961}]'::jsonb),
  '22023', 'invalid_amount', 'W11: a fractional amount gives invalid_amount');
select throws_ok(pg_temp.w(
  '[{"user_id":"9fffffff-ffff-4fff-8fff-ffffffffffff","paid_cents":"6000"},
    {"user_id":"a0000000-0000-4000-8000-000000000000","paid_cents":4021}]'::jsonb),
  '22023', 'invalid_amount', 'W11: an amount given as a string gives invalid_amount');
select throws_ok(pg_temp.w(
  '[{"user_id":"9fffffff-ffff-4fff-8fff-ffffffffffff","paid_cents":6000.0},
    {"user_id":"a0000000-0000-4000-8000-000000000000","paid_cents":4021}]'::jsonb),
  '22023', 'invalid_amount', 'W14: 6000.0 gives invalid_amount');

-- Shape errors (invalid_payers).
select throws_ok(pg_temp.w('{"user_id":"9fffffff-ffff-4fff-8fff-ffffffffffff"}'::jsonb),
  '22023', 'invalid_payers', 'D1: a non-array gives invalid_payers');
select throws_ok(pg_temp.w(
  '[{"user_id":"9fffffff-ffff-4fff-8fff-ffffffffffff"},
    {"user_id":"a0000000-0000-4000-8000-000000000000","paid_cents":4021}]'::jsonb),
  '22023', 'invalid_payers', 'D1: an entry without paid_cents gives invalid_payers');
select throws_ok(pg_temp.w(
  '[{"user_id":"not-a-uuid","paid_cents":6000},
    {"user_id":"a0000000-0000-4000-8000-000000000000","paid_cents":4021}]'::jsonb),
  '22023', 'invalid_payers', 'D1: a malformed user id gives invalid_payers');
select throws_ok(pg_temp.w(
  (select jsonb_agg(jsonb_build_object('user_id', gen_random_uuid(), 'paid_cents', 1))
   from generate_series(1, 51))),
  '22023', 'invalid_payers', 'D1: 51 entries give invalid_payers');

-- Error order: the earlier check wins when a call breaks two rules.
select throws_ok(pg_temp.w(pg_temp.pj(array[pg_temp.a()], array[0])),
  '22023', 'invalid_payers', 'order: invalid_payers (count) before invalid_amount');
select throws_ok(pg_temp.w(pg_temp.pj(array[pg_temp.a(), pg_temp.u('000003')], array[10021, 0])),
  '22023', 'invalid_amount', 'order: invalid_amount before not_participant');
select throws_ok(pg_temp.w(pg_temp.pj(array[pg_temp.a(), pg_temp.u('000003')], array[6000, 1])),
  '22023', 'not_participant', 'order: not_participant before payers_total');

select is(
  (select count(*)::int from public.bill_payers where bill_id = pg_temp.bid('w')), 0,
  'W: refused calls wrote nothing');
select is(
  (select count(*)::int from public.bill_events
   where bill_id = pg_temp.bid('w') and kind = 'payers_changed'), 0,
  'W: refused calls logged nothing');

-- W1 (with its broadcast and event).
delete from realtime.messages where topic = 'bill:' || pg_temp.bid('w')::text;
select lives_ok(pg_temp.w(pg_temp.pj(array[pg_temp.a(), pg_temp.b()], array[6000, 4021])),
  'W1: A 6000, B 4021 is accepted');
select results_eq(
  $$ select user_id, paid_cents from public.bill_payers where bill_id = pg_temp.bid('w')
     order by user_id $$,
  $$ values (pg_temp.a(), 6000), (pg_temp.b(), 4021) $$,
  'W1: the rows are written');
select is(pg_temp.lead('w'), pg_temp.a(), 'W1: payer_id becomes the lead (A, the larger amount)');
select results_eq(
  $$ select * from pg_temp.fresh('w') $$,
  format($f$ values (%L::jsonb) $f$, jsonb_build_object(
    'before', jsonb_build_array(jsonb_build_object('user_id', pg_temp.u('000001'), 'cents', 10021)),
    'after', jsonb_build_array(jsonb_build_object('user_id', pg_temp.a(), 'cents', 6000),
                               jsonb_build_object('user_id', pg_temp.b(), 'cents', 4021)),
    'moved', '[]'::jsonb)),
  'W1: one payers_changed event {before, after, moved}');
select results_eq(
  $$ select payload ->> 't' from realtime.messages
     where topic = 'bill:' || pg_temp.bid('w')::text order by 1 $$,
  $$ values ('bill_payers'::text), ('bills'::text) $$,
  'W1: one bill_payers hint and one bills hint (the lead changed)');

-- W14: jsonb stores 6e3 as the number 6000, so it is the same split as W1 (a no-op).
select lives_ok(pg_temp.w(
  '[{"user_id":"9fffffff-ffff-4fff-8fff-ffffffffffff","paid_cents":6e3},
    {"user_id":"a0000000-0000-4000-8000-000000000000","paid_cents":4021}]'::jsonb),
  'W14: 6e3 is read as 6000 (jsonb normalizes it; recorded deviation)');
select is_empty($$ select * from pg_temp.fresh('w') $$,
  'M5: the identical split again is a no-op without an event');

-- W12: lead by amount; W13: a tie goes to the lower id.
select lives_ok(pg_temp.w(pg_temp.pj(array[pg_temp.a(), pg_temp.b()], array[5011, 5010])),
  'W12: A 5011, B 5010 is accepted');
select is(pg_temp.lead('w'), pg_temp.a(), 'W12: the lead is A');
select lives_ok(pg_temp.w(pg_temp.pj(array[pg_temp.a(), pg_temp.b()], array[5010, 5011])),
  'W12: A 5010, B 5011 is accepted');
select is(pg_temp.lead('w'), pg_temp.b(), 'W12: the lead is now B');
select is((select count(*)::int from pg_temp.fresh('w')), 2, 'W12: one event per change');

select lives_ok(
  format($f$ select pg_temp.sp(%L, 'w13', %L) $f$, pg_temp.u('000001'),
         pg_temp.pj(array[pg_temp.b(), pg_temp.a()], array[5010, 5010])),
  'W13: a tie on a 10020 bill is accepted');
select is(pg_temp.lead('w13'), pg_temp.a(), 'W13: the tie goes to the lower id (A)');

select lives_ok(
  format($f$ select pg_temp.sp(%L, 'w8', %L) $f$, pg_temp.u('000001'),
         pg_temp.pj(array[pg_temp.a(), pg_temp.b()], array[99999998, 1])),
  'W8: A 99999998, B 1 on a 99999999 bill is accepted');

-- bill_payers reads (A-19).
select pg_temp.act(pg_temp.a());
set local role authenticated;
select is((select count(*)::int from public.bill_payers where bill_id = pg_temp.bid('w')), 2,
  'A-19: a participant reads the bill''s payers');
select throws_ok(
  format($f$ insert into public.bill_payers (bill_id, user_id, paid_cents) values (%L, %L, 1) $f$,
         pg_temp.bid('w'), pg_temp.a()),
  '42501', null, 'A-19: a client cannot insert bill_payers');
select throws_ok(
  format($f$ update public.bill_payers set paid_cents = 1 where bill_id = %L $f$, pg_temp.bid('w')),
  '42501', null, 'A-19: a client cannot update bill_payers');
select throws_ok(
  format($f$ delete from public.bill_payers where bill_id = %L $f$, pg_temp.bid('w')),
  '42501', null, 'A-19: a client cannot delete bill_payers');
reset role;
select pg_temp.act(pg_temp.u('000003'));
set local role authenticated;
select is((select count(*)::int from public.bill_payers where bill_id = pg_temp.bid('w')), 0,
  'A-19: a non-participant reads no payers');
reset role;
set local role anon;
select throws_ok($$ select 1 from public.bill_payers limit 1 $$, '42501', null,
  'A-19: anon cannot read bill_payers');
reset role;

-- ---------------------------------------------------------------------------
-- A-11: set_payer has 2 args
-- ---------------------------------------------------------------------------
select ok(to_regprocedure('public.set_payer(uuid,uuid,integer)') is null,
  'A-11: the 3-arg set_payer is gone');
select ok(to_regprocedure('public.set_payer(uuid,uuid)') is not null,
  'A-11: set_payer(uuid, uuid) exists');

-- ---------------------------------------------------------------------------
-- A-10: table M (pairs Sam->Mia 1510, Dee->Mia 1200, Pat->Max 900, Priya->Sam 500;
-- Ann has a flag only, to Mia). Mia (host) < Max < Moe.
-- ---------------------------------------------------------------------------
select pg_temp.mk(pg_temp.u('0001a0'), 'm', jsonb_build_array(pg_temp.item('Dinner', 10000)), 0, 10000);
select pg_temp.join(u, 'm') from unnest(array[pg_temp.u('0001b0'), pg_temp.u('0001c0'),
  pg_temp.u('000290'), pg_temp.u('0002a0'), pg_temp.u('0002d0'), pg_temp.u('0002e0'),
  pg_temp.u('0002f0')]) as u;
select pg_temp.e('m', pg_temp.u('0002e0'), pg_temp.u('0001a0'), 1510);
select pg_temp.e('m', pg_temp.u('0002d0'), pg_temp.u('0001a0'), 1200);
select pg_temp.e('m', pg_temp.u('0002f0'), pg_temp.u('0001b0'), 900);
select pg_temp.e('m', pg_temp.u('000290'), pg_temp.u('0002e0'), 500);
select pg_temp.f('m', pg_temp.u('0002a0'), pg_temp.u('0001a0'), 700);

create function pg_temp.mp(p_ids uuid[], p_cents integer[]) returns text language sql stable as $$
  select format($f$ select pg_temp.sp(%L, 'm', %L) $f$, pg_temp.u('0001a0'), pg_temp.pj(p_ids, p_cents))
$$;
create function pg_temp.mv(p_from text, p_to text, p_cents integer) returns jsonb language sql immutable as $$
  select jsonb_build_object('from_user', pg_temp.u(p_from), 'to_user', pg_temp.u(p_to), 'cents', p_cents)
$$;

select lives_ok(pg_temp.mp(array[pg_temp.u('0001a0'), pg_temp.u('0001b0')], array[6000, 4000]),
  'M6: Mia -> Mia + Max');
select results_eq($$ select d -> 'moved' from pg_temp.fresh('m') as d $$,
  $$ values ('[]'::jsonb) $$, 'M6: nothing moved');

delete from realtime.messages where topic = 'bill:' || pg_temp.bid('m')::text;
select lives_ok(pg_temp.mp(array[pg_temp.u('0001a0'), pg_temp.u('0001b0')], array[5000, 5000]),
  'M2: Mia + Max with new amounts');
select results_eq($$ select d -> 'moved' from pg_temp.fresh('m') as d $$,
  $$ values ('[]'::jsonb) $$, 'M2: nothing moved, and an event is still logged');
select results_eq(
  $$ select payload ->> 't' from realtime.messages where topic = 'bill:' || pg_temp.bid('m')::text $$,
  $$ values ('bill_payers'::text) $$,
  'M2: the lead did not change, so only the bill_payers hint is sent');
select is(
  (select count(*)::int from public.bill_payment_flags where bill_id = pg_temp.bid('m')), 1,
  'M7: Ann''s flag (to Mia, still a payer) is kept in M2');

select lives_ok(pg_temp.mp(array[pg_temp.u('0001a0'), pg_temp.u('0001b0')], array[5000, 5000]),
  'M5: the identical split again');
select is_empty($$ select * from pg_temp.fresh('m') $$, 'M5: a no-op without an event');

select lives_ok(pg_temp.mp(array[pg_temp.u('0001a0'), pg_temp.u('0001c0')], array[5000, 5000]),
  'M3: Mia + Max -> Mia + Moe');
select results_eq($$ select d -> 'moved' from pg_temp.fresh('m') as d $$,
  format($f$ values (%L::jsonb) $f$, jsonb_build_array(pg_temp.mv('0002f0', '0001b0', 900))),
  'M3: Pat->Max moved; Priya->Sam (M8) not moved');

select pg_temp.run(pg_temp.u('0001a0'), format('select public.set_payers(%L::uuid, %L::jsonb)',
  pg_temp.bid('m'), pg_temp.pj(array[pg_temp.u('0001a0'), pg_temp.u('0001b0')], array[5000, 5000])));
select results_eq($$ select d -> 'moved' from pg_temp.fresh('m') as d $$,
  $$ values ('[]'::jsonb) $$, 'M: Mia + Moe -> Mia + Max moves nothing (Moe received nothing)');

select is(pg_temp.lead('m'), pg_temp.u('0001a0'), 'M4 setup: the tie makes Mia the lead');
select lives_ok(
  pg_temp.as_sql(pg_temp.u('0001a0'), format('select public.set_payer(%L::uuid, %L::uuid)', pg_temp.bid('m'), pg_temp.u('0001a0'))),
  'M4: Mia + Max -> one person Mia (the lead)');
select results_eq($$ select d -> 'moved' from pg_temp.fresh('m') as d $$,
  format($f$ values (%L::jsonb) $f$, jsonb_build_array(pg_temp.mv('0002f0', '0001b0', 900))),
  'M4: Pat->Max moved');
select is(
  (select count(*)::int from public.bill_payers where bill_id = pg_temp.bid('m')), 0,
  'A-11: set_payer from split mode deletes the bill_payers rows even when the target is the lead');

select pg_temp.run(pg_temp.u('0001a0'),
  format('select public.set_payer(%L::uuid, %L::uuid)', pg_temp.bid('m'), pg_temp.u('0001b0')));
select results_eq($$ select d -> 'moved' from pg_temp.fresh('m') as d $$,
  format($f$ values (%L::jsonb) $f$, jsonb_build_array(pg_temp.mv('0002d0', '0001a0', 1200),
                                                       pg_temp.mv('0002e0', '0001a0', 1510))),
  'M1: one person Mia -> one person Max moves Dee->Mia and Sam->Mia (ordered by from)');
select is(
  (select count(*)::int from public.bill_payment_flags where bill_id = pg_temp.bid('m')), 0,
  'M7: Ann''s flag is deleted when Mia leaves the payer set');
select is(
  (select count(*)::int from public.bill_payments where bill_id = pg_temp.bid('m')), 4,
  'A-10: no bill_payments entry was deleted by any payer change');
update public.bills set total_cents = 10001 where id = pg_temp.bid('m');
select ok(private.payers_valid(pg_temp.bid('m')),
  'A-12: a one-person bill never gives payers_stale (total changed)');

-- ---------------------------------------------------------------------------
-- A-12 and rule E' (bill S: Steak 2000, Fries 1000; payers Sia 2000 + Sol 1000; Sid eats)
-- ---------------------------------------------------------------------------
select pg_temp.mk(pg_temp.u('0003a0'), 's',
  jsonb_build_array(pg_temp.item('Steak', 2000, 0), pg_temp.item('Fries', 1000, 1)), 0, 3000);
select pg_temp.join(u, 's') from unnest(array[pg_temp.u('0003b0'), pg_temp.u('0003d0')]) as u;
select pg_temp.claim(pg_temp.u('0003d0'), 's', 'Steak');
select pg_temp.sp(pg_temp.u('0003a0'), 's',
  pg_temp.pj(array[pg_temp.u('0003a0'), pg_temp.u('0003b0')], array[2000, 1000]));

select is(private.settle_state(pg_temp.bid('s'), pg_temp.u('0003d0')), 'not_complete',
  'E2: a split bill, proportional, incomplete, with an item claim is not_complete (no early)');
select throws_ok(
  pg_temp.as_sql(pg_temp.u('0003d0'), format('select * from public.mark_paid(%L::uuid, %L::uuid, 2000, ''venmo'')', pg_temp.bid('s'), pg_temp.u('0003a0'))),
  '22023', 'not_complete', 'E2: mark_paid on an incomplete split bill gives not_complete');
update public.bills set extras_split = 'equal' where id = pg_temp.bid('s');
select is(private.settle_state(pg_temp.bid('s'), pg_temp.u('0003d0')), 'not_complete',
  'E3: a split bill, even, incomplete is not_complete');
update public.bills set extras_split = 'proportional' where id = pg_temp.bid('s');
select pg_temp.claim(pg_temp.u('0003d0'), 's', 'Fries');
select is(private.settle_state(pg_temp.bid('s'), pg_temp.u('0003d0')), 'final',
  'E1: a complete split bill is final');

create function pg_temp.smark(p_payer uuid, p_cents integer) returns text language sql stable as $$
  select pg_temp.as_sql(pg_temp.u('0003d0'), format('select * from public.mark_paid(%L::uuid, %L::uuid, %s, ''venmo'')', pg_temp.bid('s'), p_payer, p_cents))
$$;
create function pg_temp.smore() returns text language sql stable as $$
  select pg_temp.as_sql(pg_temp.u('0003d0'), format('select public.settle_difference(%L::uuid, %L::uuid, %L::uuid, 2000, 2100, ''venmo'')', pg_temp.bid('s'), pg_temp.u('0003d0'),
    pg_temp.u('0003a0')))
$$;

select lives_ok(pg_temp.smark(pg_temp.u('0003a0'), 2000), 'A-12: Sid marks 2000 to Sia');

update public.bills set total_cents = 3001 where id = pg_temp.bid('s');
select throws_ok(pg_temp.smark(pg_temp.u('0003b0'), 1000), '22023', 'payers_stale',
  'A-12: total + 1: mark_paid gives payers_stale');
select throws_ok(pg_temp.smore(), '22023', 'payers_stale',
  'A-12: total + 1: settle_difference (more) gives payers_stale');
update public.bills set total_cents = 2999 where id = pg_temp.bid('s');
select throws_ok(pg_temp.smark(pg_temp.u('0003b0'), 1000), '22023', 'payers_stale',
  'A-12: total - 1: mark_paid gives payers_stale');
select throws_ok(pg_temp.smore(), '22023', 'payers_stale',
  'A-12: total - 1: settle_difference (more) gives payers_stale');
update public.bills set total_cents = 3300 where id = pg_temp.bid('s');
select throws_ok(pg_temp.smark(pg_temp.u('0003b0'), 1000), '22023', 'payers_stale',
  'A-12: total + 300: mark_paid gives payers_stale');
select throws_ok(pg_temp.smore(), '22023', 'payers_stale',
  'A-12: total + 300: settle_difference (more) gives payers_stale');
select lives_ok(
  format($f$ select pg_temp.sp(%L, 's', %L) $f$, pg_temp.u('0003a0'),
         pg_temp.pj(array[pg_temp.u('0003a0'), pg_temp.u('0003b0')], array[2300, 1000])),
  'A-12: re-saving the amounts to the new total works');
select lives_ok(pg_temp.smark(pg_temp.u('0003b0'), 1000),
  'A-12: after re-saving, Sid marks to Sol');

-- payers_stale is checked before all_zero (bill Z: a $0 item, 500 tax; both stale and all-$0).
select pg_temp.mk(pg_temp.u('0003a0'), 'z', jsonb_build_array(pg_temp.item('Free', 0)), 500, 500);
select pg_temp.join(u, 'z') from unnest(array[pg_temp.u('0003b0'), pg_temp.u('0003d0')]) as u;
select pg_temp.claim(pg_temp.u('0003d0'), 'z', 'Free');
select pg_temp.sp(pg_temp.u('0003a0'), 'z',
  pg_temp.pj(array[pg_temp.u('0003a0'), pg_temp.u('0003b0')], array[300, 200]));
update public.bills set total_cents = 501 where id = pg_temp.bid('z');
select throws_ok(
  pg_temp.as_sql(pg_temp.u('0003d0'), format('select * from public.mark_paid(%L::uuid, %L::uuid, 100, ''venmo'')', pg_temp.bid('z'), pg_temp.u('0003a0'))),
  '22023', 'payers_stale', 'A-12: payers_stale comes before all_zero');
update public.bills set total_cents = 500 where id = pg_temp.bid('z');
select is(private.settle_state(pg_temp.bid('z'), pg_temp.u('0003d0')), 'all_zero',
  'E4: an all-$0 split bill is all_zero');
select throws_ok(
  pg_temp.as_sql(pg_temp.u('0003d0'), format('select * from public.mark_paid(%L::uuid, %L::uuid, 100, ''venmo'')', pg_temp.bid('z'), pg_temp.u('0003a0'))),
  '22023', 'all_zero', 'E4: with valid amounts, mark_paid gives all_zero');

-- ---------------------------------------------------------------------------
-- A-17: table L (bill L: Lee host; Kit and Gus paid, then Lee, then Lee + Lou)
-- ---------------------------------------------------------------------------
select pg_temp.mk(pg_temp.u('0004a0'), 'l', jsonb_build_array(pg_temp.item('Pie', 1000)), 0, 1000);
select pg_temp.join(u, 'l') from unnest(array[pg_temp.u('0004b0'), pg_temp.u('0004c0'),
  pg_temp.u('0004d0'), pg_temp.u('0004e0'), pg_temp.u('0004f0'), pg_temp.u('000400')]) as u;
select pg_temp.sp(pg_temp.u('0004a0'), 'l',
  pg_temp.pj(array[pg_temp.u('0004c0'), pg_temp.u('0004d0')], array[600, 400]));
select pg_temp.e('l', pg_temp.u('0004e0'), pg_temp.u('0004d0'), 400);
select pg_temp.run(pg_temp.u('0004a0'),
  format('select public.set_payer(%L::uuid, %L::uuid)', pg_temp.bid('l'), pg_temp.u('0004a0')));
select pg_temp.sp(pg_temp.u('0004a0'), 'l',
  pg_temp.pj(array[pg_temp.u('0004a0'), pg_temp.u('0004b0')], array[500, 500]));
select pg_temp.e('l', pg_temp.u('000400'), pg_temp.u('0004a0'), 500);
select pg_temp.e('l', pg_temp.u('0004a0'), pg_temp.u('000400'), 500);
select pg_temp.f('l', pg_temp.u('0004f0'), pg_temp.u('0004a0'), 300);

create function pg_temp.rm(p_user text) returns text language sql stable as $$
  select pg_temp.as_sql(pg_temp.u('0004a0'), format('select public.remove_participant(%L::uuid, %L::uuid)', pg_temp.bid('l'), pg_temp.u(p_user)))
$$;
create function pg_temp.lv(p_user text) returns text language sql stable as $$
  select pg_temp.as_sql(pg_temp.u(p_user), format('select public.leave_bill(%L::uuid)', pg_temp.bid('l')))
$$;

select throws_ok(pg_temp.rm('0004b0'), '22023', 'cannot_remove', 'L1: a co-payer cannot be removed');
select throws_ok(pg_temp.rm('0004e0'), '22023', 'cannot_remove',
  'L2: a non-payer with an outgoing pair net > 0 cannot be removed');
select lives_ok(pg_temp.rm('0004f0'), 'L3: a non-payer with only a flag can be removed');
select lives_ok(pg_temp.lv('0004c0'),
  'L4: the old lead (after set_payer to someone else, no claims, every pair net 0) can leave');
select throws_ok(pg_temp.lv('0004a0'), '22023', 'cannot_leave', 'L5: the host cannot leave');
select lives_ok(pg_temp.rm('000400'), 'L6: a non-payer fully paid back can be removed');
select throws_ok(pg_temp.rm('0004d0'), '22023', 'cannot_remove',
  'L7: an ex-payer holding someone''s payment cannot be removed');

-- ---------------------------------------------------------------------------
-- A-18 (B3): a co-payer's account is deleted (bill T: Tia host, Tia 600 + Tom 400; Tess)
-- ---------------------------------------------------------------------------
select pg_temp.mk(pg_temp.u('0005a0'), 't', jsonb_build_array(pg_temp.item('Taco', 1000)), 0, 1000);
select pg_temp.join(u, 't') from unnest(array[pg_temp.u('0005b0'), pg_temp.u('0005c0')]) as u;
select pg_temp.sp(pg_temp.u('0005a0'), 't',
  pg_temp.pj(array[pg_temp.u('0005a0'), pg_temp.u('0005b0')], array[600, 400]));
select pg_temp.e('t', pg_temp.u('0005c0'), pg_temp.u('0005a0'), 300);
select pg_temp.e('t', pg_temp.u('0005c0'), pg_temp.u('0005b0'), 200);
select pg_temp.e('t', pg_temp.u('0005b0'), pg_temp.u('0005a0'), 100);

select lives_ok(
  format($f$ delete from public.bill_participants where bill_id = %L and user_id = %L $f$,
         pg_temp.bid('t'), pg_temp.u('0005b0')),
  'A-18: deleting the co-payer''s participant row succeeds');
select results_eq(
  $$ select b.payer_id, (select count(*)::int from public.bill_payers as bp where bp.bill_id = b.id)
     from public.bills as b where b.id = pg_temp.bid('t') $$,
  $$ values (pg_temp.u('0005a0'), 0) $$,
  'A-18: the bill becomes one person (the host)');
select results_eq(
  $$ select from_user, to_user, cents from public.bill_payments where bill_id = pg_temp.bid('t') $$,
  $$ values (pg_temp.u('0005c0'), pg_temp.u('0005a0'), 300) $$,
  'A-18: Tess->Tia is kept; Tess->Tom and Tom->Tia are gone');
select results_eq(
  $$ select actor_id, (details ->> 'lost')::int from public.bill_events
     where bill_id = pg_temp.bid('t') and kind = 'payers_changed' and details ? 'lost' $$,
  $$ values (null::uuid, 2) $$,
  'A-18: one payers_changed event with lost = 2 and no actor');
select lives_ok($$ set constraints all immediate $$, 'A-18: the deferred FKs pass');
-- Every deferrable constraint in public is initially deferred, so this restores the original state.
set constraints all deferred;

-- ---------------------------------------------------------------------------
-- A-18b (B4): the host's account is deleted (bill U, split, with an entry and a flag)
-- ---------------------------------------------------------------------------
select pg_temp.mk(pg_temp.u('0006a0'), 'u', jsonb_build_array(pg_temp.item('Udon', 1000)), 0, 1000);
select pg_temp.join(u, 'u') from unnest(array[pg_temp.u('0006b0'), pg_temp.u('0006c0')]) as u;
select pg_temp.sp(pg_temp.u('0006a0'), 'u',
  pg_temp.pj(array[pg_temp.u('0006a0'), pg_temp.u('0006b0')], array[600, 400]));
select pg_temp.e('u', pg_temp.u('0006c0'), pg_temp.u('0006b0'), 200);
select pg_temp.f('u', pg_temp.u('0006c0'), pg_temp.u('0006a0'), 100);
select lives_ok(
  format($f$ delete from auth.users where id = %L $f$, pg_temp.u('0006a0')),
  'A-18b: deleting the host of a split bill with entries succeeds');
select is(
  (select count(*)::int from public.bill_payers where bill_id = pg_temp.bid('u'))
  + (select count(*)::int from public.bill_payments where bill_id = pg_temp.bid('u'))
  + (select count(*)::int from public.bill_payment_flags where bill_id = pg_temp.bid('u')),
  0, 'A-18b: no bill_payers, bill_payments or flags rows remain for the bill');

-- ---------------------------------------------------------------------------
-- A-18c (B5): Groups
-- ---------------------------------------------------------------------------
select pg_temp.run(pg_temp.u('0007a0'),
  format('select public.create_group(%L::uuid, %L)', pg_temp.u('0007f0'), 'Who paid group'));
select pg_temp.run(u, format('select public.join_group(%L)',
  (select g.join_code from public.groups as g where g.id = pg_temp.u('0007f0'))))
from unnest(array[pg_temp.u('0007b0'), pg_temp.u('0007c0')]) as u;

select pg_temp.mk(pg_temp.u('0007a0'), 'v',
  jsonb_build_array(pg_temp.item('Ham', 600, 0), pg_temp.item('Egg', 400, 1)), 0, 1000);
select pg_temp.join(u, 'v') from unnest(array[pg_temp.u('0007b0'), pg_temp.u('0007c0')]) as u;
select pg_temp.claim(pg_temp.u('0007b0'), 'v', 'Ham');
select pg_temp.claim(pg_temp.u('0007c0'), 'v', 'Egg');
select pg_temp.run(pg_temp.u('0007b0'), format(
  'select * from public.mark_paid(%L::uuid, %L::uuid, 600, %L)', pg_temp.bid('v'), pg_temp.u('0007a0'), 'venmo'));
select pg_temp.run(pg_temp.u('0007c0'), format(
  'select * from public.mark_paid(%L::uuid, %L::uuid, 400, %L)', pg_temp.bid('v'), pg_temp.u('0007a0'), 'cash'));

select pg_temp.mk(pg_temp.u('0007a0'), 'v2', jsonb_build_array(pg_temp.item('Jam', 1000)), 0, 1000);
select pg_temp.join(pg_temp.u('0007b0'), 'v2');
select pg_temp.sp(pg_temp.u('0007a0'), 'v2',
  pg_temp.pj(array[pg_temp.u('0007a0'), pg_temp.u('0007b0')], array[500, 500]));

create function pg_temp.attach(p_key text) returns text language sql stable as $$
  select pg_temp.as_sql(pg_temp.u('0007a0'), format('select public.attach_bill_to_group(%L::uuid, %L::uuid)', pg_temp.bid(p_key), pg_temp.u('0007f0')))
$$;

select throws_ok(pg_temp.attach('v2'), '22023', 'split_paying',
  'A-18c: attaching a split bill gives 22023 split_paying');
select lives_ok(pg_temp.attach('v'), 'A-18c: attaching a one-payer bill with 2 entries works');
select results_eq(
  $$ select from_user, to_user, cents, method, source from public.group_payments
     where bill_id = pg_temp.bid('v') order by cents desc $$,
  $$ values (pg_temp.u('0007b0'), pg_temp.u('0007a0'), 600, 'venmo'::text, 'bill_mark'::text),
            (pg_temp.u('0007c0'), pg_temp.u('0007a0'), 400, 'cash'::text, 'bill_mark'::text) $$,
  'A-18c: the 2 entries become 2 group_payments rows (source bill_mark)');
select is(
  (select count(*)::int from public.bill_payments where bill_id = pg_temp.bid('v')), 0,
  'A-18c: no bill_payments rows remain on the attached bill');
select results_eq(
  $$ select (details ->> 'converted')::int from public.bill_events
     where bill_id = pg_temp.bid('v') and kind = 'moved_to_group' $$,
  $$ values (2) $$, 'A-18c: moved_to_group records converted = 2');
select throws_ok(
  format($f$ select pg_temp.sp(%L, 'v', %L) $f$, pg_temp.u('0007a0'),
         pg_temp.pj(array[pg_temp.u('0007a0'), pg_temp.u('0007b0')], array[500, 500])),
  '22023', 'in_group', 'A-18c: set_payers on a group bill gives in_group');
select throws_ok(
  format($f$ select pg_temp.sp(%L, 'v', 'null'::jsonb) $f$, pg_temp.u('0007a0')),
  '22023', 'in_group', 'order: in_group before invalid_payers');
select throws_ok(
  format($f$ select pg_temp.sp(%L, 'v', 'null'::jsonb) $f$, pg_temp.u('0007b0')),
  '42501', 'not_allowed', 'order: not_allowed before in_group');
select throws_ok(
  format($f$ insert into public.bill_payments (bill_id, from_user, to_user, cents, method, recorded_by)
             values (%L, %L, %L, 1, 'other', %L) $f$,
         pg_temp.bid('v'), pg_temp.u('0007b0'), pg_temp.u('0007a0'), pg_temp.u('0007b0')),
  '22023', 'in_group', 'A-18c: an entry insert on a group bill gives in_group');
select throws_ok(
  format($f$ insert into public.bill_payment_flags (bill_id, from_user, to_user, cents, method)
             values (%L, %L, %L, 1, 'other') $f$,
         pg_temp.bid('v'), pg_temp.u('0007b0'), pg_temp.u('0007a0')),
  '22023', 'in_group', 'A-18c: a flag insert on a group bill gives in_group');

-- ---------------------------------------------------------------------------
-- A-20: execute privileges, security definer, kind list
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select f, has_function_privilege('anon', f, 'execute'),
            has_function_privilege('authenticated', f, 'execute')
     from unnest(array['public.set_payers(uuid,jsonb)', 'public.set_payer(uuid,uuid)',
                       'public.attach_bill_to_group(uuid,uuid)']) as f $$,
  $$ values ('public.set_payers(uuid,jsonb)', false, true),
            ('public.set_payer(uuid,uuid)', false, true),
            ('public.attach_bill_to_group(uuid,uuid)', false, true) $$,
  'A-20: the new and re-created public functions are executable by authenticated only');
select is(
  (select count(*)::int
   from unnest(array['private.payers_json(uuid)', 'private.payments_moved(uuid,uuid[],uuid[])',
                     'private.settle_state(uuid,uuid)', 'private.bill_payer_ids(uuid)',
                     'private.payers_valid(uuid)', 'private.bill_participants_reset_payer()']) as f
   where has_function_privilege('authenticated', f, 'execute')
      or has_function_privilege('anon', f, 'execute')),
  0, 'A-20: no client role can execute the private helpers');
select is(
  (select count(*)::int from pg_proc as p join pg_namespace as n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('set_payers', 'set_payer', 'attach_bill_to_group')
     and not (p.prosecdef and array['search_path=""'] <@ coalesce(p.proconfig, '{}'))),
  0, 'A-20: the public functions are security definer with search_path = ''''');

select lives_ok(
  format($f$ insert into public.bill_events (bill_id, actor_id, kind)
             select %L, null, k from unnest(array[
               'bill_created', 'joined', 'claimed', 'unclaimed', 'split_changed', 'item_added',
               'item_removed', 'item_changed', 'amounts_changed', 'link_rotated',
               'extras_split_changed', 'payer_changed', 'marked_paid', 'unmarked_paid',
               'participant_added', 'participant_removed', 'left', 'paid_difference',
               'paid_back', 'not_received', 'moved_to_group', 'removed_from_group',
               'assigned', 'unassigned', 'payers_changed']) as k $f$, pg_temp.bid('w')),
  'A-20: every earlier kind (24) plus payers_changed is accepted');
select throws_ok(
  format($f$ insert into public.bill_events (bill_id, kind) values (%L, 'payers_change') $f$,
         pg_temp.bid('w')),
  '23514', null, 'A-20: an unknown kind is refused');

select * from finish();
rollback;
