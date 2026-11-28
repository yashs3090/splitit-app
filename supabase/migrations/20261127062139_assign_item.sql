-- Groups MVP, Task T7: assigning items on group bills (spec docs/specs/2026-11-26-groups-mvp.md
-- C-G12 and T7 as amended by Amendment A1 (A1.3, A1.6, A1.11 S15); engineering review
-- docs/specs/2026-11-26-groups-mvp-eng.md S3, S4, B4; criteria 38-44, 96, 103; decisions GR-A1,
-- GR-A5, GR-A6, GR-A8, GR-T11-3 and GR-T7-... in docs/decisions-to-review.md). Earlier migrations
-- are applied and are not edited.
--
--   public.assign_item(p_line_item_id, p_parts, p_expected)   any member of the bill's group sets
--                                     the whole claimer map of one row of a group bill (U-G6)
--   private.log_claim_event()         re-created from 20261121080352_bill_events.sql: actor =
--                                     coalesce(auth.uid(), the claim's user); when the actor isn't
--                                     the claim's user, kind assigned / unassigned with details
--                                     { user_id, unit? } (lib/activityText.ts, GR-T11-3)
--   bill_events_kind_known            the list from 20261127060131_group_bills.sql (the latest
--                                     definition on disk, 22 kinds) plus assigned, unassigned (24)
--   private.parts_map_ok(jsonb)       the parts-map shape set_item_split checks, as one helper
--
-- Non-group bills are unchanged: set_claim still writes only the caller's claim, direct claim
-- INSERT / DELETE still go through RLS (own claims only), set_item_split is unchanged (GR-A8).
-- On those paths auth.uid() is the claim's user (or null as postgres), so log_claim_event logs
-- exactly what it logged before.
--
-- ===========================================================================================
-- assign_item: checks, in this order (C-G12, A1.6)
-- ===========================================================================================
--   1. signed out                                                   -> 42501 not_allowed
--   2. the row doesn't exist, its bill isn't in a group, or the caller isn't a member of that
--      group (one answer, reveals nothing)                          -> 42501 not_allowed
--   3. p_parts or p_expected badly shaped (not an object; a key that isn't a uuid; two keys
--      spelling one uuid; a value that isn't a JSON integer 1..20, e.g. 0, 21, 1.5, "2")
--                                                                   -> 22023 invalid_parts
--   4. a key of p_parts that isn't a member of the group            -> 42501 not_allowed
--   -- locks (below) --
--   5. re-checks under the bill lock (S4): bills.group_id changed (detach / another attach), or
--      the caller is no longer a member or no longer on the bill    -> 42501 not_allowed;
--      a target who was a member at step 4 but isn't now (left meanwhile), or the row is gone
--                                                                   -> 22023 claims_changed
--   6. the current map already equals p_parts: success, no write, no event (S3; a retry after a
--      lost response, whatever p_expected says)
--   7. the current map differs from p_expected                      -> 22023 claims_changed
--   8. writes; a foreign-key failure (23503, e.g. a member with no participant row) -> 22023
--      claims_changed, so the app refetches instead of showing "network" (S4).
-- p_expected's keys need not be members: a stale map may name someone who left; it is only
-- compared. Maps compare by uuid (any letter case) and integer value.
--
-- ===========================================================================================
-- LOCK ORDER (rule in 20261126082511_groups.sql; A1.2, criterion 34; T7 bullet 1)
-- ===========================================================================================
-- assign_item takes no group lock (it changes no membership, like the money writes).
--   0. checks 1-4 without locks (line_items, bills, group_members reads).
--   1. private.lock_bill_key_share(bill): FOR KEY SHARE on the bills row (the caller is a
--      participant: every member is on every group bill). Conflicts with the FOR UPDATE that
--      attach_bill_to_group, detach_bill_from_group, leave_group (all the group's bills),
--      update_bill, set_payer, remove_participant and leave_bill take, so none of them can change
--      group_id, membership of this group, the row or its participants while this call runs;
--      each either committed before (and step 5 sees it) or waits for this commit. join_group
--      (KEY SHARE on bills) only adds members and runs alongside.
--   2. step 5's re-reads of bills.group_id, group_members and bill_participants (no row locks
--      needed: every writer of those rows for this bill needs the bill FOR UPDATE first; plpgsql
--      takes a fresh snapshot per statement, after the lock wait).
--   3. SELECT line_items FOR UPDATE (the row): blocks a concurrent claim insert on it (its FK
--      check needs KEY SHARE on the row) until this commits. set_item_split takes the same two
--      locks in the same order (bill, then row).
--   4. SELECT claims FOR UPDATE (the row's claims): nobody unclaims meanwhile.
--   5. writes, each with its implicit locks, all on rows already held or below them:
--      DELETE claims (row locks held) -> claims_log_event -> log_event INSERT bill_events
--        (KEY SHARE on the bill, held; KEY SHARE on the caller's profile).
--      UPDATE claims.parts (FOR NO KEY UPDATE on held rows; no key column changes).
--      INSERT claims: claims_lock_bill_first (bill KEY SHARE, held), FKs -> KEY SHARE on the
--        line item (held FOR UPDATE) and the target's bill_participants row; then
--        claims_log_event -> bill_events (bill, held).
--      UPDATE line_items split_set_by / split_set_at (held row; FK KEY SHARE on the caller's
--        profile). INSERT bill_events split_changed (bill, held).
--   Versus leave_group (d): leave takes the group, then every group bill FOR UPDATE, then deletes
--   group_members and participant rows. If leave holds the bill first, assign_item waits at step
--   1 and then step 5 sees the target gone (claims_changed) or the caller gone (not_allowed).
--   If assign_item holds the bill first, leave waits; afterwards leave sees the new claim and
--   refuses cannot_leave (GR-T5-7). No cycle: assign_item never waits for the group row.
--   Versus detach (c): detach locks the group, then the bill FOR UPDATE: the same two outcomes,
--   with step 5 answering not_allowed for a bill that is no longer in a group (S4).
--   Not testable in pgTAP (one session): supabase/tests/database/assign_item.test.sql checks the
--   order of these statements in the function body instead (as people_review_fixes.test.sql).
--
-- ===========================================================================================
-- Events (bill Activity), all through existing writers
-- ===========================================================================================
--   per removed claimer: unclaimed {unit, split}   when the claimer is the caller (unchanged)
--                        unassigned {user_id, unit?} otherwise (actor = the caller)
--   per added claimer:   claimed {unit, split}     when the claimer is the caller (unchanged)
--                        assigned {user_id, unit?}   otherwise
--   once, when parts change for people who stay: split_changed {unit, before, after} (the full
--   maps before and after the call, as set_item_split logs them), actor = the caller.
--   An identical map logs nothing. `unit` is [unit_index, group_size] and only for a row of a
--   multi-unit group (group_size > 1), as on claimed.
--
-- Columns clients can't read: none new. No table or column grants change here: claims keeps
-- table-level SELECT and its RLS INSERT / DELETE (own claims) for authenticated; assign_item
-- writes other members' claims as its owner.

-- ---------------------------------------------------------------------------
-- Activity kinds (B4, A1.3): the latest list on disk plus the two this task writes
-- ---------------------------------------------------------------------------
alter table public.bill_events drop constraint bill_events_kind_known;
alter table public.bill_events
  add constraint bill_events_kind_known check (kind in (
    'bill_created', 'joined', 'claimed', 'unclaimed', 'split_changed', 'item_added',
    'item_removed', 'item_changed', 'amounts_changed', 'link_rotated', 'extras_split_changed',
    'payer_changed', 'marked_paid', 'unmarked_paid',
    'participant_added', 'participant_removed', 'left',
    'paid_difference', 'paid_back',
    'not_received',
    'moved_to_group', 'removed_from_group',
    'assigned', 'unassigned'
  ));

-- ---------------------------------------------------------------------------
-- private.log_claim_event (body from 20261121080352_bill_events.sql; actor = the caller)
-- ---------------------------------------------------------------------------
-- The actor is the caller (auth.uid()), or the claim's own user when there is no caller (a
-- postgres-role write). Through set_claim and direct writes under RLS the two are the same
-- person, so those events are unchanged. When they differ (only assign_item can write another
-- member's claim), the event is assigned / unassigned with { user_id, unit? }: lib/activityText.ts
-- reads exactly that and treats an assigned/unassigned about the actor themself as malformed
-- (GR-T11-3), which can't be logged here.
-- Cascades are still skipped (the line item or the participant row is gone).
create or replace function private.log_claim_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bill_id uuid;
  v_line_item_id uuid;
  v_user_id uuid;
  v_actor uuid;
  v_name text;
  v_unit integer;
  v_size integer;
  v_split jsonb;
begin
  if tg_op = 'INSERT' then
    v_bill_id := new.bill_id; v_line_item_id := new.line_item_id; v_user_id := new.user_id;
  else
    v_bill_id := old.bill_id; v_line_item_id := old.line_item_id; v_user_id := old.user_id;
  end if;
  v_actor := coalesce((select auth.uid()), v_user_id);

  select li.name, li.unit_index, li.group_size into v_name, v_unit, v_size
  from public.line_items as li
  where li.id = v_line_item_id;
  if not found then
    return null;
  end if;

  if tg_op = 'DELETE' and not exists (
    select 1 from public.bill_participants as bp
    where bp.bill_id = v_bill_id and bp.user_id = v_user_id
  ) then
    return null;
  end if;

  if v_actor <> v_user_id then
    perform private.log_event(
      v_bill_id, v_actor,
      case when tg_op = 'INSERT' then 'assigned' else 'unassigned' end,
      v_name,
      jsonb_build_object('user_id', v_user_id)
        || case when v_size > 1
                then jsonb_build_object('unit', jsonb_build_array(v_unit, v_size))
                else '{}'::jsonb end
    );
    return null;
  end if;

  select case when count(*) >= 2 and count(distinct c.parts) > 1
              then jsonb_object_agg(c.user_id::text, c.parts) end
  into v_split
  from public.claims as c
  where c.line_item_id = v_line_item_id;

  perform private.log_event(
    v_bill_id, v_actor,
    case when tg_op = 'INSERT' then 'claimed' else 'unclaimed' end,
    v_name,
    jsonb_build_object(
      'unit', case when v_size > 1 then jsonb_build_array(v_unit, v_size) end,
      'split', v_split
    )
  );
  return null;
end;
$$;

revoke execute on function private.log_claim_event() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- private.parts_map_ok: the shape of a parts map (set_item_split's rule)
-- ---------------------------------------------------------------------------
-- An object whose keys are uuids (no two spelling the same uuid, e.g. in another letter case;
-- jsonb itself keeps only the last of two identical keys) and whose values are JSON integers
-- 1..20 (not 0, 21, 1.5 or "2"). '{}' is valid (nobody).
create function private.parts_map_ok(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p is not null
     and jsonb_typeof(p) = 'object'
     and not exists (
       select 1 from jsonb_each(p) as kv
       where kv.key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          or not private.jsonb_int_between(kv.value, 1, 20)
     )
     and (select count(*) from jsonb_object_keys(p))
         = (select count(distinct k::uuid) from jsonb_object_keys(p) as k);
$$;

revoke execute on function private.parts_map_ok(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- public.assign_item (C-G12)
-- ---------------------------------------------------------------------------
-- security definer (owner postgres): writes other members' claims, which RLS forbids clients.
create function public.assign_item(p_line_item_id uuid, p_parts jsonb, p_expected jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_bill_id uuid;
  v_group_id uuid;
  v_name text;
  v_unit integer;
  v_size integer;
  v_parts jsonb;
  v_expected jsonb;
  v_current jsonb;
  v_after jsonb;
  v_stayers_changed boolean;
  v_custom_insert boolean;
begin
  -- 1. Signed out.
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  -- 2. The row, its bill's group and the caller's membership (no locks yet). A line item never
  -- moves between bills, so bill_id read here stays right; group_id is re-read under the lock.
  select li.bill_id, b.group_id into v_bill_id, v_group_id
  from public.line_items as li
  join public.bills as b on b.id = li.bill_id
  where li.id = p_line_item_id;

  if v_group_id is null
     or not exists (
       select 1 from public.group_members as gm
       where gm.group_id = v_group_id and gm.user_id = v_uid
     ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  -- 3. Shapes.
  if not private.parts_map_ok(p_parts) or not private.parts_map_ok(p_expected) then
    raise exception using errcode = '22023', message = 'invalid_parts';
  end if;

  -- Canonical maps: lower-case uuid text keys, integer values.
  select coalesce(jsonb_object_agg(kv.key::uuid::text, (kv.value::text)::integer), '{}'::jsonb)
  into v_parts from jsonb_each(p_parts) as kv;
  select coalesce(jsonb_object_agg(kv.key::uuid::text, (kv.value::text)::integer), '{}'::jsonb)
  into v_expected from jsonb_each(p_expected) as kv;

  -- 4. Every target is a member of the bill's group.
  if exists (
    select 1 from jsonb_object_keys(v_parts) as k
    where not exists (
      select 1 from public.group_members as gm
      where gm.group_id = v_group_id and gm.user_id = k::uuid
    )
  ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  -- Lock order: the bills row first (FOR KEY SHARE).
  perform private.lock_bill_key_share(v_bill_id);

  -- 5. Re-checks under the bill lock (S4). Still the same group, the caller still a member and
  -- on the bill (so the lock above was taken).
  if not exists (
       select 1 from public.bills as b
       where b.id = v_bill_id and b.group_id = v_group_id
     )
     or not exists (
       select 1 from public.group_members as gm
       where gm.group_id = v_group_id and gm.user_id = v_uid
     )
     or not exists (
       select 1 from public.bill_participants as bp
       where bp.bill_id = v_bill_id and bp.user_id = v_uid
     ) then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  -- A target who left after step 4: the screen showed a member who is gone.
  if exists (
    select 1 from jsonb_object_keys(v_parts) as k
    where not exists (
      select 1 from public.group_members as gm
      where gm.group_id = v_group_id and gm.user_id = k::uuid
    )
  ) then
    raise exception using errcode = '22023', message = 'claims_changed';
  end if;

  -- The row, locked FOR UPDATE (re-checks it still exists: update_bill may have removed it).
  select li.name, li.unit_index, li.group_size into v_name, v_unit, v_size
  from public.line_items as li
  where li.id = p_line_item_id and li.bill_id = v_bill_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'claims_changed';
  end if;

  -- The row's claims, locked.
  perform 1 from public.claims as c where c.line_item_id = p_line_item_id for update;

  select coalesce(jsonb_object_agg(c.user_id::text, c.parts), '{}'::jsonb) into v_current
  from public.claims as c where c.line_item_id = p_line_item_id;

  -- 6. Already as asked (a retry after a lost response): success, nothing written (S3).
  if v_current = v_parts then
    return;
  end if;

  -- 7. Stale screen.
  if v_current <> v_expected then
    raise exception using errcode = '22023', message = 'claims_changed';
  end if;

  -- 8. Writes.
  select exists (
    select 1
    from public.claims as c
    join jsonb_each(v_parts) as kv on kv.key::uuid = c.user_id
    where c.line_item_id = p_line_item_id and c.parts <> (kv.value::text)::integer
  ) into v_stayers_changed;

  select exists (
    select 1 from jsonb_each(v_parts) as kv
    where (kv.value::text)::integer <> 1
      and not exists (
        select 1 from public.claims as c
        where c.line_item_id = p_line_item_id and c.user_id = kv.key::uuid
      )
  ) into v_custom_insert;

  begin
    delete from public.claims as c
    where c.line_item_id = p_line_item_id
      and not (v_parts ? c.user_id::text);

    update public.claims as c
    set parts = (kv.value::text)::integer
    from jsonb_each(v_parts) as kv
    where c.line_item_id = p_line_item_id
      and c.user_id = kv.key::uuid
      and c.parts <> (kv.value::text)::integer;

    insert into public.claims (bill_id, line_item_id, user_id, parts)
    select v_bill_id, p_line_item_id, kv.key::uuid, (kv.value::text)::integer
    from jsonb_each(v_parts) as kv
    where not exists (
      select 1 from public.claims as c
      where c.line_item_id = p_line_item_id and c.user_id = kv.key::uuid
    )
    order by kv.key;
  exception when foreign_key_violation then
    -- A target without a participant row, or a row or participant gone despite the lock.
    raise exception using errcode = '22023', message = 'claims_changed';
  end;

  -- Who set the split (lib/billView.ts rowStatus "split by ..."): when this call set parts
  -- other than the default, as set_item_split does.
  if v_stayers_changed or v_custom_insert then
    update public.line_items as li
    set split_set_by = v_uid,
        split_set_at = now()
    where li.id = p_line_item_id;
  end if;

  if v_stayers_changed then
    select coalesce(jsonb_object_agg(c.user_id::text, c.parts), '{}'::jsonb) into v_after
    from public.claims as c where c.line_item_id = p_line_item_id;

    perform private.log_event(
      v_bill_id, v_uid, 'split_changed', v_name,
      jsonb_build_object(
        'unit', case when v_size > 1 then jsonb_build_array(v_unit, v_size) end,
        'before', v_current,
        'after', v_after
      )
    );
  end if;
end;
$$;

alter function public.assign_item(uuid, jsonb, jsonb) owner to postgres;
revoke execute on function public.assign_item(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.assign_item(uuid, jsonb, jsonb) to authenticated;
