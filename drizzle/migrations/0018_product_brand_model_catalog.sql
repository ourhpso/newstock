-- Product brand/model catalog with admin-managed entries.
create table if not exists public.product_brands (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  constraint product_brands_name_not_blank check (length(trim(name)) > 0)
);
create unique index if not exists product_brands_name_ci on public.product_brands (lower(name));

create table if not exists public.product_models (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.product_brands(id) on delete restrict,
  name text not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  constraint product_models_name_not_blank check (length(trim(name)) > 0)
);
create unique index if not exists product_models_brand_name_ci on public.product_models (brand_id, lower(name));

alter table public.products
  add column if not exists brand_id uuid references public.product_brands(id) on delete restrict,
  add column if not exists model_id uuid references public.product_models(id) on delete restrict;

alter table public.product_brands enable row level security;
alter table public.product_models enable row level security;
grant select, insert, update, delete on public.product_brands to authenticated;
grant select, insert, update, delete on public.product_models to authenticated;
grant all on public.product_brands to service_role;
grant all on public.product_models to service_role;

drop policy if exists "product brands read" on public.product_brands;
create policy "product brands read" on public.product_brands
  for select to authenticated using (true);
drop policy if exists "product brands admin write" on public.product_brands;
create policy "product brands admin write" on public.product_brands
  for all to authenticated using (public.has_role(auth.uid(),'admin'))
  with check (public.has_role(auth.uid(),'admin'));

drop policy if exists "product models read" on public.product_models;
create policy "product models read" on public.product_models
  for select to authenticated using (true);
drop policy if exists "product models admin write" on public.product_models;
create policy "product models admin write" on public.product_models
  for all to authenticated using (public.has_role(auth.uid(),'admin'))
  with check (public.has_role(auth.uid(),'admin'));

insert into public.product_brands (name)
values ('SAMSUNG'), ('VIVO'), ('OPPO'), ('TECHNO'), ('ITEL'), ('INFINIX'), ('HONOR')
on conflict do nothing;
