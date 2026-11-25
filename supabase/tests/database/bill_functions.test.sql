-- pgTAP tests for create_bill, join_bill, rotate_join_code, set_claim and the shared row
-- validation (spec 2026-11-20-m1b-m2-share-and-claim.md, Task 3, criteria 22-34).
--
-- Users: H a1... 'Hana' (host), P a2... 'Pat' (joins X), O a3... 'Oli' (outsider, never in X),
--        J a4... 'Jo' (joins X later; criteria 27 and 32 use J as "the joiner" so O stays an
--        outsider for criteria 29, 31 and 33).
-- Ids returned by the functions are kept in transaction-local settings (test.*), which every
-- role can read with current_setting().

begin;

create extension if not exists pgtap with schema extensions;

select plan(95);

insert into auth.users (id, email, raw_user_meta_data) values
  ('a1000000-0000-0000-0000-000000000001', 'h@test.local', '{"full_name":"Hana"}'::jsonb),
  ('a2000000-0000-0000-0000-000000000002', 'p@test.local', '{"full_name":"Pat"}'::jsonb),
  ('a3000000-0000-0000-0000-000000000003', 'o@test.local', '{"full_name":"Oli"}'::jsonb),
  ('a4000000-0000-0000-0000-000000000004', 'j@test.local', '{"full_name":"Jo"}'::jsonb);

-- Criterion 23's bill: Burger 1500, Fries 600, Beer x2 700/700; tax 280, tip 700, total 4480.
do $do$ begin perform set_config('test.rows', $json$[
  {"name":"Burger","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":1500},
  {"name":"Fries","note":null,"group_position":1,"unit_index":0,"group_size":1,"total_cents":600},
  {"name":"Beer","note":null,"group_position":2,"unit_index":0,"group_size":2,"total_cents":700},
  {"name":"Beer","note":null,"group_position":2,"unit_index":1,"group_size":2,"total_cents":700}
]$json$, true); end $do$;

-- ---------------------------------------------------------------------------
-- Criterion 22, 26, 34: function shape and execute privileges
-- ---------------------------------------------------------------------------
select ok(
  (select bool_and(proconfig = array['search_path=""']) and count(*) = 6
     from pg_proc
     where oid in ('public.create_bill(jsonb,integer,integer,integer,integer,integer,integer,integer)'::regprocedure,
                   'public.join_bill(text)'::regprocedure,
                   'public.rotate_join_code(uuid)'::regprocedure,
                   'public.set_claim(uuid,boolean)'::regprocedure,
                   'private.validate_bill_rows(jsonb,boolean,integer,integer,integer,integer,integer,integer,integer)'::regprocedure,
                   'private.jsonb_int_between(jsonb,bigint,bigint)'::regprocedure)),
  'criterion 22: every Task 3 function has search_path set to empty'
);

select ok(
  (select bool_and(prosecdef) from pg_proc
     where oid in ('public.create_bill(jsonb,integer,integer,integer,integer,integer,integer,integer)'::regprocedure,
                   'public.join_bill(text)'::regprocedure,
                   'public.rotate_join_code(uuid)'::regprocedure)),
  'criterion 22: create_bill, join_bill and rotate_join_code are security definer'
);

select ok(
  not (select prosecdef from pg_proc where oid = 'public.set_claim(uuid,boolean)'::regprocedure),
  'criterion 22: set_claim is security invoker'
);

select ok(
  has_function_privilege('authenticated', 'public.create_bill(jsonb,integer,integer,integer,integer,integer,integer,integer)', 'execute')
  and has_function_privilege('authenticated', 'public.join_bill(text)', 'execute')
  and has_function_privilege('authenticated', 'public.rotate_join_code(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.set_claim(uuid,boolean)', 'execute'),
  'authenticated can execute the four public functions'
);

select ok(
  not has_function_privilege('anon', 'public.create_bill(jsonb,integer,integer,integer,integer,integer,integer,integer)', 'execute')
  and not has_function_privilege('anon', 'public.join_bill(text)', 'execute')
  and not has_function_privilege('anon', 'public.rotate_join_code(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.set_claim(uuid,boolean)', 'execute'),
  'anon cannot execute the four public functions'
);

select ok(
  not has_function_privilege('authenticated', 'private.validate_bill_rows(jsonb,boolean,integer,integer,integer,integer,integer,integer,integer)', 'execute')
  and not has_function_privilege('anon', 'private.validate_bill_rows(jsonb,boolean,integer,integer,integer,integer,integer,integer,integer)', 'execute')
  and not has_function_privilege('authenticated', 'private.jsonb_int_between(jsonb,bigint,bigint)', 'execute')
  and not has_function_privilege('anon', 'private.jsonb_int_between(jsonb,bigint,bigint)', 'execute'),
  'clients cannot execute the private validation helpers'
);

select ok(
  not exists (
    select 1 from unnest((select proargnames from pg_proc
      where oid = 'public.create_bill(jsonb,integer,integer,integer,integer,integer,integer,integer)'::regprocedure)) as a
    where a ilike '%host%'
  ),
  'criterion 26: create_bill has no host parameter'
);

select ok(
  (select bool_and(position('email' in lower(prosrc)) = 0) from pg_proc
     where oid in ('public.create_bill(jsonb,integer,integer,integer,integer,integer,integer,integer)'::regprocedure,
                   'public.join_bill(text)'::regprocedure,
                   'public.rotate_join_code(uuid)'::regprocedure,
                   'public.set_claim(uuid,boolean)'::regprocedure,
                   'private.validate_bill_rows(jsonb,boolean,integer,integer,integer,integer,integer,integer,integer)'::regprocedure)),
  'criterion 34: no function body references email'
);

-- ---------------------------------------------------------------------------
-- Criterion 22: anon, and authenticated with no sub, get 42501
-- ---------------------------------------------------------------------------
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

select throws_ok($$ select * from public.create_bill(current_setting('test.rows')::jsonb, null, 280, 0, 700, 0, 0, 4480) $$,
  '42501', null, 'criterion 22: anon cannot call create_bill');
select throws_ok($$ select public.join_bill('0123456789abcdef0123') $$,
  '42501', null, 'criterion 22: anon cannot call join_bill');
select throws_ok($$ select public.rotate_join_code(gen_random_uuid()) $$,
  '42501', null, 'criterion 22: anon cannot call rotate_join_code');
select throws_ok($$ select public.set_claim(gen_random_uuid(), true) $$,
  '42501', null, 'criterion 22: anon cannot call set_claim');

reset role;
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated"}';

select throws_ok($$ select * from public.create_bill(current_setting('test.rows')::jsonb, null, 280, 0, 700, 0, 0, 4480) $$,
  '42501', 'not_allowed', 'criterion 22: create_bill without a sub raises 42501');
select throws_ok($$ select public.join_bill('0123456789abcdef0123') $$,
  '42501', 'not_allowed', 'criterion 22: join_bill without a sub raises 42501');
select throws_ok($$ select public.rotate_join_code(gen_random_uuid()) $$,
  '42501', 'not_allowed', 'criterion 22: rotate_join_code without a sub raises 42501');
select throws_ok($$ select public.set_claim(gen_random_uuid(), true) $$,
  '42501', 'not_allowed', 'criterion 22: set_claim without a sub raises 42501');

-- ---------------------------------------------------------------------------
-- Criterion 23: create_bill as H
-- ---------------------------------------------------------------------------
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';

do $$
declare r record;
begin
  select * into r from public.create_bill(current_setting('test.rows')::jsonb, null, 280, 0, 700, 0, 0, 4480);
  perform set_config('test.x_id', r.bill_id::text, true);
  perform set_config('test.x_code', r.join_code, true);
end $$;

select ok(current_setting('test.x_id')::uuid is not null, 'criterion 23: create_bill returns a bill id');
select matches(current_setting('test.x_code'), '^[0-9a-f]{20}$', 'criterion 23: the join code is 20 lowercase hex chars');

select results_eq(
  $$ select host_id, subtotal_cents, tax_cents, fees_cents, tip_cents, subtotal_discount_cents, total_discount_cents, total_cents, join_code, edited_at
     from public.bills where id = current_setting('test.x_id')::uuid $$,
  $$ values ('a1000000-0000-0000-0000-000000000001'::uuid, null::integer, 280, 0, 700, 0, 0, 4480,
             current_setting('test.x_code'), null::timestamptz) $$,
  'criterion 23: host_id is H and the money columns are stored as given'
);

select results_eq(
  $$ select group_position, unit_index, group_size, name, note, total_cents
     from public.line_items where bill_id = current_setting('test.x_id')::uuid
     order by group_position, unit_index $$,
  $$ values (0, 0, 1, 'Burger'::text, null::text, 1500), (1, 0, 1, 'Fries', null, 600),
            (2, 0, 2, 'Beer', null, 700), (2, 1, 2, 'Beer', null, 700) $$,
  'criterion 23: the 4 unit rows have the given group_position, unit_index, size and cents'
);

select results_eq(
  $$ select user_id from public.bill_participants where bill_id = current_setting('test.x_id')::uuid $$,
  $$ values ('a1000000-0000-0000-0000-000000000001'::uuid) $$,
  'criterion 23: H is the only participant'
);

select lives_ok(
  $$ select * from public.create_bill(current_setting('test.rows')::jsonb, null, 280, 0, 700, 0, 0, 4481) $$,
  'criterion 23: the total check passes at +1 cent'
);
select lives_ok(
  $$ select * from public.create_bill(current_setting('test.rows')::jsonb, null, 280, 0, 700, 0, 0, 4479) $$,
  'criterion 23: the total check passes at -1 cent'
);
select lives_ok(
  $$ select * from public.create_bill(
       (select jsonb_agg(jsonb_build_object('name', 'Item', 'note', null, 'group_position', g,
                                            'unit_index', 0, 'group_size', 1, 'total_cents', 1))
        from generate_series(0, 499) as g),
       null, 0, 0, 0, 0, 0, 500) $$,
  'criterion 25 boundary: 500 rows are accepted'
);

-- Names are trimmed, blank notes become null, other notes are kept; discount and fees count.
do $$
declare r record;
begin
  select * into r from public.create_bill(
    $j$[{"name":"  Nachos ","note":"   ","group_position":0,"unit_index":0,"group_size":1,"total_cents":900},
        {"name":"Soda","note":"no ice","group_position":1,"unit_index":0,"group_size":1,"total_cents":300}]$j$::jsonb,
    1200, 100, 50, 0, 0, 200, 1150);
  perform set_config('test.n_id', r.bill_id::text, true);
end $$;

select results_eq(
  $$ select name, note from public.line_items where bill_id = current_setting('test.n_id')::uuid
     order by group_position $$,
  $$ values ('Nachos'::text, null::text), ('Soda', 'no ice') $$,
  'create_bill trims names, stores a blank note as null and keeps other notes'
);

-- ---------------------------------------------------------------------------
-- Separate subtotal and total discounts (coordinator decision 2026-11-21). The DB runs the
-- same two checks as checkTotals in lib/receiptText.ts, each with a 1 cent tolerance.
-- Arguments: rows, subtotal, tax, fees, tip, subtotal_discount, total_discount, total.
-- ---------------------------------------------------------------------------
select hasnt_column('public', 'bills', 'discount_cents', 'bills no longer has a single discount_cents column');
select ok(
  to_regprocedure('public.create_bill(jsonb,integer,integer,integer,integer,integer,integer)') is null,
  'the old 7-argument create_bill is gone'
);

do $$
declare r record;
begin
  -- items 3500 - 500 = subtotal 3000; 3000 + 280 + 700 - 100 = 3880.
  select * into r from public.create_bill(current_setting('test.rows')::jsonb, 3000, 280, 0, 700, 500, 100, 3880);
  perform set_config('test.d_id', r.bill_id::text, true);
end $$;

select results_eq(
  $$ select subtotal_cents, subtotal_discount_cents, total_discount_cents, total_cents
     from public.bills where id = current_setting('test.d_id')::uuid $$,
  $$ values (3000, 500, 100, 3880) $$,
  'both discounts are stored separately'
);
select lives_ok(
  $$ select * from public.create_bill(current_setting('test.rows')::jsonb, 3501, 280, 0, 700, 0, 0, 4482) $$,
  '1 cent + 1 cent: items 1 cent under the subtotal and subtotal 1 cent under the total is accepted (as the form does)'
);
select throws_ok(
  $$ select * from public.create_bill(current_setting('test.rows')::jsonb, 3502, 280, 0, 700, 0, 0, 4482) $$,
  '22023', 'invalid_bill', 'items 2 cents off the subtotal is rejected even when the total matches the subtotal'
);
select throws_ok(
  $$ select * from public.create_bill(current_setting('test.rows')::jsonb, 3500, 280, 0, 700, 0, 0, 4482) $$,
  '22023', 'invalid_bill', 'subtotal 2 cents off the total is rejected'
);
select throws_ok(
  $$ select * from public.create_bill(current_setting('test.rows')::jsonb, 3000, 280, 0, 700, 0, 500, 3480) $$,
  '22023', 'invalid_bill', 'a discount stored on the wrong side of the subtotal fails the items-vs-subtotal check'
);
select lives_ok(
  $$ select * from public.create_bill(current_setting('test.rows')::jsonb, null, 280, 0, 700, 500, 100, 3880) $$,
  'with no subtotal, items - both discounts + tax + fees + tip = total is accepted'
);
select throws_ok(
  $$ select * from public.create_bill(current_setting('test.rows')::jsonb, null, 280, 0, 700, null, 0, 4480) $$,
  '22023', 'invalid_bill', 'a null subtotal discount is rejected'
);
select throws_ok(
  $$ select * from public.create_bill(current_setting('test.rows')::jsonb, null, 280, 0, 700, 0, null, 4480) $$,
  '22023', 'invalid_bill', 'a null total discount is rejected'
);

-- ---------------------------------------------------------------------------
-- Criterion 25: invalid input raises 22023 and leaves no rows
-- ---------------------------------------------------------------------------
do $do$ begin perform set_config('test.h_bills_before', (select count(*)::text from public.bills), true); end $do$;

select throws_ok($$ select * from public.create_bill('[]'::jsonb, null, 0, 0, 0, 0, 0, 0) $$,
  '22023', 'invalid_bill', 'criterion 25: 0 rows');
select throws_ok(
  $$ select * from public.create_bill(
       (select jsonb_agg(jsonb_build_object('name', 'Item', 'note', null, 'group_position', g,
                                            'unit_index', 0, 'group_size', 1, 'total_cents', 1))
        from generate_series(0, 500) as g),
       null, 0, 0, 0, 0, 0, 501) $$,
  '22023', 'invalid_bill', 'criterion 25: 501 rows');
select throws_ok(
  $$ select * from public.create_bill(
       jsonb_set(current_setting('test.rows')::jsonb, '{0,id}', '"c9000000-0000-0000-0000-000000000009"'),
       null, 280, 0, 700, 0, 0, 4480) $$,
  '22023', 'invalid_bill', 'criterion 25: a row with an id');
select throws_ok(
  $$ select * from public.create_bill(
       '[{"name":"A","note":null,"group_position":0,"unit_index":0,"group_size":0,"total_cents":100}]'::jsonb,
       null, 0, 0, 0, 0, 0, 100) $$,
  '22023', 'invalid_bill', 'criterion 25: group_size 0');
select throws_ok(
  $$ select * from public.create_bill(
       jsonb_set(current_setting('test.rows')::jsonb, '{3,unit_index}', '2'),
       null, 280, 0, 700, 0, 0, 4480) $$,
  '22023', 'invalid_bill', 'criterion 25: a group whose unit_index values are {0, 2}');
select throws_ok(
  $$ select * from public.create_bill(
       jsonb_set(current_setting('test.rows')::jsonb, '{3,unit_index}', '0'),
       null, 280, 0, 700, 0, 0, 4480) $$,
  '22023', 'invalid_bill', 'criterion 25: a group with a duplicate unit_index');
select throws_ok(
  $$ select * from public.create_bill(
       jsonb_set(current_setting('test.rows')::jsonb, '{3,name}', '"Lager"'),
       null, 280, 0, 700, 0, 0, 4480) $$,
  '22023', 'invalid_bill', 'criterion 25: a group whose rows have different names');
select throws_ok(
  $$ select * from public.create_bill(
       jsonb_set(jsonb_set(current_setting('test.rows')::jsonb, '{2,group_size}', '3'), '{3,group_size}', '3'),
       null, 280, 0, 700, 0, 0, 4480) $$,
  '22023', 'invalid_bill', 'criterion 25: a group size that differs from the row count');
select throws_ok(
  $$ select * from public.create_bill(
       '[{"name":"A","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":100},
         {"name":"B","note":null,"group_position":2,"unit_index":0,"group_size":1,"total_cents":100}]'::jsonb,
       null, 0, 0, 0, 0, 0, 200) $$,
  '22023', 'invalid_bill', 'criterion 25: group_position {0, 2}');
select throws_ok(
  $$ select * from public.create_bill(
       jsonb_set(current_setting('test.rows')::jsonb, '{0,total_cents}', '-1'),
       null, 280, 0, 700, 0, 0, 2979) $$,
  '22023', 'invalid_bill', 'criterion 25: a row total_cents of -1');
select throws_ok(
  $$ select * from public.create_bill(
       jsonb_set(current_setting('test.rows')::jsonb, '{0,total_cents}', '12.5'),
       null, 280, 0, 700, 0, 0, 2993) $$,
  '22023', 'invalid_bill', 'criterion 25: a row total_cents of 12.5');
select throws_ok(
  $$ select * from public.create_bill(
       jsonb_set(current_setting('test.rows')::jsonb, '{0,total_cents}', '"1500"'),
       null, 280, 0, 700, 0, 0, 4480) $$,
  '22023', 'invalid_bill', 'criterion 25: a row total_cents given as the string "1500"');
select throws_ok(
  $$ select * from public.create_bill(
       jsonb_set(current_setting('test.rows')::jsonb, '{0,name}', '"   "'),
       null, 280, 0, 700, 0, 0, 4480) $$,
  '22023', 'invalid_bill', 'criterion 25: a blank name');
select throws_ok(
  $$ select * from public.create_bill(
       jsonb_set(current_setting('test.rows')::jsonb, '{0,name}', to_jsonb(repeat('n', 101))),
       null, 280, 0, 700, 0, 0, 4480) $$,
  '22023', 'invalid_bill', 'criterion 25: a 101-char name');
select throws_ok(
  $$ select * from public.create_bill(
       jsonb_set(current_setting('test.rows')::jsonb, '{0,note}', to_jsonb(repeat('n', 201))),
       null, 280, 0, 700, 0, 0, 4480) $$,
  '22023', 'invalid_bill', 'criterion 25: a 201-char note');
select throws_ok(
  $$ select * from public.create_bill(current_setting('test.rows')::jsonb, null, 280, 0, 700, 0, 0, 4482) $$,
  '22023', 'invalid_bill', 'criterion 25: a total 2 cents off');
select throws_ok(
  $$ select * from public.create_bill(current_setting('test.rows')::jsonb, null, null, 0, 700, 0, 0, 4200) $$,
  '22023', 'invalid_bill', 'criterion 25: a null tax');
select throws_ok(
  $$ select * from public.create_bill(
       jsonb_set(current_setting('test.rows')::jsonb, '{0,host_id}', '"a2000000-0000-0000-0000-000000000002"'),
       null, 280, 0, 700, 0, 0, 4480) $$,
  '22023', 'invalid_bill', 'a row with an unknown key (host_id) is rejected');
select throws_ok(
  $$ select * from public.create_bill('{"name":"A"}'::jsonb, null, 0, 0, 0, 0, 0, 0) $$,
  '22023', 'invalid_bill', 'p_rows that is not an array is rejected');

select is(
  (select count(*)::text from public.bills),
  current_setting('test.h_bills_before'),
  'criterion 25: none of the failed calls left a bill behind'
);

reset role;
select is(
  (select count(*)::int from public.line_items li
     where not exists (select 1 from public.bills b where b.id = li.bill_id)),
  0,
  'criterion 25: no orphaned rows either (checked as postgres)'
);

-- ---------------------------------------------------------------------------
-- Criterion 24: 200 calls give 200 distinct, well-formed codes
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';

do $$
begin
  for i in 1..200 loop
    perform public.create_bill(current_setting('test.rows')::jsonb, null, 280, 0, 700, 0, 0, 4480);
  end loop;
end $$;

select ok(
  (select count(*) = current_setting('test.h_bills_before')::bigint + 200
          and count(distinct join_code) = count(*)
          and bool_and(join_code ~ '^[0-9a-f]{20}$')
     from public.bills),
  'criterion 24: 200 more calls give 200 more distinct, well-formed codes'
);

-- ---------------------------------------------------------------------------
-- Criterion 26: a bill created as P has host_id = P
-- ---------------------------------------------------------------------------
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';

do $$
declare r record;
begin
  select * into r from public.create_bill(current_setting('test.rows')::jsonb, null, 280, 0, 700, 0, 0, 4480);
  perform set_config('test.p_bill', r.bill_id::text, true);
end $$;

select is(
  (select host_id from public.bills where id = current_setting('test.p_bill')::uuid),
  'a2000000-0000-0000-0000-000000000002'::uuid,
  'criterion 26: a bill created as P has host_id = P'
);

-- P joins X (setup for the claim and rotate tests).
select is(
  public.join_bill(current_setting('test.x_code')),
  current_setting('test.x_id')::uuid,
  'P joins X with its code'
);

-- ---------------------------------------------------------------------------
-- Criterion 27: join_bill as a new joiner (J)
-- ---------------------------------------------------------------------------
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a4000000-0000-0000-0000-000000000004","role":"authenticated"}';

select is((select count(*)::int from public.bills), 0, 'before joining, J sees no bills');
select is(
  public.join_bill(current_setting('test.x_code')),
  current_setting('test.x_id')::uuid,
  'criterion 27: join_bill returns X''s id'
);
select results_eq(
  $$ select user_id from public.bill_participants
     where bill_id = current_setting('test.x_id')::uuid order by user_id $$,
  $$ values ('a1000000-0000-0000-0000-000000000001'::uuid), ('a2000000-0000-0000-0000-000000000002'::uuid),
            ('a4000000-0000-0000-0000-000000000004'::uuid) $$,
  'criterion 27: J is now a participant and reads X''s participants'
);
select is(
  public.join_bill(current_setting('test.x_code')),
  current_setting('test.x_id')::uuid,
  'criterion 27: a second join_bill returns the same id'
);
select is(
  (select count(*)::int from public.bill_participants
     where bill_id = current_setting('test.x_id')::uuid
       and user_id = 'a4000000-0000-0000-0000-000000000004'),
  1,
  'criterion 27: the repeat call leaves exactly one participant row for J'
);

-- ---------------------------------------------------------------------------
-- Criterion 32: a joiner can claim right after join_bill
-- ---------------------------------------------------------------------------
do $do$ begin perform set_config('test.burger', (select id::text from public.line_items
  where bill_id = current_setting('test.x_id')::uuid and group_position = 0), true); end $do$;
do $do$ begin perform set_config('test.fries', (select id::text from public.line_items
  where bill_id = current_setting('test.x_id')::uuid and group_position = 1), true); end $do$;

select lives_ok($$ select public.set_claim(current_setting('test.fries')::uuid, true) $$,
  'criterion 32: J can claim Fries right after joining');
select results_eq(
  $$ select user_id, parts from public.claims where line_item_id = current_setting('test.fries')::uuid $$,
  $$ values ('a4000000-0000-0000-0000-000000000004'::uuid, 1) $$,
  'criterion 32: J''s claim on Fries exists with parts 1'
);

-- ---------------------------------------------------------------------------
-- Criterion 28: bad codes all raise the same P0002 'invalid_code', with no change (as O)
-- ---------------------------------------------------------------------------
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a3000000-0000-0000-0000-000000000003","role":"authenticated"}';

select throws_ok($$ select public.join_bill('ffffffffffffffffffff') $$, 'P0002', 'invalid_code',
  'criterion 28: an unknown well-formed code');
select throws_ok($$ select public.join_bill('abc') $$, 'P0002', 'invalid_code',
  'criterion 28: ''abc''');
select throws_ok($$ select public.join_bill(upper(current_setting('test.x_code'))) $$, 'P0002', 'invalid_code',
  'criterion 28: X''s code in uppercase hex');
select throws_ok($$ select public.join_bill(current_setting('test.x_code') || 'a') $$, 'P0002', 'invalid_code',
  'criterion 28: 21 chars');
select throws_ok($$ select public.join_bill('') $$, 'P0002', 'invalid_code',
  'criterion 28: the empty string');
select throws_ok($$ select public.join_bill(null) $$, 'P0002', 'invalid_code',
  'criterion 28: null');
select is((select count(*)::int from public.bills), 0,
  'criterion 28: after the failed joins O is still in no bill');

-- ---------------------------------------------------------------------------
-- Criteria 31, 33: as O (outsider)
-- ---------------------------------------------------------------------------
select throws_ok($$ select public.set_claim(current_setting('test.burger')::uuid, true) $$,
  'P0002', 'not_found', 'criterion 31: O claiming an X row raises P0002 not_found');
select throws_ok($$ select public.set_claim(gen_random_uuid(), true) $$,
  'P0002', 'not_found', 'criterion 31: the same error as a random row id');
select throws_ok($$ select public.rotate_join_code(current_setting('test.x_id')::uuid) $$,
  '42501', 'not_allowed', 'criterion 29/33: O cannot rotate X''s code');
select throws_ok($$ select public.rotate_join_code(gen_random_uuid()) $$,
  '42501', 'not_allowed', 'criterion 33: the same error as a random bill id');

-- ---------------------------------------------------------------------------
-- Criterion 30: set_claim as P
-- ---------------------------------------------------------------------------
-- H claims Burger first, so we can check P's calls never touch H's claim.
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok($$ select public.set_claim(current_setting('test.burger')::uuid, true) $$,
  'H claims Burger');

reset role;
do $do$ begin perform set_config('test.h_claim_created',
  (select created_at::text from public.claims
     where line_item_id = current_setting('test.burger')::uuid
       and user_id = 'a1000000-0000-0000-0000-000000000001'), true); end $do$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';

select lives_ok($$ select public.set_claim(current_setting('test.burger')::uuid, true) $$,
  'criterion 30: P claims Burger');
select results_eq(
  $$ select bill_id, user_id, parts from public.claims
     where line_item_id = current_setting('test.burger')::uuid
       and user_id = 'a2000000-0000-0000-0000-000000000002' $$,
  $$ values (current_setting('test.x_id')::uuid, 'a2000000-0000-0000-0000-000000000002'::uuid, 1) $$,
  'criterion 30: the claim has parts 1, user_id P and bill_id X'
);
select lives_ok($$ select public.set_claim(current_setting('test.burger')::uuid, true) $$,
  'criterion 30: claiming again does not raise');
select is(
  (select count(*)::int from public.claims where line_item_id = current_setting('test.burger')::uuid),
  2,
  'criterion 30: claiming again is a no-op (still H and P only)'
);
select lives_ok($$ select public.set_claim(current_setting('test.burger')::uuid, false) $$,
  'criterion 30: P unclaims Burger');
select results_eq(
  $$ select user_id from public.claims where line_item_id = current_setting('test.burger')::uuid $$,
  $$ values ('a1000000-0000-0000-0000-000000000001'::uuid) $$,
  'criterion 30: P''s claim is gone and H''s remains'
);
select lives_ok($$ select public.set_claim(current_setting('test.burger')::uuid, false) $$,
  'criterion 30: unclaiming again is a no-op');
select results_eq(
  $$ select user_id, parts, created_at::text from public.claims
     where line_item_id = current_setting('test.burger')::uuid $$,
  $$ values ('a1000000-0000-0000-0000-000000000001'::uuid, 1, current_setting('test.h_claim_created')) $$,
  'criterion 30: H''s claim was never changed (same parts and created_at)'
);
select throws_ok($$ select public.set_claim(current_setting('test.burger')::uuid, null) $$,
  '22023', 'invalid_claim', 'set_claim with a null p_claimed raises 22023');
select throws_ok($$ select public.set_claim(gen_random_uuid(), false) $$,
  'P0002', 'not_found', 'set_claim(false) on an unknown row raises P0002 too');

-- ---------------------------------------------------------------------------
-- Criterion 29: rotate_join_code
-- ---------------------------------------------------------------------------
select throws_ok($$ select public.rotate_join_code(current_setting('test.x_id')::uuid) $$,
  '42501', 'not_allowed', 'criterion 29: P (a participant, not the host) cannot rotate');

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';

select throws_ok($$ select public.rotate_join_code(gen_random_uuid()) $$,
  '42501', 'not_allowed', 'criterion 29: H with a random bill id raises 42501');

do $do$ begin perform set_config('test.x_new_code', public.rotate_join_code(current_setting('test.x_id')::uuid), true); end $do$;

select ok(
  current_setting('test.x_new_code') ~ '^[0-9a-f]{20}$'
  and current_setting('test.x_new_code') <> current_setting('test.x_code'),
  'criterion 29: rotate returns a new well-formed code'
);
select is(
  (select join_code from public.bills where id = current_setting('test.x_id')::uuid),
  current_setting('test.x_new_code'),
  'criterion 29: the bill now has the new code'
);

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a3000000-0000-0000-0000-000000000003","role":"authenticated"}';
select throws_ok($$ select public.join_bill(current_setting('test.x_code')) $$,
  'P0002', 'invalid_code', 'criterion 29: the old code no longer works');

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a4000000-0000-0000-0000-000000000004","role":"authenticated"}';
select is(public.join_bill(current_setting('test.x_new_code')), current_setting('test.x_id')::uuid,
  'criterion 29: the new code works');

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is(
  (select count(*)::int from public.bills where id = current_setting('test.x_id')::uuid),
  1,
  'criterion 29: P still reads X after the rotation'
);

reset role;
reset request.jwt.claims;

select * from finish();

rollback;
