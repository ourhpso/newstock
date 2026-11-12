import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useMe } from "@/lib/me";
import { useT } from "@/lib/i18n";
import { formatDateTime } from "@/lib/imei";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Activity = {
  id: string;
  event_type: "INSERT" | "UPDATE" | "DELETE";
  entity: string;
  entity_id: string | null;
  actor_id: string | null;
  salesman_id: string | null;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  created_at: string;
};

const labels: Record<string, [string, string]> = {
  products: ["পণ্য", "Product"], product_brands: ["ব্র্যান্ড", "Brand"], product_models: ["মডেল", "Model"],
  imei_units: ["IMEI", "IMEI"], retailers: ["দোকান", "Retailer"], sales: ["বিক্রয়", "Sale"],
  stock_movements: ["স্টক আদান-প্রদান", "Stock movement"], retailer_payments: ["দোকানের টাকা জমা", "Retailer payment"],
  deposits: ["SR-এর টাকা জমা", "SR deposit"], retailer_returns: ["পণ্য ফেরত", "Goods return"],
  purchases: ["ক্রয়", "Purchase"], expenses: ["খরচ", "Expense"], suppliers: ["সরবরাহকারী", "Supplier"],
  supplier_payments: ["সরবরাহকারীকে পরিশোধ", "Supplier payment"], approval_requests: ["অনুমোদনের অনুরোধ", "Approval request"],
  approval_events: ["অনুমোদনের সিদ্ধান্ত", "Approval event"], credit_limit_exceptions: ["বাকি সীমার অনুরোধ", "Credit limit request"],
  credit_limit_exception_events: ["বাকি সীমার সিদ্ধান্ত", "Credit limit decision"], dealer_blocks: ["দোকান ব্লক", "Retailer block"],
  dealer_risk_assessments: ["দোকানের ঝুঁকি মূল্যায়ন", "Retailer risk assessment"], business_audit: ["পরিবর্তনের রেকর্ড", "Change log"],
  profiles: ["প্রোফাইল", "Profile"], user_roles: ["ভূমিকা", "Role"], user_permission_overrides: ["অনুমতি", "Permission"],
};

export function ActivityHistory() {
  const { data: me } = useMe();
  const { t, lang } = useT();
  const [showOlder, setShowOlder] = useState(false);
  const [sectionTaps, setSectionTaps] = useState(0);
  const [selected, setSelected] = useState<Activity | null>(null);
  const { data = [], isLoading, isError, refetch } = useQuery({
    queryKey: ["activity-history", me?.id],
    enabled: !!me,
    queryFn: async () => {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await (supabase as any).from("activity_history")
        .select("id,event_type,entity,entity_id,actor_id,salesman_id,before_data,after_data,created_at")
        .gte("created_at", since).order("created_at", { ascending: false }).limit(500);
      if (error) throw error;
      return (data ?? []) as Activity[];
    },
  });
  const { recent, older } = useMemo(() => {
    const threeDays = Date.now() - 3 * 24 * 60 * 60 * 1000;
    return {
      recent: data.filter((row) => new Date(row.created_at).getTime() >= threeDays),
      older: data.filter((row) => new Date(row.created_at).getTime() < threeDays),
    };
  }, [data]);
  const title = (row: Activity) => labels[row.entity]?.[lang === "bn" ? 0 : 1] ?? row.entity;
  const summary = (row: Activity) => {
    const value = row.after_data ?? row.before_data ?? {};
    const candidates = [value.name, value.full_name, value.imei, value.invoice_no, value.receipt_no, value.doc_no, value.amount, value.total, value.reason];
    return candidates.find((item) => item !== undefined && item !== null && String(item).length > 0)?.toString() ?? row.entity_id ?? title(row);
  };
  const card = (row: Activity) => (
    <button key={row.id} type="button" onClick={() => setSelected(row)}
      className="min-w-[150px] max-w-[220px] shrink-0 rounded-lg border bg-card px-3 py-2 text-left shadow-sm transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span className="block truncate text-xs font-semibold">{title(row)}</span>
      <span className="mt-1 block truncate text-sm">{summary(row)}</span>
      <span className="mt-1 block text-[11px] text-muted-foreground">{row.event_type === "INSERT" ? (lang === "bn" ? "নতুন" : "Created") : row.event_type === "UPDATE" ? (lang === "bn" ? "আপডেট" : "Updated") : (lang === "bn" ? "মুছে ফেলা" : "Deleted")} · {formatDateTime(row.created_at)}</span>
    </button>
  );
  if (!me) return null;
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4" onClick={() => setSectionTaps((n) => { const next = n + 1; if (next >= 3) { setShowOlder((v) => !v); return 0; } return next; })}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h2 className="font-display font-bold">{lang === "bn" ? "সাম্প্রতিক আদান-প্রদান ও হিসাবের ইতিহাস" : "Recent activity & account history"}</h2>
          <p className="text-xs text-muted-foreground">{lang === "bn" ? "সর্বশেষ ৩ দিন · বিস্তারিত দেখতে কার্ডে চাপ দিন" : "Last 3 days · Select a card for details"}</p></div>
        <span className="rounded-full bg-muted px-2 py-1 text-xs">{recent.length}</span>
      </div>
      {isLoading && <p className="text-sm text-muted-foreground">{t("loading")}</p>}
      {isError && <Button variant="outline" size="sm" onClick={(event) => { event.stopPropagation(); void refetch(); }}>{t("retry")}</Button>}
      {!isLoading && recent.length === 0 && <p className="text-sm text-muted-foreground">{t("noData")}</p>}
      {recent.length > 0 && <div className="flex gap-2 overflow-x-auto pb-1">{recent.map(card)}</div>}
      {older.length > 0 && <div className="space-y-2">
        <p className="text-xs text-muted-foreground">{lang === "bn" ? "আগের ২৭ দিনের ইতিহাস লুকানো আছে" : "Previous 27 days are hidden"}</p>
        {showOlder ? <div className="flex gap-2 overflow-x-auto pb-1">{older.map(card)}</div> :
          <Button type="button" variant="outline" size="sm" onClick={(event) => { event.stopPropagation(); setSectionTaps((n) => n + 1 >= 3 ? 0 : n + 1); if (sectionTaps + 1 >= 3) setShowOlder(true); }}>
            {lang === "bn" ? "পুরোনো ইতিহাস দেখতে সেকশনে ৩ বার ট্যাপ করুন" : "Tap this section 3 times to reveal older history"}
          </Button>}
      </div>}
      <Dialog open={!!selected} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader><DialogTitle>{selected ? title(selected) : t("history")}</DialogTitle></DialogHeader>
          {selected && <div className="space-y-3 text-sm">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg bg-muted p-3"><span className="text-muted-foreground">{lang === "bn" ? "সময়" : "Time"}</span><p>{formatDateTime(selected.created_at)}</p></div>
              <div className="rounded-lg bg-muted p-3"><span className="text-muted-foreground">{lang === "bn" ? "কাজের ধরন" : "Action"}</span><p>{selected.event_type}</p></div>
              <div className="rounded-lg bg-muted p-3"><span className="text-muted-foreground">SR ID</span><p className="break-all">{selected.salesman_id ?? "—"}</p></div>
              <div className="rounded-lg bg-muted p-3"><span className="text-muted-foreground">{lang === "bn" ? "সম্পাদনকারী" : "Actor"}</span><p className="break-all">{selected.actor_id ?? "—"}</p></div>
            </div>
            {selected.before_data && <div><h3 className="mb-1 font-semibold">{lang === "bn" ? "আগের তথ্য" : "Before"}</h3><pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs">{JSON.stringify(selected.before_data, null, 2)}</pre></div>}
            {selected.after_data && <div><h3 className="mb-1 font-semibold">{lang === "bn" ? "পরের তথ্য" : "After"}</h3><pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs">{JSON.stringify(selected.after_data, null, 2)}</pre></div>}
          </div>}
        </DialogContent>
      </Dialog>
    </section>
  );
}
