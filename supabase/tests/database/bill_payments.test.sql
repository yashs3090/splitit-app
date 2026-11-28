-- pgTAP tests for Who paid Task 4a (spec docs/specs/2026-11-26-who-paid.md, amendment A1;
-- migrations 20261127140000_bill_payments.sql and 20261127140001_bill_payments_functions.sql):
-- the payments ledger (public.bill_payments, public.bill_payment_flags), contract P
-- (private.pair_state), mark_paid's (settled_at, created) result and plan key, unmark_paid (3 args),
-- mark_not_received on the ledger, settle_difference by an ex-payer, grants, RLS, indexes,
-- immutability and the deduped ledger broadcast.
-- Criteria: A-1 (columns gone), A-5 (created / repeat), A-13 (plan key, payer_changed, is_payer),
-- A-14 (table P), A-15, A-16, A-19 (ledger tables), A-20 (execute grants).
--
-- Every assertion filters to the fixture bills/users below (the local DB may hold real data).
--
-- Users (f1...): H 'Hana' (host of X and Q), S 'Sam', D 'Dee' (participants of X and Q),
--                O 'Oz' (outsider).
-- Bill X: Burger 1500 (S), Salad 1000 (D); total 2500; complete. Bill Q: Tea 300; unclaimed
-- (pair_state and mark_not_received fixtures, entries inserted as the owner).

begin;

create extension if not exists pgtap with schema extensions;

select plan(76);

insert into auth.users (id, email, raw_user_meta_data) values
  ('f1000000-0000-4000-8000-000000000001', 'bpay-h@test.local', '{"full_name":"Hana"}'::jsonb),
  ('f1000000-0000-4000-8000-000000000002', 'bpay-s@test.local', '{"full_name":"Sam"}'::jsonb),
  ('f1000000-0000-4000-8000-000000000003', 'bpay-d@test.local', '{"full_name":"Dee"}'::jsonb),
  ('f1000000-0000-4000-8000-000000000004', 'bpay-o@test.local', '{"full_name":"Oz"}'::jsonb);

create function pg_temp.h() returns uuid language sql as $$ select 'f1000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.s() returns uuid language sql as $$ select 'f1000000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.d() returns uuid language sql as $$ select 'f1000000-0000-4000-8000-000000000003'::uuid $$;
create function pg_temp.o() returns uuid language sql as $$ select 'f1000000-0000-4000-8000-000000000004'::uuid $$;
create function pg_temp.x() returns uuid language sql as $$ select current_setting('test.x_id')::uuid $$;
create function pg_temp.q() returns uuid language sql as $$ select current_setting('test.q_id')::uuid $$;

-- Sets the caller for the next client-role statements (the role itself is set at top level).
create function pg_temp.act(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

-- An owner-inserted ledger entry on bill Q with a set recorded_at (and optionally a set id).
create function pg_temp.e(p_from uuid, p_to uuid, p_cents integer, p_method text, p_at text,
                          p_id uuid default gen_random_uuid())
returns void language sql as $$
  insert into public.bill_payments (id, bill_id, from_user, to_user, cents, method, recorded_by,
                                    recorded_at)
  values (p_id, pg_temp.q(), p_from, p_to, p_cents, p_method, p_from, p_at::timestamptz);
$$;

-- ---------------------------------------------------------------------------
-- Fixtures through the real functions
-- ---------------------------------------------------------------------------
select pg_temp.act(pg_temp.h());
set local role authenticated;
do $$
declare r record;
begin
  select * into r from public.create_bill($json$[
    {"name":"Burger","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":1500},
    {"name":"Salad","note":null,"group_position":1,"unit_index":0,"group_size":1,"total_cents":1000}
  ]$json$::jsonb, null, 0, 0, 0, 0, 0, 2500);
  perform set_config('test.x_id', r.bill_id::text, true);
  perform set_config('test.x_code', r.join_code, true);
  select * into r from public.create_bill(
    '[{"name":"Tea","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":300}]'::jsonb,
    null, 0, 0, 0, 0, 0, 300);
  perform set_config('test.q_id', r.bill_id::text, true);
  perform set_config('test.q_code', r.join_code, true);
end $$;
reset role;

select pg_temp.act(pg_temp.s());
set local role authenticated;
select public.join_bill(current_setting('test.x_code'));
select public.join_bill(current_setting('test.q_code'));
select public.set_claim(
  (select li.id from public.line_items as li where li.bill_id = pg_temp.x() and li.name = 'Burger'),
  true);
reset role;

select pg_temp.act(pg_temp.d());
set local role authenticated;
select public.join_bill(current_setting('test.x_code'));
select public.join_bill(current_setting('test.q_code'));
select public.set_claim(
  (select li.id from public.line_items as li where li.bill_id = pg_temp.x() and li.name = 'Salad'),
  true);
reset role;

-- ---------------------------------------------------------------------------
-- A-1 / A-19: tables, old columns gone, grants, RLS, indexes, immutability trigger
-- ---------------------------------------------------------------------------
select has_table('public', 'bill_payments', 'A-19: public.bill_payments exists');
select has_table('public', 'bill_payment_flags', 'A-19: public.bill_payment_flags exists');
select is(
  (select count(*)::int from information_schema.columns
   where table_schema = 'public' and table_name = 'bill_participants'
     and (column_name like 'settled\_%' or column_name like 'not\_received\_%')),
  0, 'A-1: bill_participants has no settled_* or not_received_* columns');

select table_privs_are('public', 'bill_payments', 'authenticated', array['SELECT'],
  'A-19: authenticated may only SELECT bill_payments');
select table_privs_are('public', 'bill_payments', 'anon', array[]::text[],
  'A-19: anon has no privilege on bill_payments');
select table_privs_are('public', 'bill_payments', 'service_role', array[]::text[],
  'A-19: service_role has no privilege on bill_payments (entries cannot be forged)');
select table_privs_are('public', 'bill_payment_flags', 'authenticated', array['SELECT'],
  'A-19: authenticated may only SELECT bill_payment_flags');
select table_privs_are('public', 'bill_payment_flags', 'anon', array[]::text[],
  'A-19: anon has no privilege on bill_payment_flags');
select table_privs_are('public', 'bill_payment_flags', 'service_role', array[]::text[],
  'A-19: service_role has no privilege on bill_payment_flags');

select is(
  (select count(*)::int from pg_class as c
   join pg_namespace as n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in ('bill_payments', 'bill_payment_flags')
     and c.relrowsecurity),
  2, 'A-19: RLS is enabled on both ledger tables');

select has_index('public', 'bill_payments', 'bill_payments_pair_idx',
  'S7: bill_payments has the pair index');
select has_index('public', 'bill_payments', 'bill_payments_bill_to_idx',
  'S7: bill_payments has the (bill, to_user) index');
select has_index('public', 'bill_payment_flags', 'bill_payment_flags_bill_to_idx',
  'S7: bill_payment_flags has the (bill, to_user) index');
select has_trigger('public', 'bill_payments', 'bill_payments_no_update',
  'A1.2: bill_payments has the no-update trigger');

-- ---------------------------------------------------------------------------
-- A-14: table P (pair u = S, v = D on bill Q; entries inserted as the owner)
-- ---------------------------------------------------------------------------
select pg_temp.e(pg_temp.s(), pg_temp.d(), 1510, 'venmo', '2026-03-01 10:00+00');
select results_eq(
  $$ select net, mark_at, method from private.pair_state(pg_temp.q(), pg_temp.s(), pg_temp.d()) $$,
  $$ values (1510::bigint, '2026-03-01 10:00+00'::timestamptz, 'venmo'::text) $$,
  'P1: one entry gives net 1510, markAt t1, venmo');

select pg_temp.e(pg_temp.s(), pg_temp.d(), 110, 'venmo', '2026-03-01 11:00+00');
select results_eq(
  $$ select net, mark_at, method from private.pair_state(pg_temp.q(), pg_temp.s(), pg_temp.d()) $$,
  $$ values (1620::bigint, '2026-03-01 10:00+00'::timestamptz, 'venmo'::text) $$,
  'P2: a second entry adds to the run; markAt stays t1');

delete from public.bill_payments where bill_id = pg_temp.q();
select pg_temp.e(pg_temp.s(), pg_temp.d(), 1510, 'venmo', '2026-03-01 10:00+00');
select pg_temp.e(pg_temp.d(), pg_temp.s(), 1510, 'other', '2026-03-01 11:00+00');
select pg_temp.e(pg_temp.s(), pg_temp.d(), 1400, 'cash', '2026-03-01 12:00+00');
select results_eq(
  $$ select net, mark_at, method from private.pair_state(pg_temp.q(), pg_temp.s(), pg_temp.d()) $$,
  $$ values (1400::bigint, '2026-03-01 12:00+00'::timestamptz, 'cash'::text) $$,
  'P3: paid back to 0 then paid again starts a new run at t3 (cash)');

delete from public.bill_payments where bill_id = pg_temp.q();
select pg_temp.e(pg_temp.s(), pg_temp.d(), 1000, 'cash', '2026-03-01 10:00+00');
select pg_temp.e(pg_temp.s(), pg_temp.d(), 500, 'venmo', '2026-03-01 11:00+00');
select results_eq(
  $$ select net, mark_at, method from private.pair_state(pg_temp.q(), pg_temp.s(), pg_temp.d()) $$,
  $$ values (1500::bigint, '2026-03-01 10:00+00'::timestamptz, 'other'::text) $$,
  'P4: two methods in one run read as other');

delete from public.bill_payments where bill_id = pg_temp.q();
select pg_temp.e(pg_temp.s(), pg_temp.d(), 500, 'cash', '2026-03-01 10:00+00',
                 'f1000000-0000-4000-8000-0000000000bb');
select pg_temp.e(pg_temp.s(), pg_temp.d(), 300, 'venmo', '2026-03-01 10:00+00',
                 'f1000000-0000-4000-8000-0000000000aa');
select results_eq(
  $$ select net, mark_id, method from private.pair_state(pg_temp.q(), pg_temp.s(), pg_temp.d()) $$,
  $$ values (800::bigint, 'f1000000-0000-4000-8000-0000000000aa'::uuid, 'other'::text) $$,
  'P5: entries with equal recorded_at are ordered by id (the mark starts at the lower id)');

delete from public.bill_payments where bill_id = pg_temp.q();
select pg_temp.e(pg_temp.s(), pg_temp.d(), 500, 'venmo', '2026-03-01 10:00+00');
select pg_temp.e(pg_temp.d(), pg_temp.s(), 800, 'cash', '2026-03-01 11:00+00');
select results_eq(
  $$ select net, mark_at, method from private.pair_state(pg_temp.q(), pg_temp.s(), pg_temp.d()) $$,
  $$ values (-300::bigint, null::timestamptz, null::text) $$,
  'P6: u->v nets -300 and has no mark');
select results_eq(
  $$ select net, mark_at, method from private.pair_state(pg_temp.q(), pg_temp.d(), pg_temp.s()) $$,
  $$ values (300::bigint, '2026-03-01 11:00+00'::timestamptz, 'cash'::text) $$,
  'P6: v->u nets 300 with markAt t2');

-- Immutability: even the owner cannot update an entry.
select throws_ok(
  $$ update public.bill_payments set cents = 1 where bill_id = pg_temp.q() $$,
  '42501', 'payments_are_immutable', 'A1.2: an entry cannot be updated, even by the owner');

-- ---------------------------------------------------------------------------
-- Broadcast: one data-free hint per bill per statement
-- ---------------------------------------------------------------------------
delete from realtime.messages where topic = 'bill:' || pg_temp.q()::text;
insert into public.bill_payments (bill_id, from_user, to_user, cents, method, recorded_by)
values (pg_temp.q(), pg_temp.s(), pg_temp.h(), 100, 'other', pg_temp.s()),
       (pg_temp.q(), pg_temp.d(), pg_temp.h(), 100, 'other', pg_temp.d());
select results_eq(
  $$ select event, private, payload - 'id' from realtime.messages
     where topic = 'bill:' || pg_temp.q()::text $$,
  $$ values ('changed'::text, true, '{"t":"bill_payments"}'::jsonb) $$,
  'A1.3: a two-row insert sends one private hint {t: bill_payments}');

delete from realtime.messages where topic = 'bill:' || pg_temp.q()::text;
delete from public.bill_payments where bill_id = pg_temp.q();
select is(
  (select count(*)::int from realtime.messages where topic = 'bill:' || pg_temp.q()::text),
  1, 'A1.3: a multi-row delete sends one hint');

-- ---------------------------------------------------------------------------
-- A-13: mark_paid argument checks
-- ---------------------------------------------------------------------------
select pg_temp.act(pg_temp.h());
set local role authenticated;
select throws_ok(
  $$ select * from public.mark_paid(pg_temp.x(), pg_temp.h(), 1500, 'venmo') $$,
  '22023', 'is_payer', 'A-13: the payer marking themself gives is_payer');
reset role;

select pg_temp.act(pg_temp.s());
set local role authenticated;
select throws_ok(
  $$ select * from public.mark_paid(pg_temp.x(), pg_temp.d(), 1500, 'venmo') $$,
  '22023', 'payer_changed', 'A-13: marking toward a non-payer gives payer_changed');
select throws_ok(
  $$ select * from public.mark_paid(pg_temp.x(), pg_temp.h(), 1500, 'venmo', 'ABC') $$,
  '22023', 'invalid_plan_key', 'A-13: plan key ABC gives invalid_plan_key');
select throws_ok(
  $$ select * from public.mark_paid(pg_temp.x(), pg_temp.h(), 1500, 'venmo', '0123456789abcde') $$,
  '22023', 'invalid_plan_key', 'A-13: a 15-character plan key gives invalid_plan_key');
select throws_ok(
  $$ select * from public.mark_paid(pg_temp.x(), pg_temp.h(), 1500, 'venmo', '0123456789abcdef0') $$,
  '22023', 'invalid_plan_key', 'A-13: a 17-character plan key gives invalid_plan_key');
select throws_ok(
  $$ select * from public.mark_paid(pg_temp.x(), pg_temp.h(), 1500, 'venmo', '0123456789ABCDEF') $$,
  '22023', 'invalid_plan_key', 'A-13: an uppercase plan key gives invalid_plan_key (lib emits lowercase)');
reset role;

-- ---------------------------------------------------------------------------
-- A-5: mark_paid returns (settled_at, created); a repeat returns the first settled_at
-- ---------------------------------------------------------------------------
-- S's entry is backdated (owner insert), so a rewrite would show.
insert into public.bill_payments (bill_id, from_user, to_user, cents, method, recorded_by, recorded_at)
values (pg_temp.x(), pg_temp.s(), pg_temp.h(), 1500, 'venmo', pg_temp.s(), '2026-01-01 00:00+00');

select pg_temp.act(pg_temp.s());
set local role authenticated;
select results_eq(
  $$ select settled_at, created
     from public.mark_paid(pg_temp.x(), pg_temp.h(), 1500, 'venmo', '0123456789abcdef') $$,
  $$ values ('2026-01-01 00:00+00'::timestamptz, false) $$,
  'A-5: a repeat returns (the first settled_at, false)');
reset role;
select is(
  (select count(*)::int from public.bill_payments
   where bill_id = pg_temp.x() and from_user = pg_temp.s()),
  1, 'A-5: the repeat wrote no entry');

select pg_temp.act(pg_temp.d());
set local role authenticated;
select is(
  (select created from public.mark_paid(pg_temp.x(), pg_temp.h(), 1000, 'cash', '0123456789abcdef')),
  true, 'A-5: the first mark returns created = true');
select is(
  (select created from public.mark_paid(pg_temp.x(), pg_temp.h(), 1000, 'cash', null)),
  false, 'A-5: the repeat returns created = false');
select is(
  (select settled_at from public.mark_paid(pg_temp.x(), pg_temp.h(), 1000, 'cash')),
  (select recorded_at from public.bill_payments
   where bill_id = pg_temp.x() and from_user = pg_temp.d()),
  'A-5: the repeat''s settled_at is the entry''s recorded_at (the pair''s stable at)');
reset role;
select results_eq(
  $$ select to_user, cents, method, plan_key, recorded_by from public.bill_payments
     where bill_id = pg_temp.x() and from_user = pg_temp.d() $$,
  $$ values (pg_temp.h(), 1000, 'cash'::text, '0123456789abcdef'::text, pg_temp.d()) $$,
  'A-5: the entry stores the plan key and recorder');
select is(
  (select count(*)::int from public.bill_events
   where bill_id = pg_temp.x() and kind = 'marked_paid' and actor_id = pg_temp.d()),
  1, 'A-5: one marked_paid event for three calls');

-- ---------------------------------------------------------------------------
-- A-19: reads and writes by client roles
-- ---------------------------------------------------------------------------
select pg_temp.act(pg_temp.s());
set local role authenticated;
select is(
  (select count(*)::int from public.bill_payments where bill_id = pg_temp.x()),
  2, 'A-19: a participant reads the bill''s entries');
select throws_ok(
  $$ insert into public.bill_payments (bill_id, from_user, to_user, cents, method, recorded_by)
     values (pg_temp.x(), pg_temp.s(), pg_temp.h(), 1, 'other', pg_temp.s()) $$,
  '42501', null, 'A-19: a client cannot insert an entry');
select throws_ok(
  $$ update public.bill_payments set cents = 1 where bill_id = pg_temp.x() $$,
  '42501', null, 'A-19: a client cannot update an entry');
select throws_ok(
  $$ delete from public.bill_payments where bill_id = pg_temp.x() $$,
  '42501', null, 'A-19: a client cannot delete an entry');
select throws_ok(
  $$ insert into public.bill_payment_flags (bill_id, from_user, to_user, cents, method)
     values (pg_temp.x(), pg_temp.s(), pg_temp.h(), 1, 'other') $$,
  '42501', null, 'A-19: a client cannot insert a flag');
select throws_ok(
  $$ update public.bill_payment_flags set cents = 1 where bill_id = pg_temp.x() $$,
  '42501', null, 'A-19: a client cannot update a flag');
select throws_ok(
  $$ delete from public.bill_payment_flags where bill_id = pg_temp.x() $$,
  '42501', null, 'A-19: a client cannot delete a flag');
reset role;

select pg_temp.act(pg_temp.o());
set local role authenticated;
select is(
  (select count(*)::int from public.bill_payments where bill_id = pg_temp.x()),
  0, 'A-19: a non-participant reads no entries');
reset role;

-- The same read pair for flags. Bill X has no flag yet, so one owner-made flag (Sam -> Hana) makes
-- the outsider's 0 meaningful; Dee reads it as a participant who is neither side of it. The flag
-- is removed right after, so the unmark_paid checks below see bill X as before.
insert into public.bill_payment_flags (bill_id, from_user, to_user, cents, method)
values (pg_temp.x(), pg_temp.s(), pg_temp.h(), 1, 'other');
select pg_temp.act(pg_temp.d());
set local role authenticated;
select is(
  (select count(*)::int from public.bill_payment_flags where bill_id = pg_temp.x()),
  1, 'A-19: a participant reads the bill''s flags (positive control, X)');
reset role;

select pg_temp.act(pg_temp.o());
set local role authenticated;
select is(
  (select count(*)::int from public.bill_payment_flags where bill_id = pg_temp.x()),
  0, 'A-19: a non-participant reads no flags (X)');
reset role;
delete from public.bill_payment_flags where bill_id = pg_temp.x();

set local role anon;
select throws_ok($$ select 1 from public.bill_payments limit 1 $$, '42501', null,
  'A-19: anon cannot read bill_payments');
select throws_ok($$ select 1 from public.bill_payment_flags limit 1 $$, '42501', null,
  'A-19: anon cannot read bill_payment_flags');
reset role;

-- ---------------------------------------------------------------------------
-- A-16: unmark_paid(bill, user, payer)
-- ---------------------------------------------------------------------------
select ok(to_regprocedure('public.unmark_paid(uuid,uuid)') is null,
  'A-16: the 2-arg unmark_paid is gone');
select ok(to_regprocedure('public.mark_paid(uuid,uuid,integer,text)') is null,
  'A-5: the 4-arg mark_paid is gone (one 5-arg function with a defaulted plan key)');

select pg_temp.act(pg_temp.o());
set local role authenticated;
select throws_ok(
  $$ select public.unmark_paid(pg_temp.x(), pg_temp.d(), pg_temp.h()) $$,
  '42501', 'not_allowed', 'A-16: a non-participant cannot unmark');
reset role;

select pg_temp.act(pg_temp.s());
set local role authenticated;
select throws_ok(
  $$ select public.unmark_paid(pg_temp.x(), pg_temp.d(), pg_temp.h()) $$,
  '42501', 'not_allowed', 'A-16: another participant cannot unmark someone else''s pair');
reset role;

select pg_temp.act(pg_temp.d());
set local role authenticated;
select lives_ok(
  $$ select public.unmark_paid(pg_temp.x(), pg_temp.d(), pg_temp.h()) $$,
  'A-16: the sender unmarks their own pair');
reset role;
select is(
  (select count(*)::int from public.bill_payments
   where bill_id = pg_temp.x() and from_user = pg_temp.d()),
  0, 'A-16: the run is deleted');
select results_eq(
  $$ select actor_id, details from public.bill_events
     where bill_id = pg_temp.x() and kind = 'unmarked_paid' $$,
  $$ values (pg_temp.d(), jsonb_build_object('user_id', pg_temp.d(), 'cents', 1000)) $$,
  'A-16: one unmarked_paid event {user_id, cents}');

select pg_temp.act(pg_temp.d());
set local role authenticated;
select public.unmark_paid(pg_temp.x(), pg_temp.d(), pg_temp.h());
reset role;
select is(
  (select count(*)::int from public.bill_events
   where bill_id = pg_temp.x() and kind = 'unmarked_paid'),
  1, 'A-16: with no mark, unmark is a no-op without an event');

select pg_temp.act(pg_temp.h());
set local role authenticated;
select public.unmark_paid(pg_temp.x(), pg_temp.s(), pg_temp.h());
reset role;
select is(
  (select count(*)::int from public.bill_payments
   where bill_id = pg_temp.x() and from_user = pg_temp.s()),
  0, 'A-16: the host (here also the payer) unmarks a pair');

-- ---------------------------------------------------------------------------
-- A-15: mark_not_received deletes exactly the run (P3 shape on bill Q, pair S -> H)
-- ---------------------------------------------------------------------------
select pg_temp.e(pg_temp.s(), pg_temp.h(), 1510, 'venmo', '2026-03-01 10:00+00');
select pg_temp.e(pg_temp.h(), pg_temp.s(), 1510, 'other', '2026-03-01 11:00+00');
select pg_temp.e(pg_temp.s(), pg_temp.h(), 1400, 'cash', '2026-03-01 12:00+00');

select pg_temp.act(pg_temp.d());
set local role authenticated;
select throws_ok(
  $$ select public.mark_not_received(pg_temp.q(), pg_temp.s(), pg_temp.h(), 1400,
                                     '2026-03-01 12:00+00') $$,
  '42501', 'not_allowed', 'A-15: only the pair''s recipient can say not received');
reset role;

select pg_temp.act(pg_temp.h());
set local role authenticated;
select throws_ok(
  $$ select public.mark_not_received(pg_temp.q(), pg_temp.s(), pg_temp.h(), 1400,
                                     '2026-03-01 10:00+00') $$,
  '22023', 'mark_changed', 'A-15: a token with the wrong at gives mark_changed');
reset role;

delete from realtime.messages where topic = 'bill:' || pg_temp.q()::text;
select pg_temp.act(pg_temp.h());
set local role authenticated;
select lives_ok(
  $$ select public.mark_not_received(pg_temp.q(), pg_temp.s(), pg_temp.h(), 1400,
                                     '2026-03-01 12:00+00') $$,
  'A-15: the recipient says not received with the token (net, markAt)');
reset role;
select results_eq(
  $$ select recorded_at from public.bill_payments where bill_id = pg_temp.q()
     order by recorded_at $$,
  $$ values ('2026-03-01 10:00+00'::timestamptz), ('2026-03-01 11:00+00'::timestamptz) $$,
  'A-15: only the run''s entry is deleted (the t1/t2 entries stay)');
select results_eq(
  $$ select from_user, to_user, cents, method from public.bill_payment_flags
     where bill_id = pg_temp.q() $$,
  $$ values (pg_temp.s(), pg_temp.h(), 1400, 'cash'::text) $$,
  'A-15: the flag records the run''s cents and method');
select is(
  (select count(*)::int from realtime.messages where topic = 'bill:' || pg_temp.q()::text),
  1, 'A1.3: one call touching both ledger tables sends one hint');

select pg_temp.act(pg_temp.s());
set local role authenticated;
select is(
  (select count(*)::int from public.bill_payment_flags where bill_id = pg_temp.q()),
  1, 'A-19: a participant reads the bill''s flags');
reset role;

select pg_temp.act(pg_temp.o());
set local role authenticated;
select is(
  (select count(*)::int from public.bill_payment_flags where bill_id = pg_temp.q()),
  0, 'A-19: a non-participant reads no flags');
reset role;

select pg_temp.act(pg_temp.h());
set local role authenticated;
select lives_ok(
  $$ select public.mark_not_received(pg_temp.q(), pg_temp.s(), pg_temp.h(), 1400,
                                     '2026-03-01 12:00+00') $$,
  'A-15: an identical retry (the flag already holds the cents) succeeds');
reset role;
select is(
  (select count(*)::int from public.bill_events
   where bill_id = pg_temp.q() and kind = 'not_received'),
  1, 'A-15: the retry logs no second not_received event');

-- ---------------------------------------------------------------------------
-- A-15: settle_difference on the ledger (back by an ex-payer; others refused)
-- ---------------------------------------------------------------------------
select pg_temp.act(pg_temp.d());
set local role authenticated;
select * from public.mark_paid(pg_temp.x(), pg_temp.h(), 1000, 'cash');
reset role;

select pg_temp.act(pg_temp.h());
set local role authenticated;
select public.set_payer(pg_temp.x(), pg_temp.s());
select throws_ok(
  $$ select public.settle_difference(pg_temp.x(), pg_temp.d(), pg_temp.h(), 900, 0, 'other') $$,
  '22023', 'mark_changed', 'A-15: a stale expected cents gives mark_changed');
select lives_ok(
  $$ select public.settle_difference(pg_temp.x(), pg_temp.d(), pg_temp.h(), 1000, 600, 'other') $$,
  'A-15: an ex-payer pays back on a pair they received');
reset role;
select is(
  (select net from private.pair_state(pg_temp.x(), pg_temp.d(), pg_temp.h())),
  600::bigint, 'A-15: the pair nets 600 after paying back 400');

select pg_temp.act(pg_temp.s());
set local role authenticated;
select throws_ok(
  $$ select public.settle_difference(pg_temp.x(), pg_temp.d(), pg_temp.h(), 600, 0, 'other') $$,
  '42501', 'not_allowed', 'A-15: paying back by anyone but the recipient gives 42501');
reset role;

select pg_temp.act(pg_temp.d());
set local role authenticated;
select throws_ok(
  $$ select public.settle_difference(pg_temp.x(), pg_temp.d(), pg_temp.h(), 600, 800, 'venmo') $$,
  '22023', 'payer_changed', 'A-15: paying more needs a current payer');
reset role;

-- ---------------------------------------------------------------------------
-- A-20: execute grants
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select f, has_function_privilege('anon', f, 'execute'),
            has_function_privilege('authenticated', f, 'execute')
     from unnest(array[
       'public.mark_paid(uuid,uuid,integer,text,text)',
       'public.unmark_paid(uuid,uuid,uuid)',
       'public.mark_not_received(uuid,uuid,uuid,integer,timestamptz)',
       'public.settle_difference(uuid,uuid,uuid,integer,integer,text,text)']) as f $$,
  $$ values
       ('public.mark_paid(uuid,uuid,integer,text,text)', false, true),
       ('public.unmark_paid(uuid,uuid,uuid)', false, true),
       ('public.mark_not_received(uuid,uuid,uuid,integer,timestamptz)', false, true),
       ('public.settle_difference(uuid,uuid,uuid,integer,integer,text,text)', false, true) $$,
  'A-20: the ledger functions are executable by authenticated only');
select is(
  (select count(*)::int
   from unnest(array[
     'private.pair_state(uuid,uuid,uuid)',
     'private.bill_payer_ids(uuid)',
     'private.payers_valid(uuid)',
     'private.broadcast_bill_ledger_change()',
     'private.bill_payments_no_update()',
     'private.bill_payments_no_group()',
     'private.is_removable(uuid,uuid)']) as f
   where has_function_privilege('authenticated', f, 'execute')
      or has_function_privilege('anon', f, 'execute')),
  0, 'A-20: no client role can execute the private ledger helpers');
select is(
  (select count(*)::int from pg_proc as p join pg_namespace as n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('mark_paid', 'unmark_paid', 'mark_not_received', 'settle_difference')
     and not (p.prosecdef and array['search_path=""'] <@ coalesce(p.proconfig, '{}'))),
  0, 'A1.3: the ledger functions are security definer with search_path = ''''');

select * from finish();
rollback;
