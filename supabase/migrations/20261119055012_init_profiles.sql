-- M0: public.profiles, one row per auth user.
--
-- Privacy: there is deliberately NO column for the user's e-mail address. Profiles will later (M2)
-- be readable by co-participants of a bill, and addresses must not leak through that. The address
-- stays in auth.users only. (Spelled "e-mail" here so a grep for the column name stays clean.)

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text null
    constraint profiles_display_name_length
    check (display_name is null or char_length(display_name) between 1 and 50),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'One row per auth user, created by the on_auth_user_created trigger. No e-mail address (privacy).';

alter table public.profiles enable row level security;

-- RLS: a user can read and update only their own row.
-- No insert policy (rows come from the trigger) and no delete policy (rows go with auth.users
-- via on delete cascade), so both are denied for every client role.
create policy "profiles_select_own"
  on public.profiles
  for select
  to authenticated
  using (id = (select auth.uid()));

create policy "profiles_update_own"
  on public.profiles
  for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Explicit grants, defense in depth on top of RLS. Don't rely on Supabase's default privileges
-- on the public schema (which grant everything to anon and authenticated).
--   anon: nothing at all.
--   authenticated: select (RLS narrows it to the own row) and update of display_name only;
--   id, created_at and updated_at are not client-writable. No insert or delete.
revoke all on public.profiles from anon, authenticated, public;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;

-- Keep updated_at current on every update.
create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.set_updated_at() from public, anon, authenticated;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row
  execute function public.set_updated_at();

-- Create a profile when a user signs up.
-- security definer so it can insert past RLS; empty search_path so every name is schema-qualified
-- and cannot be hijacked. Takes the display name from Google's metadata: full_name, falling back
-- to name (a blank full_name also falls back). The result is trimmed and cut to 50 chars, and a
-- blank result becomes null, so it can never violate the length check and block sign-up.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    nullif(
      left(
        coalesce(
          nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
          btrim(new.raw_user_meta_data ->> 'name')
        ),
        50
      ),
      ''
    )
  );
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();
