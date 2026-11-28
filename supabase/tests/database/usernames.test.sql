-- pgTAP tests for migration 20261128070000_usernames.sql
-- (spec docs/specs/2026-11-28-usernames.md, Task 1, acceptance criteria 1-11; contract V rows B1-B24,
-- contract R). Updated for Amendment A1 (20261128100019_username_required.sql): username is NOT NULL
-- and assigned at sign-up, so criteria 1 and 2 expect a valid, unique username instead of null
-- (A1.6; sign-up itself is tested in username_required.test.sql).
-- Updated for Amendments A2/A3 (20261128111928_username_lock.sql): the assigned username is
-- provisional; set_username picks once and locks it (username_locked_at), and after that nothing
-- changes it. Nothing in this file renames a username outside set_username's one pick:
--   * criterion 3 stores rule V's rows through INSERTs of a fresh profile row;
--   * criterion 4 runs set_username for each row inside a subtransaction that is rolled back, so
--     E stays unlocked between rows;
--   * criteria 5 and 6 (uniqueness, "a rename frees the old handle") become the set-once checks
--     and the A3.3 immutability checks for every role; A2.8 checks Venmo stays editable.
--
-- Users (ids 5a00000N-..., all rolled back at the end):
--   A 5a000001 'Ann'  hosts bill X with B; creates group G with D. Picks a fresh handle (locked).
--   B 5a000002 'Ben'  joined bill X. Loses the race for A's pick, then keeps its own (locked).
--   C 5a000003 'Cal'  shares no bill or group with anyone (stranger). Checks availability.
--   D 5a000004 'Dee'  joined group G only (co-member of A, no shared bill). Stays unlocked.
--   E 5a000005 'Eve'  every boundary row B1-B24, stored directly and through set_username.
--   F/G/H 5a00000{6,7,8} sign-up rows with metadata that can't produce a username (criterion 2).
--   I 5a000009 'Ivy'  deleted (account deletion), then its handle is reused by J 5a00000a.
--
-- The local DB may hold real users, and a username can't be changed to free a handle a real user
-- holds. So every count is filtered to these ids; a check that stores a fixed valid value expects
-- 23505 if a non-fixture user already holds it (Postgres checks the unique index only after both
-- CHECK constraints passed, so that still shows the value passes rule V); and values the test
-- invents carry a random tag no one else holds.

begin;

create extension if not exists pgtap with schema extensions;

select plan(145);

insert into auth.users (id, email, raw_user_meta_data) values
  ('5a000001-0000-0000-0000-000000000001', 'un-a@test.local', '{"full_name":"Ann"}'::jsonb),
  ('5a000002-0000-0000-0000-000000000002', 'un-b@test.local', '{"full_name":"Ben"}'::jsonb),
  ('5a000003-0000-0000-0000-000000000003', 'un-c@test.local', '{"full_name":"Cal"}'::jsonb),
  ('5a000004-0000-0000-0000-000000000004', 'un-d@test.local', '{"full_name":"Dee"}'::jsonb),
  ('5a000005-0000-0000-0000-000000000005', 'un-e@test.local', '{"full_name":"Eve"}'::jsonb),
  ('5a000006-0000-0000-0000-000000000006', 'un-f@test.local', '{"full_name":"山田太郎"}'::jsonb),
  ('5a000007-0000-0000-0000-000000000007', 'un-g@test.local', '{}'::jsonb),
  ('5a000008-0000-0000-0000-000000000008', 'un-h@test.local', '{"full_name":"admin"}'::jsonb),
  ('5a000009-0000-0000-0000-000000000009', 'un-i@test.local', '{"full_name":"Ivy"}'::jsonb),
  ('5a00000a-0000-0000-0000-00000000000a', 'un-j@test.local', '{"full_name":"Jo"}'::jsonb);

-- Fresh handles nobody holds (random tags): A's pick, a rename target, and a free candidate.
select set_config('test.pick', 'fxp' || left(md5(random()::text || clock_timestamp()::text), 12), true) is not null as pick_set;
select set_config('test.fresh', 'fxr' || left(md5(random()::text || clock_timestamp()::text), 12), true) is not null as fresh_set;
select set_config('test.free', 'fxf' || left(md5(random()::text || clock_timestamp()::text), 12), true) is not null as free_set;

-- Each fixture user's assigned username, read as superuser.
select set_config('test.a_orig', (select username from public.profiles where id = '5a000001-0000-0000-0000-000000000001'), true) is not null as a_set;
select set_config('test.b_name', (select username from public.profiles where id = '5a000002-0000-0000-0000-000000000002'), true) is not null as b_set;
select set_config('test.c_name', (select username from public.profiles where id = '5a000003-0000-0000-0000-000000000003'), true) is not null as c_set;
select set_config('test.d_name', (select username from public.profiles where id = '5a000004-0000-0000-0000-000000000004'), true) is not null as d_set;

-- ---------------------------------------------------------------------------
-- Criterion 1 (as amended by A1.1/A1.6, A3.1): the columns; new rows have a valid, unique,
-- provisional username
-- ---------------------------------------------------------------------------
select has_column('public', 'profiles', 'username', 'c1: profiles has username');
select col_type_is('public', 'profiles', 'username', 'text', 'c1: username is text');
select col_not_null('public', 'profiles', 'username', 'c1 (A1.1): username is NOT NULL');
select col_hasnt_default('public', 'profiles', 'username', 'c1: username has no column default (a trigger fills it)');
select is(
  (select count(distinct username)::int from public.profiles
    where id in ('5a000001-0000-0000-0000-000000000001', '5a000002-0000-0000-0000-000000000002',
                 '5a000003-0000-0000-0000-000000000003', '5a000004-0000-0000-0000-000000000004',
                 '5a000005-0000-0000-0000-000000000005')
      and char_length(username) between 3 and 20 and username ~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$'),
  5, 'c1 (A1.6): newly inserted users A-E each have a distinct username that passes the format rule');
select has_column('public', 'profiles', 'username_locked_at', 'A3.1: profiles has username_locked_at');
select col_type_is('public', 'profiles', 'username_locked_at', 'timestamp with time zone',
  'A3.1: username_locked_at is timestamptz');
select col_is_null('public', 'profiles', 'username_locked_at', 'A3.1: username_locked_at is nullable');
select is(
  (select count(*)::int from public.profiles
    where id::text like '5a00000_-%' and username_locked_at is null),
  10, 'A3.1: every new sign-up starts provisional (username_locked_at is null)');

-- ---------------------------------------------------------------------------
-- Criterion 2 (as amended by A1.6): sign-up still works and assigns a username
-- ---------------------------------------------------------------------------
select is(
  (select count(distinct username)::int from public.profiles
    where id in ('5a000006-0000-0000-0000-000000000006', '5a000007-0000-0000-0000-000000000007',
                 '5a000008-0000-0000-0000-000000000008')
      and username ~ '^user[0-9]{1,4}$'),
  3, 'c2 (A1.6): CJK, empty and "admin" metadata each create a profile with a distinct user<n>');
select is(
  (select count(*)::int from public.profiles
    where id in ('5a000006-0000-0000-0000-000000000006', '5a000007-0000-0000-0000-000000000007',
                 '5a000008-0000-0000-0000-000000000008')
      and display_name is not distinct from case id
            when '5a000006-0000-0000-0000-000000000006' then '山田太郎'
            when '5a000008-0000-0000-0000-000000000008' then 'admin' end),
  3, 'c2: the display-name rule is unchanged (CJK kept, {} -> null, admin kept)');

-- ---------------------------------------------------------------------------
-- Index
-- ---------------------------------------------------------------------------
select has_index('public', 'profiles', 'profiles_username_lower_key',
  'profiles has the profiles_username_lower_key index');
select index_is_unique('public', 'profiles', 'profiles_username_lower_key',
  'profiles_username_lower_key is unique');

-- ---------------------------------------------------------------------------
-- Criterion 9: grants
-- ---------------------------------------------------------------------------
select ok(has_column_privilege('authenticated', 'public.profiles', 'username', 'SELECT'),
  'c9: authenticated can SELECT username');
select ok(not has_column_privilege('authenticated', 'public.profiles', 'username', 'UPDATE'),
  'c9: authenticated has no UPDATE on username');
select ok(not has_column_privilege('authenticated', 'public.profiles', 'username', 'INSERT'),
  'c9: authenticated has no INSERT on username');
select ok(not has_column_privilege('authenticated', 'public.profiles', 'username', 'REFERENCES'),
  'c9: authenticated has no REFERENCES on username');
select ok(
  not has_column_privilege('authenticated', 'public.profiles', 'username_locked_at', 'SELECT, INSERT, UPDATE, REFERENCES'),
  'A3: authenticated has no privilege on username_locked_at (owner-only, read via my_username_status)');
select ok(
  not exists (
    select 1 from pg_attribute a
     where a.attrelid = 'public.profiles'::regclass and a.attnum > 0 and not a.attisdropped
       and has_column_privilege('anon', 'public.profiles', a.attname, 'SELECT, INSERT, UPDATE, REFERENCES')),
  'c9: anon has no privilege on any column of profiles');
select table_privs_are('public', 'profiles', 'authenticated', array[]::text[],
  'c9: authenticated still has no table-level privileges on profiles');
select table_privs_are('public', 'profiles', 'anon', array[]::text[],
  'c9: anon still has no table-level privileges on profiles');

-- ---------------------------------------------------------------------------
-- Criterion 10 (and A3): the functions' and the trigger's shape and execute grants
-- ---------------------------------------------------------------------------
select ok(
  (select prosecdef and proconfig = array['search_path=""']
     from pg_proc where oid = 'public.set_username(text)'::regprocedure),
  'c10: set_username is security definer with search_path ''''');
select is(
  (select provolatile::text from pg_proc where oid = 'public.set_username(text)'::regprocedure),
  'v', 'c10: set_username is volatile');
select function_returns('public', 'set_username', array['text'], 'text', 'c10: set_username returns text');
select ok(has_function_privilege('authenticated', 'public.set_username(text)', 'execute'),
  'c10: authenticated can execute set_username');
select ok(
  not has_function_privilege('anon', 'public.set_username(text)', 'execute')
  and not has_function_privilege('public', 'public.set_username(text)', 'execute')
  and not has_function_privilege('service_role', 'public.set_username(text)', 'execute'),
  'c10: anon, public and service_role cannot execute set_username');

select ok(
  (select prosecdef and proconfig = array['search_path=""']
     from pg_proc where oid = 'public.usernames_available(text[])'::regprocedure),
  'A3.4: usernames_available is security definer with search_path ''''');
select function_returns('public', 'usernames_available', array['text[]'], 'text[]',
  'A3.4: usernames_available returns text[]');
select ok(
  has_function_privilege('authenticated', 'public.usernames_available(text[])', 'execute')
  and not has_function_privilege('anon', 'public.usernames_available(text[])', 'execute')
  and not has_function_privilege('public', 'public.usernames_available(text[])', 'execute')
  and not has_function_privilege('service_role', 'public.usernames_available(text[])', 'execute'),
  'A3.4: only authenticated can execute usernames_available');

select ok(
  (select prosecdef and proconfig = array['search_path=""']
     from pg_proc where oid = 'public.my_username_status()'::regprocedure),
  'A3: my_username_status is security definer with search_path ''''');
select ok(
  has_function_privilege('authenticated', 'public.my_username_status()', 'execute')
  and not has_function_privilege('anon', 'public.my_username_status()', 'execute')
  and not has_function_privilege('public', 'public.my_username_status()', 'execute')
  and not has_function_privilege('service_role', 'public.my_username_status()', 'execute'),
  'A3: only authenticated can execute my_username_status');

select has_trigger('public', 'profiles', 'profiles_username_lock',
  'A3.3: profiles has the profiles_username_lock trigger');
select is(
  (select pg_get_triggerdef(t.oid) from pg_trigger as t
    where t.tgrelid = 'public.profiles'::regclass and t.tgname = 'profiles_username_lock'),
  'CREATE TRIGGER profiles_username_lock BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION private.guard_username_lock()',
  'A3.3: it fires BEFORE every UPDATE (no column list), for each row');
select ok(
  (select not prosecdef and proconfig = array['search_path=""']
     from pg_proc where oid = 'private.guard_username_lock()'::regprocedure),
  'A3.3: the guard is security invoker (it compares current_user) with search_path ''''');
select ok(
  not has_function_privilege('anon', 'private.guard_username_lock()', 'execute')
  and not has_function_privilege('authenticated', 'private.guard_username_lock()', 'execute')
  and not has_function_privilege('service_role', 'private.guard_username_lock()', 'execute')
  and not has_function_privilege('public', 'private.guard_username_lock()', 'execute'),
  'A3.3: no client role can execute the guard');

-- ---------------------------------------------------------------------------
-- Fixture: A hosts bill X and B joins it; A creates group G and D joins it (real functions).
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"5a000001-0000-0000-0000-000000000001","role":"authenticated"}';
do $$
declare r record;
begin
  select * into r from public.create_bill(
    '[{"name":"Tea","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":300}]'::jsonb,
    null, 0, 0, 0, 0, 0, 300);
  perform set_config('test.x_code', r.join_code, true);
  perform public.create_group('5a0000a1-0000-0000-0000-0000000000a1', 'Username test group');
end $$;
set local request.jwt.claims = '{"sub":"5a000002-0000-0000-0000-000000000002","role":"authenticated"}';
select public.join_bill(current_setting('test.x_code'));

reset role;
select set_config('test.g_code',
  (select join_code from public.groups where id = '5a0000a1-0000-0000-0000-0000000000a1'), true);
set local role authenticated;
set local request.jwt.claims = '{"sub":"5a000004-0000-0000-0000-000000000004","role":"authenticated"}';
select public.join_group(current_setting('test.g_code'));
reset role;

-- Criterion 11 baseline: event counts for the fixture users, after the fixture, before any
-- username write.
select set_config('test.bill_events_before',
  (select count(*)::text from public.bill_events where actor_id::text like '5a00000_-%'), true);
select set_config('test.group_events_before',
  (select count(*)::text from public.group_events where actor_id::text like '5a00000_-%'), true);

-- ---------------------------------------------------------------------------
-- Boundary table (contract V, B1-B24) and helpers that report a result as text
-- ---------------------------------------------------------------------------
create temp table un_boundary (n int primary key, value text not null, class text not null);
insert into un_boundary values
  (1, 'abc', 'valid'),
  (2, 'ab', 'invalid'),
  (3, repeat('a', 20), 'valid'),
  (4, repeat('a', 21), 'invalid'),
  (5, 'yash_saraiya', 'valid'),
  (6, 'yash.saraiya', 'valid'),
  (7, '.yash', 'invalid'),
  (8, 'yash.', 'invalid'),
  (9, 'ya..sh', 'invalid'),
  (10, 'a.b.c', 'valid'),
  (11, 'Yash', 'invalid'),
  (12, 'yash-s', 'invalid'),
  (13, 'yash s', 'invalid'),
  (14, 'josé', 'invalid'),
  (15, 'yash' || chr(10), 'invalid'),
  (16, '', 'invalid'),
  (17, 'admin', 'reserved'),
  (18, 'admin1', 'valid'),
  (19, 'you', 'reserved'),
  (20, 'me', 'invalid'),
  (21, '123', 'valid'),
  (22, '___', 'valid'),
  (23, 'ADMIN', 'invalid'),
  (24, 'a.' || repeat('b', 18), 'valid');
grant select on un_boundary to authenticated;

-- True if a non-fixture user holds the handle.
create function pg_temp.held(p text) returns boolean
language sql stable security definer as $$
  select exists (select 1 from public.profiles as p
                  where lower(p.username) = lower($1) and p.id::text not like '5a00000_-%')
$$;
grant execute on function pg_temp.held(text) to authenticated;

-- Re-inserts E's profile row with p_value as superuser (delete + insert in one block, so a failure
-- rolls both back and E keeps its row). 'ok' if stored exactly, else '<sqlstate>:<constraint>'.
-- E has no bills, groups or events, so the delete touches nothing else.
create function pg_temp.insert_as(p_value text) returns text
language plpgsql as $$
declare v_constraint text; v_stored text;
begin
  delete from public.profiles where id = '5a000005-0000-0000-0000-000000000005';
  insert into public.profiles (id, display_name, username)
  values ('5a000005-0000-0000-0000-000000000005', 'Eve', p_value)
  returning username into v_stored;
  return case when v_stored = p_value then 'ok' else 'mismatch:' || coalesce(v_stored, '<null>') end;
exception when others then
  get stacked diagnostics v_constraint = constraint_name;
  return sqlstate || ':' || coalesce(v_constraint, '');
end $$;

-- set_username as the current role/JWT, inside a subtransaction that is always rolled back, so the
-- caller stays unlocked for the next row. 'ok' if it returned the value and my_username_status
-- then showed that value, locked; else '<sqlstate>:<message>'.
create function pg_temp.rpc_try(p_value text) returns text
language plpgsql as $$
declare v_returned text; v_status record;
begin
  begin
    v_returned := public.set_username(p_value);
    select * into v_status from public.my_username_status();
    raise exception using errcode = 'P0001', message = 'undo:' ||
      case when v_returned = p_value and v_status.username = p_value and v_status.locked then 'ok'
           else 'mismatch:' || coalesce(v_returned, '<null>') || '/' || coalesce(v_status.username, '<null>') end;
  exception when others then
    if sqlerrm like 'undo:%' then
      return substr(sqlerrm, 6);
    end if;
    return sqlstate || ':' || sqlerrm;
  end;
end $$;

-- An UPDATE as the current role. 'ok' or '<sqlstate>:<message>'.
create function pg_temp.update_try(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ':' || sqlerrm;
end $$;
grant execute on function pg_temp.update_try(text) to authenticated, service_role;

select set_config('test.e_orig',
  (select username from public.profiles where id = '5a000005-0000-0000-0000-000000000005'), true)
  is not null as e_set;
select set_config('test.others_before',
  (select string_agg(id::text || '=' || username, ',' order by id) from public.profiles
    where id::text like '5a00000_-%' and id <> '5a000005-0000-0000-0000-000000000005'), true);

-- ---------------------------------------------------------------------------
-- Criterion 3: every row stored directly as superuser, through an INSERT (24 assertions)
-- ---------------------------------------------------------------------------
select is(
  pg_temp.insert_as(b.value),
  case when b.class = 'valid' and pg_temp.held(b.value) then '23505:profiles_username_lower_key'
       when b.class = 'valid' then 'ok'
       when b.class = 'invalid' then '23514:profiles_username_format'
       else '23514:profiles_username_reserved' end,
  format('c3: B%s %s stored directly -> %s', b.n, quote_literal(replace(b.value, chr(10), '\n')), b.class))
from un_boundary as b
order by b.n;

-- Put E back on its own assigned username (an insert, not a rename), still provisional.
delete from public.profiles where id = '5a000005-0000-0000-0000-000000000005';
insert into public.profiles (id, display_name, username)
values ('5a000005-0000-0000-0000-000000000005', 'Eve', current_setting('test.e_orig'));

-- ---------------------------------------------------------------------------
-- Criterion 4: every row through set_username as its owner E, each rolled back (24 assertions)
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"5a000005-0000-0000-0000-000000000005","role":"authenticated"}';

select is(
  pg_temp.rpc_try(b.value),
  case when b.class = 'valid' and pg_temp.held(b.value) then '23505:username_taken'
       when b.class = 'valid' then 'ok'
       when b.class = 'invalid' then '22023:username_invalid'
       else '22023:username_reserved' end,
  format('c4: B%s %s through set_username -> %s', b.n, quote_literal(replace(b.value, chr(10), '\n')), b.class))
from un_boundary as b
order by b.n;

select throws_ok($$ select public.set_username(null) $$, '22023', 'username_invalid',
  'c4: set_username(null) -> 22023 username_invalid');

-- A JWT whose subject has no profile row.
set local request.jwt.claims = '{"sub":"5a0000ff-0000-0000-0000-0000000000ff","role":"authenticated"}';
select throws_ok($$ select public.set_username('nobody_here') $$, '42501', 'not_allowed',
  'R: a caller with no profile row -> 42501 not_allowed');

reset role;
select is(
  (select string_agg(id::text || '=' || username, ',' order by id) from public.profiles
    where id::text like '5a00000_-%' and id <> '5a000005-0000-0000-0000-000000000005'),
  current_setting('test.others_before'),
  'R: E''s set_username calls changed no other user''s row');
select is(
  (select username || '|' || (username_locked_at is null)::text from public.profiles
    where id = '5a000005-0000-0000-0000-000000000005'),
  current_setting('test.e_orig') || '|true',
  'c4: after the rolled-back calls E keeps its provisional username, unlocked');

-- ---------------------------------------------------------------------------
-- Criterion 5 (as amended by A3.2): pick once, uniqueness, keep the provisional name
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"5a000001-0000-0000-0000-000000000001","role":"authenticated"}';
select is(
  (select username || '|' || locked::text from public.my_username_status()),
  current_setting('test.a_orig') || '|false', 'A3.1: my_username_status shows A''s provisional name, unlocked');
select is(public.set_username(current_setting('test.pick')), current_setting('test.pick'),
  'A3.2: A picks a new handle; set_username returns it');
select is(
  (select username || '|' || locked::text from public.my_username_status()),
  current_setting('test.pick') || '|true', 'A3.2: A''s username is the pick, and it is locked');
select throws_ok(format($$ select public.set_username(%L) $$, current_setting('test.fresh')),
  '42501', 'username_locked', 'A3.2: a second pick by A -> 42501 username_locked');
select throws_ok(format($$ select public.set_username(%L) $$, current_setting('test.pick')),
  '42501', 'username_locked', 'A3.2: even the same name again, once locked -> 42501 username_locked');

set local request.jwt.claims = '{"sub":"5a000002-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok(format($$ select public.set_username(%L) $$, current_setting('test.pick')),
  '23505', 'username_taken', 'c5: B''s set_username of A''s pick -> 23505 username_taken (no raw constraint text)');
select is((select locked from public.my_username_status()), false,
  'c5: B is still unlocked after losing');
select is(public.set_username(current_setting('test.b_name')), current_setting('test.b_name'),
  'A3.1: B keeps its provisional name ("Keep @name"); set_username returns it');
select is(
  (select username || '|' || locked::text from public.my_username_status()),
  current_setting('test.b_name') || '|true', 'A3.1: picking the provisional name locks it');

reset role;
delete from public.profiles where id = '5a00000a-0000-0000-0000-00000000000a';
select throws_ok(
  $$ insert into public.profiles (id, display_name, username) values ('5a00000a-0000-0000-0000-00000000000a', 'Jo', 'Sam') $$,
  '23514', 'new row for relation "profiles" violates check constraint "profiles_username_format"',
  'c5: a superuser insert of Sam (uppercase) fails on the format check');
select throws_ok(
  format($$ insert into public.profiles (id, display_name, username) values ('5a00000a-0000-0000-0000-00000000000a', 'Jo', %L) $$,
         current_setting('test.pick')),
  '23505', 'duplicate key value violates unique constraint "profiles_username_lower_key"',
  'c5: a superuser insert of A''s username for another user fails on the unique index');

-- ---------------------------------------------------------------------------
-- A3.3 (replaces criterion 6): nothing changes a locked username or its lock, for any role; an
-- unlocked username changes only through set_username. A is locked, D is unlocked.
-- ---------------------------------------------------------------------------
select set_config('test.a_locked_at',
  (select username_locked_at::text from public.profiles where id = '5a000001-0000-0000-0000-000000000001'), true)
  is not null as a_lock_set;

select is(
  pg_temp.update_try(format($$ update public.profiles set username = %L where id = '5a000001-0000-0000-0000-000000000001' $$,
                            current_setting('test.fresh'))),
  '42501:username_immutable', 'A3.3: postgres renaming locked A -> 42501 username_immutable');
select is(
  pg_temp.update_try($$ update public.profiles set username_locked_at = null where id = '5a000001-0000-0000-0000-000000000001' $$),
  '42501:username_immutable', 'A3.3: postgres clearing A''s lock -> 42501 username_immutable');
select is(
  pg_temp.update_try($$ update public.profiles set username_locked_at = '2001-01-01T00:00:00Z' where id = '5a000001-0000-0000-0000-000000000001' $$),
  '42501:username_immutable', 'A3.3: postgres changing A''s lock time -> 42501 username_immutable');
select is(
  (select count(*)::int from un_boundary as b
    where pg_temp.update_try(format($$ update public.profiles set username = %L where id = '5a000001-0000-0000-0000-000000000001' $$, b.value))
          <> '42501:username_immutable'),
  0, 'A3.3: every boundary row B1-B24 as postgres on locked A -> 42501 username_immutable (the trigger runs before the CHECKs)');
select is(
  pg_temp.update_try(format($$ update public.profiles set username = 'z' || username
                                 where id in ('5a000001-0000-0000-0000-000000000001', '5a000004-0000-0000-0000-000000000004') $$)),
  '42501:username_immutable', 'A3.3: a multi-row rename by postgres fails as a whole');
select is(
  pg_temp.update_try(format($$ update public.profiles set username = %L where id = '5a000004-0000-0000-0000-000000000004' $$,
                            current_setting('test.fresh'))),
  '42501:username_immutable', 'A3.3: postgres renaming unlocked D without setting the lock -> 42501 username_immutable');
select lives_ok(
  $$ update public.profiles set username = username, username_locked_at = username_locked_at
      where id = '5a000001-0000-0000-0000-000000000001' $$,
  'A3.3: an UPDATE that sets both columns to their current values is allowed');

set local role service_role;
select is(
  pg_temp.update_try(format($$ update public.profiles set username = %L where id = '5a000001-0000-0000-0000-000000000001' $$,
                            current_setting('test.fresh'))),
  '42501:username_immutable', 'A3.3: service_role renaming locked A -> 42501 username_immutable');
select is(
  pg_temp.update_try(format($$ update public.profiles set username = %L, username_locked_at = now()
                                 where id = '5a000004-0000-0000-0000-000000000004' $$, current_setting('test.fresh'))),
  '42501:username_immutable', 'A3.3: service_role renaming unlocked D even with the lock set -> 42501 (not set_username''s path)');
select is(
  pg_temp.update_try($$ update public.profiles set username_locked_at = now() where id = '5a000004-0000-0000-0000-000000000004' $$),
  '42501:username_immutable', 'A3.3: service_role locking D directly -> 42501 username_immutable');
select lives_ok(
  $$ update public.profiles set display_name = 'Ann (svc)' where id = '5a000001-0000-0000-0000-000000000001' $$,
  'A3.3: service_role can still update display_name');
reset role;
select is(
  (select display_name || '|' || username || '|' || username_locked_at::text from public.profiles
    where id = '5a000001-0000-0000-0000-000000000001'),
  'Ann (svc)|' || current_setting('test.pick') || '|' || current_setting('test.a_locked_at'),
  'A3.3: the service_role display_name update landed and left username and its lock unchanged');
select is(
  (select username || '|' || (username_locked_at is null)::text from public.profiles
    where id = '5a000004-0000-0000-0000-000000000004'),
  current_setting('test.d_name') || '|true', 'A3.3: D is still provisional and unchanged');

-- A2.8: Venmo stays editable for the owner; a statement that also changes username fails.
set local role authenticated;
set local request.jwt.claims = '{"sub":"5a000001-0000-0000-0000-000000000001","role":"authenticated"}';
with u as (
  update public.profiles set display_name = 'Ann'
   where id = '5a000001-0000-0000-0000-000000000001' returning display_name
)
select is((select display_name from u), 'Ann', 'A3.3: the owner can still update display_name');
with u as (
  update public.profiles set venmo_username = 'ann-un-fx'
   where id = '5a000001-0000-0000-0000-000000000001' returning venmo_username
)
select is((select venmo_username from u), 'ann-un-fx', 'A2.8: the owner can update venmo_username');
select is(
  (select username from public.profiles where id = '5a000001-0000-0000-0000-000000000001'),
  current_setting('test.pick'), 'A2.8: and username is unchanged');
-- As the owner (authenticated) the column grant check refuses the combined statement first (42501
-- permission denied); service_role, which has the grant, reaches the trigger (username_immutable).
select throws_ok(
  format($$ update public.profiles set venmo_username = 'ann-un-fx2', username = %L
             where id = '5a000001-0000-0000-0000-000000000001' $$, current_setting('test.fresh')),
  '42501', null, 'A2.8: the owner updating venmo_username and username together fails with 42501');
reset role;
set local role service_role;
select is(
  pg_temp.update_try(format($$ update public.profiles set venmo_username = 'ann-un-fx2', username = %L
                                 where id = '5a000001-0000-0000-0000-000000000001' $$, current_setting('test.fresh'))),
  '42501:username_immutable',
  'A2.8: venmo_username and username together on the owner''s row -> 42501 username_immutable');
reset role;
select is(
  (select venmo_username || '|' || username from public.profiles where id = '5a000001-0000-0000-0000-000000000001'),
  'ann-un-fx|' || current_setting('test.pick'),
  'A2.8: after the refused combined updates, venmo_username is the owner''s and username is unchanged');

-- Account deletion still cascades the profile; the handle is then free for someone new (A2.7).
select set_config('test.i_name',
  (select username from public.profiles where id = '5a000009-0000-0000-0000-000000000009'), true)
  is not null as i_set;
delete from auth.users where id = '5a000009-0000-0000-0000-000000000009';
select is(
  (select count(*)::int from public.profiles where id = '5a000009-0000-0000-0000-000000000009'),
  0, 'A2.5: deleting I''s account deletes its profile (cascade)');
select lives_ok(
  format($$ insert into public.profiles (id, display_name, username) values ('5a00000a-0000-0000-0000-00000000000a', 'Jo', %L) $$,
         current_setting('test.i_name')),
  'A2.7 (today''s behaviour): a deleted account''s username can be given to a new profile');

-- ---------------------------------------------------------------------------
-- A3.4: usernames_available (as stranger C)
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"5a000003-0000-0000-0000-000000000003","role":"authenticated"}';
select is(
  public.usernames_available(array[
    current_setting('test.pick'),            -- taken (A)
    upper(current_setting('test.free')),     -- uppercase: invalid (no normalizing, UN-3)
    'admin',                                 -- reserved
    'ab',                                    -- invalid
    current_setting('test.free'),            -- free
    null,                                    -- skipped
    current_setting('test.free'),            -- duplicate
    current_setting('test.c_name')           -- the caller's own: free for them
  ]),
  array[current_setting('test.free'), current_setting('test.c_name')],
  'A3.4: only valid, free candidates come back, in order, once each (taken, uppercase, reserved, invalid, null dropped)');
select is(
  public.usernames_available(array[current_setting('test.b_name'), current_setting('test.d_name')]),
  '{}'::text[], 'A3.4: other people''s handles (locked or provisional) are not available');
select is(public.usernames_available('{}'::text[]), '{}'::text[], 'A3.4: an empty array gives {}');
select is(public.usernames_available(null), '{}'::text[], 'A3.4: null gives {}');
select lives_ok(
  $$ select public.usernames_available(array['fxa01', 'fxa02', 'fxa03', 'fxa04', 'fxa05', 'fxa06', 'fxa07', 'fxa08', 'fxa09', 'fxa10']) $$,
  'A3.4: 10 candidates are accepted');
select throws_ok(
  $$ select public.usernames_available(array['fxa01', 'fxa02', 'fxa03', 'fxa04', 'fxa05', 'fxa06', 'fxa07', 'fxa08', 'fxa09', 'fxa10', 'fxa11']) $$,
  '22023', 'too_many_candidates', 'A3.4: 11 candidates -> 22023 too_many_candidates');

-- Drift guard: no reserved word from the live constraint is ever available.
reset role;
create temp table un_reserved as
select m[1] as word
  from pg_constraint as c,
       regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''::text', 'g') as m
 where c.conrelid = 'public.profiles'::regclass and c.conname = 'profiles_username_reserved';
grant select on un_reserved to authenticated;
set local role authenticated;
select is(
  (select count(*)::int from un_reserved as r
    where cardinality(public.usernames_available(array[r.word])) > 0)
  + case when (select count(*) from un_reserved) = 44 then 0 else 1000 end,
  0, 'A3.4 drift guard: none of the constraint''s 44 reserved words is available (count checked)');
select is(
  (select array_agg(b.value order by b.n) from un_boundary as b
    where b.class = 'valid' and not pg_temp.held(b.value)),
  (select array_agg(v order by o) from (
     select v, o from unnest(
       public.usernames_available((select array_agg(value order by n) from un_boundary where n <= 10))
       || public.usernames_available((select array_agg(value order by n) from un_boundary where n between 11 and 20))
       || public.usernames_available((select array_agg(value order by n) from un_boundary where n > 20))
     ) with ordinality as t(v, o)) as s),
  'A3.4: of B1-B24, exactly the valid rows no one else holds are available');

set local request.jwt.claims = '{"role":"authenticated"}';
select throws_ok($$ select public.usernames_available(array['abc']) $$, '42501', 'not_allowed',
  'A3.4: usernames_available with no JWT subject -> 42501 not_allowed');

-- ---------------------------------------------------------------------------
-- my_username_status: the caller's own row only
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"5a000003-0000-0000-0000-000000000003","role":"authenticated"}';
select is(
  (select array_agg(username || '|' || locked::text) from public.my_username_status()),
  array[current_setting('test.c_name') || '|false'],
  'A3: my_username_status returns exactly one row, the caller''s own');

-- ---------------------------------------------------------------------------
-- Criterion 7: reads as authenticated
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"5a000001-0000-0000-0000-000000000001","role":"authenticated"}';
select is(
  (select username from public.profiles where id = '5a000001-0000-0000-0000-000000000001'),
  current_setting('test.pick'), 'c7: the owner reads their own username');
select is(
  (select username from public.profiles where id = '5a000002-0000-0000-0000-000000000002'),
  current_setting('test.b_name'), 'c7: A reads co-participant B''s username');
select is(
  (select username from public.profiles where id = '5a000004-0000-0000-0000-000000000004'),
  current_setting('test.d_name'), 'c7: A reads co-member D''s username (no shared bill)');
select throws_ok($$ select * from public.profiles $$, '42501', null,
  'c7: select * from profiles still fails with 42501');

set local request.jwt.claims = '{"sub":"5a000002-0000-0000-0000-000000000002","role":"authenticated"}';
select is(
  (select username from public.profiles where id = '5a000001-0000-0000-0000-000000000001'),
  current_setting('test.pick'), 'c7: co-participant B reads A''s username');

set local request.jwt.claims = '{"sub":"5a000004-0000-0000-0000-000000000004","role":"authenticated"}';
select is(
  (select username from public.profiles where id = '5a000001-0000-0000-0000-000000000001'),
  current_setting('test.pick'), 'c7: co-member D reads A''s username');

-- The SELECT (username) grant is safe only because the row policy scopes it.
set local request.jwt.claims = '{"sub":"5a000003-0000-0000-0000-000000000003","role":"authenticated"}';
select is(
  (select count(*)::int from (
     select username from public.profiles
      where id in ('5a000001-0000-0000-0000-000000000001', '5a000002-0000-0000-0000-000000000002',
                   '5a000004-0000-0000-0000-000000000004')) as s),
  0, 'c7: stranger C (no shared bill or group) gets 0 rows, so no username');

-- ---------------------------------------------------------------------------
-- Criterion 8: denied paths fail with 42501
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"5a000001-0000-0000-0000-000000000001","role":"authenticated"}';
select throws_ok(
  $$ update public.profiles set username = 'x' where id = '5a000001-0000-0000-0000-000000000001' $$,
  '42501', null, 'c8: the owner can''t update username directly (42501)');
select throws_ok(
  $$ select username_locked_at from public.profiles where id = '5a000001-0000-0000-0000-000000000001' $$,
  '42501', null, 'A3: the owner can''t read username_locked_at directly (42501)');

set local request.jwt.claims = '{"role":"authenticated"}';
select throws_ok($$ select public.set_username('no_subject') $$, '42501', 'not_allowed',
  'c8: set_username with no JWT subject -> 42501 not_allowed');

set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select throws_ok($$ select username from public.profiles $$, '42501', null,
  'c8: anon select username fails with 42501');
select throws_ok($$ select public.set_username('anon_try') $$, '42501', null,
  'c8: anon calling set_username fails with 42501');
select throws_ok($$ select public.usernames_available(array['abc']) $$, '42501', null,
  'A3.4: anon calling usernames_available fails with 42501');
select throws_ok($$ select * from public.my_username_status() $$, '42501', null,
  'A3: anon calling my_username_status fails with 42501');

-- ---------------------------------------------------------------------------
-- Criterion 11: no activity events from any username write (UN-10)
-- ---------------------------------------------------------------------------
reset role;
select is(
  (select count(*)::text from public.bill_events where actor_id::text like '5a00000_-%'),
  current_setting('test.bill_events_before'),
  'c11: set_username and the profile writes logged no bill_events for the fixture users');
select is(
  (select count(*)::text from public.group_events where actor_id::text like '5a00000_-%'),
  current_setting('test.group_events_before'),
  'c11: set_username and the profile writes logged no group_events for the fixture users');

select * from finish();
rollback;
