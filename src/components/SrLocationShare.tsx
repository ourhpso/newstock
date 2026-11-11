import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MapPin, Navigation, Radio, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";

export function SrLocationShare({ salesmanId }: { salesmanId: string }) {
  const qc = useQueryClient();
  const watchId = useRef<number | null>(null);
  const [sharing, setSharing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastPoint, setLastPoint] = useState<{ latitude: number; longitude: number; accuracy: number } | null>(null);
  const [permission, setPermission] = useState<PermissionState | "unsupported">("prompt");

  useEffect(() => {
    let alive = true;
    if (!navigator.geolocation) { setPermission("unsupported"); return; }
    if (navigator.permissions?.query) {
      void navigator.permissions.query({ name: "geolocation" as PermissionName }).then((p) => {
        if (alive) setPermission(p.state);
        p.onchange = () => { if (alive) setPermission(p.state); };
      }).catch(() => undefined);
    }
    return () => { alive = false; };
  }, []);

  useEffect(() => () => {
    if (watchId.current !== null) navigator.geolocation?.clearWatch(watchId.current);
  }, []);

  function stop() {
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
    setSharing(false);
    void supabase.from("sr_locations").update({ is_sharing: false, updated_at: new Date().toISOString() }).eq("salesman_id", salesmanId);
    toast.success("লোকেশন শেয়ারিং বন্ধ হয়েছে");
  }

  async function start() {
    if (!navigator.geolocation) { toast.error("এই ডিভাইসে Location সাপোর্ট নেই"); return; }
    if (!window.isSecureContext) { toast.error("Location ব্যবহারের জন্য HTTPS প্রয়োজন"); return; }
    setBusy(true);
    const onPosition = async (position: GeolocationPosition) => {
      const point = {
        salesman_id: salesmanId,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: Math.round(position.coords.accuracy),
        speed: position.coords.speed,
        heading: position.coords.heading,
        is_sharing: true,
        updated_at: new Date().toISOString(),
      };
      setLastPoint({ latitude: point.latitude, longitude: point.longitude, accuracy: point.accuracy });
      const { error } = await supabase.from("sr_locations").upsert(point, { onConflict: "salesman_id" });
      if (error) toast.error("লোকেশন সেভ হয়নি: " + error.message);
      else void qc.invalidateQueries({ queryKey: ["sr-live-locations"] });
      setBusy(false);
    };
    watchId.current = navigator.geolocation.watchPosition(
      (position) => { void onPosition(position); },
      (error) => {
        setBusy(false);
        setSharing(false);
        const message = error.code === 1 ? "Location permission অনুমোদন করুন" : error.code === 2 ? "বর্তমান লোকেশন পাওয়া যায়নি" : "Location পেতে সময় শেষ হয়েছে";
        toast.error(message);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
    setSharing(true);
    toast.info("লোকেশন শেয়ারিং চালু হয়েছে। অ্যাপ খোলা থাকলে লোকেশন আপডেট হবে।");
  }

  return (
    <section className="overflow-hidden rounded-2xl border bg-card shadow-sm">
      <div className="flex items-center gap-3 border-b bg-gradient-to-r from-primary/10 via-card to-card p-4">
        <div className="rounded-xl bg-primary/10 p-3 text-primary"><MapPin className="h-6 w-6" /></div>
        <div className="min-w-0 flex-1"><h2 className="font-display font-bold">আমার লাইভ লোকেশন</h2><p className="text-xs text-muted-foreground">অ্যাডমিনের কাছে আপনার বর্তমান অবস্থান পাঠান</p></div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${sharing ? "bg-emerald-500/15 text-emerald-700" : "bg-muted text-muted-foreground"}`}>{sharing ? "LIVE" : "বন্ধ"}</span>
      </div>
      <div className="space-y-3 p-4">
        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />লোকেশন শেয়ার করতে আপনার সম্মতি ও ডিভাইসের Location permission প্রয়োজন। অ্যাপ বন্ধ বা ফোনের ব্যাকগ্রাউন্ড সীমাবদ্ধতায় আপডেট থেমে যেতে পারে।</p>
        {lastPoint && <div className="rounded-xl bg-muted/60 p-3 text-xs"><div>Lat: {lastPoint.latitude.toFixed(6)} · Lng: {lastPoint.longitude.toFixed(6)}</div><div>Accuracy: প্রায় {lastPoint.accuracy} মিটার</div></div>}
        <div className="flex flex-wrap gap-2">
          {!sharing ? <Button className="flex-1" onClick={() => void start()} disabled={busy || permission === "denied" || permission === "unsupported"}><Radio className="mr-2 h-4 w-4" />{busy ? "লোকেশন খোঁজা হচ্ছে…" : "লাইভ লোকেশন চালু করুন"}</Button> : <Button variant="destructive" className="flex-1" onClick={stop}>শেয়ারিং বন্ধ করুন</Button>}
          {lastPoint && <Button variant="outline" onClick={() => window.open(`https://www.google.com/maps?q=${lastPoint.latitude},${lastPoint.longitude}`, "_blank", "noopener,noreferrer")}><Navigation className="mr-2 h-4 w-4" />ম্যাপ</Button>}
        </div>
        {permission === "denied" && <p className="text-xs text-destructive">ব্রাউজার Settings থেকে Location permission Allow করুন।</p>}
      </div>
    </section>
  );
}
