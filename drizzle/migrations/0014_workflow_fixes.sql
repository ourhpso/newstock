-- 0014: full-workflow audit fixes (sales/retailers/settlement/dashboard/purchases/settings).

CREATE OR REPLACE FUNCTION public.record_retailer_return(_retailer uuid, _items jsonb, _date date, _op uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE it jsonb; p record; im text; n int; rid uuid; tot numeric := 0; me uuid := auth.uid(); price numeric; sid uuid; d date := coalesce(_date,(now() AT TIME ZONE 'Asia/Dhaka')::date); sold_qty int; ret_qty int; ucost numeric; rsm uuid;
BEGIN
  PERFORM set_config('app.via_rpc','on',true);
  IF _op IS NOT NULL THEN SELECT id INTO rid FROM public.retailer_returns WHERE client_op_id=_op; IF rid IS NOT NULL THEN RETURN rid; END IF; END IF;
  SELECT salesman_id INTO rsm FROM retailers WHERE id=_retailer;
  IF rsm IS NULL THEN RAISE EXCEPTION 'Retailer not found'; END IF;
  IF rsm <> me AND NOT public.has_role(me,'admin') THEN RAISE EXCEPTION 'retailer not yours'; END IF;
  -- The return is attributed to the retailer's salesman (not the caller), so
  -- his holding, ledger and return visibility all stay consistent.
  INSERT INTO public.retailer_returns(retailer_id,salesman_id,total,doc_no,client_op_id,txn_date)
    VALUES(_retailer,rsm,0,public.next_doc_no('sale_return'),_op,d) RETURNING id INTO rid;
  FOR it IN SELECT * FROM jsonb_array_elements(_items) LOOP
    SELECT * INTO p FROM products WHERE id=(it->>'product_id')::uuid;
    price := coalesce((it->>'unit_price')::numeric, p.price);
    IF price <= 0 THEN RAISE EXCEPTION 'Return price must be positive'; END IF;
    IF p.is_smartphone THEN
      FOR im IN SELECT jsonb_array_elements_text(it->'imeis') LOOP
        sid := NULL;
        SELECT sale_id INTO sid FROM stock_movements WHERE imei=im AND kind='sale' ORDER BY created_at DESC LIMIT 1;
        UPDATE imei_units SET status='with_salesman', retailer_id=NULL, salesman_id=rsm
          WHERE imei=im AND product_id=p.id AND status='sold' AND retailer_id=_retailer;
        GET DIAGNOSTICS n = ROW_COUNT;
        IF n=0 THEN RAISE EXCEPTION 'IMEI % was not sold to this retailer', im; END IF;
        SELECT cost_price INTO ucost FROM imei_units WHERE imei=im;
        INSERT INTO stock_movements(salesman_id,product_id,kind,qty,unit_price,cost_price,imei,sale_id,retailer_id,batch_no,txn_date)
          VALUES(rsm,p.id,'sale_return',1,price,coalesce(ucost,0),im,sid,_retailer,(SELECT doc_no FROM public.retailer_returns WHERE id=rid),d);
        tot := tot + price;
      END LOOP;
    ELSE
      n := (it->>'qty')::int;
      IF n <= 0 THEN RAISE EXCEPTION 'Quantity must be positive'; END IF;
      SELECT coalesce(sum(qty),0) INTO sold_qty FROM stock_movements WHERE kind='sale' AND retailer_id=_retailer AND product_id=p.id;
      SELECT coalesce(sum(qty),0) INTO ret_qty FROM stock_movements WHERE kind='sale_return' AND retailer_id=_retailer AND product_id=p.id;
      IF ret_qty + n > sold_qty THEN RAISE EXCEPTION 'Return more than sold for %', p.name; END IF;
      INSERT INTO stock_movements(salesman_id,product_id,kind,qty,unit_price,cost_price,retailer_id,batch_no,txn_date)
        VALUES(rsm,p.id,'sale_return',n,price,p.cost_price,_retailer,(SELECT doc_no FROM public.retailer_returns WHERE id=rid),d);
      tot := tot + price*n;
    END IF;
  END LOOP;
  UPDATE public.retailer_returns SET total=tot, sale_id=(SELECT sale_id FROM stock_movements WHERE batch_no=(SELECT doc_no FROM public.retailer_returns WHERE id=rid) AND sale_id IS NOT NULL LIMIT 1) WHERE id=rid;
  IF tot > public.retailer_due(_retailer) + tot THEN RAISE EXCEPTION 'Return exceeds retailer due'; END IF;
  RETURN rid;
END $$;
REVOKE ALL ON FUNCTION public.record_retailer_return(uuid,jsonb,date,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_retailer_return(uuid,jsonb,date,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.dealer_risk_history() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public AS $$
DECLARE result jsonb;
BEGIN
 IF NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'Owner only'; END IF;
 WITH payments AS(SELECT retailer_id,sum(amount) amount,max(created_at) last_payment,count(*) payment_count FROM retailer_payments GROUP BY retailer_id),
 returns_t AS(SELECT retailer_id,sum(total) amount FROM retailer_returns GROUP BY retailer_id),
 invoices AS(SELECT s.*,coalesce(r0.due_days,30) due_days,coalesce(p.amount,0)+coalesce(rt.amount,0) settled,coalesce(sum(greatest(s.total-s.paid,0)) OVER(PARTITION BY s.retailer_id ORDER BY s.txn_date,s.created_at,s.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) prior FROM sales s LEFT JOIN retailers r0 ON r0.id=s.retailer_id LEFT JOIN payments p ON p.retailer_id=s.retailer_id LEFT JOIN returns_t rt ON rt.retailer_id=s.retailer_id),
 balances AS(SELECT *,greatest(greatest(total-paid,0)-greatest(settled-prior,0),0) remaining FROM invoices),
 totals AS(SELECT retailer_id,count(*) invoice_count,sum(total) sales_total,sum(paid) paid_at_sale,sum(remaining) total_due,coalesce(sum(remaining) FILTER(WHERE txn_date<=((now() AT TIME ZONE 'Asia/Dhaka')::date - due_days)),0) overdue_amount,coalesce(((now() AT TIME ZONE 'Asia/Dhaka')::date - min(txn_date) FILTER(WHERE remaining>0)),0) age_days,max(created_at) last_sale FROM balances GROUP BY retailer_id),
 returns AS(SELECT retailer_id,sum(qty) return_qty,sum(qty*unit_price) return_value FROM stock_movements WHERE kind IN('return','damage','sale_return') AND retailer_id IS NOT NULL GROUP BY retailer_id)
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'phone',r.phone,'salesman_name',pr.full_name,'invoice_count',coalesce(t.invoice_count,0),'sales_total',coalesce(t.sales_total,0),'paid_at_sale',coalesce(t.paid_at_sale,0),'collected',coalesce(p.amount,0),'payment_count',coalesce(p.payment_count,0),'last_payment',p.last_payment,'last_sale',t.last_sale,'total_due',coalesce(t.total_due,0),'overdue_amount',coalesce(t.overdue_amount,0),'age_days',coalesce(t.age_days,0),'linked_return_qty',coalesce(rt.return_qty,0),'linked_return_value',coalesce(rt.return_value,0),'unattributed_return_count',(SELECT count(*) FROM stock_movements WHERE kind IN('return','damage') AND retailer_id IS NULL AND salesman_id=r.salesman_id),'blocked',coalesce(b.blocked,false)) ORDER BY r.id),'[]'::jsonb) INTO result FROM retailers r LEFT JOIN profiles pr ON pr.id=r.salesman_id LEFT JOIN totals t ON t.retailer_id=r.id LEFT JOIN payments p ON p.retailer_id=r.id LEFT JOIN returns rt ON rt.retailer_id=r.id LEFT JOIN dealer_blocks b ON b.retailer_id=r.id;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.supplier_due(_supplier uuid) RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'Owner only'; END IF;
  RETURN coalesce((SELECT sum(total - paid) FROM public.purchases WHERE supplier_id=_supplier),0)
       - coalesce((SELECT sum(amount) FROM public.supplier_payments WHERE supplier_id=_supplier),0);
END $$;

CREATE OR REPLACE FUNCTION public.record_purchase(_supplier uuid, _items jsonb, _paid numeric, _date date, _op uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE it jsonb; p record; im text; n int; pid uuid; tot numeric := 0; cost numeric; d date := coalesce(_date,(now() AT TIME ZONE 'Asia/Dhaka')::date);
BEGIN
  PERFORM set_config('app.via_rpc','on',true);
  IF NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'Owner only'; END IF;
  IF _op IS NOT NULL THEN SELECT id INTO pid FROM public.purchases WHERE client_op_id=_op; IF pid IS NOT NULL THEN RETURN pid; END IF; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.suppliers WHERE id=_supplier) THEN RAISE EXCEPTION 'Supplier not found'; END IF;
  INSERT INTO public.purchases(supplier_id,total,paid,doc_no,client_op_id,txn_date,created_by)
    VALUES(_supplier,0,coalesce(_paid,0),public.next_doc_no('purchase'),_op,d,auth.uid()) RETURNING id INTO pid;
  FOR it IN SELECT * FROM jsonb_array_elements(_items) LOOP
    SELECT * INTO p FROM products WHERE id=(it->>'product_id')::uuid FOR UPDATE;
    IF p.id IS NULL THEN RAISE EXCEPTION 'Product not found'; END IF;
    cost := coalesce((it->>'cost_price')::numeric, p.cost_price);
    IF cost <= 0 THEN RAISE EXCEPTION 'Cost price must be positive for every line'; END IF;
    IF p.is_smartphone THEN
      FOR im IN SELECT jsonb_array_elements_text(it->'imeis') LOOP
        INSERT INTO public.imei_units(product_id,imei,status,cost_price,supplier_id,purchase_id)
          VALUES(p.id,im,'in_stock',cost,_supplier,pid);
        INSERT INTO public.stock_movements(salesman_id,product_id,kind,qty,unit_price,cost_price,imei,batch_no,txn_date)
          VALUES(auth.uid(),p.id,'purchase',1,cost,cost,im,(SELECT doc_no FROM public.purchases WHERE id=pid),d);
        tot := tot + cost;
      END LOOP;
    ELSE
      n := (it->>'qty')::int;
      IF n <= 0 THEN RAISE EXCEPTION 'Quantity must be positive'; END IF;
      -- moving-average cost for non-IMEI stock
      UPDATE products SET cost_price = CASE WHEN stock_qty + n > 0 THEN round(((cost_price*stock_qty) + (cost*n)) / (stock_qty + n), 2) ELSE cost END,
                          stock_qty = stock_qty + n WHERE id=p.id;
      INSERT INTO public.stock_movements(salesman_id,product_id,kind,qty,unit_price,cost_price,batch_no,txn_date)
        VALUES(auth.uid(),p.id,'purchase',n,cost,cost,(SELECT doc_no FROM public.purchases WHERE id=pid),d);
      tot := tot + cost*n;
    END IF;
  END LOOP;
  IF coalesce(_paid,0) < 0 OR coalesce(_paid,0) > tot THEN RAISE EXCEPTION 'Paid must be between 0 and purchase total'; END IF;
  UPDATE public.purchases SET total=tot WHERE id=pid;
  RETURN pid;
END $$;
REVOKE ALL ON FUNCTION public.record_purchase(uuid,jsonb,numeric,date,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_purchase(uuid,jsonb,numeric,date,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.restore_business_data(_confirmation text,_snapshot jsonb,_backup_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE tab text; row_data jsonb; saved jsonb; BEGIN
IF NOT public.has_role(auth.uid(),'admin') OR _confirmation IS DISTINCT FROM 'RESTORE FIROZA' THEN RAISE EXCEPTION 'Owner confirmation required'; END IF;
IF _snapshot->>'format' IS DISTINCT FROM 'firoza-business-data' OR _snapshot->>'version' IS DISTINCT FROM '1' OR octet_length(_snapshot::text)>20971520 THEN RAISE EXCEPTION 'Invalid backup format or size'; END IF;
-- Only authentic exports from this database are eligible, preventing fabricated stock/account histories.
SELECT snapshot INTO saved FROM business_exports WHERE id=(_snapshot->>'source')::uuid;
IF saved IS NULL THEN RAISE EXCEPTION 'Backup is modified or belongs to another installation'; END IF;
-- Compare key by key over the STORED snapshot's keys only: backups exported
-- before 0013 hold 9 table keys while the client now re-serialises 14 (the
-- extra keys default to empty), and those older backups must stay restorable.
IF EXISTS(SELECT 1 FROM jsonb_each(saved) e WHERE (_snapshot->'tables'->e.key) IS DISTINCT FROM e.value) THEN RAISE EXCEPTION 'Backup is modified or belongs to another installation'; END IF;
PERFORM public.reset_business_data('RESET FIROZA',_backup_id);
INSERT INTO suppliers SELECT * FROM jsonb_populate_recordset(NULL::public.suppliers,saved->'suppliers');
INSERT INTO purchases SELECT * FROM jsonb_populate_recordset(NULL::public.purchases,saved->'purchases');
INSERT INTO products SELECT * FROM jsonb_populate_recordset(NULL::public.products,saved->'products');
INSERT INTO retailers SELECT * FROM jsonb_populate_recordset(NULL::public.retailers,saved->'retailers');
INSERT INTO imei_units SELECT * FROM jsonb_populate_recordset(NULL::public.imei_units,saved->'imei_units');
-- Restore sales before blocks so the sales-insert protection remains untouched.
INSERT INTO sales SELECT * FROM jsonb_populate_recordset(NULL::public.sales,saved->'sales');
INSERT INTO stock_movements SELECT * FROM jsonb_populate_recordset(NULL::public.stock_movements,saved->'stock_movements');
INSERT INTO retailer_payments SELECT * FROM jsonb_populate_recordset(NULL::public.retailer_payments,saved->'retailer_payments');
INSERT INTO deposits SELECT * FROM jsonb_populate_recordset(NULL::public.deposits,saved->'deposits');
INSERT INTO retailer_returns SELECT * FROM jsonb_populate_recordset(NULL::public.retailer_returns,saved->'retailer_returns');
INSERT INTO supplier_payments SELECT * FROM jsonb_populate_recordset(NULL::public.supplier_payments,saved->'supplier_payments');
INSERT INTO expenses SELECT * FROM jsonb_populate_recordset(NULL::public.expenses,saved->'expenses');
-- AI advice and blocking are not restored: every block requires a new explicit dealer confirmation.
INSERT INTO business_audit(actor,action,reason,after_data) VALUES(auth.uid(),'restore','RESTORE FIROZA',jsonb_build_object('source',_snapshot->>'source','safety_backup',_backup_id)); END; $$;
CREATE OR REPLACE FUNCTION public.cancel_business_history(_table text,_id uuid,_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE r record; m record; p record; old jsonb; BEGIN
IF NOT public.has_role(auth.uid(),'admin') OR length(trim(_reason))<3 THEN RAISE EXCEPTION 'Owner and reason required'; END IF;
LOCK TABLE products,retailers,imei_units,sales,stock_movements,retailer_payments,deposits,dealer_blocks,dealer_risk_assessments IN SHARE ROW EXCLUSIVE MODE;
IF _table='sales' THEN
 SELECT * INTO r FROM sales WHERE id=_id FOR UPDATE; IF r.id IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;
 IF (SELECT coalesce(sum(amount),0) FROM retailer_payments WHERE retailer_id=r.retailer_id) + (SELECT coalesce(sum(total),0) FROM retailer_returns WHERE retailer_id=r.retailer_id)
      > (SELECT coalesce(sum(greatest(total-paid,0)),0) FROM sales WHERE retailer_id=r.retailer_id AND (txn_date,created_at,id) < (r.txn_date,r.created_at,r.id))
   THEN RAISE EXCEPTION 'Payments or returns already cover this invoice; reconcile them before cancelling invoice'; END IF;
 IF EXISTS(SELECT 1 FROM stock_movements WHERE sale_id=_id AND kind='sale_return') THEN RAISE EXCEPTION 'Invoice has sales returns; reconcile them before cancelling invoice'; END IF;
 IF public.salesman_cash(r.salesman_id) - r.paid < 0 THEN RAISE EXCEPTION 'Cash from this invoice was already deposited; reverse the deposit first'; END IF;
 old:=jsonb_build_object('sale',to_jsonb(r),'items',(SELECT jsonb_agg(to_jsonb(t)) FROM stock_movements t WHERE sale_id=_id));
 FOR m IN SELECT * FROM stock_movements WHERE sale_id=_id LOOP
 IF m.imei IS NOT NULL THEN
 IF EXISTS(SELECT 1 FROM stock_movements WHERE imei=m.imei AND created_at>m.created_at) THEN RAISE EXCEPTION 'Later IMEI history prevents cancellation'; END IF;
 UPDATE imei_units SET status='with_salesman',retailer_id=NULL WHERE imei=m.imei AND status='sold' AND salesman_id=m.salesman_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'IMEI state has changed'; END IF;
 END IF;
 END LOOP;
 DELETE FROM stock_movements WHERE sale_id=_id; DELETE FROM sales WHERE id=_id;
ELSIF _table='stock_movements' THEN
 SELECT * INTO m FROM stock_movements WHERE id=_id FOR UPDATE; IF m.id IS NULL THEN RAISE EXCEPTION 'Movement not found'; END IF;
 IF m.kind='sale' THEN RAISE EXCEPTION 'Cancel the whole invoice instead'; END IF;
 IF m.kind='purchase' THEN RAISE EXCEPTION 'Cancel the purchase record instead of its stock movement'; END IF;
 IF m.kind='sale_return' THEN RAISE EXCEPTION 'Reverse a sales return from the retailer record instead of cancelling its movement'; END IF;
 IF EXISTS(SELECT 1 FROM stock_movements WHERE salesman_id=m.salesman_id AND product_id=m.product_id AND (created_at>m.created_at OR (created_at=m.created_at AND id<>m.id))) THEN RAISE EXCEPTION 'Later stock history prevents cancellation'; END IF;
 SELECT * INTO p FROM products WHERE id=m.product_id FOR UPDATE;
 old:=to_jsonb(m);
 IF m.imei IS NOT NULL THEN
 IF m.kind='issue' THEN
 UPDATE imei_units SET status='in_stock',salesman_id=NULL,retailer_id=NULL WHERE imei=m.imei AND status='with_salesman' AND salesman_id=m.salesman_id;
 ELSE
 UPDATE imei_units SET status='with_salesman',salesman_id=m.salesman_id,retailer_id=NULL WHERE imei=m.imei AND status=(CASE WHEN m.kind='damage' THEN 'damaged'::imei_status ELSE 'in_stock'::imei_status END) AND salesman_id IS NULL;
 END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'IMEI state has changed'; END IF;
 ELSE
 IF m.kind='issue' THEN
 IF public.holding_qty(m.salesman_id,m.product_id)<m.qty THEN RAISE EXCEPTION 'Issued stock no longer in hand'; END IF;
 UPDATE products SET stock_qty=stock_qty+m.qty WHERE id=m.product_id;
 ELSIF m.kind='return' THEN
 IF p.stock_qty<m.qty THEN RAISE EXCEPTION 'Returned stock no longer available'; END IF;
 UPDATE products SET stock_qty=stock_qty-m.qty WHERE id=m.product_id;
 ELSIF m.kind IN ('purchase','opening') THEN
 IF p.stock_qty<m.qty THEN RAISE EXCEPTION 'Stock no longer available to reverse'; END IF;
 UPDATE products SET stock_qty=stock_qty-m.qty WHERE id=m.product_id;
 ELSIF m.kind='adjustment' THEN
 IF p.stock_qty-m.qty<0 THEN RAISE EXCEPTION 'Stock no longer available to reverse'; END IF;
 UPDATE products SET stock_qty=stock_qty-m.qty WHERE id=m.product_id;
 END IF;
 END IF;
 DELETE FROM stock_movements WHERE id=_id;
ELSIF _table='expenses' THEN
 SELECT * INTO r FROM expenses WHERE id=_id FOR UPDATE; IF r.id IS NULL THEN RAISE EXCEPTION 'Expense not found'; END IF;
 old:=to_jsonb(r);
 DELETE FROM expenses WHERE id=_id;
ELSIF _table='supplier_payments' THEN
 SELECT * INTO r FROM supplier_payments WHERE id=_id FOR UPDATE; IF r.id IS NULL THEN RAISE EXCEPTION 'Supplier payment not found'; END IF;
 old:=to_jsonb(r);
 DELETE FROM supplier_payments WHERE id=_id;
ELSIF _table='retailer_returns' THEN
 SELECT * INTO r FROM retailer_returns WHERE id=_id FOR UPDATE; IF r.id IS NULL THEN RAISE EXCEPTION 'Return not found'; END IF;
 old:=to_jsonb(r);
 FOR m IN SELECT * FROM stock_movements WHERE batch_no=r.doc_no AND kind='sale_return' LOOP
  IF m.imei IS NOT NULL THEN
   UPDATE imei_units SET status='sold',retailer_id=r.retailer_id,salesman_id=m.salesman_id WHERE imei=m.imei AND status='with_salesman' AND salesman_id=m.salesman_id;
   IF NOT FOUND THEN RAISE EXCEPTION 'Returned unit already resold; cannot reverse this return'; END IF;
  END IF;
 END LOOP;
 DELETE FROM stock_movements WHERE batch_no=r.doc_no AND kind='sale_return';
 DELETE FROM retailer_returns WHERE id=_id;
ELSIF _table='purchases' THEN
 SELECT * INTO r FROM purchases WHERE id=_id FOR UPDATE; IF r.id IS NULL THEN RAISE EXCEPTION 'Purchase not found'; END IF;
 old:=to_jsonb(r);
 IF public.supplier_due(r.supplier_id) - (r.total - r.paid) < 0 THEN RAISE EXCEPTION 'Supplier payments already cover this purchase; reconcile them first'; END IF;
 FOR m IN SELECT * FROM stock_movements WHERE batch_no=r.doc_no AND kind='purchase' LOOP
  SELECT * INTO p FROM products WHERE id=m.product_id FOR UPDATE;
  IF m.imei IS NOT NULL THEN
   DELETE FROM imei_units WHERE imei=m.imei AND purchase_id=_id AND status='in_stock';
   IF NOT FOUND THEN RAISE EXCEPTION 'Some purchased units already issued or sold; cannot cancel this purchase'; END IF;
  ELSE
   IF p.stock_qty < m.qty THEN RAISE EXCEPTION 'Purchased stock already moved; cannot cancel this purchase'; END IF;
   UPDATE products SET stock_qty = stock_qty - m.qty, cost_price = CASE WHEN (stock_qty - m.qty) > 0 THEN round(((cost_price*stock_qty) - (m.cost_price*m.qty)) / (stock_qty - m.qty), 2) ELSE cost_price END WHERE id=p.id;
  END IF;
 END LOOP;
 DELETE FROM stock_movements WHERE batch_no=r.doc_no AND kind='purchase';
 DELETE FROM purchases WHERE id=_id;
ELSE RAISE EXCEPTION 'Unsupported history'; END IF;
INSERT INTO business_audit(actor,action,entity,entity_id,reason,before_data) VALUES(auth.uid(),'cancel',_table,_id,_reason,old);
END; $$;

CREATE OR REPLACE FUNCTION public.manage_business_record(_table text,_id uuid,_action text,_values jsonb,_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE old jsonb; updated jsonb; owner boolean:=public.has_role(auth.uid(),'admin'); r record; BEGIN
IF auth.uid() IS NULL OR length(trim(_reason))<3 OR _action NOT IN ('update','delete') THEN RAISE EXCEPTION 'Valid reason and authentication required'; END IF;
IF NOT owner AND _table<>'retailers' THEN RAISE EXCEPTION 'Owner only'; END IF;
IF _table='products' THEN
 SELECT to_jsonb(p) INTO old FROM products p WHERE id=_id FOR UPDATE;
 IF _action='delete' THEN
 IF EXISTS(SELECT 1 FROM stock_movements WHERE product_id=_id) OR EXISTS(SELECT 1 FROM imei_units WHERE product_id=_id) OR coalesce((old->>'stock_qty')::int,0)<>0 THEN RAISE EXCEPTION 'Product has stock or history; cannot delete'; END IF;
 DELETE FROM products WHERE id=_id;
 ELSE
 IF length(trim(_values->>'name'))=0 OR (_values->>'price')::numeric<0 THEN RAISE EXCEPTION 'Invalid product name or price'; END IF;
 UPDATE products SET name=trim(_values->>'name'),model=nullif(_values->>'model',''),price=(_values->>'price')::numeric WHERE id=_id RETURNING to_jsonb(products.*) INTO updated;
 END IF;
ELSIF _table='retailers' THEN
 SELECT to_jsonb(t) INTO old FROM retailers t WHERE id=_id AND (owner OR salesman_id=auth.uid()) FOR UPDATE;
 IF old IS NULL THEN RAISE EXCEPTION 'Retailer not available'; END IF;
 IF _action='delete' THEN
 IF EXISTS(SELECT 1 FROM sales WHERE retailer_id=_id) OR EXISTS(SELECT 1 FROM retailer_payments WHERE retailer_id=_id) OR EXISTS(SELECT 1 FROM stock_movements WHERE retailer_id=_id) OR EXISTS(SELECT 1 FROM dealer_blocks WHERE retailer_id=_id) OR EXISTS(SELECT 1 FROM dealer_risk_assessments WHERE retailer_id=_id) THEN RAISE EXCEPTION 'Retailer has history; cannot delete'; END IF;
 DELETE FROM retailers WHERE id=_id;
 ELSE
 IF length(trim(_values->>'name'))=0 THEN RAISE EXCEPTION 'Name required'; END IF;
 UPDATE retailers SET name=trim(_values->>'name'),phone=_values->>'phone',address=_values->>'address' WHERE id=_id RETURNING to_jsonb(retailers.*) INTO updated;
 END IF;
ELSIF _table='profiles' THEN
 SELECT to_jsonb(p) INTO old FROM profiles p WHERE id=_id FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM user_roles WHERE user_id=_id AND role='salesman') THEN RAISE EXCEPTION 'Only salesman profiles can be managed'; END IF;
 IF _action='delete' THEN
 IF EXISTS(SELECT 1 FROM stock_movements WHERE salesman_id=_id) OR EXISTS(SELECT 1 FROM sales WHERE salesman_id=_id) OR EXISTS(SELECT 1 FROM retailers WHERE salesman_id=_id) OR EXISTS(SELECT 1 FROM deposits WHERE salesman_id=_id) THEN RAISE EXCEPTION 'Salesman has history; reconcile and deactivate instead'; END IF;
 UPDATE profiles SET active=false WHERE id=_id RETURNING to_jsonb(profiles.*) INTO updated;
 ELSE
 IF length(trim(_values->>'full_name'))=0 THEN RAISE EXCEPTION 'Name required'; END IF;
 UPDATE profiles SET full_name=trim(_values->>'full_name'),phone=_values->>'phone' WHERE id=_id RETURNING to_jsonb(profiles.*) INTO updated;
 END IF;
ELSIF _table IN ('sales','stock_movements') THEN
 RAISE EXCEPTION 'Stock and sales history cannot be rewritten; use validated sale/return/issue functions';
ELSIF _table IN ('retailer_payments','deposits') THEN
 IF _table='retailer_payments' THEN
 SELECT * INTO r FROM retailer_payments WHERE id=_id FOR UPDATE; old:=to_jsonb(r);
 IF _action='delete' THEN IF public.salesman_cash(r.salesman_id) - r.amount < 0 THEN RAISE EXCEPTION 'Collection already deposited; reverse the deposit first'; END IF; DELETE FROM retailer_payments WHERE id=_id;
 ELSE
 IF (_values->>'amount')::numeric<=0 OR (_values->>'amount') IS NULL THEN RAISE EXCEPTION 'Positive amount required'; END IF;
 IF (_values->>'amount')::numeric>(SELECT coalesce(sum(total-paid),0) FROM sales WHERE retailer_id=r.retailer_id)-(SELECT coalesce(sum(amount),0) FROM retailer_payments WHERE retailer_id=r.retailer_id AND id<>_id)-(SELECT coalesce(sum(total),0) FROM retailer_returns WHERE retailer_id=r.retailer_id) THEN RAISE EXCEPTION 'Amount exceeds retailer due'; END IF;
 UPDATE retailer_payments SET amount=(_values->>'amount')::numeric,note=_values->>'note' WHERE id=_id RETURNING to_jsonb(retailer_payments.*) INTO updated;
 END IF;
 ELSE
 SELECT * INTO r FROM deposits WHERE id=_id FOR UPDATE; old:=to_jsonb(r);
 IF _action='delete' THEN DELETE FROM deposits WHERE id=_id;
 ELSE
 IF (_values->>'amount')::numeric<=0 OR (_values->>'amount') IS NULL THEN RAISE EXCEPTION 'Positive amount required'; END IF;
 IF (_values->>'amount')::numeric > public.salesman_cash(r.salesman_id) + r.amount THEN RAISE EXCEPTION 'Amount exceeds cash in hand'; END IF;
  UPDATE deposits SET amount=(_values->>'amount')::numeric,note=_values->>'note' WHERE id=_id RETURNING to_jsonb(deposits.*) INTO updated;
 END IF;
 END IF;
ELSIF _table='imei_units' THEN
 SELECT to_jsonb(t) INTO old FROM imei_units t WHERE id=_id FOR UPDATE;
 IF old->>'status'<>'in_stock' OR EXISTS(SELECT 1 FROM stock_movements WHERE imei=old->>'imei') THEN RAISE EXCEPTION 'IMEI has history or is not in stock'; END IF;
 IF _action<>'delete' THEN RAISE EXCEPTION 'Delete unused IMEI then register the correct IMEI'; END IF;
 DELETE FROM imei_units WHERE id=_id;
ELSE RAISE EXCEPTION 'Unsupported list'; END IF;
IF old IS NULL THEN RAISE EXCEPTION 'Record not found'; END IF;
INSERT INTO business_audit(actor,action,entity,entity_id,reason,before_data,after_data) VALUES(auth.uid(),_action,_table,_id,_reason,old,updated);
END; $$;

-- Server-side salesman summary: the client hook used to fetch six tables and
-- sum in the browser, silently truncated by PostgREST's 1,000-row default cap.
CREATE OR REPLACE FUNCTION public.salesman_summary(_salesman uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT (auth.uid() = _salesman OR public.has_role(auth.uid(),'admin')) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  WITH per AS (
    SELECT m.product_id, pr.name, pr.is_smartphone,
      coalesce(sum(m.qty) FILTER (WHERE m.kind='issue'),0) issued,
      coalesce(sum(m.qty) FILTER (WHERE m.kind='sale'),0) sold,
      coalesce(sum(m.qty) FILTER (WHERE m.kind='return'),0) returned,
      coalesce(sum(m.qty) FILTER (WHERE m.kind='damage'),0) damaged,
      coalesce(sum(m.qty) FILTER (WHERE m.kind IN ('issue','sale_return')),0) - coalesce(sum(m.qty) FILTER (WHERE m.kind IN ('sale','return','damage')),0) hand,
      coalesce(sum(m.qty*m.unit_price) FILTER (WHERE m.kind IN ('issue','sale_return')),0) - coalesce(sum(m.qty*m.unit_price) FILTER (WHERE m.kind IN ('sale','return','damage')),0) value,
      coalesce(sum(m.qty*m.unit_price) FILTER (WHERE m.kind='issue'),0) issued_value,
      coalesce(sum(m.qty*m.unit_price) FILTER (WHERE m.kind IN ('return','damage')),0) returned_value
    FROM public.stock_movements m JOIN public.products pr ON pr.id = m.product_id
    WHERE m.salesman_id = _salesman
    GROUP BY m.product_id, pr.name, pr.is_smartphone
  ),
  agg AS (
    SELECT (SELECT coalesce(sum(total),0) FROM public.sales WHERE salesman_id=_salesman) sales_total,
           (SELECT coalesce(sum(paid),0) FROM public.sales WHERE salesman_id=_salesman) sales_paid,
           (SELECT coalesce(sum(amount),0) FROM public.retailer_payments WHERE salesman_id=_salesman) collected,
           (SELECT coalesce(sum(amount),0) FROM public.deposits WHERE salesman_id=_salesman) deposited,
           (SELECT coalesce(sum(total),0) FROM public.retailer_returns WHERE salesman_id=_salesman) returns_total,
           (SELECT coalesce(sum(issued_value),0) FROM per) issued_value,
           (SELECT coalesce(sum(returned_value),0) FROM per) returned_value
  )
  SELECT jsonb_build_object(
    'products', coalesce((SELECT jsonb_agg(jsonb_build_object('product_id',product_id,'name',name,'isSmart',is_smartphone,'issued',issued,'sold',sold,'returned',returned,'damaged',damaged,'hand',hand,'value',value) ORDER BY name) FROM per),'[]'::jsonb),
    'handImeis', coalesce((SELECT jsonb_agg(jsonb_build_object('imei',imei,'product_id',product_id,'status',status)) FROM public.imei_units WHERE salesman_id=_salesman AND status='with_salesman'),'[]'::jsonb),
    'salesTotal', a.sales_total,
    'cashInHand', a.sales_paid + a.collected - a.deposited,
    'retailerDue', a.sales_total - a.sales_paid - a.collected - a.returns_total,
    'returnsTotal', a.returns_total,
    'deposited', a.deposited,
    'deposits', coalesce((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.created_at DESC) FROM public.deposits d WHERE salesman_id=_salesman),'[]'::jsonb),
    'owesDealer', a.issued_value - a.returned_value - a.deposited
  ) INTO result FROM agg a;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.salesman_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salesman_summary(uuid) TO authenticated;

-- Idempotency key for retailer creation (offline queue replays).
ALTER TABLE public.retailers ADD COLUMN IF NOT EXISTS client_op_id uuid UNIQUE;
