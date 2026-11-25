-- M1b + M2, Task 4: update_bill (host edits after sharing), Realtime broadcast triggers and the
-- private-channel authorization policy.
-- Spec: docs/specs/2026-11-20-m1b-m2-share-and-claim.md ("Functions and Realtime", design
-- decisions 2, 4 and 7, Amendment A3, criteria 35-44). Earlier migrations are not edited.
--
-- Error contract (same fixed messages as Task 3; the app maps only these):
--   42501 'not_allowed'   no signed-in user, or not the host / no such bill (same error)
--   22023 'invalid_bill'  rows or money failed validation, or a row id isn't one of this bill's
--
-- Realtime: database triggers send a data-free broadcast on the PRIVATE topic 'bill:<bill_id>',
-- event 'changed'. Clients treat it as a hint and refetch through the RLS-protected selects.
-- Checked against the installed stack (CLI 3.2.0, Postgres 17.12):
--   * realtime.send(payload jsonb, event text, topic text, private boolean default true)
--     inserts into realtime.messages. It ADDS an "id" key (a fresh random uuid, equal to the
--     message's own id) when the payload has none, and turns any error into a WARNING, so a
--     failed broadcast never fails the user's write.
--   * realtime.topic() returns current_setting('realtime.topic'). realtime.authorize() sets it,
--     inserts probe rows with that topic, then selects them as the client's role, so a SELECT
--     policy on realtime.messages decides who may join a private channel.

-- ---------------------------------------------------------------------------
-- public.update_bill
-- ---------------------------------------------------------------------------
-- security definer: clients have no insert/update/delete grant on line_items or update on
-- bills (Task 1), and an edit must be one atomic diff. It limits itself: only the host of an
-- existing bill passes, it only touches that bill's rows, and claims are never written here
-- (claims on removed rows go by the foreign key's on delete cascade; claims on kept rows are
-- left exactly as they were).
create function public.update_bill(
  p_bill_id uuid,
  p_rows jsonb,
  p_subtotal_cents integer,
  p_tax_cents integer,
  p_fees_cents integer,
  p_tip_cents integer,
  p_subtotal_discount_cents integer,
  p_total_discount_cents integer,
  p_total_cents integer
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_bill_id uuid;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  -- Host check, and a row lock so two edits of the same bill run one after the other.
  select b.id into v_bill_id
  from public.bills as b
  where b.id = p_bill_id and b.host_id = v_uid
  for update;
  if v_bill_id is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  perform private.validate_bill_rows(
    p_rows, true, p_subtotal_cents, p_tax_cents, p_fees_cents, p_tip_cents,
    p_subtotal_discount_cents, p_total_discount_cents, p_total_cents
  );

  -- Every id must be one of THIS bill's rows (an id from another bill, or an unknown one, is
  -- rejected before anything changes). The validator already checked ids are unique uuids.
  if exists (
    select 1
    from jsonb_array_elements(p_rows) as e
    where e ? 'id'
      and not exists (
        select 1 from public.line_items as li
        where li.id = (e ->> 'id')::uuid and li.bill_id = v_bill_id
      )
  ) then
    raise exception using errcode = '22023', message = 'invalid_bill';
  end if;

  -- Rows not in the list are removed; their claims cascade (claims_line_item_fkey).
  delete from public.line_items as li
  where li.bill_id = v_bill_id
    and not exists (
      select 1 from jsonb_array_elements(p_rows) as e
      where e ? 'id' and (e ->> 'id')::uuid = li.id
    );

  -- Kept rows: new name, note, group fields and price. line_items_bill_group_unit_key is
  -- deferrable initially deferred, so swapping two groups' positions doesn't collide midway.
  update public.line_items as li
  set group_position = (e ->> 'group_position')::integer,
      unit_index = (e ->> 'unit_index')::integer,
      group_size = (e ->> 'group_size')::integer,
      name = btrim(e ->> 'name'),
      note = case when btrim(coalesce(e ->> 'note', '')) = '' then null else e ->> 'note' end,
      total_cents = (e ->> 'total_cents')::integer
  from jsonb_array_elements(p_rows) as e
  where e ? 'id'
    and li.id = (e ->> 'id')::uuid
    and li.bill_id = v_bill_id;

  -- New rows.
  insert into public.line_items (
    bill_id, group_position, unit_index, group_size, name, note, total_cents
  )
  select v_bill_id,
         (e ->> 'group_position')::integer,
         (e ->> 'unit_index')::integer,
         (e ->> 'group_size')::integer,
         btrim(e ->> 'name'),
         case when btrim(coalesce(e ->> 'note', '')) = '' then null else e ->> 'note' end,
         (e ->> 'total_cents')::integer
  from jsonb_array_elements(p_rows) as e
  where not (e ? 'id');

  -- Money and edited_at. This one update also fires the bills broadcast (no line_items
  -- trigger is needed).
  update public.bills as b
  set subtotal_cents = p_subtotal_cents,
      tax_cents = p_tax_cents,
      fees_cents = p_fees_cents,
      tip_cents = p_tip_cents,
      subtotal_discount_cents = p_subtotal_discount_cents,
      total_discount_cents = p_total_discount_cents,
      total_cents = p_total_cents,
      edited_at = now()
  where b.id = v_bill_id;
end;
$$;

revoke execute on function public.update_bill(uuid, jsonb, integer, integer, integer, integer, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.update_bill(uuid, jsonb, integer, integer, integer, integer, integer, integer, integer)
  to authenticated;

-- ---------------------------------------------------------------------------
-- private.broadcast_bill_change: trigger function for the data-free broadcasts
-- ---------------------------------------------------------------------------
-- Statement-level with transition tables: one message per bill per statement, so an
-- update_bill that cascades many claim deletes, or a set_item_split that updates several
-- claims, sends one hint per statement instead of one per row. A statement that touched no
-- rows (for example join_bill's "on conflict do nothing" on a repeat join) sends nothing.
-- Inserts and updates read the bill id from the new rows, deletes from the old rows.
--
-- security definer: a client's own claim insert/delete fires this trigger as `authenticated`,
-- which may not insert into realtime.messages (RLS there has no insert policy). Running as the
-- owner lets the hint go out. It only ever sends {"t": <table name>} on 'bill:<id>' for bills
-- that the statement actually changed.
-- The payload carries no ids, names or amounts. realtime.send adds its own random message id.
create function private.broadcast_bill_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bill_id uuid;
begin
  if tg_op = 'DELETE' then
    for v_bill_id in select distinct o.bill_id from old_rows as o loop
      perform realtime.send(
        jsonb_build_object('t', tg_table_name), 'changed', 'bill:' || v_bill_id::text, true
      );
    end loop;
  elsif tg_table_name = 'bills' then
    for v_bill_id in select distinct n.id from new_rows as n loop
      perform realtime.send(
        jsonb_build_object('t', tg_table_name), 'changed', 'bill:' || v_bill_id::text, true
      );
    end loop;
  else
    for v_bill_id in select distinct n.bill_id from new_rows as n loop
      perform realtime.send(
        jsonb_build_object('t', tg_table_name), 'changed', 'bill:' || v_bill_id::text, true
      );
    end loop;
  end if;
  return null;
end;
$$;

-- Trigger functions need no EXECUTE grant to fire (it's checked when the trigger is created).
revoke execute on function private.broadcast_bill_change() from public, anon, authenticated;

-- Postgres allows transition tables only on single-event triggers, so claims gets three.
create trigger claims_broadcast_insert
  after insert on public.claims
  referencing new table as new_rows
  for each statement
  execute function private.broadcast_bill_change();

create trigger claims_broadcast_update
  after update on public.claims
  referencing new table as new_rows
  for each statement
  execute function private.broadcast_bill_change();

create trigger claims_broadcast_delete
  after delete on public.claims
  referencing old table as old_rows
  for each statement
  execute function private.broadcast_bill_change();

create trigger bill_participants_broadcast_insert
  after insert on public.bill_participants
  referencing new table as new_rows
  for each statement
  execute function private.broadcast_bill_change();

create trigger bills_broadcast_update
  after update on public.bills
  referencing new table as new_rows
  for each statement
  execute function private.broadcast_bill_change();

-- No trigger on line_items: every line_items write happens inside update_bill, which also
-- updates bills (edited_at), and set_item_split updates claims.

-- ---------------------------------------------------------------------------
-- Private channel authorization
-- ---------------------------------------------------------------------------
-- private.can_listen_bill_topic: true iff the topic is exactly 'bill:<uuid>' and the caller is
-- a participant of that bill. Anything else (null, 'bill:', 'bill:x', 'other:<uuid>') is false
-- and never raises: the CASE guarantees the uuid cast runs only after the regex matched.
-- security definer for the same reason as the Task 1 helpers (it reads bill_participants past
-- RLS); it only answers about the caller's own membership.
create function private.can_listen_bill_topic(p_topic text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_topic ~* '^bill:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then private.is_bill_participant(substr(p_topic, 6)::uuid)
    else false
  end;
$$;

revoke execute on function private.can_listen_bill_topic(text) from public, anon, authenticated;
-- The realtime.messages policy below runs it as the subscribing (authenticated) user.
grant execute on function private.can_listen_bill_topic(text) to authenticated;

-- Participants of a bill may receive (select) messages on its topic. The row's own topic must
-- also be the one being joined, so a member of bill X can't read other topics' messages by
-- setting realtime.topic. There is NO insert or update policy, so clients can't broadcast or
-- track presence on these channels; only the triggers above (as the owner) send.
create policy "bill_topic_participants_receive"
  on realtime.messages
  for select
  to authenticated
  using (
    topic = (select realtime.topic())
    and private.can_listen_bill_topic((select realtime.topic()))
  );
