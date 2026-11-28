-- pgTAP tests for supabase/migrations/20261126082511_groups.sql (Groups MVP T2; spec
-- docs/specs/2026-11-26-groups-mvp.md criteria 8-15, 34, 97, 102, 113 and Amendment A1).
--
-- Every assertion filters to the fixture users / groups below (the local DB may hold real data).
-- Fixture ids all start with d1.
-- Users: A ..01 'Ana' (creates G1), B ..02 'Ben' (joins), C ..03 'Cy' (stranger throughout),
--        D ..04 'Dee' (joins, leaves, then fills the 50th seat of G7),
--        X1..X48 d1000000-0000-0000-0001-0000000000NN (extra members for the 50-member cap).
-- Groups (client-generated ids): G1 ..a1 'Tahoe trip'; G2..G6 name boundary cases (Ana only);
--        G7 ..a7 the cap group.
-- A real two-session deadlock can't be produced in pgTAP (one connection), so criterion 34 is
-- checked statically from the function bodies (as people_review_fixes.test.sql does).

begin;

create extension if not exists pgtap with schema extensions;

select plan(114);

-- Sets the JWT claims for the next statements (call as postgres, then `set local role`).
create function pg_temp.act(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

create function pg_temp.signed_out() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
end $$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('d1000000-0000-0000-0000-000000000001', 'groups-a@test.local', '{"full_name":"Ana"}'::jsonb),
  ('d1000000-0000-0000-0000-000000000002', 'groups-b@test.local', '{"full_name":"Ben"}'::jsonb),
  ('d1000000-0000-0000-0000-000000000003', 'groups-c@test.local', '{"full_name":"Cy"}'::jsonb),
  ('d1000000-0000-0000-0000-000000000004', 'groups-d@test.local', '{"full_name":"Dee"}'::jsonb);

insert into auth.users (id, email, raw_user_meta_data)
select ('d1000000-0000-0000-0001-' || lpad(i::text, 12, '0'))::uuid,
       'groups-x' || i || '@test.local',
       jsonb_build_object('full_name', 'X' || i)
from generate_series(1, 48) as i;

update public.profiles set venmo_username = 'ana-venmo'
where id = 'd1000000-0000-0000-0000-000000000001';

-- ===========================================================================
-- Criterion 8 (structure): RLS, grants
-- ===========================================================================
select ok(
  (select bool_and(c.relrowsecurity) and count(*) = 4
   from pg_class as c
   where c.oid in ('public.groups'::regclass, 'public.group_members'::regclass,
                   'public.group_hidden'::regclass, 'public.group_events'::regclass)),
  'c8: RLS is enabled on groups, group_members, group_hidden and group_events');

select ok(
  not exists (
    select 1
    from unnest(array['public.groups', 'public.group_members', 'public.group_hidden',
                      'public.group_events']) as t(name)
    where has_table_privilege('anon', t.name,
            'select, insert, update, delete, truncate, references, trigger')
       or has_any_column_privilege('anon', t.name, 'select, insert, update, references')
       or has_table_privilege('public', t.name,
            'select, insert, update, delete, truncate, references, trigger')),
  'c8: anon and public hold no privilege on any of the four tables');

select ok(
  has_table_privilege('authenticated', 'public.groups', 'select')
  and has_table_privilege('authenticated', 'public.group_members', 'select')
  and has_table_privilege('authenticated', 'public.group_events', 'select')
  and not has_any_column_privilege('authenticated', 'public.group_hidden',
        'select, insert, update, references')
  and not exists (
    select 1
    from unnest(array['public.groups', 'public.group_members', 'public.group_hidden',
                      'public.group_events']) as t(name)
    where has_table_privilege('authenticated', t.name,
            'insert, update, delete, truncate, references, trigger')
       or has_any_column_privilege('authenticated', t.name, 'insert, update, references')),
  'c8: authenticated has exactly SELECT on groups, group_members, group_events and nothing on group_hidden');

select ok(
  not has_table_privilege('service_role', 'public.group_events', 'insert, update, delete, truncate'),
  'audit: service_role cannot insert, update, delete or truncate group_events');

select ok(
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']) and count(*) = 10
   from pg_proc as p
   where p.oid in ('public.create_group(uuid, text)'::regprocedure,
                   'public.join_group(text)'::regprocedure,
                   'public.rename_group(uuid, text)'::regprocedure,
                   'public.rotate_group_code(uuid)'::regprocedure,
                   'public.set_group_hidden(uuid, boolean)'::regprocedure,
                   'public.my_groups()'::regprocedure,
                   'public.leave_group(uuid)'::regprocedure,
                   'private.is_group_member(uuid)'::regprocedure,
                   'private.shares_group_with(uuid)'::regprocedure,
                   'private.log_group_event(uuid, uuid, text, jsonb)'::regprocedure)),
  'every new function is security definer with an empty search_path');

select ok(
  (select bool_and(has_function_privilege('authenticated', f, 'execute')
                   and not has_function_privilege('anon', f, 'execute'))
   from unnest(array['public.create_group(uuid, text)', 'public.join_group(text)',
                     'public.rename_group(uuid, text)', 'public.rotate_group_code(uuid)',
                     'public.set_group_hidden(uuid, boolean)', 'public.my_groups()',
                     'public.leave_group(uuid)']) as f)
  and not exists (
    select 1 from pg_proc as p, aclexplode(p.proacl) as a
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('create_group', 'join_group', 'rename_group', 'rotate_group_code',
                        'set_group_hidden', 'my_groups', 'leave_group')
      and a.grantee in (0::oid, 'anon'::regrole::oid))
  and not has_function_privilege('authenticated', 'private.log_group_event(uuid, uuid, text, jsonb)', 'execute')
  and not has_function_privilege('service_role', 'private.log_group_event(uuid, uuid, text, jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'private.group_name(text)', 'execute'),
  'c9: only authenticated may execute the group functions; nobody but the owner may call log_group_event');

select is(
  (select array_agg(polname::text) from pg_policy
   where polrelid = 'public.profiles'::regclass and polcmd in ('r', '*') and polpermissive),
  array['profiles_select_own_or_co_participant_or_co_member'],
  'one permissive SELECT policy on profiles');

-- ===========================================================================
-- Criterion 10 + 113: create_group names
-- ===========================================================================
select pg_temp.act('d1000000-0000-0000-0000-000000000001');
set local role authenticated;

select throws_ok(
  $$ select public.create_group('d1000000-0000-0000-0000-0000000000b0', '') $$,
  '22023', 'invalid_name', 'c10: a 0-code-point name -> 22023 invalid_name');
select throws_ok(
  format($$ select public.create_group('d1000000-0000-0000-0000-0000000000b0', %L) $$, repeat('a', 61)),
  '22023', 'invalid_name', 'c10: a 61-code-point name -> 22023 invalid_name');
select throws_ok(
  format($$ select public.create_group('d1000000-0000-0000-0000-0000000000b0', %L) $$, repeat('😀', 61)),
  '22023', 'invalid_name', 'c10: 61 emoji -> 22023 invalid_name');
select throws_ok(
  format($$ select public.create_group('d1000000-0000-0000-0000-0000000000b0', %L) $$, E'\t\n'),
  '22023', 'invalid_name', 'c113: a name of only "\t\n" -> 22023 invalid_name');
select throws_ok(
  format($$ select public.create_group('d1000000-0000-0000-0000-0000000000b0', %L) $$,
         ' ' || chr(9) || chr(10) || chr(13) || chr(11) || chr(12)),
  '22023', 'invalid_name', 'c113: a name of only the six trimmed characters -> invalid_name');
select throws_ok(
  $$ select public.create_group('d1000000-0000-0000-0000-0000000000b0', null) $$,
  '22023', 'invalid_name', 'c10: a null name -> 22023 invalid_name');
select throws_ok(
  $$ select public.create_group(null, 'Tahoe trip') $$,
  '22023', 'invalid_id', 'create_group with a null id -> 22023 invalid_id');

select is(
  public.create_group('d1000000-0000-0000-0000-0000000000a1', 'Tahoe trip'),
  'd1000000-0000-0000-0000-0000000000a1'::uuid,
  'c10: create_group returns the client-generated id');
select is(
  public.create_group('d1000000-0000-0000-0000-0000000000a2', 'T'),
  'd1000000-0000-0000-0000-0000000000a2'::uuid,
  'c10: a 1-code-point name succeeds');
-- Created first: a select can't see a row inserted by a function called in its own WHERE.
select public.create_group('d1000000-0000-0000-0000-0000000000a3', repeat('b', 60));
select public.create_group('d1000000-0000-0000-0000-0000000000a4', repeat('😀', 60));
select public.create_group('d1000000-0000-0000-0000-0000000000a5', '  ' || chr(11) || 'Cabin weekend' || chr(9) || chr(12) || ' ');
select public.create_group('d1000000-0000-0000-0000-0000000000a6', 'Lake' || chr(160));
select is(
  (select char_length(name) from public.groups where id = 'd1000000-0000-0000-0000-0000000000a3'),
  60, 'c10: a 60-code-point name succeeds and is stored whole');
select is(
  (select name from public.groups where id = 'd1000000-0000-0000-0000-0000000000a4'),
  repeat('😀', 60), 'c10: 60 emoji succeed');
select is(
  (select name from public.groups where id = 'd1000000-0000-0000-0000-0000000000a5'),
  'Cabin weekend', 'c113: leading and trailing space, \t, \v, \f are trimmed before storing');
select is(
  (select name from public.groups where id = 'd1000000-0000-0000-0000-0000000000a6'),
  'Lake' || chr(160), 'c113: a trailing non-breaking space is kept (same as normalizeTitle)');

reset role;
select results_eq(
  $$ select user_id from public.group_members where group_id = 'd1000000-0000-0000-0000-0000000000a1' $$,
  $$ values ('d1000000-0000-0000-0000-000000000001'::uuid) $$,
  'c10: the caller is the only member');
select results_eq(
  $$ select actor_id, kind, details from public.group_events
     where group_id = 'd1000000-0000-0000-0000-0000000000a1' $$,
  $$ values ('d1000000-0000-0000-0000-000000000001'::uuid, 'group_created'::text,
             '{"name":"Tahoe trip"}'::jsonb) $$,
  'c10: one group_created event {name}');

-- Signed out
select pg_temp.signed_out();
set local role authenticated;
select throws_ok(
  $$ select public.create_group('d1000000-0000-0000-0000-0000000000b1', 'Nope') $$,
  '42501', 'not_allowed', 'create_group signed out -> 42501 not_allowed');
select throws_ok(
  $$ select public.join_group('0123456789abcdef0123') $$,
  '42501', 'not_allowed', 'join_group signed out -> 42501 not_allowed');
reset role;

-- ===========================================================================
-- Criterion 102: create_group retry
-- ===========================================================================
select pg_temp.act('d1000000-0000-0000-0000-000000000001');
set local role authenticated;
select is(
  public.create_group('d1000000-0000-0000-0000-0000000000a1', ' Tahoe trip' || chr(9)),
  'd1000000-0000-0000-0000-0000000000a1'::uuid,
  'c102: a retry with the same id and (trimmed) name returns the same id');
select throws_ok(
  $$ select public.create_group('d1000000-0000-0000-0000-0000000000a1', 'Other name') $$,
  '22023', 'id_conflict', 'c102: same id, different name -> 22023 id_conflict');
reset role;
select pg_temp.act('d1000000-0000-0000-0000-000000000002');
set local role authenticated;
select throws_ok(
  $$ select public.create_group('d1000000-0000-0000-0000-0000000000a1', 'Tahoe trip') $$,
  '22023', 'id_conflict', 'c102: same id and name from another caller -> 22023 id_conflict');
reset role;
select ok(
  (select count(*) from public.groups where id = 'd1000000-0000-0000-0000-0000000000a1') = 1
  and (select count(*) from public.group_members where group_id = 'd1000000-0000-0000-0000-0000000000a1') = 1
  and (select count(*) from public.group_events where group_id = 'd1000000-0000-0000-0000-0000000000a1') = 1,
  'c102: after the retries there is one group, one member and one group_created event');

-- ===========================================================================
-- Criterion 8 (writes): direct INSERT / UPDATE / DELETE by authenticated -> 42501
-- (Ana is a member of G1, so RLS would let her see the rows; the missing grant refuses.)
-- ===========================================================================
select pg_temp.act('d1000000-0000-0000-0000-000000000001');
set local role authenticated;
select throws_ok(
  $$ insert into public.groups (id, name, join_code, created_by)
     values ('d1000000-0000-0000-0000-0000000000b2', 'X', 'aaaaaaaaaaaaaaaaaaaa',
             'd1000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'c8: insert into groups -> 42501');
select throws_ok(
  $$ update public.groups set name = 'Hacked' where id = 'd1000000-0000-0000-0000-0000000000a1' $$,
  '42501', null, 'c8: update groups -> 42501');
select throws_ok(
  $$ delete from public.groups where id = 'd1000000-0000-0000-0000-0000000000a1' $$,
  '42501', null, 'c8: delete from groups -> 42501');
select throws_ok(
  $$ insert into public.group_members (group_id, user_id)
     values ('d1000000-0000-0000-0000-0000000000a1', 'd1000000-0000-0000-0000-000000000003') $$,
  '42501', null, 'c8: insert into group_members -> 42501');
select throws_ok(
  $$ update public.group_members set joined_at = now()
     where group_id = 'd1000000-0000-0000-0000-0000000000a1' $$,
  '42501', null, 'c8: update group_members -> 42501');
select throws_ok(
  $$ delete from public.group_members where group_id = 'd1000000-0000-0000-0000-0000000000a1' $$,
  '42501', null, 'c8: delete from group_members -> 42501');
select throws_ok(
  $$ select group_id from public.group_hidden where user_id = 'd1000000-0000-0000-0000-000000000001' $$,
  '42501', null, 'c8: select on group_hidden (own rows) -> 42501');
select throws_ok(
  $$ insert into public.group_hidden (group_id, user_id)
     values ('d1000000-0000-0000-0000-0000000000a1', 'd1000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'c8: insert into group_hidden -> 42501');
select throws_ok(
  $$ update public.group_hidden set hidden_at = now()
     where user_id = 'd1000000-0000-0000-0000-000000000001' $$,
  '42501', null, 'c8: update group_hidden -> 42501');
select throws_ok(
  $$ delete from public.group_hidden where user_id = 'd1000000-0000-0000-0000-000000000001' $$,
  '42501', null, 'c8: delete from group_hidden -> 42501');
select throws_ok(
  $$ insert into public.group_events (group_id, actor_id, kind)
     values ('d1000000-0000-0000-0000-0000000000a1', 'd1000000-0000-0000-0000-000000000001', 'renamed') $$,
  '42501', null, 'c8: insert into group_events -> 42501');
select throws_ok(
  $$ update public.group_events set details = '{}'
     where group_id = 'd1000000-0000-0000-0000-0000000000a1' $$,
  '42501', null, 'c8: update group_events -> 42501');
select throws_ok(
  $$ delete from public.group_events where group_id = 'd1000000-0000-0000-0000-0000000000a1' $$,
  '42501', null, 'c8: delete from group_events -> 42501');
-- A member reads all three readable tables (positive control for the 0-row checks below).
select ok(
  (select count(*) from public.groups where id = 'd1000000-0000-0000-0000-0000000000a1') = 1
  and (select count(*) from public.group_members where group_id = 'd1000000-0000-0000-0000-0000000000a1') = 1
  and (select count(*) from public.group_events where group_id = 'd1000000-0000-0000-0000-0000000000a1') = 1,
  'c9 (control): a member sees the group, its members and its events');
reset role;

-- ===========================================================================
-- Criterion 9: a non-member (Cy) sees nothing and every function refuses
-- ===========================================================================
select pg_temp.act('d1000000-0000-0000-0000-000000000003');
set local role authenticated;
select is((select count(*)::integer from public.groups where id = 'd1000000-0000-0000-0000-0000000000a1'),
  0, 'c9: a non-member selects 0 groups rows');
select is((select count(*)::integer from public.group_members where group_id = 'd1000000-0000-0000-0000-0000000000a1'),
  0, 'c9: a non-member selects 0 group_members rows');
select is((select count(*)::integer from public.group_events where group_id = 'd1000000-0000-0000-0000-0000000000a1'),
  0, 'c9: a non-member selects 0 group_events rows');
select throws_ok(
  $$ select public.rename_group('d1000000-0000-0000-0000-0000000000a1', 'Mine now') $$,
  '42501', 'not_allowed', 'c9: rename_group by a non-member -> 42501 not_allowed');
select throws_ok(
  $$ select public.rename_group('d1000000-0000-0000-0000-0000000000a1', '') $$,
  '42501', 'not_allowed', 'c9: a non-member gets not_allowed even with a bad name (checked first)');
select throws_ok(
  $$ select public.rotate_group_code('d1000000-0000-0000-0000-0000000000a1') $$,
  '42501', 'not_allowed', 'c9: rotate_group_code by a non-member -> 42501 not_allowed');
select throws_ok(
  $$ select public.set_group_hidden('d1000000-0000-0000-0000-0000000000a1', true) $$,
  '42501', 'not_allowed', 'c9: set_group_hidden by a non-member -> 42501 not_allowed');
select throws_ok(
  $$ select public.leave_group('d1000000-0000-0000-0000-0000000000a1') $$,
  '42501', 'not_allowed', 'c9: leave_group by a non-member -> 42501 not_allowed');
select throws_ok(
  $$ select public.rename_group('d1000000-0000-0000-0000-0000000000ff', 'Ghost') $$,
  '42501', 'not_allowed', 'c9: a group that does not exist gives the same 42501 not_allowed');
select is((select count(*)::integer from public.my_groups()), 0,
  'c9: my_groups() for a user in no group is empty');
select is(
  (select count(*)::integer from public.profiles where id = 'd1000000-0000-0000-0000-000000000001'),
  0, 'c12: a stranger gets 0 profiles rows for a group member');
reset role;

set local role anon;
select throws_ok($$ select public.create_group('d1000000-0000-0000-0000-0000000000b3', 'A') $$,
  '42501', null, 'c9: anon cannot execute create_group');
select throws_ok($$ select public.join_group('0123456789abcdef0123') $$,
  '42501', null, 'c9: anon cannot execute join_group');
select throws_ok($$ select public.rename_group('d1000000-0000-0000-0000-0000000000a1', 'A') $$,
  '42501', null, 'c9: anon cannot execute rename_group');
select throws_ok($$ select public.rotate_group_code('d1000000-0000-0000-0000-0000000000a1') $$,
  '42501', null, 'c9: anon cannot execute rotate_group_code');
select throws_ok($$ select public.set_group_hidden('d1000000-0000-0000-0000-0000000000a1', true) $$,
  '42501', null, 'c9: anon cannot execute set_group_hidden');
select throws_ok($$ select * from public.my_groups() $$,
  '42501', null, 'c9: anon cannot execute my_groups');
select throws_ok($$ select public.leave_group('d1000000-0000-0000-0000-0000000000a1') $$,
  '42501', null, 'c9: anon cannot execute leave_group');
select throws_ok($$ select id from public.groups limit 1 $$,
  '42501', null, 'c8: anon select on groups -> 42501');
reset role;

-- ===========================================================================
-- Criterion 11: join_group
-- ===========================================================================
select set_config('test.code1',
  (select join_code from public.groups where id = 'd1000000-0000-0000-0000-0000000000a1'), true);

select pg_temp.act('d1000000-0000-0000-0000-000000000002');
set local role authenticated;
select throws_ok($$ select public.join_group('not-a-code') $$,
  'P0002', 'invalid_code', 'c11: a malformed code -> P0002 invalid_code');
select throws_ok($$ select public.join_group('ffffffffffffffffffff') $$,
  'P0002', 'invalid_code', 'c11: an unknown well-formed code -> P0002 invalid_code');
select throws_ok($$ select public.join_group(null) $$,
  'P0002', 'invalid_code', 'c11: a null code -> P0002 invalid_code');
select is(public.join_group(current_setting('test.code1')),
  'd1000000-0000-0000-0000-0000000000a1'::uuid, 'c11: a good code returns the group id');
select is(public.join_group(current_setting('test.code1')),
  'd1000000-0000-0000-0000-0000000000a1'::uuid, 'c11: a second call returns the same id');
reset role;
select ok(
  (select count(*) from public.group_members
   where group_id = 'd1000000-0000-0000-0000-0000000000a1'
     and user_id = 'd1000000-0000-0000-0000-000000000002') = 1
  and (select count(*) from public.group_events
       where group_id = 'd1000000-0000-0000-0000-0000000000a1' and kind = 'member_joined'
         and actor_id = 'd1000000-0000-0000-0000-000000000002' and details = '{}'::jsonb) = 1,
  'c11: two joins add Ben once and log one member_joined');

-- ===========================================================================
-- Criterion 12: profiles through co-membership
-- ===========================================================================
select ok(
  not exists (
    select 1 from public.bill_participants as a
    join public.bill_participants as b on b.bill_id = a.bill_id
    where a.user_id = 'd1000000-0000-0000-0000-000000000001'
      and b.user_id = 'd1000000-0000-0000-0000-000000000002'),
  'c12 (precondition, as postgres): Ana and Ben share no bill');
select pg_temp.act('d1000000-0000-0000-0000-000000000002');
set local role authenticated;
select results_eq(
  $$ select display_name, venmo_username from public.profiles
     where id = 'd1000000-0000-0000-0000-000000000001' $$,
  $$ values ('Ana'::text, 'ana-venmo'::text) $$,
  'c12: a co-member who shares no bill reads display_name and venmo_username');
select throws_ok(
  $$ select * from public.profiles where id = 'd1000000-0000-0000-0000-000000000001' $$,
  '42501', null, 'c12: select * on profiles still fails with 42501 for a co-member');
reset role;
select pg_temp.act('d1000000-0000-0000-0000-000000000001');
set local role authenticated;
select throws_ok(
  $$ select * from public.profiles where id = 'd1000000-0000-0000-0000-000000000001' $$,
  '42501', null, 'c12: select * on profiles still fails with 42501 for the owner');
reset role;

-- ===========================================================================
-- Criterion 13: rename_group, rotate_group_code (by Ben, not the creator)
-- ===========================================================================
select pg_temp.act('d1000000-0000-0000-0000-000000000002');
set local role authenticated;
select lives_ok(
  format($$ select public.rename_group('d1000000-0000-0000-0000-0000000000a1', %L) $$,
         '  Tahoe 2026' || chr(9)),
  'c13: any member can rename');
select throws_ok(
  $$ select public.rename_group('d1000000-0000-0000-0000-0000000000a1', '   ') $$,
  '22023', 'invalid_name', 'c13: rename to a blank name -> 22023 invalid_name');
select throws_ok(
  format($$ select public.rename_group('d1000000-0000-0000-0000-0000000000a1', %L) $$, repeat('c', 61)),
  '22023', 'invalid_name', 'c13: rename to 61 code points -> 22023 invalid_name');
select lives_ok(
  format($$ select public.rename_group('d1000000-0000-0000-0000-0000000000a1', %L) $$,
         'Tahoe 2026' || chr(10)),
  'c102/N4: renaming to the same trimmed name succeeds');
select set_config('test.code2',
  public.rotate_group_code('d1000000-0000-0000-0000-0000000000a1'), true);
reset role;

select is(
  (select name from public.groups where id = 'd1000000-0000-0000-0000-0000000000a1'),
  'Tahoe 2026', 'c13: the trimmed new name is stored');
select results_eq(
  $$ select actor_id, details from public.group_events
     where group_id = 'd1000000-0000-0000-0000-0000000000a1' and kind = 'renamed' $$,
  $$ values ('d1000000-0000-0000-0000-000000000002'::uuid,
             '{"from":"Tahoe trip","to":"Tahoe 2026"}'::jsonb) $$,
  'c13/N4: exactly one renamed {from, to} event (the same-name rename logged nothing)');
select ok(
  current_setting('test.code2') ~ '^[0-9a-f]{20}$'
  and current_setting('test.code2') <> current_setting('test.code1')
  and (select join_code from public.groups where id = 'd1000000-0000-0000-0000-0000000000a1')
      = current_setting('test.code2'),
  'c13: rotate_group_code returns and stores a new 20-hex code');
select results_eq(
  $$ select actor_id, details from public.group_events
     where group_id = 'd1000000-0000-0000-0000-0000000000a1' and kind = 'link_rotated' $$,
  $$ values ('d1000000-0000-0000-0000-000000000002'::uuid, '{}'::jsonb) $$,
  'c13: one link_rotated event with {} (no code)');

select pg_temp.act('d1000000-0000-0000-0000-000000000003');
set local role authenticated;
select throws_ok(
  format($$ select public.join_group(%L) $$, current_setting('test.code1')),
  'P0002', 'invalid_code', 'c13: the old code no longer joins');
reset role;
select pg_temp.act('d1000000-0000-0000-0000-000000000004');
set local role authenticated;
select is(public.join_group(current_setting('test.code2')),
  'd1000000-0000-0000-0000-0000000000a1'::uuid, 'c13: the new code joins (Dee)');
reset role;

-- ===========================================================================
-- Criterion 15: append-only, insertion order
-- ===========================================================================
select is(
  (select array_agg(kind order by seq) from public.group_events
   where group_id = 'd1000000-0000-0000-0000-0000000000a1'),
  array['group_created', 'member_joined', 'renamed', 'link_rotated', 'member_joined'],
  'c15: events written in one transaction (same created_at) come back in insertion order by seq');
select throws_ok(
  $$ update public.group_events set details = '{"x":1}'
     where group_id = 'd1000000-0000-0000-0000-0000000000a1' $$,
  '42501', 'group_events_append_only', 'c15: UPDATE on group_events fails even for postgres');
select throws_ok(
  $$ delete from public.group_events where group_id = 'd1000000-0000-0000-0000-0000000000a1' $$,
  '42501', 'group_events_append_only', 'c15: DELETE on group_events fails even for postgres');
select throws_ok(
  $$ truncate public.group_events $$,
  '42501', 'group_events_append_only', 'c15: TRUNCATE on group_events fails even for postgres');
set local role service_role;
select throws_ok(
  $$ insert into public.group_events (group_id, kind)
     values ('d1000000-0000-0000-0000-0000000000a1', 'renamed') $$,
  '42501', null, 'c15: service_role cannot insert (forge) group_events');
select throws_ok(
  $$ delete from public.group_events where group_id = 'd1000000-0000-0000-0000-0000000000a1' $$,
  '42501', null, 'c15: service_role cannot delete group_events');
reset role;
select throws_ok(
  $$ insert into public.group_events (group_id, kind)
     values ('d1000000-0000-0000-0000-0000000000a1', 'not_a_kind') $$,
  '23514', null, 'group_events_kind_known refuses an unknown kind');

-- ===========================================================================
-- Criterion 14: set_group_hidden changes nothing shared
-- ===========================================================================
-- Backdate first, so a rewrite of these values would show (lessons 2026-11-25).
update public.groups set created_at = '2020-01-01 00:00:00+00'
where id = 'd1000000-0000-0000-0000-0000000000a1';
update public.group_members
set joined_at = '2020-01-02 00:00:00+00'::timestamptz
                + (right(user_id::text, 1)::integer * interval '1 hour')
where group_id = 'd1000000-0000-0000-0000-0000000000a1';
select set_config('test.shared_before', (
  select jsonb_build_object(
    'g', (select to_jsonb(g) from public.groups as g where g.id = 'd1000000-0000-0000-0000-0000000000a1'),
    'm', (select jsonb_agg(to_jsonb(m) order by m.user_id) from public.group_members as m
          where m.group_id = 'd1000000-0000-0000-0000-0000000000a1'),
    'e', (select count(*) from public.group_events where group_id = 'd1000000-0000-0000-0000-0000000000a1')
  ))::text, true);

select pg_temp.act('d1000000-0000-0000-0000-000000000002');
set local role authenticated;
select lives_ok($$ select public.set_group_hidden('d1000000-0000-0000-0000-0000000000a1', true) $$,
  'c14: a member hides the group');
select lives_ok($$ select public.set_group_hidden('d1000000-0000-0000-0000-0000000000a1', true) $$,
  'c14: hiding again is a no-op');
select throws_ok($$ select public.set_group_hidden('d1000000-0000-0000-0000-0000000000a1', null) $$,
  '22023', 'invalid_hidden', 'set_group_hidden with null -> 22023 invalid_hidden');
select results_eq(
  $$ select id, name, member_count, hidden from public.my_groups()
     where id = 'd1000000-0000-0000-0000-0000000000a1' $$,
  $$ values ('d1000000-0000-0000-0000-0000000000a1'::uuid, 'Tahoe 2026'::text, 3, true) $$,
  'c14: my_groups() shows hidden = true for the caller, with name and member_count');
reset role;
select pg_temp.act('d1000000-0000-0000-0000-000000000001');
set local role authenticated;
select results_eq(
  $$ select hidden from public.my_groups() where id = 'd1000000-0000-0000-0000-0000000000a1' $$,
  $$ values (false) $$,
  'c14: another member''s my_groups() shows hidden = false');
-- Ana is in G1 (joined 2020-01-02 01:00 after backdating) and G2..G6 (joined now, same instant):
-- newest membership first, ties by id.
select results_eq(
  $$ select id from public.my_groups() $$,
  $$ values ('d1000000-0000-0000-0000-0000000000a2'::uuid), ('d1000000-0000-0000-0000-0000000000a3'::uuid),
            ('d1000000-0000-0000-0000-0000000000a4'::uuid), ('d1000000-0000-0000-0000-0000000000a5'::uuid),
            ('d1000000-0000-0000-0000-0000000000a6'::uuid), ('d1000000-0000-0000-0000-0000000000a1'::uuid) $$,
  'my_groups() orders by joined_at desc, then id');
reset role;
select is(
  (select jsonb_build_object(
    'g', (select to_jsonb(g) from public.groups as g where g.id = 'd1000000-0000-0000-0000-0000000000a1'),
    'm', (select jsonb_agg(to_jsonb(m) order by m.user_id) from public.group_members as m
          where m.group_id = 'd1000000-0000-0000-0000-0000000000a1'),
    'e', (select count(*) from public.group_events where group_id = 'd1000000-0000-0000-0000-0000000000a1')
  )),
  current_setting('test.shared_before')::jsonb,
  'c14: hiding wrote no group_events row and changed no groups / group_members row (backdated values intact)');

select pg_temp.act('d1000000-0000-0000-0000-000000000002');
set local role authenticated;
select public.set_group_hidden('d1000000-0000-0000-0000-0000000000a1', false);
select results_eq(
  $$ select hidden from public.my_groups() where id = 'd1000000-0000-0000-0000-0000000000a1' $$,
  $$ values (false) $$,
  'c14: unhiding shows hidden = false again');
reset role;

-- ===========================================================================
-- leave_group (C-G10 as far as T2 goes)
-- ===========================================================================
-- Dee hides G1 first, so leaving must also remove her hidden row.
select pg_temp.act('d1000000-0000-0000-0000-000000000004');
set local role authenticated;
select public.set_group_hidden('d1000000-0000-0000-0000-0000000000a1', true);
select lives_ok($$ select public.leave_group('d1000000-0000-0000-0000-0000000000a1') $$,
  'leave_group: a member with no history leaves');
select is((select count(*)::integer from public.groups where id = 'd1000000-0000-0000-0000-0000000000a1'),
  0, 'leave_group: after leaving, Dee can no longer read the group');
select throws_ok($$ select public.leave_group('d1000000-0000-0000-0000-0000000000a1') $$,
  '42501', 'not_allowed', 'leave_group: leaving again -> 42501 not_allowed (no longer a member)');
reset role;
select ok(
  not exists (select 1 from public.group_members
              where group_id = 'd1000000-0000-0000-0000-0000000000a1'
                and user_id = 'd1000000-0000-0000-0000-000000000004')
  and not exists (select 1 from public.group_hidden
                  where group_id = 'd1000000-0000-0000-0000-0000000000a1'
                    and user_id = 'd1000000-0000-0000-0000-000000000004')
  and (select count(*) from public.group_members
       where group_id = 'd1000000-0000-0000-0000-0000000000a1') = 2,
  'leave_group: Dee''s membership and hidden row are gone; Ana and Ben stay');
select results_eq(
  $$ select actor_id, details from public.group_events
     where group_id = 'd1000000-0000-0000-0000-0000000000a1' and kind = 'member_left' $$,
  $$ values ('d1000000-0000-0000-0000-000000000004'::uuid, '{}'::jsonb) $$,
  'leave_group: one member_left event');

select pg_temp.act('d1000000-0000-0000-0000-000000000001');
set local role authenticated;
select throws_ok($$ select public.leave_group('d1000000-0000-0000-0000-0000000000a2') $$,
  '22023', 'cannot_leave', 'leave_group: the only member -> 22023 cannot_leave');
reset role;

-- A row that references the membership with ON DELETE RESTRICT (what T3-T5's expenses,
-- payments and bills add) makes the delete fail with 23503, answered as cannot_leave.
-- A real table (temporary tables can't reference permanent ones); the test's rollback drops it.
create table private.groups_test_fake_history (
  group_id uuid not null,
  user_id uuid not null,
  foreign key (group_id, user_id) references public.group_members (group_id, user_id) on delete restrict
);
insert into private.groups_test_fake_history values
  ('d1000000-0000-0000-0000-0000000000a1', 'd1000000-0000-0000-0000-000000000002');
select pg_temp.act('d1000000-0000-0000-0000-000000000002');
set local role authenticated;
select throws_ok($$ select public.leave_group('d1000000-0000-0000-0000-0000000000a1') $$,
  '22023', 'cannot_leave', 'leave_group: a restrict FK on the membership (23503) -> 22023 cannot_leave');
reset role;
select is(
  (select count(*)::integer from public.group_members
   where group_id = 'd1000000-0000-0000-0000-0000000000a1'
     and user_id = 'd1000000-0000-0000-0000-000000000002'),
  1, 'leave_group: the refused leave changed nothing');

-- S8: membership blocks account deletion (restrict).
select throws_ok(
  $$ delete from public.profiles where id = 'd1000000-0000-0000-0000-000000000002' $$,
  '23503', null, 'S8: deleting a group member''s profile fails (group_members.user_id restrict)');

-- ===========================================================================
-- 50-member cap (A1.7 / criterion 97)
-- ===========================================================================
select pg_temp.act('d1000000-0000-0000-0000-000000000001');
set local role authenticated;
select public.create_group('d1000000-0000-0000-0000-0000000000a7', 'Big trip');
reset role;
-- 48 extra members as postgres: Ana + 48 = 49.
insert into public.group_members (group_id, user_id)
select 'd1000000-0000-0000-0000-0000000000a7', ('d1000000-0000-0000-0001-' || lpad(i::text, 12, '0'))::uuid
from generate_series(1, 48) as i;
select set_config('test.code7',
  (select join_code from public.groups where id = 'd1000000-0000-0000-0000-0000000000a7'), true);

select pg_temp.act('d1000000-0000-0000-0000-000000000004');
set local role authenticated;
select is(public.join_group(current_setting('test.code7')),
  'd1000000-0000-0000-0000-0000000000a7'::uuid, 'cap: the 50th member can join');
reset role;
select pg_temp.act('d1000000-0000-0000-0000-000000000003');
set local role authenticated;
select throws_ok(format($$ select public.join_group(%L) $$, current_setting('test.code7')),
  '22023', 'group_full', 'c97: joining a group with 50 members -> 22023 group_full');
reset role;
select is(
  (select count(*)::integer from public.group_members where group_id = 'd1000000-0000-0000-0000-0000000000a7'),
  50, 'cap: the group still has exactly 50 members');
select pg_temp.act('d1000000-0000-0000-0000-000000000004');
set local role authenticated;
select is(public.join_group(current_setting('test.code7')),
  'd1000000-0000-0000-0000-0000000000a7'::uuid,
  'cap: a current member re-joining a full group is still a no-op success');
reset role;

-- ===========================================================================
-- Criterion 34: lock order, from the function bodies
-- ===========================================================================
create function pg_temp.body(p regprocedure) returns text language sql as $$
  select lower(prosrc) from pg_proc where oid = p
$$;

select ok(
  position('for no key update' in pg_temp.body('public.join_group(text)'))
    between 1 and position('from public.group_members' in pg_temp.body('public.join_group(text)')) - 1
  and position('for no key update' in pg_temp.body('public.join_group(text)'))
    < position('insert into public.group_members' in pg_temp.body('public.join_group(text)')),
  'c34(a,b): join_group takes the group row FOR NO KEY UPDATE before reading or writing members');
select ok(
  position('from public.group_members' in pg_temp.body('public.leave_group(uuid)'))
    < position('for no key update' in pg_temp.body('public.leave_group(uuid)'))
  and position('for no key update' in pg_temp.body('public.leave_group(uuid)'))
    < position('delete from public.group_members' in pg_temp.body('public.leave_group(uuid)'))
  and position('foreign_key_violation' in pg_temp.body('public.leave_group(uuid)'))
    > position('delete from public.group_members' in pg_temp.body('public.leave_group(uuid)'))
  and pg_temp.body('public.leave_group(uuid)') !~ 'for update\s*;',
  'c34(a,d): leave_group checks membership unlocked, then FOR NO KEY UPDATE (never FOR UPDATE) on the group, then deletes, mapping 23503');
select ok(
  position('for no key update' in pg_temp.body('public.rename_group(uuid, text)'))
    between 1 and position('update public.groups' in pg_temp.body('public.rename_group(uuid, text)')) - 1,
  'c34: rename_group locks the group row before updating it');
select ok(
  position('for update' in pg_temp.body('public.rotate_group_code(uuid)'))
    between 1 and position('update public.groups' in pg_temp.body('public.rotate_group_code(uuid)')) - 1,
  'c34: rotate_group_code takes FOR UPDATE on the group row before changing join_code');
select ok(
  pg_temp.body('public.set_group_hidden(uuid, boolean)') not like '%for %update%'
  and pg_temp.body('public.set_group_hidden(uuid, boolean)') not like '%public.groups%',
  'c34: set_group_hidden takes no group lock');

select * from finish();
rollback;
