-- Groups MVP, Task T6: the group snapshot (spec docs/specs/2026-11-26-groups-mvp.md C-G11 as
-- amended by Amendment A1.7 (S5, S6), Amendment A2 (A2.1: payments carry method and source) and
-- GR-M6 (recipient-undone payments); criteria 35-37, 104; decisions GR-T6-... in
-- docs/decisions-to-review.md). Earlier migrations are applied and are not edited.
--
--   public.group_snapshot(p_group_id uuid) returns jsonb
--
-- The one read for the group screens. lib/groups.ts's parseSnapshot reads exactly this shape and
-- fails closed on anything else, so the shape below is the parser's (where the parser and the
-- spec text differ, the parser wins and T12 reconciles; GR-T6-1):
--
--   {
--     "group":    { "id", "name", "join_code", "created_by", "created_at" },
--     "me":       { "hidden": boolean },
--     "members":  [ { "user_id", "display_name", "venmo_username", "joined_at" } ]
--                   ordered by joined_at, user_id
--     "bills":    [ { "id", "host_id", "payer_id", "total_cents", "extras_split", "created_at",
--                     "rows": [ { "id", "total_cents", "kind", "name", "claims": { "<uid>": parts } } ]
--                       in group_position, unit_index order (the line_items unique index);
--                       name is null unless the row has no claim (A1.7); group_position and
--                       unit_index are not sent,
--                     "participant_ids": [ uuid ]  ordered by user_id } ]
--                   bills with group_id = G, ordered by created_at, id
--     "expenses": [ { "id", "title", "payer_id", "amount_cents", "split_method", "created_by",
--                     "created_at", "edited_at", "version",
--                     "shares": [ { "user_id", "cents" } ]  every share row, $0 ones included,
--                       ordered by user_id (the expense_shares primary key) } ]
--                   live only (deleted_at is null), ordered by created_at, id
--                   (expenses_group_created_idx)
--     "payments": [ { "id", "from_user", "to_user", "cents", "method", "source", "recorded_by",
--                     "bill_id", "created_at" } ]
--                   live only (undone_at is null), ordered by created_at, id
--                   (group_payments_group_created_idx)
--     "not_received": [ { "id", "from", "to", "cents", "method", "undone_at" } ]
--                   GR-M6: payments undone by their recipient (undone_reason = 'not_received')
--                   within the last 30 days where the caller is from_user or to_user, ordered by
--                   undone_at desc, id (group_payments_not_received_idx)
--   }
--
-- Every array is present ([] when empty). Ids are uuid values, so they render lowercase
-- canonical; timestamps are timestamptz rendered by jsonb (ISO 8601 with an offset).
--
-- Privacy (criterion 36): only members' ids, display_name and venmo_username (both already
-- readable by co-members, GR-13); no email or any other profile or auth column; only rows of G.
-- A former member's id can still appear only where history keeps it, and history blocks leaving
-- (C-G10), so in practice every id in the payload is a current member (the parser requires it).
--
-- Consistency: one SELECT over one snapshot of the data (C-G11 "one statement"); the membership
-- check is a condition of the same statement, so the answer can't mix a membership from one
-- moment with data from another. (plpgsql only to raise 42501; the function is stable, so it
-- runs on the calling query's snapshot anyway.)
--
-- Size (criterion 37): one scalar jsonb value, so PostgREST's max_rows doesn't cut it (measured in
-- the T6 report through the REST API).
--
-- ===========================================================================================
-- LOCK ORDER (rule in 20261126082511_groups.sql; A1.2, criterion 34)
-- ===========================================================================================
--   group_snapshot takes no row locks (a plain read: ACCESS SHARE on each table only), so it adds
--   no path to the lock order and can't deadlock with the writers.
--
-- ===========================================================================================
-- Grants and errors
-- ===========================================================================================
-- security definer: members can read these tables through RLS, but group_hidden has no client
-- grant (the caller's own `hidden` comes from it) and one owner-run statement avoids re-checking
-- membership per table. search_path = ''; every name is qualified. Execute: authenticated only.
-- No table grants change. Columns clients can't read: none new.
--
--   42501 not_allowed   signed out; p_group_id null; no such group; the caller isn't a member
--                       (someone who left included). One answer for all of them.

create function public.group_snapshot(p_group_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_out jsonb;
begin
  -- One statement: the membership check and the payload read one snapshot. (A stable plpgsql
  -- function also runs every statement on the calling query's snapshot.)
  select jsonb_build_object(
    'group', jsonb_build_object(
      'id', g.id,
      'name', g.name,
      'join_code', g.join_code,
      'created_by', g.created_by,
      'created_at', g.created_at),
    'me', jsonb_build_object(
      'hidden', exists (
        select 1 from public.group_hidden as h
        where h.group_id = g.id and h.user_id = v_uid)),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', m.user_id,
               'display_name', p.display_name,
               'venmo_username', p.venmo_username,
               'joined_at', m.joined_at)
             order by m.joined_at, m.user_id)
      from public.group_members as m
      join public.profiles as p on p.id = m.user_id
      where m.group_id = g.id), '[]'::jsonb),
    'bills', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', b.id,
               'host_id', b.host_id,
               'payer_id', b.payer_id,
               'total_cents', b.total_cents,
               'extras_split', b.extras_split,
               'created_at', b.created_at,
               'rows', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'id', li.id,
                          'total_cents', li.total_cents,
                          'kind', li.kind,
                          'name', case when rc.claims is null then li.name end,
                          'claims', coalesce(rc.claims, '{}'::jsonb))
                        order by li.group_position, li.unit_index)
                 from public.line_items as li
                 left join lateral (
                   select jsonb_object_agg(c.user_id::text, c.parts) as claims
                   from public.claims as c
                   where c.line_item_id = li.id
                 ) as rc on true
                 where li.bill_id = b.id), '[]'::jsonb),
               'participant_ids', coalesce((
                 select jsonb_agg(bp.user_id order by bp.user_id)
                 from public.bill_participants as bp
                 where bp.bill_id = b.id), '[]'::jsonb))
             order by b.created_at, b.id)
      from public.bills as b
      where b.group_id = g.id), '[]'::jsonb),
    'expenses', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', e.id,
               'title', e.title,
               'payer_id', e.payer_id,
               'amount_cents', e.amount_cents,
               'split_method', e.split_method,
               'created_by', e.created_by,
               'created_at', e.created_at,
               'edited_at', e.edited_at,
               'version', e.version,
               'shares', coalesce((
                 select jsonb_agg(jsonb_build_object('user_id', s.user_id, 'cents', s.cents)
                                  order by s.user_id)
                 from public.expense_shares as s
                 where s.expense_id = e.id), '[]'::jsonb))
             order by e.created_at, e.id)
      from public.expenses as e
      where e.group_id = g.id and e.deleted_at is null), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', gp.id,
               'from_user', gp.from_user,
               'to_user', gp.to_user,
               'cents', gp.cents,
               'method', gp.method,
               'source', gp.source,
               'recorded_by', gp.recorded_by,
               'bill_id', gp.bill_id,
               'created_at', gp.created_at)
             order by gp.created_at, gp.id)
      from public.group_payments as gp
      where gp.group_id = g.id and gp.undone_at is null), '[]'::jsonb),
    'not_received', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', nr.id,
               'from', nr.from_user,
               'to', nr.to_user,
               'cents', nr.cents,
               'method', nr.method,
               'undone_at', nr.undone_at)
             order by nr.undone_at desc, nr.id)
      from public.group_payments as nr
      where nr.group_id = g.id
        and nr.undone_reason = 'not_received'
        and nr.undone_at > now() - interval '30 days'
        and (nr.from_user = v_uid or nr.to_user = v_uid)), '[]'::jsonb)
  )
  into v_out
  from public.groups as g
  where g.id = p_group_id
    and v_uid is not null
    and exists (
      select 1 from public.group_members as me
      where me.group_id = g.id and me.user_id = v_uid);

  if v_out is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  return v_out;
end;
$$;

comment on function public.group_snapshot(uuid) is
  'Groups MVP (C-G11 + A1.7 + GR-M6): one jsonb snapshot of a group for a member; 42501 otherwise.';

revoke execute on function public.group_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.group_snapshot(uuid) to authenticated;
