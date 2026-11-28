-- pgTAP tests for the delete-group migration (20261128100232_group_delete.sql; spec
-- docs/specs/2026-11-28-delete-group.md contracts D, F, L, W and Amendment A2, criteria 1-14 as
-- amended by A2.1-A2.11).
--
-- Every assertion filters to the fixture users / groups / bills below (the local DB may hold real
-- data). Fixture ids start with d6000000.
-- Users: Ana ..01, Ben ..02, Cy ..03, Sam ..04 (stranger to every group).
-- Groups: GL ..a1 fully loaded, deleted by Ben; GF ..a2 fingerprint sensitivity; GW ..a3 a waiting
--   receipt, then deleted; GO ..a4 another live group (untouched); GX ..a5 money writes after a
--   delete.
-- Bills: RL (GL's receipt, with a bill_mark payment), RF (GF's), RW (GW's), N1 (no group),
--   W cases (no group, inserted directly as the owner).

begin;

create extension if not exists pgtap with schema extensions;

select plan(98);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function pg_temp.u(p text) returns uuid language sql immutable as $$
  select ('d6000000-0000-0000-0000-0000000000' || p)::uuid
$$;
create function pg_temp.g(p text) returns uuid language sql immutable as $$
  select ('d6000000-0000-0000-0000-0000000000' || p)::uuid
$$;
create function pg_temp.act(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;
-- p_sql as p_user (authenticated), for lives_ok / throws_ok.
create function pg_temp.as_sql(p_user uuid, p_sql text) returns text language sql immutable as $$
  select format(
    'select set_config(''request.jwt.claims'', %L, true); set local role authenticated; %s',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, p_sql)
$$;
-- Run p_sql as p_user, then back to the owner.
create function pg_temp.run(p_user uuid, p_sql text) returns void language plpgsql as $$
begin
  perform pg_temp.act(p_user);
  set local role authenticated;
  execute p_sql;
  reset role;
end $$;
create function pg_temp.body(p regprocedure) returns text language sql as $$
  select lower(prosrc) from pg_proc where oid = p
$$;
create function pg_temp.fp(p_group uuid) returns text language sql as $$
  select private.group_money_fingerprint(p_group)
$$;
-- The snapshot's money_fingerprint, read as p_user.
create function pg_temp.snapfp(p_user uuid, p_group uuid) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.act(p_user);
  set local role authenticated;
  select public.group_snapshot(p_group) ->> 'money_fingerprint' into v;
  reset role;
  return v;
end $$;
create function pg_temp.it(p_pos integer, p_name text, p_cents integer) returns jsonb
language sql immutable as $$
  select jsonb_build_object('name', p_name, 'note', null, 'group_position', p_pos,
    'unit_index', 0, 'group_size', 1, 'total_cents', p_cents);
$$;
create function pg_temp.bid(p_tag text) returns uuid language sql stable as
  $$ select current_setting('test.bill_' || p_tag)::uuid $$;
create function pg_temp.li(p_tag text, p_name text) returns uuid language sql stable as $$
  select li.id from public.line_items as li
  where li.bill_id = pg_temp.bid(p_tag) and li.name = p_name;
$$;
create function pg_temp.gcode(p_group uuid) returns text language sql stable as
  $$ select g.join_code from public.groups as g where g.id = p_group $$;
-- As p_host: create a bill; each of p_joiners joins it by link.
create function pg_temp.mk(p_tag text, p_host uuid, p_rows jsonb, p_tax integer, p_total integer,
                           p_joiners uuid[]) returns void language plpgsql as $$
declare r record; j uuid;
begin
  perform pg_temp.act(p_host);
  set local role authenticated;
  select * into r from public.create_bill(p_rows, null, p_tax, 0, 0, 0, 0, p_total);
  reset role;
  perform set_config('test.bill_' || p_tag, r.bill_id::text, true);
  foreach j in array coalesce(p_joiners, '{}'::uuid[]) loop
    perform pg_temp.run(j, format('select public.join_bill(%L)', r.join_code));
  end loop;
end $$;
create function pg_temp.claim(p_user uuid, p_tag text, p_name text, p_on boolean default true)
returns void language sql as $$
  select pg_temp.run(p_user, format('select public.set_claim(%L::uuid, %L)', pg_temp.li(p_tag, p_name), p_on))
$$;
create function pg_temp.join(p_user uuid, p_group uuid) returns void language sql as $$
  select pg_temp.run(p_user, format('select public.join_group(%L)', pg_temp.gcode(p_group)))
$$;
create function pg_temp.mkgroup(p_user uuid, p_group uuid, p_name text) returns void language sql as $$
  select pg_temp.run(p_user, format('select public.create_group(%L::uuid, %L)', p_group, p_name))
$$;
create function pg_temp.attach(p_user uuid, p_tag text, p_group uuid) returns void language sql as $$
  select pg_temp.run(p_user, format('select public.attach_bill_to_group(%L::uuid, %L::uuid)', pg_temp.bid(p_tag), p_group))
$$;
-- An equal-split p_shares object.
create function pg_temp.eq(variadic p uuid[]) returns jsonb language sql immutable as $$
  select jsonb_object_agg(x::text, 1) from unnest(p) as x
$$;
create function pg_temp.add_expense_sql(p_id uuid, p_group uuid, p_payer uuid, p_cents integer,
                                        p_shares jsonb) returns text language sql immutable as $$
  select format('select public.add_expense(%L::uuid, %L::uuid, %L, %L::uuid, %s, %L, %L::jsonb)',
    p_id, p_group, 'Dinner', p_payer, p_cents, 'equal', p_shares)
$$;
create function pg_temp.edit_expense_sql(p_id uuid, p_version integer, p_payer uuid, p_cents integer,
                                         p_shares jsonb) returns text language sql immutable as $$
  select format('select public.edit_expense(%L::uuid, %s, %L, %L::uuid, %s, %L, %L::jsonb)',
    p_id, p_version, 'Dinner', p_payer, p_cents, 'equal', p_shares)
$$;
create function pg_temp.pay_sql(p_id uuid, p_group uuid, p_from uuid, p_to uuid, p_cents integer)
returns text language sql immutable as $$
  select format('select public.record_payment(%L::uuid, %L::uuid, %L::uuid, %L::uuid, %s, %L, %L)',
    p_id, p_group, p_from, p_to, p_cents, 'cash', 'manual')
$$;
create function pg_temp.del_sql(p_group uuid, p_fp text) returns text language sql immutable as $$
  select format('select public.delete_group(%L::uuid, %L)', p_group, p_fp)
$$;

-- Fingerprints kept between statements.
create temp table fps (k text primary key, v text);
create function pg_temp.keep(p_k text, p_v text) returns void language sql as $$
  insert into fps values (p_k, p_v) on conflict (k) do update set v = excluded.v
$$;
create function pg_temp.kept(p_k text) returns text language sql as $$ select v from fps where k = p_k $$;

-- Rows of a group and of one of its bills, per table (A2.1: all must reach 0).
create function pg_temp.counts(p_group uuid, p_bill uuid) returns jsonb language sql as $$
  select jsonb_build_object(
    'groups', (select count(*) from public.groups where id = p_group),
    'group_members', (select count(*) from public.group_members where group_id = p_group),
    'group_events', (select count(*) from public.group_events where group_id = p_group),
    'group_hidden', (select count(*) from public.group_hidden where group_id = p_group),
    'expenses', (select count(*) from public.expenses where group_id = p_group),
    'expense_shares', (select count(*) from public.expense_shares where group_id = p_group),
    'group_payments', (select count(*) from public.group_payments
                       where group_id = p_group or bill_id = p_bill),
    'bills', (select count(*) from public.bills where id = p_bill or group_id = p_group),
    'line_items', (select count(*) from public.line_items where bill_id = p_bill),
    'claims', (select count(*) from public.claims where bill_id = p_bill),
    'bill_participants', (select count(*) from public.bill_participants where bill_id = p_bill),
    'bill_events', (select count(*) from public.bill_events where bill_id = p_bill),
    'bill_not_part', (select count(*) from public.bill_not_part where bill_id = p_bill),
    'bill_seen', (select count(*) from public.bill_seen where bill_id = p_bill),
    'bill_payers', (select count(*) from public.bill_payers where bill_id = p_bill),
    'bill_payments', (select count(*) from public.bill_payments where bill_id = p_bill),
    'bill_payment_flags', (select count(*) from public.bill_payment_flags where bill_id = p_bill))
$$;
-- Every row of a non-group bill and its children, as one string.
create function pg_temp.bill_state(p_bill uuid) returns text language sql as $$
  select md5(concat_ws('#',
    (select b::text from public.bills as b where b.id = p_bill),
    (select string_agg(li::text, '|' order by li.id) from public.line_items as li where li.bill_id = p_bill),
    (select string_agg(c::text, '|' order by c.line_item_id, c.user_id) from public.claims as c where c.bill_id = p_bill),
    (select string_agg(bp::text, '|' order by bp.user_id) from public.bill_participants as bp where bp.bill_id = p_bill),
    (select string_agg(e::text, '|' order by e.id) from public.bill_events as e where e.bill_id = p_bill)))
$$;

-- W cases: a bill (no group) inserted directly as the owner. Host Ana; participants Ana and Ben.
create function pg_temp.wbill(p_tag text, p_total integer, p_mode text) returns void
language plpgsql as $$
declare v uuid;
begin
  insert into public.bills (host_id, payer_id, total_cents, extras_split, join_code)
  values (pg_temp.u('01'), pg_temp.u('01'), p_total, p_mode,
          encode(extensions.gen_random_bytes(10), 'hex'))
  returning id into v;
  insert into public.bill_participants (bill_id, user_id)
  values (v, pg_temp.u('01')), (v, pg_temp.u('02'));
  perform set_config('test.bill_' || p_tag, v::text, true);
end $$;
create function pg_temp.wrow(p_tag text, p_name text, p_cents integer) returns void
language sql as $$
  insert into public.line_items (bill_id, group_position, unit_index, group_size, name, total_cents,
                                 kind, applies_to)
  select pg_temp.bid(p_tag),
         (select count(*)::integer from public.line_items where bill_id = pg_temp.bid(p_tag)),
         0, 1, p_name, p_cents,
         case when p_cents < 0 then 'discount' else 'item' end,
         case when p_cents < 0 then 'total' end
$$;
create function pg_temp.wclaim(p_tag text, p_name text, p_user text, p_parts integer default 1)
returns void language sql as $$
  insert into public.claims (bill_id, line_item_id, user_id, parts)
  values (pg_temp.bid(p_tag), pg_temp.li(p_tag, p_name), pg_temp.u(p_user), p_parts)
$$;
-- One W case in both modes: tags <p_tag>p and <p_tag>e.
create function pg_temp.wcase(p_tag text, p_total integer, p_rows text[], p_cents integer[],
                              p_claims text[]) returns void language plpgsql as $$
declare m text; t text; i integer;
begin
  foreach m in array array['proportional', 'equal'] loop
    t := p_tag || left(m, 1);
    perform pg_temp.wbill(t, p_total, m);
    for i in 1 .. coalesce(array_length(p_rows, 1), 0) loop
      perform pg_temp.wrow(t, p_rows[i], p_cents[i]);
    end loop;
    -- p_claims: 'row:user:parts' triples
    for i in 1 .. coalesce(array_length(p_claims, 1), 0) loop
      perform pg_temp.wclaim(t, split_part(p_claims[i], ':', 1), split_part(p_claims[i], ':', 2),
                             split_part(p_claims[i], ':', 3)::integer);
    end loop;
  end loop;
end $$;
create function pg_temp.waiting(p_tag text) returns boolean language sql as $$
  select private.group_bill_waiting(pg_temp.bid(p_tag))
$$;

-- ---------------------------------------------------------------------------
-- Fixture: users
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data)
select pg_temp.u(t.k), 'dgroup-' || t.k || '@test.local', jsonb_build_object('full_name', t.n)
from (values ('01','Ana'),('02','Ben'),('03','Cy'),('04','Sam')) as t(k, n);

-- ===========================================================================
-- A. Contract W (criterion 7): group_bill_waiting = lib's answers (header table), both modes
-- ===========================================================================
select pg_temp.wcase('w1', 1100, array['x','y'], array[400,600], array['x:01:1','y:02:1']);
select pg_temp.wcase('w2', 1100, array['x','y'], array[400,600], array['x:01:1']);
select pg_temp.wcase('w3', 900, array['x','y','d'], array[400,600,-200], array['x:01:1','y:02:1']);
select pg_temp.wcase('w4', 500, array['x','y'], array[0,0], array['x:01:1','y:02:1']);
select pg_temp.wcase('w4z', 0, array['x'], array[0], array['x:01:1']);
select pg_temp.wcase('w5', 1100, array['x','z'], array[1000,0], array['x:01:1']);
select pg_temp.wcase('w6', 1100, array['x'], array[1000], array['x:01:1','x:02:2']);
select pg_temp.wcase('w7', 500, '{}'::text[], '{}'::integer[], '{}'::text[]);
select pg_temp.wcase('w7z', 0, '{}'::text[], '{}'::integer[], '{}'::text[]);
select pg_temp.wcase('wd', 300, array['d'], array[-200], array['d:01:1']);
select pg_temp.wcase('wd0', 0, array['d'], array[-200], array['d:01:1']);

select is(pg_temp.waiting('w1p'), false, 'W1 proportional: every priced row claimed -> not waiting');   -- 1
select is(pg_temp.waiting('w1e'), false, 'W1 equal: not waiting');                                     -- 2
select is(pg_temp.waiting('w2p'), true, 'W2 proportional: an item unclaimed -> waiting');               -- 3
select is(pg_temp.waiting('w2e'), true, 'W2 equal: waiting');                                          -- 4
select is(pg_temp.waiting('w3p'), true, 'W3 proportional: a discount unclaimed -> waiting');            -- 5
select is(pg_temp.waiting('w3e'), true, 'W3 equal: waiting');                                          -- 6
select is(pg_temp.waiting('w4p'), true, 'W4 proportional: every row $0, total > $0 -> waiting (all-$0)'); -- 7
select is(pg_temp.waiting('w4e'), false, 'W4 equal: every row $0, claimed -> not waiting (lib: claimers carry the extras)'); -- 8
select is(pg_temp.waiting('w4zp'), false, 'W4 with a $0 total, proportional: not waiting');           -- 9
select is(pg_temp.waiting('w4ze'), false, 'W4 with a $0 total, equal: not waiting');                  -- 10
select is(pg_temp.waiting('w5p'), true, 'W5 proportional: a $0 row unclaimed -> waiting (S9)');       -- 11
select is(pg_temp.waiting('w5e'), true, 'W5 equal: waiting');                                         -- 12
select is(pg_temp.waiting('w6p'), false, 'W6 proportional: a split row (1 + 2 parts) -> not waiting'); -- 13
select is(pg_temp.waiting('w6e'), false, 'W6 equal: not waiting');                                    -- 14
select is(pg_temp.waiting('w7p'), true, 'W7 proportional: no rows, total > $0 -> waiting (lib)');     -- 15
select is(pg_temp.waiting('w7e'), true, 'W7 equal: no rows, total > $0 -> waiting (lib; A2.10, the old SQL pair said no)'); -- 16
select is(pg_temp.waiting('w7zp'), false, 'W7 with a $0 total, proportional: not waiting');          -- 17
select is(pg_temp.waiting('w7ze'), false, 'W7 with a $0 total, equal: not waiting');                 -- 18
select is(pg_temp.waiting('wdp'), true, 'discount rows only, claimed, proportional -> waiting');      -- 19
select is(pg_temp.waiting('wde'), true, 'discount rows only, claimed, equal -> waiting (A2.10)');     -- 20
select is(pg_temp.waiting('wd0p'), true, 'discount only, $0 total, proportional -> waiting');         -- 21
select is(pg_temp.waiting('wd0e'), true, 'discount only, $0 total, equal -> waiting (A2.10)');        -- 22

-- ---------------------------------------------------------------------------
-- Fixture: groups and bills
-- ---------------------------------------------------------------------------
select pg_temp.mkgroup(pg_temp.u('01'), pg_temp.g('a1'), 'Tahoe trip');
select pg_temp.mkgroup(pg_temp.u('01'), pg_temp.g('a2'), 'Fingerprint');
select pg_temp.mkgroup(pg_temp.u('01'), pg_temp.g('a3'), 'Waiting');
select pg_temp.mkgroup(pg_temp.u('01'), pg_temp.g('a4'), 'Other live group');
select pg_temp.mkgroup(pg_temp.u('01'), pg_temp.g('a5'), 'After delete');
select pg_temp.join(pg_temp.u('02'), pg_temp.g('a1'));
select pg_temp.join(pg_temp.u('03'), pg_temp.g('a1'));
select pg_temp.join(pg_temp.u('02'), pg_temp.g('a2'));
select pg_temp.join(pg_temp.u('02'), pg_temp.g('a3'));
select pg_temp.join(pg_temp.u('02'), pg_temp.g('a4'));
select pg_temp.join(pg_temp.u('02'), pg_temp.g('a5'));

-- GL, fully loaded. RL: Ana hosts and pays; Ana claims A, Ben claims B; Ben marks 2200 by Venmo
-- before the attach, so the attach turns it into a bill_mark group payment.
select pg_temp.mk('rl', pg_temp.u('01'),
  jsonb_build_array(pg_temp.it(0, 'A', 1000), pg_temp.it(1, 'B', 2000)), 300, 3300,
  array[pg_temp.u('02'), pg_temp.u('03')]);
select pg_temp.claim(pg_temp.u('01'), 'rl', 'A');
select pg_temp.claim(pg_temp.u('02'), 'rl', 'B');
select pg_temp.run(pg_temp.u('02'),
  format('select public.mark_paid(%L::uuid, %L::uuid, 2200, %L)', pg_temp.bid('rl'), pg_temp.u('01'), 'venmo'));
select pg_temp.attach(pg_temp.u('01'), 'rl', pg_temp.g('a1'));
select pg_temp.run(pg_temp.u('03'), format('select public.set_not_part(%L::uuid, true)', pg_temp.bid('rl')));
insert into public.bill_seen (bill_id, user_id) values (pg_temp.bid('rl'), pg_temp.u('02'));
-- Expenses: one live, one edited, one deleted.
select pg_temp.run(pg_temp.u('01'), pg_temp.add_expense_sql(pg_temp.g('e1'), pg_temp.g('a1'), pg_temp.u('01'), 3000,
  pg_temp.eq(pg_temp.u('01'), pg_temp.u('02'), pg_temp.u('03'))));
select pg_temp.run(pg_temp.u('02'), pg_temp.add_expense_sql(pg_temp.g('e2'), pg_temp.g('a1'), pg_temp.u('02'), 900,
  pg_temp.eq(pg_temp.u('01'), pg_temp.u('02'), pg_temp.u('03'))));
select pg_temp.run(pg_temp.u('02'), pg_temp.edit_expense_sql(pg_temp.g('e2'), 1, pg_temp.u('02'), 1200,
  pg_temp.eq(pg_temp.u('01'), pg_temp.u('02'), pg_temp.u('03'))));
select pg_temp.run(pg_temp.u('03'), pg_temp.add_expense_sql(pg_temp.g('e3'), pg_temp.g('a1'), pg_temp.u('03'), 600,
  pg_temp.eq(pg_temp.u('02'), pg_temp.u('03'))));
select pg_temp.run(pg_temp.u('03'), format('select public.delete_expense(%L::uuid, 1)', pg_temp.g('e3')));
-- Payments: one live, one undone.
select pg_temp.run(pg_temp.u('02'), pg_temp.pay_sql(pg_temp.g('f1'), pg_temp.g('a1'), pg_temp.u('02'), pg_temp.u('01'), 1000));
select pg_temp.run(pg_temp.u('03'), pg_temp.pay_sql(pg_temp.g('f2'), pg_temp.g('a1'), pg_temp.u('03'), pg_temp.u('01'), 1000));
select pg_temp.run(pg_temp.u('01'), format('select public.undo_payment(%L::uuid)', pg_temp.g('f2')));
-- Hidden for Cy.
select pg_temp.run(pg_temp.u('03'), format('select public.set_group_hidden(%L::uuid, true)', pg_temp.g('a1')));

-- GO: another live group with an expense. N1: a bill with no group (Ana hosts, Ben claims).
select pg_temp.run(pg_temp.u('01'), pg_temp.add_expense_sql(pg_temp.g('e4'), pg_temp.g('a4'), pg_temp.u('01'), 500,
  pg_temp.eq(pg_temp.u('01'), pg_temp.u('02'))));
select pg_temp.mk('n1', pg_temp.u('01'), jsonb_build_array(pg_temp.it(0, 'Soup', 800)), 0, 800,
  array[pg_temp.u('02')]);
select pg_temp.claim(pg_temp.u('02'), 'n1', 'Soup');

-- ===========================================================================
-- B. The snapshot's money_fingerprint (criterion 11)
-- ===========================================================================
select matches(pg_temp.snapfp(pg_temp.u('02'), pg_temp.g('a1')), '^[0-9a-f]{32}$',
  'criterion 11: money_fingerprint is 32 lowercase hex characters');                                  -- 23
select is(pg_temp.snapfp(pg_temp.u('02'), pg_temp.g('a1')), pg_temp.fp(pg_temp.g('a1')),
  'criterion 11: it equals private.group_money_fingerprint in the same transaction');                  -- 24
select pg_temp.act(pg_temp.u('02'));
set local role authenticated;
select is(
  (select array_agg(k order by k) from jsonb_object_keys(public.group_snapshot(pg_temp.g('a1'))) as k),
  array['bills','expenses','group','me','members','money_fingerprint','not_received','payments'],
  'criterion 11: the top-level keys are the old ones plus money_fingerprint');                         -- 25
reset role;

-- ===========================================================================
-- C. Privileges (criteria 1, 3, 13, 14)
-- ===========================================================================
select ok(
  not has_function_privilege('anon', 'private.group_money_fingerprint(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.group_money_fingerprint(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.group_bill_waiting(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.group_bill_waiting(uuid)', 'execute')
  and not exists (select 1 from pg_proc as p, aclexplode(p.proacl) as a
                  where p.oid in ('private.group_money_fingerprint(uuid)'::regprocedure,
                                  'private.group_bill_waiting(uuid)'::regprocedure)
                    and a.grantee = 0),
  'criterion 13: neither helper is executable by public, anon or authenticated');                     -- 26
select ok(
  has_function_privilege('authenticated', 'public.delete_group(uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.delete_group(uuid, text)', 'execute')
  and not has_function_privilege('service_role', 'public.delete_group(uuid, text)', 'execute')
  and not exists (select 1 from pg_proc as p, aclexplode(p.proacl) as a
                  where p.oid = 'public.delete_group(uuid, text)'::regprocedure and a.grantee = 0),
  'criterion 14: delete_group is executable by authenticated only (service_role revoked)');           -- 27
select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=""']
   from pg_proc as p where p.oid = 'public.delete_group(uuid, text)'::regprocedure),
  'delete_group is security definer with an empty search_path');                                     -- 28
select throws_ok(
  format('set local role anon; select public.delete_group(%L::uuid, %L)', pg_temp.g('a1'), pg_temp.fp(pg_temp.g('a1'))),
  '42501', null, 'criterion 3: anon executing delete_group gets 42501');                              -- 29
reset role;
select throws_ok(
  pg_temp.as_sql(pg_temp.u('01'), format('delete from public.groups where id = %L', pg_temp.g('a1'))),
  '42501', null, 'criterion 1: authenticated still can''t DELETE groups directly (42501)');          -- 30
reset role;

-- ===========================================================================
-- D. Refusals on GL (criteria 3, 5)
-- ===========================================================================
select throws_ok(
  format($f$ select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
             set local role authenticated; select public.delete_group(%L::uuid, %L) $f$,
         pg_temp.g('a1'), pg_temp.fp(pg_temp.g('a1'))),
  '42501', 'not_allowed', 'criterion 3: signed out -> 42501 not_allowed');                             -- 31
reset role;
select throws_ok(pg_temp.as_sql(pg_temp.u('02'), pg_temp.del_sql(null, pg_temp.fp(pg_temp.g('a1')))),
  '42501', 'not_allowed', 'criterion 3: a null id -> 42501 not_allowed');                              -- 32
reset role;
select throws_ok(pg_temp.as_sql(pg_temp.u('02'), pg_temp.del_sql(gen_random_uuid(), pg_temp.fp(pg_temp.g('a1')))),
  '42501', 'not_allowed', 'criterion 3: an unknown group -> 42501 not_allowed');                      -- 33
reset role;
select throws_ok(pg_temp.as_sql(pg_temp.u('04'), pg_temp.del_sql(pg_temp.g('a1'), pg_temp.fp(pg_temp.g('a1')))),
  '42501', 'not_allowed', 'criterion 3: a non-member with the right fingerprint -> 42501');           -- 34
reset role;
select throws_ok(pg_temp.as_sql(pg_temp.u('02'), pg_temp.del_sql(pg_temp.g('a1'), null)),
  '22023', 'group_changed', 'criterion 5: a null fingerprint -> group_changed');                      -- 35
reset role;
select throws_ok(pg_temp.as_sql(pg_temp.u('02'), pg_temp.del_sql(pg_temp.g('a1'), '')),
  '22023', 'group_changed', 'criterion 5: an empty fingerprint -> group_changed');                    -- 36
reset role;
select throws_ok(pg_temp.as_sql(pg_temp.u('02'), pg_temp.del_sql(pg_temp.g('a1'), left(pg_temp.fp(pg_temp.g('a1')), 31))),
  '22023', 'group_changed', 'criterion 5: 31 hex characters -> group_changed');                       -- 37
reset role;
select throws_ok(pg_temp.as_sql(pg_temp.u('02'), pg_temp.del_sql(pg_temp.g('a1'), upper(pg_temp.fp(pg_temp.g('a1'))))),
  '22023', 'group_changed', 'criterion 5: the right value in uppercase -> group_changed');            -- 38
reset role;
select throws_ok(pg_temp.as_sql(pg_temp.u('02'), pg_temp.del_sql(pg_temp.g('a1'),
    left(pg_temp.fp(pg_temp.g('a1')), 31)
    || case when right(pg_temp.fp(pg_temp.g('a1')), 1) = '0' then '1' else '0' end)),
  '22023', 'group_changed', 'criterion 5: one character changed -> group_changed');                   -- 39
reset role;
select is((pg_temp.counts(pg_temp.g('a1'), pg_temp.bid('rl')) ->> 'groups')::integer, 1,
  'criterion 5: after every refusal GL still exists');                                                -- 40

-- ===========================================================================
-- E. A waiting receipt (criteria 7, 8)
-- ===========================================================================
-- RW: Ana hosts, Ben joins; X claimed by Ana, Y unclaimed (W2); attached to GW.
select pg_temp.mk('rw', pg_temp.u('01'),
  jsonb_build_array(pg_temp.it(0, 'X', 400), pg_temp.it(1, 'Y', 600)), 0, 1000, array[pg_temp.u('02')]);
select pg_temp.claim(pg_temp.u('01'), 'rw', 'X');
select pg_temp.attach(pg_temp.u('01'), 'rw', pg_temp.g('a3'));
select pg_temp.keep('gw0', pg_temp.fp(pg_temp.g('a3')));
select throws_ok(pg_temp.as_sql(pg_temp.u('02'), pg_temp.del_sql(pg_temp.g('a3'), pg_temp.fp(pg_temp.g('a3')))),
  '22023', 'receipts_waiting', 'criterion 7: a W2 receipt with a fresh fingerprint -> receipts_waiting'); -- 41
reset role;
select pg_temp.claim(pg_temp.u('02'), 'rw', 'Y');
select throws_ok(pg_temp.as_sql(pg_temp.u('02'), pg_temp.del_sql(pg_temp.g('a3'), pg_temp.kept('gw0'))),
  '22023', 'group_changed', 'criterion 8: the claim changed the fingerprint; the stale one -> group_changed (checked before waiting)'); -- 42
reset role;
select lives_ok(pg_temp.as_sql(pg_temp.u('02'), pg_temp.del_sql(pg_temp.g('a3'), pg_temp.fp(pg_temp.g('a3')))),
  'criterion 7: once every row is claimed (W1), delete_group succeeds');                              -- 43
reset role;
select is(pg_temp.counts(pg_temp.g('a3'), pg_temp.bid('rw')),
  jsonb_build_object('groups',0,'group_members',0,'group_events',0,'group_hidden',0,'expenses',0,
    'expense_shares',0,'group_payments',0,'bills',0,'line_items',0,'claims',0,'bill_participants',0,
    'bill_events',0,'bill_not_part',0,'bill_seen',0,'bill_payers',0,'bill_payments',0,
    'bill_payment_flags',0),
  'GW and its receipt are gone');                                                                     -- 44

-- ===========================================================================
-- F. Fingerprint sensitivity on GF (criterion 6), and each money write still works
-- ===========================================================================
select pg_temp.mk('rf', pg_temp.u('01'),
  jsonb_build_array(pg_temp.it(0, 'X', 500), pg_temp.it(1, 'Y', 700)), 0, 1200, array[pg_temp.u('02')]);
select pg_temp.keep('f0', pg_temp.fp(pg_temp.g('a2')));
select pg_temp.keep('f', pg_temp.fp(pg_temp.g('a2')));
-- After a step: was the fingerprint changed? Then remember the new one.
create function pg_temp.moved() returns boolean language plpgsql as $$
declare v_old text := pg_temp.kept('f'); v_new text := pg_temp.fp(pg_temp.g('a2'));
begin
  perform pg_temp.keep('f', v_new);
  return v_old is distinct from v_new;
end $$;

select pg_temp.attach(pg_temp.u('01'), 'rf', pg_temp.g('a2'));
select ok(pg_temp.moved(), 'criterion 6: a bill attached changes the fingerprint');                  -- 45
select pg_temp.claim(pg_temp.u('01'), 'rf', 'X');
select ok(pg_temp.moved(), 'criterion 6: a claim changes it');                                       -- 46
select pg_temp.claim(pg_temp.u('01'), 'rf', 'X', false);
select ok(pg_temp.moved(), 'criterion 6: an unclaim changes it');                                    -- 47
select pg_temp.run(pg_temp.u('01'), format('select public.assign_item(%L::uuid, %L::jsonb, ''{}''::jsonb)',
  pg_temp.li('rf', 'X'), jsonb_build_object(pg_temp.u('02')::text, 1)));
select ok(pg_temp.moved(), 'criterion 6: assign_item changes it');                                   -- 48
select pg_temp.run(pg_temp.u('01'), format(
  'select public.update_bill(%L::uuid, %L::jsonb, null, 0, 0, 0, 0, 0, 1300)', pg_temp.bid('rf'),
  (select jsonb_agg(jsonb_build_object('id', li.id, 'name', li.name, 'note', li.note,
            'group_position', li.group_position, 'unit_index', li.unit_index, 'group_size', li.group_size,
            'total_cents', case when li.name = 'Y' then 800 else li.total_cents end) order by li.group_position)
   from public.line_items as li where li.bill_id = pg_temp.bid('rf'))));
select ok(pg_temp.moved(), 'criterion 6: an item price edit changes it');                            -- 49
select pg_temp.run(pg_temp.u('01'), format('select public.set_extras_split(%L::uuid, %L)', pg_temp.bid('rf'), 'equal'));
select ok(pg_temp.moved(), 'criterion 6: an extras-split change changes it');                        -- 50
select pg_temp.run(pg_temp.u('01'), format('select public.set_payer(%L::uuid, %L::uuid)', pg_temp.bid('rf'), pg_temp.u('02')));
select ok(pg_temp.moved(), 'criterion 6: a payer change on a group bill changes it');               -- 51
select pg_temp.join(pg_temp.u('03'), pg_temp.g('a2'));
select ok(pg_temp.moved(), 'criterion 6: a member joining changes it');                              -- 52

select lives_ok(pg_temp.as_sql(pg_temp.u('01'), pg_temp.add_expense_sql(pg_temp.g('e5'), pg_temp.g('a2'),
  pg_temp.u('01'), 3000, pg_temp.eq(pg_temp.u('01'), pg_temp.u('02')))),
  'add_expense still works on a live group');                                                         -- 53
reset role;
select ok(pg_temp.moved(), 'criterion 6: add_expense changes it');                                   -- 54
select lives_ok(pg_temp.as_sql(pg_temp.u('01'), pg_temp.edit_expense_sql(pg_temp.g('e5'), 1,
  pg_temp.u('01'), 4000, pg_temp.eq(pg_temp.u('01'), pg_temp.u('02')))),
  'edit_expense still works on a live group');                                                        -- 55
reset role;
select ok(pg_temp.moved(), 'criterion 6: edit_expense changes it');                                  -- 56
select lives_ok(pg_temp.as_sql(pg_temp.u('01'), format('select public.delete_expense(%L::uuid, 2)', pg_temp.g('e5'))),
  'delete_expense still works on a live group');                                                      -- 57
reset role;
select ok(pg_temp.moved(), 'criterion 6: delete_expense changes it');                                -- 58
select lives_ok(pg_temp.as_sql(pg_temp.u('02'), pg_temp.pay_sql(pg_temp.g('f5'), pg_temp.g('a2'),
  pg_temp.u('02'), pg_temp.u('01'), 500)),
  'record_payment still works on a live group');                                                      -- 59
reset role;
select ok(pg_temp.moved(), 'criterion 6: record_payment changes it');                                -- 60
select lives_ok(pg_temp.as_sql(pg_temp.u('01'), format('select public.undo_payment(%L::uuid)', pg_temp.g('f5'))),
  'undo_payment still works on a live group');                                                        -- 61
reset role;
select ok(pg_temp.moved(), 'criterion 6: undo_payment changes it');                                  -- 62

select pg_temp.run(pg_temp.u('01'), format('select public.rename_group(%L::uuid, %L)', pg_temp.g('a2'), 'Renamed'));
select ok(not pg_temp.moved(), 'criterion 6: rename leaves it unchanged');                           -- 63
select pg_temp.run(pg_temp.u('01'), format('select public.rotate_group_code(%L::uuid)', pg_temp.g('a2')));
select ok(not pg_temp.moved(), 'criterion 6: rotating the link leaves it unchanged');                -- 64
select pg_temp.run(pg_temp.u('02'), format('select public.set_group_hidden(%L::uuid, true)', pg_temp.g('a2')));
select ok(not pg_temp.moved(), 'criterion 6: hide leaves it unchanged');                             -- 65
select pg_temp.run(pg_temp.u('02'), format('select public.set_group_hidden(%L::uuid, false)', pg_temp.g('a2')));
select ok(not pg_temp.moved(), 'criterion 6: unhide leaves it unchanged');                           -- 66
select pg_temp.run(pg_temp.u('03'), format('select public.set_not_part(%L::uuid, true)', pg_temp.bid('rf')));
select ok(not pg_temp.moved(), 'criterion 6: set_not_part leaves it unchanged');                     -- 67

select pg_temp.run(pg_temp.u('01'), format('select public.detach_bill_from_group(%L::uuid)', pg_temp.bid('rf')));
select ok(pg_temp.moved(), 'criterion 6: a bill detached changes it');                               -- 68
select throws_ok(pg_temp.as_sql(pg_temp.u('02'), pg_temp.del_sql(pg_temp.g('a2'), pg_temp.kept('f0'))),
  '22023', 'group_changed', 'criterion 6: delete_group with the first fingerprint -> group_changed'); -- 69
reset role;

-- ===========================================================================
-- G. The loaded delete (A2.1, A2.2, A2.4; criteria 2, 10)
-- ===========================================================================
select pg_temp.keep('n1', pg_temp.bill_state(pg_temp.bid('n1')));
select pg_temp.keep('go', pg_temp.fp(pg_temp.g('a4')));
select pg_temp.keep('glcode', pg_temp.gcode(pg_temp.g('a1')));
select pg_temp.keep('gl', pg_temp.snapfp(pg_temp.u('02'), pg_temp.g('a1')));
-- Positive control: every kind of row the delete must remove is there.
select ok(
  (select bool_and((pg_temp.counts(pg_temp.g('a1'), pg_temp.bid('rl')) ->> k)::integer > 0)
   from unnest(array['groups','group_members','group_events','group_hidden','expenses','expense_shares',
                     'group_payments','bills','line_items','claims','bill_participants','bill_events',
                     'bill_not_part','bill_seen']) as k)
  and exists (select 1 from public.group_payments as gp
              where gp.group_id = pg_temp.g('a1') and gp.source = 'bill_mark' and gp.bill_id = pg_temp.bid('rl'))
  and exists (select 1 from public.group_payments as gp
              where gp.group_id = pg_temp.g('a1') and gp.undone_at is not null)
  and exists (select 1 from public.expenses as x
              where x.group_id = pg_temp.g('a1') and x.deleted_at is not null),
  'GL holds every kind of row: members, events, hidden, live/edited/deleted expenses, shares, '
  'a bill_mark payment, an undone payment, a receipt with claims, participants, events, not-part, seen'); -- 70
select lives_ok(pg_temp.as_sql(pg_temp.u('02'), pg_temp.del_sql(pg_temp.g('a1'), pg_temp.kept('gl'))),
  'criterion 2: a member deletes the loaded group with the snapshot''s fingerprint');               -- 71
reset role;
select is(pg_temp.counts(pg_temp.g('a1'), pg_temp.bid('rl')),
  jsonb_build_object('groups',0,'group_members',0,'group_events',0,'group_hidden',0,'expenses',0,
    'expense_shares',0,'group_payments',0,'bills',0,'line_items',0,'claims',0,'bill_participants',0,
    'bill_events',0,'bill_not_part',0,'bill_seen',0,'bill_payers',0,'bill_payments',0,
    'bill_payment_flags',0),
  'A2.1: 0 rows of GL or its receipt are left in any table');                                         -- 72
select throws_ok(pg_temp.as_sql(pg_temp.u('02'), format('select public.group_snapshot(%L::uuid)', pg_temp.g('a1'))),
  '42501', 'not_allowed', 'A2.4: group_snapshot of the deleted group -> the existing 42501 not_allowed'); -- 73
reset role;
select throws_ok(pg_temp.as_sql(pg_temp.u('04'), format('select public.join_group(%L)', pg_temp.kept('glcode'))),
  'P0002', 'invalid_code', 'A2.4: join_group with the old code (a stranger) -> P0002 invalid_code');  -- 74
reset role;
select throws_ok(pg_temp.as_sql(pg_temp.u('02'), format('select public.join_group(%L)', pg_temp.kept('glcode'))),
  'P0002', 'invalid_code', 'A2.4: join_group with the old code (a former member) -> P0002 invalid_code'); -- 75
reset role;
select pg_temp.act(pg_temp.u('02'));
set local role authenticated;
select ok(
  not exists (select 1 from public.my_groups() as m where m.id = pg_temp.g('a1'))
  and exists (select 1 from public.my_groups() as m where m.id = pg_temp.g('a4')),
  'A2.4: my_groups lists the live group and not the deleted one');                                  -- 76
select is(
  (select count(*)::integer from public.groups where id = pg_temp.g('a1'))
  + (select count(*)::integer from public.group_members where group_id = pg_temp.g('a1'))
  + (select count(*)::integer from public.group_events where group_id = pg_temp.g('a1'))
  + (select count(*)::integer from public.expenses where group_id = pg_temp.g('a1'))
  + (select count(*)::integer from public.expense_shares where group_id = pg_temp.g('a1'))
  + (select count(*)::integer from public.group_payments where group_id = pg_temp.g('a1')),
  0, 'A2.4: a former member''s table reads of the deleted group return 0 rows');                    -- 77
select ok(
  exists (select 1 from public.groups where id = pg_temp.g('a4'))
  and exists (select 1 from public.group_members where group_id = pg_temp.g('a4'))
  and exists (select 1 from public.expenses where group_id = pg_temp.g('a4'))
  and exists (select 1 from public.expense_shares where group_id = pg_temp.g('a4'))
  and exists (select 1 from public.group_events where group_id = pg_temp.g('a4')),
  'positive control: the same reads still return the live group''s rows');                         -- 78
select is(
  (select count(*)::integer from public.bills where id = pg_temp.bid('rl'))
  + (select count(*)::integer from public.line_items where bill_id = pg_temp.bid('rl'))
  + (select count(*)::integer from public.claims where bill_id = pg_temp.bid('rl'))
  + (select count(*)::integer from public.bill_participants where bill_id = pg_temp.bid('rl')),
  0, 'A2.4: reads of the deleted receipt return 0 rows');                                            -- 79
reset role;
select throws_ok(pg_temp.as_sql(pg_temp.u('02'), pg_temp.del_sql(pg_temp.g('a1'), pg_temp.kept('gl'))),
  '42501', 'not_allowed', 'A2.11: a retry after the delete went through -> 42501 (the group is gone)'); -- 80
reset role;
select is(pg_temp.bill_state(pg_temp.bid('n1')), pg_temp.kept('n1'),
  'a bill with no group is untouched (every row of it and its children)');                          -- 81
select is(pg_temp.fp(pg_temp.g('a4')), pg_temp.kept('go'), 'another live group is untouched');     -- 82

-- ===========================================================================
-- H. Money writes after a delete get 42501 (option A)
-- ===========================================================================
select pg_temp.run(pg_temp.u('01'), pg_temp.add_expense_sql(pg_temp.g('e6'), pg_temp.g('a5'), pg_temp.u('01'), 800,
  pg_temp.eq(pg_temp.u('01'), pg_temp.u('02'))));
select pg_temp.run(pg_temp.u('02'), pg_temp.pay_sql(pg_temp.g('f6'), pg_temp.g('a5'), pg_temp.u('02'), pg_temp.u('01'), 400));
select lives_ok(pg_temp.as_sql(pg_temp.u('01'), pg_temp.del_sql(pg_temp.g('a5'), pg_temp.fp(pg_temp.g('a5')))),
  'GX is deleted (one expense, one payment, no receipts)');                                          -- 83
reset role;
select throws_ok(pg_temp.as_sql(pg_temp.u('01'), pg_temp.add_expense_sql(gen_random_uuid(), pg_temp.g('a5'),
  pg_temp.u('01'), 800, pg_temp.eq(pg_temp.u('01'), pg_temp.u('02')))),
  '42501', 'not_allowed', 'add_expense on a deleted group -> 42501');                               -- 84
reset role;
select throws_ok(pg_temp.as_sql(pg_temp.u('01'), pg_temp.edit_expense_sql(pg_temp.g('e6'), 1,
  pg_temp.u('01'), 900, pg_temp.eq(pg_temp.u('01'), pg_temp.u('02')))),
  '42501', 'not_allowed', 'edit_expense of a deleted group''s expense -> 42501');                   -- 85
reset role;
select throws_ok(pg_temp.as_sql(pg_temp.u('01'), format('select public.delete_expense(%L::uuid, 1)', pg_temp.g('e6'))),
  '42501', 'not_allowed', 'delete_expense of a deleted group''s expense -> 42501');                 -- 86
reset role;
select throws_ok(pg_temp.as_sql(pg_temp.u('02'), pg_temp.pay_sql(gen_random_uuid(), pg_temp.g('a5'),
  pg_temp.u('02'), pg_temp.u('01'), 400)),
  '42501', 'not_allowed', 'record_payment on a deleted group -> 42501');                            -- 87
reset role;
select throws_ok(pg_temp.as_sql(pg_temp.u('01'), format('select public.undo_payment(%L::uuid)', pg_temp.g('f6'))),
  '42501', 'not_allowed', 'undo_payment of a deleted group''s payment -> 42501');                   -- 88
reset role;

-- ===========================================================================
-- I. Lock order on the bodies (criterion 9; contract L; pgTAP can't run two sessions)
-- ===========================================================================
create function pg_temp.pos(p_body text, p_needle text) returns integer language sql immutable as $$
  select nullif(strpos(p_body, p_needle), 0)
$$;
select ok(
  pg_temp.pos(pg_temp.body('public.delete_group(uuid, text)'), 'from public.group_members as gm')
    < pg_temp.pos(pg_temp.body('public.delete_group(uuid, text)'), 'for update;'),
  'criterion 9: the membership read comes before any lock');                                         -- 89
select ok(
  pg_temp.pos(pg_temp.body('public.delete_group(uuid, text)'),
              'from public.groups as g where g.id = p_group_id for update;')
    < pg_temp.pos(pg_temp.body('public.delete_group(uuid, text)'), 'for update of b;')
  and pg_temp.pos(pg_temp.body('public.delete_group(uuid, text)'), 'order by b.id')
    < pg_temp.pos(pg_temp.body('public.delete_group(uuid, text)'), 'for update of b;'),
  'criterion 9: groups FOR UPDATE, then the bills FOR UPDATE in id order');                         -- 90
select ok(
  pg_temp.pos(pg_temp.body('public.delete_group(uuid, text)'), 'for update of b;')
    < pg_temp.pos(pg_temp.body('public.delete_group(uuid, text)'), 'group_money_fingerprint(p_group_id)')
  and pg_temp.pos(pg_temp.body('public.delete_group(uuid, text)'), 'group_money_fingerprint(p_group_id)')
    < pg_temp.pos(pg_temp.body('public.delete_group(uuid, text)'), 'group_bill_waiting(b.id)'),
  'criterion 9 / 8: fingerprint, then waiting receipts, both after the locks');                     -- 91
select ok(
  (select bool_and(a.p < b.p)
   from (select n, pg_temp.pos(pg_temp.body('public.delete_group(uuid, text)'), 'delete from public.' || t || ' as') as p
         from unnest(array['expense_shares','expenses','group_payments','bills','group_hidden','groups'])
              with ordinality as x(t, n)) as a
   join (select n, pg_temp.pos(pg_temp.body('public.delete_group(uuid, text)'), 'delete from public.' || t || ' as') as p
         from unnest(array['expense_shares','expenses','group_payments','bills','group_hidden','groups'])
              with ordinality as x(t, n)) as b on b.n = a.n + 1),
  'A2.1: deletes in the FK-safe order');                                                             -- 92
-- Each money write: membership read, then the group FOR KEY SHARE, then its first write or row lock.
create function pg_temp.key_share_first(p regprocedure, p_first text) returns boolean language sql as $$
  select pg_temp.pos(pg_temp.body(p), 'from public.group_members as gm')
           < pg_temp.pos(pg_temp.body(p), 'for key share;')
     and pg_temp.pos(pg_temp.body(p), 'for key share;') < pg_temp.pos(pg_temp.body(p), p_first)
     and pg_temp.pos(pg_temp.body(p), 'for key share;') < pg_temp.pos(pg_temp.body(p), 'if not found then')
$$;
select ok(pg_temp.key_share_first('public.add_expense(uuid, uuid, text, uuid, bigint, text, jsonb)',
  'insert into public.expenses'), 'add_expense: the group FOR KEY SHARE before its first insert');  -- 93
select ok(pg_temp.key_share_first('public.edit_expense(uuid, integer, text, uuid, bigint, text, jsonb)',
  'for no key update'), 'edit_expense: the group FOR KEY SHARE before the expense row lock');      -- 94
select ok(pg_temp.key_share_first('public.delete_expense(uuid, integer)', 'for no key update'),
  'delete_expense: the group FOR KEY SHARE before the expense row lock');                           -- 95
select ok(pg_temp.key_share_first('public.record_payment(uuid, uuid, uuid, uuid, bigint, text, text)',
  'insert into public.group_payments'), 'record_payment: the group FOR KEY SHARE before its insert'); -- 96
select ok(pg_temp.key_share_first('public.undo_payment(uuid)', 'for no key update'),
  'undo_payment: the group FOR KEY SHARE before the payment row lock');                             -- 97
select ok(
  (select bool_and(pg_temp.pos(pg_temp.body(p), 'from public.groups as g where g.id = p_group_id for no key update') is not null)
   from unnest(array['public.leave_group(uuid)'::regprocedure,
                     'public.attach_bill_to_group(uuid, uuid)'::regprocedure]) as p),
  'leave_group / attach keep the group FOR NO KEY UPDATE as their first lock (not re-created here)'); -- 98

select * from finish();
rollback;
