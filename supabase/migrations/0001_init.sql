-- OpenGiveaway multi-tenant schema: spaces (workspaces) with members + roles,
-- giveaways scoped to a space, and a public Storage bucket for the published
-- artifacts. Tenant isolation is enforced entirely by Row Level Security, so the
-- Node backend runs every query as the signed-in user (never service-role).
--
-- Verification stays trustless: the giveaway artifacts live in a PUBLIC bucket,
-- so anyone can reproduce a result without logging in. Only the DB metadata and
-- artifact *writes* are gated.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.spaces (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique
              check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name        text not null,
  created_by  uuid not null default auth.uid() references auth.users (id),
  created_at  timestamptz not null default now()
);

create table if not exists public.space_members (
  space_id  uuid not null references public.spaces (id) on delete cascade,
  user_id   uuid not null references auth.users (id) on delete cascade,
  role      text not null default 'member' check (role in ('owner','admin','member')),
  added_at  timestamptz not null default now(),
  primary key (space_id, user_id)
);

create table if not exists public.giveaways (
  id                       uuid primary key default gen_random_uuid(),
  space_id                 uuid not null references public.spaces (id) on delete cascade,
  space_slug               text not null,
  giveaway_id              text not null
                           check (giveaway_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  commitment               text not null,
  participant_count        integer not null,
  participant_file_sha256  text not null,
  participant_merkle_root  text not null,
  winner_count             integer not null,
  block_height             bigint not null,
  scheduled_at             timestamptz,
  timezone                 text,
  has_ots                  boolean not null default false,
  drawn                    boolean not null default false,
  seed                     text,
  bitcoin_block_hash       text,
  winners                  jsonb,
  created_by               uuid not null default auth.uid() references auth.users (id),
  created_at               timestamptz not null default now(),
  drawn_at                 timestamptz,
  unique (space_id, giveaway_id)
);

create index if not exists giveaways_space_idx on public.giveaways (space_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Membership helpers (SECURITY DEFINER to avoid RLS recursion inside policies)
-- ---------------------------------------------------------------------------

create or replace function public.is_member(p_space uuid)
returns boolean language sql security definer stable
set search_path = public as $$
  select exists (
    select 1 from public.space_members m
    where m.space_id = p_space and m.user_id = auth.uid()
  );
$$;

create or replace function public.has_role(p_space uuid, p_roles text[])
returns boolean language sql security definer stable
set search_path = public as $$
  select exists (
    select 1 from public.space_members m
    where m.space_id = p_space and m.user_id = auth.uid() and m.role = any(p_roles)
  );
$$;

create or replace function public.is_member_slug(p_slug text)
returns boolean language sql security definer stable
set search_path = public as $$
  select exists (
    select 1 from public.space_members m
    join public.spaces s on s.id = m.space_id
    where s.slug = p_slug and m.user_id = auth.uid()
  );
$$;

-- New space -> creator becomes owner (definer bypasses RLS on space_members).
create or replace function public.handle_new_space()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  insert into public.space_members (space_id, user_id, role)
  values (new.id, new.created_by, 'owner');
  return new;
end;
$$;

drop trigger if exists on_space_created on public.spaces;
create trigger on_space_created
  after insert on public.spaces
  for each row execute function public.handle_new_space();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.spaces        enable row level security;
alter table public.space_members enable row level security;
alter table public.giveaways     enable row level security;

-- spaces
create policy spaces_select on public.spaces
  for select to authenticated using (public.is_member(id));
create policy spaces_insert on public.spaces
  for insert to authenticated with check (created_by = auth.uid());
create policy spaces_update on public.spaces
  for update to authenticated using (public.has_role(id, array['owner','admin']));
create policy spaces_delete on public.spaces
  for delete to authenticated using (public.has_role(id, array['owner']));

-- space_members
create policy members_select on public.space_members
  for select to authenticated using (public.is_member(space_id));
create policy members_insert on public.space_members
  for insert to authenticated with check (public.has_role(space_id, array['owner','admin']));
create policy members_update on public.space_members
  for update to authenticated using (public.has_role(space_id, array['owner','admin']));
create policy members_delete on public.space_members
  for delete to authenticated using (public.has_role(space_id, array['owner','admin']));

-- giveaways
create policy giveaways_select on public.giveaways
  for select to authenticated using (public.is_member(space_id));
create policy giveaways_insert on public.giveaways
  for insert to authenticated with check (public.is_member(space_id));
create policy giveaways_update on public.giveaways
  for update to authenticated using (public.is_member(space_id));
create policy giveaways_delete on public.giveaways
  for delete to authenticated using (public.has_role(space_id, array['owner','admin']));

-- ---------------------------------------------------------------------------
-- Storage: public bucket for published artifacts
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('giveaways', 'giveaways', true)
on conflict (id) do nothing;

-- Public read is served by the public bucket; writes are restricted to members
-- of the space named by the first path segment (<space_slug>/<gid>/<file>).
create policy giveaway_artifacts_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'giveaways' and public.is_member_slug((storage.foldername(name))[1]));
create policy giveaway_artifacts_update on storage.objects
  for update to authenticated
  using (bucket_id = 'giveaways' and public.is_member_slug((storage.foldername(name))[1]))
  with check (bucket_id = 'giveaways' and public.is_member_slug((storage.foldername(name))[1]));
create policy giveaway_artifacts_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'giveaways' and public.is_member_slug((storage.foldername(name))[1]));
