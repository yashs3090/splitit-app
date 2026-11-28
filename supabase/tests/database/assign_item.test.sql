-- pgTAP tests for the Groups T7 migration (20261127062139_assign_item.sql; spec
-- docs/specs/2026-11-26-groups-mvp.md C-G12, criteria 38-44, 96 (kinds), 103, Amendment A1
-- (A1.3, A1.6); eng review S3, S4, B4).
--
-- Every assertion filters to the fixture users / group / bills below (the local DB may hold real
-- data). Fixture user ids start with e7a00000.
-- Users: Ana ..01 (creates G1, hosts GB and NB), Ben ..02, Cy ..03, Eve ..05 (members of G1),
--   Dee ..04 (stranger to G1), Fay ..06 (member of G1 inserted without participant rows, for the
--   23503 mapping), Gus ..07 (member who "leaves" during the lock, S4).
-- Bills: GB (in G1): Tacos, Nachos, Wings, Beer (2 units), Fries, Chips, Soda.
--        NB (not in a group; Ana hosts, Ben joined): Salad.
--
-- A real two-session race can't run in pgTAP (one transaction, one connection). The detach /
-- leave races (S4, criterion 103) are checked two ways: the function body takes its locks and
-- re-checks in the order the migration header gives (static, from pg_proc), and a test copy of
-- private.lock_bill_key_share applies the concurrent change at the moment the lock is granted,
-- so the re-checks under the lock must catch it.

begin;

create extension if not exists pgtap with schema extensions;

select plan(64);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function pg_temp.u(p text) returns uuid language sql immutable as $$
  select ('e7a00000-0000-0000-0000-0000000000' || p)::uuid
$$;
create function pg_temp.g1() returns uuid language sql immutable as $$
  select 'e7a00000-0000-0000-0000-0000000000a1'::uuid
$$;

create function pg_temp.act(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

create function pg_temp.body() returns text language sql as $$
  select lower(prosrc) from pg_proc where oid = 'public.assign_item(uuid, jsonb, jsonb)'::regprocedure
$$;

create function pg_temp.it(p_pos integer, p_name text, p_cents integer) returns jsonb
language sql immutable as $$
  select jsonb_build_object('name', p_name, 'note', null, 'group_position', p_pos,
    'unit_index', 0, 'group_size', 1, 'total_cents', p_cents);
$$;

create function pg_temp.bid(p_tag text) returns uuid language sql stable as
  $$ select current_setting('test.bill_' || p_tag)::uuid $$;
create function pg_temp.li(p_tag text, p_name text, p_unit integer default 0) returns uuid
language sql stable as $$
  select li.id from public.line_items as li
  where li.bill_id = pg_temp.bid(p_tag) and li.name = p_name and li.unit_index = p_unit;
$$;

-- As p_user (authenticated): create a bill, then let each of p_joiners join it by link.
create function pg_temp.mk(p_tag text, p_host uuid, p_rows jsonb, p_total integer,
                           p_joiners uuid[]) returns void language plpgsql as $$
declare r record; j uuid;
begin
  perform pg_temp.act(p_host);
  set local role authenticated;
  select * into r from public.create_bill(p_rows, null, 0, 0, 0, 0, 0, p_total);
  reset role;
  perform set_config('test.bill_' || p_tag, r.bill_id::text, true);
  foreach j in array coalesce(p_joiners, '{}'::uuid[]) loop
    perform pg_temp.act(j);
    set local role authenticated;
    perform public.join_bill(r.join_code);
    reset role;
  end loop;
end $$;

-- SQL that runs as p_user (authenticated); used by lives_ok / throws_ok. Callers reset role after.
create function pg_temp.as_sql(p_user uuid, p_sql text) returns text language sql immutable as $$
  select format(
    'select set_config(''request.jwt.claims'', %L, true); set local role authenticated; %s',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, p_sql)
$$;
-- assign_item on GB's row p_name (unit p_unit) as p_user.
create function pg_temp.assign(p_user uuid, p_name text, p_parts jsonb, p_expected jsonb,
                               p_unit integer default 0, p_tag text default 'gb') returns text
language sql stable as $$
  select pg_temp.as_sql(p_user, format('select public.assign_item(%L::uuid, %L::jsonb, %L::jsonb)',
    pg_temp.li(p_tag, p_name, p_unit), p_parts, p_expected))
$$;
-- A parts map from (user suffix, parts) pairs.
create function pg_temp.m(variadic p text[]) returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(pg_temp.u(p[i])::text, p[i + 1]::integer), '{}'::jsonb)
  from generate_series(1, coalesce(array_length(p, 1), 0), 2) as i
$$;
-- The row's current claimer map.
create function pg_temp.claims(p_name text, p_unit integer default 0, p_tag text default 'gb')
returns jsonb language sql stable as $$
  select coalesce(jsonb_object_agg(c.user_id::text, c.parts), '{}'::jsonb)
  from public.claims as c where c.line_item_id = pg_temp.li(p_tag, p_name, p_unit)
$$;

-- Events of the fixture bills written since the last pg_temp.mark().
create temp table seen (id uuid primary key);
create function pg_temp.mark() returns void language sql as $$
  insert into seen select e.id from public.bill_events as e
  where e.bill_id in (pg_temp.bid('gb'), pg_temp.bid('nb')) on conflict do nothing;
$$;
create function pg_temp.name(p uuid) returns text language sql stable as $$
  select coalesce((select p2.display_name from public.profiles as p2 where p2.id = p), 'none')
$$;
create function pg_temp.ev() returns table (kind text, actor text, item text, details jsonb)
language sql stable as $$
  select e.kind, pg_temp.name(e.actor_id), e.item_name, e.details
  from public.bill_events as e
  where e.bill_id in (pg_temp.bid('gb'), pg_temp.bid('nb'))
    and not exists (select 1 from seen as s where s.id = e.id)
$$;

-- ---------------------------------------------------------------------------
-- Fixture
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data)
select pg_temp.u(t.k), 'assign-' || t.k || '@test.local', jsonb_build_object('full_name', t.n)
from (values ('01','Ana'),('02','Ben'),('03','Cy'),('04','Dee'),('05','Eve'),('06','Fay'),
             ('07','Gus')) as t(k, n);

-- G1: Ana creates it; Ben, Cy, Eve, Gus join.
select pg_temp.act(pg_temp.u('01'));
set local role authenticated;
select public.create_group(pg_temp.g1(), 'Tahoe trip');
reset role;
do $$
declare v_code text := (select g.join_code from public.groups as g where g.id = pg_temp.g1());
        k text;
begin
  foreach k in array array['02', '03', '05', '07'] loop
    perform pg_temp.act(pg_temp.u(k));
    set local role authenticated;
    perform public.join_group(v_code);
    reset role;
  end loop;
end $$;

-- GB: Ana's receipt, attached to G1 (every member becomes a participant).
select pg_temp.mk('gb', pg_temp.u('01'),
  jsonb_build_array(pg_temp.it(0, 'Tacos', 1000), pg_temp.it(1, 'Nachos', 800),
    pg_temp.it(2, 'Wings', 600),
    jsonb_build_object('name', 'Beer', 'note', null, 'group_position', 3, 'unit_index', 0,
      'group_size', 2, 'total_cents', 500),
    jsonb_build_object('name', 'Beer', 'note', null, 'group_position', 3, 'unit_index', 1,
      'group_size', 2, 'total_cents', 500),
    pg_temp.it(4, 'Fries', 300), pg_temp.it(5, 'Chips', 200), pg_temp.it(6, 'Soda', 100)),
  4000, null);
select pg_temp.act(pg_temp.u('01'));
set local role authenticated;
select public.attach_bill_to_group(pg_temp.bid('gb'), pg_temp.g1());
reset role;

-- NB: Ana's receipt outside any group; Ben joined by link.
select pg_temp.mk('nb', pg_temp.u('01'), jsonb_build_array(pg_temp.it(0, 'Salad', 900)), 900,
  array[pg_temp.u('02')]);

select pg_temp.mark();

-- ===========================================================================
-- Function, grants, kinds
-- ===========================================================================
select ok(
  (select p.prosecdef and p.proconfig = array['search_path=""']
     and pg_get_userbyid(p.proowner) = 'postgres'
   from pg_proc as p where p.oid = 'public.assign_item(uuid, jsonb, jsonb)'::regprocedure),
  'assign_item is security definer, owned by postgres, with an empty search_path');                 -- 1

select ok(
  has_function_privilege('authenticated', 'public.assign_item(uuid, jsonb, jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.assign_item(uuid, jsonb, jsonb)', 'execute')
  and not exists (
    select 1 from pg_proc as p, aclexplode(p.proacl) as a
    where p.oid = 'public.assign_item(uuid, jsonb, jsonb)'::regprocedure and a.grantee = 0)
  and not has_function_privilege('authenticated', 'private.parts_map_ok(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'private.log_claim_event()', 'execute'),
  'assign_item: execute for authenticated only (not anon, not PUBLIC); the private helpers are not executable by clients'); -- 2

select ok(
  (select p.prosecdef and p.proconfig = array['search_path=""']
   from pg_proc as p where p.oid = 'private.log_claim_event()'::regprocedure),
  'log_claim_event is still security definer with an empty search_path');                          -- 3

-- Criterion 96 (B4, A1.3): the constraint lists exactly the 24 kinds.
select is(
  (select array_agg(m[1] order by m[1])
   from pg_constraint as c,
        regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') as m
   where c.conrelid = 'public.bill_events'::regclass and c.conname = 'bill_events_kind_known'),
  (select array_agg(k order by k) from unnest(array[
    'bill_created', 'joined', 'claimed', 'unclaimed', 'split_changed', 'item_added',
    'item_removed', 'item_changed', 'amounts_changed', 'link_rotated', 'extras_split_changed',
    'payer_changed', 'marked_paid', 'unmarked_paid', 'participant_added', 'participant_removed',
    'left', 'paid_difference', 'paid_back', 'not_received', 'moved_to_group', 'removed_from_group',
    'assigned', 'unassigned', 'payers_changed']) as k),
  'criterion 96: bill_events_kind_known is T5''s 22 kinds plus assigned and unassigned (24), plus who-paid''s payers_changed (25)');      -- 4

-- ===========================================================================
-- Static lock order (header; criterion 34 / A1.2, S4)
-- ===========================================================================
select ok(
  position('private.lock_bill_key_share' in pg_temp.body()) > 0
  and position('private.lock_bill_key_share' in pg_temp.body()) < position('for update' in pg_temp.body())
  and position('for update' in pg_temp.body())
      < position('from public.claims as c where c.line_item_id = p_line_item_id for update' in pg_temp.body())
  and position('from public.claims as c where c.line_item_id = p_line_item_id for update' in pg_temp.body())
      < position('delete from public.claims' in pg_temp.body())
  and position('delete from public.claims' in pg_temp.body()) < position('update public.claims' in pg_temp.body())
  and position('update public.claims' in pg_temp.body()) < position('insert into public.claims' in pg_temp.body()),
  'lock order: bill (lock_bill_key_share), then the line item FOR UPDATE, then its claims FOR UPDATE, then delete / update / insert'); -- 5

select ok(
  position('b.group_id = v_group_id' in pg_temp.body()) > position('private.lock_bill_key_share' in pg_temp.body())
  and position('private.lock_bill_key_share' in pg_temp.body())
      < position('''claims_changed''' in pg_temp.body())
  and position('if v_current = v_parts' in pg_temp.body()) > position('b.group_id = v_group_id' in pg_temp.body())
  and position('if v_current = v_parts' in pg_temp.body()) < position('if v_current <> v_expected' in pg_temp.body()),
  'S4/S3: group_id is re-read after the bill lock; the no-op check comes before the stale-token check'); -- 6

select ok(
  position('public.groups' in pg_temp.body()) = 0
  and position('for no key update' in pg_temp.body()) = 0
  and position('foreign_key_violation' in pg_temp.body()) > position('insert into public.claims' in pg_temp.body()),
  'assign_item takes no group lock (rule (a)); the claims writes map foreign_key_violation');         -- 7

-- ===========================================================================
-- Criterion 38: Ana assigns Tacos to Ben
-- ===========================================================================
select lives_ok(pg_temp.assign(pg_temp.u('01'), 'Tacos', pg_temp.m('02', '1'), '{}'),
  'criterion 38: member Ana assigns Tacos to Ben');                                                -- 8
reset role;
select is(pg_temp.claims('Tacos'), pg_temp.m('02', '1'),
  'criterion 38: Tacos has exactly one claim, Ben''s, parts 1');                                  -- 9
select results_eq(
  $$ select kind, actor, item, details from pg_temp.ev() $$,
  $$ values ('assigned'::text, 'Ana'::text, 'Tacos'::text,
             jsonb_build_object('user_id', pg_temp.u('02'))) $$,
  'criterion 38: one assigned event, actor Ana, details {user_id: Ben}; no claimed event');          -- 10
select pg_temp.mark();

-- ===========================================================================
-- Criterion 39: Ben removes his own claim; Cy assigns a fresh row to two people
-- ===========================================================================
select lives_ok(pg_temp.assign(pg_temp.u('02'), 'Tacos', '{}', pg_temp.m('02', '1')),
  'criterion 39: Ben sets Tacos to nobody');                                                       -- 11
reset role;
select is(pg_temp.claims('Tacos'), '{}'::jsonb, 'criterion 39: Tacos has no claims');             -- 12
select results_eq(
  $$ select kind, actor, item, details from pg_temp.ev() $$,
  $$ values ('unclaimed'::text, 'Ben'::text, 'Tacos'::text,
             '{"unit": null, "split": null}'::jsonb) $$,
  'criterion 39: one unclaimed event with actor Ben (his own claim), shaped as before');            -- 13
select pg_temp.mark();

select lives_ok(pg_temp.assign(pg_temp.u('03'), 'Nachos', pg_temp.m('01', '2', '02', '1'), '{}'),
  'criterion 39: Cy assigns Nachos to Ana (2 parts) and Ben (1)');                                 -- 14
reset role;
select is(pg_temp.claims('Nachos'), pg_temp.m('01', '2', '02', '1'),
  'criterion 39: Nachos claims are {Ana: 2, Ben: 1}');                                             -- 15
select results_eq(
  $$ select kind, actor, item, details from pg_temp.ev() order by details ->> 'user_id' $$,
  $$ values ('assigned'::text, 'Cy'::text, 'Nachos'::text, jsonb_build_object('user_id', pg_temp.u('01'))),
            ('assigned'::text, 'Cy'::text, 'Nachos'::text, jsonb_build_object('user_id', pg_temp.u('02'))) $$,
  'criterion 39: two assigned events (Ana, Ben), actor Cy; no split_changed on a fresh row');        -- 16
select is((select li.split_set_by from public.line_items as li where li.id = pg_temp.li('gb', 'Nachos')),
  pg_temp.u('03'), 'Cy set an uneven split on a fresh row: split_set_by = Cy');                     -- 17
select pg_temp.mark();

-- ===========================================================================
-- Criterion 40: parts change for people who stay; identical maps
-- ===========================================================================
select lives_ok(pg_temp.assign(pg_temp.u('01'), 'Nachos', pg_temp.m('01', '1', '02', '3'),
                               pg_temp.m('01', '2', '02', '1')),
  'criterion 40: Ana changes only the parts (Ana 1, Ben 3)');                                      -- 18
reset role;
select is(pg_temp.claims('Nachos'), pg_temp.m('01', '1', '02', '3'), 'criterion 40: parts updated'); -- 19
select results_eq(
  $$ select kind, actor, item, details from pg_temp.ev() $$,
  $$ values ('split_changed'::text, 'Ana'::text, 'Nachos'::text,
             jsonb_build_object('unit', null, 'before', pg_temp.m('01', '2', '02', '1'),
                                'after', pg_temp.m('01', '1', '02', '3'))) $$,
  'criterion 40: exactly one split_changed (actor Ana, before / after); no claimed / assigned');      -- 20
select pg_temp.mark();

-- Backdate the rows so a rewrite would show (now() is fixed inside the transaction). Triggers
-- off for these two statements only, or claims_set_updated_at would put now() back.
set local session_replication_role = replica;
update public.claims as c set updated_at = '2000-01-01T00:00:00Z'
where c.line_item_id = pg_temp.li('gb', 'Nachos');
update public.line_items as li set split_set_at = '2000-01-01T00:00:00Z'
where li.id = pg_temp.li('gb', 'Nachos');
set local session_replication_role = origin;

select lives_ok(pg_temp.assign(pg_temp.u('01'), 'Nachos', pg_temp.m('01', '1', '02', '3'),
                               pg_temp.m('01', '1', '02', '3')),
  'criterion 40: identical p_parts and current map succeeds');                                     -- 21
reset role;
select ok(
  not exists (select 1 from pg_temp.ev())
  and (select bool_and(c.updated_at = '2000-01-01T00:00:00Z') from public.claims as c
       where c.line_item_id = pg_temp.li('gb', 'Nachos'))
  and (select li.split_set_at = '2000-01-01T00:00:00Z' from public.line_items as li
       where li.id = pg_temp.li('gb', 'Nachos')),
  'criterion 40: identical maps: no write (claims and row untouched), no event');                    -- 22

-- ===========================================================================
-- Criterion 103 / S3: a retry with the same p_parts and the old p_expected
-- ===========================================================================
select lives_ok(pg_temp.assign(pg_temp.u('01'), 'Nachos', pg_temp.m('01', '1', '02', '3'),
                               pg_temp.m('01', '2', '02', '1')),
  'criterion 103 (S3): the retry with the old p_expected succeeds');                               -- 23
reset role;
select ok(
  not exists (select 1 from pg_temp.ev())
  and (select bool_and(c.updated_at = '2000-01-01T00:00:00Z') from public.claims as c
       where c.line_item_id = pg_temp.li('gb', 'Nachos')),
  'criterion 103 (S3): the retry writes nothing and logs nothing');                                -- 24

-- Upper-case keys name the same people: still the same map, still a no-op.
select lives_ok(pg_temp.assign(pg_temp.u('01'), 'Nachos',
    jsonb_build_object(upper(pg_temp.u('01')::text), 1, upper(pg_temp.u('02')::text), 3),
    pg_temp.m('01', '1', '02', '3')),
  'maps compare by uuid: upper-case keys for the current map are a no-op success');                -- 25
reset role;
select ok(not exists (select 1 from pg_temp.ev()), 'upper-case no-op: no event');                  -- 26

-- ===========================================================================
-- Criterion 41: stale p_expected; badly shaped p_parts
-- ===========================================================================
select throws_ok(pg_temp.assign(pg_temp.u('01'), 'Nachos', pg_temp.m('03', '1'),
                                pg_temp.m('01', '2', '02', '1')),
  '22023', 'claims_changed', 'criterion 41: a stale p_expected -> 22023 claims_changed');           -- 27
reset role;
select ok(pg_temp.claims('Nachos') = pg_temp.m('01', '1', '02', '3') and not exists (select 1 from pg_temp.ev()),
  'criterion 41: after claims_changed nothing changed and nothing was logged');                     -- 28

select throws_ok(pg_temp.assign(pg_temp.u('01'), 'Wings', jsonb_build_object(pg_temp.u('02'), 0), '{}'),
  '22023', 'invalid_parts', 'criterion 41: parts 0 -> invalid_parts');                              -- 29
reset role;
select throws_ok(pg_temp.assign(pg_temp.u('01'), 'Wings', jsonb_build_object(pg_temp.u('02'), 21), '{}'),
  '22023', 'invalid_parts', 'criterion 41: parts 21 -> invalid_parts');                             -- 30
reset role;
select throws_ok(pg_temp.assign(pg_temp.u('01'), 'Wings', jsonb_build_object(pg_temp.u('02'), 1.5), '{}'),
  '22023', 'invalid_parts', 'criterion 41: parts 1.5 -> invalid_parts');                            -- 31
reset role;
select throws_ok(pg_temp.assign(pg_temp.u('01'), 'Wings', jsonb_build_object(pg_temp.u('02'), '2'), '{}'),
  '22023', 'invalid_parts', 'criterion 41: parts "2" (a string) -> invalid_parts');                 -- 32
reset role;
select throws_ok(pg_temp.assign(pg_temp.u('01'), 'Wings',
    jsonb_build_object(pg_temp.u('02')::text, 1, upper(pg_temp.u('02')::text), 1), '{}'),
  '22023', 'invalid_parts', 'criterion 41: duplicate keys (one uuid spelled twice) -> invalid_parts'); -- 33
reset role;
select throws_ok(pg_temp.assign(pg_temp.u('01'), 'Wings', '["x"]', '{}'),
  '22023', 'invalid_parts', 'criterion 41: p_parts not an object (or a non-uuid key) -> invalid_parts'); -- 34
reset role;
select throws_ok(pg_temp.assign(pg_temp.u('01'), 'Wings', pg_temp.m('02', '1'), '{"x": 1}'),
  '22023', 'invalid_parts', 'a badly shaped p_expected -> invalid_parts');                           -- 35
reset role;
select ok(pg_temp.claims('Wings') = '{}'::jsonb and not exists (select 1 from pg_temp.ev()),
  'criterion 41: refused shapes wrote nothing');                                                   -- 36

-- ===========================================================================
-- Criterion 42: 42501 not_allowed (same answer for the "can't see it" cases)
-- ===========================================================================
select throws_ok(pg_temp.assign(pg_temp.u('01'), 'Salad', pg_temp.m('01', '1'), '{}', 0, 'nb'),
  '42501', 'not_allowed', 'criterion 42: a non-group bill, even for its host -> 42501 not_allowed'); -- 37
reset role;
select throws_ok(pg_temp.assign(pg_temp.u('02'), 'Salad', pg_temp.m('01', '1'), '{}', 0, 'nb'),
  '42501', 'not_allowed', 'criterion 42: a participant assigning on a non-group bill -> 42501 not_allowed'); -- 38
reset role;
select throws_ok(pg_temp.assign(pg_temp.u('04'), 'Wings', pg_temp.m('04', '1'), '{}'),
  '42501', 'not_allowed', 'criterion 42: a caller who isn''t a member of the bill''s group -> 42501 not_allowed'); -- 39
reset role;
select throws_ok(pg_temp.as_sql(pg_temp.u('01'),
    format('select public.assign_item(%L::uuid, ''{}'', ''{}'')', gen_random_uuid())),
  '42501', 'not_allowed', 'a row that doesn''t exist -> the same 42501 not_allowed');              -- 40
reset role;
select throws_ok(pg_temp.assign(pg_temp.u('01'), 'Wings', pg_temp.m('02', '1', '04', '1'), '{}'),
  '42501', 'not_allowed', 'criterion 42: a target key who isn''t a member -> 42501 not_allowed');    -- 41
reset role;
select throws_ok(
  format($f$ set local role anon; select public.assign_item(%L::uuid, '{}', '{}') $f$, pg_temp.li('gb', 'Wings')),
  '42501', null, 'criterion 42: anon can''t execute assign_item (42501)');                          -- 42
reset role;
select throws_ok(
  format($f$ select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
             set local role authenticated; select public.assign_item(%L::uuid, '{}', '{}') $f$,
         pg_temp.li('gb', 'Wings')),
  '42501', 'not_allowed', 'signed out (no user id) -> 42501 not_allowed');                          -- 43
reset role;
select ok(
  pg_temp.claims('Wings') = '{}'::jsonb and pg_temp.claims('Salad', 0, 'nb') = '{}'::jsonb
  and not exists (select 1 from pg_temp.ev()),
  'criterion 42: every refused call wrote nothing and logged nothing');                            -- 44

-- ===========================================================================
-- Criterion 43: non-group bills keep today's rules
-- ===========================================================================
select lives_ok(pg_temp.as_sql(pg_temp.u('02'),
    format('select public.set_claim(%L::uuid, true)', pg_temp.li('nb', 'Salad'))),
  'criterion 43: Ben set_claims the Salad on the non-group bill');                                 -- 45
reset role;
select results_eq(
  $$ select pg_temp.claims('Salad', 0, 'nb'), kind, actor, details from pg_temp.ev() $$,
  $$ values (pg_temp.m('02', '1'), 'claimed'::text, 'Ben'::text, '{"unit": null, "split": null}'::jsonb) $$,
  'criterion 43: set_claim wrote only Ben''s claim and logged claimed (actor Ben) as before');      -- 46
select pg_temp.mark();

select throws_ok(pg_temp.as_sql(pg_temp.u('02'),
    format('insert into public.claims (bill_id, line_item_id, user_id) values (%L, %L, %L)',
      pg_temp.bid('nb'), pg_temp.li('nb', 'Salad'), pg_temp.u('01'))),
  '42501', null, 'criterion 43: a direct INSERT of another user''s claim is refused by RLS (42501)'); -- 47
reset role;
select lives_ok(pg_temp.as_sql(pg_temp.u('01'),
    format('delete from public.claims where line_item_id = %L and user_id = %L',
      pg_temp.li('nb', 'Salad'), pg_temp.u('02'))),
  'a direct DELETE of another user''s claim runs (RLS hides the row) ...');                        -- 48
reset role;
select ok(pg_temp.claims('Salad', 0, 'nb') = pg_temp.m('02', '1') and not exists (select 1 from pg_temp.ev()),
  'criterion 43: ... and deletes nothing, logs nothing');                                          -- 49

-- ===========================================================================
-- Criterion 44 and mixed maps: own changes stay claimed / unclaimed
-- ===========================================================================
select lives_ok(pg_temp.as_sql(pg_temp.u('03'),
    format('select public.set_claim(%L::uuid, true)', pg_temp.li('gb', 'Wings'))),
  'criterion 44: member Cy set_claims Wings on the group bill');                                   -- 50
reset role;
select results_eq(
  $$ select kind, actor, item, details from pg_temp.ev() $$,
  $$ values ('claimed'::text, 'Cy'::text, 'Wings'::text, '{"unit": null, "split": null}'::jsonb) $$,
  'criterion 44: set_claim on a group bill logs claimed with actor = the member, as before');        -- 51
select pg_temp.mark();

-- One call removes Cy, adds Ana (the caller) and Ben: unassigned Cy, claimed Ana, assigned Ben.
-- Beer unit 2 of 2 to Ben: assigned carries unit [1, 2].
select lives_ok(pg_temp.assign(pg_temp.u('01'), 'Wings', pg_temp.m('01', '1', '02', '1'), pg_temp.m('03', '1'))
  || '; ' || format('select public.assign_item(%L::uuid, %L::jsonb, ''{}'')',
                    pg_temp.li('gb', 'Beer', 1), pg_temp.m('02', '1')),
  'Ana swaps Cy for herself and Ben on Wings, and assigns Beer (2 of 2) to Ben');                   -- 52
reset role;
select results_eq(
  $$ select kind, actor, item, details from pg_temp.ev() order by item desc, kind $$,
  $$ values ('assigned'::text, 'Ana'::text, 'Wings'::text, jsonb_build_object('user_id', pg_temp.u('02'))),
            ('claimed', 'Ana', 'Wings', '{"unit": null, "split": null}'::jsonb),
            ('unassigned', 'Ana', 'Wings', jsonb_build_object('user_id', pg_temp.u('03'))),
            ('assigned', 'Ana', 'Beer', jsonb_build_object('user_id', pg_temp.u('02'), 'unit', jsonb_build_array(1, 2))) $$,
  'one event per person: unassigned Cy, claimed Ana (her own), assigned Ben; a unit row''s assigned has unit [1, 2]'); -- 53
select pg_temp.mark();

-- A postgres-role write (no caller): actor = the claim's user, kind claimed (unchanged).
select set_config('request.jwt.claims', '', true);
insert into public.claims (bill_id, line_item_id, user_id)
values (pg_temp.bid('gb'), pg_temp.li('gb', 'Soda'), pg_temp.u('05'));
select results_eq(
  $$ select kind, actor, item from pg_temp.ev() $$,
  $$ values ('claimed'::text, 'Eve'::text, 'Soda'::text) $$,
  'with no caller (postgres), the actor is the claim''s user and the kind stays claimed');           -- 54
select pg_temp.mark();

-- ===========================================================================
-- Criterion 103 / S4: races, applied when the bill lock is granted
-- ===========================================================================
-- Test copy of private.lock_bill_key_share: the same lock, then (once) the change named in
-- test.race, as if that transaction had committed while assign_item waited for the bill lock.
create or replace function private.lock_bill_key_share(p_bill_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_race text := current_setting('test.race', true);
begin
  perform 1
  from public.bills as b
  where b.id = p_bill_id
    and exists (
      select 1 from public.bill_participants as bp
      where bp.bill_id = b.id and bp.user_id = (select auth.uid())
    )
  for key share of b;
  perform set_config('test.race', '', true);
  if v_race = 'detach' then
    update public.bills set group_id = null where id = p_bill_id;
  elsif v_race like 'leave:%' then
    -- leave_group's deletes, in its order: the membership, then the participant rows.
    delete from public.group_members where group_id = 'e7a00000-0000-0000-0000-0000000000a1'
      and user_id = substr(v_race, 7)::uuid;
    delete from public.bill_participants where user_id = substr(v_race, 7)::uuid
      and bill_id = p_bill_id;
  end if;
end;
$$;

-- Detach commits while Ana waits for the bill lock: the re-read of group_id refuses (S4).
select throws_ok(
  $$ select set_config('test.race', 'detach', true) $$ || '; '
    || pg_temp.assign(pg_temp.u('01'), 'Chips', pg_temp.m('01', '1'), '{}'),
  '42501', 'not_allowed',
  'criterion 103 (S4): the bill detached while waiting for the lock -> 42501 not_allowed');           -- 55
reset role;
-- The target leaves while Ana waits: claims_changed (the app refetches), never network.
select throws_ok(
  format($f$ select set_config('test.race', 'leave:%s', true) $f$, pg_temp.u('07')) || '; '
    || pg_temp.assign(pg_temp.u('01'), 'Chips', pg_temp.m('07', '1'), '{}'),
  '22023', 'claims_changed',
  'criterion 103 (S4): a target removed by leave_group while waiting -> 22023 claims_changed');       -- 56
reset role;
-- The caller leaves while waiting: not a member any more.
select throws_ok(
  format($f$ select set_config('test.race', 'leave:%s', true) $f$, pg_temp.u('03')) || '; '
    || pg_temp.assign(pg_temp.u('03'), 'Chips', pg_temp.m('01', '1'), '{}'),
  '42501', 'not_allowed',
  'S4: the caller removed by leave_group while waiting -> 42501 not_allowed');                       -- 57
reset role;
select set_config('test.race', '', true);
select ok(pg_temp.claims('Chips') = '{}'::jsonb and not exists (select 1 from pg_temp.ev()),
  'S4: the three raced calls wrote nothing and logged nothing');                                    -- 58

-- 23503 -> claims_changed: Fay is a member (inserted directly) with no participant row.
insert into public.group_members (group_id, user_id) values (pg_temp.g1(), pg_temp.u('06'));
select throws_ok(pg_temp.assign(pg_temp.u('01'), 'Chips', pg_temp.m('01', '1', '06', '1'), '{}'),
  '22023', 'claims_changed',
  'A1.6: a foreign-key failure on the claim insert (23503) -> 22023 claims_changed');                -- 59
reset role;
select ok(pg_temp.claims('Chips') = '{}'::jsonb and not exists (select 1 from pg_temp.ev()),
  'A1.6: after the mapped 23503 nothing was written (Ana''s own claim rolled back too)');            -- 60
delete from public.group_members where group_id = pg_temp.g1() and user_id = pg_temp.u('06');

-- An assigned claim is history: the assignee can't leave the group (GR-T5-7; lock-order outcome).
select lives_ok(pg_temp.assign(pg_temp.u('01'), 'Chips', pg_temp.m('07', '1'), '{}'),
  'Ana assigns Chips to Gus');                                                                     -- 61
reset role;
select throws_ok(pg_temp.as_sql(pg_temp.u('07'), format('select public.leave_group(%L::uuid)', pg_temp.g1())),
  '22023', 'cannot_leave', 'Gus, now holding an assigned claim, gets cannot_leave from leave_group');  -- 62
reset role;
select pg_temp.mark();

-- Criterion 103: the bill detached between calls -> 42501.
select lives_ok(pg_temp.as_sql(pg_temp.u('01'),
    format('select public.detach_bill_from_group(%L::uuid)', pg_temp.bid('gb'))),
  'Ana detaches the bill from the group');                                                         -- 63
reset role;
select throws_ok(pg_temp.assign(pg_temp.u('01'), 'Chips', '{}', pg_temp.m('07', '1')),
  '42501', 'not_allowed', 'criterion 103: assign_item after the bill left the group -> 42501 not_allowed'); -- 64
reset role;

select * from finish();
rollback;
