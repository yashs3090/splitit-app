-- pgTAP tests for review finding R7 of the Sent via Venmo slice (no new migration; option (a)).
--
-- Who paid 4a (20261127140000/1, 2026-11-27): the mark and flag columns, and the two CHECKs that
-- call private.is_payment_method, moved from bill_participants to public.bill_payments /
-- public.bill_payment_flags. Those tables revoke every privilege from service_role, so a
-- service_role write is refused by the grant (42501 on the table) before any CHECK runs, and
-- bill_participants no longer has a CHECK that calls the helper (service_role's default UPDATE on
-- it now works, as on any table without such a CHECK). The assertions below pin the new stance;
-- the history of the original finding follows.
--
-- 20261126080844_sent_via_venmo.sql revokes EXECUTE on private.is_payment_method(text) from
-- public, anon and authenticated, and two CHECK constraints on public.bill_participants call it
-- (bill_participants_settled_method_known, bill_participants_not_received_complete). Postgres
-- checks EXECUTE on a function in a CHECK expression as the role doing the write, and evaluates
-- every CHECK on every INSERT and UPDATE (not only when the named columns change). So any INSERT
-- or UPDATE on bill_participants by a role other than the owner fails with 42501 "permission
-- denied for function is_payment_method", even though service_role still holds its default table
-- grants. DELETE evaluates no CHECK, so it is unaffected.
--
-- That is the intended stance (ADR 0013): no non-owner role writes bill_participants. Clients have
-- SELECT only, and every write goes through security definer functions owned by postgres
-- (join_bill, mark_paid, set_payer, ...), whose writes run as postgres. Nothing legitimate writes
-- the table as service_role (it is used only for the auth admin API and for deny checks). These
-- tests pin that: if a later migration grants EXECUTE to service_role, or the definer path
-- breaks, they fail.
--
-- Every assertion filters to the fixture bill/users below (the local DB may hold real data).
-- Users: Rho 7a1... (host), Tau 7a2... (participant), Uma 7a3... (not on the bill). Bill: tag r7, one item, total 1000.

begin;

create extension if not exists pgtap with schema extensions;

select plan(9);

insert into auth.users (id, email, raw_user_meta_data) values
  ('7a100000-0000-0000-0000-000000000001', 'r7-rho@test.local', '{"full_name":"Rho"}'::jsonb),
  ('7a200000-0000-0000-0000-000000000002', 'r7-tau@test.local', '{"full_name":"Tau"}'::jsonb),
  ('7a300000-0000-0000-0000-000000000003', 'r7-uma@test.local', '{"full_name":"Uma"}'::jsonb);

create function pg_temp.rho() returns uuid language sql immutable as
  $$ select '7a100000-0000-0000-0000-000000000001'::uuid $$;
create function pg_temp.tau() returns uuid language sql immutable as
  $$ select '7a200000-0000-0000-0000-000000000002'::uuid $$;
create function pg_temp.uma() returns uuid language sql immutable as
  $$ select '7a300000-0000-0000-0000-000000000003'::uuid $$;
create function pg_temp.act(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.bid() returns uuid language sql stable as
  $$ select current_setting('test.r7')::uuid $$;

-- Rho creates the bill and Tau joins (both through definer functions).
do $$
declare r record;
begin
  perform pg_temp.act(pg_temp.rho());
  select * into r from public.create_bill(jsonb_build_array(jsonb_build_object(
      'name', 'Soup', 'note', null, 'group_position', 0, 'unit_index', 0, 'group_size', 1,
      'total_cents', 1000)),
    null, 0, 0, 0, 0, 0, 1000);
  perform set_config('test.r7', r.bill_id::text, true);
  perform set_config('test.r7_code', r.join_code::text, true);
end $$;
select pg_temp.act(pg_temp.tau());
select public.join_bill(current_setting('test.r7_code'));
select set_config('request.jwt.claims', null, true);

-- ---------------------------------------------------------------------------
-- The stance: only the owner can execute the helper the CHECKs call
-- ---------------------------------------------------------------------------
select ok(
  not has_function_privilege('service_role', 'private.is_payment_method(text)', 'execute')
  and not has_function_privilege('authenticated', 'private.is_payment_method(text)', 'execute')
  and not has_function_privilege('anon', 'private.is_payment_method(text)', 'execute'),
  'R7: service_role, authenticated and anon cannot execute private.is_payment_method');
select ok(
  not has_table_privilege('service_role', 'public.bill_payments', 'insert, update, delete')
  and not has_table_privilege('service_role', 'public.bill_payment_flags', 'insert, update, delete'),
  'R7: service_role has no INSERT/UPDATE/DELETE on bill_payments or bill_payment_flags');

-- ---------------------------------------------------------------------------
-- service_role writes: INSERT and UPDATE fail with 42501, DELETE and SELECT work
-- ---------------------------------------------------------------------------
set local role service_role;

select throws_ok(
  $$ insert into public.bill_payments (bill_id, from_user, to_user, cents, method, recorded_by)
     values (pg_temp.bid(), pg_temp.tau(), pg_temp.rho(), 500, 'venmo', pg_temp.tau()) $$,
  '42501', 'permission denied for table bill_payments',
  'R7: service_role INSERT of a payment fails with 42501 (no grant)');
select throws_ok(
  $$ insert into public.bill_payment_flags (bill_id, from_user, to_user, cents, method)
     values (pg_temp.bid(), pg_temp.tau(), pg_temp.rho(), 500, 'venmo') $$,
  '42501', 'permission denied for table bill_payment_flags',
  'R7: service_role INSERT of a flag fails with 42501 (no grant)');
select lives_ok(
  $$ update public.bill_participants set joined_at = joined_at
     where bill_id = pg_temp.bid() and user_id = pg_temp.tau() $$,
  'R7: service_role UPDATE of bill_participants now passes (no CHECK on it calls is_payment_method)');
select is(
  (select count(*)::integer from public.bill_participants
   where bill_id = pg_temp.bid() and user_id in (pg_temp.rho(), pg_temp.tau())),
  2,
  'R7: service_role can still SELECT; both fixture participants are there');
select lives_ok(
  $$ delete from public.bill_participants
     where bill_id = pg_temp.bid() and user_id = pg_temp.tau() $$,
  'R7: service_role DELETE is unaffected (DELETE evaluates no CHECK)');

reset role;

-- Put Tau back for the definer-path checks.
select pg_temp.act(pg_temp.tau());
select public.join_bill(current_setting('test.r7_code'));

-- ---------------------------------------------------------------------------
-- The definer path (owner postgres) is unaffected
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act(pg_temp.tau());
select public.set_claim(
  (select li.id from public.line_items as li where li.bill_id = pg_temp.bid() and li.name = 'Soup'),
  true);
select lives_ok(
  $$ select public.mark_paid(pg_temp.bid(), pg_temp.rho(), 1000, 'venmo') $$,
  'R7: mark_paid (definer, owner postgres) writes the payment through the ledger CHECKs as authenticated');
reset role;
select is(
  (select e.method from public.bill_payments as e
   where e.bill_id = pg_temp.bid() and e.from_user = pg_temp.tau() and e.to_user = pg_temp.rho()),
  'venmo',
  'R7: the definer write landed (Tau''s payment to Rho has method venmo)');

select * from finish();
rollback;
