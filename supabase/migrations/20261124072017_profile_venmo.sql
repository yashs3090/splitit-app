-- Profile + Venmo (spec docs/specs/2026-11-24-profile-venmo.md, Task 1; contracts D1-D3).
--
-- Adds:
--   profiles.venmo_username            text null, D2 format check. Readable by the owner and by
--                                      co-participants (same rows as display_name, through the
--                                      existing SELECT policy); updatable by the owner only.
--   profiles.venmo_prompt_dismissed_at timestamptz null. Owner-only state with NO client grant:
--                                      a column SELECT grant would apply to every row RLS shows,
--                                      including co-participants' rows. Read and written only
--                                      through the two security definer functions below.
--   private.stamp_venmo_prompt()       BEFORE UPDATE OF venmo_username trigger: the first time
--                                      a username is set, the prompt counts as answered forever.
--   public.venmo_prompt_pending()      true iff the caller's row has neither column set.
--   public.dismiss_venmo_prompt()      stamps the caller's own row once (idempotent).
--
-- No new policy: profiles_select_own_or_co_participant and profiles_update_own already scope rows.
-- Existing grants (select (id, display_name), update (display_name)) are left as they are.

-- ---------------------------------------------------------------------------
-- Columns and the D2 format rule
-- ---------------------------------------------------------------------------
-- Same pattern as lib/venmo.ts VENMO_USERNAME_PATTERN. Postgres regex bracket ranges compare code
-- points, not collation order, so 'é' is outside A-Z/a-z; '$' matches only at the very end of the
-- string (no newline-sensitive mode), so a trailing newline is rejected. pgTAP covers both (B9, B15).
-- The stored value never has a leading '@' (the app strips one); '@' is not in the class.
alter table public.profiles
  add column venmo_username text null
    constraint profiles_venmo_username_format
    check (venmo_username is null or venmo_username ~ '^[A-Za-z0-9_-]{5,30}$'),
  add column venmo_prompt_dismissed_at timestamptz null;

comment on column public.profiles.venmo_username is
  'Venmo username without a leading @ (5-30 of A-Z a-z 0-9 _ -). Visible to co-participants.';
comment on column public.profiles.venmo_prompt_dismissed_at is
  'When the "add your Venmo" prompt was answered. Owner-only: no client grant; use '
  'public.venmo_prompt_pending() / public.dismiss_venmo_prompt().';

-- ---------------------------------------------------------------------------
-- Grants (column-level; nothing at all for venmo_prompt_dismissed_at)
-- ---------------------------------------------------------------------------
grant select (venmo_username) on public.profiles to authenticated;
grant update (venmo_username) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- Trigger: setting a username answers the prompt for good
-- ---------------------------------------------------------------------------
-- A BEFORE trigger can assign NEW.venmo_prompt_dismissed_at even though the caller has no UPDATE
-- grant on that column: column privileges are checked against the statement's SET list, not
-- against what triggers change. So this stays security invoker.
create function private.stamp_venmo_prompt()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.venmo_username is not null and new.venmo_prompt_dismissed_at is null then
    new.venmo_prompt_dismissed_at := now();
  end if;
  return new;
end;
$$;

revoke execute on function private.stamp_venmo_prompt() from public, anon, authenticated;

create trigger profiles_stamp_venmo_prompt
  before update of venmo_username on public.profiles
  for each row
  execute function private.stamp_venmo_prompt();

-- ---------------------------------------------------------------------------
-- public.venmo_prompt_pending()
-- ---------------------------------------------------------------------------
-- security definer because the caller has no SELECT grant on venmo_prompt_dismissed_at. It reads
-- only the caller's own row (id = auth.uid()) and returns a boolean, never the timestamp.
create function public.venmo_prompt_pending()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select p.venmo_username is null and p.venmo_prompt_dismissed_at is null
       from public.profiles p
      where p.id = (select auth.uid())),
    false
  );
$$;

revoke execute on function public.venmo_prompt_pending() from public, anon, authenticated;
grant execute on function public.venmo_prompt_pending() to authenticated;

-- ---------------------------------------------------------------------------
-- public.dismiss_venmo_prompt()
-- ---------------------------------------------------------------------------
-- security definer because the caller has no UPDATE grant on venmo_prompt_dismissed_at. Touches
-- only the caller's own row and only that column (plus updated_at via profiles_set_updated_at).
-- coalesce keeps the first answer, so a second call changes nothing.
create function public.dismiss_venmo_prompt()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  update public.profiles
     set venmo_prompt_dismissed_at = coalesce(venmo_prompt_dismissed_at, now())
   where id = v_uid
     and venmo_prompt_dismissed_at is null;
end;
$$;

revoke execute on function public.dismiss_venmo_prompt() from public, anon, authenticated;
grant execute on function public.dismiss_venmo_prompt() to authenticated;
