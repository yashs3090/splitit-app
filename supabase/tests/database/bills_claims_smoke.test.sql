-- Smoke tests for the bills_claims migration (spec 2026-11-20-m1b-m2-share-and-claim.md, Task 1).
-- Checks that the four tables exist with RLS on, the grants are exactly as specified, the
-- private helpers are locked down, and one participant/outsider pair sees what it should.
-- The full schema/grants/RLS suite (criteria 7 to 21) is Task 2 (bills_rls.test.sql).
--
-- Users: H a1... (host), P a2... (participant), O a3... (outsider, in no bill)

begin;

create extension if not exists pgtap with schema extensions;

select plan(28);

-- ---------------------------------------------------------------------------
-- Tables and RLS
-- ---------------------------------------------------------------------------
select has_table('public', 'bills', 'public.bills exists');
select has_table('public', 'line_items', 'public.line_items exists');
select has_table('public', 'bill_participants', 'public.bill_participants exists');
select has_table('public', 'claims', 'public.claims exists');

select ok(
  (select bool_and(relrowsecurity) from pg_class
    where oid in ('public.bills'::regclass, 'public.line_items'::regclass,
                  'public.bill_participants'::regclass, 'public.claims'::regclass)),
  'RLS is enabled on all four tables'
);

-- ---------------------------------------------------------------------------
-- Grants (criteria 7, 8)
-- ---------------------------------------------------------------------------
select table_privs_are('public', 'bills', 'anon', array[]::text[], 'anon has no privileges on bills');
select table_privs_are('public', 'line_items', 'anon', array[]::text[], 'anon has no privileges on line_items');
select table_privs_are('public', 'bill_participants', 'anon', array[]::text[], 'anon has no privileges on bill_participants');
select table_privs_are('public', 'claims', 'anon', array[]::text[], 'anon has no privileges on claims');

select table_privs_are('public', 'bills', 'authenticated', array['SELECT'], 'authenticated: bills SELECT only');
select table_privs_are('public', 'line_items', 'authenticated', array['SELECT'], 'authenticated: line_items SELECT only');
select table_privs_are('public', 'bill_participants', 'authenticated', array['SELECT'], 'authenticated: bill_participants SELECT only');
select table_privs_are('public', 'claims', 'authenticated', array['DELETE', 'SELECT'],
  'authenticated: claims table-level SELECT and DELETE only');

select ok(
  has_column_privilege('authenticated', 'public.claims', 'bill_id', 'INSERT')
  and has_column_privilege('authenticated', 'public.claims', 'line_item_id', 'INSERT')
  and has_column_privilege('authenticated', 'public.claims', 'user_id', 'INSERT')
  and not has_column_privilege('authenticated', 'public.claims', 'parts', 'INSERT')
  and not has_column_privilege('authenticated', 'public.claims', 'created_at', 'INSERT'),
  'authenticated can insert claims only through bill_id, line_item_id, user_id'
);

select ok(
  not exists (
    select 1 from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'claims'
      and grantee in ('authenticated', 'anon', 'PUBLIC') and privilege_type = 'UPDATE'
  ),
  'no client role has UPDATE on any claims column'
);

-- ---------------------------------------------------------------------------
-- private helpers (criterion 10)
-- ---------------------------------------------------------------------------
select ok(
  (select bool_and(prosecdef and proconfig = array['search_path=""'])
     from pg_proc
     where oid in ('private.is_bill_participant(uuid)'::regprocedure,
                   'private.shares_bill_with(uuid)'::regprocedure)),
  'private helpers are security definer with an empty search_path'
);

select ok(
  not has_function_privilege('anon', 'private.is_bill_participant(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.shares_bill_with(uuid)', 'execute')
  and not has_schema_privilege('anon', 'private', 'usage'),
  'anon cannot use the private schema or execute its helpers'
);

select ok(
  has_function_privilege('authenticated', 'private.is_bill_participant(uuid)', 'execute')
  and has_function_privilege('authenticated', 'private.shares_bill_with(uuid)', 'execute'),
  'authenticated can execute the helpers (RLS policies need it)'
);

select ok(
  not exists (
    select 1 from pg_trigger t
    join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.claims'::regclass and not t.tgisinternal
      -- Writes to parts, not reads: the Activity trigger (bill_events migration) reads parts.
      and p.prosrc ~* '(update\s+public\.claims|set\s+parts|new\.parts\s*:?=)'
  ),
  'no trigger on claims rewrites parts (A2.3: no reset trigger)'
);

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres): bill X hosted by H, with P; O is in no bill.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('a1000000-0000-0000-0000-000000000001', 'h@test.local', '{"full_name":"Hana"}'::jsonb),
  ('a2000000-0000-0000-0000-000000000002', 'p@test.local', '{"full_name":"Pat"}'::jsonb),
  ('a3000000-0000-0000-0000-000000000003', 'o@test.local', '{"full_name":"Oli"}'::jsonb);

insert into public.bills (id, host_id, tax_cents, total_cents, join_code) values
  ('b1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001',
   100, 1600, '0123456789abcdef0123');

insert into public.bill_participants (bill_id, user_id) values
  ('b1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000002');

insert into public.line_items (id, bill_id, group_position, unit_index, group_size, name, total_cents) values
  ('c1000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 0, 0, 1, 'Burger', 1500);

insert into public.claims (bill_id, line_item_id, user_id) values
  ('b1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001',
   'a1000000-0000-0000-0000-000000000001');

-- ---------------------------------------------------------------------------
-- As P (participant)
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';

select is((select count(*)::int from public.bills), 1, 'P sees bill X');
select is((select count(*)::int from public.claims), 1, 'P sees H''s claim on X');

select lives_ok(
  $$ insert into public.claims (bill_id, line_item_id, user_id) values
     ('b1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001',
      'a2000000-0000-0000-0000-000000000002') $$,
  'P can claim a row of X for themselves'
);

select throws_ok(
  $$ update public.claims set parts = 3
     where user_id = 'a2000000-0000-0000-0000-000000000002' $$,
  '42501', null,
  'P cannot update parts on their own claim (no update grant)'
);

select results_eq(
  $$ select display_name from public.profiles order by display_name $$,
  $$ values ('Hana'::text), ('Pat'::text) $$,
  'P reads their own and H''s profile, not O''s'
);

-- ---------------------------------------------------------------------------
-- As O (outsider)
-- ---------------------------------------------------------------------------
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a3000000-0000-0000-0000-000000000003","role":"authenticated"}';

select is(
  (select (select count(*) from public.bills) + (select count(*) from public.line_items)
        + (select count(*) from public.bill_participants) + (select count(*) from public.claims))::int,
  0,
  'O sees no rows of X in any of the four tables'
);

select throws_ok(
  $$ insert into public.claims (bill_id, line_item_id, user_id) values
     ('b1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001',
      'a3000000-0000-0000-0000-000000000003') $$,
  '42501', null,
  'O cannot claim a row of X'
);

-- ---------------------------------------------------------------------------
-- As anon
-- ---------------------------------------------------------------------------
reset role;
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

select throws_ok($$ select 1 from public.bills $$, '42501', null, 'anon cannot read bills');
select throws_ok($$ select 1 from public.claims $$, '42501', null, 'anon cannot read claims');

reset role;
reset request.jwt.claims;

select * from finish();

rollback;
