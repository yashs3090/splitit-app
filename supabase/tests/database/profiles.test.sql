-- pgTAP tests for public.profiles: schema, signup trigger, and RLS.
-- Covers spec 2026-11-19-m0-scaffold-auth-deeplinks.md acceptance criteria 6 to 14.
-- Run with `npm test` (supabase test db). Requires the local stack (Docker).
--
-- Users:
--   A 11111111-... no metadata
--   B 22222222-... full_name 'Bob'
--   C 33333333-... full_name of 60 chars (truncated to 50)
--   D 44444444-... full_name of only spaces, no name (stored as null)
--   E 55555555-... name '  Erin  ' only, as some Google payloads have (fallback, trimmed)
--   F 66666666-... full_name 'Frank Full' and name 'Frank N' (full_name wins)
--   G 77777777-... full_name of only spaces and name 'Gina' (blank full_name falls back)

begin;

create extension if not exists pgtap with schema extensions;

select plan(46);

-- ---------------------------------------------------------------------------
-- Schema (criteria 6, 14)
-- ---------------------------------------------------------------------------

select has_table('public', 'profiles', 'public.profiles exists');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.profiles'::regclass),
  'criterion 6: RLS is enabled on public.profiles'
);

select hasnt_column('public', 'profiles', 'email', 'criterion 14: profiles has no email column');

select ok(
  (select prosecdef from pg_proc where oid = 'public.handle_new_user()'::regprocedure),
  'criterion 14: handle_new_user is security definer'
);

select is(
  (select proconfig from pg_proc where oid = 'public.handle_new_user()'::regprocedure),
  array['search_path=""'],
  'criterion 14: handle_new_user has search_path set to empty'
);

select ok(
  position('email' in (select prosrc from pg_proc where oid = 'public.handle_new_user()'::regprocedure)) = 0,
  'criterion 14: handle_new_user body does not reference email'
);

select table_privs_are(
  'public', 'profiles', 'anon', array[]::text[],
  'anon has no privileges on public.profiles'
);

-- M2 review R7: SELECT is column-level (id, display_name), so co-participants see display_name only.
select table_privs_are(
  'public', 'profiles', 'authenticated', array[]::text[],
  'authenticated has no table-level privileges on public.profiles (no insert/delete/update/table-wide select)'
);

select ok(
  has_column_privilege('authenticated', 'public.profiles', 'id', 'SELECT')
  and has_column_privilege('authenticated', 'public.profiles', 'display_name', 'SELECT')
  and not has_column_privilege('authenticated', 'public.profiles', 'created_at', 'SELECT')
  and not has_column_privilege('authenticated', 'public.profiles', 'updated_at', 'SELECT'),
  'authenticated can select id and display_name, not created_at or updated_at (venmo_username: profile_venmo.test.sql)'
);

select ok(
  has_column_privilege('authenticated', 'public.profiles', 'display_name', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.profiles', 'id', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.profiles', 'created_at', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.profiles', 'updated_at', 'UPDATE'),
  'authenticated can update display_name and no other column'
);

select ok(
  not has_function_privilege('anon', 'public.handle_new_user()', 'execute'),
  'anon cannot execute handle_new_user'
);

select ok(
  not has_function_privilege('authenticated', 'public.handle_new_user()', 'execute'),
  'authenticated cannot execute handle_new_user'
);

-- ---------------------------------------------------------------------------
-- Signup trigger (criterion 7)
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, raw_user_meta_data)
values
  ('11111111-1111-1111-1111-111111111111', 'a@test.local', '{}'::jsonb),
  ('22222222-2222-2222-2222-222222222222', 'b@test.local', '{"full_name":"Bob"}'::jsonb),
  ('33333333-3333-3333-3333-333333333333', 'c@test.local',
    jsonb_build_object('full_name', repeat('x', 60))),
  ('44444444-4444-4444-4444-444444444444', 'd@test.local', '{"full_name":"   "}'::jsonb),
  ('55555555-5555-5555-5555-555555555555', 'e@test.local', '{"name":"  Erin  "}'::jsonb),
  ('66666666-6666-6666-6666-666666666666', 'f@test.local',
    '{"full_name":"Frank Full","name":"Frank N"}'::jsonb),
  ('77777777-7777-7777-7777-777777777777', 'g@test.local',
    '{"full_name":"   ","name":"Gina"}'::jsonb);

select is(
  (select count(*)::int from public.profiles where id = '11111111-1111-1111-1111-111111111111'),
  1,
  'criterion 7: inserting user A creates exactly one profile with the same id'
);

select is(
  (select count(*)::int from public.profiles where id = '22222222-2222-2222-2222-222222222222'),
  1,
  'criterion 7: inserting user B creates exactly one profile with the same id'
);

select is(
  (select display_name from public.profiles where id = '11111111-1111-1111-1111-111111111111'),
  null,
  'no full_name metadata gives a null display_name'
);

select is(
  (select display_name from public.profiles where id = '22222222-2222-2222-2222-222222222222'),
  'Bob',
  'full_name metadata is copied into display_name'
);

select is(
  (select char_length(display_name) from public.profiles where id = '33333333-3333-3333-3333-333333333333'),
  50,
  'a long full_name is truncated to 50 characters'
);

select is(
  (select display_name from public.profiles where id = '44444444-4444-4444-4444-444444444444'),
  null,
  'a blank full_name is stored as null (signup does not fail the length check)'
);

select is(
  (select display_name from public.profiles where id = '55555555-5555-5555-5555-555555555555'),
  'Erin',
  'with no full_name, the trimmed name metadata is used'
);

select is(
  (select display_name from public.profiles where id = '66666666-6666-6666-6666-666666666666'),
  'Frank Full',
  'full_name takes priority over name'
);

select is(
  (select display_name from public.profiles where id = '77777777-7777-7777-7777-777777777777'),
  'Gina',
  'a blank full_name falls back to name'
);

-- Pin A's updated_at in the past (bypassing the trigger) so the update test below can see it move.
alter table public.profiles disable trigger profiles_set_updated_at;
update public.profiles
  set updated_at = '2000-01-01T00:00:00Z'
  where id = '11111111-1111-1111-1111-111111111111';
alter table public.profiles enable trigger profiles_set_updated_at;

-- ---------------------------------------------------------------------------
-- As user A (criteria 8 to 13)
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

-- criterion 8
select is(
  (select count(*)::int from public.profiles where id = '11111111-1111-1111-1111-111111111111'),
  1,
  'criterion 8: A can select their own profile'
);

-- criterion 9
select is_empty(
  $$ select id from public.profiles where id = '22222222-2222-2222-2222-222222222222' $$,
  'criterion 9: A selecting B''s profile by id returns 0 rows'
);

select results_eq(
  $$ select id from public.profiles $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid) $$,
  'criterion 9: selecting all profiles as A returns only A''s row'
);

-- criterion 10
select is_empty(
  $$ update public.profiles set display_name = 'hacked'
     where id = '22222222-2222-2222-2222-222222222222' returning id $$,
  'criterion 10: A updating B''s display_name affects 0 rows'
);

-- Own update is allowed (positive control for the update policy).
select isnt_empty(
  $$ update public.profiles set display_name = 'Alice'
     where id = '11111111-1111-1111-1111-111111111111' returning id $$,
  'A can update their own display_name'
);

select throws_ok(
  $$ update public.profiles set display_name = ''
     where id = '11111111-1111-1111-1111-111111111111' $$,
  '23514',
  null,
  'an empty display_name is rejected by the length check'
);

select throws_ok(
  $$ update public.profiles set display_name = repeat('y', 51)
     where id = '11111111-1111-1111-1111-111111111111' $$,
  '23514',
  null,
  'a 51-character display_name is rejected by the length check'
);

select throws_ok(
  $$ update public.profiles set created_at = '1999-01-01T00:00:00Z'
     where id = '11111111-1111-1111-1111-111111111111' $$,
  '42501',
  null,
  'A cannot change their own created_at (column not client-writable)'
);

-- criterion 11
select throws_ok(
  $$ insert into public.profiles (id) values ('22222222-2222-2222-2222-222222222222') $$,
  '42501',
  null,
  'criterion 11: A cannot insert a profile for B'
);

select throws_ok(
  $$ insert into public.profiles (id) values (gen_random_uuid()) $$,
  '42501',
  null,
  'criterion 11: A cannot insert a profile for a random id'
);

select throws_ok(
  $$ insert into public.profiles (id) values ('11111111-1111-1111-1111-111111111111') $$,
  '42501',
  null,
  'criterion 11: A cannot insert a profile for their own id'
);

-- criterion 12 (delete): authenticated has no delete privilege, so it is denied outright.
select throws_ok(
  $$ delete from public.profiles where id = '11111111-1111-1111-1111-111111111111' $$,
  '42501',
  null,
  'criterion 12: A cannot delete their own profile'
);

select throws_ok(
  $$ delete from public.profiles where id = '22222222-2222-2222-2222-222222222222' $$,
  '42501',
  null,
  'criterion 12: A cannot delete B''s profile'
);

-- criterion 13
select throws_ok(
  $$ update public.profiles set id = '22222222-2222-2222-2222-222222222222'
     where id = '11111111-1111-1111-1111-111111111111' $$,
  '42501',
  null,
  'criterion 13: A cannot change their own id to B''s id'
);

select throws_ok(
  $$ update public.profiles set id = gen_random_uuid()
     where id = '11111111-1111-1111-1111-111111111111' $$,
  '42501',
  null,
  'criterion 13: A cannot change their own id to a random id'
);

-- ---------------------------------------------------------------------------
-- As user B: B sees only B, and B's row is untouched by A (criteria 9, 10)
-- ---------------------------------------------------------------------------

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

select results_eq(
  $$ select id, display_name from public.profiles $$,
  $$ values ('22222222-2222-2222-2222-222222222222'::uuid, 'Bob'::text) $$,
  'criterion 10: as B, B''s display_name is unchanged and B sees only their own row'
);

-- ---------------------------------------------------------------------------
-- As anon (criterion 12)
-- ---------------------------------------------------------------------------

reset role;
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

select throws_ok(
  $$ select id from public.profiles $$,
  '42501',
  null,
  'criterion 12: anon cannot read profiles (no select privilege)'
);

select throws_ok(
  $$ update public.profiles set display_name = 'anon'
     where id = '11111111-1111-1111-1111-111111111111' $$,
  '42501',
  null,
  'anon cannot update profiles'
);

select throws_ok(
  $$ insert into public.profiles (id) values (gen_random_uuid()) $$,
  '42501',
  null,
  'anon cannot insert profiles'
);

select throws_ok(
  $$ delete from public.profiles returning id $$,
  '42501',
  null,
  'anon cannot delete profiles'
);

-- ---------------------------------------------------------------------------
-- Back as the test superuser: verify final state (criteria 10, 12, 13)
-- ---------------------------------------------------------------------------

reset role;
reset request.jwt.claims;

select is(
  (select display_name from public.profiles where id = '22222222-2222-2222-2222-222222222222'),
  'Bob',
  'criterion 10: B''s display_name is still Bob (checked as superuser)'
);

select is(
  (select count(*)::int from public.profiles
    where id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222')),
  2,
  'criterion 12: A and B profiles both still exist after delete attempts'
);

select is(
  (select display_name from public.profiles where id = '11111111-1111-1111-1111-111111111111'),
  'Alice',
  'criterion 13: A''s row still has A''s id, with A''s own update applied'
);

select ok(
  (select updated_at > '2000-01-01T00:00:00Z'::timestamptz
     from public.profiles where id = '11111111-1111-1111-1111-111111111111'),
  'updated_at is bumped by the trigger on update'
);

-- Cascade: deleting the auth user removes the profile.
delete from auth.users where id = '44444444-4444-4444-4444-444444444444';

select is_empty(
  $$ select id from public.profiles where id = '44444444-4444-4444-4444-444444444444' $$,
  'deleting an auth user cascades to their profile'
);

select * from finish();

rollback;
