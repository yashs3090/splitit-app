-- pgTAP tests for migration 20261128100019_username_required.sql
-- (spec docs/specs/2026-11-28-usernames.md, Amendment A1: username is mandatory).
--
-- Fixture users (all rolled back at the end):
--   5b0000NN-...  sign-ups whose metadata can't give a usable handle, and one 60-character name
--   5b0001NN-...  20 sign-ups all named 'Yash Saraiya'
--   5b0002NN-...  direct profile inserts (the demo seed pattern, service_role, an explicit value)
--   5b00ffff-...  9,999 sign-ups whose profiles are re-inserted holding every free 'user<n>' name,
--                 so the uuid fallback must run
--
-- Updated for Amendment A2 (20261128111430_username_immutable.sql): a username never changes, so
-- nothing here renames one. Handles a real user may hold can't be freed any more; a check that
-- expects a base exactly (pg_temp.base_or_numbered) accepts base + number when a non-fixture user
-- already holds the base. Fixture handles that must be exact are set by INSERT, and values the
-- test invents carry a random tag. The local DB may hold real users: every count is filtered to
-- fixture ids. Rule V is checked by pg_temp.is_valid, whose reserved list is read from the
-- profiles_username_reserved constraint itself.

begin;

create extension if not exists pgtap with schema extensions;

select plan(55);

-- Rule V, with the reserved words taken from the live constraint.
create temp table un_reserved as
select m[1] as word
  from pg_constraint as c,
       regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''::text', 'g') as m
 where c.conrelid = 'public.profiles'::regclass and c.conname = 'profiles_username_reserved';

create function pg_temp.is_valid(u text) returns boolean
language sql stable as $$
  select u is not null
     and char_length(u) between 3 and 20
     and u ~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$'
     and not exists (select 1 from un_reserved as r where r.word = u)
$$;

-- True if a non-fixture user holds the handle (it can't be freed: usernames never change, A2).
create function pg_temp.held(b text) returns boolean
language sql stable as $$
  select exists (select 1 from public.profiles as p
                  where lower(p.username) = b and p.id::text not like '5b%')
$$;

-- u is exactly the base, or, if a real user already holds the base, the base cut so a 1-4 digit
-- number fits in 20, plus that number (withNumberSuffix's rule). Bases here are [a-z_] only.
create function pg_temp.base_or_numbered(u text, b text) returns boolean
language sql stable as $$
  select case
    when not pg_temp.held(b) then u = b
    else pg_temp.is_valid(u) and u ~ '[^0-9][0-9]{1,4}$'
         and regexp_replace(u, '[0-9]+$', '')
             = rtrim(left(b, 20 - char_length(substring(u from '[0-9]+$'))), '_')
  end
$$;

-- Random tags nobody else holds: an exact explicit handle, and a 20-character base to take.
select set_config('test.keep', 'keep' || left(md5(random()::text || clock_timestamp()::text), 10), true)
  is not null as keep_set;
select set_config('test.base20', 'fx' || left(md5(random()::text || clock_timestamp()::text), 18), true)
  is not null as base20_set;

-- ---------------------------------------------------------------------------
-- Shape (A1.1, A1.2, A1.3)
-- ---------------------------------------------------------------------------
select col_not_null('public', 'profiles', 'username', 'A1.1: profiles.username is NOT NULL');
select col_hasnt_default('public', 'profiles', 'username',
  'A1.3: username has no column default (the BEFORE INSERT trigger fills it)');
select has_trigger('public', 'profiles', 'profiles_fill_username',
  'A1.3: profiles has the profiles_fill_username trigger');
select ok(
  (select prosecdef and proconfig = array['search_path=""']
     from pg_proc where oid = 'private.assign_username(text)'::regprocedure),
  'A1.2: private.assign_username is security definer with search_path ''''');
select ok(
  (select prosecdef and proconfig = array['search_path=""']
     from pg_proc where oid = 'private.fill_username()'::regprocedure),
  'A1.3: private.fill_username is security definer with search_path ''''');
select ok(
  not has_function_privilege('anon', 'private.assign_username(text)', 'execute')
  and not has_function_privilege('authenticated', 'private.assign_username(text)', 'execute')
  and not has_function_privilege('service_role', 'private.assign_username(text)', 'execute')
  and not has_function_privilege('public', 'private.assign_username(text)', 'execute'),
  'A1.2: no client role (anon, authenticated, service_role, public) can execute assign_username');
select ok(
  not has_function_privilege('anon', 'private.fill_username()', 'execute')
  and not has_function_privilege('authenticated', 'private.fill_username()', 'execute')
  and not has_function_privilege('service_role', 'private.fill_username()', 'execute')
  and not has_function_privilege('public', 'private.fill_username()', 'execute'),
  'A1.3: no client role can execute fill_username');
select ok(
  (select prosecdef and proconfig = array['search_path=""']
     from pg_proc where oid = 'public.handle_new_user()'::regprocedure)
  and not has_function_privilege('anon', 'public.handle_new_user()', 'execute')
  and not has_function_privilege('authenticated', 'public.handle_new_user()', 'execute'),
  'A1.2: handle_new_user is still security definer, search_path '''', not client-executable');
select is((select count(*)::int from un_reserved), 44,
  'positive control: 44 reserved words read from the constraint');

-- ---------------------------------------------------------------------------
-- The SQL base rule against lib suggestUsername (A1.2 pair; Jest has the same four)
-- ---------------------------------------------------------------------------
-- (Each accepts base + number only if a real user already holds the base: see the header.)
select ok(pg_temp.base_or_numbered(private.assign_username('Yash Saraiya'), 'yash_saraiya'),
  'pair: Yash Saraiya -> yash_saraiya');
select ok(pg_temp.base_or_numbered(private.assign_username('Zo' || chr(235) || ' Smith'), 'zoe_smith'),
  'pair: Zoë Smith -> zoe_smith (NFKD fold)');
select ok(pg_temp.base_or_numbered(private.assign_username('Jos' || chr(233) || ' N' || chr(250) || chr(241) || 'ez'), 'jose_nunez'),
  'pair: José Núñez -> jose_nunez');
select ok(pg_temp.base_or_numbered(private.assign_username('Mary-Jane O''Brien'), 'mary_jane_obrien'),
  'pair: Mary-Jane O''Brien -> mary_jane_obrien');
select ok(private.assign_username(null) ~ '^user[0-9]{1,4}$', 'assign_username(null) -> user<n>');
select is(
  (select count(*)::int from un_reserved as r
    where private.assign_username(r.word) = r.word or not pg_temp.is_valid(private.assign_username(r.word))),
  0, 'drift guard: assign_username never returns a reserved word, and every result passes V');

-- Every lib boundary value (contract V rows B1-B24) used as a display name gives a handle that
-- passes V.
select is(
  (select count(*)::int
     from unnest(array['abc', 'ab', repeat('a', 20), repeat('a', 21), 'yash_saraiya', 'yash.saraiya',
                       '.yash', 'yash.', 'ya..sh', 'a.b.c', 'Yash', 'yash-s', 'yash s', 'jos' || chr(233),
                       'yash' || chr(10), '', 'admin', 'admin1', 'you', 'me', '123', '___', 'ADMIN',
                       'a.' || repeat('b', 18)]) as v
    where not pg_temp.is_valid(private.assign_username(v))),
  0, 'every boundary value B1-B24 as a display name gives a handle passing V');

-- ---------------------------------------------------------------------------
-- Sign-up never fails: names that can't give a handle (A1.2)
-- ---------------------------------------------------------------------------
select lives_ok($$
  insert into auth.users (id, email, raw_user_meta_data) values
    ('5b000001-0000-0000-0000-000000000001', 'ur-01@test.local', '{"full_name":"山田太郎"}'::jsonb),
    ('5b000002-0000-0000-0000-000000000002', 'ur-02@test.local',
       jsonb_build_object('full_name', chr(127881) || chr(127881) || chr(127881))),
    ('5b000003-0000-0000-0000-000000000003', 'ur-03@test.local', '{}'::jsonb),
    ('5b000004-0000-0000-0000-000000000004', 'ur-04@test.local', '{"full_name":"admin"}'::jsonb),
    ('5b000005-0000-0000-0000-000000000005', 'ur-05@test.local', '{"full_name":""}'::jsonb),
    ('5b000006-0000-0000-0000-000000000006', 'ur-06@test.local',
       '{"full_name":"Bartholomew Montgomery-Smythe Westchester Ravensworth Junior"}'::jsonb),
    ('5b000007-0000-0000-0000-000000000007', 'ur-07@test.local', null),
    ('5b000008-0000-0000-0000-000000000008', 'ur-08@test.local', '[]'::jsonb),
    ('5b000009-0000-0000-0000-000000000009', 'ur-09@test.local', '"just a string"'::jsonb),
    ('5b000010-0000-0000-0000-000000000010', 'ur-10@test.local', '{"full_name":"   "}'::jsonb),
    ('5b000011-0000-0000-0000-000000000011', 'ur-11@test.local', '{"full_name":"Al"}'::jsonb),
    ('5b000012-0000-0000-0000-000000000012', 'ur-12@test.local',
       jsonb_build_object('name', 'Z' || repeat(chr(776), 40))),
    ('5b000013-0000-0000-0000-000000000013', 'ur-13@test.local',
       jsonb_build_object('full_name', 'A' || chr(776) || 'dm' || chr(237) || 'n')),
    ('5b000014-0000-0000-0000-000000000014', 'ur-14@test.local',
       jsonb_build_object('full_name', repeat('a', 200)))
$$, 'sign-up: CJK, emoji-only, {}, admin, empty, 60 chars, null, [], a JSON string, blank, Al, Z+40 marks, '
    || 'a name folding to admin, and 200 chars all succeed');
select is(
  char_length((select raw_user_meta_data ->> 'full_name' from auth.users
                where id = '5b000006-0000-0000-0000-000000000006')),
  60, 'positive control: the long name is 60 characters');
select is(
  (select count(*)::int from public.profiles where id::text like '5b0000__-%'),
  14, 'sign-up: each of the 14 created exactly one profile');
select is(
  (select count(distinct username)::int from public.profiles where id::text like '5b0000__-%' and pg_temp.is_valid(username)),
  14, 'sign-up: all 14 have a distinct username that passes V');
select is(
  (select count(*)::int from public.profiles where id::text like '5b0000__-%' and username_locked_at is null),
  14, 'A3.1: all 14 sign-ups are provisional (username_locked_at is null)');
select is(
  (select count(*)::int from public.profiles
    where id::text like '5b0000__-%'
      and id not in ('5b000006-0000-0000-0000-000000000006', '5b000014-0000-0000-0000-000000000014')
      and username ~ '^user[0-9]{1,4}$'),
  12, 'sign-up: the 12 with no usable base (including the one folding to reserved admin) get user<n>');
select ok(
  (select username ~ '^a{20}$|^a{16,19}[0-9]{1,4}$' and char_length(username) <= 20
     from public.profiles where id = '5b000014-0000-0000-0000-000000000014'),
  'sign-up: the 200-character name gets a handle of at most 20 characters');
select ok(
  pg_temp.base_or_numbered((select username from public.profiles where id = '5b000006-0000-0000-0000-000000000006'),
                           'bartholomew_montgome'),
  'sign-up: the 60-character name gets its base cut to 20 (bartholomew_montgome)');
select is(
  (select char_length(display_name) from public.profiles where id = '5b000006-0000-0000-0000-000000000006'),
  50, 'sign-up: the 60-character display name is still cut to 50 (rule unchanged)');

-- ---------------------------------------------------------------------------
-- Many sign-ups with the same name
-- ---------------------------------------------------------------------------
select lives_ok($$
  insert into auth.users (id, email, raw_user_meta_data)
  select ('5b0001' || lpad(n::text, 2, '0') || '-0000-0000-0000-000000000000')::uuid,
         'ur-yash-' || n || '@test.local', '{"full_name":"Yash Saraiya"}'::jsonb
    from generate_series(1, 20) as n
$$, 'same name: 20 sign-ups named Yash Saraiya succeed');
select is(
  (select count(distinct username)::int from public.profiles
    where id::text like '5b0001__-%' and pg_temp.is_valid(username)),
  20, 'same name: 20 distinct usernames, all passing V');
-- If a real user already holds yash_saraiya, all 20 get a number; otherwise the first gets the bare
-- base and the other 19 get a number.
select is(
  (select count(*)::int from public.profiles
    where id = '5b000101-0000-0000-0000-000000000000' and username = 'yash_saraiya'),
  case when pg_temp.held('yash_saraiya') then 0 else 1 end,
  'same name: the first gets the bare base (unless a real user holds it)');
select is(
  (select count(*)::int from public.profiles
    where id::text like '5b0001__-%' and username ~ '^yash_saraiya[0-9]{1,4}$'),
  case when pg_temp.held('yash_saraiya') then 20 else 19 end,
  'same name: the others get the base plus a number');

-- A taken 20-character base is cut so the number fits. The base is a random 20-character tag, taken
-- by a sign-up whose display name is that tag (no rename).
insert into auth.users (id, email, raw_user_meta_data)
values ('5b000015-0000-0000-0000-000000000015', 'ur-15@test.local',
        jsonb_build_object('full_name', current_setting('test.base20')));
select is(
  (select username from public.profiles where id = '5b000015-0000-0000-0000-000000000015'),
  current_setting('test.base20'), 'positive control: the 20-character base is taken');
select ok(
  (select u <> b and char_length(u) = 20 and pg_temp.is_valid(u)
          and regexp_replace(u, '[0-9]{1,4}$', '') = left(b, 20 - char_length(substring(u from '[0-9]{1,4}$')))
          and u ~ '[0-9]$'
     from (select private.assign_username(current_setting('test.base20')) as u,
                  current_setting('test.base20') as b) as t),
  'taken 20-character base: cut so base + number is exactly 20 and passes V');

-- ---------------------------------------------------------------------------
-- Direct inserts without a username: the demo seed pattern, service_role, an explicit value (A1.3)
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('5b000201-0000-0000-0000-000000000201', 'ur-s1@test.local', '{"full_name":"Sam (demo)"}'::jsonb),
  ('5b000202-0000-0000-0000-000000000202', 'ur-s2@test.local', '{"full_name":"Dee (demo)"}'::jsonb),
  ('5b000203-0000-0000-0000-000000000203', 'ur-s3@test.local', '{"full_name":"Maya (demo)"}'::jsonb);
select set_config('test.s1_before',
  (select username from public.profiles where id = '5b000201-0000-0000-0000-000000000201'), true) is not null
  as s1_captured;

-- Exactly the seed's shape: the profile already exists, so it takes the do-update path.
select lives_ok($$
  insert into public.profiles (id, display_name, venmo_username, venmo_prompt_dismissed_at)
  values ('5b000201-0000-0000-0000-000000000201', 'Sam (demo)', 'demo-sam-x', now())
  on conflict (id) do update
    set display_name = excluded.display_name, venmo_username = excluded.venmo_username
$$, 'seed pattern: insert ... on conflict do update with no username still runs');
select is(
  (select username from public.profiles where id = '5b000201-0000-0000-0000-000000000201'),
  current_setting('test.s1_before'), 'seed pattern: the existing username is kept');

-- A plain direct insert of a profile that doesn't exist yet.
delete from public.profiles where id = '5b000202-0000-0000-0000-000000000202';
select lives_ok($$
  insert into public.profiles (id, display_name, venmo_username, venmo_prompt_dismissed_at)
  values ('5b000202-0000-0000-0000-000000000202', 'Dee (demo)', 'demo-dee-x', now())
$$, 'direct insert with no username succeeds');
select ok(
  pg_temp.base_or_numbered((select username from public.profiles where id = '5b000202-0000-0000-0000-000000000202'),
                           'dee_demo'),
  'direct insert: the fill trigger assigns from display_name (dee_demo)');

-- service_role has INSERT on profiles but no EXECUTE on the helpers; the trigger still works.
delete from public.profiles where id = '5b000203-0000-0000-0000-000000000203';
set local role service_role;
select lives_ok($$
  insert into public.profiles (id, display_name) values ('5b000203-0000-0000-0000-000000000203', 'Maya (demo)')
$$, 'service_role direct insert with no username succeeds');
reset role;
select ok(pg_temp.is_valid((select username from public.profiles where id = '5b000203-0000-0000-0000-000000000203')),
  'service_role direct insert: the username passes V');

-- An explicit username is kept, not replaced.
delete from public.profiles where id = '5b000201-0000-0000-0000-000000000201';
insert into public.profiles (id, display_name, username)
values ('5b000201-0000-0000-0000-000000000201', 'Sam (demo)', current_setting('test.keep'));
select is(
  (select username from public.profiles where id = '5b000201-0000-0000-0000-000000000201'),
  current_setting('test.keep'), 'direct insert with a username keeps it');

-- ---------------------------------------------------------------------------
-- It can't be cleared (A1.1, A1.4)
-- ---------------------------------------------------------------------------
-- Setting the lock in the same statement gets past the A3.3 guard (postgres owns set_username),
-- so this reaches the NOT NULL check.
select throws_ok(
  $$ update public.profiles set username = null, username_locked_at = now()
      where id = '5b000201-0000-0000-0000-000000000201' $$,
  '23502', null, 'A1.1: a superuser write of null fails with 23502');
set local role authenticated;
set local request.jwt.claims = '{"sub":"5b000201-0000-0000-0000-000000000201","role":"authenticated"}';
select throws_ok($$ select public.set_username(null) $$, '22023', 'username_invalid',
  'A1.4: set_username(null) is still username_invalid');
reset role;
select is(
  (select username from public.profiles where id = '5b000201-0000-0000-0000-000000000201'),
  current_setting('test.keep'), 'A1.4: and the username is unchanged');

-- ---------------------------------------------------------------------------
-- Every numbered candidate taken: the uuid fallback (A1.2 step 3)
-- ---------------------------------------------------------------------------
-- 9,999 sign-ups (each with its own name, so each pick is one lookup). Their profiles are then
-- deleted and re-inserted holding user1 .. user9999 (skipping names a real user already holds), so
-- every random 'user<n>' try is taken. Delete then insert, never a rename (usernames can't change).
insert into auth.users (id, email, raw_user_meta_data)
select ('5b00ffff-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 'ur-x' || n || '@test.local',
       jsonb_build_object('full_name', 'Fx Fallback ' || n)
  from generate_series(1, 9999) as n;
delete from public.profiles where id::text like '5b00ffff-%';
insert into public.profiles (id, display_name, username)
select ('5b00ffff-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 'Fx Fallback ' || n, 'user' || n
  from generate_series(1, 9999) as n
 where not exists (select 1 from public.profiles as q where lower(q.username) = 'user' || n);
select is(
  (select count(*)::int from generate_series(1, 9999) as n
    where not exists (select 1 from public.profiles as p where p.username = 'user' || n)),
  0, 'positive control: every user1 .. user9999 is taken');
select ok(private.assign_username('') ~ '^u[0-9a-f]{12}$',
  'fallback: with every user<n> taken, assign_username returns u + 12 hex');
select lives_ok($$
  insert into auth.users (id, email, raw_user_meta_data)
  values ('5b000301-0000-0000-0000-000000000301', 'ur-fb@test.local', '{"full_name":"山田太郎"}'::jsonb)
$$, 'fallback: sign-up still succeeds');
select ok(
  (select username ~ '^u[0-9a-f]{12}$' and pg_temp.is_valid(username)
     from public.profiles where id = '5b000301-0000-0000-0000-000000000301'),
  'fallback: that sign-up gets u + 12 hex, which passes V');

-- ---------------------------------------------------------------------------
-- Review R7: handle_new_user's unique-violation retry (A1.2), driven by stubs of assign_username
-- ---------------------------------------------------------------------------
-- The real definition is saved and re-created at the end (and the transaction rolls back anyway).
-- The stub counts its calls with a temp sequence (nextval isn't undone when handle_new_user's
-- exception block rolls back an attempt; a table insert would be) and returns a name that is already taken (the
-- first Yash Saraiya fixture's) for its first test.r7_taken_calls calls, then a fresh tag. The
-- third stub also inserts a profile for the id in test.r7_dup_id, so handle_new_user's own insert
-- hits the primary key instead of the username index.
select set_config('test.r7_real', pg_get_functiondef('private.assign_username(text)'::regprocedure), true) is not null as r7_saved;
select set_config('test.r7_real_md5', md5(pg_get_functiondef('private.assign_username(text)'::regprocedure)), true) is not null as r7_md5;
select set_config('test.r7_taken', (select username from public.profiles where id = '5b000101-0000-0000-0000-000000000000'), true) is not null as r7_taken_set;
select set_config('test.r7_fresh', 'fxr7' || left(md5(random()::text || clock_timestamp()::text), 12), true) is not null as r7_fresh_set;
create temp sequence r7_calls;
create function pg_temp.r7_count() returns int language sql as $$
  select case when is_called then last_value::int else 0 end from pg_temp.r7_calls
$$;

create or replace function private.assign_username(p_display_name text)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare v_n int;
begin
  v_n := nextval('pg_temp.r7_calls');
  if nullif(current_setting('test.r7_dup_id', true), '') is not null then
    insert into public.profiles (id, display_name, username)
    values (current_setting('test.r7_dup_id')::uuid, 'dup', current_setting('test.r7_fresh') || 'd');
  end if;
  if v_n <= current_setting('test.r7_taken_calls')::int then
    return current_setting('test.r7_taken');
  end if;
  return current_setting('test.r7_fresh');
end $$;

-- 1. Taken twice, then free: the third attempt succeeds.
select set_config('test.r7_taken_calls', '2', true) is not null as r7_cfg1;
select lives_ok($$
  insert into auth.users (id, email, raw_user_meta_data)
  values ('5b000401-0000-0000-0000-000000000401', 'ur-r7a@test.local', '{"full_name":"Retry Ann"}'::jsonb)
$$, 'R7: sign-up succeeds when the first two picked names are taken by the time of the insert');
select is(
  (select username from public.profiles where id = '5b000401-0000-0000-0000-000000000401'),
  current_setting('test.r7_fresh'), 'R7: it gets the name from the third pick');
select is(pg_temp.r7_count(), 3, 'R7: handle_new_user picked three times (two 23505s caught)');

-- 2. Always taken: 5 attempts, then the u + 12 hex fallback.
alter sequence r7_calls restart;
select set_config('test.r7_taken_calls', '1000', true) is not null as r7_cfg2;
select lives_ok($$
  insert into auth.users (id, email, raw_user_meta_data)
  values ('5b000402-0000-0000-0000-000000000402', 'ur-r7b@test.local', '{"full_name":"Retry Ben"}'::jsonb)
$$, 'R7: sign-up succeeds even when every pick is taken');
select ok(
  (select username ~ '^u[0-9a-f]{12}$' and pg_temp.is_valid(username)
     from public.profiles where id = '5b000402-0000-0000-0000-000000000402'),
  'R7: after 5 taken picks it gets u + 12 hex, which passes V');
select is(pg_temp.r7_count(), 5, 'R7: exactly 5 attempts before the fallback');

-- 3. A duplicate profile id is a different unique violation: it is re-raised, sign-up fails.
alter sequence r7_calls restart;
select set_config('test.r7_taken_calls', '0', true) is not null as r7_cfg3;
select set_config('test.r7_dup_id', '5b000403-0000-0000-0000-000000000403', true) is not null as r7_cfg_dup;
select throws_ok($$
  insert into auth.users (id, email, raw_user_meta_data)
  values ('5b000403-0000-0000-0000-000000000403', 'ur-r7c@test.local', '{"full_name":"Retry Cal"}'::jsonb)
$$, '23505', 'duplicate key value violates unique constraint "profiles_pkey"',
  'R7: a profile that already exists for the id still raises 23505 (profiles_pkey), not a retry');
select is(pg_temp.r7_count(), 1, 'R7: no retry on the primary-key violation');
select set_config('test.r7_dup_id', '', true) is not null as r7_cfg_clear;

-- 4. Restore the real function and check it is back.
do $$ begin execute current_setting('test.r7_real'); end $$;
select is(md5(pg_get_functiondef('private.assign_username(text)'::regprocedure)), current_setting('test.r7_real_md5'),
  'R7: the real assign_username is restored');
select ok(pg_temp.base_or_numbered(private.assign_username('Mary-Jane O''Brien'), 'mary_jane_obrien'),
  'R7: and it works again (Mary-Jane O''Brien -> mary_jane_obrien)');

select * from finish();
rollback;
