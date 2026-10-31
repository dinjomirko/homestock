-- Key Record: shared household data.
-- Run in your Supabase project: SQL Editor → paste all of this → Run. Safe to run again after
-- updates: it only adds what's missing and replaces its own functions and rules.
-- People sign in with an account and join a household with its code; row-level security keeps
-- each household's data visible only to its members. The person who starts a household owns it:
-- they can remove members and issue a new code.

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  household_id uuid not null references public.households (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null default '',
  role text not null default 'member', -- 'owner' or 'member'
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

-- Added after the first release: every household gets an owner (its first member).
alter table public.members add column if not exists role text not null default 'member';
update public.members m set role = 'owner'
where not exists (select 1 from public.members o where o.household_id = m.household_id and o.role = 'owner')
  and m.joined_at = (select min(f.joined_at) from public.members f where f.household_id = m.household_id);

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
  insert into members (household_id, user_id, name, role) values (h, auth.uid(), coalesce(member_name, ''), 'owner');
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

-- Owner only: remove someone from the household.
create or replace function public.remove_member(h uuid, member uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from members where household_id = h and user_id = auth.uid() and role = 'owner') then
    raise exception 'Only the household owner can remove people';
  end if;
  if member = auth.uid() then raise exception 'Use Leave household to remove yourself'; end if;
  delete from members where household_id = h and user_id = member;
end $$;

-- Owner only: replace the join code; the old one stops working at once.
create or replace function public.new_join_code(h uuid)
returns text
language plpgsql security definer set search_path = public as $$
declare
  c text;
begin
  if not exists (select 1 from members where household_id = h and user_id = auth.uid() and role = 'owner') then
    raise exception 'Only the household owner can change the code';
  end if;
  loop
    c := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
    exit when not exists (select 1 from households where households.code = c);
  end loop;
  update households set code = c where id = h;
  return c;
end $$;

-- Leave a household; if the owner leaves, the longest-standing member becomes owner.
create or replace function public.leave_household(h uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from members where household_id = h and user_id = auth.uid();
  if not exists (select 1 from members where household_id = h and role = 'owner') then
    update members set role = 'owner'
    where household_id = h and user_id = (select user_id from members where household_id = h order by joined_at limit 1);
  end if;
end $$;

-- Moving from a guest (anonymous) membership to a real account: called by the guest after the
-- account is created or signed in on the same phone. The account takes over the guest's
-- households and role, and the guest sign-in is removed.
create or replace function public.hand_over_membership(new_user uuid)
returns void
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  old uuid := auth.uid();
begin
  if old is null or new_user is null or old = new_user then return; end if;
  if not exists (select 1 from auth.users where id = old and is_anonymous) then
    raise exception 'Only a guest membership can be handed over';
  end if;
  if not exists (select 1 from auth.users where id = new_user and not coalesce(is_anonymous, false)) then
    raise exception 'That is not an account';
  end if;
  insert into members (household_id, user_id, name, role, joined_at)
    select household_id, new_user, name, role, joined_at from members where user_id = old
  on conflict (household_id, user_id) do update
    set role = case when excluded.role = 'owner' then 'owner' else members.role end;
  delete from members where user_id = old;
  delete from auth.users where id = old;
end $$;

revoke all on function public.create_household(text) from public, anon;
revoke all on function public.remove_member(uuid, uuid) from public, anon;
revoke all on function public.new_join_code(uuid) from public, anon;
revoke all on function public.leave_household(uuid) from public, anon;
revoke all on function public.hand_over_membership(uuid) from public, anon;
grant execute on function public.remove_member(uuid, uuid) to authenticated;
grant execute on function public.new_join_code(uuid) to authenticated;
grant execute on function public.leave_household(uuid) to authenticated;
grant execute on function public.hand_over_membership(uuid) to authenticated;
revoke all on function public.join_household(text, text) from public, anon;
grant execute on function public.create_household(text) to authenticated;
grant execute on function public.join_household(text, text) to authenticated;

-- Live updates on other phones.
do $$
begin
  alter publication supabase_realtime add table public.items, public.household_settings;
exception when duplicate_object then null;
end $$;
