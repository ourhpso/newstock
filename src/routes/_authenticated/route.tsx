import { createFileRoute, Link, Outlet, redirect, useNavigate, useRouterState } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useMe } from "@/lib/me";
import { useT, type Key } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { LayoutDashboard, Menu, Package, Users, PackageOpen, HandCoins, ShoppingCart, Store, Settings2, ShieldCheck, FileBarChart, MapPin, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useBusiness } from "@/lib/business";
import { useOnline, usePendingSyncCount } from "@/lib/offline";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

// Logo is served from /public so it works on every host (Lovable + Vercel),
// not only on Lovable's asset CDN.
const LOGO_URL = "/firoza-logo.png";

const navIcon: Partial<Record<Key, LucideIcon>> = {
  dashboard: LayoutDashboard,
  products: Package,
  purchases: ShoppingCart,
  salesmen: Users,
  stockIssue: PackageOpen,
  settlement: HandCoins,
  sales: ShoppingCart,
  retailers: Store,
  settings: Settings2,
  userAccess: ShieldCheck,
  srLocations: MapPin,
  reports: FileBarChart,
};

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    // Local session read (no network round-trip per navigation); RLS still enforces access server-side.
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw redirect({ to: "/auth" });
  },
  component: Layout,
});

const adminNav: { to: string; k: Key }[] = [
  { to: "/dashboard", k: "dashboard" },
  { to: "/products", k: "products" },
  { to: "/purchases", k: "purchases" },
  { to: "/salesmen", k: "salesmen" },
  { to: "/sr-locations", k: "srLocations" },
  { to: "/stock-issue", k: "stockIssue" },
  { to: "/settlement", k: "settlement" },
  { to: "/reports", k: "reports" },
  { to: "/retailers", k: "retailers" },
  { to: "/settings", k: "settings" },
  { to: "/user-access", k: "userAccess" },
];
const salesNav: { to: string; k: Key }[] = [
  { to: "/dashboard", k: "dashboard" },
  { to: "/sales", k: "sales" },
  { to: "/retailers", k: "retailers" },
  { to: "/settlement", k: "settlement" },
  { to: "/reports", k: "reports" },
  { to: "/settings", k: "settings" },
];

function Layout() {
  const { data: me, isPending: mePending, isError: meError, error: meErrorValue, refetch: retryMe } = useMe();
  const { t, lang, setLang } = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const nav = me?.isAdmin ? adminNav : salesNav;
  async function signOut() {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }
  return (
    <div className="min-h-screen pb-20 md:pb-0">
      <header className="sticky top-0 z-20 border-b bg-primary text-primary-foreground">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-3 py-3 sm:px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <img src={LOGO_URL} alt={t("companyName")} className="h-10 w-10 shrink-0 rounded-md bg-card object-contain p-0.5 sm:h-12 sm:w-12" />
            <div className="min-w-0">
              <div className="break-words font-display text-base font-bold sm:text-lg">{t("companyName")}</div>
              <div className="break-words text-xs leading-relaxed opacity-90 sm:text-sm">{t("appName")}</div>
              <div className="hidden text-xs opacity-80 sm:block">{t("companyAddress")} · {t("companyPhone")}</div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <SyncBadge />
            <BusinessSettings />
            <Button size="sm" variant="secondary" onClick={() => setLang(lang === "bn" ? "en" : "bn")}>{lang === "bn" ? "EN" : "বাং"}</Button>
            <Button size="sm" variant="secondary" className="px-2" onClick={signOut}>{t("signOut")}</Button>
          </div>
        </div>
      </header>
      <DesktopSidebar nav={nav} />
      <main className="mx-auto min-w-0 max-w-6xl px-3 py-5 sm:px-4">{mePending ? <p role="status" className="text-sm text-muted-foreground">{t("loading")}</p> : meError ? <section role="alert" className="space-y-2 rounded-xl border border-destructive/30 p-4"><p className="text-sm text-destructive">{t("loadFailed")}: {(meErrorValue as Error).message}</p><Button size="sm" onClick={() => retryMe()}>{t("retry")}</Button></section> : me?.active ? <Outlet /> : me ? <p className="text-destructive">{t("accountDisabled")}</p> : null}</main>
      <MobileNav nav={nav} isSalesman={!me?.isAdmin} />
    </div>
  );
}

/**
 * Desktop navigation stays collapsed to a slim left-edge handle until hovered
 * or keyboard-focused. Selecting a destination closes it immediately.
 */
function DesktopSidebar({ nav }: { nav: { to: string; k: Key }[] }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const currentPath = useRouterState({ select: (r) => r.location.pathname });
  useEffect(() => setOpen(false), [currentPath]);
  return (
    <aside
      className="group fixed inset-y-0 left-0 z-40 hidden md:block"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <div className={`h-full overflow-hidden border-r bg-card/95 shadow-xl backdrop-blur transition-[width] duration-200 ease-out ${open ? "w-64" : "w-3"}`}>
        <div className={`flex h-full flex-col ${open ? "opacity-100" : "pointer-events-none opacity-0"} transition-opacity duration-150`}>
          <div className="flex h-16 items-center gap-3 border-b px-4">
            <img src={LOGO_URL} alt={t("companyName")} className="h-9 w-9 shrink-0 rounded-md object-contain" />
            <span className="truncate text-sm font-bold">{t("menu")}</span>
          </div>
          <nav aria-label={t("menu")} className="flex-1 space-y-1 overflow-y-auto p-2">
            {nav.map((item) => {
              const Icon = navIcon[item.k] ?? LayoutDashboard;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  activeProps={{ className: "bg-accent font-semibold text-accent-foreground" }}
                >
                  <Icon className="h-5 w-5 shrink-0" />
                  <span className="truncate">{t(item.k)}</span>
                </Link>
              );
            })}
          </nav>
          <div className="border-t px-4 py-3 text-xs text-muted-foreground">{t("appName")}</div>
        </div>
      </div>
      <button
        type="button"
        aria-label={t("menu")}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onFocus={() => setOpen(true)}
        className={`absolute left-0 top-1/2 h-16 w-3 -translate-y-1/2 rounded-r-md border border-l-0 bg-primary/80 shadow-sm transition-colors hover:bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${open ? "opacity-0" : "opacity-100"}`}
      />
    </aside>
  );
}

/**
 * Mobile navigation: a fixed bottom bar with at most 4 items (first three
 * pages + a "More" button) and an auto-hiding side drawer that lists every
 * page. The drawer closes itself as soon as a page is opened.
 */
function MobileNav({ nav, isSalesman }: { nav: { to: string; k: Key }[]; isSalesman: boolean }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const currentPath = useRouterState({ select: (r) => r.location.pathname });
  // Auto-hide the drawer whenever the route changes.
  useEffect(() => {
    setOpen(false);
  }, [currentPath]);
  const bar = isSalesman ? nav.slice(0, 2) : nav.slice(0, 3);
  return (
    <>
      <nav className={`fixed inset-x-0 bottom-0 z-20 grid border-t bg-card pb-[env(safe-area-inset-bottom)] shadow-sm md:hidden ${isSalesman ? "grid-cols-3" : "grid-cols-4"}`}>
        {bar.map((n) => {
          const Icon = navIcon[n.k] ?? LayoutDashboard;
          return (
            <Link
              key={n.to}
              to={n.to}
              className="flex min-w-0 flex-col items-center gap-1 px-0.5 py-3 text-[10px] text-muted-foreground sm:text-xs"
              activeProps={{ className: "font-bold text-primary" }}
            >
              <Icon className="h-5 w-5 shrink-0" />
              <span className="break-words text-center leading-tight">{t(n.k)}</span>
            </Link>
          );
        })}
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <button
              type="button"
              className="flex min-w-0 flex-col items-center gap-1 px-0.5 py-3 text-[10px] text-muted-foreground sm:text-xs"
              aria-label={t("menu")}
            >
              <Menu className="h-5 w-5 shrink-0" />
              <span className="break-words text-center leading-tight">{t("more")}</span>
            </button>
          </SheetTrigger>
          <SheetContent side={isSalesman ? "bottom" : "left"} className={isSalesman ? "rounded-t-3xl border-t-0 px-4 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] pt-3" : "w-64 p-0"}>
            <SheetHeader className="border-b p-4">
              <SheetTitle className="flex items-center gap-2">
                <img src={LOGO_URL} alt={t("companyName")} className="h-8 w-8 shrink-0 rounded-md object-contain" />
                <span className="min-w-0 truncate text-sm">{t("menu")}</span>
              </SheetTitle>
            </SheetHeader>
            <div className={isSalesman ? "grid grid-cols-2 gap-3 p-3 sm:grid-cols-3" : "flex flex-col p-2"}>
              {nav.map((n) => {
                const Icon = navIcon[n.k] ?? LayoutDashboard;
                return (
                  <Link
                    key={n.to}
                    to={n.to}
                    onClick={() => setOpen(false)}
                    className={isSalesman ? "flex min-h-24 flex-col items-center justify-center gap-2 rounded-2xl border border-border/70 bg-gradient-to-br from-card to-muted/70 px-3 py-4 text-center text-sm font-bold shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md active:scale-[0.98]" : "flex min-w-0 items-center gap-3 rounded-md px-3 py-2.5 text-sm hover:bg-muted"}
                    activeProps={{ className: isSalesman ? "border-primary bg-primary/10 text-primary shadow-md ring-1 ring-primary/20" : "bg-accent font-bold text-accent-foreground" }}
                  >
                    <Icon className={isSalesman ? "h-7 w-7 shrink-0 stroke-[2.4]" : "h-4 w-4 shrink-0"} />
                    <span className="min-w-0 break-words">{t(n.k)}</span>
                  </Link>
                );
              })}
            </div>
          </SheetContent>
        </Sheet>
      </nav>
    </>
  );
}

/** Shows connection status and how many offline entries still need syncing. */
function SyncBadge() {
  const { t } = useT();
  const online = useOnline();
  const pending = usePendingSyncCount();
  if (online && pending === 0) return null;
  return (
    <span
      className={`rounded-full px-2 py-1 text-[10px] font-semibold sm:text-xs ${
        online ? "bg-warning/20 text-foreground" : "bg-destructive/20 text-primary-foreground"
      }`}
    >
      {online ? `${pending} ${t("pendingSync")}` : t("offline") + (pending ? ` · ${pending}` : "")}
    </span>
  );
}

function BusinessSettings() {
  const { t } = useT();
  const { data: me } = useMe();
  const [open, setOpen] = useState(false);
  const [business, saveBusiness] = useBusiness();
  const [f, setF] = useState(business);
  // The database letterhead is the single source: pull it in on load so every
  // device prints identical documents, whatever its local copy says.
  useEffect(() => {
    let live = true;
    void supabase.from("business_profile").select("name,address,phone").maybeSingle().then(async ({ data }) => {
      if (!live || !data || !(data.name || data.address || data.phone)) return;
      const db = { name: data.name, address: data.address, phone: data.phone };
      const seed = { name: "FIROZA ENTERPRISE", address: "KONABARI, GAZIPUR", phone: "01817122232" };
      const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
      const dbIsSeed = same(db.name, seed.name) && same(db.address, seed.address) && db.phone === seed.phone;
      const localCustom = !(same(business.name, seed.name) && same(business.address, seed.address) && business.phone === seed.phone);
      if (!dbIsSeed) { saveBusiness(db); return; }
      // The DB still holds only the seeded defaults while this device has a
      // letterhead the owner customised before profiles lived in the DB:
      // keep the local one and lift it into the DB instead of erasing it.
      if (localCustom) {
        saveBusiness(business);
        await supabase.rpc("set_business_profile", { _name: business.name, _address: business.address, _phone: business.phone });
      }
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <Button size="sm" variant="secondary" title={t("businessInfo")} onClick={() => { setF(business); setOpen(true); }}>
        <Settings2 className="h-4 w-4" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t("businessInfo")}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1"><Label>{t("name")}</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
            <div className="space-y-1"><Label>{t("address")}</Label><Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></div>
            <div className="space-y-1"><Label>{t("phone")}</Label><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
            <Button className="w-full" onClick={() => { saveBusiness(f); if (me?.isAdmin) void supabase.rpc("set_business_profile", { _name: f.name, _address: f.address, _phone: f.phone }); setOpen(false); }}>{t("save")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
