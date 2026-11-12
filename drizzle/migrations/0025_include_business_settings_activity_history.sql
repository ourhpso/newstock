
create or replace function public.capture_activity_history()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  before_row jsonb;
  after_row jsonb;
  row_data jsonb;
  actor uuid;
  sr uuid;
  entity_uuid uuid;
  retailer uuid;
begin
  if tg_op in ('UPDATE','DELETE') then before_row := to_jsonb(old); end if;
  if tg_op in ('INSERT','UPDATE') then after_row := to_jsonb(new); end if;
  row_data := coalesce(after_row, before_row);
  actor := coalesce(auth.uid(),
    nullif(row_data->>'actor','')::uuid,
    nullif(row_data->>'actor_id','')::uuid,
    nullif(row_data->>'created_by','')::uuid,
    nullif(row_data->>'received_by','')::uuid,
    nullif(row_data->>'decided_by','')::uuid,
    nullif(row_data->>'requested_by','')::uuid,
    nullif(row_data->>'updated_by','')::uuid,
    nullif(row_data->>'confirmed_by','')::uuid);
  sr := coalesce(
    nullif(row_data->>'salesman_id','')::uuid,
    nullif(row_data->>'sr_confirmed_by','')::uuid,
    nullif(coalesce(row_data->'after_data',row_data->'before_data')->>'salesman_id','')::uuid
  );
  if tg_table_name = 'approval_events' and sr is null then
    select ar.salesman_id into sr from public.approval_requests ar
    where ar.id = nullif(row_data->>'request_id','')::uuid;
  elsif tg_table_name = 'credit_limit_exception_events' and sr is null then
    select cle.salesman_id into sr from public.credit_limit_exceptions cle
    where cle.id = nullif(row_data->>'exception_id','')::uuid;
  elsif tg_table_name in ('dealer_blocks','dealer_risk_assessments') and sr is null then
    retailer := nullif(row_data->>'retailer_id','')::uuid;
    select r.salesman_id into sr from public.retailers r where r.id = retailer;
  end if;
  entity_uuid := nullif(row_data->>'id','')::uuid;
  insert into public.activity_history(event_type,entity,entity_id,actor_id,salesman_id,before_data,after_data)
  values(tg_op,tg_table_name,entity_uuid,actor,sr,before_row,after_row);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

do $$
declare table_name text;
begin
  foreach table_name in array array['business_profile','dealer_ai_access'] loop
    execute format('drop trigger if exists capture_activity_history on public.%I',table_name);
    execute format('create trigger capture_activity_history after insert or update or delete on public.%I for each row execute function public.capture_activity_history()',table_name);
  end loop;
end $$;
