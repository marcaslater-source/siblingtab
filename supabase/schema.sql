-- SiblingTab database setup
-- Paste this whole file into Supabase: SQL Editor -> New query -> Run.
-- Safe rules: every table is locked down with Row Level Security so a person
-- can only ever read or change data for the families they belong to.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.families (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(trim(name)) between 1 and 80),
  created_by  uuid not null references auth.users (id),
  created_at  timestamptz not null default now()
);

create table public.family_members (
  family_id    uuid not null references public.families (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) between 1 and 60),
  role         text not null default 'member' check (role in ('owner', 'member')),
  joined_at    timestamptz not null default now(),
  primary key (family_id, user_id)
);
create index family_members_user_idx on public.family_members (user_id);

-- Invite links. One link can be shared with several siblings until it expires.
create table public.invites (
  code        text primary key default replace(gen_random_uuid()::text, '-', ''),
  family_id   uuid not null references public.families (id) on delete cascade,
  created_by  uuid not null default auth.uid() references auth.users (id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '14 days'
);

create table public.expenses (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families (id) on delete cascade,
  paid_by      uuid not null,
  amount_cents integer not null check (amount_cents > 0 and amount_cents <= 10000000),
  spent_on     date not null,
  category     text not null check (category in
                 ('medication', 'medical', 'care_home', 'home_care', 'transport',
                  'groceries', 'home', 'equipment', 'other')),
  description  text not null default '' check (char_length(description) <= 300),
  receipt_path text check (receipt_path is null or char_length(receipt_path) <= 200),
  created_by   uuid not null default auth.uid() references auth.users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, family_id),
  foreign key (family_id, paid_by) references public.family_members (family_id, user_id)
);
create index expenses_family_idx on public.expenses (family_id, spent_on desc);

-- Who shares each expense, and how many cents each person's share is.
create table public.expense_shares (
  expense_id  uuid not null,
  family_id   uuid not null,
  user_id     uuid not null,
  share_cents integer not null check (share_cents >= 0),
  primary key (expense_id, user_id),
  foreign key (expense_id, family_id) references public.expenses (id, family_id) on delete cascade,
  foreign key (family_id, user_id) references public.family_members (family_id, user_id)
);
create index expense_shares_family_idx on public.expense_shares (family_id);

-- "I paid you back" records.
create table public.settlements (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families (id) on delete cascade,
  from_user    uuid not null,
  to_user      uuid not null,
  amount_cents integer not null check (amount_cents > 0 and amount_cents <= 10000000),
  settled_on   date not null default current_date,
  note         text not null default '' check (char_length(note) <= 200),
  created_by   uuid not null default auth.uid() references auth.users (id),
  created_at   timestamptz not null default now(),
  check (from_user <> to_user),
  foreign key (family_id, from_user) references public.family_members (family_id, user_id),
  foreign key (family_id, to_user)   references public.family_members (family_id, user_id)
);
create index settlements_family_idx on public.settlements (family_id);

-- ---------------------------------------------------------------------------
-- Helper: is the signed-in person a member of this family?
-- (security definer so the check itself isn't blocked by the rules below)
-- ---------------------------------------------------------------------------

create function public.is_member(fid uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.family_members m
    where m.family_id = fid and m.user_id = auth.uid()
  );
$$;

-- Same check for a storage path like "<family id>/<file name>".
create function public.is_member_path(path text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case
    when split_part(path, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then public.is_member(split_part(path, '/', 1)::uuid)
    else false
  end;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.families       enable row level security;
alter table public.family_members enable row level security;
alter table public.invites        enable row level security;
alter table public.expenses       enable row level security;
alter table public.expense_shares enable row level security;
alter table public.settlements    enable row level security;

-- Families: members can see and rename. Creating goes through create_family().
create policy "members read family" on public.families
  for select to authenticated using (public.is_member(id));
create policy "members rename family" on public.families
  for update to authenticated using (public.is_member(id)) with check (public.is_member(id));

-- Members: see the people in your families; change only your own display name.
create policy "members read members" on public.family_members
  for select to authenticated using (public.is_member(family_id));
create policy "edit own name" on public.family_members
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Invites: any member can create or cancel an invite link for their family.
create policy "members read invites" on public.invites
  for select to authenticated using (public.is_member(family_id));
create policy "members create invites" on public.invites
  for insert to authenticated with check (public.is_member(family_id) and created_by = auth.uid());
create policy "members delete invites" on public.invites
  for delete to authenticated using (public.is_member(family_id));

-- Expenses: every member sees them; only the person who entered one can change or delete it.
create policy "members read expenses" on public.expenses
  for select to authenticated using (public.is_member(family_id));
create policy "members add expenses" on public.expenses
  for insert to authenticated with check (public.is_member(family_id) and created_by = auth.uid());
create policy "creator edits expense" on public.expenses
  for update to authenticated
  using (created_by = auth.uid() and public.is_member(family_id))
  with check (created_by = auth.uid() and public.is_member(family_id));
create policy "creator deletes expense" on public.expenses
  for delete to authenticated using (created_by = auth.uid() and public.is_member(family_id));

create policy "members read shares" on public.expense_shares
  for select to authenticated using (public.is_member(family_id));
create policy "creator writes shares" on public.expense_shares
  for insert to authenticated with check (
    exists (select 1 from public.expenses e
            where e.id = expense_id and e.family_id = expense_shares.family_id
              and e.created_by = auth.uid()));
create policy "creator deletes shares" on public.expense_shares
  for delete to authenticated using (
    exists (select 1 from public.expenses e
            where e.id = expense_id and e.created_by = auth.uid()));

-- Settlements: members see them; a member can record one they're part of; creator can delete.
create policy "members read settlements" on public.settlements
  for select to authenticated using (public.is_member(family_id));
create policy "members record settlements" on public.settlements
  for insert to authenticated with check (
    public.is_member(family_id) and created_by = auth.uid()
    and auth.uid() in (from_user, to_user));
create policy "creator deletes settlement" on public.settlements
  for delete to authenticated using (created_by = auth.uid());

-- Start from no access (Supabase grants everything by default), then allow only what the
-- app needs, and only to signed-in users. Anonymous visitors get nothing.
revoke all on public.families, public.family_members, public.invites,
              public.expenses, public.expense_shares, public.settlements from anon, authenticated;
grant select, insert, delete on public.families, public.family_members, public.invites,
              public.expenses, public.expense_shares, public.settlements to authenticated;
-- Updates are limited to the columns people are meant to change.
grant update (name) on public.families to authenticated;
grant update (display_name) on public.family_members to authenticated;
grant update (paid_by, amount_cents, spent_on, category, description, receipt_path, updated_at)
  on public.expenses to authenticated;

-- ---------------------------------------------------------------------------
-- Actions the app calls
-- ---------------------------------------------------------------------------

-- Create a family and make the caller its first member.
create function public.create_family(family_name text, my_name text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare fid uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  insert into public.families (name, created_by) values (trim(family_name), auth.uid())
    returning id into fid;
  insert into public.family_members (family_id, user_id, display_name, role)
    values (fid, auth.uid(), trim(my_name), 'owner');
  return fid;
end;
$$;

-- Show the family name on the "join" screen before someone joins.
create function public.invite_info(invite_code text)
returns table (family_name text, expired boolean)
language sql stable security definer set search_path = ''
as $$
  select f.name, i.expires_at < now()
  from public.invites i join public.families f on f.id = i.family_id
  where i.code = invite_code;
$$;

-- Join a family using an invite link.
create function public.join_family(invite_code text, my_name text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare fid uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select family_id into fid from public.invites
    where code = invite_code and expires_at >= now();
  if fid is null then raise exception 'This invite link is invalid or has expired'; end if;
  insert into public.family_members (family_id, user_id, display_name)
    values (fid, auth.uid(), trim(my_name))
    on conflict (family_id, user_id) do nothing;
  return fid;
end;
$$;

-- Add or edit an expense and split it evenly among the chosen people, all in one step.
-- Runs with the caller's own permissions, so the rules above still apply.
create function public.save_expense(
  p_id uuid, p_family_id uuid, p_paid_by uuid, p_amount_cents integer,
  p_spent_on date, p_category text, p_description text, p_receipt_path text,
  p_share_with uuid[]
)
returns uuid
language plpgsql security invoker set search_path = ''
as $$
declare
  eid uuid;
  n integer;
  base integer;
  extra integer;
  i integer := 0;
  uid uuid;
begin
  select array_agg(distinct x) into p_share_with from unnest(p_share_with) x where x is not null;
  n := coalesce(array_length(p_share_with, 1), 0);
  if n = 0 then raise exception 'Choose at least one person to share this expense'; end if;
  if p_receipt_path is not null and split_part(p_receipt_path, '/', 1) <> p_family_id::text then
    raise exception 'Receipt belongs to a different family';
  end if;

  if p_id is null then
    insert into public.expenses (family_id, paid_by, amount_cents, spent_on, category, description, receipt_path)
    values (p_family_id, p_paid_by, p_amount_cents, p_spent_on, p_category, coalesce(p_description, ''), p_receipt_path)
    returning id into eid;
  else
    update public.expenses set
      paid_by = p_paid_by, amount_cents = p_amount_cents, spent_on = p_spent_on,
      category = p_category, description = coalesce(p_description, ''),
      receipt_path = p_receipt_path, updated_at = now()
    where id = p_id and family_id = p_family_id
    returning id into eid;
    if eid is null then raise exception 'Expense not found, or you did not create it'; end if;
    delete from public.expense_shares where expense_id = eid;
  end if;

  base := p_amount_cents / n;
  extra := p_amount_cents - base * n;   -- leftover cents go one each to the first people
  foreach uid in array p_share_with loop
    insert into public.expense_shares (expense_id, family_id, user_id, share_cents)
      values (eid, p_family_id, uid, base + case when i < extra then 1 else 0 end);
    i := i + 1;
  end loop;
  return eid;
end;
$$;

revoke execute on function public.create_family(text, text), public.invite_info(text),
  public.join_family(text, text),
  public.save_expense(uuid, uuid, uuid, integer, date, text, text, text, uuid[]),
  public.is_member(uuid), public.is_member_path(text) from public, anon;
grant execute on function public.create_family(text, text), public.invite_info(text),
  public.join_family(text, text),
  public.save_expense(uuid, uuid, uuid, integer, date, text, text, text, uuid[]),
  public.is_member(uuid), public.is_member_path(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Receipt photos (private storage; files live under "<family id>/...")
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])
on conflict (id) do nothing;

create policy "members read receipts" on storage.objects
  for select to authenticated
  using (bucket_id = 'receipts' and public.is_member_path(name));
create policy "members upload receipts" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'receipts' and public.is_member_path(name));
create policy "uploader deletes receipt" on storage.objects
  for delete to authenticated
  using (bucket_id = 'receipts' and owner_id = auth.uid()::text and public.is_member_path(name));
