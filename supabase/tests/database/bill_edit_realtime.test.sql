-- pgTAP tests for update_bill, the Realtime broadcast triggers and the private-channel policy
-- (spec 2026-11-20-m1b-m2-share-and-claim.md, Task 4, criteria 35-44; Amendment A3).
--
-- Users: H a1... 'Hana' (host of X), P a2... 'Pat' and R a5... 'Rae' (participants of X),
--        O a3... 'Oli' (outsider; host of Y), J a4... 'Jo' (joins X during the test).
-- Broadcasts are checked by reading realtime.messages directly (as postgres). The installed
-- realtime.send inserts into the partitioned table inside the caller's transaction, so no stub
-- is needed. Before each action the test deletes the bill topics' messages, so counts are exact
-- (everything is rolled back at the end).

begin;

create extension if not exists pgtap with schema extensions;

select plan(61);

insert into auth.users (id, email, raw_user_meta_data) values
  ('a1000000-0000-0000-0000-000000000001', 'h@test.local', '{"full_name":"Hana"}'::jsonb),
  ('a2000000-0000-0000-0000-000000000002', 'p@test.local', '{"full_name":"Pat"}'::jsonb),
  ('a3000000-0000-0000-0000-000000000003', 'o@test.local', '{"full_name":"Oli"}'::jsonb),
  ('a4000000-0000-0000-0000-000000000004', 'j@test.local', '{"full_name":"Jo"}'::jsonb),
  ('a5000000-0000-0000-0000-000000000005', 'r@test.local', '{"full_name":"Rae"}'::jsonb);

-- X: Burger 1500, Fries 600, Beer x2 700/700; tax 280, tip 700, total 4480 (as host H).
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
  perform set_config('test.x_topic', 'bill:' || r.bill_id::text, true);
end $$;

-- Y: O's own bill.
set local request.jwt.claims = '{"sub":"a3000000-0000-0000-0000-000000000003","role":"authenticated"}';
do $$
declare r record;
begin
  select * into r from public.create_bill(
    '[{"name":"Tea","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":300}]'::jsonb,
    null, 0, 0, 0, 0, 0, 300);
  perform set_config('test.y_id', r.bill_id::text, true);
  perform set_config('test.y_topic', 'bill:' || r.bill_id::text, true);
end $$;

reset role;

-- Row ids of X and Y, by name/unit.
do $$ begin
  perform set_config('test.burger', (select id::text from public.line_items where bill_id = current_setting('test.x_id')::uuid and name = 'Burger'), true);
  perform set_config('test.fries', (select id::text from public.line_items where bill_id = current_setting('test.x_id')::uuid and name = 'Fries'), true);
  perform set_config('test.beer0', (select id::text from public.line_items where bill_id = current_setting('test.x_id')::uuid and name = 'Beer' and unit_index = 0), true);
  perform set_config('test.beer1', (select id::text from public.line_items where bill_id = current_setting('test.x_id')::uuid and name = 'Beer' and unit_index = 1), true);
  perform set_config('test.tea', (select id::text from public.line_items where bill_id = current_setting('test.y_id')::uuid), true);
end $$;

-- P and R join X. Claims: H on Burger and Fries; P on Fries, Beer 0 and Beer 1 (P's Fries at
-- 2 parts, set as postgres, to show kept rows keep their parts).
set local role authenticated;
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.join_bill(current_setting('test.x_code'));
select public.set_claim(current_setting('test.fries')::uuid, true);
select public.set_claim(current_setting('test.beer0')::uuid, true);
select public.set_claim(current_setting('test.beer1')::uuid, true);
set local request.jwt.claims = '{"sub":"a5000000-0000-0000-0000-000000000005","role":"authenticated"}';
select public.join_bill(current_setting('test.x_code'));
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.set_claim(current_setting('test.burger')::uuid, true);
select public.set_claim(current_setting('test.fries')::uuid, true);
reset role;
update public.claims set parts = 2
  where line_item_id = current_setting('test.fries')::uuid
    and user_id = 'a2000000-0000-0000-0000-000000000002';

-- The edit arguments (criterion 35): Burger kept at 1800, Fries kept, Beer unit 0 kept as a
-- size-1 group, Beer unit 1 omitted, new Wine x1 at 900. Items 4000 + tax 280 + tip 700 = 4980.
do $$ begin perform set_config('test.edit_rows', jsonb_build_array(
  jsonb_build_object('id', current_setting('test.burger'), 'name', 'Burger', 'note', null, 'group_position', 0, 'unit_index', 0, 'group_size', 1, 'total_cents', 1800),
  jsonb_build_object('id', current_setting('test.fries'), 'name', 'Fries', 'note', null, 'group_position', 1, 'unit_index', 0, 'group_size', 1, 'total_cents', 600),
  jsonb_build_object('id', current_setting('test.beer0'), 'name', 'Beer', 'note', null, 'group_position', 2, 'unit_index', 0, 'group_size', 1, 'total_cents', 700),
  jsonb_build_object('name', 'Wine', 'note', null, 'group_position', 3, 'unit_index', 0, 'group_size', 1, 'total_cents', 900)
)::text, true); end $$;

-- A snapshot of X (rows and money) to prove failed calls change nothing.
create temp table x_before as
  select li.id, li.group_position, li.unit_index, li.group_size, li.name, li.note, li.total_cents
  from public.line_items li where li.bill_id = current_setting('test.x_id')::uuid;
create temp table x_money_before as
  select b.subtotal_cents, b.tax_cents, b.fees_cents, b.tip_cents, b.subtotal_discount_cents,
         b.total_discount_cents, b.total_cents, b.edited_at
  from public.bills b where b.id = current_setting('test.x_id')::uuid;
create temp table kept_claims_before as
  select c.line_item_id, c.user_id, c.parts from public.claims c
  where c.line_item_id in (current_setting('test.burger')::uuid, current_setting('test.fries')::uuid,
                           current_setting('test.beer0')::uuid);
grant select on x_before, x_money_before, kept_claims_before to authenticated;

-- ---------------------------------------------------------------------------
-- Function shape and privileges (criteria 22 style, 41)
-- ---------------------------------------------------------------------------
select ok(
  (select prosecdef and proconfig = array['search_path=""'] from pg_proc
     where oid = 'public.update_bill(uuid,jsonb,integer,integer,integer,integer,integer,integer,integer)'::regprocedure),
  'update_bill is security definer with an empty search_path'
);
select ok(
  (select bool_and(prosecdef and proconfig = array['search_path=""']) and count(*) = 2 from pg_proc
     where oid in ('private.broadcast_bill_change()'::regprocedure, 'private.can_listen_bill_topic(text)'::regprocedure)),
  'criterion 41: broadcast_bill_change and can_listen_bill_topic are definer with an empty search_path'
);
select ok(
  has_function_privilege('authenticated', 'public.update_bill(uuid,jsonb,integer,integer,integer,integer,integer,integer,integer)', 'execute')
  and not has_function_privilege('anon', 'public.update_bill(uuid,jsonb,integer,integer,integer,integer,integer,integer,integer)', 'execute'),
  'authenticated can execute update_bill; anon cannot'
);
select ok(
  not has_function_privilege('anon', 'private.can_listen_bill_topic(text)', 'execute')
  and not has_function_privilege('anon', 'private.broadcast_bill_change()', 'execute')
  and not has_function_privilege('authenticated', 'private.broadcast_bill_change()', 'execute'),
  'anon cannot execute the Realtime helpers; nobody but the owner can call the trigger function'
);
select ok(
  (select position('email' in lower(prosrc)) = 0 from pg_proc
     where oid = 'public.update_bill(uuid,jsonb,integer,integer,integer,integer,integer,integer,integer)'::regprocedure),
  'update_bill does not reference email'
);

-- ---------------------------------------------------------------------------
-- 42501 without a user, and criterion 36: only the host
-- ---------------------------------------------------------------------------
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select throws_ok($$ select public.update_bill(current_setting('test.x_id')::uuid, current_setting('test.edit_rows')::jsonb, null, 280, 0, 700, 0, 0, 4980) $$,
  '42501', null, 'anon cannot call update_bill');

reset role;
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated"}';
select throws_ok($$ select public.update_bill(current_setting('test.x_id')::uuid, current_setting('test.edit_rows')::jsonb, null, 280, 0, 700, 0, 0, 4980) $$,
  '42501', 'not_allowed', 'update_bill without a sub raises 42501');

set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok($$ select public.update_bill(current_setting('test.x_id')::uuid, current_setting('test.edit_rows')::jsonb, null, 280, 0, 700, 0, 0, 4980) $$,
  '42501', 'not_allowed', 'criterion 36: update_bill as participant P raises 42501');

set local request.jwt.claims = '{"sub":"a3000000-0000-0000-0000-000000000003","role":"authenticated"}';
select throws_ok($$ select public.update_bill(current_setting('test.x_id')::uuid, current_setting('test.edit_rows')::jsonb, null, 280, 0, 700, 0, 0, 4980) $$,
  '42501', 'not_allowed', 'criterion 36: update_bill as outsider O raises 42501');

set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select throws_ok($$ select public.update_bill(gen_random_uuid(), current_setting('test.edit_rows')::jsonb, null, 280, 0, 700, 0, 0, 4980) $$,
  '42501', 'not_allowed', 'update_bill on an unknown bill gives the same 42501 as "not the host"');

-- Criterion 36: a row id from bill Y.
select throws_ok(
  format($$ select public.update_bill(current_setting('test.x_id')::uuid, %L::jsonb, null, 280, 0, 700, 0, 0, 4980) $$,
    jsonb_set(current_setting('test.edit_rows')::jsonb, '{3,id}', to_jsonb(current_setting('test.tea')))),
  '22023', 'invalid_bill', 'criterion 36: a row id from bill Y raises 22023');
select throws_ok(
  format($$ select public.update_bill(current_setting('test.x_id')::uuid, %L::jsonb, null, 280, 0, 700, 0, 0, 4980) $$,
    jsonb_set(current_setting('test.edit_rows')::jsonb, '{3,id}', '"c9000000-0000-0000-0000-000000000009"')),
  '22023', 'invalid_bill', 'an unknown row id raises 22023');

-- Criterion 37: the shared validation, spot-checked.
select throws_ok($$ select public.update_bill(current_setting('test.x_id')::uuid, '[]'::jsonb, null, 280, 0, 700, 0, 0, 4980) $$,
  '22023', 'invalid_bill', 'criterion 37: 0 rows raises 22023');
select throws_ok(
  format($$ select public.update_bill(current_setting('test.x_id')::uuid, %L::jsonb, null, 280, 0, 700, 0, 0, 4980) $$,
    jsonb_set(current_setting('test.edit_rows')::jsonb, '{0,total_cents}', '12.5')),
  '22023', 'invalid_bill', 'criterion 37: total_cents 12.5 raises 22023');
select throws_ok($$ select public.update_bill(current_setting('test.x_id')::uuid, current_setting('test.edit_rows')::jsonb, null, 280, 0, 700, 0, 0, 4982) $$,
  '22023', 'invalid_bill', 'criterion 37: a total 2 cents off raises 22023');
select throws_ok(
  format($$ select public.update_bill(current_setting('test.x_id')::uuid, %L::jsonb, null, 280, 0, 700, 0, 0, 4980) $$,
    jsonb_set(current_setting('test.edit_rows')::jsonb, '{2,unit_index}', '1')),
  '22023', 'invalid_bill', 'criterion 37: a broken unit_index raises 22023');
select throws_ok($$ select public.update_bill(current_setting('test.x_id')::uuid, current_setting('test.edit_rows')::jsonb, null, null, 0, 700, 0, 0, 4980) $$,
  '22023', 'invalid_bill', 'a null tax raises 22023');

reset role;
select results_eq(
  $$ select li.id, li.group_position, li.unit_index, li.group_size, li.name, li.note, li.total_cents
       from public.line_items li where li.bill_id = current_setting('test.x_id')::uuid order by li.id $$,
  $$ select * from x_before order by id $$,
  'criteria 35-37: failed update_bill calls leave X''s rows exactly as before'
);
select results_eq(
  $$ select b.subtotal_cents, b.tax_cents, b.fees_cents, b.tip_cents, b.subtotal_discount_cents,
            b.total_discount_cents, b.total_cents, b.edited_at
       from public.bills b where b.id = current_setting('test.x_id')::uuid $$,
  $$ select * from x_money_before $$,
  'criteria 35-37: failed update_bill calls leave X''s money and edited_at unchanged'
);
select is(
  (select count(*)::integer from public.claims where bill_id = current_setting('test.x_id')::uuid),
  5, 'failed update_bill calls leave every claim in place'
);

-- ---------------------------------------------------------------------------
-- Criterion 35, 39, 44: the edit
-- ---------------------------------------------------------------------------
delete from realtime.messages where topic like 'bill:%';

set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok(
  $$ select public.update_bill(current_setting('test.x_id')::uuid, current_setting('test.edit_rows')::jsonb, null, 280, 0, 700, 0, 0, 4980) $$,
  'criterion 35/44: update_bill as H succeeds, cascading the removed row''s claims without error'
);
reset role;

select is(
  (select count(*)::integer from public.line_items where id = current_setting('test.beer1')::uuid),
  0, 'criterion 35: Beer unit 1 (omitted) is gone'
);
select is(
  (select count(*)::integer from public.claims where line_item_id = current_setting('test.beer1')::uuid),
  0, 'criterion 35: Beer unit 1''s claims are gone'
);
select results_eq(
  $$ select c.line_item_id, c.user_id, c.parts from public.claims c
       where c.line_item_id in (current_setting('test.burger')::uuid, current_setting('test.fries')::uuid,
                                current_setting('test.beer0')::uuid)
       order by 1, 2 $$,
  $$ select * from kept_claims_before order by 1, 2 $$,
  'criterion 35: claims on Burger, Fries and Beer unit 0 are unchanged (same users and parts)'
);
select results_eq(
  $$ select name, group_position, unit_index, group_size, total_cents from public.line_items
       where bill_id = current_setting('test.x_id')::uuid order by group_position, unit_index $$,
  $$ values ('Burger'::text, 0, 0, 1, 1800), ('Fries', 1, 0, 1, 600), ('Beer', 2, 0, 1, 700), ('Wine', 3, 0, 1, 900) $$,
  'criterion 35: X now has Burger 1800, Fries, Beer as a size-1 group, and the new Wine'
);
select is(
  (select id::text from public.line_items where bill_id = current_setting('test.x_id')::uuid and name = 'Beer'),
  current_setting('test.beer0'), 'criterion 35: the kept Beer row is unit 0''s original row'
);
select results_eq(
  $$ select subtotal_cents, tax_cents, fees_cents, tip_cents, subtotal_discount_cents, total_discount_cents,
            total_cents, edited_at is not null
       from public.bills where id = current_setting('test.x_id')::uuid $$,
  $$ values (null::integer, 280, 0, 700, 0, 0, 4980, true) $$,
  'criterion 35: the money columns are updated and edited_at is set'
);
select is(
  (select count(*)::integer from realtime.messages
     where topic = current_setting('test.x_topic') and payload ->> 't' = 'bills'),
  1, 'criterion 39: update_bill sends exactly one message with t = bills'
);
select is(
  (select count(*)::integer from realtime.messages where payload ->> 't' = 'line_items'),
  0, 'criterion 39: update_bill sends no message with t = line_items'
);
select ok(
  (select count(*) filter (where payload ->> 't' = 'claims') >= 1
          and bool_and(topic = current_setting('test.x_topic'))
     from realtime.messages where topic like 'bill:%'),
  'criterion 44: the cascaded claim deletes broadcast, and every message goes only to bill:<X>'
);

-- Criterion 36: swapping two groups' positions (the deferrable unique constraint).
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok(
  format($$ select public.update_bill(current_setting('test.x_id')::uuid, %L::jsonb, null, 280, 0, 700, 0, 0, 4980) $$,
    jsonb_set(jsonb_set(current_setting('test.edit_rows')::jsonb, '{0,group_position}', '1'), '{1,group_position}', '0')
      #- '{3}'
      || jsonb_build_array(jsonb_build_object('id', (select id::text from public.line_items where bill_id = current_setting('test.x_id')::uuid and name = 'Wine'),
           'name', 'Wine', 'note', null, 'group_position', 3, 'unit_index', 0, 'group_size', 1, 'total_cents', 900))),
  'criterion 36: swapping Burger and Fries positions succeeds'
);
reset role;
select results_eq(
  $$ select name from public.line_items where bill_id = current_setting('test.x_id')::uuid order by group_position $$,
  $$ values ('Fries'::text), ('Burger'), ('Beer'), ('Wine') $$,
  'criterion 36: the positions are swapped and Wine kept its id (no duplicate)'
);
select lives_ok(
  $$ set constraints all immediate $$,
  'criterion 36: the deferred unique constraint holds after the swap'
);

-- ---------------------------------------------------------------------------
-- Criterion 38: set_claim broadcasts a data-free hint
-- ---------------------------------------------------------------------------
delete from realtime.messages where topic like 'bill:%';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.set_claim((select id from public.line_items where bill_id = current_setting('test.x_id')::uuid and name = 'Wine'), true);
reset role;

select results_eq(
  $$ select topic, event, private, extension from realtime.messages where topic like 'bill:%' $$,
  $$ values (current_setting('test.x_topic'), 'changed'::text, true, 'broadcast'::text) $$,
  'criterion 38: set_claim sends one private ''changed'' broadcast on bill:<X>'
);
select is(
  (select payload - 'id' from realtime.messages where topic = current_setting('test.x_topic')),
  '{"t":"claims"}'::jsonb,
  'criterion 38: the payload is {"t":"claims"} apart from realtime.send''s message id'
);
select ok(
  (select payload ->> 'id' = id::text
          and (select array_agg(k order by k) from jsonb_object_keys(payload) as k) = array['id', 't']
     from realtime.messages where topic = current_setting('test.x_topic')),
  'criterion 38: the only other key is "id", the message''s own random id (no bill, user, parts or cents)'
);

-- A direct client insert (not through set_claim) also broadcasts: the definer trigger may write
-- realtime.messages even though the client may not.
delete from realtime.messages where topic like 'bill:%';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a5000000-0000-0000-0000-000000000005","role":"authenticated"}';
insert into public.claims (bill_id, line_item_id, user_id)
  values (current_setting('test.x_id')::uuid, current_setting('test.burger')::uuid, 'a5000000-0000-0000-0000-000000000005');
reset role;
select is(
  (select count(*)::integer from realtime.messages where topic = current_setting('test.x_topic') and payload ->> 't' = 'claims'),
  1, 'a direct claim insert by R broadcasts on bill:<X>'
);

-- ---------------------------------------------------------------------------
-- Criterion 39: join_bill broadcasts once, and not on a repeat join
-- ---------------------------------------------------------------------------
delete from realtime.messages where topic like 'bill:%';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a4000000-0000-0000-0000-000000000004","role":"authenticated"}';
select public.join_bill(current_setting('test.x_code'));
reset role;
select results_eq(
  $$ select topic, payload - 'id' from realtime.messages where topic like 'bill:%' $$,
  $$ values (current_setting('test.x_topic'), '{"t":"bill_participants"}'::jsonb) $$,
  'criterion 39: join_bill sends exactly one message, t = bill_participants'
);
set local role authenticated;
set local request.jwt.claims = '{"sub":"a4000000-0000-0000-0000-000000000004","role":"authenticated"}';
select public.join_bill(current_setting('test.x_code'));
reset role;
select is(
  (select count(*)::integer from realtime.messages where topic like 'bill:%'),
  1, 'a repeat join_bill (no row inserted) sends nothing'
);

-- ---------------------------------------------------------------------------
-- Criterion 40: deletes (topic from OLD) and updates
-- ---------------------------------------------------------------------------
delete from realtime.messages where topic like 'bill:%';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.set_claim((select id from public.line_items where bill_id = current_setting('test.x_id')::uuid and name = 'Wine'), false);
reset role;
select results_eq(
  $$ select topic, payload - 'id' from realtime.messages where topic like 'bill:%' $$,
  $$ values (current_setting('test.x_topic'), '{"t":"claims"}'::jsonb) $$,
  'criterion 40: an unclaim sends one message on bill:<X> (bill id read from the deleted row)'
);

delete from realtime.messages where topic like 'bill:%';
update public.claims set parts = 3 where bill_id = current_setting('test.x_id')::uuid;
select results_eq(
  $$ select topic, payload - 'id' from realtime.messages where topic like 'bill:%' $$,
  $$ values (current_setting('test.x_topic'), '{"t":"claims"}'::jsonb) $$,
  'criterion 40: a multi-row claims update sends one message per bill per statement'
);

delete from realtime.messages where topic like 'bill:%';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.rotate_join_code(current_setting('test.x_id')::uuid);
reset role;
select results_eq(
  $$ select topic, payload - 'id' from realtime.messages where topic like 'bill:%' $$,
  $$ values (current_setting('test.x_topic'), '{"t":"bills"}'::jsonb) $$,
  'rotate_join_code sends one bills message, without the code'
);
select ok(
  -- A uuid has at most 12 hex chars in a row, so only a join code could match 20.
  not exists (select 1 from realtime.messages where topic like 'bill:%' and payload::text ~ '[0-9a-f]{20}'),
  'no message payload contains a join code'
);

-- ---------------------------------------------------------------------------
-- Criterion 41: private.can_listen_bill_topic
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select ok(private.can_listen_bill_topic(current_setting('test.x_topic')), 'criterion 41: host H can listen to bill:<X>');
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select ok(private.can_listen_bill_topic(current_setting('test.x_topic')), 'criterion 41: participant P can listen to bill:<X>');
set local request.jwt.claims = '{"sub":"a5000000-0000-0000-0000-000000000005","role":"authenticated"}';
select ok(private.can_listen_bill_topic(current_setting('test.x_topic')), 'criterion 41: participant R (no claims) can listen to bill:<X>');
set local request.jwt.claims = '{"sub":"a3000000-0000-0000-0000-000000000003","role":"authenticated"}';
select ok(not private.can_listen_bill_topic(current_setting('test.x_topic')), 'criterion 41: outsider O cannot listen to bill:<X>');
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select results_eq(
  $$ select private.can_listen_bill_topic(t) from unnest(array[
       'bill:x', 'bill:', 'other:' || current_setting('test.x_id'), null,
       current_setting('test.x_id'), 'bill:' || current_setting('test.x_id') || ' ',
       'bill:' || gen_random_uuid()::text, current_setting('test.y_topic')]) as t $$,
  $$ values (false), (false), (false), (false), (false), (false), (false), (false) $$,
  'criterion 41: malformed topics, unknown bills and bills P isn''t in return false without raising'
);

-- ---------------------------------------------------------------------------
-- Criterion 42: the realtime.messages policy
-- ---------------------------------------------------------------------------
reset role;
select results_eq(
  $$ select polcmd::text, polroles::regrole[]::text from pg_policy
       where polrelid = 'realtime.messages'::regclass and polname = 'bill_topic_participants_receive' $$,
  $$ values ('r'::text, '{authenticated}'::text) $$,
  'criterion 42: realtime.messages has the select policy for authenticated'
);
select is(
  (select count(*)::integer from pg_policy
     where polrelid = 'realtime.messages'::regclass and polcmd in ('a', 'w', 'd', '*')),
  0, 'criterion 42: realtime.messages has no insert, update, delete or all policy'
);

-- Messages for X and Y exist to look at.
select realtime.send('{"t":"probe"}'::jsonb, 'changed', current_setting('test.x_topic'), true);
select realtime.send('{"t":"probe"}'::jsonb, 'changed', current_setting('test.y_topic'), true);

set local role authenticated;
select set_config('realtime.topic', current_setting('test.x_topic'), true);
set local request.jwt.claims = '{"sub":"a3000000-0000-0000-0000-000000000003","role":"authenticated"}';
select is(
  (select count(*)::integer from realtime.messages where topic = current_setting('test.x_topic')),
  0, 'criterion 42: as O, X''s messages return 0 rows'
);
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select ok(
  (select count(*) > 0 from realtime.messages where topic = current_setting('test.x_topic')),
  'criterion 42: as P on topic bill:<X>, X''s messages are returned'
);
select is(
  (select count(*)::integer from realtime.messages where topic <> current_setting('test.x_topic')),
  0, 'as P on topic bill:<X>, no other topic''s messages (e.g. Y''s) are visible'
);
select set_config('realtime.topic', '', true);
select is(
  (select count(*)::integer from realtime.messages),
  0, 'as P with no channel topic set, nothing is visible'
);
select set_config('realtime.topic', current_setting('test.x_topic'), true);
select throws_ok(
  $$ insert into realtime.messages (topic, extension, payload, event, private)
       values (current_setting('test.x_topic'), 'broadcast', '{"t":"spoof"}', 'changed', true) $$,
  '42501', null, 'criterion 42: P cannot broadcast (no insert policy)'
);
reset role;

-- The real join check Realtime runs: realtime.authorize as each user.
select results_eq(
  $$ select read_allowed, write_allowed from realtime.authorize('authenticated', current_setting('test.x_topic'),
       '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}', 'a2000000-0000-0000-0000-000000000002',
       '{}', array['broadcast'], array['broadcast']) $$,
  $$ values (array[true], array[false]) $$,
  'criterion 42: realtime.authorize lets P join bill:<X> for reading, not writing'
);
select results_eq(
  $$ select read_allowed, write_allowed from realtime.authorize('authenticated', current_setting('test.x_topic'),
       '{"sub":"a3000000-0000-0000-0000-000000000003","role":"authenticated"}', 'a3000000-0000-0000-0000-000000000003',
       '{}', array['broadcast'], array['broadcast']) $$,
  $$ values (array[false], array[false]) $$,
  'criterion 42: realtime.authorize refuses O on bill:<X>'
);
select results_eq(
  $$ select read_allowed from realtime.authorize('anon', current_setting('test.x_topic'),
       '{"role":"anon"}', '', '{}', array['broadcast'], array[]::text[]) $$,
  $$ values (array[false]) $$,
  'realtime.authorize refuses anon on bill:<X>'
);
reset role;

-- ---------------------------------------------------------------------------
-- Criterion 43: which triggers exist
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select tgrelid::regclass::text,
            case when tgtype & 4 <> 0 then 'insert' when tgtype & 8 <> 0 then 'delete' when tgtype & 16 <> 0 then 'update' end
       from pg_trigger
       where tgfoid = 'private.broadcast_bill_change()'::regprocedure and not tgisinternal
       order by 1, 2 $$,
  -- bill_participants update added by 20261124081411_settle_payer.sql (M3 Task 1, marks);
  -- bill_participants delete added by 20261124091042_membership.sql (remove / leave).
  $$ values ('bill_participants'::text, 'delete'::text), ('bill_participants', 'insert'), ('bill_participants', 'update'), ('bills', 'update'), ('claims', 'delete'), ('claims', 'insert'), ('claims', 'update') $$,
  'criterion 43: broadcast triggers on claims (insert, update, delete), bill_participants (insert, update, delete), bills (update)'
);
select ok(
  (select bool_and(tgtype & 1 = 0 and tgtype & 2 = 0) from pg_trigger
     where tgfoid = 'private.broadcast_bill_change()'::regprocedure and not tgisinternal),
  'criterion 43: the broadcast triggers are AFTER, statement-level'
);
select is(
  (select count(*)::integer from pg_trigger where tgrelid = 'public.line_items'::regclass and not tgisinternal),
  0, 'criterion 43: there is no trigger on line_items'
);

select * from finish();
rollback;
