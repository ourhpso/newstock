CREATE TABLE IF NOT EXISTS public.sr_locations (
  salesman_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy double precision,
  speed double precision,
  heading double precision,
  is_sharing boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sr_locations_updated_at_idx ON public.sr_locations(updated_at DESC);
ALTER TABLE public.sr_locations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sr_locations_read_admin ON public.sr_locations;
CREATE POLICY sr_locations_read_admin ON public.sr_locations FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin'));
DROP POLICY IF EXISTS sr_locations_read_own ON public.sr_locations;
CREATE POLICY sr_locations_read_own ON public.sr_locations FOR SELECT TO authenticated USING (salesman_id=auth.uid());
DROP POLICY IF EXISTS sr_locations_insert_own ON public.sr_locations;
CREATE POLICY sr_locations_insert_own ON public.sr_locations FOR INSERT TO authenticated WITH CHECK (salesman_id=auth.uid() AND public.has_role(auth.uid(),'salesman'));
DROP POLICY IF EXISTS sr_locations_update_own ON public.sr_locations;
CREATE POLICY sr_locations_update_own ON public.sr_locations FOR UPDATE TO authenticated USING (salesman_id=auth.uid() AND public.has_role(auth.uid(),'salesman')) WITH CHECK (salesman_id=auth.uid() AND public.has_role(auth.uid(),'salesman'));
GRANT SELECT, INSERT, UPDATE ON public.sr_locations TO authenticated;
GRANT ALL ON public.sr_locations TO service_role;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='sr_locations') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sr_locations;
  END IF;
END $$;
