-- pgTAP tests for settle early, Task 1 (spec docs/specs/2026-11-25-settle-early-and-differences.md,
-- Amendment A1; D2 contract E, D3; criteria 1-6): private.settle_state, private.bill_all_zero and
-- the new mark_paid.
--
-- Each boundary row E1-E20 has its own bill, set up through the real functions (create_bill,
-- join_bill, set_claim, set_item_split, set_extras_split, update_bill), and its assertions start
-- with its [E#] tag (criterion 62's drift test matches these against lib/settle.test.ts).
--
-- Every assertion filters to the fixture bills/users below (the local DB may hold real data).
--
-- Users: Hana 5e1... (host and payer of every bill), Sam 5e2... (U, joins every bill),
--        Cal 5e3... (outsider).
-- Small helpers live in pg_temp (dropped with the session; the whole file is rolled back).

begin;

create extension if not exists pgtap with schema extensions;

select plan(71);

insert into auth.users (id, email, raw_user_meta_data) values
  ('5e100000-0000-0000-0000-000000000001', 'early-hana@test.local', '{"full_name":"Hana"}'::jsonb),
  ('5e200000-0000-0000-0000-000000000002', 'early-sam@test.local', '{"full_name":"Sam"}'::jsonb),
  ('5e300000-0000-0000-0000-000000000003', 'early-cal@test.local', '{"full_name":"Cal"}'::jsonb);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function pg_temp.hana() returns uuid language sql immutable as
  $$ select '5e100000-0000-0000-0000-000000000001'::uuid $$;
create function pg_temp.sam() returns uuid language sql immutable as
  $$ select '5e200000-0000-0000-0000-000000000002'::uuid $$;

-- Act as a user (auth.uid() reads request.jwt.claims).
create function pg_temp.act(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

-- An item row / a claimable discount row (applies_to subtotal) for create_bill.
create function pg_temp.it(p_pos integer, p_name text, p_cents integer) returns jsonb
language sql immutable as $$
  select jsonb_build_object('name', p_name, 'note', null, 'group_position', p_pos,
    'unit_index', 0, 'group_size', 1, 'total_cents', p_cents);
$$;
create function pg_temp.dc(p_pos integer, p_name text, p_cents integer) returns jsonb
language sql immutable as $$
  select jsonb_build_object('name', p_name, 'group_position', p_pos, 'unit_index', 0,
    'group_size', 1, 'total_cents', p_cents, 'kind', 'discount', 'applies_to', 'subtotal');
$$;

create function pg_temp.bid(p_tag text) returns uuid language sql stable as
  $$ select current_setting('test.' || p_tag)::uuid $$;
create function pg_temp.li(p_tag text, p_name text) returns uuid language sql stable as $$
  select li.id from public.line_items as li
  where li.bill_id = pg_temp.bid(p_tag) and li.name = p_name;
$$;

-- Hana creates the bill (no subtotal, tax p_tax, total p_total); Sam joins.
create function pg_temp.mk(p_tag text, p_rows jsonb, p_tax integer, p_total integer)
returns void language plpgsql as $$
declare r record;
begin
  perform pg_temp.act(pg_temp.hana());
  select * into r from public.create_bill(p_rows, null, p_tax, 0, 0, 0, 0, p_total);
  perform set_config('test.' || p_tag, r.bill_id::text, true);
  perform pg_temp.act(pg_temp.sam());
  perform public.join_bill(r.join_code);
end $$;

create function pg_temp.claim(p_user uuid, p_tag text, p_name text) returns void
language plpgsql as $$
begin
  perform pg_temp.act(p_user);
  perform public.set_claim(pg_temp.li(p_tag, p_name), true);
end $$;

-- Accepted: the user's row holds exactly p_cents, and the bill has exactly one marked_paid event,
-- by the user, with details {payer_id: Hana, cents: p_cents}.
create function pg_temp.marked(p_tag text, p_user uuid, p_cents integer) returns boolean
language sql stable as $$
  select coalesce((select bp.settled_cents = p_cents and bp.settled_at is not null
                   from public.bill_participants as bp
                   where bp.bill_id = pg_temp.bid(p_tag) and bp.user_id = p_user), false)
     and (select count(*) = 1 from public.bill_events as e
          where e.bill_id = pg_temp.bid(p_tag) and e.kind = 'marked_paid')
     and (select count(*) = 1 from public.bill_events as e
          where e.bill_id = pg_temp.bid(p_tag) and e.kind = 'marked_paid'
            and e.actor_id = p_user
            and e.details = jsonb_build_object('payer_id', pg_temp.hana(), 'cents', p_cents));
$$;

-- Refused: nobody on the bill is marked and the bill has no marked_paid event.
create function pg_temp.unmarked(p_tag text) returns boolean language sql stable as $$
  select not exists (select 1 from public.bill_participants as bp
                     where bp.bill_id = pg_temp.bid(p_tag) and bp.settled_at is not null)
     and not exists (select 1 from public.bill_events as e
                     where e.bill_id = pg_temp.bid(p_tag) and e.kind = 'marked_paid');
$$;


-- ---------------------------------------------------------------------------
-- Fixtures (as authenticated, through the real functions)
-- ---------------------------------------------------------------------------
set local role authenticated;
do $$
declare
  v_e1_rows jsonb := jsonb_build_array(pg_temp.it(0, 'Burger', 1000), pg_temp.it(1, 'Salad', 800),
                                       pg_temp.it(2, 'Fries', 600));
begin
  -- E1: proportional, 3 rows, Sam claimed Salad, Fries unclaimed.
  perform pg_temp.mk('e1', v_e1_rows, 0, 2400);
  perform pg_temp.claim(pg_temp.hana(), 'e1', 'Burger');
  perform pg_temp.claim(pg_temp.sam(), 'e1', 'Salad');

  -- E2: incomplete, Sam claimed nothing.
  perform pg_temp.mk('e2', v_e1_rows, 0, 2400);
  perform pg_temp.claim(pg_temp.hana(), 'e2', 'Burger');

  -- E3: incomplete, Sam claimed only the discount row.
  perform pg_temp.mk('e3', jsonb_build_array(pg_temp.it(0, 'Burger', 1000),
    pg_temp.it(1, 'Salad', 800), pg_temp.dc(2, 'Comp', -200)), 0, 1600);
  perform pg_temp.claim(pg_temp.hana(), 'e3', 'Burger');
  perform pg_temp.claim(pg_temp.sam(), 'e3', 'Comp');

  -- E4: incomplete, Sam claimed only a $0.00 item.
  perform pg_temp.mk('e4', jsonb_build_array(pg_temp.it(0, 'Burger', 1000),
    pg_temp.it(1, 'Water', 0), pg_temp.it(2, 'Salad', 800)), 0, 1800);
  perform pg_temp.claim(pg_temp.hana(), 'e4', 'Burger');
  perform pg_temp.claim(pg_temp.sam(), 'e4', 'Water');

  -- E5: even, incomplete, Sam claimed Salad.
  perform pg_temp.mk('e5', v_e1_rows, 0, 2400);
  perform pg_temp.act(pg_temp.hana());
  perform public.set_extras_split(pg_temp.bid('e5'), 'equal');
  perform pg_temp.claim(pg_temp.hana(), 'e5', 'Burger');
  perform pg_temp.claim(pg_temp.sam(), 'e5', 'Salad');

  -- E6: proportional, complete, Hana claimed every row, Sam nothing.
  perform pg_temp.mk('e6', jsonb_build_array(pg_temp.it(0, 'Burger', 1000),
    pg_temp.it(1, 'Salad', 800)), 0, 1800);
  perform pg_temp.claim(pg_temp.hana(), 'e6', 'Burger');
  perform pg_temp.claim(pg_temp.hana(), 'e6', 'Salad');

  -- E7: Sam's only claim is 1 part of Fries (Hana 2 parts); Salad unclaimed.
  perform pg_temp.mk('e7', jsonb_build_array(pg_temp.it(0, 'Burger', 1000),
    pg_temp.it(1, 'Fries', 600), pg_temp.it(2, 'Salad', 800)), 0, 2400);
  perform pg_temp.claim(pg_temp.hana(), 'e7', 'Burger');
  perform pg_temp.claim(pg_temp.hana(), 'e7', 'Fries');
  perform pg_temp.claim(pg_temp.sam(), 'e7', 'Fries');
  perform pg_temp.act(pg_temp.hana());
  perform public.set_item_split(pg_temp.li('e7', 'Fries'),
    jsonb_build_object(pg_temp.hana()::text, 2, pg_temp.sam()::text, 1));

  -- E8: every row $0.00 and claimed, tax 500, total 500 (K6).
  perform pg_temp.mk('e8', jsonb_build_array(pg_temp.it(0, 'Bread', 0),
    pg_temp.it(1, 'Water', 0)), 500, 500);
  perform pg_temp.claim(pg_temp.hana(), 'e8', 'Bread');
  perform pg_temp.claim(pg_temp.sam(), 'e8', 'Water');

  -- E9: every item $0.00, incomplete (Soup unclaimed), total 500.
  perform pg_temp.mk('e9', jsonb_build_array(pg_temp.it(0, 'Bread', 0),
    pg_temp.it(1, 'Water', 0), pg_temp.it(2, 'Soup', 0)), 500, 500);
  perform pg_temp.claim(pg_temp.hana(), 'e9', 'Bread');
  perform pg_temp.claim(pg_temp.sam(), 'e9', 'Water');

  -- E10: every item $0.00, total 0, no discounts, incomplete (Bread unclaimed).
  perform pg_temp.mk('e10', jsonb_build_array(pg_temp.it(0, 'Bread', 0),
    pg_temp.it(1, 'Water', 0)), 0, 0);
  perform pg_temp.claim(pg_temp.sam(), 'e10', 'Water');

  -- E11: even, complete (K1).
  perform pg_temp.mk('e11', jsonb_build_array(pg_temp.it(0, 'Tea', 300),
    pg_temp.it(1, 'Cake', 400)), 0, 700);
  perform pg_temp.act(pg_temp.hana());
  perform public.set_extras_split(pg_temp.bid('e11'), 'equal');
  perform pg_temp.claim(pg_temp.hana(), 'e11', 'Tea');
  perform pg_temp.claim(pg_temp.sam(), 'e11', 'Cake');

  -- E12: even, every item $0.00, complete, total 500.
  perform pg_temp.mk('e12', jsonb_build_array(pg_temp.it(0, 'Bread', 0),
    pg_temp.it(1, 'Water', 0)), 500, 500);
  perform pg_temp.act(pg_temp.hana());
  perform public.set_extras_split(pg_temp.bid('e12'), 'equal');
  perform pg_temp.claim(pg_temp.hana(), 'e12', 'Bread');
  perform pg_temp.claim(pg_temp.sam(), 'e12', 'Water');

  -- E13: E1, Sam marks 900 early, then Hana switches to even.
  perform pg_temp.mk('e13', v_e1_rows, 0, 2400);
  perform pg_temp.claim(pg_temp.hana(), 'e13', 'Burger');
  perform pg_temp.claim(pg_temp.sam(), 'e13', 'Salad');
  perform pg_temp.act(pg_temp.sam());
  perform public.mark_paid(pg_temp.bid('e13'), pg_temp.hana(), 900);
  perform pg_temp.act(pg_temp.hana());
  perform public.set_extras_split(pg_temp.bid('e13'), 'equal');

  -- E15: Steak 1000 + claimable comp -1000 (unclaimed), total 0; Sam claimed Steak.
  perform pg_temp.mk('e15', jsonb_build_array(pg_temp.it(0, 'Steak', 1000),
    pg_temp.dc(1, 'Comp', -1000)), 0, 0);
  perform pg_temp.claim(pg_temp.sam(), 'e15', 'Steak');

  -- E16: every item claimed, only the claimable discount unclaimed; Sam has an item claim.
  perform pg_temp.mk('e16', jsonb_build_array(pg_temp.it(0, 'Burger', 1000),
    pg_temp.it(1, 'Fries', 500), pg_temp.dc(2, 'Comp', -200)), 100, 1400);
  perform pg_temp.claim(pg_temp.hana(), 'e16', 'Burger');
  perform pg_temp.claim(pg_temp.sam(), 'e16', 'Fries');

  -- E17: complete, every item $0.00, total 0, no discounts.
  perform pg_temp.mk('e17', jsonb_build_array(pg_temp.it(0, 'Bread', 0),
    pg_temp.it(1, 'Water', 0)), 0, 0);
  perform pg_temp.claim(pg_temp.hana(), 'e17', 'Bread');
  perform pg_temp.claim(pg_temp.sam(), 'e17', 'Water');

  -- E18: every item $0.00, one claimable discount of -1 (unclaimed), total 0; extras = +1.
  perform pg_temp.mk('e18', jsonb_build_array(pg_temp.it(0, 'Bread', 0),
    pg_temp.it(1, 'Water', 0), pg_temp.dc(2, 'Comp', -1)), 0, 0);
  perform pg_temp.claim(pg_temp.hana(), 'e18', 'Bread');
  perform pg_temp.claim(pg_temp.sam(), 'e18', 'Water');

  -- E19: items 600 + 400, total 999 (extras -1); Fries unclaimed; Sam claimed Burger.
  perform pg_temp.mk('e19', jsonb_build_array(pg_temp.it(0, 'Burger', 600),
    pg_temp.it(1, 'Fries', 400)), 0, 999);
  perform pg_temp.claim(pg_temp.sam(), 'e19', 'Burger');

  -- E20: E1, then Hana deletes Salad (Sam's only item row) with update_bill.
  perform pg_temp.mk('e20', v_e1_rows, 0, 2400);
  perform pg_temp.claim(pg_temp.hana(), 'e20', 'Burger');
  perform pg_temp.claim(pg_temp.sam(), 'e20', 'Salad');
  perform pg_temp.act(pg_temp.hana());
  perform public.update_bill(pg_temp.bid('e20'), jsonb_build_array(
      pg_temp.it(0, 'Burger', 1000) || jsonb_build_object('id', pg_temp.li('e20', 'Burger')),
      pg_temp.it(1, 'Fries', 600) || jsonb_build_object('id', pg_temp.li('e20', 'Fries'))),
    null, 0, 0, 0, 0, 0, 1600);
end $$;
reset role;

-- Sam's E13 mark before the switch (criterion 2 compares against it).
select set_config('test.e13_at', (select bp.settled_at::text from public.bill_participants as bp
  where bp.bill_id = pg_temp.bid('e13') and bp.user_id = pg_temp.sam()), true);

-- ---------------------------------------------------------------------------
-- Criterion 1: settle_state for E1-E20 (as postgres)
-- ---------------------------------------------------------------------------
select is(private.settle_state(pg_temp.bid('e1'), pg_temp.sam()), 'early',
  '[E1] proportional, Sam claimed 1 of 3 rows, 1 unclaimed: settle_state early');
select is(private.settle_state(pg_temp.bid('e2'), pg_temp.sam()), 'not_complete',
  '[E2] proportional, incomplete, Sam claimed nothing: not_complete');
select is(private.settle_state(pg_temp.bid('e3'), pg_temp.sam()), 'not_complete',
  '[E3] incomplete, Sam claimed only a discount row: not_complete');
select is(private.settle_state(pg_temp.bid('e4'), pg_temp.sam()), 'early',
  '[E4] incomplete, Sam claimed only a $0.00 item: early');
select is(private.settle_state(pg_temp.bid('e5'), pg_temp.sam()), 'not_complete',
  '[E5] even, incomplete, Sam claimed an item: not_complete');
select is(private.settle_state(pg_temp.bid('e6'), pg_temp.sam()), 'final',
  '[E6] proportional, complete, Sam claimed nothing: final');
select is(private.settle_state(pg_temp.bid('e7'), pg_temp.sam()), 'early',
  '[E7] Sam''s only claim is 1 part of a shared row: early');
select is(private.settle_state(pg_temp.bid('e8'), pg_temp.sam()), 'all_zero',
  '[E8] every row $0.00 and claimed, total 500 (K6): all_zero');
select is(private.settle_state(pg_temp.bid('e9'), pg_temp.sam()), 'all_zero',
  '[E9] every item $0.00, incomplete, total 500: all_zero');
select is(private.settle_state(pg_temp.bid('e10'), pg_temp.sam()), 'early',
  '[E10] every item $0.00, total 0, incomplete: early (extras 0)');
select is(private.settle_state(pg_temp.bid('e11'), pg_temp.sam()), 'final',
  '[E11] even, complete: final');
select is(private.settle_state(pg_temp.bid('e12'), pg_temp.sam()), 'final',
  '[E12] even, every item $0.00, complete, total 500: final (Z is proportional only)');
select is(private.settle_state(pg_temp.bid('e13'), pg_temp.sam()), 'not_complete',
  '[E13] E1 switched to even: not_complete');
select is(private.settle_state(pg_temp.bid('e1'), pg_temp.hana()), 'early',
  '[E14] E1 for Hana (the payer, who claimed Burger): early');
select is(private.settle_state(pg_temp.bid('e15'), pg_temp.sam()), 'early',
  '[E15] items 1000 + unclaimed discount -1000, total 0: early (itemSum 1000)');
select is(private.settle_state(pg_temp.bid('e16'), pg_temp.sam()), 'early',
  '[E16] only a claimable discount unclaimed: early');
select is(private.settle_state(pg_temp.bid('e17'), pg_temp.sam()), 'final',
  '[E17] complete, every item $0.00, total 0: final');
select is(private.settle_state(pg_temp.bid('e18'), pg_temp.sam()), 'all_zero',
  '[E18] $0.00 items, unclaimed discount -1, total 0 (extras +1 from the discount): all_zero');
select is(private.settle_state(pg_temp.bid('e19'), pg_temp.sam()), 'early',
  '[E19] items 600 + 400, total 999 (extras -1), incomplete: early');
select is(private.settle_state(pg_temp.bid('e20'), pg_temp.sam()), 'not_complete',
  '[E20] Sam''s only item row deleted by update_bill: not_complete');

-- ---------------------------------------------------------------------------
-- Criterion 1: mark_paid as Sam (or Hana for E14)
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act(pg_temp.sam());
select lives_ok($$ select public.mark_paid(pg_temp.bid('e1'), pg_temp.hana(), 900) $$,
  '[E1] mark_paid 900 is accepted');
select throws_ok($$ select public.mark_paid(pg_temp.bid('e2'), pg_temp.hana(), 900) $$,
  '22023', 'not_complete', '[E2] mark_paid raises 22023 not_complete');
select throws_ok($$ select public.mark_paid(pg_temp.bid('e3'), pg_temp.hana(), 900) $$,
  '22023', 'not_complete', '[E3] mark_paid raises 22023 not_complete');
select lives_ok($$ select public.mark_paid(pg_temp.bid('e4'), pg_temp.hana(), 1) $$,
  '[E4] mark_paid 1 is accepted (the UI hides the button; the DB allows it, PI-M-1)');
select throws_ok($$ select public.mark_paid(pg_temp.bid('e5'), pg_temp.hana(), 900) $$,
  '22023', 'not_complete', '[E5] mark_paid raises 22023 not_complete');
select lives_ok($$ select public.mark_paid(pg_temp.bid('e6'), pg_temp.hana(), 500) $$,
  '[E6] mark_paid 500 is accepted (PI-M-1, unchanged)');
select lives_ok($$ select public.mark_paid(pg_temp.bid('e7'), pg_temp.hana(), 200) $$,
  '[E7] mark_paid 200 is accepted');
select throws_ok($$ select public.mark_paid(pg_temp.bid('e8'), pg_temp.hana(), 1) $$,
  '22023', 'all_zero', '[E8] mark_paid raises 22023 all_zero (was accepted; K6 closed)');
select throws_ok($$ select public.mark_paid(pg_temp.bid('e9'), pg_temp.hana(), 1) $$,
  '22023', 'all_zero', '[E9] mark_paid raises 22023 all_zero, not not_complete');
select lives_ok($$ select public.mark_paid(pg_temp.bid('e10'), pg_temp.hana(), 1) $$,
  '[E10] mark_paid 1 is accepted');
select lives_ok($$ select public.mark_paid(pg_temp.bid('e11'), pg_temp.hana(), 400) $$,
  '[E11] mark_paid 400 is accepted');
select lives_ok($$ select public.mark_paid(pg_temp.bid('e12'), pg_temp.hana(), 250) $$,
  '[E12] mark_paid 250 is accepted');
select throws_ok($$ select public.mark_paid(pg_temp.bid('e13'), pg_temp.hana(), 950) $$,
  '22023', 'not_complete', '[E13] a second mark_paid after the switch raises 22023 not_complete');
select lives_ok($$ select public.mark_paid(pg_temp.bid('e15'), pg_temp.hana(), 1) $$,
  '[E15] mark_paid 1 is accepted');
select lives_ok($$ select public.mark_paid(pg_temp.bid('e16'), pg_temp.hana(), 600) $$,
  '[E16] mark_paid 600 is accepted');
select lives_ok($$ select public.mark_paid(pg_temp.bid('e17'), pg_temp.hana(), 1) $$,
  '[E17] mark_paid 1 is accepted (UI hides the button: share $0)');
select throws_ok($$ select public.mark_paid(pg_temp.bid('e18'), pg_temp.hana(), 1) $$,
  '22023', 'all_zero', '[E18] mark_paid raises 22023 all_zero');
select lives_ok($$ select public.mark_paid(pg_temp.bid('e19'), pg_temp.hana(), 600) $$,
  '[E19] mark_paid 600 is accepted');
select throws_ok($$ select public.mark_paid(pg_temp.bid('e20'), pg_temp.hana(), 900) $$,
  '22023', 'not_complete', '[E20] mark_paid raises 22023 not_complete');
select pg_temp.act(pg_temp.hana());
select throws_ok($$ select public.mark_paid(pg_temp.bid('e1'), pg_temp.hana(), 900) $$,
  '22023', 'is_payer', '[E14] Hana (the payer) gets 22023 is_payer (checked before rule E)');

-- Criterion 3: check order.
select throws_ok($$ select public.mark_paid(pg_temp.bid('e2'), pg_temp.hana(), 0) $$,
  '22023', 'invalid_amount', 'c3: the payer sending p_cents 0 gets invalid_amount, not is_payer');
select pg_temp.act('5e300000-0000-0000-0000-000000000003');
select throws_ok($$ select public.mark_paid(pg_temp.bid('e1'), pg_temp.hana(), 0) $$,
  '42501', 'not_allowed', 'c3: a non-participant gets 42501 before any amount check');
reset role;

-- ---------------------------------------------------------------------------
-- Criterion 1: what each call stored (accepted: exact cents + one event; refused: nothing)
-- ---------------------------------------------------------------------------
select ok(pg_temp.marked('e1', pg_temp.sam(), 900),
  '[E1] Sam''s row holds 900 and one marked_paid {payer_id Hana, cents 900} by Sam');
select ok(pg_temp.unmarked('e2'), '[E2] no mark and no event');
select ok(pg_temp.unmarked('e3'), '[E3] no mark and no event');
select ok(pg_temp.marked('e4', pg_temp.sam(), 1), '[E4] Sam''s row holds 1 and one event');
select ok(pg_temp.unmarked('e5'), '[E5] no mark and no event');
select ok(pg_temp.marked('e6', pg_temp.sam(), 500), '[E6] Sam''s row holds 500 and one event');
select ok(pg_temp.marked('e7', pg_temp.sam(), 200), '[E7] Sam''s row holds 200 and one event');
select ok(pg_temp.unmarked('e8'), '[E8] no mark and no event');
select ok(pg_temp.unmarked('e9'), '[E9] no mark and no event');
select ok(pg_temp.marked('e10', pg_temp.sam(), 1), '[E10] Sam''s row holds 1 and one event');
select ok(pg_temp.marked('e11', pg_temp.sam(), 400), '[E11] Sam''s row holds 400 and one event');
select ok(pg_temp.marked('e12', pg_temp.sam(), 250), '[E12] Sam''s row holds 250 and one event');
-- Criterion 2: the early mark survives the switch to even, unchanged.
select ok(
  pg_temp.marked('e13', pg_temp.sam(), 900)
  and (select bp.settled_at = current_setting('test.e13_at')::timestamptz
       from public.bill_participants as bp
       where bp.bill_id = pg_temp.bid('e13') and bp.user_id = pg_temp.sam()),
  '[E13] Sam''s earlier mark is kept (900, same settled_at) and the refused call logged nothing');
select ok(
  not exists (select 1 from public.bill_participants as bp
              where bp.bill_id = pg_temp.bid('e1') and bp.user_id = pg_temp.hana()
                and bp.settled_at is not null)
  and not exists (select 1 from public.bill_events as e
                  where e.bill_id = pg_temp.bid('e1') and e.kind = 'marked_paid'
                    and e.actor_id = pg_temp.hana()),
  '[E14] Hana has no mark and no marked_paid event');
select ok(pg_temp.marked('e15', pg_temp.sam(), 1), '[E15] Sam''s row holds 1 and one event');
select ok(pg_temp.marked('e16', pg_temp.sam(), 600), '[E16] Sam''s row holds 600 and one event');
select ok(pg_temp.marked('e17', pg_temp.sam(), 1), '[E17] Sam''s row holds 1 and one event');
select ok(pg_temp.unmarked('e18'), '[E18] no mark and no event');
select ok(pg_temp.marked('e19', pg_temp.sam(), 600), '[E19] Sam''s row holds 600 and one event');
select ok(pg_temp.unmarked('e20'), '[E20] no mark and no event');

-- ---------------------------------------------------------------------------
-- Rule Z: bill_all_zero agrees with settle_state's all_zero branch
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select t, private.bill_all_zero(pg_temp.bid(t))
     from unnest(array['e1', 'e8', 'e9', 'e10', 'e12', 'e17', 'e18', 'e19']) with ordinality as u(t, n)
     order by n $$,
  $$ values ('e1', false), ('e8', true), ('e9', true), ('e10', false), ('e12', false),
            ('e17', false), ('e18', true), ('e19', false) $$,
  'rule Z: bill_all_zero is true exactly on the all_zero rows (E8, E9, E18)');
select ok(
  private.settle_state('00000000-0000-0000-0000-00000000dead', pg_temp.sam()) is null
  and private.bill_all_zero('00000000-0000-0000-0000-00000000dead') = false,
  'an unknown bill: settle_state is null and bill_all_zero is false');

-- ---------------------------------------------------------------------------
-- Criterion 4: privileges
-- ---------------------------------------------------------------------------
select ok(
  not has_function_privilege('public', 'private.settle_state(uuid,uuid)', 'execute')
  and not has_function_privilege('anon', 'private.settle_state(uuid,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.settle_state(uuid,uuid)', 'execute')
  and not has_function_privilege('public', 'private.bill_all_zero(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.bill_all_zero(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.bill_all_zero(uuid)', 'execute'),
  'c4: settle_state and bill_all_zero are not executable by public, anon or authenticated');
set local role authenticated;
select pg_temp.act(pg_temp.sam());
select throws_ok($$ select private.settle_state(pg_temp.bid('e1'), pg_temp.sam()) $$,
  '42501', null, 'c4: authenticated calling settle_state gets 42501');
select throws_ok($$ select private.bill_all_zero(pg_temp.bid('e1')) $$,
  '42501', null, 'c4: authenticated calling bill_all_zero gets 42501');
reset role;
select ok(
  (select prosecdef and proconfig = array['search_path=""'] from pg_proc
   where oid = 'public.mark_paid(uuid,uuid,integer)'::regprocedure),
  'c4: mark_paid is still security definer with an empty search_path');
select ok(
  has_function_privilege('authenticated', 'public.mark_paid(uuid,uuid,integer)', 'execute')
  and not has_function_privilege('anon', 'public.mark_paid(uuid,uuid,integer)', 'execute')
  and not has_function_privilege('public', 'public.mark_paid(uuid,uuid,integer)', 'execute'),
  'c4: mark_paid is executable by authenticated only');

-- ---------------------------------------------------------------------------
-- Criterion 6: lock order, checked statically (pgTAP can't run two sessions)
-- ---------------------------------------------------------------------------
select ok(
  (select position('public.bill_participants' in p.prosrc) > 0
          and position('public.bill_participants' in p.prosrc) < position('for share' in p.prosrc)
          and position('for share' in p.prosrc) < position('private.settle_state' in p.prosrc)
          and position('private.settle_state' in p.prosrc) < position('update public.bill_participants' in p.prosrc)
   from pg_proc as p where p.oid = 'public.mark_paid(uuid,uuid,integer)'::regprocedure),
  'c6: mark_paid reads participation before FOR SHARE on bills, then settle_state, then the update');
select ok(
  (select position('for update' in p.prosrc) = 0
          and (length(p.prosrc) - length(replace(p.prosrc, 'private.settle_state', '')))
              / length('private.settle_state') = 1
   from pg_proc as p where p.oid = 'public.mark_paid(uuid,uuid,integer)'::regprocedure),
  'c6: mark_paid takes no explicit FOR UPDATE and calls settle_state exactly once');

select * from finish();
rollback;
