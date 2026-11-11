import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MapPin, Navigation, Radio, RefreshCw } from "lucide-react";
import { PageTitle } from "@/components/Stat";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useSalesmen, requireAdmin } from "@/lib/me";

type LiveLocation = { salesman_id: string; latitude: number; longitude: number; accuracy: number | null; speed: number | null; heading: number | null; is_sharing: boolean; updated_at: string };

export const Route = createFileRoute("/_authenticated/sr-locations")({
  beforeLoad: requireAdmin,
  head: () => ({ meta: [{ title: "SR Live Location — FIROZA ENTERPRISE" }] }),
  component: SrLocations,
});

function SrLocations() {
  const qc = useQueryClient();
  const { data: salesmen = [] } = useSalesmen();
  const [selected, setSelected] = useState<string | null>(null);
  const { data: locations = [], isLoading, isError, refetch } = useQuery({
    queryKey: ["sr-live-locations"],
    queryFn: async () => {
      const { data, error } = await supabase.from("sr_locations").select("*").order("updated_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as LiveLocation[];
    },
    refetchInterval: 15000,
  });
  useEffect(() => {
    const channel = supabase.channel("sr-live-locations-admin").on("postgres_changes", { event: "*", schema: "public", table: "sr_locations" }, () => {
      void qc.invalidateQueries({ queryKey: ["sr-live-locations"] });
    }).subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [qc]);

  const rows = useMemo(() => salesmen.map((s) => ({ ...s, location: locations.find((l) => l.salesman_id === s.id) })).filter((s) => s.active), [salesmen, locations]);
  const chosen = rows.find((r) => r.id === selected) ?? rows.find((r) => r.location?.is_sharing && r.location.latitude && r.location.longitude);
  const liveCount = rows.filter((r) => r.location?.is_sharing && Date.now() - new Date(r.location.updated_at).getTime() < 120000).length;
  const loc = chosen?.location;
  const bbox = loc ? `${loc.longitude - 0.01}%2C${loc.latitude - 0.01}%2C${loc.longitude + 0.01}%2C${loc.latitude + 0.01}` : "";
  const mapUrl = loc ? `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${loc.latitude}%2C${loc.longitude}` : "";

  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-2"><PageTitle>SR Live Location</PageTitle><Button size="sm" variant="outline" onClick={() => void refetch()}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button></div>
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <div className="rounded-2xl border bg-card p-4"><div className="text-xs text-muted-foreground">মোট সক্রিয় SR</div><div className="mt-1 text-2xl font-bold">{rows.length}</div></div>
      <div className="rounded-2xl border bg-card p-4"><div className="text-xs text-muted-foreground">লাইভ / সাম্প্রতিক</div><div className="mt-1 flex items-center gap-2 text-2xl font-bold"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />{liveCount}</div></div>
      <div className="col-span-2 rounded-2xl border bg-card p-4 sm:col-span-1"><div className="text-xs text-muted-foreground">আপডেট</div><div className="mt-1 text-lg font-bold">প্রতি ১৫ সেকেন্ডে</div></div>
    </div>
    {isError && <p className="text-sm text-destructive">লোকেশন লোড করা যায়নি। ডাটাবেস migration ও permission যাচাই করুন।</p>}
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
      <div className="space-y-2">
        {isLoading && <p className="text-sm text-muted-foreground">লোড হচ্ছে…</p>}
        {rows.map((s) => {
          const l = s.location;
          const fresh = !!l?.is_sharing && Date.now() - new Date(l.updated_at).getTime() < 120000;
          return <button key={s.id} type="button" onClick={() => setSelected(s.id)} className={`w-full rounded-xl border p-3 text-left transition-colors ${chosen?.id === s.id ? "border-primary bg-primary/5 ring-1 ring-primary/20" : "bg-card hover:bg-muted/60"}`}>
            <div className="flex items-center justify-between gap-2"><span className="font-bold">{s.full_name}</span><span className={`flex items-center gap-1 text-xs font-semibold ${fresh ? "text-emerald-600" : "text-muted-foreground"}`}><span className={`h-2 w-2 rounded-full ${fresh ? "bg-emerald-500" : "bg-muted-foreground/50"}`} />{fresh ? "LIVE" : l ? "শেষ লোকেশন" : "লোকেশন নেই"}</span></div>
            <div className="mt-1 text-xs text-muted-foreground">{l ? new Date(l.updated_at).toLocaleString("bn-BD") : "SR এখনো লোকেশন শেয়ার করেনি"}</div>
          </button>;
        })}
        {rows.length === 0 && <div className="rounded-xl border bg-card p-5 text-sm text-muted-foreground">কোনো সক্রিয় SR পাওয়া যায়নি।</div>}
      </div>
      <div className="overflow-hidden rounded-2xl border bg-card">
        <div className="flex items-center gap-2 border-b p-3 font-semibold"><MapPin className="h-4 w-4 text-primary" />{chosen?.full_name ?? "SR Map"}</div>
        {loc ? <><iframe title="SR live location map" src={mapUrl} className="h-[360px] w-full border-0 sm:h-[480px]" loading="lazy" referrerPolicy="no-referrer-when-downgrade" /><div className="flex flex-wrap items-center justify-between gap-2 p-3 text-xs text-muted-foreground"><span>±{loc.accuracy ?? "?"} মিটার · {new Date(loc.updated_at).toLocaleString("bn-BD")}</span><a className="inline-flex items-center gap-1 font-semibold text-primary" href={`https://www.google.com/maps?q=${loc.latitude},${loc.longitude}`} target="_blank" rel="noreferrer"><Navigation className="h-3.5 w-3.5" />Google Maps</a></div></> : <div className="flex min-h-[360px] flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground"><MapPin className="h-9 w-9 opacity-40" />এই SR-এর কোনো লোকেশন ডেটা নেই। SR-কে তার ড্যাশবোর্ড থেকে Live Location চালু করতে বলুন।</div>}
      </div>
    </div>
  </div>;
}
