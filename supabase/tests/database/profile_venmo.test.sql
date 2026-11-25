-- pgTAP tests for migration 20261124072017_profile_venmo.sql
-- (spec docs/specs/2026-11-24-profile-venmo.md, Task 1, acceptance criteria 1-14; D2 rows B1-B15).
--
-- Users:
--   A c1... 'Ann' host of bill X. Used for dismiss (criterion 10), then sets 'alice-1' (criterion 6).
--   B c2... 'Ben' joined X. Stays fresh (criterion 12).
--   C c3... 'Cal' shares no bill with anyone.
--   D c4... 'Dee' fresh, sets a username (criterion 11).
--   E c5... 'Eve' writes every D2 boundary row (criterion 2).
--
-- Accepted writes use a top-level data-modifying CTE: `with u as (update ... returning ...) select
-- is(...) from u`. If the update affected 0 rows no assertion is emitted and plan() fails.

begin;

create extension if not exists pgtap with schema extensions;

select plan(68);

insert into auth.users (id, email, raw_user_meta_data) values
  ('c1000000-0000-0000-0000-000000000001', 'a@test.local', '{"full_name":"Ann"}'::jsonb),
  ('c2000000-0000-0000-0000-000000000002', 'b@test.local', '{"full_name":"Ben"}'::jsonb),
  ('c3000000-0000-0000-0000-000000000003', 'c@test.local', '{"full_name":"Cal"}'::jsonb),
  ('c4000000-0000-0000-0000-000000000004', 'd@test.local', '{"full_name":"Dee"}'::jsonb),
  ('c5000000-0000-0000-0000-000000000005', 'e@test.local', '{"full_name":"Eve"}'::jsonb);

-- ---------------------------------------------------------------------------
-- Criterion 1: columns
-- ---------------------------------------------------------------------------
select has_column('public', 'profiles', 'venmo_username', 'c1: profiles has venmo_username');
select col_type_is('public', 'profiles', 'venmo_username', 'text', 'c1: venmo_username is text');
select col_is_null('public', 'profiles', 'venmo_username', 'c1: venmo_username is nullable');
select has_column('public', 'profiles', 'venmo_prompt_dismissed_at',
  'c1: profiles has venmo_prompt_dismissed_at');
select col_type_is('public', 'profiles', 'venmo_prompt_dismissed_at', 'timestamp with time zone',
  'c1: venmo_prompt_dismissed_at is timestamptz');
select col_is_null('public', 'profiles', 'venmo_prompt_dismissed_at',
  'c1: venmo_prompt_dismissed_at is nullable');
-- No defaults, so rows that existed before the migration got null in both columns.
select col_hasnt_default('public', 'profiles', 'venmo_username',
  'c1: venmo_username has no default (existing rows are null)');
select col_hasnt_default('public', 'profiles', 'venmo_prompt_dismissed_at',
  'c1: venmo_prompt_dismissed_at has no default (existing rows are null)');
select is(
  (select count(*)::int from public.profiles
    where id::text like 'c_000000-%'
      and venmo_username is null and venmo_prompt_dismissed_at is null),
  5, 'c1: new profiles start with both columns null');

-- ---------------------------------------------------------------------------
-- Criteria 3-5: grants
-- ---------------------------------------------------------------------------
select ok(
  has_column_privilege('authenticated', 'public.profiles', 'venmo_username', 'SELECT')
  and has_column_privilege('authenticated', 'public.profiles', 'venmo_username', 'UPDATE'),
  'c3: authenticated can select and update venmo_username');

select ok(
  not has_column_privilege('authenticated', 'public.profiles', 'venmo_prompt_dismissed_at',
    'SELECT, INSERT, UPDATE, REFERENCES'),
  'c4: authenticated has no privilege on venmo_prompt_dismissed_at');

select ok(
  not exists (
    select 1 from pg_attribute a
     where a.attrelid = 'public.profiles'::regclass and a.attnum > 0 and not a.attisdropped
       and has_column_privilege('anon', 'public.profiles', a.attname, 'SELECT, INSERT, UPDATE, REFERENCES')),
  'c4: anon has no privilege on any column of profiles');

select table_privs_are('public', 'profiles', 'authenticated', array[]::text[],
  'c4: authenticated still has no table-level privileges on profiles');
select table_privs_are('public', 'profiles', 'anon', array[]::text[],
  'c4: anon still has no table-level privileges on profiles');

select ok(
  has_column_privilege('authenticated', 'public.profiles', 'id', 'SELECT')
  and has_column_privilege('authenticated', 'public.profiles', 'display_name', 'SELECT')
  and not has_column_privilege('authenticated', 'public.profiles', 'created_at', 'SELECT')
  and not has_column_privilege('authenticated', 'public.profiles', 'updated_at', 'SELECT'),
  'c5: existing SELECT grants unchanged (id, display_name; not created_at/updated_at)');

select ok(
  has_column_privilege('authenticated', 'public.profiles', 'display_name', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.profiles', 'id', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.profiles', 'created_at', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.profiles', 'updated_at', 'UPDATE'),
  'c5: existing UPDATE grants unchanged (display_name; not id/created_at/updated_at)');

select ok(
  not exists (
    select 1 from pg_attribute a
     where a.attrelid = 'public.profiles'::regclass and a.attnum > 0 and not a.attisdropped
       and has_column_privilege('authenticated', 'public.profiles', a.attname, 'INSERT')),
  'c5: authenticated has no INSERT on any column (DELETE is covered by table_privs_are)');

-- ---------------------------------------------------------------------------
-- Criterion 14: functions and trigger
-- ---------------------------------------------------------------------------
select ok(
  (select prosecdef and proconfig = array['search_path=""']
     from pg_proc where oid = 'public.venmo_prompt_pending()'::regprocedure),
  'c14: venmo_prompt_pending is security definer with search_path ''''');
select ok(
  (select prosecdef and proconfig = array['search_path=""']
     from pg_proc where oid = 'public.dismiss_venmo_prompt()'::regprocedure),
  'c14: dismiss_venmo_prompt is security definer with search_path ''''');
select ok(
  has_function_privilege('authenticated', 'public.venmo_prompt_pending()', 'execute')
  and not has_function_privilege('anon', 'public.venmo_prompt_pending()', 'execute')
  and not has_function_privilege('public', 'public.venmo_prompt_pending()', 'execute'),
  'c14: venmo_prompt_pending executable by authenticated only (not anon, not public)');
select ok(
  has_function_privilege('authenticated', 'public.dismiss_venmo_prompt()', 'execute')
  and not has_function_privilege('anon', 'public.dismiss_venmo_prompt()', 'execute')
  and not has_function_privilege('public', 'public.dismiss_venmo_prompt()', 'execute'),
  'c14: dismiss_venmo_prompt executable by authenticated only (not anon, not public)');
select has_trigger('public', 'profiles', 'profiles_stamp_venmo_prompt',
  'c14: profiles has the profiles_stamp_venmo_prompt trigger');
select trigger_is('public', 'profiles', 'profiles_stamp_venmo_prompt',
  'private', 'stamp_venmo_prompt', 'c14: the trigger runs private.stamp_venmo_prompt');
select ok(
  not has_function_privilege('public', 'private.stamp_venmo_prompt()', 'execute')
  and not has_function_privilege('anon', 'private.stamp_venmo_prompt()', 'execute')
  and not has_function_privilege('authenticated', 'private.stamp_venmo_prompt()', 'execute'),
  'c14: trigger function execute revoked from public, anon and authenticated');
select is(
  (select proconfig from pg_proc where oid = 'private.stamp_venmo_prompt()'::regprocedure),
  array['search_path=""'],
  'c14: trigger function has search_path set to empty');

-- ---------------------------------------------------------------------------
-- Fixture: A hosts bill X, B joins it (through the real functions). C and D share nothing.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"c1000000-0000-0000-0000-000000000001","role":"authenticated"}';
do $$
declare r record;
begin
  select * into r from public.create_bill(
    '[{"name":"Tea","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":300}]'::jsonb,
    null, 0, 0, 0, 0, 0, 300);
  perform set_config('test.x_code', r.join_code, true);
end $$;
set local request.jwt.claims = '{"sub":"c2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.join_bill(current_setting('test.x_code'));

-- ---------------------------------------------------------------------------
-- Criterion 10: A pending -> dismiss -> not pending; dismiss is idempotent
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"c1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select is(public.venmo_prompt_pending(), true, 'c10: fresh A has the prompt pending');
select public.dismiss_venmo_prompt();
select is(public.venmo_prompt_pending(), false, 'c10: after dismiss, A''s prompt is not pending');

reset role;
select isnt(
  (select venmo_prompt_dismissed_at from public.profiles where id = 'c1000000-0000-0000-0000-000000000001'),
  null, 'c10: dismiss stamped A''s venmo_prompt_dismissed_at');
-- now() is fixed inside a transaction, so pin a distinct first value to see a second call keep it.
update public.profiles set venmo_prompt_dismissed_at = '2001-01-01T00:00:00Z'
 where id = 'c1000000-0000-0000-0000-000000000001';

set local role authenticated;
set local request.jwt.claims = '{"sub":"c1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.dismiss_venmo_prompt();

reset role;
select is(
  (select venmo_prompt_dismissed_at from public.profiles where id = 'c1000000-0000-0000-0000-000000000001'),
  '2001-01-01T00:00:00Z'::timestamptz,
  'c10: a second dismiss keeps the first venmo_prompt_dismissed_at (idempotent)');

-- ---------------------------------------------------------------------------
-- Criterion 12: A's dismiss touched only A's row and only that column
-- ---------------------------------------------------------------------------
select is(
  (select venmo_prompt_dismissed_at from public.profiles where id = 'c2000000-0000-0000-0000-000000000002'),
  null, 'c12: B''s venmo_prompt_dismissed_at is still null after A dismissed');

set local role authenticated;
set local request.jwt.claims = '{"sub":"c2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is(public.venmo_prompt_pending(), true, 'c12: B''s prompt is still pending');

reset role;
select ok(
  (select venmo_username is null and display_name = 'Ann'
     from public.profiles where id = 'c1000000-0000-0000-0000-000000000001')
  and (select venmo_username is null and venmo_prompt_dismissed_at is null and display_name = 'Ben'
     from public.profiles where id = 'c2000000-0000-0000-0000-000000000002'),
  'c12: neither function changed venmo_username or display_name (A and B)');

-- ---------------------------------------------------------------------------
-- Criterion 11: setting a username answers the prompt for good (D, fresh)
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"c4000000-0000-0000-0000-000000000004","role":"authenticated"}';

with u as (
  update public.profiles set venmo_username = 'dee-99'
   where id = 'c4000000-0000-0000-0000-000000000004' returning venmo_username
)
select is(u.venmo_username, 'dee-99', 'c11: D sets their own venmo_username') from u;

select is(public.venmo_prompt_pending(), false, 'c11: after setting a username, D''s prompt is not pending');

reset role;
select isnt(
  (select venmo_prompt_dismissed_at from public.profiles where id = 'c4000000-0000-0000-0000-000000000004'),
  null, 'c11: the trigger stamped venmo_prompt_dismissed_at although D has no grant on it');

set local role authenticated;
set local request.jwt.claims = '{"sub":"c4000000-0000-0000-0000-000000000004","role":"authenticated"}';

with u as (
  update public.profiles set venmo_username = null
   where id = 'c4000000-0000-0000-0000-000000000004' returning venmo_username
)
select is(u.venmo_username, null::text, 'c11: D clears their venmo_username') from u;

select is(public.venmo_prompt_pending(), false, 'c11: clearing the username does not bring the prompt back');

-- ---------------------------------------------------------------------------
-- Criterion 2: D2 boundary rows B1-B15, stored as-is, written by E as the owner
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"c5000000-0000-0000-0000-000000000005","role":"authenticated"}';

-- Accepted
with u as (update public.profiles set venmo_username = 'abcde'
            where id = 'c5000000-0000-0000-0000-000000000005' returning venmo_username)
select is(u.venmo_username, 'abcde', 'c2 B2: abcde (5 chars) is accepted') from u;

with u as (update public.profiles set venmo_username = repeat('a', 30)
            where id = 'c5000000-0000-0000-0000-000000000005' returning venmo_username)
select is(u.venmo_username, repeat('a', 30), 'c2 B3: 30 x a is accepted') from u;

with u as (update public.profiles set venmo_username = 'Jane-Doe_99'
            where id = 'c5000000-0000-0000-0000-000000000005' returning venmo_username)
select is(u.venmo_username, 'Jane-Doe_99', 'c2 B5: Jane-Doe_99 is accepted with case kept') from u;

with u as (update public.profiles set venmo_username = '12345'
            where id = 'c5000000-0000-0000-0000-000000000005' returning venmo_username)
select is(u.venmo_username, '12345', 'c2 B6: 12345 (all digits) is accepted') from u;

with u as (update public.profiles set venmo_username = null
            where id = 'c5000000-0000-0000-0000-000000000005' returning venmo_username)
select is(u.venmo_username, null::text, 'c2 B14: null is accepted') from u;

-- Rejected with 23514 (check_violation)
select throws_ok($$ update public.profiles set venmo_username = 'abcd'
  where id = 'c5000000-0000-0000-0000-000000000005' $$,
  '23514', null, 'c2 B1: abcd (4 chars) is rejected');
select throws_ok($$ update public.profiles set venmo_username = repeat('a', 31)
  where id = 'c5000000-0000-0000-0000-000000000005' $$,
  '23514', null, 'c2 B4: 31 x a is rejected');
select throws_ok($$ update public.profiles set venmo_username = 'abc.de'
  where id = 'c5000000-0000-0000-0000-000000000005' $$,
  '23514', null, 'c2 B7: abc.de is rejected');
select throws_ok($$ update public.profiles set venmo_username = 'abc de'
  where id = 'c5000000-0000-0000-0000-000000000005' $$,
  '23514', null, 'c2 B8: abc de is rejected');
select throws_ok($$ update public.profiles set venmo_username = 'josé1'
  where id = 'c5000000-0000-0000-0000-000000000005' $$,
  '23514', null, 'c2 B9: josé1 (non-ASCII letter) is rejected');
select throws_ok($$ update public.profiles set venmo_username = '@abcde'
  where id = 'c5000000-0000-0000-0000-000000000005' $$,
  '23514', null, 'c2 B10: @abcde is rejected (a stored @ is never valid)');
select throws_ok($$ update public.profiles set venmo_username = '  @abcde  '
  where id = 'c5000000-0000-0000-0000-000000000005' $$,
  '23514', null, 'c2 B11: "  @abcde  " is rejected');
select throws_ok($$ update public.profiles set venmo_username = '@@abcde'
  where id = 'c5000000-0000-0000-0000-000000000005' $$,
  '23514', null, 'c2 B12: @@abcde is rejected');
select throws_ok($$ update public.profiles set venmo_username = '@abcd'
  where id = 'c5000000-0000-0000-0000-000000000005' $$,
  '23514', null, 'c2 B13: @abcd is rejected');
select throws_ok($$ update public.profiles set venmo_username = ''
  where id = 'c5000000-0000-0000-0000-000000000005' $$,
  '23514', null, 'c2 B14: empty string is rejected');
select throws_ok($$ update public.profiles set venmo_username = '   '
  where id = 'c5000000-0000-0000-0000-000000000005' $$,
  '23514', null, 'c2 B14: "   " (spaces only) is rejected');
select throws_ok($$ update public.profiles set venmo_username = '@'
  where id = 'c5000000-0000-0000-0000-000000000005' $$,
  '23514', null, 'c2 B14: "@" is rejected');
select throws_ok($$ update public.profiles set venmo_username = E'abcde\n'
  where id = 'c5000000-0000-0000-0000-000000000005' $$,
  '23514', null, 'c2 B15: abcde plus a trailing newline is rejected');

-- ---------------------------------------------------------------------------
-- Criteria 6-8: A writes own row only; no access to venmo_prompt_dismissed_at
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"c1000000-0000-0000-0000-000000000001","role":"authenticated"}';

with u as (update public.profiles set venmo_username = 'alice-1'
            where id = 'c1000000-0000-0000-0000-000000000001' returning venmo_username)
select is(u.venmo_username, 'alice-1', 'c6: A''s own update returns A''s row with the new value') from u;

select is_empty(
  $$ update public.profiles set venmo_username = 'hacked'
     where id = 'c2000000-0000-0000-0000-000000000002' returning id $$,
  'c7: A updating B''s venmo_username affects 0 rows');

select throws_ok(
  $$ select venmo_prompt_dismissed_at from public.profiles $$,
  '42501', null, 'c8: A cannot select venmo_prompt_dismissed_at');
select throws_ok(
  $$ update public.profiles set venmo_prompt_dismissed_at = now()
     where id = 'c1000000-0000-0000-0000-000000000001' $$,
  '42501', null, 'c8: A cannot update venmo_prompt_dismissed_at on their own row');

reset role;
select is(
  (select venmo_username from public.profiles where id = 'c1000000-0000-0000-0000-000000000001'),
  'alice-1', 'c6: A''s value is stored (checked as superuser)');
select is(
  (select venmo_username from public.profiles where id = 'c2000000-0000-0000-0000-000000000002'),
  null, 'c7: B''s venmo_username is unchanged (checked as superuser)');

-- ---------------------------------------------------------------------------
-- Criterion 9: anon gets 42501 everywhere
-- ---------------------------------------------------------------------------
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

select throws_ok($$ select venmo_username from public.profiles $$,
  '42501', null, 'c9: anon cannot select venmo_username');
select throws_ok($$ update public.profiles set venmo_username = 'anon1'
  where id = 'c1000000-0000-0000-0000-000000000001' $$,
  '42501', null, 'c9: anon cannot update venmo_username');
select throws_ok($$ select public.venmo_prompt_pending() $$,
  '42501', null, 'c9: anon cannot execute venmo_prompt_pending');
select throws_ok($$ select public.dismiss_venmo_prompt() $$,
  '42501', null, 'c9: anon cannot execute dismiss_venmo_prompt');

-- ---------------------------------------------------------------------------
-- Criterion 13: co-participant read
-- ---------------------------------------------------------------------------
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"c2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is(
  (select venmo_username from public.profiles where id = 'c1000000-0000-0000-0000-000000000001'),
  'alice-1', 'c13: B (joined A''s bill) reads A''s venmo_username');

set local request.jwt.claims = '{"sub":"c3000000-0000-0000-0000-000000000003","role":"authenticated"}';
select is_empty(
  $$ select venmo_username from public.profiles where id = 'c1000000-0000-0000-0000-000000000001' $$,
  'c13: C (no shared bill) gets 0 rows for A');

set local request.jwt.claims = '{"sub":"c1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select is(
  (select venmo_username from public.profiles where id = 'c1000000-0000-0000-0000-000000000001'),
  'alice-1', 'c13: A reads their own venmo_username');

reset role;

select * from finish();

rollback;
