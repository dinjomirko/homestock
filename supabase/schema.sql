-- Key Record: shared household data.
-- Run once in your Supabase project: SQL Editor → paste all of this → Run.
-- Everyone in a household signs in anonymously and joins with the household's code;
-- row-level security keeps each household's data visible only to its members.

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  household_id uuid not null references public.households (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null default '',
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

-- One row per inventory item; `data` is the item as the app stores it.
create table if not exists public.items (
  household_id uuid not null references public.households (id) on delete cascade,
  id text not null,
  data jsonb not null,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  primary key (household_id, id)
);

-- Shared lists of stores and places.
create table if not exists public.household_settings (
  household_id uuid primary key references public.households (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.households enable row level security;
alter table public.members enable row level security;
alter table public.items enable row level security;
alter table public.household_settings enable row level security;

create or replace function public.is_member(h uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from members where household_id = h and user_id = auth.uid());
$$;

drop policy if exists "members read their household" on public.households;
create policy "members read their household" on public.households for select using (public.is_member(id));

drop policy if exists "members see each other" on public.members;
create policy "members see each other" on public.members for select using (public.is_member(household_id));
drop policy if exists "members rename themselves" on public.members;
create policy "members rename themselves" on public.members for update using (user_id = auth.uid());
drop policy if exists "members can leave" on public.members;
create policy "members can leave" on public.members for delete using (user_id = auth.uid());

drop policy if exists "members use items" on public.items;
create policy "members use items" on public.items for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));

drop policy if exists "members use settings" on public.household_settings;
create policy "members use settings" on public.household_settings for all
  using (public.is_member(household_id)) with check (public.is_member(household_id));

-- Start a household; returns its id and the 8-character code others join with.
create or replace function public.create_household(member_name text)
returns table (household_id uuid, code text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  h uuid;
  c text;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  loop
    c := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
    exit when not exists (select 1 from households where households.code = c);
  end loop;
  insert into households (code) values (c) returning id into h;
  insert into members (household_id, user_id, name) values (h, auth.uid(), coalesce(member_name, ''));
  insert into household_settings (household_id) values (h);
  return query select h, c;
end $$;

-- Join with a code from someone already in the household.
create or replace function public.join_household(join_code text, member_name text)
returns table (household_id uuid, code text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  h uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select id into h from households where households.code = upper(trim(join_code));
  if h is null then raise exception 'No household with that code'; end if;
  insert into members (household_id, user_id, name) values (h, auth.uid(), coalesce(member_name, ''))
    on conflict (household_id, user_id) do update set name = excluded.name;
  return query select h, upper(trim(join_code));
end $$;

revoke all on function public.create_household(text) from public, anon;
revoke all on function public.join_household(text, text) from public, anon;
grant execute on function public.create_household(text) to authenticated;
grant execute on function public.join_household(text, text) to authenticated;

-- Live updates on other phones.
do $$
begin
  alter publication supabase_realtime add table public.items, public.household_settings;
exception when duplicate_object then null;
end $$;
