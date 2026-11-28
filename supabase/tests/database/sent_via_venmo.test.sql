-- pgTAP tests for sent via Venmo, Task 2 (spec docs/specs/2026-11-26-sent-via-venmo.md, Amendment
-- A1; D1, D4, D8; criteria 1-21, 49-50): migration 20261126080844_sent_via_venmo.sql.
--
-- Each case M1-M18 / N1-N16 is tagged [M#] / [N#] at the start of its assertion descriptions (the
-- drift test matches these). Other criteria are tagged c17-c20.
--
-- Every assertion filters to the fixture bills/users below (the local DB may hold real data).
-- "Nothing changed" checks backdate settled_at first: now() is fixed for the whole test
-- transaction, so a rewrite to now() would otherwise compare equal.
--
-- Users: Dee 5f4... (host of every bill, not the payer), Hana 5f1... (the payer, set by Dee's
--        set_payer), Sam 5f2... (the person whose mark changes), Cal 5f3... (outsider),
--        Pia 5f5... (payer of bill n15b only; her account is deleted there).
-- Standard bill: Burger 1500 (Hana), Salad 1000 (Sam), Fries 600 (Sam and Dee), tax 500,
--        total 3600, proportional, complete. pg_temp.mk(tag, cents, method) has Sam mark when
--        cents isn't null.
--   m1 m2 m3   M1-M3 (Sam unmarked; marks venmo / cash / other in the test)
--   m4         M4-M8 (Sam unmarked)           m13  M13 (Sam marked 1510 venmo, backdated)
--   m14        M14 (Sam unmarked, flag set as owner)
--   m10 m11    M10, M11 (venmo / cash mark)   m12a m12b  M12 (venmo / cash mark, pay-backs)
--   m17        M17 (Sam unmarked; the racing unmark is simulated with a skip trigger)
--   n1 n2      N1, N2, N5, N11, N13 (venmo / cash mark)
--   n3         N3 (venmo mark, backdated)     n4   N4 (ABA: mark backdated, cleared, re-made)
--   n6         N6-N10 refusals (venmo mark, backdated)
--   n9         N9 former payer (Dee moved the payer from Hana to Dee)
--   n15a       N15 set_payer clears marks and flags      n15b  N15 reset trigger (payer Pia)
--   u          c20 unmark_paid nulls settled_method      sn    c17 my_bills.seen_at

begin;

create extension if not exists pgtap with schema extensions;

select plan(102);

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
  ('5f100000-0000-0000-0000-000000000001', 'svv-hana@test.local', '{"full_name":"Hana"}'::jsonb),
  ('5f200000-0000-0000-0000-000000000002', 'svv-sam@test.local', '{"full_name":"Sam"}'::jsonb),
  ('5f300000-0000-0000-0000-000000000003', 'svv-cal@test.local', '{"full_name":"Cal"}'::jsonb),
  ('5f400000-0000-0000-0000-000000000004', 'svv-dee@test.local', '{"full_name":"Dee"}'::jsonb),
  ('5f500000-0000-0000-0000-000000000005', 'svv-pia@test.local', '{"full_name":"Pia"}'::jsonb);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function pg_temp.hana() returns uuid language sql immutable as
  $$ select '5f100000-0000-0000-0000-000000000001'::uuid $$;
create function pg_temp.sam() returns uuid language sql immutable as
  $$ select '5f200000-0000-0000-0000-000000000002'::uuid $$;
create function pg_temp.cal() returns uuid language sql immutable as
  $$ select '5f300000-0000-0000-0000-000000000003'::uuid $$;
create function pg_temp.dee() returns uuid language sql immutable as
  $$ select '5f400000-0000-0000-0000-000000000004'::uuid $$;
create function pg_temp.pia() returns uuid language sql immutable as
  $$ select '5f500000-0000-0000-0000-000000000005'::uuid $$;
create function pg_temp.old_at() returns timestamptz language sql immutable as
  $$ select timestamptz '2026-01-01 12:00:00+00' $$;

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

-- Dee creates the standard bill, Hana and Sam join, Dee makes p_payer the payer, everyone claims
-- (complete), and Sam marks p_cents with p_method when p_cents isn't null.
create function pg_temp.mk(p_tag text, p_cents integer, p_method text,
                           p_payer uuid default '5f100000-0000-0000-0000-000000000001')
returns void language plpgsql as $$
declare r record;
begin
  perform pg_temp.act(pg_temp.dee());
  select * into r from public.create_bill(jsonb_build_array(
      pg_temp.it(0, 'Burger', 1500), pg_temp.it(1, 'Salad', 1000), pg_temp.it(2, 'Fries', 600)),
    null, 500, 0, 0, 0, 0, 3600);
  perform set_config('test.' || p_tag, r.bill_id::text, true);
  perform pg_temp.act(p_payer);
  perform public.join_bill(r.join_code);
  perform pg_temp.act(pg_temp.sam());
  perform public.join_bill(r.join_code);
  perform pg_temp.act(pg_temp.dee());
  perform public.set_payer(r.bill_id, p_payer);
  perform pg_temp.claim(p_payer, p_tag, 'Burger');
  perform pg_temp.claim(pg_temp.sam(), p_tag, 'Salad');
  perform pg_temp.claim(pg_temp.sam(), p_tag, 'Fries');
  perform pg_temp.claim(pg_temp.dee(), p_tag, 'Fries');
  if p_cents is not null then
    perform pg_temp.act(pg_temp.sam());
    perform public.mark_paid(r.bill_id, p_payer, p_cents, p_method);
  end if;
end $$;

-- A user's whole transfer state on a bill, as one jsonb (compared before/after).
-- security definer (who paid 4a): it reads the owner-only pg_temp.bp_marks view, and some callers
-- run as authenticated.
create function pg_temp.row_of(p_tag text, p_user uuid) returns jsonb language sql stable
security definer as $$
  select jsonb_build_object('at', bp.settled_at, 'cents', bp.settled_cents,
    'method', bp.settled_method, 'nr_cents', bp.not_received_cents,
    'nr_method', bp.not_received_method, 'nr_by', bp.not_received_by)
  from pg_temp.bp_marks as bp
  where bp.bill_id = pg_temp.bid(p_tag) and bp.user_id = p_user;
$$;
create function pg_temp.sam_row(p_tag text) returns jsonb language sql stable as
  $$ select pg_temp.row_of(p_tag, pg_temp.sam()) $$;
-- Sam with no mark and no flag.
create function pg_temp.clean() returns jsonb language sql immutable as $$
  select jsonb_build_object('at', null, 'cents', null, 'method', null, 'nr_cents', null,
    'nr_method', null, 'nr_by', null);
$$;
create function pg_temp.n(p_tag text, p_kind text) returns integer language sql stable as $$
  select count(*)::integer from public.bill_events as e
  where e.bill_id = pg_temp.bid(p_tag) and e.kind = p_kind;
$$;
create function pg_temp.nall(p_tag text) returns integer language sql stable as $$
  select count(*)::integer from public.bill_events as e where e.bill_id = pg_temp.bid(p_tag);
$$;
-- Exactly one event of the kind on the bill, with this actor and exactly these details.
create function pg_temp.one(p_tag text, p_kind text, p_actor uuid, p_details jsonb)
returns boolean language sql stable as $$
  select pg_temp.n(p_tag, p_kind) = 1
     and exists (select 1 from public.bill_events as e
                 where e.bill_id = pg_temp.bid(p_tag) and e.kind = p_kind
                   and e.actor_id = p_actor and e.details = p_details);
$$;
create function pg_temp.msgs(p_tag text) returns integer language sql stable as $$
  select count(*)::integer from realtime.messages as m
  where m.topic = 'bill:' || pg_temp.bid(p_tag)::text;
$$;
-- Save Sam's row (after backdating) to compare against later.
create function pg_temp.save(p_tag text) returns void language sql as $$
  select set_config('test.' || p_tag || '_row', pg_temp.sam_row(p_tag)::text, true);
$$;
create function pg_temp.saved(p_tag text) returns jsonb language sql stable as
  $$ select current_setting('test.' || p_tag || '_row')::jsonb $$;

-- mark_paid's result rows, captured as authenticated.
create temp table mp (tag text, settled_at timestamptz, created boolean);
grant all on mp to authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures (as authenticated, through the real functions)
-- ---------------------------------------------------------------------------
set local role authenticated;
do $$
begin
  perform pg_temp.mk('m1', null, null);
  perform pg_temp.mk('m2', null, null);
  perform pg_temp.mk('m3', null, null);
  perform pg_temp.mk('m4', null, null);
  perform pg_temp.mk('m13', 1510, 'venmo');
  perform pg_temp.mk('m14', null, null);
  perform pg_temp.mk('m10', 1510, 'venmo');
  perform pg_temp.mk('m11', 1510, 'cash');
  perform pg_temp.mk('m12a', 1510, 'venmo');
  perform pg_temp.mk('m12b', 1510, 'cash');
  perform pg_temp.mk('m17', null, null);
  perform pg_temp.mk('n1', 1510, 'venmo');
  perform pg_temp.mk('n2', 1510, 'cash');
  perform pg_temp.mk('n3', 1510, 'venmo');
  perform pg_temp.mk('n4', 1510, 'venmo');
  perform pg_temp.mk('n6', 1510, 'venmo');
  perform pg_temp.mk('n9', 1510, 'venmo');
  perform pg_temp.mk('n15a', 1510, 'venmo');
  perform pg_temp.mk('n15b', 1510, 'venmo', pg_temp.pia());
  perform pg_temp.mk('u', 1510, 'venmo');
  perform pg_temp.mk('sn', null, null);
end $$;
reset role;

-- Backdate the marks that "nothing changed" checks compare, then save the baselines.
-- (Who paid 4a: the marks are Sam's bill_payments entries, whose rows can't be updated; the test
-- lifts that guard for the backdate only, as the owner.)
alter table public.bill_payments disable trigger bill_payments_no_update;
update public.bill_payments as e
   set recorded_at = pg_temp.old_at()
 where e.from_user = pg_temp.sam()
   and e.bill_id in (select pg_temp.bid(t) from unnest(array['m13', 'n1', 'n3', 'n4', 'n6']) as t);
alter table public.bill_payments enable trigger bill_payments_no_update;
select pg_temp.save(t) from unnest(array['m13', 'n3', 'n6']) as t;

-- ---------------------------------------------------------------------------
-- M1-M3: mark_paid with each method
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act(pg_temp.sam());
insert into pg_temp.mp select 'm1', r.* from public.mark_paid(pg_temp.bid('m1'), pg_temp.hana(), 1510, 'venmo') as r;
insert into pg_temp.mp select 'm2', r.* from public.mark_paid(pg_temp.bid('m2'), pg_temp.hana(), 1510, 'cash') as r;
insert into pg_temp.mp select 'm3', r.* from public.mark_paid(pg_temp.bid('m3'), pg_temp.hana(), 1510, 'other') as r;
reset role;

select ok(
  (select count(*) = 1 and bool_and(mp.created)
          and bool_and(mp.settled_at = (pg_temp.sam_row(t.tag) ->> 'at')::timestamptz)
   from pg_temp.mp where mp.tag = t.tag)
  and pg_temp.sam_row(t.tag) ->> 'method' = t.m
  and (pg_temp.sam_row(t.tag) ->> 'cents')::integer = 1510
  and pg_temp.one(t.tag, 'marked_paid', pg_temp.sam(),
        jsonb_build_object('payer_id', pg_temp.hana(), 'cents', 1510, 'method', t.m)),
  format('[%s] mark_paid with %s stores settled_method %s, returns one row (stored settled_at, created true) and logs one marked_paid {payer_id, cents 1510, method %s}',
         t.c, t.m, t.m, t.m))
from (values ('m1', 'venmo', 'M1'), ('m2', 'cash', 'M2'), ('m3', 'other', 'M3')) as t(tag, m, c);

-- ---------------------------------------------------------------------------
-- M4-M6: unknown methods; the check sits right after invalid_amount
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act(pg_temp.sam());
select throws_ok($$ select public.mark_paid(pg_temp.bid('m4'), pg_temp.hana(), 1510, 'zelle') $$,
  '22023', 'invalid_method', '[M4] p_method ''zelle'' gets 22023 invalid_method');
select throws_ok($$ select public.mark_paid(pg_temp.bid('m4'), pg_temp.hana(), 1510, null) $$,
  '22023', 'invalid_method', '[M5] p_method null gets 22023 invalid_method');
select throws_ok($$ select public.mark_paid(pg_temp.bid('m4'), pg_temp.hana(), 1510, 'Venmo') $$,
  '22023', 'invalid_method', '[M6] p_method ''Venmo'' (case differs) gets 22023 invalid_method');
select throws_ok($$ select public.mark_paid(pg_temp.bid('m4'), pg_temp.hana(), 0, 'zelle') $$,
  '22023', 'invalid_amount', '[M4] a bad amount and a bad method gets invalid_amount (amount first)');
select throws_ok($$ select public.mark_paid(pg_temp.bid('m4'), pg_temp.dee(), 1510, 'zelle') $$,
  '22023', 'invalid_method', '[M4] a stale payer and a bad method gets invalid_method (method before payer_changed)');
reset role;
select ok(pg_temp.sam_row('m4') = pg_temp.clean() and pg_temp.n('m4', 'marked_paid') = 0,
  '[M4] [M5] [M6] the refused calls stored nothing and logged nothing');

-- ---------------------------------------------------------------------------
-- M7: no client can write a payment or a flag (who paid 4a moved the columns to the ledger)
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act(pg_temp.sam());
select throws_ok(
  $$ update public.bill_payments set method = 'cash' where bill_id = pg_temp.bid('m1') and from_user = pg_temp.sam() $$,
  '42501', null, '[M7] a direct update of a payment''s method as Sam fails with 42501');
select throws_ok(
  $$ insert into public.bill_payment_flags (bill_id, from_user, to_user, cents, method)
     values (pg_temp.bid('m4'), pg_temp.sam(), pg_temp.hana(), 1, 'cash') $$,
  '42501', null, '[M7] a direct insert of a not-received flag fails with 42501');
select throws_ok(
  $$ update public.bill_payment_flags set method = 'cash' where bill_id = pg_temp.bid('m4') $$,
  '42501', null, '[M7] a direct update of a flag fails with 42501');
select throws_ok(
  $$ delete from public.bill_payments where bill_id = pg_temp.bid('m1') and from_user = pg_temp.sam() $$,
  '42501', null, '[M7] a direct delete of Sam''s payment fails with 42501');
reset role;

-- ---------------------------------------------------------------------------
-- M8: the ledger's checks, as the owner (positive control first: a complete flag is accepted)
-- ---------------------------------------------------------------------------
select lives_ok(
  $$ insert into public.bill_payment_flags (bill_id, from_user, to_user, cents, method)
     values (pg_temp.bid('m4'), pg_temp.dee(), pg_temp.hana(), 100, 'cash') $$,
  '[M8] positive control: a complete flag row is accepted');
select throws_ok(
  $$ insert into public.bill_payments (bill_id, from_user, to_user, cents, method, recorded_by)
     values (pg_temp.bid('m4'), pg_temp.sam(), pg_temp.hana(), 100, 'zelle', pg_temp.sam()) $$,
  '23514', null, '[M8] a payment with method ''zelle'' fails 23514');
select throws_ok(
  $$ insert into public.bill_payments (bill_id, from_user, to_user, cents, method, recorded_by)
     values (pg_temp.bid('m4'), pg_temp.sam(), pg_temp.hana(), 100, 'Venmo', pg_temp.sam()) $$,
  '23514', null, '[M8] a payment with method ''Venmo'' (case differs) fails 23514');
select throws_ok(
  $$ insert into public.bill_payment_flags (bill_id, from_user, to_user, cents, method)
     values (pg_temp.bid('m4'), pg_temp.sam(), pg_temp.hana(), 100, 'zelle') $$,
  '23514', null, '[M8] a flag with method ''zelle'' fails 23514');
select throws_ok(
  $$ insert into public.bill_payment_flags (bill_id, from_user, to_user, cents, method)
     values (pg_temp.bid('m4'), pg_temp.sam(), pg_temp.hana(), 0, 'cash') $$,
  '23514', null, '[M8] a flag with cents 0 fails 23514');
select throws_ok(
  $$ insert into public.bill_payment_flags (bill_id, from_user, to_user, cents, method)
     values (pg_temp.bid('m4'), pg_temp.sam(), pg_temp.hana(), 100000000, 'cash') $$,
  '23514', null, '[M8] a flag with cents 100000000 fails 23514');
select throws_ok(
  $$ insert into public.bill_payment_flags (bill_id, from_user, to_user, cents, method)
     values (pg_temp.bid('m4'), pg_temp.sam(), pg_temp.sam(), 100, 'cash') $$,
  '23514', null, '[M8] a flag from a person to themself fails 23514');

-- ---------------------------------------------------------------------------
-- M9: the backfill. Rows that existed before the migration can't be fixture rows (the test runs
-- after it), so this checks that the constraints were validated against every pre-existing row
-- (which needs every old mark to have a method) and that fixture rows obey the rule.
-- ---------------------------------------------------------------------------
select ok(
  (select bool_and(c.convalidated) and count(*) = 3 from pg_constraint as c
   where (c.conrelid = 'public.bill_payments'::regclass
          and c.conname in ('bill_payments_method_known', 'bill_payments_plan_key_format'))
      or (c.conrelid = 'public.bill_payment_flags'::regclass
          and c.conname = 'bill_payment_flags_method_known')),
  '[M9] the ledger''s method and plan-key constraints are validated (who paid 4a copied every mark into them)');
select ok(
  (select bool_and((bp.settled_at is null) = (bp.settled_method is null)) and count(*) > 0
   from pg_temp.bp_marks as bp
   where bp.bill_id in (select pg_temp.bid(t) from unnest(array['m1','m2','m3','m4','m13','n6']) as t)),
  '[M9] fixture rows: marked rows have a method, unmarked rows have none');

-- ---------------------------------------------------------------------------
-- M10-M12: settle_difference and the method
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act(pg_temp.sam());
select lives_ok($$ select public.settle_difference(pg_temp.bid('m10'), pg_temp.sam(), pg_temp.hana(), 1510, 1620, 'venmo') $$,
  '[M10] Sam pays 110 more via Venmo on a venmo mark');
select lives_ok($$ select public.settle_difference(pg_temp.bid('m11'), pg_temp.sam(), pg_temp.hana(), 1510, 1620, 'venmo') $$,
  '[M11] Sam pays 110 more via Venmo on a cash mark');
select throws_ok($$ select public.settle_difference(pg_temp.bid('m10'), pg_temp.sam(), pg_temp.hana(), 1620, 1700, 'zelle') $$,
  '22023', 'invalid_method', '[M10] settle_difference with ''zelle'' gets 22023 invalid_method');
select pg_temp.act(pg_temp.hana());
select throws_ok($$ select public.settle_difference(pg_temp.bid('m12a'), pg_temp.sam(), pg_temp.hana(), 1510, 1400, null) $$,
  '22023', 'invalid_method', '[M12] a pay-back still needs a known method (null gets invalid_method)');
select lives_ok($$ select public.settle_difference(pg_temp.bid('m12a'), pg_temp.sam(), pg_temp.hana(), 1510, 1400, 'cash') $$,
  '[M12] Hana pays 110 back, passing ''cash''');
select lives_ok($$ select public.settle_difference(pg_temp.bid('m12b'), pg_temp.sam(), pg_temp.hana(), 1510, 0, 'venmo') $$,
  '[M12] Hana pays back to 0');
reset role;
select ok(pg_temp.sam_row('m10') ->> 'method' = 'venmo' and (pg_temp.sam_row('m10') ->> 'cents')::int = 1620
          and pg_temp.one('m10', 'paid_difference', pg_temp.sam(),
                jsonb_build_object('payer_id', pg_temp.hana(), 'from', 1510, 'to', 1620, 'method', 'venmo')),
  '[M10] venmo + more via venmo keeps venmo; one paid_difference {payer_id, from, to, method venmo}');
select ok(pg_temp.sam_row('m11') ->> 'method' = 'other'
          and pg_temp.one('m11', 'paid_difference', pg_temp.sam(),
                jsonb_build_object('payer_id', pg_temp.hana(), 'from', 1510, 'to', 1620, 'method', 'venmo')),
  '[M11] cash + more via venmo becomes other; the event carries this payment''s method (venmo)');
select ok(pg_temp.sam_row('m12a') ->> 'method' = 'venmo' and (pg_temp.sam_row('m12a') ->> 'cents')::int = 1400
          and pg_temp.one('m12a', 'paid_back', pg_temp.hana(),
                jsonb_build_object('user_id', pg_temp.sam(), 'payer_id', pg_temp.hana(),
                                   'from', 1510, 'to', 1400, 'method', 'venmo')),
  '[M12] a pay-back passing cash leaves venmo; paid_back {user_id, payer_id, from, to, method: the mark''s venmo}');
select ok(pg_temp.sam_row('m12b') = pg_temp.clean()
          and pg_temp.one('m12b', 'paid_back', pg_temp.hana(),
                jsonb_build_object('user_id', pg_temp.sam(), 'payer_id', pg_temp.hana(),
                                   'from', 1510, 'to', 0, 'method', 'cash')),
  '[M12] a pay-back to 0 clears the mark and its method; paid_back carries the cleared mark''s cash');

-- ---------------------------------------------------------------------------
-- M13: mark_paid on an existing mark (backdated) with another method
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act(pg_temp.sam());
insert into pg_temp.mp select 'm13', r.* from public.mark_paid(pg_temp.bid('m13'), pg_temp.hana(), 1600, 'cash') as r;
reset role;
select ok(
  (select count(*) = 1 and bool_and(not mp.created) and bool_and(mp.settled_at = pg_temp.old_at())
   from pg_temp.mp where mp.tag = 'm13')
  and pg_temp.sam_row('m13') = pg_temp.saved('m13')
  and pg_temp.n('m13', 'marked_paid') = 1,
  '[M13] already marked: returns (the existing backdated settled_at, false), row unchanged (venmo, 1510), no new event');

-- ---------------------------------------------------------------------------
-- M14: mark_paid nulls a not-received flag in the same call
-- ---------------------------------------------------------------------------
insert into public.bill_payment_flags (bill_id, from_user, to_user, cents, method)
values (pg_temp.bid('m14'), pg_temp.sam(), pg_temp.hana(), 900, 'venmo');
select ok((pg_temp.sam_row('m14') ->> 'nr_cents')::int = 900,
  '[M14] positive control: Sam carries a flag before marking');
set local role authenticated;
select pg_temp.act(pg_temp.sam());
select lives_ok($$ select public.mark_paid(pg_temp.bid('m14'), pg_temp.hana(), 1510, 'cash') $$,
  '[M14] Sam marks paid in cash');
reset role;
select ok(pg_temp.sam_row('m14') ->> 'method' = 'cash'
          and pg_temp.sam_row('m14') ->> 'nr_cents' is null
          and pg_temp.sam_row('m14') ->> 'nr_method' is null
          and pg_temp.sam_row('m14') ->> 'nr_by' is null,
  '[M14] the mark is stored and all three not_received_* are null');

-- ---------------------------------------------------------------------------
-- M15: private.is_payment_method is the only list
-- ---------------------------------------------------------------------------
select ok(
  (select bool_and(pg_get_constraintdef(c.oid) like '%private.is_payment_method%'
                   and pg_get_constraintdef(c.oid) not like '%''cash''%') and count(*) = 2
   from pg_constraint as c
   where (c.conrelid = 'public.bill_payments'::regclass and c.conname = 'bill_payments_method_known')
      or (c.conrelid = 'public.bill_payment_flags'::regclass and c.conname = 'bill_payment_flags_method_known')),
  '[M15] both method checks (payments, flags) call private.is_payment_method and don''t spell the list');
select ok(
  (select bool_and(pg_get_functiondef(p.oid) like '%private.is_payment_method%'
                   and pg_get_functiondef(p.oid) not like '%''cash''%') and count(*) = 2
   from pg_proc as p
   where p.oid in ('public.mark_paid(uuid,uuid,integer,text,text)'::regprocedure,
                   'public.settle_difference(uuid,uuid,uuid,integer,integer,text,text)'::regprocedure)),
  '[M15] mark_paid and settle_difference call private.is_payment_method and don''t spell the list');
select ok(
  pg_get_functiondef('private.is_payment_method(text)'::regprocedure) like '%''cash''%'
  and private.is_payment_method('venmo') and private.is_payment_method('cash')
  and private.is_payment_method('other') and not private.is_payment_method('zelle')
  and private.is_payment_method(null) is null,
  '[M15] positive control: the list lives in private.is_payment_method (venmo, cash, other; not zelle; null -> null)');

-- ---------------------------------------------------------------------------
-- M16-M18: the returns table shape, the racing-unmark no-op, the reload notify
-- ---------------------------------------------------------------------------
select ok(
  (select p.proretset
          and pg_get_function_result(p.oid) = 'TABLE(settled_at timestamp with time zone, created boolean)'
   from pg_proc as p where p.oid = 'public.mark_paid(uuid,uuid,integer,text,text)'::regprocedure),
  '[M16] mark_paid returns table (settled_at timestamptz, created boolean), exactly');

-- M17 (who paid 4a): the racing-unmark window is gone. mark_paid now locks the caller's participant
-- row (FOR NO KEY UPDATE, which unmark_paid also takes) before reading the pair's state, then
-- inserts, so "no write but no mark either" can't happen. Checked statically, plus a fresh mark
-- returning (its recorded_at, true).
select ok(
  (select position('for no key update' in p.prosrc) > 0
          and position('for no key update' in p.prosrc) < position('private.pair_state' in p.prosrc)
          and position('private.pair_state' in p.prosrc) < position('insert into public.bill_payments' in p.prosrc)
   from pg_proc as p where p.oid = 'public.mark_paid(uuid,uuid,integer,text,text)'::regprocedure),
  '[M17] mark_paid locks the caller''s row before reading the pair, then inserts');
set local role authenticated;
select pg_temp.act(pg_temp.sam());
insert into pg_temp.mp select 'm17', r.* from public.mark_paid(pg_temp.bid('m17'), pg_temp.hana(), 1510, 'venmo') as r;
reset role;
select ok(
  (select count(*) = 1 and bool_and(mp.created)
          and bool_and(mp.settled_at = (pg_temp.sam_row('m17') ->> 'at')::timestamptz)
   from pg_temp.mp where mp.tag = 'm17')
  and pg_temp.n('m17', 'marked_paid') = 1,
  '[M17] a fresh mark returns (its settled_at, true) and logs one event');

select ok(
  (select bool_or(s like '%notify pgrst, ''reload schema''%')
   from supabase_migrations.schema_migrations as m, unnest(m.statements) as s
   where m.version = '20261126080844'),
  '[M18] the migration ends with notify pgrst, ''reload schema'' (recorded statements)');

-- ---------------------------------------------------------------------------
-- N1, N2: mark_not_received as the payer
-- ---------------------------------------------------------------------------
select set_config('test.n1_msgs', pg_temp.msgs('n1')::text, true);
set local role authenticated;
select pg_temp.act(pg_temp.hana());
select lives_ok(
  $$ select public.mark_not_received(pg_temp.bid('n1'), pg_temp.sam(), pg_temp.hana(), 1510, pg_temp.old_at()) $$,
  '[N1] Hana marks Sam''s venmo $15.10 not received');
select lives_ok(
  format($$ select public.mark_not_received(pg_temp.bid('n2'), pg_temp.sam(), pg_temp.hana(), 1510, %L::timestamptz) $$,
         pg_temp.sam_row('n2') ->> 'at'),
  '[N2] Hana marks Sam''s cash $15.10 not received');
reset role;
select is(pg_temp.sam_row('n1'),
  jsonb_build_object('at', null, 'cents', null, 'method', null, 'nr_cents', 1510,
                     'nr_method', 'venmo', 'nr_by', pg_temp.hana()),
  '[N1] mark cleared; not_received 1510 / venmo / by Hana');
select ok(pg_temp.one('n1', 'not_received', pg_temp.hana(),
            jsonb_build_object('user_id', pg_temp.sam(), 'payer_id', pg_temp.hana(), 'cents', 1510, 'method', 'venmo'))
          and pg_temp.n('n1', 'unmarked_paid') = 0,
  '[N1] exactly one not_received {user_id Sam, payer_id Hana, cents 1510, method venmo}, actor Hana, and no unmarked_paid');
select is(pg_temp.sam_row('n2'),
  jsonb_build_object('at', null, 'cents', null, 'method', null, 'nr_cents', 1510,
                     'nr_method', 'cash', 'nr_by', pg_temp.hana()),
  '[N2] mark cleared; not_received 1510 / cash / by Hana');
select ok(pg_temp.one('n2', 'not_received', pg_temp.hana(),
            jsonb_build_object('user_id', pg_temp.sam(), 'payer_id', pg_temp.hana(), 'cents', 1510, 'method', 'cash')),
  '[N2] exactly one not_received with method cash, actor Hana');
select is(pg_temp.msgs('n1') - current_setting('test.n1_msgs')::integer, 1,
  '[N13] mark_not_received sent exactly one broadcast on bill:<id>');

-- ---------------------------------------------------------------------------
-- N5: the idempotent retry; and it doesn't skip the permission checks
-- ---------------------------------------------------------------------------
select set_config('test.n1_msgs', pg_temp.msgs('n1')::text, true);
select set_config('test.n1_row', pg_temp.sam_row('n1')::text, true);
set local role authenticated;
select pg_temp.act(pg_temp.hana());
select lives_ok(
  $$ select public.mark_not_received(pg_temp.bid('n1'), pg_temp.sam(), pg_temp.hana(), 1510, pg_temp.old_at()) $$,
  '[N5] Hana''s identical retry succeeds');
select pg_temp.act(pg_temp.dee());
select throws_ok(
  $$ select public.mark_not_received(pg_temp.bid('n1'), pg_temp.sam(), pg_temp.hana(), 1510, pg_temp.old_at()) $$,
  '42501', 'not_allowed', '[N5] Dee repeating Hana''s call gets 42501 (the retry rule comes after the permission checks)');
reset role;
select ok(pg_temp.sam_row('n1') = current_setting('test.n1_row')::jsonb
          and pg_temp.n('n1', 'not_received') = 1,
  '[N5] no change and still one event');
select is(pg_temp.msgs('n1'), current_setting('test.n1_msgs')::integer,
  '[N13] the idempotent retry sent no broadcast');

-- ---------------------------------------------------------------------------
-- N11: after N1, Sam's mark_paid clears the flag
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act(pg_temp.sam());
select lives_ok($$ select public.mark_paid(pg_temp.bid('n1'), pg_temp.hana(), 1510, 'cash') $$,
  '[N11] Sam marks again (cash)');
reset role;
select ok(pg_temp.sam_row('n1') ->> 'method' = 'cash' and pg_temp.sam_row('n1') ->> 'nr_cents' is null
          and pg_temp.sam_row('n1') ->> 'nr_by' is null and pg_temp.sam_row('n1') ->> 'nr_method' is null,
  '[N11] the flag is gone');

-- ---------------------------------------------------------------------------
-- N3, N4: stale tokens
-- ---------------------------------------------------------------------------
-- N4: Sam's backdated mark is cleared and re-made at the same amount (settled_at = now()).
set local role authenticated;
select pg_temp.act(pg_temp.sam());
select public.unmark_paid(pg_temp.bid('n4'), pg_temp.sam(), pg_temp.hana());
select public.mark_paid(pg_temp.bid('n4'), pg_temp.hana(), 1510, 'venmo');
reset role;
select pg_temp.save('n4');
select ok((pg_temp.sam_row('n4') ->> 'at')::timestamptz <> pg_temp.old_at()
          and (pg_temp.sam_row('n4') ->> 'cents')::int = 1510,
  '[N4] positive control: the re-made mark has the same cents and a different settled_at');

set local role authenticated;
select pg_temp.act(pg_temp.hana());
select throws_ok(
  $$ select public.mark_not_received(pg_temp.bid('n3'), pg_temp.sam(), pg_temp.hana(), 1400, pg_temp.old_at()) $$,
  '22023', 'mark_changed', '[N3] a stale p_expected_cents (1400 while 1510 is stored) gets 22023 mark_changed');
select throws_ok(
  $$ select public.mark_not_received(pg_temp.bid('n4'), pg_temp.sam(), pg_temp.hana(), 1510, pg_temp.old_at()) $$,
  '22023', 'mark_changed', '[N4] same cents but the old p_expected_at (mark cleared and re-made) gets mark_changed');
select throws_ok(
  $$ select public.mark_not_received(pg_temp.bid('m4'), pg_temp.sam(), pg_temp.hana(), 1510, pg_temp.old_at()) $$,
  '22023', 'mark_changed', '[N4] an unmarked target gets mark_changed');
reset role;
select ok(pg_temp.sam_row('n3') = pg_temp.saved('n3') and pg_temp.n('n3', 'not_received') = 0
          and pg_temp.sam_row('n4') = pg_temp.saved('n4') and pg_temp.n('n4', 'not_received') = 0
          and pg_temp.sam_row('m4') = pg_temp.clean() and pg_temp.n('m4', 'not_received') = 0,
  '[N3] [N4] nothing changed and nothing was logged');

-- ---------------------------------------------------------------------------
-- N6-N9: who may call
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act(pg_temp.sam());
select throws_ok(
  $$ select public.mark_not_received(pg_temp.bid('n6'), pg_temp.sam(), pg_temp.hana(), 1510, pg_temp.old_at()) $$,
  '42501', 'not_allowed', '[N6] Sam on his own mark gets 42501 not_allowed');
select pg_temp.act(pg_temp.dee());
select throws_ok(
  $$ select public.mark_not_received(pg_temp.bid('n6'), pg_temp.sam(), pg_temp.hana(), 1510, pg_temp.old_at()) $$,
  '42501', 'not_allowed', '[N7] Dee (host, not payer) passing the real payer id gets 42501 not_allowed');
select pg_temp.act(pg_temp.cal());
select throws_ok(
  $$ select public.mark_not_received(pg_temp.bid('n6'), pg_temp.sam(), pg_temp.hana(), 1510, pg_temp.old_at()) $$,
  '42501', 'not_allowed', '[N8] Cal (outsider) gets 42501 not_allowed');
select pg_temp.act(pg_temp.hana());
select throws_ok(
  $$ select public.mark_not_received('00000000-0000-0000-0000-00000000dead', pg_temp.sam(), pg_temp.hana(), 1510, pg_temp.old_at()) $$,
  '42501', 'not_allowed', '[N8] an unknown bill gets 42501 not_allowed');
select throws_ok(
  $$ select public.mark_not_received(pg_temp.bid('n6'), pg_temp.hana(), pg_temp.hana(), 1510, pg_temp.old_at()) $$,
  '42501', 'not_allowed', '[N9] p_user_id = the payer gets 42501 not_allowed');
select throws_ok(
  $$ select public.mark_not_received(pg_temp.bid('n6'), null, pg_temp.hana(), 1510, pg_temp.old_at()) $$,
  '42501', 'not_allowed', '[N9] p_user_id null gets 42501 not_allowed');
select throws_ok(
  $$ select public.mark_not_received(pg_temp.bid('n6'), pg_temp.sam(), pg_temp.hana(), 0, null) $$,
  '22023', 'invalid_amount', '[N9] the permission checks pass before the amount check (invalid_amount, not mark_changed)');
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select throws_ok(
  $$ select public.mark_not_received(pg_temp.bid('n6'), pg_temp.sam(), pg_temp.hana(), 1510, pg_temp.old_at()) $$,
  '42501', null, '[N8] anon gets 42501');
reset role;
set local role authenticated;
select pg_temp.act(null);
select throws_ok(
  $$ select public.mark_not_received(pg_temp.bid('n6'), pg_temp.sam(), pg_temp.hana(), 1510, pg_temp.old_at()) $$,
  '42501', 'not_allowed', '[N8] no user id gets 42501 not_allowed');

-- N9: Dee moves the payer from Hana to Dee; Hana (the former payer) passes her own id.
-- (Who paid 4a/4b: the recipient of a pair need not be a current payer, so the former payer is no
-- longer refused for that; Sam's 1510 to Hana is still in the ledger, and Hana passing the token
-- of Sam's NEW mark (to Dee) is stale for the Sam -> Hana pair: mark_changed.)
select pg_temp.act(pg_temp.dee());
select public.set_payer(pg_temp.bid('n9'), pg_temp.dee());
select pg_temp.act(pg_temp.sam());
select public.mark_paid(pg_temp.bid('n9'), pg_temp.dee(), 1510, 'venmo');
select pg_temp.act(pg_temp.hana());
select throws_ok(
  format($$ select public.mark_not_received(pg_temp.bid('n9'), pg_temp.sam(), pg_temp.hana(), 1510, %L::timestamptz) $$,
         pg_temp.sam_row('n9') ->> 'at'),
  '22023', 'mark_changed', '[N9] a former payer passing another pair''s token gets 22023 mark_changed');
reset role;
select ok(pg_temp.sam_row('n6') = pg_temp.saved('n6') and pg_temp.n('n6', 'not_received') = 0
          and pg_temp.sam_row('n9') ->> 'method' = 'venmo' and pg_temp.n('n9', 'not_received') = 0,
  '[N6] [N7] [N8] [N9] the refused calls changed nothing and logged nothing');

-- ---------------------------------------------------------------------------
-- N10: bad cents or time
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act(pg_temp.hana());
select throws_ok(
  $$ select public.mark_not_received(pg_temp.bid('n6'), pg_temp.sam(), pg_temp.hana(), 0, pg_temp.old_at()) $$,
  '22023', 'invalid_amount', '[N10] p_expected_cents 0 gets 22023 invalid_amount');
select throws_ok(
  $$ select public.mark_not_received(pg_temp.bid('n6'), pg_temp.sam(), pg_temp.hana(), null, pg_temp.old_at()) $$,
  '22023', 'invalid_amount', '[N10] p_expected_cents null gets 22023 invalid_amount');
select throws_ok(
  $$ select public.mark_not_received(pg_temp.bid('n6'), pg_temp.sam(), pg_temp.hana(), 100000000, pg_temp.old_at()) $$,
  '22023', 'invalid_amount', '[N10] p_expected_cents 100000000 gets 22023 invalid_amount');
select throws_ok(
  $$ select public.mark_not_received(pg_temp.bid('n6'), pg_temp.sam(), pg_temp.hana(), 1510, null) $$,
  '22023', 'invalid_amount', '[N10] p_expected_at null gets 22023 invalid_amount');
reset role;
select ok(pg_temp.sam_row('n6') = pg_temp.saved('n6') and pg_temp.n('n6', 'not_received') = 0,
  '[N10] nothing changed');

-- ---------------------------------------------------------------------------
-- N14: lock order (static; pgTAP can't run two sessions)
-- ---------------------------------------------------------------------------
select ok(
  (select position('public.bill_participants' in p.prosrc) > 0
          and position('public.bill_participants' in p.prosrc) < position('for share' in p.prosrc)
          and position('for share' in p.prosrc) < position('for no key update' in p.prosrc)
          and position('for no key update' in p.prosrc) < position('delete from public.bill_payments' in p.prosrc)
          and position('delete from public.bill_payments' in p.prosrc) < position('private.log_event' in p.prosrc)
          and position('for update' in p.prosrc) = 0
   from pg_proc as p
   where p.oid = 'public.mark_not_received(uuid,uuid,uuid,integer,timestamptz)'::regprocedure),
  '[N14] participation read, then FOR SHARE on bills, then FOR NO KEY UPDATE on the row, the ledger writes, the event; no FOR UPDATE');
select ok(
  (select position('public.bill_participants' in p.prosrc) < position('for share' in p.prosrc)
          and position('for share' in p.prosrc) < position('private.settle_state' in p.prosrc)
          and position('private.settle_state' in p.prosrc) < position('insert into public.bill_payments' in p.prosrc)
          and position('for update' in p.prosrc) = 0
   from pg_proc as p where p.oid = 'public.mark_paid(uuid,uuid,integer,text,text)'::regprocedure),
  '[N14] mark_paid keeps its order: participation read, FOR SHARE on bills, settle_state, the ledger insert; no FOR UPDATE');

-- ---------------------------------------------------------------------------
-- N15 (criterion 20): set_payer and the reset trigger clear marks, methods and flags
-- ---------------------------------------------------------------------------
-- n15a: Hana flags Sam, Dee marks, then Dee moves the payer to Sam.
set local role authenticated;
select pg_temp.act(pg_temp.hana());
select public.mark_not_received(pg_temp.bid('n15a'), pg_temp.sam(), pg_temp.hana(), 1510,
  (pg_temp.sam_row('n15a') ->> 'at')::timestamptz);
select pg_temp.act(pg_temp.dee());
select public.mark_paid(pg_temp.bid('n15a'), pg_temp.hana(), 500, 'cash');
reset role;
select ok((pg_temp.sam_row('n15a') ->> 'nr_cents')::int = 1510
          and pg_temp.row_of('n15a', pg_temp.dee()) ->> 'method' = 'cash',
  '[N15] positive control: Sam is flagged and Dee is marked (cash) before set_payer');
set local role authenticated;
select pg_temp.act(pg_temp.dee());
select lives_ok($$ select public.set_payer(pg_temp.bid('n15a'), pg_temp.sam()) $$,
  '[N15] set_payer succeeds');
reset role;
-- (Who paid 4b, ledger: Dee's 500 to Hana is kept and listed as moved; Sam's flag to Hana goes,
-- because Hana is no longer paying. Toward the new payer Sam, neither has a mark or a flag.)
select ok(pg_temp.sam_row('n15a') = pg_temp.clean()
          and pg_temp.row_of('n15a', pg_temp.dee()) = pg_temp.clean()
          and not exists (select 1 from public.bill_payment_flags as f where f.bill_id = pg_temp.bid('n15a'))
          and exists (select 1 from public.bill_payments as e
                      where e.bill_id = pg_temp.bid('n15a') and e.from_user = pg_temp.dee()
                        and e.to_user = pg_temp.hana() and e.cents = 500)
          and pg_temp.n('n15a', 'payers_changed') = 2
          and exists (select 1 from public.bill_events as e
                      where e.bill_id = pg_temp.bid('n15a') and e.kind = 'payers_changed'
                        and e.actor_id = pg_temp.dee()
                        and e.details = jsonb_build_object(
                          'before', jsonb_build_array(jsonb_build_object('user_id', pg_temp.hana(), 'cents', 3600)),
                          'after', jsonb_build_array(jsonb_build_object('user_id', pg_temp.sam(), 'cents', 3600)),
                          'moved', jsonb_build_array(jsonb_build_object('from_user', pg_temp.dee(),
                                     'to_user', pg_temp.hana(), 'cents', 500)))),
  '[N15] set_payer deleted Sam''s flag to Hana, kept Dee''s 500 to Hana (moved), and logged one payers_changed');

-- n15b: Pia (payer, not host) flags Sam, Dee marks, then Pia's account is deleted.
set local role authenticated;
select pg_temp.act(pg_temp.pia());
select public.mark_not_received(pg_temp.bid('n15b'), pg_temp.sam(), pg_temp.pia(), 1510,
  (pg_temp.sam_row('n15b') ->> 'at')::timestamptz);
select pg_temp.act(pg_temp.dee());
select public.mark_paid(pg_temp.bid('n15b'), pg_temp.pia(), 500, 'venmo');
reset role;
select ok((pg_temp.sam_row('n15b') ->> 'nr_cents')::int = 1510
          and pg_temp.row_of('n15b', pg_temp.dee()) ->> 'method' = 'venmo',
  '[N15] positive control: Sam is flagged and Dee is marked before the payer''s account goes');
select lives_ok($$ delete from auth.users where id = pg_temp.pia() $$,
  '[N15] deleting the payer''s account succeeds');
select ok(pg_temp.sam_row('n15b') = pg_temp.clean()
          and pg_temp.row_of('n15b', pg_temp.dee()) = pg_temp.clean()
          and not exists (select 1 from public.bill_payments as e where e.bill_id = pg_temp.bid('n15b'))
          and not exists (select 1 from public.bill_payment_flags as f where f.bill_id = pg_temp.bid('n15b'))
          and (select b.payer_id = pg_temp.dee() from public.bills as b where b.id = pg_temp.bid('n15b'))
          and pg_temp.n('n15b', 'payers_changed') = 2
          and exists (select 1 from public.bill_events as e
                      where e.bill_id = pg_temp.bid('n15b') and e.kind = 'payers_changed'
                        and e.actor_id is null
                        and e.details = jsonb_build_object(
                          'before', jsonb_build_array(jsonb_build_object('user_id', pg_temp.pia(), 'cents', 3600)),
                          'after', jsonb_build_array(jsonb_build_object('user_id', pg_temp.dee(), 'cents', 3600)),
                          'moved', '[]'::jsonb, 'lost', 1)),
  '[N15] the reset trigger deleted Dee''s payment to Pia and Sam''s flag, gave the bill back to Dee, lost = 1');

-- ---------------------------------------------------------------------------
-- N16: mark_not_received on a raised mark uses the stored (net) cents
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act(pg_temp.hana());
select throws_ok(
  $$ select public.mark_not_received(pg_temp.bid('m10'), pg_temp.sam(), pg_temp.hana(), 1510,
       (pg_temp.sam_row('m10') ->> 'at')::timestamptz) $$,
  '22023', 'mark_changed', '[N16] after a difference (1510 -> 1620) the old 1510 is stale: mark_changed');
select lives_ok(
  $$ select public.mark_not_received(pg_temp.bid('m10'), pg_temp.sam(), pg_temp.hana(), 1620,
       (pg_temp.sam_row('m10') ->> 'at')::timestamptz) $$,
  '[N16] the current 1620 is accepted');
reset role;
select ok(pg_temp.sam_row('m10') ->> 'nr_cents' = '1620' and pg_temp.sam_row('m10') ->> 'nr_method' = 'venmo'
          and pg_temp.n('m10', 'not_received') = 1,
  '[N16] the flag stores 1620 / venmo, one event');

-- ---------------------------------------------------------------------------
-- Criterion 20: unmark_paid nulls settled_method
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act(pg_temp.sam());
select lives_ok($$ select public.unmark_paid(pg_temp.bid('u'), pg_temp.sam(), pg_temp.hana()) $$,
  'c20: Sam undoes his venmo mark');
reset role;
select ok(pg_temp.sam_row('u') = pg_temp.clean()
          and pg_temp.one('u', 'unmarked_paid', pg_temp.sam(),
                jsonb_build_object('user_id', pg_temp.sam(), 'cents', 1510)),
  'c20: mark and method null; one unmarked_paid {user_id, cents} (unchanged shape)');

-- ---------------------------------------------------------------------------
-- Criterion 17: my_bills.seen_at
-- ---------------------------------------------------------------------------
-- The fixture users joined 20+ bills in this transaction with the same now(), and my_bills
-- returns 20 rows ordered by joined_at desc, so move sn to the top for Sam and Hana.
update public.bill_participants set joined_at = now() + interval '1 day'
 where bill_id = pg_temp.bid('sn');
create temp table mb (who text, seen boolean, seen_at timestamptz);
grant all on mb to authenticated;
set local role authenticated;
select pg_temp.act(pg_temp.sam());
insert into pg_temp.mb select 'sam_before', m.seen, m.seen_at from public.my_bills() as m where m.bill_id = pg_temp.bid('sn');
select public.mark_bill_seen(pg_temp.bid('sn'));
reset role;
update public.bill_seen set seen_at = pg_temp.old_at()
 where bill_id = pg_temp.bid('sn') and user_id = pg_temp.sam();
set local role authenticated;
select pg_temp.act(pg_temp.sam());
insert into pg_temp.mb select 'sam_after', m.seen, m.seen_at from public.my_bills() as m where m.bill_id = pg_temp.bid('sn');
select pg_temp.act(pg_temp.hana());
insert into pg_temp.mb select 'hana', m.seen, m.seen_at from public.my_bills() as m where m.bill_id = pg_temp.bid('sn');
reset role;
select ok((select count(*) = 1 and bool_and(not mb.seen and mb.seen_at is null) from pg_temp.mb where who = 'sam_before'),
  'c17: with no bill_seen row, seen is false and seen_at is null');
select ok((select count(*) = 1 and bool_and(mb.seen and mb.seen_at = pg_temp.old_at()) from pg_temp.mb where who = 'sam_after'),
  'c17: after mark_bill_seen, seen is true and seen_at equals the caller''s bill_seen.seen_at');
select ok((select count(*) = 1 and bool_and(not mb.seen and mb.seen_at is null) from pg_temp.mb where who = 'hana'),
  'c17: Hana (hasn''t opened it) gets her own null seen_at, never Sam''s');
select is(
  (select pg_get_function_result('public.my_bills()'::regprocedure)),
  'TABLE(bill_id uuid, host_id uuid, host_name text, payer_id uuid, total_cents integer, created_at timestamp with time zone, joined_at timestamp with time zone, added boolean, seen boolean, claimed_any boolean, complete boolean, seen_at timestamp with time zone)',
  'c17: my_bills keeps every column in order and appends seen_at');

-- ---------------------------------------------------------------------------
-- Criterion 18: the kind constraint (as postgres, on bill sn)
-- ---------------------------------------------------------------------------
select lives_ok(
  $$ insert into public.bill_events (bill_id, kind)
     select pg_temp.bid('sn'), k
     from unnest(array['bill_created', 'joined', 'claimed', 'unclaimed', 'split_changed',
                       'item_added', 'item_removed', 'item_changed', 'amounts_changed',
                       'link_rotated', 'extras_split_changed', 'payer_changed', 'marked_paid',
                       'unmarked_paid', 'participant_added', 'participant_removed', 'left',
                       'paid_difference', 'paid_back', 'not_received']) as k $$,
  'c18: every earlier kind plus not_received is accepted');
select throws_ok(
  $$ insert into public.bill_events (bill_id, kind) values (pg_temp.bid('sn'), 'not_sent') $$,
  '23514', null, 'c18: kind ''not_sent'' is rejected');

-- ---------------------------------------------------------------------------
-- Criterion 19: functions, grants, old signatures
-- ---------------------------------------------------------------------------
select ok(
  to_regprocedure('public.mark_paid(uuid,uuid,integer)') is null
  and to_regprocedure('public.settle_difference(uuid,uuid,uuid,integer,integer)') is null,
  'c19: the old mark_paid (3 args) and settle_difference (5 args) no longer exist');
select ok(
  (select bool_and(p.prosecdef and p.proconfig = array['search_path=""']
                   and has_function_privilege('authenticated', p.oid, 'execute')
                   and not has_function_privilege('anon', p.oid, 'execute')
                   and not has_function_privilege('public', p.oid, 'execute')
                   and p.proowner = 'postgres'::regrole)
          and count(*) = 6
   from pg_proc as p
   where p.oid in ('public.mark_paid(uuid,uuid,integer,text,text)'::regprocedure,
                   'public.settle_difference(uuid,uuid,uuid,integer,integer,text,text)'::regprocedure,
                   'public.mark_not_received(uuid,uuid,uuid,integer,timestamptz)'::regprocedure,
                   'public.my_bills()'::regprocedure,
                   'public.set_payer(uuid,uuid)'::regprocedure,
                   'public.unmark_paid(uuid,uuid,uuid)'::regprocedure)),
  'c19: every new or re-created public function is security definer, empty search_path, owner postgres, executable by authenticated only');
select ok(
  (select bool_and(p.proconfig = array['search_path=""']
                   and not has_function_privilege('authenticated', p.oid, 'execute')
                   and not has_function_privilege('anon', p.oid, 'execute')
                   and not has_function_privilege('public', p.oid, 'execute'))
          and count(*) = 2
   from pg_proc as p
   where p.oid in ('private.is_payment_method(text)'::regprocedure,
                   'private.bill_participants_reset_payer()'::regprocedure)),
  'c19: private.is_payment_method and the reset trigger function are executable by no client role');
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select throws_ok($$ select public.mark_paid(pg_temp.bid('m4'), pg_temp.hana(), 1510, 'venmo') $$,
  '42501', null, 'c19: anon calling mark_paid gets 42501');
select throws_ok($$ select public.settle_difference(pg_temp.bid('m10'), pg_temp.sam(), pg_temp.hana(), 1620, 1700, 'venmo') $$,
  '42501', null, 'c19: anon calling settle_difference gets 42501');
select throws_ok($$ select * from public.my_bills() $$,
  '42501', null, 'c19: anon calling my_bills gets 42501');
reset role;

select * from finish();
rollback;
