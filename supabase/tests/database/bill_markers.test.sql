-- pgTAP tests for supabase/migrations/20261124144925_bill_seen.sql (spec
-- docs/specs/2026-11-24-bill-markers-and-notices.md, Task 1, criteria 1-15; criterion 16 is the
-- whole `npm run db:test` run).
--
-- Every assertion filters to the fixture users/bills below (the local DB may hold real data).
-- Fixture user ids all start with b5ee.
-- Users: A ..01 'Ana' (host), B ..02 'Ben' (guest), C ..03 'Cal' (on no bill), D ..04 'Dee'
-- (hosts 21 bills), N ..05 (host whose display_name is null).
-- Bills hosted by A: P (Tea 300, Fries 2 x 200, claimable discount Comp -100; total 600),
-- Q, R, L, X, Y (Tea 300 each). Bills hosted by N: T1, T2, T3 (Tea 300).
-- B joins P, Q, R, Y, T1-T3 with the link; A adds B to L and X.
-- Inside one transaction now() is constant, so joined_at / created_at are set explicitly (as
-- postgres) to give the ordering cases distinct times.

begin;

create extension if not exists pgtap with schema extensions;

select plan(53);

insert into auth.users (id, email, raw_user_meta_data) values
  ('b5ee0000-0000-0000-0000-000000000001', 'billseen-a@test.local', '{"full_name":"Ana"}'::jsonb),
  ('b5ee0000-0000-0000-0000-000000000002', 'billseen-b@test.local', '{"full_name":"Ben"}'::jsonb),
  ('b5ee0000-0000-0000-0000-000000000003', 'billseen-c@test.local', '{"full_name":"Cal"}'::jsonb),
  ('b5ee0000-0000-0000-0000-000000000004', 'billseen-d@test.local', '{"full_name":"Dee"}'::jsonb),
  ('b5ee0000-0000-0000-0000-000000000005', 'billseen-n@test.local', '{"full_name":"Nil"}'::jsonb);
update public.profiles set display_name = null where id = 'b5ee0000-0000-0000-0000-000000000005';

-- ---------------------------------------------------------------------------
-- Fixtures through the real functions
-- ---------------------------------------------------------------------------
create temp table d_bills (i integer primary key, id uuid not null);
grant all on d_bills to authenticated;

do $$
declare
  r record;
  v_tea constant jsonb := $json$[
    {"name":"Tea","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":300}
  ]$json$::jsonb;
  v_name text;
  i integer;
begin
  -- A's bills
  perform set_config('request.jwt.claims',
    '{"sub":"b5ee0000-0000-0000-0000-000000000001","role":"authenticated"}', true);
  select * into r from public.create_bill($json$[
    {"name":"Tea","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":300},
    {"name":"Fries","note":null,"group_position":1,"unit_index":0,"group_size":2,"total_cents":200},
    {"name":"Fries","note":null,"group_position":1,"unit_index":1,"group_size":2,"total_cents":200},
    {"name":"Comp","group_position":2,"unit_index":0,"group_size":1,"total_cents":-100,
     "kind":"discount","applies_to":"subtotal"}
  ]$json$::jsonb, 600, 0, 0, 0, 0, 0, 600);
  perform set_config('test.p', r.bill_id::text, true);
  perform set_config('test.p_code', r.join_code, true);
  foreach v_name in array array['q', 'r', 'l', 'x', 'y'] loop
    select * into r from public.create_bill(v_tea, 300, 0, 0, 0, 0, 0, 300);
    perform set_config('test.' || v_name, r.bill_id::text, true);
    perform set_config('test.' || v_name || '_code', r.join_code, true);
  end loop;

  -- N's bills
  perform set_config('request.jwt.claims',
    '{"sub":"b5ee0000-0000-0000-0000-000000000005","role":"authenticated"}', true);
  foreach v_name in array array['t1', 't2', 't3'] loop
    select * into r from public.create_bill(v_tea, 300, 0, 0, 0, 0, 0, 300);
    perform set_config('test.' || v_name, r.bill_id::text, true);
    perform set_config('test.' || v_name || '_code', r.join_code, true);
  end loop;

  -- D's 21 bills
  perform set_config('request.jwt.claims',
    '{"sub":"b5ee0000-0000-0000-0000-000000000004","role":"authenticated"}', true);
  for i in 1..21 loop
    select * into r from public.create_bill(v_tea, 300, 0, 0, 0, 0, 0, 300);
    insert into pg_temp.d_bills (i, id) values (i, r.bill_id);
  end loop;

  -- B joins with the link
  perform set_config('request.jwt.claims',
    '{"sub":"b5ee0000-0000-0000-0000-000000000002","role":"authenticated"}', true);
  foreach v_name in array array['p', 'q', 'r', 'y', 't1', 't2', 't3'] loop
    perform public.join_bill(current_setting('test.' || v_name || '_code'));
  end loop;

  -- A adds B (linked through P)
  perform set_config('request.jwt.claims',
    '{"sub":"b5ee0000-0000-0000-0000-000000000001","role":"authenticated"}', true);
  perform public.add_participant(current_setting('test.l')::uuid, 'b5ee0000-0000-0000-0000-000000000002');
  perform public.add_participant(current_setting('test.x')::uuid, 'b5ee0000-0000-0000-0000-000000000002');
end $$;

select set_config('test.tea', (select id::text from public.line_items
  where bill_id = current_setting('test.p')::uuid and name = 'Tea'), true);
select set_config('test.fries0', (select id::text from public.line_items
  where bill_id = current_setting('test.p')::uuid and name = 'Fries' and unit_index = 0), true);
select set_config('test.fries1', (select id::text from public.line_items
  where bill_id = current_setting('test.p')::uuid and name = 'Fries' and unit_index = 1), true);
select set_config('test.comp', (select id::text from public.line_items
  where bill_id = current_setting('test.p')::uuid and name = 'Comp'), true);
select set_config('test.q_tea', (select id::text from public.line_items
  where bill_id = current_setting('test.q')::uuid), true);

-- Distinct times (base 2026-01-01 00:00 UTC). B's joined_at, newest last:
--   L +30m, P +1h, Q +2h, R +3h, Y +4h, X +5h, T1 = T2 = T3 +6h.
-- created_at: X +0 before Y +30m; T1 +1h; T2 = T3 +2h (tie broken by bill_id asc).
update public.bill_participants as bp
set joined_at = timestamptz '2026-01-01 00:00+00' + v.off
from (values
  ('l', interval '30 minutes'), ('p', interval '1 hour'), ('q', interval '2 hours'),
  ('r', interval '3 hours'), ('y', interval '4 hours'), ('x', interval '5 hours'),
  ('t1', interval '6 hours'), ('t2', interval '6 hours'), ('t3', interval '6 hours')
) as v(k, off)
where bp.bill_id = current_setting('test.' || v.k)::uuid
  and bp.user_id = 'b5ee0000-0000-0000-0000-000000000002';
update public.bills as b
set created_at = timestamptz '2026-01-01 00:00+00' + v.off
from (values
  ('x', interval '0 minutes'), ('y', interval '30 minutes'),
  ('t1', interval '1 hour'), ('t2', interval '2 hours'), ('t3', interval '2 hours')
) as v(k, off)
where b.id = current_setting('test.' || v.k)::uuid;
update public.bill_participants as bp
set joined_at = timestamptz '2026-01-01 00:00+00' + d.i * interval '1 minute'
from pg_temp.d_bills as d
where bp.bill_id = d.id and bp.user_id = 'b5ee0000-0000-0000-0000-000000000004';

-- ---------------------------------------------------------------------------
-- Criterion 1: the table
-- ---------------------------------------------------------------------------
select has_table('public', 'bill_seen', 'c1: public.bill_seen exists');
select results_eq(
  $$ select column_name::text collate "C", data_type::text collate "C", is_nullable::text collate "C", coalesce(column_default::text, '') collate "C"
     from information_schema.columns
     where table_schema = 'public' and table_name = 'bill_seen' order by ordinal_position $$,
  $$ values ('bill_id' collate "C", 'uuid' collate "C", 'NO' collate "C", '' collate "C"),
            ('user_id', 'uuid', 'NO', ''),
            ('seen_at', 'timestamp with time zone', 'NO', 'now()') $$,
  'c1: columns bill_id uuid, user_id uuid, seen_at timestamptz not null default now()');
select col_is_pk('public', 'bill_seen', array['bill_id', 'user_id'], 'c1: primary key (bill_id, user_id)');
select ok(
  (select count(*) = 1 from pg_constraint as c
   where c.conrelid = 'public.bill_seen'::regclass and c.contype = 'f'
     and c.confrelid = 'public.bill_participants'::regclass
     and c.confdeltype = 'c'
     and (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality as k(n, ord)
          join pg_attribute as a on a.attrelid = c.conrelid and a.attnum = k.n) = array['bill_id', 'user_id']
     and (select array_agg(a.attname::text order by k.ord) from unnest(c.confkey) with ordinality as k(n, ord)
          join pg_attribute as a on a.attrelid = c.confrelid and a.attnum = k.n) = array['bill_id', 'user_id'])
  and (select count(*) = 1 from pg_constraint where conrelid = 'public.bill_seen'::regclass and contype = 'f'),
  'c1: the only foreign key is (bill_id, user_id) -> bill_participants (bill_id, user_id) on delete cascade');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.bill_seen'::regclass)
  and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'bill_seen'),
  'c1: RLS is enabled and there are no policies');

-- ---------------------------------------------------------------------------
-- Criterion 2: no client privileges
-- ---------------------------------------------------------------------------
select ok(
  not exists (
    select 1 from pg_class as c, aclexplode(c.relacl) as a
    where c.oid = 'public.bill_seen'::regclass
      and a.grantee in (0::oid, 'anon'::regrole::oid, 'authenticated'::regrole::oid))
  and not has_any_column_privilege('anon', 'public.bill_seen', 'select, insert, update, references')
  and not has_any_column_privilege('authenticated', 'public.bill_seen', 'select, insert, update, references')
  and not has_table_privilege('public', 'public.bill_seen', 'select, insert, update, delete, truncate, references, trigger'),
  'c2: anon, authenticated and public hold no table or column privilege on bill_seen');

-- B gets an own row on Q first, so the denied statements target it.
set local role authenticated;
set local request.jwt.claims = '{"sub":"b5ee0000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.mark_bill_seen(current_setting('test.q')::uuid);
select throws_ok(
  format($$ select bill_id from public.bill_seen where bill_id = %L $$, current_setting('test.q')),
  '42501', null, 'c2: select on bill_seen fails with 42501, even for the caller''s own row');
select throws_ok(
  format($$ insert into public.bill_seen (bill_id, user_id) values (%L, 'b5ee0000-0000-0000-0000-000000000002') $$,
         current_setting('test.r')),
  '42501', null, 'c2: insert into bill_seen fails with 42501');
select throws_ok(
  format($$ update public.bill_seen set seen_at = now() where bill_id = %L
            and user_id = 'b5ee0000-0000-0000-0000-000000000002' $$, current_setting('test.q')),
  '42501', null, 'c2: update of the caller''s own bill_seen row fails with 42501');
select throws_ok(
  format($$ delete from public.bill_seen where bill_id = %L
            and user_id = 'b5ee0000-0000-0000-0000-000000000002' $$, current_setting('test.q')),
  '42501', null, 'c2: delete of the caller''s own bill_seen row fails with 42501');
reset role;

-- ---------------------------------------------------------------------------
-- Criterion 3: EXECUTE
-- ---------------------------------------------------------------------------
select ok(
  has_function_privilege('authenticated', 'public.mark_bill_seen(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.my_bills()', 'execute')
  and not has_function_privilege('anon', 'public.mark_bill_seen(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.my_bills()', 'execute')
  and not exists (
    select 1 from pg_proc as p, aclexplode(p.proacl) as a
    where p.oid in ('public.mark_bill_seen(uuid)'::regprocedure, 'public.my_bills()'::regprocedure)
      and a.grantee in (0::oid, 'anon'::regrole::oid)),
  'c3: only authenticated may execute mark_bill_seen and my_bills (not public, not anon)');
set local role anon;
select throws_ok(
  format($$ select public.mark_bill_seen(%L) $$, current_setting('test.p')),
  '42501', null, 'c3: anon calling mark_bill_seen fails with 42501');
select throws_ok($$ select * from public.my_bills() $$,
  '42501', null, 'c3: anon calling my_bills fails with 42501');
reset role;

-- ---------------------------------------------------------------------------
-- Criteria 8 and 15: membership and order
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"b5ee0000-0000-0000-0000-000000000002","role":"authenticated"}';
select results_eq(
  $$ select bill_id from public.my_bills() $$,
  $$ select v.id from (values
       (1, least(current_setting('test.t2')::uuid, current_setting('test.t3')::uuid)),
       (2, greatest(current_setting('test.t2')::uuid, current_setting('test.t3')::uuid)),
       (3, current_setting('test.t1')::uuid), (4, current_setting('test.x')::uuid),
       (5, current_setting('test.y')::uuid), (6, current_setting('test.r')::uuid),
       (7, current_setting('test.q')::uuid), (8, current_setting('test.p')::uuid),
       (9, current_setting('test.l')::uuid)) as v(n, id) order by v.n $$,
  'c8: my_bills as B returns exactly B''s 9 bills, joined_at desc, created_at desc, bill_id asc');
select ok(
  (select array_position(array_agg(m.bill_id), current_setting('test.x')::uuid)
          < array_position(array_agg(m.bill_id), current_setting('test.y')::uuid)
   from public.my_bills() as m),
  'c15: X (created first, B added later) comes before Y (created later, B joined earlier)');
select ok(
  (select array_position(a, least(current_setting('test.t2')::uuid, current_setting('test.t3')::uuid))
          < array_position(a, greatest(current_setting('test.t2')::uuid, current_setting('test.t3')::uuid))
      and array_position(a, greatest(current_setting('test.t2')::uuid, current_setting('test.t3')::uuid))
          < array_position(a, current_setting('test.t1')::uuid)
   from (select array_agg(m.bill_id) as a from public.my_bills() as m) as s),
  'c15: equal joined_at -> created_at desc (T2/T3 before T1); equal created_at too -> bill_id asc');

set local request.jwt.claims = '{"sub":"b5ee0000-0000-0000-0000-000000000003","role":"authenticated"}';
select is(
  (select count(*)::int from public.my_bills() as m
   where m.bill_id in (current_setting('test.p')::uuid, current_setting('test.q')::uuid,
     current_setting('test.r')::uuid, current_setting('test.l')::uuid, current_setting('test.x')::uuid,
     current_setting('test.y')::uuid, current_setting('test.t1')::uuid, current_setting('test.t2')::uuid,
     current_setting('test.t3')::uuid)
      or m.bill_id in (select id from pg_temp.d_bills)),
  0, 'c8: my_bills as an outsider returns none of the fixture bills');

set local request.jwt.claims = '{"role":"authenticated"}';
select throws_ok($$ select * from public.my_bills() $$,
  '42501', 'not_allowed', 'c8: my_bills signed out fails with 42501 not_allowed');

set local request.jwt.claims = '{"sub":"b5ee0000-0000-0000-0000-000000000004","role":"authenticated"}';
select is((select count(*)::int from public.my_bills()), 20,
  'c15: with 21 bills, my_bills returns exactly 20');
select results_eq(
  $$ select bill_id from public.my_bills() $$,
  $$ select id from pg_temp.d_bills where i between 2 and 21 order by i desc $$,
  'c15: the earliest-joined bill is the one dropped; the rest come newest first');
reset role;

-- ---------------------------------------------------------------------------
-- Criterion 9: every column equals its source
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"b5ee0000-0000-0000-0000-000000000002","role":"authenticated"}';
select results_eq(
  format($$ select bill_id, host_id, host_name, payer_id, total_cents, created_at, joined_at, added
            from public.my_bills() where bill_id = %L $$, current_setting('test.p')),
  format($$ select b.id, b.host_id, 'Ana'::text, b.payer_id, b.total_cents, b.created_at, bp.joined_at, bp.added
            from public.bills as b join public.bill_participants as bp
              on bp.bill_id = b.id and bp.user_id = 'b5ee0000-0000-0000-0000-000000000002'
            where b.id = %L $$, current_setting('test.p')),
  'c9: P as B: host_name is the host''s display_name; payer_id, total_cents, created_at, joined_at, added match');
select results_eq(
  format($$ select bill_id, host_id, host_name, payer_id, total_cents, created_at, joined_at, added
            from public.my_bills() where bill_id = %L $$, current_setting('test.x')),
  format($$ select b.id, b.host_id, 'Ana'::text, b.payer_id, 300, b.created_at,
                   timestamptz '2026-01-01 05:00+00', true
            from public.bills as b where b.id = %L $$, current_setting('test.x')),
  'c9: X as B (added by A): total 300, B''s own joined_at, added = true');
select results_eq(
  format($$ select host_id, host_name from public.my_bills() where bill_id = %L $$, current_setting('test.t1')),
  $$ values ('b5ee0000-0000-0000-0000-000000000005'::uuid, null::text) $$,
  'c9: host_name is null when the host''s display_name is null');
reset role;

-- ---------------------------------------------------------------------------
-- Criterion 11: seen is per person
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"b5ee0000-0000-0000-0000-000000000002","role":"authenticated"}';
select is((select seen from public.my_bills() where bill_id = current_setting('test.p')::uuid), false,
  'c11: seen is false for B before any call');

set local request.jwt.claims = '{"sub":"b5ee0000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.mark_bill_seen(current_setting('test.p')::uuid);
select set_config('test.a_seen_p',
  (select seen::text from public.my_bills() where bill_id = current_setting('test.p')::uuid), true);
set local request.jwt.claims = '{"sub":"b5ee0000-0000-0000-0000-000000000002","role":"authenticated"}';
select ok(
  current_setting('test.a_seen_p') = 'true'
  and (select not seen from public.my_bills() where bill_id = current_setting('test.p')::uuid),
  'c11: A''s call makes A''s seen true and leaves B''s false');

select public.mark_bill_seen(current_setting('test.p')::uuid);
select is((select seen from public.my_bills() where bill_id = current_setting('test.p')::uuid), true,
  'c11: seen is true after B''s own call');

select public.mark_bill_seen(current_setting('test.r')::uuid);
set local request.jwt.claims = '{"sub":"b5ee0000-0000-0000-0000-000000000001","role":"authenticated"}';
select is((select seen from public.my_bills() where bill_id = current_setting('test.r')::uuid), false,
  'c11: B''s call on R leaves A''s seen on R false');
reset role;

-- ---------------------------------------------------------------------------
-- Criterion 4: one row per (bill, caller), repeat calls keep one row
-- ---------------------------------------------------------------------------
-- B already called mark_bill_seen(Q) once (criterion 2 setup).
select results_eq(
  format($$ select count(*)::int from public.bill_seen
            where bill_id = %L and user_id = 'b5ee0000-0000-0000-0000-000000000002' $$, current_setting('test.q')),
  $$ values (1) $$, 'c4: a guest''s first call creates exactly one row');
select set_config('test.q_seen1', (select seen_at::text from public.bill_seen
  where bill_id = current_setting('test.q')::uuid and user_id = 'b5ee0000-0000-0000-0000-000000000002'), true);

set local role authenticated;
set local request.jwt.claims = '{"sub":"b5ee0000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.mark_bill_seen(current_setting('test.q')::uuid);
set local request.jwt.claims = '{"sub":"b5ee0000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.mark_bill_seen(current_setting('test.q')::uuid);
select public.mark_bill_seen(current_setting('test.q')::uuid);
reset role;

select ok(
  (select count(*) = 1 and min(seen_at) >= current_setting('test.q_seen1')::timestamptz
   from public.bill_seen
   where bill_id = current_setting('test.q')::uuid and user_id = 'b5ee0000-0000-0000-0000-000000000002'),
  'c4: a second call by the guest leaves one row with seen_at >= the first value');
select is(
  (select count(*)::int from public.bill_seen
   where bill_id = current_setting('test.q')::uuid and user_id = 'b5ee0000-0000-0000-0000-000000000001'),
  1, 'c4: the host''s two calls leave exactly one row for the host');

-- ---------------------------------------------------------------------------
-- Criterion 5: refusals
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated"}';
select throws_ok(format($$ select public.mark_bill_seen(%L) $$, current_setting('test.p')),
  '42501', 'not_allowed', 'c5: signed out -> 42501 not_allowed');
set local request.jwt.claims = '{"sub":"b5ee0000-0000-0000-0000-000000000003","role":"authenticated"}';
select throws_ok(format($$ select public.mark_bill_seen(%L) $$, current_setting('test.p')),
  '42501', 'not_allowed', 'c5: a bill the caller isn''t on -> 42501 not_allowed');
select throws_ok($$ select public.mark_bill_seen('b5ee0000-dead-0000-0000-000000000000') $$,
  '42501', 'not_allowed', 'c5: a random UUID -> 42501 not_allowed (same message)');
reset role;
select is(
  (select count(*)::int from public.bill_seen
   where user_id = 'b5ee0000-0000-0000-0000-000000000003'
      or bill_id = 'b5ee0000-dead-0000-0000-000000000000'),
  0, 'c5: no row was written by the refused calls');

-- ---------------------------------------------------------------------------
-- Criterion 6: no side channel
-- ---------------------------------------------------------------------------
-- On L (B added, not seen yet).
select set_config('test.l_events', (select count(*)::text from public.bill_events
  where bill_id = current_setting('test.l')::uuid), true);
create temp table bp_before as
  select * from public.bill_participants
  where bill_id = current_setting('test.l')::uuid and user_id = 'b5ee0000-0000-0000-0000-000000000002';

set local role authenticated;
set local request.jwt.claims = '{"sub":"b5ee0000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.mark_bill_seen(current_setting('test.l')::uuid);
reset role;

select is(
  (select count(*)::text from public.bill_events where bill_id = current_setting('test.l')::uuid),
  current_setting('test.l_events'), 'c6: mark_bill_seen logs no bill_events row');
select results_eq(
  $$ select * from pg_temp.bp_before $$,
  format($$ select * from public.bill_participants
            where bill_id = %L and user_id = 'b5ee0000-0000-0000-0000-000000000002' $$, current_setting('test.l')),
  'c6: the caller''s bill_participants row is unchanged (all columns)');
select ok(
  not exists (select 1 from pg_trigger where tgrelid = 'public.bill_seen'::regclass and not tgisinternal),
  'c1/c6: bill_seen has no (non-internal) triggers');

-- ---------------------------------------------------------------------------
-- Criterion 7: lock order (static) and function settings
-- ---------------------------------------------------------------------------
select ok(
  (select position('from public.bill_participants' in p.prosrc) > 0
          and position('from public.bill_participants' in p.prosrc) < position('private.lock_bill_key_share' in p.prosrc)
          and position('private.lock_bill_key_share' in p.prosrc) < position('insert into public.bill_seen' in p.prosrc)
          and position('for update' in p.prosrc) = 0
   from pg_proc as p where p.oid = 'public.mark_bill_seen(uuid)'::regprocedure),
  'c7: mark_bill_seen checks participation (no lock), then locks the bill, then upserts');
select ok(
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']) and count(*) = 2
   from pg_proc as p
   where p.oid in ('public.mark_bill_seen(uuid)'::regprocedure, 'public.my_bills()'::regprocedure)),
  'c7: both functions are security definer with an empty search_path');

-- ---------------------------------------------------------------------------
-- Criterion 10: privacy of my_bills
-- ---------------------------------------------------------------------------
-- A claims Tea on Q, so A's and B's claimed_any differ there; A hasn't seen R, B has.
set local role authenticated;
set local request.jwt.claims = '{"sub":"b5ee0000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.set_claim(current_setting('test.q_tea')::uuid, true);
reset role;

create temp table hn_check (u uuid, bad integer, checked integer);
grant all on hn_check to authenticated;
do $$
declare u uuid;
begin
  foreach u in array array[
    'b5ee0000-0000-0000-0000-000000000001', 'b5ee0000-0000-0000-0000-000000000002',
    'b5ee0000-0000-0000-0000-000000000003', 'b5ee0000-0000-0000-0000-000000000004',
    'b5ee0000-0000-0000-0000-000000000005']::uuid[]
  loop
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    insert into pg_temp.hn_check (u, bad, checked)
    select u,
           count(*) filter (where not exists (
             select 1 from public.profiles as pr
             where pr.id = m.host_id and pr.display_name = m.host_name)),
           count(*)
    from public.my_bills() as m
    where m.host_name is not null;
    execute 'reset role';
  end loop;
end $$;
select ok(
  (select sum(bad) = 0 and sum(checked) > 0 and count(*) = 5 from pg_temp.hn_check),
  'c10: every non-null host_name belongs to a profile the caller can select (5 fixture users)');

create temp table mb_b as select * from public.my_bills() limit 0;
grant all on mb_b to authenticated;
set local role authenticated;
set local request.jwt.claims = '{"sub":"b5ee0000-0000-0000-0000-000000000002","role":"authenticated"}';
insert into pg_temp.mb_b select * from public.my_bills();
reset role;
select ok(
  (select count(*) = 9
      and count(*) filter (where
        m.added is distinct from (select bp.added from public.bill_participants as bp
          where bp.bill_id = m.bill_id and bp.user_id = 'b5ee0000-0000-0000-0000-000000000002')
        or m.seen is distinct from exists (select 1 from public.bill_seen as s
          where s.bill_id = m.bill_id and s.user_id = 'b5ee0000-0000-0000-0000-000000000002')
        or m.claimed_any is distinct from exists (select 1 from public.claims as c
          where c.bill_id = m.bill_id and c.user_id = 'b5ee0000-0000-0000-0000-000000000002')) = 0
   from pg_temp.mb_b as m),
  'c10: B''s rows carry only B''s own added / seen / claimed_any (A''s differ on Q, R, L, X)');

-- ---------------------------------------------------------------------------
-- Criterion 12: claimed_any (on P, as B)
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"b5ee0000-0000-0000-0000-000000000002","role":"authenticated"}';
select is((select claimed_any from public.my_bills() where bill_id = current_setting('test.p')::uuid), false,
  'c12: claimed_any is false with no claims');
select public.set_claim(current_setting('test.fries1')::uuid, true);
select is((select claimed_any from public.my_bills() where bill_id = current_setting('test.p')::uuid), true,
  'c12: true with a claim on unit 2 of a two-unit item');
select public.set_claim(current_setting('test.fries1')::uuid, false);
select public.set_claim(current_setting('test.comp')::uuid, true);
select is((select claimed_any from public.my_bills() where bill_id = current_setting('test.p')::uuid), true,
  'c12: true with a claim only on a claimable discount row');
select public.set_claim(current_setting('test.comp')::uuid, false);
select is((select claimed_any from public.my_bills() where bill_id = current_setting('test.p')::uuid), false,
  'c12: false again after that claim is removed');

-- ---------------------------------------------------------------------------
-- Criterion 13: complete = private.bill_is_complete (on P, as B)
-- ---------------------------------------------------------------------------
select public.set_claim(current_setting('test.tea')::uuid, true);
select public.set_claim(current_setting('test.fries0')::uuid, true);
select public.set_claim(current_setting('test.fries1')::uuid, true);
select public.set_claim(current_setting('test.comp')::uuid, true);
select set_config('test.c_all',
  (select complete::text from public.my_bills() where bill_id = current_setting('test.p')::uuid), true);
select public.set_claim(current_setting('test.fries1')::uuid, false);
select set_config('test.c_unit',
  (select complete::text from public.my_bills() where bill_id = current_setting('test.p')::uuid), true);
reset role;
select set_config('test.k_unit', private.bill_is_complete(current_setting('test.p')::uuid)::text, true);
set local role authenticated;
select public.set_claim(current_setting('test.fries1')::uuid, true);
select public.set_claim(current_setting('test.comp')::uuid, false);
select set_config('test.c_disc',
  (select complete::text from public.my_bills() where bill_id = current_setting('test.p')::uuid), true);
reset role;

-- bill_is_complete for the "discount unclaimed" state (as postgres; clients can't execute it).
select set_config('test.k_disc', private.bill_is_complete(current_setting('test.p')::uuid)::text, true);
select ok(
  current_setting('test.c_all') = 'true'
  and current_setting('test.c_unit') = 'false' and current_setting('test.k_unit') = 'false',
  'c13: every row claimed -> complete true; one unit of a two-unit item unclaimed -> false (= bill_is_complete)');
select ok(
  current_setting('test.c_disc') = 'false' and current_setting('test.k_disc') = 'false',
  'c13: every item claimed but the claimable discount unclaimed -> false (= bill_is_complete)');
set local role authenticated;
select public.set_claim(current_setting('test.comp')::uuid, true);
select set_config('test.c_all2',
  (select complete::text from public.my_bills() where bill_id = current_setting('test.p')::uuid), true);
reset role;
select ok(
  current_setting('test.c_all2') = 'true'
  and private.bill_is_complete(current_setting('test.p')::uuid) = true,
  'c13: every row claimed -> complete true, equal to bill_is_complete');

-- ---------------------------------------------------------------------------
-- Criterion 14: leave, re-add, join with the link (on L; B added and seen in c6)
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"b5ee0000-0000-0000-0000-000000000002","role":"authenticated"}';
select ok(
  (select added and seen from public.my_bills() where bill_id = current_setting('test.l')::uuid),
  'c14: before leaving, L is listed for B with added = true and seen = true');
select public.leave_bill(current_setting('test.l')::uuid);
reset role;
select is(
  (select count(*)::int from public.bill_seen
   where bill_id = current_setting('test.l')::uuid and user_id = 'b5ee0000-0000-0000-0000-000000000002'),
  0, 'c14: leaving removes B''s bill_seen row (cascade)');
set local role authenticated;
select is(
  (select count(*)::int from public.my_bills() where bill_id = current_setting('test.l')::uuid),
  0, 'c14: my_bills as B no longer lists L');

set local request.jwt.claims = '{"sub":"b5ee0000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.add_participant(current_setting('test.l')::uuid, 'b5ee0000-0000-0000-0000-000000000002');
set local request.jwt.claims = '{"sub":"b5ee0000-0000-0000-0000-000000000002","role":"authenticated"}';
select results_eq(
  format($$ select added, seen from public.my_bills() where bill_id = %L $$, current_setting('test.l')),
  $$ values (true, false) $$,
  'c14: added again -> L is listed with added = true, seen = false');
select public.join_bill(current_setting('test.l_code'));
select is((select added from public.my_bills() where bill_id = current_setting('test.l')::uuid), false,
  'c14: opening the link afterwards -> added = false');
reset role;

select * from finish();
rollback;
