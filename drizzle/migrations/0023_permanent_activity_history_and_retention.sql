-- Permanent, access-scoped activity history and 30-day settings change-log retention.
do $extension$
begin
  if exists (select 1 from pg_available_extensions where name='pg_cron') then
    execute 'create extension if not exists pg_cron with schema pg_catalog';
  end if;
end $extension$;

create table if not exists public.activity_history (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in ('INSERT','UPDATE','DELETE')),
  entity text not null,
  entity_id uuid,
  actor_id uuid,
  salesman_id uuid,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);
create index if not exists activity_history_created_at_idx on public.activity_history (created_at desc);
create index if not exists activity_history_salesman_created_idx on public.activity_history (salesman_id, created_at desc);
create index if not exists activity_history_actor_created_idx on public.activity_history (actor_id, created_at desc);

alter table public.activity_history enable row level security;
drop policy if exists activity_history_read_scope on public.activity_history;
create policy activity_history_read_scope on public.activity_history
for select to authenticated
using (public.has_role(auth.uid(),'admin') or actor_id = auth.uid() or salesman_id = auth.uid());
revoke all on public.activity_history from anon, authenticated;
grant select on public.activity_history to authenticated;
grant all on public.activity_history to service_role;

create or replace function public.capture_activity_history()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  before_row jsonb;
  after_row jsonb;
  row_data jsonb;
  actor uuid;
  sr uuid;
  entity_uuid uuid;
begin
  if tg_op in ('UPDATE','DELETE') then before_row := to_jsonb(old); end if;
  if tg_op in ('INSERT','UPDATE') then after_row := to_jsonb(new); end if;
  row_data := coalesce(after_row, before_row);
  actor := coalesce(auth.uid(),
    nullif(row_data->>'actor','')::uuid,
    nullif(row_data->>'created_by','')::uuid,
    nullif(row_data->>'received_by','')::uuid,
    nullif(row_data->>'decided_by','')::uuid,
    nullif(row_data->>'requested_by','')::uuid,
    nullif(row_data->>'updated_by','')::uuid,
    nullif(row_data->>'confirmed_by','')::uuid);
  sr := coalesce(nullif(row_data->>'salesman_id','')::uuid,
    nullif(row_data->>'sr_confirmed_by','')::uuid);
  if tg_table_name = 'approval_events' and sr is null then
    select ar.salesman_id into sr from public.approval_requests ar
    where ar.id = nullif(row_data->>'request_id','')::uuid;
  end if;
  entity_uuid := nullif(row_data->>'id','')::uuid;
  insert into public.activity_history(event_type,entity,entity_id,actor_id,salesman_id,before_data,after_data)
  values(tg_op,tg_table_name,entity_uuid,actor,sr,before_row,after_row);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.capture_activity_history() from public, anon, authenticated;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'products','product_brands','product_models','imei_units','retailers','sales',
    'stock_movements','retailer_payments','deposits','retailer_returns','purchases',
    'expenses','suppliers','supplier_payments','approval_requests','approval_events',
    'credit_limit_exceptions','credit_limit_exception_events','dealer_blocks',
    'dealer_risk_assessments','business_audit','profiles','user_roles','user_permission_overrides'
  ] loop
    execute format('drop trigger if exists capture_activity_history on public.%I',table_name);
    execute format('create trigger capture_activity_history after insert or update or delete on public.%I for each row execute function public.capture_activity_history()',table_name);
  end loop;
end $$;

create or replace function public.purge_expired_business_change_history()
returns bigint language plpgsql security definer set search_path = public as $$
declare removed bigint;
begin
  delete from public.business_audit where created_at < now() - interval '30 days';
  get diagnostics removed = row_count;
  return removed;
end;
$$;
revoke all on function public.purge_expired_business_change_history() from public, anon, authenticated;
grant execute on function public.purge_expired_business_change_history() to service_role;

do $cron$
begin
  if to_regnamespace('cron') is not null then
    execute 'select cron.unschedule(jobid) from cron.job where jobname = ''purge-business-change-history-daily''';
    execute 'select cron.schedule(''purge-business-change-history-daily'', ''15 18 * * *'', ''select public.purge_expired_business_change_history();'')';
  end if;
end $cron$;
