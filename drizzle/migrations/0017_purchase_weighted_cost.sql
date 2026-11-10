-- Preserve the incoming unit cost when the first purchase initializes an empty product.
CREATE OR REPLACE FUNCTION public.record_purchase(
  _supplier uuid, _items jsonb, _paid numeric, _date date, _op uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  it jsonb; p record; im text; n int; pid uuid;
  tot numeric := 0; cost numeric;
  d date := coalesce(_date,(now() AT TIME ZONE 'Asia/Dhaka')::date);
  checksum int; digit int; pos int;
BEGIN
  PERFORM set_config('app.via_rpc','on',true);
  IF NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'Owner only'; END IF;
  IF _op IS NOT NULL THEN
    SELECT id INTO pid FROM public.purchases WHERE client_op_id=_op;
    IF pid IS NOT NULL THEN RETURN pid; END IF;
  END IF;
  IF _supplier IS NULL THEN RAISE EXCEPTION 'Supplier required'; END IF;
  PERFORM 1 FROM public.suppliers WHERE id=_supplier FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Supplier not found'; END IF;
  IF _items IS NULL OR jsonb_typeof(_items) <> 'array' OR jsonb_array_length(_items)=0 THEN
    RAISE EXCEPTION 'At least one purchase item is required';
  END IF;
  IF _paid IS NULL OR _paid < 0 THEN RAISE EXCEPTION 'Paid amount cannot be negative'; END IF;

  -- Validate the complete payload before writing any stock or ledger rows.
  FOR it IN SELECT value FROM jsonb_array_elements(_items) LOOP
    IF jsonb_typeof(it) <> 'object' OR coalesce(it->>'product_id','') = '' THEN
      RAISE EXCEPTION 'Every purchase line requires a product';
    END IF;
    SELECT * INTO p FROM public.products WHERE id=(it->>'product_id')::uuid FOR UPDATE;
    IF p.id IS NULL THEN RAISE EXCEPTION 'Product not found'; END IF;
    cost := coalesce((it->>'cost_price')::numeric,p.cost_price);
    IF cost IS NULL OR cost <= 0 OR cost::text IN ('NaN','Infinity','-Infinity') THEN
      RAISE EXCEPTION 'Cost price must be positive for every line';
    END IF;
    IF p.is_smartphone THEN
      IF jsonb_typeof(it->'imeis') IS DISTINCT FROM 'array' OR jsonb_array_length(coalesce(it->'imeis','[]'::jsonb))=0 THEN
        RAISE EXCEPTION 'At least one IMEI is required for %',p.name;
      END IF;
      FOR im IN SELECT jsonb_array_elements_text(it->'imeis') LOOP
        IF im !~ '^[0-9]{15}$' THEN RAISE EXCEPTION 'Invalid 15-digit IMEI: %',im; END IF;
        checksum := 0;
        FOR pos IN 1..15 LOOP
          digit := substr(im,pos,1)::int;
          IF pos % 2 = 0 THEN digit := digit * 2; IF digit > 9 THEN digit := digit - 9; END IF; END IF;
          checksum := checksum + digit;
        END LOOP;
        IF checksum % 10 <> 0 THEN RAISE EXCEPTION 'Invalid IMEI checksum: %',im; END IF;
        tot := tot + cost;
      END LOOP;
    ELSE
      IF coalesce(it->>'qty','') !~ '^[0-9]+$' THEN RAISE EXCEPTION 'Quantity must be a positive integer'; END IF;
      n := (it->>'qty')::int;
      IF n <= 0 THEN RAISE EXCEPTION 'Quantity must be positive'; END IF;
      tot := tot + cost*n;
    END IF;
  END LOOP;
  IF _paid > tot THEN RAISE EXCEPTION 'Paid must be between 0 and purchase total'; END IF;

  INSERT INTO public.purchases(supplier_id,total,paid,doc_no,client_op_id,txn_date,created_by)
    VALUES(_supplier,tot,_paid,public.next_doc_no('purchase'),_op,d,auth.uid()) RETURNING id INTO pid;

  FOR it IN SELECT value FROM jsonb_array_elements(_items) LOOP
    SELECT * INTO p FROM public.products WHERE id=(it->>'product_id')::uuid FOR UPDATE;
    cost := coalesce((it->>'cost_price')::numeric,p.cost_price);
    IF p.is_smartphone THEN
      FOR im IN SELECT jsonb_array_elements_text(it->'imeis') LOOP
        INSERT INTO public.imei_units(product_id,imei,status,cost_price,supplier_id,purchase_id)
          VALUES(p.id,im,'in_stock',cost,_supplier,pid);
        INSERT INTO public.stock_movements(salesman_id,product_id,kind,qty,unit_price,cost_price,imei,batch_no,txn_date)
          VALUES(auth.uid(),p.id,'purchase',1,cost,cost,im,(SELECT doc_no FROM public.purchases WHERE id=pid),d);
      END LOOP;
    ELSE
      n := (it->>'qty')::int;
      UPDATE public.products
        SET cost_price=CASE WHEN stock_qty=0 THEN cost ELSE round(((cost_price*stock_qty)+(cost*n))/(stock_qty+n),2) END,
            stock_qty=stock_qty+n
        WHERE id=p.id;
      INSERT INTO public.stock_movements(salesman_id,product_id,kind,qty,unit_price,cost_price,batch_no,txn_date)
        VALUES(auth.uid(),p.id,'purchase',n,cost,cost,(SELECT doc_no FROM public.purchases WHERE id=pid),d);
    END IF;
  END LOOP;
  RETURN pid;
END $$;
REVOKE ALL ON FUNCTION public.record_purchase(uuid,jsonb,numeric,date,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_purchase(uuid,jsonb,numeric,date,uuid) TO authenticated;

