-- pgTAP tests for supabase/migrations/20261124094656_people_review_fixes.sql (review R1, R4 of
-- docs/specs/2026-11-24-people-and-invites.md; R6 / P10 is in people.test.sql).
--
-- A real two-session deadlock can't be produced in pgTAP (one transaction, one connection). These
-- tests check the lock order instead:
--   * the function bodies call the bill lock before their writes (static, from pg_proc), and
--   * at run time the helper is called while the claim row doesn't exist yet (insert) or still
--     exists (delete). For that the helper is replaced, inside this rolled-back transaction, with
--     a copy that records each call and then takes the same lock.
--
-- Every assertion filters to the fixture users/bills below (the local DB may hold real data).
-- Fixture ids all start with 7c.
-- Users: H ..01 'Hal' (host), P ..02 'Pia' (joined with the link), O ..03 'Oz' (not on the bill).
-- Bill T: Tea 300, Cake 400; total 700.

begin;

create extension if not exists pgtap with schema extensions;

select plan(16);

create function pg_temp.act(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('7c000000-0000-0000-0000-000000000001', 'reviewfix-h@test.local', '{"full_name":"Hal"}'::jsonb),
  ('7c000000-0000-0000-0000-000000000002', 'reviewfix-p@test.local', '{"full_name":"Pia"}'::jsonb),
  ('7c000000-0000-0000-0000-000000000003', 'reviewfix-o@test.local', '{"full_name":"Oz"}'::jsonb);

do $$
declare r record;
begin
  perform pg_temp.act('7c000000-0000-0000-0000-000000000001');
  select * into r from public.create_bill($json$[
    {"name":"Tea","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":300},
    {"name":"Cake","note":null,"group_position":1,"unit_index":0,"group_size":1,"total_cents":400}
  ]$json$::jsonb, null, 0, 0, 0, 0, 0, 700);
  perform set_config('test.t', r.bill_id::text, true);
  perform pg_temp.act('7c000000-0000-0000-0000-000000000002');
  perform public.join_bill(r.join_code);
end $$;

select set_config('test.tea',
  (select id::text from public.line_items where bill_id = current_setting('test.t')::uuid and name = 'Tea'), true);
select set_config('test.cake',
  (select id::text from public.line_items where bill_id = current_setting('test.t')::uuid and name = 'Cake'), true);

-- ---------------------------------------------------------------------------
-- The helper and the trigger
-- ---------------------------------------------------------------------------
select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=""']
   from pg_proc as p where p.oid = 'private.lock_bill_key_share(uuid)'::regprocedure),
  'R1: private.lock_bill_key_share is security definer with an empty search_path');
select ok(
  has_function_privilege('authenticated', 'private.lock_bill_key_share(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.lock_bill_key_share(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.claims_lock_bill_first()', 'execute')
  and not has_function_privilege('anon', 'private.claims_lock_bill_first()', 'execute'),
  'R1: only authenticated may execute the helper (set_claim runs as the client); nobody may call the trigger function');
select has_trigger('public', 'claims', 'claims_lock_bill_first',
  'R1: claims has the BEFORE INSERT trigger claims_lock_bill_first');
select ok(
  (select t.tgtype & 2 = 2 and t.tgtype & 4 = 4 and t.tgtype & 1 = 1
   from pg_trigger as t
   where t.tgrelid = 'public.claims'::regclass and t.tgname = 'claims_lock_bill_first'),
  'R1: claims_lock_bill_first is BEFORE, ROW, INSERT');

-- ---------------------------------------------------------------------------
-- Static order: the bill lock comes before each function's writes
-- ---------------------------------------------------------------------------
select ok(
  (select position('private.lock_bill_key_share' in p.prosrc) > 0
          and position('private.lock_bill_key_share' in p.prosrc) < position('insert into public.claims' in p.prosrc)
          and position('private.lock_bill_key_share' in p.prosrc) < position('delete from public.claims' in p.prosrc)
   from pg_proc as p where p.oid = 'public.set_claim(uuid,boolean)'::regprocedure),
  'R1: set_claim calls the bill lock before its insert and its delete');
select ok(
  (select position('private.lock_bill_key_share' in p.prosrc) > 0
          and position('private.lock_bill_key_share' in p.prosrc) < position('for update' in p.prosrc)
   from pg_proc as p where p.oid = 'public.set_item_split(uuid,jsonb)'::regprocedure),
  'R1: set_item_split calls the bill lock before its first FOR UPDATE');
select ok(
  (select position('for key share' in p.prosrc) > 0
          and position('for key share' in p.prosrc) < position('insert into public.bill_participants' in p.prosrc)
          and position('for key share' in p.prosrc) < position('update public.bill_participants' in p.prosrc)
   from pg_proc as p where p.oid = 'public.join_bill(text)'::regprocedure),
  'R1: join_bill locks the bill (FOR KEY SHARE) before it inserts or updates a participant row');

-- ---------------------------------------------------------------------------
-- Run-time order: a recording copy of the helper (rolled back with the test)
-- ---------------------------------------------------------------------------
create temp table lock_calls (
  n serial primary key,
  bill_id uuid,
  claim_rows integer  -- the caller's claims on the bill at the moment the helper ran
);
grant all on lock_calls to authenticated;
grant usage on sequence lock_calls_n_seq to authenticated;

create or replace function private.lock_bill_key_share(p_bill_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into pg_temp.lock_calls (bill_id, claim_rows)
  select p_bill_id, count(*)::integer from public.claims as c
  where c.bill_id = p_bill_id and c.user_id = (select auth.uid());

  perform 1
  from public.bills as b
  where b.id = p_bill_id
    and exists (
      select 1 from public.bill_participants as bp
      where bp.bill_id = b.id and bp.user_id = (select auth.uid())
    )
  for key share of b;
end;
$$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"7c000000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.set_claim(current_setting('test.tea')::uuid, true);
reset role;

select results_eq(
  $$ select bill_id::text, claim_rows from lock_calls order by n $$,
  $$ values (current_setting('test.t'), 0), (current_setting('test.t'), 0) $$,
  'R1: set_claim(true) runs the bill lock twice (its own call, then the trigger), both before the claim row exists');
select is(
  (select count(*)::int from public.claims
   where bill_id = current_setting('test.t')::uuid and user_id = '7c000000-0000-0000-0000-000000000002'),
  1, 'R1: and the claim is written');

truncate lock_calls;
set local role authenticated;
set local request.jwt.claims = '{"sub":"7c000000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.set_claim(current_setting('test.tea')::uuid, false);
reset role;

select results_eq(
  $$ select bill_id::text, claim_rows from lock_calls order by n $$,
  $$ values (current_setting('test.t'), 1) $$,
  'R1: set_claim(false) runs the bill lock once, while the claim row still exists');

truncate lock_calls;
set local role authenticated;
set local request.jwt.claims = '{"sub":"7c000000-0000-0000-0000-000000000002","role":"authenticated"}';
insert into public.claims (bill_id, line_item_id, user_id)
values (current_setting('test.t')::uuid, current_setting('test.cake')::uuid, '7c000000-0000-0000-0000-000000000002');
reset role;

select results_eq(
  $$ select bill_id::text, claim_rows from lock_calls order by n $$,
  $$ values (current_setting('test.t'), 0) $$,
  'R1: a direct claim insert under RLS runs the bill lock (trigger) before the row exists');

-- Behavior unchanged.
select bag_eq(
  $$ select kind, item_name from public.bill_events
     where bill_id = current_setting('test.t')::uuid and kind in ('claimed', 'unclaimed') $$,
  $$ values ('claimed'::text, 'Tea'::text), ('unclaimed', 'Tea'), ('claimed', 'Cake') $$,
  'R1: the three claim writes logged exactly one event each');
set local role authenticated;
set local request.jwt.claims = '{"sub":"7c000000-0000-0000-0000-000000000003","role":"authenticated"}';
select throws_ok(
  $$ select public.set_claim(current_setting('test.tea')::uuid, true) $$,
  'P0002', 'not_found', 'R1: set_claim by a non-participant still fails with P0002 not_found');
reset role;

-- ---------------------------------------------------------------------------
-- R4: leave_bill refuses a non-participant before locking the bill
-- ---------------------------------------------------------------------------
-- A FOR UPDATE taken inside throws_ok's subtransaction would leave that subtransaction's xid (or a
-- multixact) in the bills row's xmax even after the rollback; an unlocked refusal leaves xmax as
-- it was.
select set_config('test.xmax_before',
  (select xmax::text from public.bills where id = current_setting('test.t')::uuid), true);
set local role authenticated;
set local request.jwt.claims = '{"sub":"7c000000-0000-0000-0000-000000000003","role":"authenticated"}';
select throws_ok(
  $$ select public.leave_bill(current_setting('test.t')::uuid) $$,
  '42501', 'not_allowed', 'R4: leave_bill by a non-participant fails with 42501 not_allowed');
reset role;
select is(
  (select xmax::text from public.bills where id = current_setting('test.t')::uuid),
  current_setting('test.xmax_before'),
  'R4: and it took no lock on the bills row');

set local role authenticated;
set local request.jwt.claims = '{"sub":"7c000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok(
  $$ select public.leave_bill(current_setting('test.t')::uuid) $$,
  '22023', 'cannot_leave', 'R4: a participant with a claim still gets 22023 cannot_leave (checked under the lock)');
reset role;

select * from finish();
rollback;
