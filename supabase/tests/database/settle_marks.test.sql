-- pgTAP tests for M3 Task 2 (spec docs/specs/2026-11-24-m3-settle-venmo.md, criteria 14-23):
-- private.bill_is_complete (C1, cases K1-K5), mark_paid (C2 cases A1-A6, the C3 check order)
-- and unmark_paid (Q4 callers), with their Activity events (Q9).
--
-- Every assertion filters to the fixture bills/users below (the local DB may hold real data).
--
-- Users: A f1... 'Hana' (host of every bill), B f2... 'Sam', D f4... 'Dee' (participants),
--        C f3... 'Cal' (outsider).
-- Bill W (D3 worked example, also K4): Burger 1500 (A), Salad 1000 (B), Fries 600 (A and B),
--        tax 500, total 3600. D is in W and claims nothing.
-- Bill K1: Tea 300 (A), Cake 400 (B). Every row claimed.
-- Bill K2: Beer x2 at 700. Unit 0 claimed by A, unit 1 unclaimed.
-- Bill K3: Burger 1000 (A), Water 0 (unclaimed).
-- Bill K5: Tea 300 (A); then A's update_bill adds Cookie 200 (unclaimed).
-- Bill K6: Bread 0 (A), Water 0 (B), tax 500, total 500, proportional: every row $0.00 and every
--          row claimed. lib/settle.ts blocks it (blocked_all_zero, Q10); the DB calls it complete,
--          and since 20261125090050_settle_early.sql mark_paid refuses it (all_zero; K6 closed).

begin;

create extension if not exists pgtap with schema extensions;

select plan(57);

-- Who paid 4a (20261127140001): the mark columns moved off bill_participants into
-- public.bill_payments / bill_payment_flags. This temp view gives each participant's old columns
-- (their pair toward the bill's current payer, contract P; the flag to that payer) so the
-- readbacks below keep their shape. Read as the owner only (it is not granted to client roles).
create temp view bp_marks as
select bp.bill_id, bp.user_id, bp.added, bp.joined_at,
       case when ps.net > 0 then ps.mark_at end as settled_at,
       case when ps.net > 0 then ps.net::integer end as settled_cents,
       case when ps.net > 0 then ps.method end as settled_method,
       f.cents as not_received_cents, f.method as not_received_method, f.to_user as not_received_by
from public.bill_participants as bp
join public.bills as b on b.id = bp.bill_id
cross join lateral private.pair_state(bp.bill_id, bp.user_id, b.payer_id) as ps
left join public.bill_payment_flags as f
  on f.bill_id = bp.bill_id and f.from_user = bp.user_id and f.to_user = b.payer_id;

insert into auth.users (id, email, raw_user_meta_data) values
  ('f1000000-0000-0000-0000-000000000001', 'marks-a@test.local', '{"full_name":"Hana"}'::jsonb),
  ('f2000000-0000-0000-0000-000000000002', 'marks-b@test.local', '{"full_name":"Sam"}'::jsonb),
  ('f3000000-0000-0000-0000-000000000003', 'marks-c@test.local', '{"full_name":"Cal"}'::jsonb),
  ('f4000000-0000-0000-0000-000000000004', 'marks-d@test.local', '{"full_name":"Dee"}'::jsonb);

-- ---------------------------------------------------------------------------
-- Fixtures through the real functions
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"f1000000-0000-0000-0000-000000000001","role":"authenticated"}';
do $$
declare r record;
begin
  select * into r from public.create_bill($json$[
    {"name":"Burger","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":1500},
    {"name":"Salad","note":null,"group_position":1,"unit_index":0,"group_size":1,"total_cents":1000},
    {"name":"Fries","note":null,"group_position":2,"unit_index":0,"group_size":1,"total_cents":600}
  ]$json$::jsonb, null, 500, 0, 0, 0, 0, 3600);
  perform set_config('test.w_id', r.bill_id::text, true);
  perform set_config('test.w_code', r.join_code, true);

  select * into r from public.create_bill($json$[
    {"name":"Tea","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":300},
    {"name":"Cake","note":null,"group_position":1,"unit_index":0,"group_size":1,"total_cents":400}
  ]$json$::jsonb, null, 0, 0, 0, 0, 0, 700);
  perform set_config('test.k1_id', r.bill_id::text, true);
  perform set_config('test.k1_code', r.join_code, true);

  select * into r from public.create_bill($json$[
    {"name":"Beer","note":null,"group_position":0,"unit_index":0,"group_size":2,"total_cents":700},
    {"name":"Beer","note":null,"group_position":0,"unit_index":1,"group_size":2,"total_cents":700}
  ]$json$::jsonb, null, 0, 0, 0, 0, 0, 1400);
  perform set_config('test.k2_id', r.bill_id::text, true);
  perform set_config('test.k2_code', r.join_code, true);

  select * into r from public.create_bill($json$[
    {"name":"Burger","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":1000},
    {"name":"Water","note":null,"group_position":1,"unit_index":0,"group_size":1,"total_cents":0}
  ]$json$::jsonb, null, 0, 0, 0, 0, 0, 1000);
  perform set_config('test.k3_id', r.bill_id::text, true);
  perform set_config('test.k3_code', r.join_code, true);

  select * into r from public.create_bill($json$[
    {"name":"Tea","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":300}
  ]$json$::jsonb, null, 0, 0, 0, 0, 0, 300);
  perform set_config('test.k5_id', r.bill_id::text, true);
  perform set_config('test.k5_code', r.join_code, true);
end $$;

set local request.jwt.claims = '{"sub":"f2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.join_bill(current_setting('test.w_code'));
select public.join_bill(current_setting('test.k1_code'));
select public.join_bill(current_setting('test.k2_code'));
select public.join_bill(current_setting('test.k3_code'));
select public.join_bill(current_setting('test.k5_code'));
set local request.jwt.claims = '{"sub":"f4000000-0000-0000-0000-000000000004","role":"authenticated"}';
select public.join_bill(current_setting('test.w_code'));
reset role;

do $$
declare
  v_ids text[] := array[
    'w_burger', current_setting('test.w_id'), 'Burger', '0',
    'w_salad', current_setting('test.w_id'), 'Salad', '0',
    'w_fries', current_setting('test.w_id'), 'Fries', '0',
    'k1_tea', current_setting('test.k1_id'), 'Tea', '0',
    'k1_cake', current_setting('test.k1_id'), 'Cake', '0',
    'k2_beer0', current_setting('test.k2_id'), 'Beer', '0',
    'k3_burger', current_setting('test.k3_id'), 'Burger', '0',
    'k5_tea', current_setting('test.k5_id'), 'Tea', '0'];
  i integer;
begin
  for i in 0 .. array_length(v_ids, 1) / 4 - 1 loop
    perform set_config('test.' || v_ids[i * 4 + 1],
      (select li.id::text from public.line_items as li
       where li.bill_id = v_ids[i * 4 + 2]::uuid and li.name = v_ids[i * 4 + 3]
         and li.unit_index = v_ids[i * 4 + 4]::integer), true);
  end loop;
end $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"f1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.set_claim(current_setting('test.w_burger')::uuid, true);
select public.set_claim(current_setting('test.w_fries')::uuid, true);
select public.set_claim(current_setting('test.k1_tea')::uuid, true);
select public.set_claim(current_setting('test.k2_beer0')::uuid, true);
select public.set_claim(current_setting('test.k3_burger')::uuid, true);
select public.set_claim(current_setting('test.k5_tea')::uuid, true);
set local request.jwt.claims = '{"sub":"f2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.set_claim(current_setting('test.w_salad')::uuid, true);
select public.set_claim(current_setting('test.w_fries')::uuid, true);
select public.set_claim(current_setting('test.k1_cake')::uuid, true);
reset role;

-- ---------------------------------------------------------------------------
-- Criterion 14: bill_is_complete for K1-K5
-- ---------------------------------------------------------------------------
select is(private.bill_is_complete(current_setting('test.k1_id')::uuid), true,
  'c14 K1: every row has a claim: complete');
select is(private.bill_is_complete(current_setting('test.k2_id')::uuid), false,
  'c14 K2: Beer x2 with unit 1 unclaimed: not complete');
select is(private.bill_is_complete(current_setting('test.k3_id')::uuid), false,
  'c14 K3: an unclaimed $0.00 row: not complete');
select is(private.bill_is_complete(current_setting('test.w_id')::uuid), true,
  'c14 K4: one row shared by 2 claimers, the rest claimed: complete');
select is(private.bill_is_complete(current_setting('test.k5_id')::uuid), true,
  'c14 K5 (before the edit): complete');

set local role authenticated;
set local request.jwt.claims = '{"sub":"f1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok(
  format($$ select public.update_bill(%L::uuid, %L::jsonb, null, 0, 0, 0, 0, 0, 500) $$,
    current_setting('test.k5_id'),
    jsonb_build_array(
      jsonb_build_object('id', current_setting('test.k5_tea'), 'name', 'Tea', 'note', null,
        'group_position', 0, 'unit_index', 0, 'group_size', 1, 'total_cents', 300),
      jsonb_build_object('name', 'Cookie', 'note', null,
        'group_position', 1, 'unit_index', 0, 'group_size', 1, 'total_cents', 200))),
  'c14 K5: the host''s update_bill adds a row');
reset role;
select is(private.bill_is_complete(current_setting('test.k5_id')::uuid), false,
  'c14 K5: after a new row is added: not complete');

set local role authenticated;
set local request.jwt.claims = '{"sub":"f1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select throws_ok(
  $$ select private.bill_is_complete(current_setting('test.k1_id')::uuid) $$,
  '42501', null, 'c14: authenticated cannot execute bill_is_complete (42501)');
reset role;
select ok(
  not has_function_privilege('public', 'private.bill_is_complete(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.bill_is_complete(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.bill_is_complete(uuid)', 'execute'),
  'c14: bill_is_complete is not executable by public, anon or authenticated');

-- ---------------------------------------------------------------------------
-- Criterion 23: security settings of mark_paid and unmark_paid
-- ---------------------------------------------------------------------------
select ok(
  (select bool_and(prosecdef and proconfig = array['search_path=""']) from pg_proc
   where oid in ('public.mark_paid(uuid,uuid,integer,text,text)'::regprocedure,
                 'public.unmark_paid(uuid,uuid,uuid)'::regprocedure)),
  'c23: mark_paid and unmark_paid are security definer with an empty search_path');
select ok(
  has_function_privilege('authenticated', 'public.mark_paid(uuid,uuid,integer,text,text)', 'execute')
  and not has_function_privilege('anon', 'public.mark_paid(uuid,uuid,integer,text,text)', 'execute')
  and not has_function_privilege('public', 'public.mark_paid(uuid,uuid,integer,text,text)', 'execute'),
  'c23: mark_paid is executable by authenticated only');
select ok(
  has_function_privilege('authenticated', 'public.unmark_paid(uuid,uuid,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.unmark_paid(uuid,uuid,uuid)', 'execute')
  and not has_function_privilege('public', 'public.unmark_paid(uuid,uuid,uuid)', 'execute'),
  'c23: unmark_paid is executable by authenticated only');

-- ---------------------------------------------------------------------------
-- Criterion 15: B marks paid on the worked example (payer A)
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"f2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select lives_ok(
  $$ select public.mark_paid(current_setting('test.w_id')::uuid, 'f1000000-0000-0000-0000-000000000001', 1510, 'other') $$,
  'c15: B marks 1510 paid to A');
reset role;
select results_eq(
  $$ select user_id, settled_cents, settled_at is not null from pg_temp.bp_marks
     where bill_id = current_setting('test.w_id')::uuid order by user_id $$,
  $$ values ('f1000000-0000-0000-0000-000000000001'::uuid, null::integer, false),
            ('f2000000-0000-0000-0000-000000000002'::uuid, 1510, true),
            ('f4000000-0000-0000-0000-000000000004'::uuid, null::integer, false) $$,
  'c15: only B''s row has the mark (1510, settled_at set)');
select results_eq(
  $$ select actor_id, details from public.bill_events
     where bill_id = current_setting('test.w_id')::uuid and kind = 'marked_paid' $$,
  $$ values ('f2000000-0000-0000-0000-000000000002'::uuid,
             '{"payer_id":"f1000000-0000-0000-0000-000000000001","cents":1510,"method":"other"}'::jsonb) $$,
  'c15: one marked_paid {payer_id A, cents 1510, method other}, actor B');
do $$ begin
  perform set_config('test.b_at', (select settled_at::text from pg_temp.bp_marks
    where bill_id = current_setting('test.w_id')::uuid and user_id = 'f2000000-0000-0000-0000-000000000002'), true);
end $$;

-- ---------------------------------------------------------------------------
-- Criterion 16: marking again is a no-op
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"f2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select lives_ok(
  $$ select public.mark_paid(current_setting('test.w_id')::uuid, 'f1000000-0000-0000-0000-000000000001', 1600, 'other') $$,
  'c16: B marks again with 1600 without an error');
reset role;
select ok(
  (select settled_cents = 1510 and settled_at = current_setting('test.b_at')::timestamptz
   from pg_temp.bp_marks
   where bill_id = current_setting('test.w_id')::uuid and user_id = 'f2000000-0000-0000-0000-000000000002')
  and (select count(*) = 1 from public.bill_events
       where bill_id = current_setting('test.w_id')::uuid and kind = 'marked_paid'),
  'c16: still 1510 with the same settled_at, and no second event');

-- ---------------------------------------------------------------------------
-- Criterion 17: incomplete bills (K2, K3, K5) refuse marks
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"f2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok(
  $$ select public.mark_paid(current_setting('test.k2_id')::uuid, 'f1000000-0000-0000-0000-000000000001', 700, 'other') $$,
  '22023', 'not_complete', 'c17 K2: 22023 not_complete');
select throws_ok(
  $$ select public.mark_paid(current_setting('test.k3_id')::uuid, 'f1000000-0000-0000-0000-000000000001', 100, 'other') $$,
  '22023', 'not_complete', 'c17 K3: 22023 not_complete');
select throws_ok(
  $$ select public.mark_paid(current_setting('test.k5_id')::uuid, 'f1000000-0000-0000-0000-000000000001', 100, 'other') $$,
  '22023', 'not_complete', 'c17 K5: 22023 not_complete');
reset role;
select ok(
  (select count(*) = 0 from pg_temp.bp_marks
   where bill_id in (current_setting('test.k2_id')::uuid, current_setting('test.k3_id')::uuid,
                     current_setting('test.k5_id')::uuid)
     and settled_at is not null)
  and (select count(*) = 0 from public.bill_events
       where bill_id in (current_setting('test.k2_id')::uuid, current_setting('test.k3_id')::uuid,
                         current_setting('test.k5_id')::uuid)
         and kind = 'marked_paid'),
  'c17: no mark and no event on K2, K3 or K5');

-- ---------------------------------------------------------------------------
-- Criterion 18: the payer can't mark; a stale payer id is refused
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"f1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select throws_ok(
  $$ select public.mark_paid(current_setting('test.w_id')::uuid, 'f1000000-0000-0000-0000-000000000001', 2090, 'other') $$,
  '22023', 'is_payer', 'c18: A (the payer) gets 22023 is_payer');
set local request.jwt.claims = '{"sub":"f4000000-0000-0000-0000-000000000004","role":"authenticated"}';
select throws_ok(
  $$ select public.mark_paid(current_setting('test.w_id')::uuid, 'f2000000-0000-0000-0000-000000000002', 100, 'other') $$,
  '22023', 'payer_changed', 'c18: D naming B as payer while the payer is A gets 22023 payer_changed');
select throws_ok(
  $$ select public.mark_paid(current_setting('test.w_id')::uuid, null, 100, 'other') $$,
  '22023', 'payer_changed', 'c18: a null payer id gets 22023 payer_changed');

-- ---------------------------------------------------------------------------
-- Criterion 19: the amount rule C2 (as D on W, payer A, complete)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select public.mark_paid(current_setting('test.w_id')::uuid, 'f1000000-0000-0000-0000-000000000001', 0, 'other') $$,
  '22023', 'invalid_amount', 'c19 A1: 0 gives 22023 invalid_amount');
select throws_ok(
  $$ select public.mark_paid(current_setting('test.w_id')::uuid, 'f1000000-0000-0000-0000-000000000001', 100000000, 'other') $$,
  '22023', 'invalid_amount', 'c19 A4: 100000000 gives 22023 invalid_amount');
select throws_ok(
  $$ select public.mark_paid(current_setting('test.w_id')::uuid, 'f1000000-0000-0000-0000-000000000001', -5, 'other') $$,
  '22023', 'invalid_amount', 'c19 A5: -5 gives 22023 invalid_amount');
select throws_ok(
  $$ select public.mark_paid(current_setting('test.w_id')::uuid, 'f1000000-0000-0000-0000-000000000001', null, 'other') $$,
  '22023', 'invalid_amount', 'c19 A6: null gives 22023 invalid_amount');
select lives_ok(
  $$ select public.mark_paid(current_setting('test.w_id')::uuid, 'f1000000-0000-0000-0000-000000000001', 1, 'other') $$,
  'c19 A2: 1 is accepted');
set local request.jwt.claims = '{"sub":"f2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select lives_ok(
  $$ select public.mark_paid(current_setting('test.k1_id')::uuid, 'f1000000-0000-0000-0000-000000000001', 99999999, 'other') $$,
  'c19 A3: 99999999 is accepted');
reset role;
select is(
  (select settled_cents from pg_temp.bp_marks
   where bill_id = current_setting('test.w_id')::uuid and user_id = 'f4000000-0000-0000-0000-000000000004'),
  1, 'c19 A2: 1 is stored exactly');
select is(
  (select settled_cents from pg_temp.bp_marks
   where bill_id = current_setting('test.k1_id')::uuid and user_id = 'f2000000-0000-0000-0000-000000000002'),
  99999999, 'c19 A3: 99999999 is stored exactly');
select is(
  (select count(*)::int from public.bill_events
   where bill_id = current_setting('test.w_id')::uuid and kind = 'marked_paid'
     and actor_id = 'f4000000-0000-0000-0000-000000000004'),
  1, 'c19: the four refused amounts logged nothing; the accepted one logged one event');

-- ---------------------------------------------------------------------------
-- Criterion 22: the check order (invalid amount and the payer: invalid_amount wins)
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"f1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select throws_ok(
  $$ select public.mark_paid(current_setting('test.w_id')::uuid, 'f1000000-0000-0000-0000-000000000001', 0, 'other') $$,
  '22023', 'invalid_amount', 'c22: the payer with an invalid amount gets invalid_amount, not is_payer');
set local request.jwt.claims = '{"sub":"f2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok(
  $$ select public.mark_paid(current_setting('test.k2_id')::uuid, 'f4000000-0000-0000-0000-000000000004', 100, 'other') $$,
  '22023', 'payer_changed', 'c22: a stale payer on an incomplete bill gets payer_changed, not not_complete');

-- ---------------------------------------------------------------------------
-- Criterion 20: outsiders, anon and unknown bills
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"f3000000-0000-0000-0000-000000000003","role":"authenticated"}';
select throws_ok(
  $$ select public.mark_paid(current_setting('test.w_id')::uuid, 'f1000000-0000-0000-0000-000000000001', 100, 'other') $$,
  '42501', 'not_allowed', 'c20: C (outsider) gets 42501 from mark_paid');
select throws_ok(
  $$ select public.unmark_paid(current_setting('test.w_id')::uuid, 'f2000000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000001') $$,
  '42501', 'not_allowed', 'c20: C (outsider) gets 42501 from unmark_paid');
select throws_ok(
  $$ select public.unmark_paid(current_setting('test.w_id')::uuid, 'f3000000-0000-0000-0000-000000000003', 'f1000000-0000-0000-0000-000000000001') $$,
  '42501', 'not_allowed', 'c20: C unmarking themself on a bill they aren''t in gets 42501');
set local request.jwt.claims = '{"sub":"f2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok(
  $$ select public.mark_paid('00000000-0000-0000-0000-00000000dead', 'f1000000-0000-0000-0000-000000000001', 100, 'other') $$,
  '42501', 'not_allowed', 'c20: an unknown bill gets 42501 from mark_paid');
select throws_ok(
  $$ select public.unmark_paid('00000000-0000-0000-0000-00000000dead', 'f2000000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000001') $$,
  '42501', 'not_allowed', 'c20: an unknown bill gets 42501 from unmark_paid');
set local request.jwt.claims = '{"role":"authenticated"}';
select throws_ok(
  $$ select public.mark_paid(current_setting('test.w_id')::uuid, 'f1000000-0000-0000-0000-000000000001', 100, 'other') $$,
  '42501', 'not_allowed', 'c20: no user id gets 42501 from mark_paid');
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select throws_ok(
  $$ select public.mark_paid(current_setting('test.w_id')::uuid, 'f1000000-0000-0000-0000-000000000001', 100, 'other') $$,
  '42501', null, 'c20: anon gets 42501 from mark_paid');
select throws_ok(
  $$ select public.unmark_paid(current_setting('test.w_id')::uuid, 'f2000000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'c20: anon gets 42501 from unmark_paid');
reset role;

-- ---------------------------------------------------------------------------
-- Criterion 21: unmark_paid (host, self, payer; not others)
-- ---------------------------------------------------------------------------
-- D (neither host nor payer) on B: refused, mark kept.
set local role authenticated;
set local request.jwt.claims = '{"sub":"f4000000-0000-0000-0000-000000000004","role":"authenticated"}';
select throws_ok(
  $$ select public.unmark_paid(current_setting('test.w_id')::uuid, 'f2000000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000001') $$,
  '42501', 'not_allowed', 'c21: D unmarking B gets 42501');
reset role;
select is(
  (select settled_cents from pg_temp.bp_marks
   where bill_id = current_setting('test.w_id')::uuid and user_id = 'f2000000-0000-0000-0000-000000000002'),
  1510, 'c21: B''s mark is kept after D''s refused undo');

-- The host (A) undoes B's mark.
set local role authenticated;
set local request.jwt.claims = '{"sub":"f1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok(
  $$ select public.unmark_paid(current_setting('test.w_id')::uuid, 'f2000000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000001') $$,
  'c21: the host A undoes B''s mark');
reset role;
select ok(
  (select settled_at is null and settled_cents is null from pg_temp.bp_marks
   where bill_id = current_setting('test.w_id')::uuid and user_id = 'f2000000-0000-0000-0000-000000000002'),
  'c21: B''s mark is cleared by the host');

-- B marks again and undoes it themself.
set local role authenticated;
set local request.jwt.claims = '{"sub":"f2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.mark_paid(current_setting('test.w_id')::uuid, 'f1000000-0000-0000-0000-000000000001', 1510, 'other');
select lives_ok(
  $$ select public.unmark_paid(current_setting('test.w_id')::uuid, 'f2000000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000001') $$,
  'c21: B undoes their own mark');
reset role;

-- Payer becomes D (not the host); B marks paid to D; D undoes it as the payer.
set local role authenticated;
set local request.jwt.claims = '{"sub":"f1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.set_payer(current_setting('test.w_id')::uuid, 'f4000000-0000-0000-0000-000000000004');
set local request.jwt.claims = '{"sub":"f2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.mark_paid(current_setting('test.w_id')::uuid, 'f4000000-0000-0000-0000-000000000004', 1510, 'other');
set local request.jwt.claims = '{"sub":"f4000000-0000-0000-0000-000000000004","role":"authenticated"}';
select lives_ok(
  $$ select public.unmark_paid(current_setting('test.w_id')::uuid, 'f2000000-0000-0000-0000-000000000002', 'f4000000-0000-0000-0000-000000000004') $$,
  'c21: the payer D undoes B''s mark');
reset role;

select results_eq(
  $$ select actor_id, details from public.bill_events
     where bill_id = current_setting('test.w_id')::uuid and kind = 'unmarked_paid'
     order by actor_id $$,
  $$ values
       ('f1000000-0000-0000-0000-000000000001'::uuid,
        '{"user_id":"f2000000-0000-0000-0000-000000000002","cents":1510}'::jsonb),
       ('f2000000-0000-0000-0000-000000000002'::uuid,
        '{"user_id":"f2000000-0000-0000-0000-000000000002","cents":1510}'::jsonb),
       ('f4000000-0000-0000-0000-000000000004'::uuid,
        '{"user_id":"f2000000-0000-0000-0000-000000000002","cents":1510}'::jsonb) $$,
  'c21: one unmarked_paid {user_id B, cents 1510} per undo, with the host, B and the payer D as actors');
select is(
  (select count(*)::int from public.bill_events
   where bill_id = current_setting('test.w_id')::uuid and kind = 'marked_paid'
     and actor_id = 'f2000000-0000-0000-0000-000000000002'),
  3, 'c21: each of B''s three marks logged exactly one marked_paid');

-- Unmarked and non-participant targets: no-op, no event (as the host).
set local role authenticated;
set local request.jwt.claims = '{"sub":"f1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok(
  $$ select public.unmark_paid(current_setting('test.w_id')::uuid, 'f2000000-0000-0000-0000-000000000002', 'f4000000-0000-0000-0000-000000000004') $$,
  'c21: undoing an unmarked target raises nothing');
select lives_ok(
  $$ select public.unmark_paid(current_setting('test.w_id')::uuid, 'f3000000-0000-0000-0000-000000000003', 'f4000000-0000-0000-0000-000000000004') $$,
  'c21: undoing a non-participant target raises nothing');
reset role;
select is(
  (select count(*)::int from public.bill_events
   where bill_id = current_setting('test.w_id')::uuid and kind = 'unmarked_paid'),
  3, 'c21: the two no-op undos logged nothing');

-- ---------------------------------------------------------------------------
-- C1 K6 (spec Amendment A1 review R2): proportional, every row $0.00, total > 0, all claimed. The
-- DB still calls it complete (bill_is_complete, unchanged), but since 20261125090050_settle_early.sql
-- mark_paid refuses it with 22023 all_zero (rule Z, SE-3: K6 closed), matching the app's
-- blocked_all_zero.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"f1000000-0000-0000-0000-000000000001","role":"authenticated"}';
do $$
declare r record;
begin
  select * into r from public.create_bill($json$[
    {"name":"Bread","note":null,"group_position":0,"unit_index":0,"group_size":1,"total_cents":0},
    {"name":"Water","note":null,"group_position":1,"unit_index":0,"group_size":1,"total_cents":0}
  ]$json$::jsonb, null, 500, 0, 0, 0, 0, 500);
  perform set_config('test.k6_id', r.bill_id::text, true);
  perform set_config('test.k6_code', r.join_code, true);
end $$;
set local request.jwt.claims = '{"sub":"f2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.join_bill(current_setting('test.k6_code'));
reset role;
do $$ begin
  perform set_config('test.k6_bread', (select id::text from public.line_items
    where bill_id = current_setting('test.k6_id')::uuid and name = 'Bread'), true);
  perform set_config('test.k6_water', (select id::text from public.line_items
    where bill_id = current_setting('test.k6_id')::uuid and name = 'Water'), true);
end $$;
set local role authenticated;
set local request.jwt.claims = '{"sub":"f1000000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.set_claim(current_setting('test.k6_bread')::uuid, true);
set local request.jwt.claims = '{"sub":"f2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.set_claim(current_setting('test.k6_water')::uuid, true);
reset role;
select ok(private.bill_is_complete(current_setting('test.k6_id')::uuid),
  'K6: every row $0.00 and claimed: the DB calls it complete (lib: blocked_all_zero)');
set local role authenticated;
set local request.jwt.claims = '{"sub":"f2000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok(
  $$ select public.mark_paid(current_setting('test.k6_id')::uuid, 'f1000000-0000-0000-0000-000000000001', 1, 'other') $$,
  '22023', 'all_zero', 'K6: mark_paid raises 22023 all_zero (K6 closed, SE-3)');
reset role;
select ok(
  (select settled_at is null and settled_cents is null from pg_temp.bp_marks
   where bill_id = current_setting('test.k6_id')::uuid and user_id = 'f2000000-0000-0000-0000-000000000002')
  and not exists (select 1 from public.bill_events
                  where bill_id = current_setting('test.k6_id')::uuid and kind = 'marked_paid'),
  'K6: no mark is stored and no marked_paid event is logged');

select * from finish();
rollback;
