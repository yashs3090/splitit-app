-- pgTAP tests for settle the difference, Task 2 (spec
-- docs/specs/2026-11-25-settle-early-and-differences.md, Amendment A1; D4 contract D, D8, D10;
-- criteria 7-15): public.settle_difference and the two new Activity kinds.
--
-- Each boundary row D1-D20 is tagged [D#] at the start of its assertions (criterion 62's drift
-- test matches these against lib/settle.test.ts and lib/bills.test.ts).
--
-- Every assertion filters to the fixture bills/users below (the local DB may hold real data).
--
-- Users: Dee 5d4... (host of every bill, not the payer), Hana 5d1... (the payer, set by Dee's
--        set_payer), Sam 5d2... (the person whose mark changes), Cal 5d3... (outsider).
-- Standard bill: Burger 1500 (Hana), Salad 1000 (Sam), Fries 600 (Sam and Dee), tax 500,
--        total 3600, proportional; complete unless noted. Sam marks 1510 unless noted.
--   x    the main bill: refusals D8, D10-D14, D16, D17, then D1, D18, D20
--   d2   D2 (pay back to 1400)       d3   D3, D19, criterion 9 (Dee also marked 500)
--   d4   D4 (pay back to 0)          d5   D5 (raise by 1)       d6   D6 (raise by 2)
--   d7   D7 (Sam not marked)         d9   D9 (Sam not marked)
--   d15  D15: incomplete (Hana's Burger unclaimed), Sam marked 1510 early
--   az   all-$0 proportional bill (Bread 0, Water 0, tax 500, total 500), complete, no marks
--   big  standard bill plus 220 rows of 9,999,999 inserted as postgres (criterion 14 overflow)

begin;

create extension if not exists pgtap with schema extensions;

select plan(64);

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
  ('5d100000-0000-0000-0000-000000000001', 'diff-hana@test.local', '{"full_name":"Hana"}'::jsonb),
  ('5d200000-0000-0000-0000-000000000002', 'diff-sam@test.local', '{"full_name":"Sam"}'::jsonb),
  ('5d300000-0000-0000-0000-000000000003', 'diff-cal@test.local', '{"full_name":"Cal"}'::jsonb),
  ('5d400000-0000-0000-0000-000000000004', 'diff-dee@test.local', '{"full_name":"Dee"}'::jsonb);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function pg_temp.hana() returns uuid language sql immutable as
  $$ select '5d100000-0000-0000-0000-000000000001'::uuid $$;
create function pg_temp.sam() returns uuid language sql immutable as
  $$ select '5d200000-0000-0000-0000-000000000002'::uuid $$;
create function pg_temp.dee() returns uuid language sql immutable as
  $$ select '5d400000-0000-0000-0000-000000000004'::uuid $$;

create function pg_temp.act(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

create function pg_temp.it(p_pos integer, p_name text, p_cents integer) returns jsonb
language sql immutable as $$
  select jsonb_build_object('name', p_name, 'note', null, 'group_position', p_pos,
    'unit_index', 0, 'group_size', 1, 'total_cents', p_cents);
$$;

create function pg_temp.bid(p_tag text) returns uuid language sql stable as
  $$ select current_setting('test.' || p_tag)::uuid $$;
create function pg_temp.li(p_tag text, p_name text) returns uuid language sql stable as $$
  select li.id from public.line_items as li
  where li.bill_id = pg_temp.bid(p_tag) and li.name = p_name;
$$;

create function pg_temp.claim(p_user uuid, p_tag text, p_name text) returns void
language plpgsql as $$
begin
  perform pg_temp.act(p_user);
  perform public.set_claim(pg_temp.li(p_tag, p_name), true);
end $$;

-- Dee creates the standard bill, Hana and Sam join, Dee makes Hana the payer, everyone claims
-- (Hana's Burger only when p_complete), and Sam marks p_mark when it isn't null.
create function pg_temp.mk(p_tag text, p_complete boolean, p_mark integer) returns void
language plpgsql as $$
declare r record;
begin
  perform pg_temp.act(pg_temp.dee());
  select * into r from public.create_bill(jsonb_build_array(
      pg_temp.it(0, 'Burger', 1500), pg_temp.it(1, 'Salad', 1000), pg_temp.it(2, 'Fries', 600)),
    null, 500, 0, 0, 0, 0, 3600);
  perform set_config('test.' || p_tag, r.bill_id::text, true);
  perform pg_temp.act(pg_temp.hana());
  perform public.join_bill(r.join_code);
  perform pg_temp.act(pg_temp.sam());
  perform public.join_bill(r.join_code);
  perform pg_temp.act(pg_temp.dee());
  perform public.set_payer(r.bill_id, pg_temp.hana());
  if p_complete then
    perform pg_temp.claim(pg_temp.hana(), p_tag, 'Burger');
  end if;
  perform pg_temp.claim(pg_temp.sam(), p_tag, 'Salad');
  perform pg_temp.claim(pg_temp.sam(), p_tag, 'Fries');
  perform pg_temp.claim(pg_temp.dee(), p_tag, 'Fries');
  if p_mark is not null then
    perform pg_temp.act(pg_temp.sam());
    perform public.mark_paid(r.bill_id, pg_temp.hana(), p_mark, 'other');
  end if;
end $$;

-- Sam's stored mark (null when unmarked) and the number of events of a kind on a bill.
create function pg_temp.mark(p_tag text) returns integer language sql stable as $$
  select bp.settled_cents from pg_temp.bp_marks as bp
  where bp.bill_id = pg_temp.bid(p_tag) and bp.user_id = pg_temp.sam();
$$;
create function pg_temp.n(p_tag text, p_kind text) returns integer language sql stable as $$
  select count(*)::integer from public.bill_events as e
  where e.bill_id = pg_temp.bid(p_tag) and e.kind = p_kind;
$$;
-- Exactly one event of the kind on the bill, and it has this actor and these details.
create function pg_temp.one(p_tag text, p_kind text, p_actor uuid, p_details jsonb)
returns boolean language sql stable as $$
  select pg_temp.n(p_tag, p_kind) = 1
     and exists (select 1 from public.bill_events as e
                 where e.bill_id = pg_temp.bid(p_tag) and e.kind = p_kind
                   and e.actor_id = p_actor and e.details = p_details);
$$;
-- Sam's settled_at still equals the one saved at fixture time.
create function pg_temp.same_at(p_tag text) returns boolean language sql stable as $$
  select bp.settled_at = current_setting('test.' || p_tag || '_at')::timestamptz
  from pg_temp.bp_marks as bp
  where bp.bill_id = pg_temp.bid(p_tag) and bp.user_id = pg_temp.sam();
$$;
-- Realtime messages on the bill's topic (as postgres).
create function pg_temp.msgs(p_tag text) returns integer language sql stable as $$
  select count(*)::integer from realtime.messages as m
  where m.topic = 'bill:' || pg_temp.bid(p_tag)::text;
$$;

-- ---------------------------------------------------------------------------
-- Fixtures (as authenticated, through the real functions)
-- ---------------------------------------------------------------------------
set local role authenticated;
do $$
declare r record;
begin
  perform pg_temp.mk('x', true, 1510);
  perform pg_temp.mk('d2', true, 1510);
  perform pg_temp.mk('d3', true, 1510);
  perform pg_temp.act(pg_temp.dee());
  perform public.mark_paid(pg_temp.bid('d3'), pg_temp.hana(), 500, 'other');
  perform pg_temp.mk('d4', true, 1510);
  perform pg_temp.mk('d5', true, 1510);
  perform pg_temp.mk('d6', true, 1510);
  perform pg_temp.mk('d7', true, null);
  perform pg_temp.mk('d9', true, null);
  perform pg_temp.mk('d15', false, 1510);
  perform pg_temp.mk('big', false, null);

  perform pg_temp.act(pg_temp.dee());
  select * into r from public.create_bill(jsonb_build_array(
      pg_temp.it(0, 'Bread', 0), pg_temp.it(1, 'Water', 0)), null, 500, 0, 0, 0, 0, 500);
  perform set_config('test.az', r.bill_id::text, true);
  perform pg_temp.act(pg_temp.hana());
  perform public.join_bill(r.join_code);
  perform pg_temp.act(pg_temp.sam());
  perform public.join_bill(r.join_code);
  perform pg_temp.act(pg_temp.dee());
  perform public.set_payer(r.bill_id, pg_temp.hana());
  perform pg_temp.claim(pg_temp.hana(), 'az', 'Bread');
  perform pg_temp.claim(pg_temp.sam(), 'az', 'Water');
end $$;
reset role;

-- Backdate Sam's fixture marks before saving the baseline. The fixtures set settled_at = now(),
-- and now() is fixed for the whole test transaction, so without this a regression that rewrote
-- settled_at = now() would still compare equal and the "settled_at unchanged" checks could not fail.
-- (Who paid 4a: the marks are Sam's bill_payments entries, whose rows can't be updated; the test
-- lifts that guard for the backdate only, as the owner.)
alter table public.bill_payments disable trigger bill_payments_no_update;
update public.bill_payments as e
   set recorded_at = timestamptz '2026-01-01 12:00:00+00'
 where e.from_user = pg_temp.sam()
   and e.bill_id in (select pg_temp.bid(t) from unnest(array['x', 'd2', 'd5', 'd6', 'd15']) as t);
alter table public.bill_payments enable trigger bill_payments_no_update;

select set_config('test.' || t || '_at', (select bp.settled_at::text from pg_temp.bp_marks as bp
  where bp.bill_id = pg_temp.bid(t) and bp.user_id = pg_temp.sam()), true)
from unnest(array['x', 'd2', 'd5', 'd6', 'd15']) as t;

-- ---------------------------------------------------------------------------
-- Refusals on bill x (Sam marked 1510, complete, payer Hana)
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act(pg_temp.sam());
select throws_ok(
  $$ select public.settle_difference(pg_temp.bid('x'), pg_temp.sam(), pg_temp.hana(), 1400, 1620, 'other') $$,
  '22023', 'mark_changed', '[D8] a stale token (1400 while 1510 is stored) gets 22023 mark_changed');
select throws_ok(
  $$ select public.settle_difference(pg_temp.bid('x'), pg_temp.sam(), pg_temp.hana(), 1510, 1510, 'other') $$,
  '22023', 'invalid_amount', '[D10] from = to gets 22023 invalid_amount');
select throws_ok(
  $$ select public.settle_difference(pg_temp.bid('x'), pg_temp.sam(), pg_temp.hana(), 1510, 100000000, 'other') $$,
  '22023', 'invalid_amount', '[D11] p_new_cents 100000000 gets 22023 invalid_amount');
select throws_ok(
  $$ select public.settle_difference(pg_temp.bid('x'), pg_temp.sam(), pg_temp.hana(), 1510, -1, 'other') $$,
  '22023', 'invalid_amount', '[D11] p_new_cents -1 gets 22023 invalid_amount');
select throws_ok(
  $$ select public.settle_difference(pg_temp.bid('x'), pg_temp.sam(), pg_temp.hana(), 1510, null, 'other') $$,
  '22023', 'invalid_amount', '[D11] p_new_cents null gets 22023 invalid_amount');
select throws_ok(
  $$ select public.settle_difference(pg_temp.bid('x'), pg_temp.sam(), pg_temp.hana(), 0, 1620, 'other') $$,
  '22023', 'invalid_amount', '[D11] p_expected_cents 0 gets 22023 invalid_amount');
select throws_ok(
  $$ select public.settle_difference(pg_temp.bid('x'), pg_temp.sam(), pg_temp.hana(), null, 1620, 'other') $$,
  '22023', 'invalid_amount', '[D11] p_expected_cents null gets 22023 invalid_amount');
select throws_ok(
  $$ select public.settle_difference(pg_temp.bid('x'), pg_temp.sam(), pg_temp.hana(), 1510, 1400, 'other') $$,
  '42501', 'not_allowed', '[D12] Sam lowering his own mark gets 42501 not_allowed');
select throws_ok(
  $$ select public.settle_difference(pg_temp.bid('x'), pg_temp.sam(), pg_temp.dee(), 1510, 1620, 'other') $$,
  '22023', 'payer_changed', '[D16] a stale payer id gets 22023 payer_changed');
select pg_temp.act(pg_temp.hana());
select throws_ok(
  $$ select public.settle_difference(pg_temp.bid('x'), pg_temp.sam(), pg_temp.hana(), 1510, 1620, 'other') $$,
  '42501', 'not_allowed', '[D13] Hana (the payer) raising Sam''s mark gets 42501 not_allowed');
select throws_ok(
  $$ select public.settle_difference(pg_temp.bid('x'), pg_temp.sam(), pg_temp.hana(), 1510, 100000000, 'other') $$,
  '22023', 'invalid_amount',
  'c10: a wrong-direction caller with an invalid amount gets invalid_amount (step 3 before 5)');
select pg_temp.act(pg_temp.dee());
select throws_ok(
  $$ select public.settle_difference(pg_temp.bid('x'), pg_temp.sam(), pg_temp.hana(), 1510, 1620, 'other') $$,
  '42501', 'not_allowed', '[D14] Dee (host, not payer) raising Sam''s mark gets 42501');
select throws_ok(
  $$ select public.settle_difference(pg_temp.bid('x'), pg_temp.sam(), pg_temp.hana(), 1510, 1400, 'other') $$,
  '42501', 'not_allowed', '[D14] Dee (host, not payer) lowering Sam''s mark gets 42501');
select pg_temp.act('5d300000-0000-0000-0000-000000000003');
select throws_ok(
  $$ select public.settle_difference(pg_temp.bid('x'), pg_temp.sam(), pg_temp.hana(), 1510, 1620, 'other') $$,
  '42501', 'not_allowed', '[D17] Cal (outsider) gets 42501 not_allowed');
select pg_temp.act(pg_temp.sam());
select throws_ok(
  $$ select public.settle_difference('00000000-0000-0000-0000-00000000dead', pg_temp.sam(),
       pg_temp.hana(), 1510, 1620, 'other') $$,
  '42501', 'not_allowed', '[D17] an unknown bill gets 42501 not_allowed');
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select throws_ok(
  $$ select public.settle_difference(pg_temp.bid('x'), pg_temp.sam(), pg_temp.hana(), 1510, 1620, 'other') $$,
  '42501', null, '[D17] anon gets 42501');
reset role;

select ok(pg_temp.mark('x') = 1510 and pg_temp.same_at('x')
          and pg_temp.n('x', 'paid_difference') = 0 and pg_temp.n('x', 'paid_back') = 0,
  '[D8] [D10] [D11] [D12] [D13] [D14] [D16] [D17] the refused calls left Sam''s mark at 1510 and logged nothing');

-- ---------------------------------------------------------------------------
-- D1, D18 (idempotent retry), D20 on bill x
-- ---------------------------------------------------------------------------
select set_config('test.msgs', pg_temp.msgs('x')::text, true);
set local role authenticated;
select pg_temp.act(pg_temp.sam());
select lives_ok(
  $$ select public.settle_difference(pg_temp.bid('x'), pg_temp.sam(), pg_temp.hana(), 1510, 1620, 'other') $$,
  '[D1] Sam records paying 110 more (1510 -> 1620)');
reset role;
select ok(pg_temp.mark('x') = 1620 and pg_temp.same_at('x')
          and pg_temp.one('x', 'paid_difference', pg_temp.sam(),
                jsonb_build_object('payer_id', pg_temp.hana(), 'from', 1510, 'to', 1620, 'method', 'other')),
  '[D1] stored 1620, settled_at unchanged, one paid_difference {payer_id Hana, from 1510, to 1620} by Sam');
select is(pg_temp.msgs('x') - current_setting('test.msgs')::integer, 1,
  '[D1] exactly one broadcast on bill:<id> (c13)');

select set_config('test.msgs', pg_temp.msgs('x')::text, true);
set local role authenticated;
select pg_temp.act(pg_temp.sam());
select lives_ok(
  $$ select public.settle_difference(pg_temp.bid('x'), pg_temp.sam(), pg_temp.hana(), 1510, 1620, 'other') $$,
  '[D18] the identical retry succeeds');
reset role;
select ok(pg_temp.mark('x') = 1620 and pg_temp.n('x', 'paid_difference') = 1
          and pg_temp.msgs('x') = current_setting('test.msgs')::integer,
  '[D18] still 1620, still one event, and no broadcast (no write)');

set local role authenticated;
select pg_temp.act(pg_temp.dee());
select throws_ok(
  $$ select public.settle_difference(pg_temp.bid('x'), pg_temp.sam(), pg_temp.hana(), 1510, 1620, 'other') $$,
  '42501', 'not_allowed', '[D20] Dee repeating Sam''s call gets 42501 (idempotency doesn''t skip step 5)');
reset role;
select ok(pg_temp.mark('x') = 1620 and pg_temp.n('x', 'paid_difference') = 1,
  '[D20] nothing changed');

-- ---------------------------------------------------------------------------
-- D2, D3, D19, criterion 9, D4
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act(pg_temp.hana());
select lives_ok(
  $$ select public.settle_difference(pg_temp.bid('d2'), pg_temp.sam(), pg_temp.hana(), 1510, 1400, 'other') $$,
  '[D2] Hana records paying Sam 110 back (1510 -> 1400)');
select lives_ok(
  $$ select public.settle_difference(pg_temp.bid('d3'), pg_temp.sam(), pg_temp.hana(), 1510, 0, 'other') $$,
  '[D3] Hana records paying Sam back in full (1510 -> 0)');
select lives_ok(
  $$ select public.settle_difference(pg_temp.bid('d3'), pg_temp.sam(), pg_temp.hana(), 1510, 0, 'other') $$,
  '[D19] Hana''s identical retry succeeds');
select lives_ok(
  $$ select public.unmark_paid(pg_temp.bid('d3'), pg_temp.sam(), pg_temp.hana()) $$,
  'c9: after D3, unmark_paid on Sam raises nothing (unmarked target, as today)');
select lives_ok(
  $$ select public.settle_difference(pg_temp.bid('d4'), pg_temp.sam(), pg_temp.hana(), 1510, 0, 'other') $$,
  '[D4] Hana pays back to 0 when Sam''s share is below 0 (1510 -> 0, not 1610)');
reset role;
select ok(pg_temp.mark('d2') = 1400 and pg_temp.same_at('d2')
          and pg_temp.one('d2', 'paid_back', pg_temp.hana(),
                jsonb_build_object('user_id', pg_temp.sam(), 'payer_id', pg_temp.hana(), 'from', 1510, 'to', 1400,
                                   'method', 'other')),
  '[D2] stored 1400, settled_at unchanged, one paid_back {user_id Sam, from 1510, to 1400} by Hana');
select ok((select bp.settled_at is null and bp.settled_cents is null from pg_temp.bp_marks as bp
           where bp.bill_id = pg_temp.bid('d3') and bp.user_id = pg_temp.sam())
          and pg_temp.one('d3', 'paid_back', pg_temp.hana(),
                jsonb_build_object('user_id', pg_temp.sam(), 'payer_id', pg_temp.hana(), 'from', 1510, 'to', 0,
                                   'method', 'other')),
  '[D3] the mark is cleared (settled_at and settled_cents null) and one paid_back {from 1510, to 0}');
select ok(pg_temp.mark('d3') is null and pg_temp.n('d3', 'paid_back') = 1,
  '[D19] still no mark and still one paid_back event');
select ok(pg_temp.n('d3', 'unmarked_paid') = 0,
  'c9: the unmark_paid after D3 logged no event');
select ok((select bp.settled_at is null and bp.settled_cents is null from pg_temp.bp_marks as bp
           where bp.bill_id = pg_temp.bid('d4') and bp.user_id = pg_temp.sam())
          and pg_temp.one('d4', 'paid_back', pg_temp.hana(),
                jsonb_build_object('user_id', pg_temp.sam(), 'payer_id', pg_temp.hana(), 'from', 1510, 'to', 0,
                                   'method', 'other')),
  '[D4] the mark is cleared and one paid_back {from 1510, to 0}');

-- Criterion 9 (who paid 4b, 20261127140002): set_payer has no expected-cleared token any more
-- (payments are a ledger and a payer change clears none), so the count check is gone.
set local role authenticated;
select pg_temp.act(pg_temp.dee());
select throws_ok(
  $$ select public.set_payer(pg_temp.bid('d3'), pg_temp.sam(), 2) $$,
  '42883', null, 'c9: after D3, the 3-arg set_payer (expected-cleared token) no longer exists');
select lives_ok(
  $$ select public.set_payer(pg_temp.bid('d3'), pg_temp.sam()) $$,
  'c9: after D3, set_payer(bill, Sam) succeeds');

-- ---------------------------------------------------------------------------
-- D5, D6 (raises), D7, D9 (unmarked), criterion 8's mark_paid 0
-- ---------------------------------------------------------------------------
select pg_temp.act(pg_temp.sam());
select lives_ok(
  $$ select public.settle_difference(pg_temp.bid('d5'), pg_temp.sam(), pg_temp.hana(), 1510, 1511, 'other') $$,
  '[D5] a 1-cent raise is accepted (the DB has no tolerance)');
select lives_ok(
  $$ select public.settle_difference(pg_temp.bid('d6'), pg_temp.sam(), pg_temp.hana(), 1510, 1512, 'other') $$,
  '[D6] a 2-cent raise is accepted');
select throws_ok(
  $$ select public.settle_difference(pg_temp.bid('d7'), pg_temp.sam(), pg_temp.hana(), 0, 500, 'other') $$,
  '22023', 'invalid_amount', '[D7] unmarked Sam with token 0 gets 22023 invalid_amount');
select throws_ok(
  $$ select public.settle_difference(pg_temp.bid('d9'), pg_temp.sam(), pg_temp.hana(), 1510, 1620, 'other') $$,
  '22023', 'mark_changed', '[D9] unmarked Sam with token 1510 gets 22023 mark_changed');
select throws_ok(
  $$ select public.mark_paid(pg_temp.bid('d7'), pg_temp.hana(), 0, 'other') $$,
  '22023', 'invalid_amount', 'c8: mark_paid with 0 still raises invalid_amount');
reset role;
select ok(pg_temp.mark('d5') = 1511 and pg_temp.same_at('d5')
          and pg_temp.one('d5', 'paid_difference', pg_temp.sam(),
                jsonb_build_object('payer_id', pg_temp.hana(), 'from', 1510, 'to', 1511, 'method', 'other')),
  '[D5] stored 1511 and one paid_difference {from 1510, to 1511}');
select ok(pg_temp.mark('d6') = 1512 and pg_temp.same_at('d6')
          and pg_temp.one('d6', 'paid_difference', pg_temp.sam(),
                jsonb_build_object('payer_id', pg_temp.hana(), 'from', 1510, 'to', 1512, 'method', 'other')),
  '[D6] stored 1512 and one paid_difference {from 1510, to 1512}');
select ok(pg_temp.mark('d7') is null and pg_temp.n('d7', 'paid_difference') = 0
          and pg_temp.n('d7', 'marked_paid') = 0,
  '[D7] still unmarked and nothing logged');
select ok(pg_temp.mark('d9') is null and pg_temp.n('d9', 'paid_difference') = 0,
  '[D9] still unmarked and nothing logged');

-- ---------------------------------------------------------------------------
-- D15 and the check-order pins on the incomplete bill (criterion 10); all_zero (step 6)
-- ---------------------------------------------------------------------------
set local role authenticated;
select throws_ok(
  $$ select public.settle_difference(pg_temp.bid('d15'), pg_temp.sam(), pg_temp.hana(), 1510, 1620, 'other') $$,
  '22023', 'not_complete', '[D15] on an incomplete bill (E1 state) Sam gets 22023 not_complete');
select throws_ok(
  $$ select public.settle_difference(pg_temp.bid('d15'), pg_temp.sam(), pg_temp.hana(), 1400, 1620, 'other') $$,
  '22023', 'not_complete', 'c10: a stale token on an incomplete bill gets not_complete (step 7 before 10)');
select throws_ok(
  $$ select public.settle_difference(pg_temp.bid('az'), pg_temp.sam(), pg_temp.hana(), 1510, 1620, 'other') $$,
  '22023', 'all_zero', 'step 6: on an all-$0 proportional bill Sam gets 22023 all_zero');
select pg_temp.act(pg_temp.hana());
select throws_ok(
  $$ select public.settle_difference(pg_temp.bid('d15'), pg_temp.sam(), pg_temp.hana(), 1510, 1620, 'other') $$,
  '42501', 'not_allowed',
  'c10: a wrong-direction caller with valid amounts on an incomplete bill gets 42501 (step 5 before 6-7)');
reset role;
select ok(pg_temp.mark('d15') = 1510 and pg_temp.same_at('d15')
          and pg_temp.n('d15', 'paid_difference') = 0 and pg_temp.n('d15', 'paid_back') = 0,
  '[D15] Sam''s early mark is unchanged and nothing was logged');

-- ---------------------------------------------------------------------------
-- Criterion 11: the kind constraint (as postgres, on bill az)
-- ---------------------------------------------------------------------------
select lives_ok(
  $$ insert into public.bill_events (bill_id, kind)
     select pg_temp.bid('az'), k
     from unnest(array['bill_created', 'joined', 'claimed', 'unclaimed', 'split_changed',
                       'item_added', 'item_removed', 'item_changed', 'amounts_changed',
                       'link_rotated', 'extras_split_changed', 'payer_changed', 'marked_paid',
                       'unmarked_paid', 'participant_added', 'participant_removed', 'left',
                       'paid_difference', 'paid_back']) as k $$,
  'c11: every earlier kind plus paid_difference and paid_back is accepted');
select throws_ok(
  $$ insert into public.bill_events (bill_id, kind) values (pg_temp.bid('az'), 'paid_more') $$,
  '23514', null, 'c11: kind ''paid_more'' is rejected');

-- ---------------------------------------------------------------------------
-- Criterion 12: security settings and grants
-- ---------------------------------------------------------------------------
select ok(
  (select prosecdef and proconfig = array['search_path=""'] from pg_proc
   where oid = 'public.settle_difference(uuid,uuid,uuid,integer,integer,text,text)'::regprocedure),
  'c12: settle_difference is security definer with an empty search_path');
select ok(
  has_function_privilege('authenticated', 'public.settle_difference(uuid,uuid,uuid,integer,integer,text,text)', 'execute')
  and not has_function_privilege('anon', 'public.settle_difference(uuid,uuid,uuid,integer,integer,text,text)', 'execute')
  and not has_function_privilege('public', 'public.settle_difference(uuid,uuid,uuid,integer,integer,text,text)', 'execute'),
  'c12: settle_difference is executable by authenticated only');
set local role authenticated;
select pg_temp.act(pg_temp.sam());
select throws_ok(
  $$ update public.bill_payments set cents = 1 where from_user = pg_temp.sam() $$,
  '42501', null, 'c12: a direct update of Sam''s bill_payments entries as Sam fails with 42501');
reset role;
select table_privs_are('public', 'bills', 'authenticated', array['SELECT'],
  'c12: authenticated has only SELECT on bills');
select table_privs_are('public', 'bill_participants', 'authenticated', array['SELECT'],
  'c12: authenticated has only SELECT on bill_participants');
select table_privs_are('public', 'bills', 'anon', array[]::text[],
  'c12: anon has nothing on bills');
select table_privs_are('public', 'bill_participants', 'anon', array[]::text[],
  'c12: anon has nothing on bill_participants');

-- ---------------------------------------------------------------------------
-- Criterion 14: lock order (static), settle_state is one SQL statement with bigint sums
-- ---------------------------------------------------------------------------
select ok(
  (select position('public.bill_participants' in p.prosrc) > 0
          and position('public.bill_participants' in p.prosrc) < position('for share' in p.prosrc)
          and position('for share' in p.prosrc) < position('private.settle_state' in p.prosrc)
          and position('private.settle_state' in p.prosrc) < position('for no key update' in p.prosrc)
          and position('for no key update' in p.prosrc) < position('insert into public.bill_payments' in p.prosrc)
          and position('insert into public.bill_payments' in p.prosrc) < position('private.log_event' in p.prosrc)
   from pg_proc as p
   where p.oid = 'public.settle_difference(uuid,uuid,uuid,integer,integer,text,text)'::regprocedure),
  'c14: participation read, then FOR SHARE on bills, settle_state, FOR NO KEY UPDATE on the participant row, the ledger insert, the event');
select ok(
  (select position('for update' in p.prosrc) = 0
          and (length(p.prosrc) - length(replace(p.prosrc, 'private.settle_state', '')))
              / length('private.settle_state') = 1
   from pg_proc as p
   where p.oid = 'public.settle_difference(uuid,uuid,uuid,integer,integer,text,text)'::regprocedure),
  'c14: no FOR UPDATE (only FOR NO KEY UPDATE), and settle_state is called exactly once');
select ok(
  (select l.lanname = 'sql' and p.provolatile = 's'
          and p.prosrc !~* '::\s*(integer|int4|int)\M'
   from pg_proc as p join pg_language as l on l.oid = p.prolang
   where p.oid = 'private.settle_state(uuid,uuid)'::regprocedure),
  'c14: private.settle_state is language sql (one statement), stable, with no cast to integer');

-- A bill whose item rows sum above 2,147,483,647: the row constraints allow it (each item row
-- <= 9,999,999), so 220 rows are inserted as postgres next to the standard rows (incomplete; Sam
-- has item claims, so the answer is early).
insert into public.line_items (bill_id, group_position, unit_index, group_size, name, total_cents)
select pg_temp.bid('big'), 2 + g, 0, 1, 'Big ' || g, 9999999
from generate_series(1, 220) as g;
select lives_ok(
  $$ select private.settle_state(pg_temp.bid('big'), pg_temp.sam()) $$,
  'c14: settle_state on a bill whose items sum to 2,199,999,780 + 3,100 raises no overflow');
select is(private.settle_state(pg_temp.bid('big'), pg_temp.sam()), 'early',
  'c14: and answers early (bigint sums, nothing cast back to integer)');

select * from finish();
rollback;
