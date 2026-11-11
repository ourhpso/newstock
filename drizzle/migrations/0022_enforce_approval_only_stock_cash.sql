-- Phase 2: run immediately AFTER the new application code is deployed.
-- The phase-1 migration (0021) creates the approval RPCs while keeping the
-- previous application compatible. This migration closes the legacy bypass.

revoke all on function public.issue_stock(uuid,jsonb,date,uuid) from public,anon,authenticated;
revoke all on function public.issue_stock(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.return_stock(uuid,jsonb,date,uuid) from public,anon,authenticated;
revoke all on function public.return_stock(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.record_deposit(uuid,numeric,text,text,date,uuid) from public,anon,authenticated;
