DROP POLICY IF EXISTS "products admin write" ON public.products;
DROP POLICY IF EXISTS "products admin insert" ON public.products;
DROP POLICY IF EXISTS "products admin update" ON public.products;
DROP POLICY IF EXISTS "products admin delete" ON public.products;
CREATE POLICY "products admin insert" ON public.products FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "products admin update" ON public.products FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "products admin delete" ON public.products FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "imei admin write" ON public.imei_units;
DROP POLICY IF EXISTS "imei admin insert" ON public.imei_units;
DROP POLICY IF EXISTS "imei admin update" ON public.imei_units;
DROP POLICY IF EXISTS "imei admin delete" ON public.imei_units;
CREATE POLICY "imei admin insert" ON public.imei_units FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "imei admin update" ON public.imei_units FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "imei admin delete" ON public.imei_units FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

DO $$
BEGIN
  IF to_regprocedure('public.rls_auto_enable()') IS NOT NULL THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated';
  END IF;
END
$$;
