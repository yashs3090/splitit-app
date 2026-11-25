-- pgTAP tests for the bills/line_items/bill_participants/claims schema, grants and RLS
-- (spec 2026-11-20-m1b-m2-share-and-claim.md, Task 2, criteria 7-21).
--
-- Fixtures (inserted as postgres):
--   Users: H a1... 'Hana' (host of X), P a2... 'Pat', R a3... 'Rae' (in X, claims nothing),
--          O a4... 'Oli' (host of Y, outsider to X), Q a5... 'Quinn' (in Y with O only).
--   Bill X: rows Burger 1500, Fries 600, Beer 1/2 700, Beer 2/2 700.
--           Claims: H Burger, H Fries, P Fries, P Beer 1/2.
--   Bill Y: row Salad 900. Claim: O Salad.

begin;

create extension if not exists pgtap with schema extensions;

select plan(80);

insert into auth.users (id, email, raw_user_meta_data) values
  ('a1000000-0000-0000-0000-000000000001', 'h@test.local', '{"full_name":"Hana"}'::jsonb),
  ('a2000000-0000-0000-0000-000000000002', 'p@test.local', '{"full_name":"Pat"}'::jsonb),
  ('a3000000-0000-0000-0000-000000000003', 'r@test.local', '{"full_name":"Rae"}'::jsonb),
  ('a4000000-0000-0000-0000-000000000004', 'o@test.local', '{"full_name":"Oli"}'::jsonb),
  ('a5000000-0000-0000-0000-000000000005', 'q@test.local', '{"full_name":"Quinn"}'::jsonb);

insert into public.bills (id, host_id, tax_cents, tip_cents, total_cents, join_code) values
  ('b1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 280, 700, 4480, '0123456789abcdef0123'),
  ('b2000000-0000-0000-0000-000000000002', 'a4000000-0000-0000-0000-000000000004', 0, 0, 900, 'fedcba9876543210fedc');

insert into public.bill_participants (bill_id, user_id) values
  ('b1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000002'),
  ('b1000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000003'),
  ('b2000000-0000-0000-0000-000000000002', 'a4000000-0000-0000-0000-000000000004'),
  ('b2000000-0000-0000-0000-000000000002', 'a5000000-0000-0000-0000-000000000005');

insert into public.line_items (id, bill_id, group_position, unit_index, group_size, name, total_cents) values
  ('c1000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 0, 0, 1, 'Burger', 1500),
  ('c1000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000001', 1, 0, 1, 'Fries', 600),
  ('c1000000-0000-0000-0000-000000000003', 'b1000000-0000-0000-0000-000000000001', 2, 0, 2, 'Beer', 700),
  ('c1000000-0000-0000-0000-000000000004', 'b1000000-0000-0000-0000-000000000001', 2, 1, 2, 'Beer', 700),
  ('c2000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000002', 0, 0, 1, 'Salad', 900);

insert into public.claims (bill_id, line_item_id, user_id) values
  ('b1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000002', 'a2000000-0000-0000-0000-000000000002'),
  ('b1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000003', 'a2000000-0000-0000-0000-000000000002'),
  ('b2000000-0000-0000-0000-000000000002', 'c2000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000004');

-- ---------------------------------------------------------------------------
-- Criterion 7: RLS on, anon has nothing
-- ---------------------------------------------------------------------------
select ok(
  (select bool_and(relrowsecurity) and count(*) = 4 from pg_class
    where oid in ('public.bills'::regclass, 'public.line_items'::regclass,
                  'public.bill_participants'::regclass, 'public.claims'::regclass)),
  'criterion 7: RLS is enabled on all four tables'
);
select table_privs_are('public', 'bills', 'anon', array[]::text[], 'criterion 7: anon has no privileges on bills');
select table_privs_are('public', 'line_items', 'anon', array[]::text[], 'criterion 7: anon has no privileges on line_items');
select table_privs_are('public', 'bill_participants', 'anon', array[]::text[], 'criterion 7: anon has no privileges on bill_participants');
select table_privs_are('public', 'claims', 'anon', array[]::text[], 'criterion 7: anon has no privileges on claims');
select ok(
  not exists (
    select 1 from information_schema.column_privileges
    where table_schema = 'public' and table_name in ('bills', 'line_items', 'bill_participants', 'claims')
      and grantee in ('anon', 'PUBLIC')
  ),
  'criterion 7: anon and PUBLIC have no column privileges on the four tables'
);

-- ---------------------------------------------------------------------------
-- Criterion 8: authenticated grants
-- ---------------------------------------------------------------------------
select table_privs_are('public', 'bills', 'authenticated', array['SELECT'], 'criterion 8: bills SELECT only');
select table_privs_are('public', 'line_items', 'authenticated', array['SELECT'], 'criterion 8: line_items SELECT only');
select table_privs_are('public', 'bill_participants', 'authenticated', array['SELECT'], 'criterion 8: bill_participants SELECT only');
select table_privs_are('public', 'claims', 'authenticated', array['DELETE', 'SELECT'],
  'criterion 8: claims table-level SELECT and DELETE only');
select is(
  array(select column_name::text from information_schema.column_privileges
        where table_schema = 'public' and table_name = 'claims'
          and grantee = 'authenticated' and privilege_type = 'INSERT'
        order by 1),
  array['bill_id', 'line_item_id', 'user_id'],
  'criterion 8: claims column INSERT is exactly (bill_id, line_item_id, user_id)'
);
select ok(
  not exists (
    select 1 from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'claims'
      and grantee = 'authenticated' and privilege_type = 'UPDATE'
  ),
  'criterion 8: authenticated has no UPDATE on any claims column'
);

-- ---------------------------------------------------------------------------
-- Criterion 9: integer money and check constraints (as postgres)
-- ---------------------------------------------------------------------------
select ok(
  (select bool_and(data_type = 'integer') and count(*) = 8 from information_schema.columns
    where table_schema = 'public' and table_name in ('bills', 'line_items') and column_name like '%cents'),
  'criterion 9: every money column on bills and line_items is integer'
);
select throws_ok(
  $$ update public.bills set total_cents = -1 where id = 'b1000000-0000-0000-0000-000000000001' $$,
  '23514', null, 'criterion 9: a negative bills.total_cents fails the check');
select throws_ok(
  $$ update public.line_items set total_cents = -1 where id = 'c1000000-0000-0000-0000-000000000001' $$,
  '23514', null, 'criterion 9: a negative line_items.total_cents fails the check');
select throws_ok(
  $$ insert into public.line_items (bill_id, group_position, unit_index, group_size, name, total_cents)
     values ('b1000000-0000-0000-0000-000000000001', 9, 0, 0, 'X', 1) $$,
  '23514', null, 'criterion 9: group_size 0 fails the check');
select throws_ok(
  $$ insert into public.line_items (bill_id, group_position, unit_index, group_size, name, total_cents)
     values ('b1000000-0000-0000-0000-000000000001', 9, 0, 100, 'X', 1) $$,
  '23514', null, 'criterion 9: group_size 100 fails the check');
select throws_ok(
  $$ insert into public.line_items (bill_id, group_position, unit_index, group_size, name, total_cents)
     values ('b1000000-0000-0000-0000-000000000001', 9, 2, 2, 'X', 1) $$,
  '23514', null, 'criterion 9: unit_index >= group_size fails the check');
select throws_ok(
  $$ update public.claims set parts = 0
     where line_item_id = 'c1000000-0000-0000-0000-000000000001' $$,
  '23514', null, 'criterion 9: parts 0 fails the check');
select throws_ok(
  $$ update public.claims set parts = 21
     where line_item_id = 'c1000000-0000-0000-0000-000000000001' $$,
  '23514', null, 'criterion 9: parts 21 fails the check');

-- ---------------------------------------------------------------------------
-- Criterion 10: private helpers
-- ---------------------------------------------------------------------------
select ok(
  (select bool_and(prosecdef and proconfig = array['search_path=""']) and count(*) = 2
     from pg_proc
     where oid in ('private.is_bill_participant(uuid)'::regprocedure,
                   'private.shares_bill_with(uuid)'::regprocedure)),
  'criterion 10: the private helpers are security definer with an empty search_path'
);
select ok(
  not has_function_privilege('anon', 'private.is_bill_participant(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.shares_bill_with(uuid)', 'execute')
  and not has_schema_privilege('anon', 'private', 'usage'),
  'criterion 10: anon cannot use the private schema or execute the helpers'
);
-- config.toml [api] schemas is a file, not database state; it is checked outside pgTAP.

-- ---------------------------------------------------------------------------
-- Criterion 11: foreign-key indexes
-- ---------------------------------------------------------------------------
select has_index('public', 'claims', 'claims_bill_id_idx', 'criterion 11: claims(bill_id) index');
select has_index('public', 'claims', 'claims_user_id_idx', 'criterion 11: claims(user_id) index');
select has_index('public', 'bill_participants', 'bill_participants_user_id_idx', 'criterion 11: bill_participants(user_id) index');
select has_index('public', 'bills', 'bills_host_id_idx', 'criterion 11: bills(host_id) index');
select has_index('public', 'line_items', 'line_items_bill_group_unit_key',
  array['bill_id', 'group_position', 'unit_index'],
  'criterion 11: line_items(bill_id, ...) unique index covers bill_id');

-- ---------------------------------------------------------------------------
-- Criterion 17: the composite FK pins a claim's bill to its row's bill (as postgres)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.claims (bill_id, line_item_id, user_id) values
     ('b2000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000001',
      'a4000000-0000-0000-0000-000000000004') $$,
  '23503', null,
  'criterion 17: a claim on an X row that says bill Y fails with 23503, even as postgres'
);

-- ---------------------------------------------------------------------------
-- Criteria 12, 14: as O (outsider to X, host of Y)
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"a4000000-0000-0000-0000-000000000004","role":"authenticated"}';

select is((select count(*)::int from public.bills where id = 'b1000000-0000-0000-0000-000000000001'), 0,
  'criterion 12: O sees no X bill');
select is((select count(*)::int from public.line_items where bill_id = 'b1000000-0000-0000-0000-000000000001'), 0,
  'criterion 12: O sees no X rows');
select is((select count(*)::int from public.bill_participants where bill_id = 'b1000000-0000-0000-0000-000000000001'), 0,
  'criterion 12: O sees no X participants');
select is((select count(*)::int from public.claims where bill_id = 'b1000000-0000-0000-0000-000000000001'), 0,
  'criterion 12: O sees no X claims');
select results_eq(
  $$ select id from public.bills $$,
  $$ values ('b2000000-0000-0000-0000-000000000002'::uuid) $$,
  'criterion 12: an unfiltered bills select as O returns only Y'
);
select throws_ok(
  $$ insert into public.claims (bill_id, line_item_id, user_id) values
     ('b1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001',
      'a4000000-0000-0000-0000-000000000004') $$,
  '42501', null, 'criterion 14: O cannot insert a claim on an X row'
);
select results_eq(
  $$ select display_name from public.profiles order by display_name $$,
  $$ values ('Oli'::text), ('Quinn'::text) $$,
  'criterion 19: O reads only Oli and Quinn (not Hana, Pat or Rae)'
);

-- ---------------------------------------------------------------------------
-- Criteria 13, 15, 16, 18, 19: as P (participant of X)
-- ---------------------------------------------------------------------------
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';

select results_eq(
  $$ select id from public.bills $$,
  $$ values ('b1000000-0000-0000-0000-000000000001'::uuid) $$,
  'criterion 13: P sees X and only X'
);
select is((select count(*)::int from public.line_items where bill_id = 'b1000000-0000-0000-0000-000000000001'), 4,
  'criterion 13: P sees all 4 of X''s rows');
select results_eq(
  $$ select user_id from public.bill_participants where bill_id = 'b1000000-0000-0000-0000-000000000001' order by user_id $$,
  $$ values ('a1000000-0000-0000-0000-000000000001'::uuid), ('a2000000-0000-0000-0000-000000000002'::uuid),
            ('a3000000-0000-0000-0000-000000000003'::uuid) $$,
  'criterion 13: P sees all three participants of X'
);
select results_eq(
  $$ select line_item_id, user_id from public.claims order by line_item_id, user_id $$,
  $$ values ('c1000000-0000-0000-0000-000000000001'::uuid, 'a1000000-0000-0000-0000-000000000001'::uuid),
            ('c1000000-0000-0000-0000-000000000002'::uuid, 'a1000000-0000-0000-0000-000000000001'::uuid),
            ('c1000000-0000-0000-0000-000000000002'::uuid, 'a2000000-0000-0000-0000-000000000002'::uuid),
            ('c1000000-0000-0000-0000-000000000003'::uuid, 'a2000000-0000-0000-0000-000000000002'::uuid) $$,
  'criterion 13: P sees all of X''s claims, H''s included, and none of Y''s'
);
select is(
  (select (select count(*) from public.line_items where bill_id = 'b2000000-0000-0000-0000-000000000002')
        + (select count(*) from public.bill_participants where bill_id = 'b2000000-0000-0000-0000-000000000002')
        + (select count(*) from public.claims where bill_id = 'b2000000-0000-0000-0000-000000000002'))::int,
  0,
  'criterion 13: P sees no Y rows, participants or claims'
);

select throws_ok(
  $$ insert into public.claims (bill_id, line_item_id, user_id) values
     ('b1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000004',
      'a1000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'criterion 15: P cannot insert a claim for H'
);
select lives_ok(
  $$ delete from public.claims where user_id = 'a1000000-0000-0000-0000-000000000001' $$,
  'criterion 15: P deleting H''s claims does not raise'
);
select is(
  (select count(*)::int from public.claims where user_id = 'a1000000-0000-0000-0000-000000000001'),
  2,
  'criterion 15: ... and affects 0 rows (H still has both claims)'
);
select throws_ok(
  $$ update public.claims set parts = 3 where user_id = 'a2000000-0000-0000-0000-000000000002' $$,
  '42501', null, 'criterion 16: P cannot update parts on P''s own claim (no update grant)'
);

select throws_ok(
  $$ insert into public.bills (host_id, total_cents, join_code)
     values ('a2000000-0000-0000-0000-000000000002', 0, 'aaaaaaaaaaaaaaaaaaaa') $$,
  '42501', null, 'criterion 18: P cannot insert into bills');
select throws_ok(
  $$ update public.bills set total_cents = 1 where id = 'b1000000-0000-0000-0000-000000000001' $$,
  '42501', null, 'criterion 18: P cannot update bills');
select throws_ok(
  $$ delete from public.bills where id = 'b1000000-0000-0000-0000-000000000001' $$,
  '42501', null, 'criterion 18: P cannot delete bills');
select throws_ok(
  $$ insert into public.line_items (bill_id, group_position, unit_index, group_size, name, total_cents)
     values ('b1000000-0000-0000-0000-000000000001', 3, 0, 1, 'Wine', 900) $$,
  '42501', null, 'criterion 18: P cannot insert line_items');
select throws_ok(
  $$ update public.line_items set total_cents = 1 where bill_id = 'b1000000-0000-0000-0000-000000000001' $$,
  '42501', null, 'criterion 18: P cannot update line_items');
select throws_ok(
  $$ delete from public.line_items where bill_id = 'b1000000-0000-0000-0000-000000000001' $$,
  '42501', null, 'criterion 18: P cannot delete line_items');
select throws_ok(
  $$ insert into public.bill_participants (bill_id, user_id)
     values ('b2000000-0000-0000-0000-000000000002', 'a2000000-0000-0000-0000-000000000002') $$,
  '42501', null, 'criterion 18: P cannot insert into bill_participants (no joining Y without a code)');
select throws_ok(
  $$ delete from public.bill_participants where user_id = 'a2000000-0000-0000-0000-000000000002' $$,
  '42501', null, 'P cannot delete bill_participants rows (leaving is out of scope)');

select results_eq(
  $$ select display_name from public.profiles order by display_name $$,
  $$ values ('Hana'::text), ('Pat'::text), ('Rae'::text) $$,
  'criterion 19: P reads Hana, Pat and Rae, and not Oli or Quinn'
);
select lives_ok(
  $$ update public.profiles set display_name = 'Hacked' where id = 'a1000000-0000-0000-0000-000000000001' $$,
  'criterion 19: P updating H''s profile does not raise'
);

-- ---------------------------------------------------------------------------
-- Criteria 18, 19: as H (host of X)
-- ---------------------------------------------------------------------------
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';

select is(
  (select display_name from public.profiles where id = 'a1000000-0000-0000-0000-000000000001'),
  'Hana',
  'criterion 19: ... and H''s display_name is unchanged'
);
select results_eq(
  $$ select display_name from public.profiles order by display_name $$,
  $$ values ('Hana'::text), ('Pat'::text), ('Rae'::text) $$,
  'criterion 19: H reads Hana, Pat and Rae'
);

select throws_ok(
  $$ insert into public.bills (host_id, total_cents, join_code)
     values ('a1000000-0000-0000-0000-000000000001', 0, 'aaaaaaaaaaaaaaaaaaaa') $$,
  '42501', null, 'criterion 18: H cannot insert into bills directly');
select throws_ok(
  $$ update public.bills set total_cents = 1 where id = 'b1000000-0000-0000-0000-000000000001' $$,
  '42501', null, 'criterion 18: H cannot update bills directly');
select throws_ok(
  $$ delete from public.bills where id = 'b1000000-0000-0000-0000-000000000001' $$,
  '42501', null, 'criterion 18: H cannot delete bills directly');
select throws_ok(
  $$ insert into public.line_items (bill_id, group_position, unit_index, group_size, name, total_cents)
     values ('b1000000-0000-0000-0000-000000000001', 3, 0, 1, 'Wine', 900) $$,
  '42501', null, 'criterion 18: H cannot insert line_items directly');
select throws_ok(
  $$ update public.line_items set total_cents = 1 where bill_id = 'b1000000-0000-0000-0000-000000000001' $$,
  '42501', null, 'criterion 18: H cannot update line_items directly');
select throws_ok(
  $$ delete from public.line_items where bill_id = 'b1000000-0000-0000-0000-000000000001' $$,
  '42501', null, 'criterion 18: H cannot delete line_items directly');
select throws_ok(
  $$ insert into public.bill_participants (bill_id, user_id)
     values ('b1000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000004') $$,
  '42501', null, 'criterion 18: H cannot add participants directly');

-- ---------------------------------------------------------------------------
-- Criterion 19: as R (participant with no claims)
-- ---------------------------------------------------------------------------
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a3000000-0000-0000-0000-000000000003","role":"authenticated"}';

select results_eq(
  $$ select display_name from public.profiles order by display_name $$,
  $$ values ('Hana'::text), ('Pat'::text), ('Rae'::text) $$,
  'criterion 19: R reads Hana, Pat and Rae'
);
select is((select count(*)::int from public.claims), 4,
  'criterion 13: R (no claims of their own) still reads all of X''s claims');

-- ---------------------------------------------------------------------------
-- Criterion 19: as Q (in Y with O only)
-- ---------------------------------------------------------------------------
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a5000000-0000-0000-0000-000000000005","role":"authenticated"}';

select results_eq(
  $$ select display_name from public.profiles order by display_name $$,
  $$ values ('Oli'::text), ('Quinn'::text) $$,
  'criterion 19: Q reads only Oli and Quinn'
);
select is((select count(*)::int from public.bills), 1, 'Q sees only bill Y');

-- ---------------------------------------------------------------------------
-- anon
-- ---------------------------------------------------------------------------
reset role;
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

select throws_ok($$ select 1 from public.bills $$, '42501', null, 'criterion 7: anon cannot read bills');
select throws_ok($$ select 1 from public.line_items $$, '42501', null, 'criterion 7: anon cannot read line_items');
select throws_ok($$ select 1 from public.bill_participants $$, '42501', null, 'criterion 7: anon cannot read bill_participants');
select throws_ok($$ select 1 from public.claims $$, '42501', null, 'criterion 7: anon cannot read claims');
select throws_ok(
  $$ insert into public.claims (bill_id, line_item_id, user_id) values
     ('b1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000004',
      'a3000000-0000-0000-0000-000000000003') $$,
  '42501', null, 'criterion 7: anon cannot insert claims');

reset role;
reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- Criterion 19: still no email column
-- ---------------------------------------------------------------------------
select hasnt_column('public', 'profiles', 'email', 'criterion 19: profiles still has no email column');

-- ---------------------------------------------------------------------------
-- Criterion 21: deleting one unit row deletes only that row's claims (as postgres)
-- ---------------------------------------------------------------------------
delete from public.line_items where id = 'c1000000-0000-0000-0000-000000000003';

select results_eq(
  $$ select line_item_id, user_id, parts from public.claims
     where bill_id in ('b1000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000002')
     order by bill_id, line_item_id, user_id $$,
  $$ values ('c1000000-0000-0000-0000-000000000001'::uuid, 'a1000000-0000-0000-0000-000000000001'::uuid, 1),
            ('c1000000-0000-0000-0000-000000000002'::uuid, 'a1000000-0000-0000-0000-000000000001'::uuid, 1),
            ('c1000000-0000-0000-0000-000000000002'::uuid, 'a2000000-0000-0000-0000-000000000002'::uuid, 1),
            ('c2000000-0000-0000-0000-000000000001'::uuid, 'a4000000-0000-0000-0000-000000000004'::uuid, 1) $$,
  'criterion 21: deleting Beer 1/2 removed only P''s claim on it; every other claim is unchanged'
);
select is(
  (select count(*)::int from public.line_items where bill_id = 'b1000000-0000-0000-0000-000000000001'),
  3,
  'criterion 21: the other three X rows remain'
);

-- ---------------------------------------------------------------------------
-- Criterion 20: deleting H's auth user cascades through X (as postgres)
-- ---------------------------------------------------------------------------
delete from auth.users where id = 'a1000000-0000-0000-0000-000000000001';

select is((select count(*)::int from public.bills where id = 'b1000000-0000-0000-0000-000000000001'), 0,
  'criterion 20: deleting H removes bill X');
select is((select count(*)::int from public.line_items where bill_id = 'b1000000-0000-0000-0000-000000000001'), 0,
  'criterion 20: ... and X''s rows');
select is((select count(*)::int from public.bill_participants where bill_id = 'b1000000-0000-0000-0000-000000000001'), 0,
  'criterion 20: ... and X''s participants');
select is((select count(*)::int from public.claims where bill_id = 'b1000000-0000-0000-0000-000000000001'), 0,
  'criterion 20: ... and X''s claims');
select is(
  (select (select count(*) from public.bills where id = 'b2000000-0000-0000-0000-000000000002')
        + (select count(*) from public.claims where bill_id = 'b2000000-0000-0000-0000-000000000002'))::int,
  2,
  'criterion 20: bill Y and its claim are untouched'
);

select * from finish();

rollback;
