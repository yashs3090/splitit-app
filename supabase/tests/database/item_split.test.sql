-- pgTAP tests for set_item_split (spec 2026-11-20-m1b-m2-share-and-claim.md, Task 5,
-- criteria 45-52 and the set_item_split part of criterion 40; A1.2, A2.3).
--
-- Users: H a1... 'Hana' (host of X), P a2... 'Pat', R a5... 'Rae' (participant, no claim on F),
--        O a3... 'Oli' (outsider, host of Y).
-- Row F = Fries on X, claimed by H and P. Burger is also claimed by H and P. Beer unit 0 is
-- claimed by P only.

begin;

create extension if not exists pgtap with schema extensions;

select plan(49);

insert into auth.users (id, email, raw_user_meta_data) values
  ('a1000000-0000-0000-0000-000000000001', 'h@test.local', '{"full_name":"Hana"}'::jsonb),
  ('a2000000-0000-0000-0000-000000000002', 'p@test.local', '{"full_name":"Pat"}'::jsonb),
  ('a3000000-0000-0000-0000-000000000003', 'o@test.local', '{"full_name":"Oli"}'::jsonb),
  ('a5000000-0000-0000-0000-000000000005', 'r@test.local', '{"full_name":"Rae"}'::jsonb);

set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
do $$
declare r record;
begin
  select * into r from public.create_bill($json$[
    {"name":"Burger","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":1500},
    {"name":"Fries","note":null,"group_position":1,"unit_index":0,"group_size":1,"total_cents":600},
    {"name":"Beer","note":null,"group_position":2,"unit_index":0,"group_size":2,"total_cents":700},
    {"name":"Beer","note":null,"group_position":2,"unit_index":1,"group_size":2,"total_cents":700}
  ]$json$::jsonb, null, 280, 0, 700, 0, 0, 4480);
  perform set_config('test.x_id', r.bill_id::text, true);
  perform set_config('test.x_code', r.join_code, true);
end $$;

set local request.jwt.claims = '{"sub":"a3000000-0000-0000-0000-000000000003","role":"authenticated"}';
do $$
declare r record;
begin
  select * into r from public.create_bill(
    '[{"name":"Tea","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":300}]'::jsonb,
    null, 0, 0, 0, 0, 0, 300);
  perform set_config('test.y_id', r.bill_id::text, true);
end $$;
reset role;

do $$ begin
  perform set_config('test.f', (select id::text from public.line_items where bill_id = current_setting('test.x_id')::uuid and name = 'Fries'), true);
  perform set_config('test.burger', (select id::text from public.line_items where bill_id = current_setting('test.x_id')::uuid and name = 'Burger'), true);
  perform set_config('test.beer0', (select id::text from public.line_items where bill_id = current_setting('test.x_id')::uuid and name = 'Beer' and unit_index = 0), true);
  perform set_config('test.tea', (select id::text from public.line_items where bill_id = current_setting('test.y_id')::uuid), true);
end $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.join_bill(current_setting('test.x_code'));
select public.set_claim(current_setting('test.f')::uuid, true);
select public.set_claim(current_setting('test.burger')::uuid, true);
select public.set_claim(current_setting('test.beer0')::uuid, true);
set local request.jwt.claims = '{"sub":"a5000000-0000-0000-0000-000000000005","role":"authenticated"}';
select public.join_bill(current_setting('test.x_code'));
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.set_claim(current_setting('test.f')::uuid, true);
select public.set_claim(current_setting('test.burger')::uuid, true);
reset role;

-- F's claims and every row's split fields, as they start.
create temp table f_before as
  select c.user_id, c.parts from public.claims c where c.line_item_id = current_setting('test.f')::uuid;

-- ---------------------------------------------------------------------------
-- Criterion 52: shape and privileges
-- ---------------------------------------------------------------------------
select ok(
  (select prosecdef and proconfig = array['search_path=""'] from pg_proc
     where oid = 'public.set_item_split(uuid,jsonb)'::regprocedure),
  'criterion 52: set_item_split is security definer with an empty search_path'
);
select ok(
  has_function_privilege('authenticated', 'public.set_item_split(uuid,jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.set_item_split(uuid,jsonb)', 'execute'),
  'criterion 52: authenticated can execute set_item_split; anon cannot'
);
select ok(
  (select prosrc ~* 'from\s+public\.claims\s+as\s+c\s+where\s+c\.line_item_id\s*=\s*p_line_item_id\s+for\s+update'
     from pg_proc where oid = 'public.set_item_split(uuid,jsonb)'::regprocedure),
  'criterion 52: the body locks the row''s claims (for update)'
);
select ok(
  (select position('email' in lower(prosrc)) = 0 from pg_proc
     where oid = 'public.set_item_split(uuid,jsonb)'::regprocedure),
  'set_item_split does not reference email'
);

-- ---------------------------------------------------------------------------
-- 42501 without a user
-- ---------------------------------------------------------------------------
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select throws_ok($$ select public.set_item_split(current_setting('test.f')::uuid, '{}'::jsonb) $$,
  '42501', null, 'anon cannot call set_item_split');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated"}';
select throws_ok($$ select public.set_item_split(current_setting('test.f')::uuid, '{}'::jsonb) $$,
  '42501', 'not_allowed', 'set_item_split without a sub raises 42501');

-- ---------------------------------------------------------------------------
-- Criterion 46: a non-claimer participant gets 42501; a non-participant gets P0002
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"a5000000-0000-0000-0000-000000000005","role":"authenticated"}';
select throws_ok(
  $$ select public.set_item_split(current_setting('test.f')::uuid,
       '{"a1000000-0000-0000-0000-000000000001": 2, "a2000000-0000-0000-0000-000000000002": 1}'::jsonb) $$,
  '42501', 'not_allowed', 'criterion 46: R (participant, not a claimer of F) raises 42501');

set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select throws_ok(
  $$ select public.set_item_split(current_setting('test.beer0')::uuid,
       '{"a2000000-0000-0000-0000-000000000002": 2}'::jsonb) $$,
  '42501', 'not_allowed', 'being the host is not enough: H (not a claimer of Beer 1) raises 42501');

set local request.jwt.claims = '{"sub":"a3000000-0000-0000-0000-000000000003","role":"authenticated"}';
select throws_ok(
  $$ select public.set_item_split(current_setting('test.f')::uuid,
       '{"a1000000-0000-0000-0000-000000000001": 2, "a2000000-0000-0000-0000-000000000002": 1}'::jsonb) $$,
  'P0002', 'not_found', 'criterion 46: O (not a participant) raises P0002');
select throws_ok(
  $$ select public.set_item_split(gen_random_uuid(),
       '{"a1000000-0000-0000-0000-000000000001": 2, "a2000000-0000-0000-0000-000000000002": 1}'::jsonb) $$,
  'P0002', 'not_found', 'criterion 46: O with a random row id gets the same P0002');

set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok(
  $$ select public.set_item_split(gen_random_uuid(), '{"a2000000-0000-0000-0000-000000000002": 2}'::jsonb) $$,
  'P0002', 'not_found', 'P with a random row id raises P0002');
select throws_ok(
  $$ select public.set_item_split(current_setting('test.tea')::uuid, '{"a3000000-0000-0000-0000-000000000003": 2}'::jsonb) $$,
  'P0002', 'not_found', 'P on a row of bill Y (not P''s bill) raises P0002');
select throws_ok(
  $$ select public.set_item_split(null, '{"a2000000-0000-0000-0000-000000000002": 2}'::jsonb) $$,
  'P0002', 'not_found', 'a null row id raises P0002');

-- ---------------------------------------------------------------------------
-- Criterion 47: the key set must be exactly the current claimers
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select public.set_item_split(current_setting('test.f')::uuid,
       '{"a1000000-0000-0000-0000-000000000001": 2, "a2000000-0000-0000-0000-000000000002": 1, "a5000000-0000-0000-0000-000000000005": 1}'::jsonb) $$,
  '22023', 'claimers_changed', 'criterion 47: adding a non-claimer (R) raises 22023 claimers_changed');
reset role;
select is(
  (select count(*)::integer from public.claims
     where line_item_id = current_setting('test.f')::uuid and user_id = 'a5000000-0000-0000-0000-000000000005'),
  0, 'criterion 47: R has no claim on F afterwards'
);
set local role authenticated;
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok(
  $$ select public.set_item_split(current_setting('test.f')::uuid, '{"a2000000-0000-0000-0000-000000000002": 2}'::jsonb) $$,
  '22023', 'claimers_changed', 'criterion 47: omitting a claimer (H) raises 22023 claimers_changed');
select throws_ok(
  $$ select public.set_item_split(current_setting('test.f')::uuid, '{}'::jsonb) $$,
  '22023', 'claimers_changed', 'an empty object raises 22023 claimers_changed');
select throws_ok(
  $$ select public.set_item_split(current_setting('test.f')::uuid,
       '{"a2000000-0000-0000-0000-000000000002": 1, "a3000000-0000-0000-0000-000000000003": 2}'::jsonb) $$,
  '22023', 'claimers_changed', 'swapping a claimer for an outsider (O) raises 22023 claimers_changed');

-- ---------------------------------------------------------------------------
-- Criterion 48: values and keys must be well formed
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select public.set_item_split(current_setting('test.f')::uuid,
       '{"a1000000-0000-0000-0000-000000000001": 0, "a2000000-0000-0000-0000-000000000002": 1}'::jsonb) $$,
  '22023', 'invalid_parts', 'criterion 48: 0 parts raises 22023');
select throws_ok(
  $$ select public.set_item_split(current_setting('test.f')::uuid,
       '{"a1000000-0000-0000-0000-000000000001": 21, "a2000000-0000-0000-0000-000000000002": 1}'::jsonb) $$,
  '22023', 'invalid_parts', 'criterion 48: 21 parts raises 22023');
select throws_ok(
  $$ select public.set_item_split(current_setting('test.f')::uuid,
       '{"a1000000-0000-0000-0000-000000000001": 1.5, "a2000000-0000-0000-0000-000000000002": 1}'::jsonb) $$,
  '22023', 'invalid_parts', 'criterion 48: 1.5 parts raises 22023');
select throws_ok(
  $$ select public.set_item_split(current_setting('test.f')::uuid,
       '{"a1000000-0000-0000-0000-000000000001": "2", "a2000000-0000-0000-0000-000000000002": 1}'::jsonb) $$,
  '22023', 'invalid_parts', 'criterion 48: the string "2" raises 22023');
select throws_ok(
  $$ select public.set_item_split(current_setting('test.f')::uuid,
       '{"hana": 2, "a2000000-0000-0000-0000-000000000002": 1}'::jsonb) $$,
  '22023', 'invalid_parts', 'criterion 48: a non-uuid key raises 22023');
select throws_ok(
  $$ select public.set_item_split(current_setting('test.f')::uuid,
       '{"a1000000-0000-0000-0000-000000000001": null, "a2000000-0000-0000-0000-000000000002": 1}'::jsonb) $$,
  '22023', 'invalid_parts', 'a null value raises 22023');
select throws_ok(
  $$ select public.set_item_split(current_setting('test.f')::uuid, null) $$,
  '22023', 'invalid_parts', 'a null p_parts raises 22023');
select throws_ok(
  $$ select public.set_item_split(current_setting('test.f')::uuid, '[2, 1]'::jsonb) $$,
  '22023', 'invalid_parts', 'an array p_parts raises 22023');
select throws_ok(
  $$ select public.set_item_split(current_setting('test.f')::uuid,
       '{"a1000000-0000-0000-0000-000000000001": 2, "A1000000-0000-0000-0000-000000000001": 3, "a2000000-0000-0000-0000-000000000002": 1}'::jsonb) $$,
  '22023', 'invalid_parts', 'the same uuid spelled twice (different case) raises 22023');
reset role;

-- Criteria 46-48, 50: none of the failed calls changed anything.
select results_eq(
  $$ select user_id, parts from public.claims where line_item_id = current_setting('test.f')::uuid order by 1 $$,
  $$ select * from f_before order by 1 $$,
  'criteria 46-48, 50: after the failed calls F has the same claimers and parts'
);
select is(
  (select count(*)::integer from public.line_items
     where bill_id = current_setting('test.x_id')::uuid and (split_set_by is not null or split_set_at is not null)),
  0, 'criteria 46-48: after the failed calls no row has split_set_by or split_set_at'
);

-- ---------------------------------------------------------------------------
-- Criterion 45, 40, 49, 50: P sets H 2, P 1 on F
-- ---------------------------------------------------------------------------
delete from realtime.messages where topic like 'bill:%';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select lives_ok(
  $$ select public.set_item_split(current_setting('test.f')::uuid,
       '{"a1000000-0000-0000-0000-000000000001": 2, "a2000000-0000-0000-0000-000000000002": 1}'::jsonb) $$,
  'criterion 45: P (a claimer) sets the Fries split for everyone on it'
);
reset role;
select results_eq(
  $$ select user_id::text, parts from public.claims where line_item_id = current_setting('test.f')::uuid order by 1 $$,
  $$ values ('a1000000-0000-0000-0000-000000000001'::text, 2), ('a2000000-0000-0000-0000-000000000002', 1) $$,
  'criterion 45: H has 2 parts and P has 1'
);
select ok(
  (select split_set_by = 'a2000000-0000-0000-0000-000000000002'::uuid and split_set_at is not null
     from public.line_items where id = current_setting('test.f')::uuid),
  'criterion 45: F''s split_set_by is P and split_set_at is set'
);
select is(
  (select count(*)::integer from public.claims where line_item_id = current_setting('test.f')::uuid),
  2, 'criterion 50: F still has exactly 2 claims (nothing inserted or deleted)'
);
select results_eq(
  $$ select user_id::text, parts from public.claims where line_item_id = current_setting('test.burger')::uuid order by 1 $$,
  $$ values ('a1000000-0000-0000-0000-000000000001'::text, 1), ('a2000000-0000-0000-0000-000000000002', 1) $$,
  'criterion 49: H''s and P''s claims on Burger keep their parts'
);
select is(
  (select count(*)::integer from public.line_items
     where bill_id = current_setting('test.x_id')::uuid and id <> current_setting('test.f')::uuid
       and (split_set_by is not null or split_set_at is not null)),
  0, 'criterion 49: no other row (Burger included) has split_set_by or split_set_at'
);
select results_eq(
  $$ select topic, payload - 'id' from realtime.messages where topic like 'bill:%' $$,
  $$ values ('bill:' || current_setting('test.x_id'), '{"t":"claims"}'::jsonb) $$,
  'criterion 40: set_item_split sends one data-free message on bill:<X>'
);

-- Upper-case uuid keys name the same people (the client may send either case).
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok(
  $$ select public.set_item_split(current_setting('test.burger')::uuid,
       '{"A1000000-0000-0000-0000-000000000001": 3, "a2000000-0000-0000-0000-000000000002": 1}'::jsonb) $$,
  'H (a claimer of Burger) can set its split, with an upper-case key'
);
reset role;
select results_eq(
  $$ select user_id::text, parts from public.claims where line_item_id = current_setting('test.burger')::uuid order by 1 $$,
  $$ values ('a1000000-0000-0000-0000-000000000001'::text, 3), ('a2000000-0000-0000-0000-000000000002', 1) $$,
  'Burger is now H 3, P 1; F is unaffected by that call'
);
select results_eq(
  $$ select user_id::text, parts from public.claims where line_item_id = current_setting('test.f')::uuid order by 1 $$,
  $$ values ('a1000000-0000-0000-0000-000000000001'::text, 2), ('a2000000-0000-0000-0000-000000000002', 1) $$,
  'criterion 49: setting Burger''s split doesn''t touch F'
);

-- ---------------------------------------------------------------------------
-- Criterion 51: parts are kept when claimers change (A2.3)
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"a5000000-0000-0000-0000-000000000005","role":"authenticated"}';
select public.set_claim(current_setting('test.f')::uuid, true);
reset role;
select results_eq(
  $$ select user_id::text, parts from public.claims where line_item_id = current_setting('test.f')::uuid order by 1 $$,
  $$ values ('a1000000-0000-0000-0000-000000000001'::text, 2), ('a2000000-0000-0000-0000-000000000002', 1),
            ('a5000000-0000-0000-0000-000000000005', 1) $$,
  'criterion 51: R claims F and gets 1 part; H keeps 2 and P keeps 1'
);
select is(
  (select split_set_by::text from public.line_items where id = current_setting('test.f')::uuid),
  'a2000000-0000-0000-0000-000000000002', 'criterion 51: split_set_by is still P'
);

-- The newcomer makes the old key set stale: P's earlier {H, P} split now fails.
set local role authenticated;
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok(
  $$ select public.set_item_split(current_setting('test.f')::uuid,
       '{"a1000000-0000-0000-0000-000000000001": 2, "a2000000-0000-0000-0000-000000000002": 1}'::jsonb) $$,
  '22023', 'claimers_changed', 'a split built before R joined the row raises claimers_changed');
select public.set_claim(current_setting('test.f')::uuid, false);
reset role;
select results_eq(
  $$ select user_id::text, parts from public.claims where line_item_id = current_setting('test.f')::uuid order by 1 $$,
  $$ values ('a1000000-0000-0000-0000-000000000001'::text, 2), ('a5000000-0000-0000-0000-000000000005', 1) $$,
  'criterion 51: P unclaims; H stays 2 and R stays 1'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"a5000000-0000-0000-0000-000000000005","role":"authenticated"}';
select public.set_claim(current_setting('test.f')::uuid, false);
reset role;
select results_eq(
  $$ select user_id::text, parts from public.claims where line_item_id = current_setting('test.f')::uuid order by 1 $$,
  $$ values ('a1000000-0000-0000-0000-000000000001'::text, 2) $$,
  'criterion 51: R unclaims; H stays 2 and is the only claimer'
);

select ok(
  not exists (
    select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.claims'::regclass and not t.tgisinternal
      -- Writes to parts, not reads: the Activity trigger (bill_events migration) reads parts.
      and p.prosrc ~* '(update\s+public\.claims|set\s+parts|new\.parts\s*:?=)'
  ),
  'criterion 51: no trigger on claims has a function that touches parts'
);
select ok(
  not exists (select 1 from pg_trigger where tgname = 'claims_reset_split')
  and not exists (select 1 from pg_proc where proname ilike '%reset_split%'),
  'criterion 51: there is no claims_reset_split trigger or function'
);

-- "Reset to even" from the sole claimer: every claimer at 1.
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok(
  $$ select public.set_item_split(current_setting('test.f')::uuid, '{"a1000000-0000-0000-0000-000000000001": 1}'::jsonb) $$,
  'reset to even: H sends every claimer (just H) at 1'
);
reset role;
select ok(
  (select c.parts = 1 and li.split_set_by = 'a1000000-0000-0000-0000-000000000001'::uuid
     from public.claims c join public.line_items li on li.id = c.line_item_id
     where c.line_item_id = current_setting('test.f')::uuid),
  'after the reset H has 1 part and split_set_by is H'
);

-- Clients still have no direct update path on claims (A1.2).
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select throws_ok(
  $$ update public.claims set parts = 5 where line_item_id = current_setting('test.f')::uuid $$,
  '42501', null, 'a direct update of parts still fails with 42501'
);
reset role;

select * from finish();
rollback;
