-- Approval workflows, credit-limit exceptions and server-validated discounts.
-- Apply manually in Supabase SQL Editor after deploying the matching app code.

create table if not exists public.approval_requests (
 id uuid primary key default gen_random_uuid(),
 request_type text not null check(request_type in ('stock_issue','stock_return','cash_deposit')),
 salesman_id uuid not null references public.profiles(id),
 created_by uuid not null references auth.users(id),
 payload jsonb not null,
 reason text not null default '',
 status text not null check(status in ('pending_sr','awaiting_admin_finalize','pending_admin','completed','rejected')),
 result_ref text,
 client_op_id uuid unique,
 sr_confirmed_by uuid references auth.users(id),
 sr_confirmed_at timestamptz,
 decided_by uuid references auth.users(id),
 decided_at timestamptz,
 decision_reason text,
 finalized_at timestamptz,
 created_at timestamptz not null default now()
);
create index if not exists approval_requests_salesman_created_idx on public.approval_requests(salesman_id,created_at desc);
create index if not exists approval_requests_status_created_idx on public.approval_requests(status,created_at desc);
create table if not exists public.approval_events (
 id uuid primary key default gen_random_uuid(),
 request_id uuid not null references public.approval_requests(id) on delete cascade,
 actor_id uuid not null references auth.users(id),
 action text not null,
 reason text,
 details jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);
create index if not exists approval_events_request_created_idx on public.approval_events(request_id,created_at);
alter table public.approval_requests enable row level security;
alter table public.approval_events enable row level security;
revoke all on public.approval_requests,public.approval_events from public,anon,authenticated;
grant select on public.approval_requests,public.approval_events to authenticated;
drop policy if exists approval_requests_read on public.approval_requests;
create policy approval_requests_read on public.approval_requests for select to authenticated
 using(public.has_role(auth.uid(),'admin') or salesman_id=auth.uid());
drop policy if exists approval_events_read on public.approval_events;
create policy approval_events_read on public.approval_events for select to authenticated
 using(public.has_role(auth.uid(),'admin') or exists(select 1 from public.approval_requests r where r.id=request_id and r.salesman_id=auth.uid()));

create or replace function public.submit_workflow_request(_kind text,_salesman uuid,_payload jsonb,_reason text,_op uuid default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare rid uuid; st text;
begin
 if auth.uid() is null or not public.user_is_active(auth.uid()) then raise exception 'Active authenticated account required'; end if;
 if _kind not in ('issue','return','deposit') then raise exception 'Unsupported request'; end if;
 if _kind='issue' and not public.has_role(auth.uid(),'admin') then raise exception 'Admin only'; end if;
 if public.has_role(auth.uid(),'admin') then
  if not public.has_role(_salesman,'salesman') then raise exception 'Salesman not found'; end if;
  st:='pending_sr';
 else
  if _salesman<>auth.uid() or not public.has_role(auth.uid(),'salesman') then raise exception 'Only assigned SR can submit'; end if;
  if _kind='return' and not public.user_can(auth.uid(),'returns') then raise exception 'Return permission denied'; end if;
  st:='pending_admin';
 end if;
 if _kind in ('issue','return') and (jsonb_typeof(_payload->'items')<>'array' or jsonb_array_length(_payload->'items')=0) then raise exception 'At least one item is required'; end if;
 if _kind='deposit' and coalesce((_payload->>'amount')::numeric,0)<=0 then raise exception 'Positive deposit amount required'; end if;
 if _op is not null then select id into rid from public.approval_requests where client_op_id=_op; if rid is not null then return rid; end if; end if;
 insert into public.approval_requests(request_type,salesman_id,created_by,payload,reason,status,client_op_id)
 values(case _kind when 'issue' then 'stock_issue' when 'return' then 'stock_return' else 'cash_deposit' end,
 _salesman,auth.uid(),coalesce(_payload,'{}'::jsonb),coalesce(_reason,''),st,_op) returning id into rid;
 insert into public.approval_events(request_id,actor_id,action,reason,details)
 values(rid,auth.uid(),'submitted',nullif(_reason,''),jsonb_build_object('kind',_kind));
 return rid;
end $$;

create or replace function public.confirm_stock_issue_receipt(_request uuid) returns void
language plpgsql security definer set search_path=public as $$
declare r public.approval_requests%rowtype;
begin
 select * into r from public.approval_requests where id=_request for update;
 if not found or r.request_type not in ('stock_issue','stock_return','cash_deposit') then raise exception 'Approval request not found'; end if;
 if r.salesman_id<>auth.uid() or not public.has_role(auth.uid(),'salesman') then raise exception 'Assigned SR only'; end if;
 if r.status<>'pending_sr' then raise exception 'Request is not awaiting SR confirmation'; end if;
 update public.approval_requests set status='awaiting_admin_finalize',sr_confirmed_by=auth.uid(),sr_confirmed_at=now() where id=_request;
 insert into public.approval_events(request_id,actor_id,action,reason)
 values(_request,auth.uid(),'sr_confirmed','SR confirmed receipt/handover');
end $$;

create or replace function public.reject_stock_issue_request(_request uuid,_reason text) returns void
language plpgsql security definer set search_path=public as $$
declare r public.approval_requests%rowtype;
begin
 if length(trim(coalesce(_reason,'')))<3 then raise exception 'Rejection reason is required'; end if;
 select * into r from public.approval_requests where id=_request for update;
 if not found or r.request_type not in ('stock_issue','stock_return','cash_deposit') or r.status<>'pending_sr' then raise exception 'Request is not awaiting SR response'; end if;
 if r.salesman_id<>auth.uid() or not public.has_role(auth.uid(),'salesman') then raise exception 'Assigned SR only'; end if;
 update public.approval_requests set status='rejected',decided_by=auth.uid(),decided_at=now(),decision_reason=_reason where id=_request;
 insert into public.approval_events(request_id,actor_id,action,reason) values(_request,auth.uid(),'sr_rejected',_reason);
end $$;

create or replace function public.decide_workflow_request(_request uuid,_approved boolean,_reason text) returns text
language plpgsql security definer set search_path=public as $$
declare r public.approval_requests%rowtype; result text;
begin
 if not public.has_role(auth.uid(),'admin') then raise exception 'Admin only'; end if;
 if length(trim(coalesce(_reason,'')))<3 then raise exception 'Decision reason is required'; end if;
 select * into r from public.approval_requests where id=_request for update;
 if not found or r.request_type='stock_issue' or r.status<>'pending_admin' then raise exception 'Request is not pending admin approval'; end if;
 if not _approved then
  update public.approval_requests set status='rejected',decided_by=auth.uid(),decided_at=now(),decision_reason=_reason where id=_request;
  insert into public.approval_events(request_id,actor_id,action,reason) values(_request,auth.uid(),'rejected',_reason);
  return 'rejected';
 end if;
 if r.request_type='stock_return' then
  result:=public.return_stock(r.salesman_id,r.payload->'items',nullif(r.payload->>'date','')::date,_request);
 else
  result:=public.record_deposit(r.salesman_id,(r.payload->>'amount')::numeric,coalesce(r.payload->>'method','cash'),
   r.payload->>'note',nullif(r.payload->>'date','')::date,_request)::text;
 end if;
 update public.approval_requests set status='completed',result_ref=result,decided_by=auth.uid(),decided_at=now(),decision_reason=_reason,finalized_at=now() where id=_request;
 insert into public.approval_events(request_id,actor_id,action,reason,details) values(_request,auth.uid(),'approved_and_finalized',_reason,jsonb_build_object('result_ref',result));
 return result;
end $$;

create or replace function public.finalize_workflow_request(_request uuid) returns text
language plpgsql security definer set search_path=public as $$
declare r public.approval_requests%rowtype; result text;
begin
 if not public.has_role(auth.uid(),'admin') then raise exception 'Admin only'; end if;
 select * into r from public.approval_requests where id=_request for update;
 if not found or r.status<>'awaiting_admin_finalize' or r.sr_confirmed_at is null then raise exception 'SR confirmation is required before finalization'; end if;
 if r.request_type='stock_issue' then
  result:=public.issue_stock(r.salesman_id,r.payload->'items',nullif(r.payload->>'date','')::date,_request);
 elsif r.request_type='stock_return' then
  result:=public.return_stock(r.salesman_id,r.payload->'items',nullif(r.payload->>'date','')::date,_request);
 elsif r.request_type='cash_deposit' then
  result:=public.record_deposit(r.salesman_id,(r.payload->>'amount')::numeric,coalesce(r.payload->>'method','cash'),
   r.payload->>'note',nullif(r.payload->>'date','')::date,_request)::text;
 else raise exception 'Unsupported request type'; end if;
 update public.approval_requests set status='completed',result_ref=result,decided_by=auth.uid(),decided_at=now(),
  decision_reason='Finalized after SR confirmation',finalized_at=now() where id=_request;
 insert into public.approval_events(request_id,actor_id,action,reason,details)
 values(_request,auth.uid(),'admin_finalized','Finalized after SR confirmation',jsonb_build_object('result_ref',result));
 return result;
end $$;

create table if not exists public.credit_limit_exceptions (
 id uuid primary key default gen_random_uuid(),
 retailer_id uuid not null references public.retailers(id),
 salesman_id uuid not null references public.profiles(id),
 requested_by uuid not null references auth.users(id),
 payload jsonb not null,
 current_due numeric not null,
 over_limit_amount numeric not null check(over_limit_amount>0),
 reason text not null,
 status text not null default 'pending' check(status in ('pending','approved','rejected','consumed')),
 decided_by uuid references auth.users(id),
 decided_at timestamptz,
 decision_reason text,
 consumed_at timestamptz,
 created_at timestamptz not null default now()
);
create index if not exists credit_limit_exceptions_status_created_idx on public.credit_limit_exceptions(status,created_at desc);
alter table public.credit_limit_exceptions enable row level security;
revoke all on public.credit_limit_exceptions from public,anon,authenticated;
grant select on public.credit_limit_exceptions to authenticated;
drop policy if exists credit_limit_exceptions_read on public.credit_limit_exceptions;
create policy credit_limit_exceptions_read on public.credit_limit_exceptions for select to authenticated
 using(public.has_role(auth.uid(),'admin') or salesman_id=auth.uid());

create or replace function public.request_credit_limit_exception(
 _retailer uuid,_items jsonb,_paid numeric,_discount_mode text,_discount_value numeric,_date date,_reason text
) returns uuid language plpgsql security definer set search_path=public as $$
declare r public.retailers%rowtype; it jsonb; p public.products%rowtype; gross numeric:=0; disc numeric:=0; due numeric; due_after numeric; eid uuid;
begin
 if auth.uid() is null or not public.user_is_active(auth.uid()) or not public.user_can(auth.uid(),'sales') or length(trim(coalesce(_reason,'')))<3 then raise exception 'Active sales permission and a request reason are required'; end if;
 select * into r from public.retailers where id=_retailer and salesman_id=auth.uid() for update;
 if not found then raise exception 'Retailer not assigned to this SR'; end if;
 if jsonb_typeof(_items)<>'array' or jsonb_array_length(_items)=0 then raise exception 'Sale items required'; end if;
 for it in select * from jsonb_array_elements(_items) loop
  select * into p from public.products where id=(it->>'product_id')::uuid;
  if p.id is null then raise exception 'Product not found'; end if;
  if coalesce((it->>'unit_price')::numeric,p.price)<=0 then raise exception 'Unit price must be positive'; end if;
  if p.is_smartphone then
   if coalesce(jsonb_typeof(it->'imeis'),'')<>'array' or jsonb_array_length(it->'imeis')<=0
      or coalesce((it->>'qty')::int,0)<>jsonb_array_length(it->'imeis') then raise exception 'Smartphone quantity must match scanned IMEIs'; end if;
   gross:=gross+jsonb_array_length(it->'imeis')*coalesce((it->>'unit_price')::numeric,p.price);
  else
   if coalesce((it->>'qty')::numeric,0)<=0 then raise exception 'Invalid quantity'; end if;
   gross:=gross+coalesce((it->>'qty')::numeric,0)*coalesce((it->>'unit_price')::numeric,p.price);
  end if;
 end loop;
 if _discount_mode='percent' then
  if coalesce(_discount_value,0)<0 or _discount_value>100 then raise exception 'Percent discount must be 0 to 100'; end if;
  disc:=round(gross*_discount_value/100,2);
 elsif _discount_mode='fixed' then
  disc:=coalesce(_discount_value,0); if disc<0 or disc>gross then raise exception 'Invalid fixed discount'; end if;
 else raise exception 'Invalid discount mode'; end if;
 if coalesce(_paid,0)<0 or _paid>gross-disc then raise exception 'Invalid paid amount'; end if;
 due:=public.retailer_due(_retailer); due_after:=due+gross-disc-coalesce(_paid,0);
 if r.credit_limit is null or due_after<=r.credit_limit then raise exception 'Credit approval is not required'; end if;
 insert into public.credit_limit_exceptions(retailer_id,salesman_id,requested_by,payload,current_due,over_limit_amount,reason)
 values(_retailer,auth.uid(),auth.uid(),jsonb_build_object('items',_items,'paid',_paid,'discount_mode',_discount_mode,'discount_value',_discount_value,'date',_date),
 due,due_after-r.credit_limit,trim(_reason)) returning id into eid;
 return eid;
end $$;

create or replace function public.decide_credit_limit_exception(_request uuid,_approved boolean,_reason text) returns void
language plpgsql security definer set search_path=public as $$
declare e public.credit_limit_exceptions%rowtype;
begin
 if not public.has_role(auth.uid(),'admin') then raise exception 'Admin only'; end if;
 if length(trim(coalesce(_reason,'')))<3 then raise exception 'Decision reason is required'; end if;
 select * into e from public.credit_limit_exceptions where id=_request for update;
 if not found or e.status<>'pending' then raise exception 'Exception request is not pending'; end if;
 update public.credit_limit_exceptions set status=case when _approved then 'approved' else 'rejected' end,
 decided_by=auth.uid(),decided_at=now(),decision_reason=_reason where id=_request;
end $$;

create or replace function public.record_sale_v2(
 _retailer uuid,_items jsonb,_paid numeric,_discount_mode text,_discount_value numeric,
 _date date,_exception_id uuid,_op uuid
) returns uuid language plpgsql security definer set search_path=public as $$
declare it jsonb; p public.products%rowtype; gross numeric:=0; disc numeric:=0; due numeric; due_after numeric;
 lim numeric; e public.credit_limit_exceptions%rowtype; sid uuid;
begin
 if _op is not null then select id into sid from public.sales where client_op_id=_op; if sid is not null then return sid; end if; end if;
 if coalesce(jsonb_typeof(_items),'')<>'array' or jsonb_array_length(_items)=0 then raise exception 'Sale items are required'; end if;
 for it in select * from jsonb_array_elements(_items) loop
  select * into p from public.products where id=(it->>'product_id')::uuid;
  if p.id is null then raise exception 'Product not found'; end if;
  if coalesce((it->>'unit_price')::numeric,p.price)<=0 then raise exception 'Unit price must be positive'; end if;
  if p.is_smartphone then
   if coalesce(jsonb_typeof(it->'imeis'),'')<>'array' or jsonb_array_length(it->'imeis')<=0
      or coalesce((it->>'qty')::int,0)<>jsonb_array_length(it->'imeis') then raise exception 'Smartphone quantity must match scanned IMEIs'; end if;
   gross:=gross+jsonb_array_length(it->'imeis')*coalesce((it->>'unit_price')::numeric,p.price);
  else
   if coalesce((it->>'qty')::numeric,0)<=0 then raise exception 'Invalid quantity'; end if;
   gross:=gross+coalesce((it->>'qty')::numeric,0)*coalesce((it->>'unit_price')::numeric,p.price);
  end if;
 end loop;
 if _discount_mode='percent' then
  if coalesce(_discount_value,0)<0 or _discount_value>100 then raise exception 'Percent discount must be 0 to 100'; end if;
  disc:=round(gross*_discount_value/100,2);
 elsif _discount_mode='fixed' then
  disc:=coalesce(_discount_value,0); if disc<0 or disc>gross then raise exception 'Discount exceeds sale total'; end if;
 else raise exception 'Invalid discount mode'; end if;
 if coalesce(_paid,0)<0 or _paid>gross-disc then raise exception 'Invalid paid amount'; end if;
 if _exception_id is not null then
  select * into e from public.credit_limit_exceptions where id=_exception_id and retailer_id=_retailer and salesman_id=auth.uid() for update;
  if not found or e.status<>'approved' or e.consumed_at is not null then raise exception 'Approved exception not found or already used'; end if;
  if e.payload<>jsonb_build_object('items',_items,'paid',_paid,'discount_mode',_discount_mode,'discount_value',_discount_value,'date',_date) then raise exception 'Sale details differ from approved request'; end if;
  select credit_limit into lim from public.retailers where id=_retailer and salesman_id=auth.uid() for update;
  if not found then raise exception 'Retailer not assigned to this SR'; end if;
  due:=public.retailer_due(_retailer); due_after:=due+gross-disc-coalesce(_paid,0);
  if lim is null or due_after-lim>e.over_limit_amount then raise exception 'Retailer due changed; request a new approval'; end if;
  perform set_config('app.credit_exception_id',_exception_id::text,true);
  sid:=public.record_sale(_retailer,_items,_paid,disc,_date,_op);
  update public.credit_limit_exceptions set status='consumed',consumed_at=now() where id=_exception_id and status='approved';
  perform set_config('app.credit_exception_id','',true);
  return sid;
 end if;
 return public.record_sale(_retailer,_items,_paid,disc,_date,_op);
end $$;

-- Prevent authenticated users from bypassing SR/Admin approval by calling legacy stock/cash RPCs.
revoke all on function public.issue_stock(uuid,jsonb,date,uuid) from public,anon,authenticated;
revoke all on function public.issue_stock(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.return_stock(uuid,jsonb,date,uuid) from public,anon,authenticated;
revoke all on function public.return_stock(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.record_deposit(uuid,numeric,text,text,date,uuid) from public,anon,authenticated;

revoke all on function public.submit_workflow_request(text,uuid,jsonb,text,uuid) from public,anon;
revoke all on function public.confirm_stock_issue_receipt(uuid) from public,anon;
revoke all on function public.reject_stock_issue_request(uuid,text) from public,anon;
revoke all on function public.decide_workflow_request(uuid,boolean,text) from public,anon;
revoke all on function public.finalize_workflow_request(uuid) from public,anon;
revoke all on function public.request_credit_limit_exception(uuid,jsonb,numeric,text,numeric,date,text) from public,anon;
revoke all on function public.decide_credit_limit_exception(uuid,boolean,text) from public,anon;
revoke all on function public.record_sale_v2(uuid,jsonb,numeric,text,numeric,date,uuid,uuid) from public,anon;
grant execute on function public.submit_workflow_request(text,uuid,jsonb,text,uuid) to authenticated;
grant execute on function public.confirm_stock_issue_receipt(uuid) to authenticated;
grant execute on function public.reject_stock_issue_request(uuid,text) to authenticated;
grant execute on function public.decide_workflow_request(uuid,boolean,text) to authenticated;
grant execute on function public.finalize_workflow_request(uuid) to authenticated;
grant execute on function public.request_credit_limit_exception(uuid,jsonb,numeric,text,numeric,date,text) to authenticated;
grant execute on function public.decide_credit_limit_exception(uuid,boolean,text) to authenticated;
grant execute on function public.record_sale_v2(uuid,jsonb,numeric,text,numeric,date,uuid,uuid) to authenticated;

-- Immutable audit events for credit-limit approval/rejection.
create table if not exists public.credit_limit_exception_events (
 id uuid primary key default gen_random_uuid(),
 exception_id uuid not null references public.credit_limit_exceptions(id) on delete cascade,
 actor_id uuid not null references auth.users(id),
 action text not null,
 reason text,
 created_at timestamptz not null default now()
);
create index if not exists credit_limit_exception_events_created_idx
 on public.credit_limit_exception_events(exception_id,created_at);
alter table public.credit_limit_exception_events enable row level security;
revoke all on public.credit_limit_exception_events from public,anon,authenticated;
grant select on public.credit_limit_exception_events to authenticated;
drop policy if exists credit_limit_exception_events_read on public.credit_limit_exception_events;
create policy credit_limit_exception_events_read on public.credit_limit_exception_events for select to authenticated
 using(public.has_role(auth.uid(),'admin') or exists(
   select 1 from public.credit_limit_exceptions e where e.id=exception_id and e.salesman_id=auth.uid()
 ));
create or replace function public.log_credit_limit_exception_event() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if tg_op='INSERT' then
  insert into public.credit_limit_exception_events(exception_id,actor_id,action,reason)
  values(new.id,auth.uid(),'requested',new.reason);
 elsif new.status is distinct from old.status then
  insert into public.credit_limit_exception_events(exception_id,actor_id,action,reason)
  values(new.id,coalesce(auth.uid(),new.decided_by),new.status,new.decision_reason);
 end if;
 return new;
end $$;
drop trigger if exists credit_limit_exception_audit on public.credit_limit_exceptions;
create trigger credit_limit_exception_audit after insert or update of status on public.credit_limit_exceptions
 for each row execute function public.log_credit_limit_exception_event();
revoke all on function public.log_credit_limit_exception_event() from public,anon,authenticated;

-- Replace the legacy sale function with the same stock/IMEI validation plus a
-- narrowly scoped exception check. Only record_sale_v2 sets this transaction-local
-- value after checking the exact approved cart; direct record_sale calls stay capped.
create or replace function public.record_sale(
 _retailer uuid,_items jsonb,_paid numeric,_discount numeric,_date date,_op uuid
) returns uuid language plpgsql security definer set search_path=public as $$
declare it jsonb; p record; im text; n int; sid uuid; tot numeric:=0; me uuid:=auth.uid();
 price numeric; disc numeric:=coalesce(_discount,0); lim numeric; due_after numeric; ucost numeric;
 exception_text text; ex public.credit_limit_exceptions%rowtype; expected_disc numeric;
begin
 perform set_config('app.via_rpc','on',true);
 if _op is not null then select id into sid from public.sales where client_op_id=_op; if sid is not null then return sid; end if; end if;
 if disc<0 or coalesce(_paid,0)<0 then raise exception 'Invalid discount or paid amount'; end if;
 if jsonb_typeof(_items)<>'array' or jsonb_array_length(_items)=0 then raise exception 'Sale items are required'; end if;
 select credit_limit into lim from public.retailers where id=_retailer and salesman_id=me for update;
 if not found then raise exception 'retailer not yours'; end if;
 insert into public.sales(salesman_id,retailer_id,total,paid,discount,invoice_no,client_op_id,txn_date)
 values(me,_retailer,0,coalesce(_paid,0),disc,public.next_doc_no('invoice'),_op,coalesce(_date,(now() at time zone 'Asia/Dhaka')::date)) returning id into sid;
 for it in select * from jsonb_array_elements(_items) loop
  select * into p from public.products where id=(it->>'product_id')::uuid;
  if p.id is null then raise exception 'Product not found'; end if;
  price:=coalesce((it->>'unit_price')::numeric,p.price);
  if price<=0 then raise exception 'Unit price must be positive for %',p.name; end if;
  if p.is_smartphone then
   if coalesce(jsonb_typeof(it->'imeis'),'')<>'array' or jsonb_array_length(it->'imeis')<=0 or coalesce((it->>'qty')::int,0)<>jsonb_array_length(it->'imeis') then raise exception 'Smartphone quantity must match scanned IMEIs'; end if;
   for im in select jsonb_array_elements_text(it->'imeis') loop
    update public.imei_units set status='sold',retailer_id=_retailer
     where imei=im and product_id=p.id and status='with_salesman' and salesman_id=me;
    get diagnostics n=row_count;
    if n=0 then raise exception 'IMEI % not with you',im; end if;
    select cost_price into ucost from public.imei_units where imei=im;
    insert into public.stock_movements(salesman_id,product_id,kind,qty,unit_price,cost_price,imei,sale_id,retailer_id,txn_date)
    values(me,p.id,'sale',1,price,coalesce(ucost,0),im,sid,_retailer,coalesce(_date,(now() at time zone 'Asia/Dhaka')::date));
    tot:=tot+price;
   end loop;
  else
   n:=(it->>'qty')::int;
   if n<=0 or public.holding_qty(me,p.id)<n then raise exception 'Not enough % in hand',p.name; end if;
   insert into public.stock_movements(salesman_id,product_id,kind,qty,unit_price,cost_price,sale_id,retailer_id,txn_date)
   values(me,p.id,'sale',n,price,p.cost_price,sid,_retailer,coalesce(_date,(now() at time zone 'Asia/Dhaka')::date));
   tot:=tot+price*n;
  end if;
 end loop;
 if disc>tot then raise exception 'Discount exceeds sale total'; end if;
 tot:=tot-disc;
 if coalesce(_paid,0)>tot then raise exception 'paid more than total'; end if;
 if lim is not null then
  due_after:=public.retailer_due(_retailer)+(tot-coalesce(_paid,0));
  if due_after>lim then
   exception_text:=nullif(current_setting('app.credit_exception_id',true),'');
   if exception_text is null then raise exception 'Credit limit exceeded for this retailer'; end if;
   select * into ex from public.credit_limit_exceptions
    where id=exception_text::uuid and retailer_id=_retailer and salesman_id=me
      and status='approved' and consumed_at is null for update;
   if not found then raise exception 'Approved credit exception not found or already used'; end if;
   if ex.payload->'items'<>_items or (ex.payload->>'paid')::numeric<>coalesce(_paid,0)
      or nullif(ex.payload->>'date','')::date is distinct from _date then
     raise exception 'Sale details differ from approved request';
   end if;
   if ex.payload->>'discount_mode'='percent' then
    expected_disc:=round((tot+disc)*(ex.payload->>'discount_value')::numeric/100,2);
   elsif ex.payload->>'discount_mode'='fixed' then
    expected_disc:=(ex.payload->>'discount_value')::numeric;
   else raise exception 'Invalid approved discount type'; end if;
   if abs(expected_disc-disc)>0.01 or due_after-lim>ex.over_limit_amount then
    raise exception 'Sale exceeds approved credit exception';
   end if;
   update public.credit_limit_exceptions set status='consumed',consumed_at=now() where id=ex.id;
  end if;
 end if;
 update public.sales set total=tot where id=sid;
 return sid;
end $$;
