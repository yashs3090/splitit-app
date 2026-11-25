-- pgTAP tests for claimable discounts, Task 1 (spec docs/specs/2026-11-24-claimable-discounts.md,
-- contracts C1-C3, criteria 1-12; criterion 8 is the rest of the suite passing unchanged).
-- Task 2 (update_bill, criteria 13-17) is the last section.
--
-- Every assertion filters to the fixture users and bills below (the local DB may hold real data).
--
-- Users: A cd1... 'Ana', B cd2... 'Ben' (host and payer of every fixture bill), C cd3... 'Cy'
--        (outsider), D cd4... 'Dot', E cd5... (creates only rejected bills), F cd6... (creates
--        only accepted C2 boundary bills).
-- Base bill (C2 "B1"): Steak 1603, Salad 1400 (I = 3003), claimable comp "Police comp" -1603
--        applies_to subtotal, subtotal 1400, tax 240, tip 0, fees 0, total 1640.
-- Bill M: the B1 bill. A joins. A claims Steak, B claims Salad (then the comp, criteria 9-11).
-- Bill P: the B1 bill. D joins and claims only the comp (criterion 12).
-- Bill X: the B1 bill, target of direct inserts as postgres (criteria 1-2).
-- Task 2 bills (host B; A joins U1, U2, U4):
-- Bill U1: B1; A claims the comp; edits change its amount, then only its applies_to (c13).
-- Bill U2: B1; A claims the comp; the edit switches it to Split (c14).
-- Bill U3: B1 with the comp as a split discount; edits add it as a row, then add an item (c15).
-- Bill U4: B1; A claims Steak and the comp; rejected edits change nothing (c16, c17).

begin;

create extension if not exists pgtap with schema extensions;

select plan(96);

insert into auth.users (id, email, raw_user_meta_data) values
  ('cd100000-0000-0000-0000-000000000001', 'claimdisc-a@test.local', '{"full_name":"Ana"}'::jsonb),
  ('cd200000-0000-0000-0000-000000000002', 'claimdisc-b@test.local', '{"full_name":"Ben"}'::jsonb),
  ('cd300000-0000-0000-0000-000000000003', 'claimdisc-c@test.local', '{"full_name":"Cy"}'::jsonb),
  ('cd400000-0000-0000-0000-000000000004', 'claimdisc-d@test.local', '{"full_name":"Dot"}'::jsonb),
  ('cd500000-0000-0000-0000-000000000005', 'claimdisc-e@test.local', '{"full_name":"Eve"}'::jsonb),
  ('cd600000-0000-0000-0000-000000000006', 'claimdisc-f@test.local', '{"full_name":"Fay"}'::jsonb);

-- The two item rows of the base bill, and the comp row. Statements below append rows with ||.
select set_config('test.items', $json$[
  {"name":"Steak","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":1603},
  {"name":"Salad","note":null,"group_position":1,"unit_index":0,"group_size":1,"total_cents":1400}
]$json$, true);
select set_config('test.comp', $json$[
  {"name":"Police comp","group_position":2,"unit_index":0,"group_size":1,"total_cents":-1603,
   "kind":"discount","applies_to":"subtotal"}
]$json$, true);

-- ---------------------------------------------------------------------------
-- Fixtures through the real functions
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"cd200000-0000-0000-0000-000000000002","role":"authenticated"}';
do $$
declare r record;
begin
  select * into r from public.create_bill(
    current_setting('test.items')::jsonb || current_setting('test.comp')::jsonb,
    1400, 240, 0, 0, 0, 0, 1640);
  perform set_config('test.m_id', r.bill_id::text, true);
  perform set_config('test.m_code', r.join_code, true);

  select * into r from public.create_bill(
    current_setting('test.items')::jsonb || current_setting('test.comp')::jsonb,
    1400, 240, 0, 0, 0, 0, 1640);
  perform set_config('test.p_id', r.bill_id::text, true);
  perform set_config('test.p_code', r.join_code, true);

  select * into r from public.create_bill(
    current_setting('test.items')::jsonb || current_setting('test.comp')::jsonb,
    1400, 240, 0, 0, 0, 0, 1640);
  perform set_config('test.x_id', r.bill_id::text, true);
end $$;

set local request.jwt.claims = '{"sub":"cd100000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.join_bill(current_setting('test.m_code'));
set local request.jwt.claims = '{"sub":"cd400000-0000-0000-0000-000000000004","role":"authenticated"}';
select public.join_bill(current_setting('test.p_code'));
reset role;

do $$
begin
  perform set_config('test.m_steak', (select li.id::text from public.line_items as li
    where li.bill_id = current_setting('test.m_id')::uuid and li.name = 'Steak'), true);
  perform set_config('test.m_salad', (select li.id::text from public.line_items as li
    where li.bill_id = current_setting('test.m_id')::uuid and li.name = 'Salad'), true);
  perform set_config('test.m_comp', (select li.id::text from public.line_items as li
    where li.bill_id = current_setting('test.m_id')::uuid and li.name = 'Police comp'), true);
  perform set_config('test.p_comp', (select li.id::text from public.line_items as li
    where li.bill_id = current_setting('test.p_id')::uuid and li.name = 'Police comp'), true);
end $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"cd100000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.set_claim(current_setting('test.m_steak')::uuid, true);
set local request.jwt.claims = '{"sub":"cd200000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.set_claim(current_setting('test.m_salad')::uuid, true);
set local request.jwt.claims = '{"sub":"cd400000-0000-0000-0000-000000000004","role":"authenticated"}';
select public.set_claim(current_setting('test.p_comp')::uuid, true);
reset role;

-- ---------------------------------------------------------------------------
-- Criterion 1: columns, default, backfill
-- ---------------------------------------------------------------------------
select has_column('public', 'line_items', 'kind', 'c1: line_items.kind exists');
select col_type_is('public', 'line_items', 'kind', 'text', 'c1: kind is text');
select col_not_null('public', 'line_items', 'kind', 'c1: kind is not null');
select col_default_is('public', 'line_items', 'kind', 'item', 'c1: kind defaults to ''item''');
select has_column('public', 'line_items', 'applies_to', 'c1: line_items.applies_to exists');
select col_type_is('public', 'line_items', 'applies_to', 'text', 'c1: applies_to is text');
select col_is_null('public', 'line_items', 'applies_to', 'c1: applies_to is nullable');

select results_eq(
  format($$ select li.name, li.kind, li.applies_to from public.line_items as li
            where li.bill_id = %L::uuid and li.name in ('Steak', 'Salad') order by li.group_position $$,
    current_setting('test.m_id')),
  $$ values ('Steak'::text, 'item'::text, null::text), ('Salad', 'item', null) $$,
  'c1: item rows from create_bill (sent without kind) are kind item, applies_to null');

-- A row inserted without the new columns (as every pre-existing row was) gets the defaults.
insert into public.line_items (bill_id, group_position, unit_index, group_size, name, total_cents)
values (current_setting('test.x_id')::uuid, 50, 0, 1, 'Raw row', 100);
select results_eq(
  format($$ select li.kind, li.applies_to from public.line_items as li
            where li.bill_id = %L::uuid and li.name = 'Raw row' $$, current_setting('test.x_id')),
  $$ values ('item'::text, null::text) $$,
  'c1: a row inserted without kind / applies_to is kind item, applies_to null');

-- ---------------------------------------------------------------------------
-- Criterion 2: line_items_kind_shape as postgres
-- ---------------------------------------------------------------------------
select throws_ok(format($$ insert into public.line_items
    (bill_id, group_position, unit_index, group_size, name, note, total_cents, kind, applies_to)
    values (%L, 60, 0, 1, 'Bad', null, -1, 'item', null) $$, current_setting('test.x_id')),
  '23514', null, 'c2: an item with total_cents -1 fails the check');
select throws_ok(format($$ insert into public.line_items
    (bill_id, group_position, unit_index, group_size, name, note, total_cents, kind, applies_to)
    values (%L, 61, 0, 1, 'Bad', null, 100, 'item', 'subtotal') $$, current_setting('test.x_id')),
  '23514', null, 'c2: an item with applies_to subtotal fails the check');
select throws_ok(format($$ insert into public.line_items
    (bill_id, group_position, unit_index, group_size, name, note, total_cents, kind, applies_to)
    values (%L, 62, 0, 1, 'Bad', null, 0, 'discount', 'subtotal') $$, current_setting('test.x_id')),
  '23514', null, 'c2: a discount with total_cents 0 fails the check');
select throws_ok(format($$ insert into public.line_items
    (bill_id, group_position, unit_index, group_size, name, note, total_cents, kind, applies_to)
    values (%L, 63, 0, 1, 'Bad', null, 100, 'discount', 'subtotal') $$, current_setting('test.x_id')),
  '23514', null, 'c2: a discount with total_cents 100 fails the check');
select throws_ok(format($$ insert into public.line_items
    (bill_id, group_position, unit_index, group_size, name, note, total_cents, kind, applies_to)
    values (%L, 64, 0, 1, 'Bad', null, -10000000, 'discount', 'subtotal') $$, current_setting('test.x_id')),
  '23514', null, 'c2: a discount with total_cents -10000000 fails the check');
select throws_ok(format($$ insert into public.line_items
    (bill_id, group_position, unit_index, group_size, name, note, total_cents, kind, applies_to)
    values (%L, 65, 0, 1, 'Bad', null, -100, 'discount', null) $$, current_setting('test.x_id')),
  '23514', null, 'c2: a discount with applies_to null fails the check');
select throws_ok(format($$ insert into public.line_items
    (bill_id, group_position, unit_index, group_size, name, note, total_cents, kind, applies_to)
    values (%L, 66, 0, 2, 'Bad', null, -100, 'discount', 'total') $$, current_setting('test.x_id')),
  '23514', null, 'c2: a discount with group_size 2 fails the check');
select throws_ok(format($$ insert into public.line_items
    (bill_id, group_position, unit_index, group_size, name, note, total_cents, kind, applies_to)
    values (%L, 67, 0, 1, 'Bad', 'x', -100, 'discount', 'total') $$, current_setting('test.x_id')),
  '23514', null, 'c2: a discount with a note fails the check');
select throws_ok(format($$ insert into public.line_items
    (bill_id, group_position, unit_index, group_size, name, note, total_cents, kind, applies_to)
    values (%L, 68, 0, 1, 'Bad', null, 100, 'coupon', null) $$, current_setting('test.x_id')),
  '23514', null, 'c2: kind coupon fails the check');
select lives_ok(format($$ insert into public.line_items
    (bill_id, group_position, unit_index, group_size, name, note, total_cents, kind, applies_to)
    values (%L, 69, 0, 1, 'Max item', null, 9999999, 'item', null) $$, current_setting('test.x_id')),
  'c2: an item with total_cents 9999999 inserts');
select lives_ok(format($$ insert into public.line_items
    (bill_id, group_position, unit_index, group_size, name, note, total_cents, kind, applies_to)
    values (%L, 70, 0, 1, 'Max discount', null, -9999999, 'discount', 'total') $$, current_setting('test.x_id')),
  'c2: a discount with total_cents -9999999 (applies_to total) inserts');

-- ---------------------------------------------------------------------------
-- Criterion 3: grants and RLS (unchanged) cover the new columns
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"cd100000-0000-0000-0000-000000000001","role":"authenticated"}';
select is(
  (select count(*)::integer from (
     select li.id, li.kind, li.applies_to from public.line_items as li
     where li.bill_id = current_setting('test.m_id')::uuid) as s),
  3, 'c3: a participant reads id, kind, applies_to for all 3 rows of their bill');
select throws_ok(format($$ insert into public.line_items
    (bill_id, group_position, unit_index, group_size, name, total_cents, kind, applies_to)
    values (%L, 9, 0, 1, 'Sneaky', -100, 'discount', 'subtotal') $$, current_setting('test.m_id')),
  '42501', null, 'c3: a direct insert as authenticated fails with 42501');
select throws_ok(format($$ update public.line_items set kind = 'discount' where id = %L $$,
    current_setting('test.m_steak')),
  '42501', null, 'c3: a direct update of kind as authenticated fails with 42501');
select throws_ok(format($$ delete from public.line_items where id = %L $$,
    current_setting('test.m_comp')),
  '42501', null, 'c3: a direct delete as authenticated fails with 42501');
set local request.jwt.claims = '{"sub":"cd300000-0000-0000-0000-000000000003","role":"authenticated"}';
select is(
  (select count(*)::integer from (
     select li.id, li.kind, li.applies_to from public.line_items as li
     where li.bill_id = current_setting('test.m_id')::uuid) as s),
  0, 'c3: a non-participant reads 0 rows');
set local role anon;
select throws_ok(
  format($$ select li.id, li.kind from public.line_items as li where li.bill_id = %L $$,
    current_setting('test.m_id')),
  '42501', null, 'c3: anon selecting line_items fails with 42501');
reset role;

-- ---------------------------------------------------------------------------
-- Criterion 4: create_bill stores the B1 discount row
-- ---------------------------------------------------------------------------
select results_eq(
  format($$ select li.name, li.kind, li.applies_to, li.total_cents, li.group_position,
                   li.unit_index, li.group_size, li.note
            from public.line_items as li
            where li.bill_id = %L::uuid and li.kind = 'discount' $$, current_setting('test.m_id')),
  $$ values ('Police comp'::text, 'discount'::text, 'subtotal'::text, -1603, 2, 0, 1, null::text) $$,
  'c4: the comp is stored as kind discount, applies_to subtotal, total_cents -1603');
select results_eq(
  format($$ select b.subtotal_discount_cents, b.total_discount_cents from public.bills as b
            where b.id = %L::uuid $$, current_setting('test.m_id')),
  $$ values (0, 0) $$,
  'c4: the bill''s stored discount sums stay 0 (the comp lives in the row)');

-- ---------------------------------------------------------------------------
-- Criterion 5: invalid rows raise 22023 invalid_bill (as E, who ends with no bills)
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"cd500000-0000-0000-0000-000000000005","role":"authenticated"}';
select throws_ok($$ select * from public.create_bill(current_setting('test.items')::jsonb || '[
    {"name":"Police comp","group_position":2,"unit_index":0,"group_size":1,"total_cents":-1603,
     "kind":"coupon","applies_to":"subtotal"}]'::jsonb, 1400, 240, 0, 0, 0, 0, 1640) $$,
  '22023', 'invalid_bill', 'c5: kind "coupon" is rejected');
select throws_ok($$ select * from public.create_bill(current_setting('test.items')::jsonb || '[
    {"name":"Police comp","group_position":2,"unit_index":0,"group_size":1,"total_cents":-1603,
     "kind":1,"applies_to":"subtotal"}]'::jsonb, 1400, 240, 0, 0, 0, 0, 1640) $$,
  '22023', 'invalid_bill', 'c5: kind 1 (a number) is rejected');
select throws_ok($$ select * from public.create_bill(current_setting('test.items')::jsonb || '[
    {"name":"Police comp","group_position":2,"unit_index":0,"group_size":1,"total_cents":-1603,
     "kind":"discount"}]'::jsonb, 1400, 240, 0, 0, 0, 0, 1640) $$,
  '22023', 'invalid_bill', 'c5: a discount without applies_to is rejected');
select throws_ok($$ select * from public.create_bill(current_setting('test.items')::jsonb || '[
    {"name":"Police comp","group_position":2,"unit_index":0,"group_size":1,"total_cents":-1603,
     "kind":"discount","applies_to":"tip"}]'::jsonb, 1400, 240, 0, 0, 0, 0, 1640) $$,
  '22023', 'invalid_bill', 'c5: applies_to "tip" is rejected');
select throws_ok($$ select * from public.create_bill('[
    {"name":"Steak","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":1603,
     "applies_to":"subtotal"},
    {"name":"Salad","note":null,"group_position":1,"unit_index":0,"group_size":1,"total_cents":1400}
  ]'::jsonb || current_setting('test.comp')::jsonb, 1400, 240, 0, 0, 0, 0, 1640) $$,
  '22023', 'invalid_bill', 'c5: an item with applies_to "subtotal" is rejected');
select throws_ok($$ select * from public.create_bill(current_setting('test.items')::jsonb || '[
    {"name":"Police comp","group_position":2,"unit_index":0,"group_size":1,"total_cents":0,
     "kind":"discount","applies_to":"subtotal"}]'::jsonb, 3003, 240, 0, 0, 0, 0, 3243) $$,
  '22023', 'invalid_bill', 'c5: a discount with total_cents 0 is rejected');
select throws_ok($$ select * from public.create_bill(current_setting('test.items')::jsonb || '[
    {"name":"Police comp","group_position":2,"unit_index":0,"group_size":1,"total_cents":5,
     "kind":"discount","applies_to":"subtotal"}]'::jsonb, 3008, 240, 0, 0, 0, 0, 3248) $$,
  '22023', 'invalid_bill', 'c5: a discount with total_cents 5 is rejected');
select throws_ok($$ select * from public.create_bill(current_setting('test.items')::jsonb || '[
    {"name":"Police comp","group_position":2,"unit_index":0,"group_size":1,"total_cents":-10000000,
     "kind":"discount","applies_to":"subtotal"}]'::jsonb, null, 240, 0, 0, 0, 0, 0) $$,
  '22023', 'invalid_bill', 'c5: a discount with total_cents -10000000 is rejected');
select throws_ok($$ select * from public.create_bill(current_setting('test.items')::jsonb || '[
    {"name":"Police comp","group_position":2,"unit_index":0,"group_size":1,"total_cents":"-1603",
     "kind":"discount","applies_to":"subtotal"}]'::jsonb, 1400, 240, 0, 0, 0, 0, 1640) $$,
  '22023', 'invalid_bill', 'c5: a discount with total_cents "-1603" (a string) is rejected');
select throws_ok($$ select * from public.create_bill(current_setting('test.items')::jsonb || '[
    {"name":"Police comp","group_position":2,"unit_index":0,"group_size":2,"total_cents":-1603,
     "kind":"discount","applies_to":"subtotal"}]'::jsonb, 1400, 240, 0, 0, 0, 0, 1640) $$,
  '22023', 'invalid_bill', 'c5: a discount with group_size 2 is rejected');
select throws_ok($$ select * from public.create_bill(current_setting('test.items')::jsonb || '[
    {"name":"Police comp","note":"x","group_position":2,"unit_index":0,"group_size":1,
     "total_cents":-1603,"kind":"discount","applies_to":"subtotal"}]'::jsonb,
    1400, 240, 0, 0, 0, 0, 1640) $$,
  '22023', 'invalid_bill', 'c5: a discount with the note "x" is rejected');
-- Totals that would otherwise add up (0 - 1 + 1 = 0), so only the "at least one item" rule fails.
select throws_ok($$ select * from public.create_bill('[
    {"name":"Coupon","group_position":0,"unit_index":0,"group_size":1,"total_cents":-1,
     "kind":"discount","applies_to":"subtotal"}]'::jsonb, null, 1, 0, 0, 0, 0, 0) $$,
  '22023', 'invalid_bill', 'c5: rows that are only discounts are rejected');
select throws_ok($$ select * from public.create_bill('[
    {"name":"Steak","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":1603,
     "host_id":"cd500000-0000-0000-0000-000000000005"},
    {"name":"Salad","note":null,"group_position":1,"unit_index":0,"group_size":1,"total_cents":1400}
  ]'::jsonb || current_setting('test.comp')::jsonb, 1400, 240, 0, 0, 0, 0, 1640) $$,
  '22023', 'invalid_bill', 'c5: an unknown key (host_id) is rejected');
-- A discount sharing a group position with an item (a mixed group).
select throws_ok($$ select * from public.create_bill(current_setting('test.items')::jsonb || '[
    {"name":"Salad","group_position":1,"unit_index":0,"group_size":1,"total_cents":-1603,
     "kind":"discount","applies_to":"subtotal"}]'::jsonb, 1400, 240, 0, 0, 0, 0, 1640) $$,
  '22023', 'invalid_bill', 'c5: a discount in the same group position as an item is rejected');
-- Item rows with an explicit "kind":"item" and "applies_to":null are fine; checked in c6 below.
select throws_ok($$ select * from public.create_bill(current_setting('test.items')::jsonb || '[
    {"name":"Police comp","group_position":2,"unit_index":0,"group_size":1,"total_cents":-1603,
     "kind":null,"applies_to":"subtotal"}]'::jsonb, 1400, 240, 0, 0, 0, 0, 1640) $$,
  '22023', 'invalid_bill', 'c5: kind null is rejected (present but not "item"/"discount")');
reset role;

-- ---------------------------------------------------------------------------
-- Criterion 6: C2 boundaries B1-B7 (claimable, as F) and B6 (same bills, split discount)
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"cd600000-0000-0000-0000-000000000006","role":"authenticated"}';
-- Claimable: the comp is a row.
select lives_ok($$ select * from public.create_bill(current_setting('test.items')::jsonb || '[
    {"name":"Police comp","group_position":2,"unit_index":0,"group_size":1,"total_cents":-1603,
     "kind":"discount","applies_to":"subtotal"}]'::jsonb, 1400, 240, 0, 0, 0, 0, 1640) $$,
  'c6 B1: comp 1603 (subtotal), gaps 0 / 0: accepted');
select lives_ok($$ select * from public.create_bill('[
    {"name":"Steak","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":1603,
     "kind":"item","applies_to":null},
    {"name":"Salad","note":null,"group_position":1,"unit_index":0,"group_size":1,"total_cents":1400}
  ]'::jsonb || '[
    {"name":"Police comp","group_position":2,"unit_index":0,"group_size":1,"total_cents":-1602,
     "kind":"discount","applies_to":"subtotal"}]'::jsonb, 1400, 240, 0, 0, 0, 0, 1640) $$,
  'c6 B2: comp 1602, gaps 1 / 0: accepted (an item row with explicit kind item / applies_to null is fine)');
select throws_ok($$ select * from public.create_bill(current_setting('test.items')::jsonb || '[
    {"name":"Police comp","group_position":2,"unit_index":0,"group_size":1,"total_cents":-1601,
     "kind":"discount","applies_to":"subtotal"}]'::jsonb, 1400, 240, 0, 0, 0, 0, 1640) $$,
  '22023', 'invalid_bill', 'c6 B3: comp 1601, gaps 2 / 0: rejected');
select lives_ok($$ select * from public.create_bill(current_setting('test.items')::jsonb || '[
    {"name":"Police comp","group_position":2,"unit_index":0,"group_size":1,"total_cents":-1602,
     "kind":"discount","applies_to":"subtotal"}]'::jsonb, 1400, 240, 0, 0, 0, 0, 1639) $$,
  'c6 B4: comp 1602, total 16.39, gaps 1 / 1: accepted');
select lives_ok($$ select * from public.create_bill(current_setting('test.items')::jsonb || '[
    {"name":"Police comp","group_position":2,"unit_index":0,"group_size":1,"total_cents":-1602,
     "kind":"discount","applies_to":"subtotal"}]'::jsonb, null, 240, 0, 0, 0, 0, 1640) $$,
  'c6 B5: no subtotal, comp 1602, combined gap 1: accepted');
select throws_ok($$ select * from public.create_bill(current_setting('test.items')::jsonb || '[
    {"name":"Police comp","group_position":2,"unit_index":0,"group_size":1,"total_cents":-1601,
     "kind":"discount","applies_to":"subtotal"}]'::jsonb, null, 240, 0, 0, 0, 0, 1640) $$,
  '22023', 'invalid_bill', 'c6 B5b: no subtotal, comp 1601, combined gap 2: rejected');
select throws_ok($$ select * from public.create_bill(current_setting('test.items')::jsonb || '[
    {"name":"Police comp","group_position":2,"unit_index":0,"group_size":1,"total_cents":-1603,
     "kind":"discount","applies_to":"total"}]'::jsonb, 1400, 240, 0, 0, 0, 0, 1640) $$,
  '22023', 'invalid_bill', 'c6 B7: comp 1603 applied to the total: rejected');
-- B6: the same seven bills with the comp as a split discount (no row).
select lives_ok($$ select * from public.create_bill(current_setting('test.items')::jsonb,
    1400, 240, 0, 0, 1603, 0, 1640) $$,
  'c6 B6/B1: split comp 1603 (subtotal): accepted');
select lives_ok($$ select * from public.create_bill(current_setting('test.items')::jsonb,
    1400, 240, 0, 0, 1602, 0, 1640) $$,
  'c6 B6/B2: split comp 1602: accepted');
select throws_ok($$ select * from public.create_bill(current_setting('test.items')::jsonb,
    1400, 240, 0, 0, 1601, 0, 1640) $$,
  '22023', 'invalid_bill', 'c6 B6/B3: split comp 1601: rejected');
select lives_ok($$ select * from public.create_bill(current_setting('test.items')::jsonb,
    1400, 240, 0, 0, 1602, 0, 1639) $$,
  'c6 B6/B4: split comp 1602, total 16.39: accepted');
select lives_ok($$ select * from public.create_bill(current_setting('test.items')::jsonb,
    null, 240, 0, 0, 1602, 0, 1640) $$,
  'c6 B6/B5: no subtotal, split comp 1602: accepted');
select throws_ok($$ select * from public.create_bill(current_setting('test.items')::jsonb,
    null, 240, 0, 0, 1601, 0, 1640) $$,
  '22023', 'invalid_bill', 'c6 B6/B5b: no subtotal, split comp 1601: rejected');
select throws_ok($$ select * from public.create_bill(current_setting('test.items')::jsonb,
    1400, 240, 0, 0, 0, 1603, 1640) $$,
  '22023', 'invalid_bill', 'c6 B6/B7: split comp 1603 applied to the total: rejected');
reset role;

-- No rejected create_bill left a bill behind (criteria 5 and 6).
select is(
  (select count(*)::integer from public.bills as b
   where b.host_id = 'cd500000-0000-0000-0000-000000000005'),
  0, 'c5: no bill row exists for any rejected create_bill (user E)');

-- ---------------------------------------------------------------------------
-- Criterion 7: bill_created counts item groups only
-- ---------------------------------------------------------------------------
select results_eq(
  format($$ select e.details from public.bill_events as e
            where e.bill_id = %L::uuid and e.kind = 'bill_created' $$, current_setting('test.m_id')),
  $$ values ('{"items": 2, "total_cents": 1640}'::jsonb) $$,
  'c7: bill_created.details is {items: 2, total_cents: 1640} for the B1 bill');

-- ---------------------------------------------------------------------------
-- Criterion 11 (K-D1): items claimed, discount unclaimed
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"cd100000-0000-0000-0000-000000000001","role":"authenticated"}';
-- Since 20261125090050_settle_early.sql (rule E), A (who claimed Steak) may mark paid early on a
-- proportional bill, so this checks C1 and rule E directly instead of calling mark_paid.
reset role;
select ok(
  not private.bill_is_complete(current_setting('test.m_id')::uuid)
  and private.settle_state(current_setting('test.m_id')::uuid,
                           'cd100000-0000-0000-0000-000000000001') = 'early',
  'c11 K-D1: every item claimed, the discount unclaimed: not complete (C1); rule E says early for A');
set local role authenticated;

-- ---------------------------------------------------------------------------
-- Criterion 9: set_claim on a discount row
-- ---------------------------------------------------------------------------
select lives_ok(
  format($$ select public.set_claim(%L::uuid, true) $$, current_setting('test.m_comp')),
  'c9: a participant claims the discount row');
reset role;
select results_eq(
  format($$ select c.parts from public.claims as c
            where c.line_item_id = %L::uuid and c.user_id = 'cd100000-0000-0000-0000-000000000001' $$,
    current_setting('test.m_comp')),
  $$ values (1) $$,
  'c9: the claim on the discount row has parts = 1');
select is(
  (select count(*)::integer from public.bill_events as e
   where e.bill_id = current_setting('test.m_id')::uuid and e.kind = 'claimed'
     and e.actor_id = 'cd100000-0000-0000-0000-000000000001' and e.item_name = 'Police comp'),
  1, 'c9: exactly one claimed event with item_name Police comp');
set local role authenticated;
set local request.jwt.claims = '{"sub":"cd300000-0000-0000-0000-000000000003","role":"authenticated"}';
select throws_ok(
  format($$ select public.set_claim(%L::uuid, true) $$, current_setting('test.m_comp')),
  'P0002', 'not_found', 'c9: a non-participant claiming the discount row gets not_found');

-- ---------------------------------------------------------------------------
-- Criterion 10: set_item_split on a discount row
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"cd200000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.set_claim(current_setting('test.m_comp')::uuid, true);
set local request.jwt.claims = '{"sub":"cd100000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok(
  format($$ select public.set_item_split(%L::uuid,
    '{"cd100000-0000-0000-0000-000000000001": 2, "cd200000-0000-0000-0000-000000000002": 1}'::jsonb) $$,
    current_setting('test.m_comp')),
  'c10: a claimer sets parts {A: 2, B: 1} on the discount row');
select throws_ok(
  format($$ select public.set_item_split(%L::uuid,
    '{"cd100000-0000-0000-0000-000000000001": 2}'::jsonb) $$, current_setting('test.m_comp')),
  '22023', 'claimers_changed', 'c10: leaving out a current claimer raises claimers_changed');
reset role;
select results_eq(
  format($$ select c.user_id::text, c.parts from public.claims as c
            where c.line_item_id = %L::uuid order by c.user_id $$, current_setting('test.m_comp')),
  $$ values ('cd100000-0000-0000-0000-000000000001'::text, 2),
            ('cd200000-0000-0000-0000-000000000002'::text, 1) $$,
  'c10: the discount row''s parts are A 2, B 1');
select is(
  (select count(*)::integer from public.bill_events as e
   where e.bill_id = current_setting('test.m_id')::uuid and e.kind = 'split_changed'
     and e.item_name = 'Police comp'),
  1, 'c10: exactly one split_changed event for the discount row');

-- ---------------------------------------------------------------------------
-- Criterion 11 (K-D3, K-D2)
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"cd200000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.set_claim(current_setting('test.m_salad')::uuid, false);
set local request.jwt.claims = '{"sub":"cd100000-0000-0000-0000-000000000001","role":"authenticated"}';
reset role;
select ok(
  not private.bill_is_complete(current_setting('test.m_id')::uuid)
  and private.settle_state(current_setting('test.m_id')::uuid,
                           'cd100000-0000-0000-0000-000000000001') = 'early',
  'c11 K-D3: discount claimed, one item unclaimed: not complete (C1); rule E says early for A');
set local role authenticated;
set local request.jwt.claims = '{"sub":"cd200000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.set_claim(current_setting('test.m_salad')::uuid, true);
set local request.jwt.claims = '{"sub":"cd100000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok(
  format($$ select public.mark_paid(%L::uuid, 'cd200000-0000-0000-0000-000000000002'::uuid, 128) $$,
    current_setting('test.m_id')),
  'c11 K-D2: every row (items and the discount) claimed: mark_paid succeeds');
reset role;
select is(
  (select count(*)::integer from public.bill_events as e
   where e.bill_id = current_setting('test.m_id')::uuid and e.kind = 'marked_paid'
     and e.actor_id = 'cd100000-0000-0000-0000-000000000001'),
  1, 'c11 K-D2: exactly one marked_paid event');

-- ---------------------------------------------------------------------------
-- Criterion 12: a claim on a discount row only still blocks removal and leaving
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"cd200000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok(
  format($$ select public.remove_participant(%L::uuid, 'cd400000-0000-0000-0000-000000000004'::uuid) $$,
    current_setting('test.p_id')),
  '22023', 'cannot_remove', 'c12: the host can''t remove someone whose only claim is a discount row');
set local request.jwt.claims = '{"sub":"cd400000-0000-0000-0000-000000000004","role":"authenticated"}';
select throws_ok(
  format($$ select public.leave_bill(%L::uuid) $$, current_setting('test.p_id')),
  '22023', 'cannot_leave', 'c12: someone whose only claim is a discount row can''t leave');
reset role;

-- ===========================================================================
-- Task 2: update_bill (criteria 13-17)
-- ===========================================================================
set local role authenticated;
set local request.jwt.claims = '{"sub":"cd200000-0000-0000-0000-000000000002","role":"authenticated"}';
do $$
declare r record;
begin
  select * into r from public.create_bill(
    current_setting('test.items')::jsonb || current_setting('test.comp')::jsonb,
    1400, 240, 0, 0, 0, 0, 1640);
  perform set_config('test.u1_id', r.bill_id::text, true);
  perform set_config('test.u1_code', r.join_code, true);

  select * into r from public.create_bill(
    current_setting('test.items')::jsonb || current_setting('test.comp')::jsonb,
    1400, 240, 0, 0, 0, 0, 1640);
  perform set_config('test.u2_id', r.bill_id::text, true);
  perform set_config('test.u2_code', r.join_code, true);

  select * into r from public.create_bill(
    current_setting('test.items')::jsonb, 1400, 240, 0, 0, 1603, 0, 1640);
  perform set_config('test.u3_id', r.bill_id::text, true);

  select * into r from public.create_bill(
    current_setting('test.items')::jsonb || current_setting('test.comp')::jsonb,
    1400, 240, 0, 0, 0, 0, 1640);
  perform set_config('test.u4_id', r.bill_id::text, true);
  perform set_config('test.u4_code', r.join_code, true);
end $$;

set local request.jwt.claims = '{"sub":"cd100000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.join_bill(current_setting('test.u1_code'));
select public.join_bill(current_setting('test.u2_code'));
select public.join_bill(current_setting('test.u4_code'));
reset role;

do $$
declare
  v_bill text;
  v_name text;
begin
  foreach v_bill in array array['u1', 'u2', 'u3', 'u4'] loop
    foreach v_name in array array['Steak', 'Salad', 'Police comp'] loop
      perform set_config('test.' || v_bill || '_' || split_part(lower(v_name), ' ', 1),
        coalesce((select li.id::text from public.line_items as li
                  where li.bill_id = current_setting('test.' || v_bill || '_id')::uuid
                    and li.name = v_name), ''), true);
    end loop;
  end loop;
end $$;
-- Settings now: test.u1_steak, test.u1_salad, test.u1_police (the comp row), and so on; U3 has
-- no comp row yet ('').

set local role authenticated;
set local request.jwt.claims = '{"sub":"cd100000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.set_claim(current_setting('test.u1_police')::uuid, true);
select public.set_claim(current_setting('test.u2_police')::uuid, true);
select public.set_claim(current_setting('test.u4_steak')::uuid, true);
select public.set_claim(current_setting('test.u4_police')::uuid, true);

-- ---------------------------------------------------------------------------
-- Criterion 13: change a claimed discount's amount, then only its applies_to
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"cd200000-0000-0000-0000-000000000002","role":"authenticated"}';
-- Comp -1000 (subtotal): I 3003 - 1000 = subtotal 2003; 2003 + 240 = total 2243.
select lives_ok($$ select public.update_bill(current_setting('test.u1_id')::uuid, jsonb_build_array(
    jsonb_build_object('id', current_setting('test.u1_steak'), 'name', 'Steak', 'note', null,
      'group_position', 0, 'unit_index', 0, 'group_size', 1, 'total_cents', 1603),
    jsonb_build_object('id', current_setting('test.u1_salad'), 'name', 'Salad', 'note', null,
      'group_position', 1, 'unit_index', 0, 'group_size', 1, 'total_cents', 1400),
    jsonb_build_object('id', current_setting('test.u1_police'), 'name', 'Police comp',
      'group_position', 2, 'unit_index', 0, 'group_size', 1, 'total_cents', -1000,
      'kind', 'discount', 'applies_to', 'subtotal')),
    2003, 240, 0, 0, 0, 0, 2243) $$,
  'c13: the host changes the claimed comp from -1603 to -1000 (same id)');
reset role;
select is(
  (select count(*)::integer from public.claims as c
   where c.line_item_id = current_setting('test.u1_police')::uuid
     and c.user_id = 'cd100000-0000-0000-0000-000000000001'),
  1, 'c13: A''s claim on the comp is kept');
select results_eq(
  $$ select e.item_name, e.details from public.bill_events as e
     where e.bill_id = current_setting('test.u1_id')::uuid and e.kind = 'item_changed' $$,
  $$ values ('Police comp'::text, '{"price_cents": [-1603, -1000], "discount": true}'::jsonb) $$,
  'c13: exactly one item_changed, {price_cents: [-1603, -1000], discount: true}');

set local role authenticated;
set local request.jwt.claims = '{"sub":"cd200000-0000-0000-0000-000000000002","role":"authenticated"}';
-- Same comp, now after the subtotal: subtotal 3003; 3003 + 240 - 1000 = total 2243.
select lives_ok($$ select public.update_bill(current_setting('test.u1_id')::uuid, jsonb_build_array(
    jsonb_build_object('id', current_setting('test.u1_steak'), 'name', 'Steak', 'note', null,
      'group_position', 0, 'unit_index', 0, 'group_size', 1, 'total_cents', 1603),
    jsonb_build_object('id', current_setting('test.u1_salad'), 'name', 'Salad', 'note', null,
      'group_position', 1, 'unit_index', 0, 'group_size', 1, 'total_cents', 1400),
    jsonb_build_object('id', current_setting('test.u1_police'), 'name', 'Police comp',
      'group_position', 2, 'unit_index', 0, 'group_size', 1, 'total_cents', -1000,
      'kind', 'discount', 'applies_to', 'total')),
    3003, 240, 0, 0, 0, 0, 2243) $$,
  'c13: the host moves the comp from subtotal to total (money arguments adjusted)');
reset role;
select is(
  (select li.applies_to from public.line_items as li
   where li.id = current_setting('test.u1_police')::uuid),
  'total', 'c13: the kept discount row''s applies_to is now total');
select is(
  (select count(*)::integer from public.bill_events as e
   where e.bill_id = current_setting('test.u1_id')::uuid and e.kind = 'item_changed'),
  1, 'c13: changing only applies_to logs no item_changed');

-- ---------------------------------------------------------------------------
-- Criterion 14: Claim -> Split (row dropped, amount into p_subtotal_discount_cents)
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"cd200000-0000-0000-0000-000000000002","role":"authenticated"}';
select lives_ok($$ select public.update_bill(current_setting('test.u2_id')::uuid, jsonb_build_array(
    jsonb_build_object('id', current_setting('test.u2_steak'), 'name', 'Steak', 'note', null,
      'group_position', 0, 'unit_index', 0, 'group_size', 1, 'total_cents', 1603),
    jsonb_build_object('id', current_setting('test.u2_salad'), 'name', 'Salad', 'note', null,
      'group_position', 1, 'unit_index', 0, 'group_size', 1, 'total_cents', 1400)),
    1400, 240, 0, 0, 1603, 0, 1640) $$,
  'c14: the host switches the claimed comp to Split');
reset role;
select is(
  (select count(*)::integer from public.line_items as li
   where li.id = current_setting('test.u2_police')::uuid),
  0, 'c14: the comp row is deleted');
select is(
  (select count(*)::integer from public.claims as c
   where c.bill_id = current_setting('test.u2_id')::uuid
     and c.line_item_id = current_setting('test.u2_police')::uuid),
  0, 'c14: its claims are gone (cascade)');
select results_eq(
  $$ select e.item_name, e.details from public.bill_events as e
     where e.bill_id = current_setting('test.u2_id')::uuid and e.kind = 'item_removed' $$,
  $$ values ('Police comp'::text,
             '{"qty": 1, "price_cents": -1603, "claimer_ids": ["cd100000-0000-0000-0000-000000000001"],
               "discount": true}'::jsonb) $$,
  'c14: exactly one item_removed {qty 1, price_cents -1603, claimer_ids [A], discount true}');
select results_eq(
  $$ select e.details from public.bill_events as e
     where e.bill_id = current_setting('test.u2_id')::uuid and e.kind = 'amounts_changed' $$,
  $$ values ('{"subtotal_discount_cents": [0, 1603]}'::jsonb) $$,
  'c14: exactly one amounts_changed {subtotal_discount_cents: [0, 1603]}');

-- ---------------------------------------------------------------------------
-- Criterion 15: Split -> Claim adds a discount row; adding an item has no discount key
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"cd200000-0000-0000-0000-000000000002","role":"authenticated"}';
select lives_ok($$ select public.update_bill(current_setting('test.u3_id')::uuid, jsonb_build_array(
    jsonb_build_object('id', current_setting('test.u3_steak'), 'name', 'Steak', 'note', null,
      'group_position', 0, 'unit_index', 0, 'group_size', 1, 'total_cents', 1603),
    jsonb_build_object('id', current_setting('test.u3_salad'), 'name', 'Salad', 'note', null,
      'group_position', 1, 'unit_index', 0, 'group_size', 1, 'total_cents', 1400),
    jsonb_build_object('name', 'Police comp', 'note', '  ',
      'group_position', 2, 'unit_index', 0, 'group_size', 1, 'total_cents', -1603,
      'kind', 'discount', 'applies_to', 'subtotal')),
    1400, 240, 0, 0, 0, 0, 1640) $$,
  'c15: the host turns the split comp into a claimable row (blank note sent)');
reset role;
select results_eq(
  $$ select li.kind, li.applies_to, li.total_cents, li.note from public.line_items as li
     where li.bill_id = current_setting('test.u3_id')::uuid and li.name = 'Police comp' $$,
  $$ values ('discount'::text, 'subtotal'::text, -1603, null::text) $$,
  'c15: the new row is stored as kind discount, applies_to subtotal, -1603, note null');
select set_config('test.u3_police', (select li.id::text from public.line_items as li
  where li.bill_id = current_setting('test.u3_id')::uuid and li.name = 'Police comp'), true);

set local role authenticated;
set local request.jwt.claims = '{"sub":"cd200000-0000-0000-0000-000000000002","role":"authenticated"}';
-- Add Wine 500: I 3503 - 1603 = subtotal 1900; 1900 + 240 = total 2140.
select lives_ok($$ select public.update_bill(current_setting('test.u3_id')::uuid, jsonb_build_array(
    jsonb_build_object('id', current_setting('test.u3_steak'), 'name', 'Steak', 'note', null,
      'group_position', 0, 'unit_index', 0, 'group_size', 1, 'total_cents', 1603),
    jsonb_build_object('id', current_setting('test.u3_salad'), 'name', 'Salad', 'note', null,
      'group_position', 1, 'unit_index', 0, 'group_size', 1, 'total_cents', 1400),
    jsonb_build_object('name', 'Wine', 'note', null,
      'group_position', 2, 'unit_index', 0, 'group_size', 1, 'total_cents', 500),
    jsonb_build_object('id', current_setting('test.u3_police'), 'name', 'Police comp',
      'group_position', 3, 'unit_index', 0, 'group_size', 1, 'total_cents', -1603,
      'kind', 'discount', 'applies_to', 'subtotal')),
    1900, 240, 0, 0, 0, 0, 2140) $$,
  'c15: the host adds an item row (the comp moves after it)');
reset role;
select results_eq(
  $$ select e.item_name, e.details from public.bill_events as e
     where e.bill_id = current_setting('test.u3_id')::uuid and e.kind = 'item_added'
     order by e.item_name $$,
  $$ values ('Police comp'::text, '{"qty": 1, "price_cents": -1603, "discount": true}'::jsonb),
            ('Wine'::text, '{"qty": 1, "price_cents": 500}'::jsonb) $$,
  'c15: exactly one item_added per added row: the discount with discount true, Wine without the key');

-- ---------------------------------------------------------------------------
-- Criterion 16: rejected edits change nothing
-- ---------------------------------------------------------------------------
select set_config('test.u4_rows', (
  select string_agg(concat_ws('|', li.id, li.kind, li.applies_to, li.total_cents, li.group_position,
                              li.name), ',' order by li.id)
  from public.line_items as li where li.bill_id = current_setting('test.u4_id')::uuid), true);
select set_config('test.u4_claims', (
  select string_agg(concat_ws('|', c.line_item_id, c.user_id, c.parts), ',' order by c.line_item_id, c.user_id)
  from public.claims as c where c.bill_id = current_setting('test.u4_id')::uuid), true);
select set_config('test.u4_bill', (
  select concat_ws('|', b.subtotal_cents, b.subtotal_discount_cents, b.total_discount_cents,
                   b.total_cents, b.edited_at)
  from public.bills as b where b.id = current_setting('test.u4_id')::uuid), true);
select set_config('test.u4_events', (
  select count(*)::text from public.bill_events as e
  where e.bill_id = current_setting('test.u4_id')::uuid), true);

set local role authenticated;
set local request.jwt.claims = '{"sub":"cd200000-0000-0000-0000-000000000002","role":"authenticated"}';
-- Otherwise valid (comp dropped; Steak as a -1 discount: I 1400 - 1 = subtotal 1399, total 1639).
select throws_ok($$ select public.update_bill(current_setting('test.u4_id')::uuid, jsonb_build_array(
    jsonb_build_object('id', current_setting('test.u4_steak'), 'name', 'Steak',
      'group_position', 0, 'unit_index', 0, 'group_size', 1, 'total_cents', -1,
      'kind', 'discount', 'applies_to', 'subtotal'),
    jsonb_build_object('id', current_setting('test.u4_salad'), 'name', 'Salad', 'note', null,
      'group_position', 1, 'unit_index', 0, 'group_size', 1, 'total_cents', 1400)),
    1399, 240, 0, 0, 0, 0, 1639) $$,
  '22023', 'invalid_bill', 'c16: a kept item id sent with kind discount is rejected');
-- Otherwise valid (the comp as a $0 item: subtotal 3003, total 3243).
select throws_ok($$ select public.update_bill(current_setting('test.u4_id')::uuid, jsonb_build_array(
    jsonb_build_object('id', current_setting('test.u4_steak'), 'name', 'Steak', 'note', null,
      'group_position', 0, 'unit_index', 0, 'group_size', 1, 'total_cents', 1603),
    jsonb_build_object('id', current_setting('test.u4_salad'), 'name', 'Salad', 'note', null,
      'group_position', 1, 'unit_index', 0, 'group_size', 1, 'total_cents', 1400),
    jsonb_build_object('id', current_setting('test.u4_police'), 'name', 'Police comp', 'note', null,
      'group_position', 2, 'unit_index', 0, 'group_size', 1, 'total_cents', 0)),
    3003, 240, 0, 0, 0, 0, 3243) $$,
  '22023', 'invalid_bill', 'c16: a kept discount id sent without kind is rejected');
select throws_ok($$ select public.update_bill(current_setting('test.u4_id')::uuid, jsonb_build_array(
    jsonb_build_object('id', current_setting('test.u4_steak'), 'name', 'Steak', 'note', null,
      'group_position', 0, 'unit_index', 0, 'group_size', 1, 'total_cents', 1603),
    jsonb_build_object('id', current_setting('test.u4_salad'), 'name', 'Salad', 'note', null,
      'group_position', 1, 'unit_index', 0, 'group_size', 1, 'total_cents', 1400),
    jsonb_build_object('id', current_setting('test.u4_police'), 'name', 'Police comp', 'note', 'x',
      'group_position', 2, 'unit_index', 0, 'group_size', 1, 'total_cents', -1603,
      'kind', 'discount', 'applies_to', 'subtotal')),
    1400, 240, 0, 0, 0, 0, 1640) $$,
  '22023', 'invalid_bill', 'c16: a discount row that breaks C1 (a note) is rejected');

-- ---------------------------------------------------------------------------
-- Criterion 17: a non-host can't edit
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"cd100000-0000-0000-0000-000000000001","role":"authenticated"}';
select throws_ok($$ select public.update_bill(current_setting('test.u4_id')::uuid, jsonb_build_array(
    jsonb_build_object('id', current_setting('test.u4_steak'), 'name', 'Steak', 'note', null,
      'group_position', 0, 'unit_index', 0, 'group_size', 1, 'total_cents', 1603),
    jsonb_build_object('id', current_setting('test.u4_salad'), 'name', 'Salad', 'note', null,
      'group_position', 1, 'unit_index', 0, 'group_size', 1, 'total_cents', 1400)),
    1400, 240, 0, 0, 1603, 0, 1640) $$,
  '42501', 'not_allowed', 'c17: a non-host''s update_bill raises 42501');
reset role;

select is(
  (select string_agg(concat_ws('|', li.id, li.kind, li.applies_to, li.total_cents, li.group_position,
                               li.name), ',' order by li.id)
   from public.line_items as li where li.bill_id = current_setting('test.u4_id')::uuid),
  current_setting('test.u4_rows'), 'c16/c17: U4''s rows are unchanged');
select is(
  (select string_agg(concat_ws('|', c.line_item_id, c.user_id, c.parts), ',' order by c.line_item_id, c.user_id)
   from public.claims as c where c.bill_id = current_setting('test.u4_id')::uuid),
  current_setting('test.u4_claims'), 'c16/c17: U4''s claims are unchanged');
select is(
  (select concat_ws('|', b.subtotal_cents, b.subtotal_discount_cents, b.total_discount_cents,
                    b.total_cents, b.edited_at)
   from public.bills as b where b.id = current_setting('test.u4_id')::uuid),
  current_setting('test.u4_bill'), 'c16/c17: U4''s bill row is unchanged');
select is(
  (select count(*)::text from public.bill_events as e
   where e.bill_id = current_setting('test.u4_id')::uuid),
  current_setting('test.u4_events'), 'c16/c17: U4''s event count is unchanged');

select * from finish();
rollback;
