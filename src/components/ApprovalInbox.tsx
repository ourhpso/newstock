import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { rpc } from "@/lib/rpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type ApprovalRequest = {
  id: string; request_type: "stock_issue" | "stock_return" | "cash_deposit";
  salesman_id: string; created_by: string; payload: Record<string, unknown>;
  reason: string; status: string; result_ref: string | null; created_at: string;
  sr_confirmed_by: string | null; sr_confirmed_at: string | null;
  decided_by: string | null; decided_at: string | null; decision_reason: string | null;
};
type ApprovalEvent = { id: string; request_id: string; actor_id: string; action: string; reason: string | null; created_at: string };
type Product = { id: string; name: string; price: number | string | null };
type Profile = { id: string; full_name: string | null };
type PayloadItem = { product_id?: string; qty?: number | string; unit_price?: number | string; imeis?: string[]; damaged?: boolean };

const money = (value: number) => new Intl.NumberFormat("bn-BD", { style: "currency", currency: "BDT", maximumFractionDigits: 2 }).format(value);
const dateTime = (value: string | null | undefined) => value ? new Date(value).toLocaleString("bn-BD", { dateStyle: "medium", timeStyle: "short" }) : "—";

export function ApprovalInbox({ isAdmin, salesmanId }: { isAdmin: boolean; salesmanId: string }) {
  const qc = useQueryClient();
  const [decisionReason, setDecisionReason] = useState("");
  const [busyId, setBusyId] = useState("");
  const { data: requests = [], isLoading, isError: requestsError, error: requestsErrorValue } = useQuery({
    queryKey: ["approval-requests"],
    queryFn: async () => {
      const { data, error } = await (supabase as any).from("approval_requests").select("*").order("created_at", { ascending: false }).limit(100);
      if (error) throw error;
      return (data ?? []) as ApprovalRequest[];
    },
  });
  const { data: events = [] } = useQuery({
    queryKey: ["approval-events"],
    queryFn: async () => {
      const { data, error } = await (supabase as any).from("approval_events").select("*").order("created_at", { ascending: false }).limit(300);
      if (error) throw error;
      return (data ?? []) as ApprovalEvent[];
    },
  });
  const { data: products = [] } = useQuery({
    queryKey: ["approval-product-details"],
    queryFn: async () => {
      const { data, error } = await supabase.from("products").select("id,name,price");
      if (error) throw error;
      return (data ?? []) as Product[];
    },
  });
  const { data: profiles = [] } = useQuery({
    queryKey: ["approval-actor-profiles"],
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("id,full_name");
      if (error) throw error;
      return (data ?? []) as Profile[];
    },
  });
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const profileById = useMemo(() => new Map(profiles.map((p) => [p.id, p.full_name || p.id])), [profiles]);
  const visible = requests.filter((r) => isAdmin || r.salesman_id === salesmanId);
  async function act(id: string, action: "confirm" | "reject_issue" | "approve" | "reject" | "finalize") {
    if (busyId) return;
    setBusyId(id);
    try {
      let result: { error: { message: string } | null; data: unknown };
      if (action === "confirm") result = await rpc("confirm_stock_issue_receipt", { _request: id });
      else if (action === "reject_issue") result = await rpc("reject_stock_issue_request", { _request: id, _reason: decisionReason.trim() });
      else if (action === "finalize") result = await rpc("finalize_workflow_request", { _request: id });
      else result = await rpc("decide_workflow_request", { _request: id, _approved: action === "approve", _reason: decisionReason.trim() });
      if (result.error) { toast.error(result.error.message); return; }
      toast.success(action === "confirm" ? "Receipt confirmation saved" : action === "reject" || action === "reject_issue" ? "Request rejected" : "Approval completed");
      setDecisionReason("");
      await Promise.all([qc.invalidateQueries({ queryKey: ["approval-requests"] }), qc.invalidateQueries({ queryKey: ["approval-events"] }), qc.invalidateQueries()]);
    } finally { setBusyId(""); }
  }
  const label = (type: ApprovalRequest["request_type"]) => type === "stock_issue" ? "পণ্য বরাদ্দ" : type === "stock_return" ? "অবিক্রীত পণ্য ফেরত" : "নগদ জমা";
  const statusLabel = (status: string) => ({ pending_sr: "এস আর-এর পণ্য গ্রহণ নিশ্চিতকরণ বাকি", awaiting_admin_finalize: "এস আর গ্রহণ নিশ্চিত করেছেন — অ্যাডমিনের চূড়ান্তকরণ বাকি", pending_admin: "অ্যাডমিনের অনুমোদনের অপেক্ষায়", completed: "সম্পন্ন", rejected: "প্রত্যাখ্যাত" } as Record<string, string>)[status] ?? status;
  if (isLoading) return <section className="rounded-xl border p-4 text-sm text-muted-foreground">অনুমোদন ও জমার অনুরোধ লোড হচ্ছে…</section>;
  if (requestsError) return <section role="alert" className="rounded-xl border border-destructive/30 p-4 text-sm"><p className="text-destructive">অনুরোধের তালিকা আনা যায়নি: {(requestsErrorValue as Error).message}</p></section>;
  if (!visible.length) return <section className="rounded-xl border p-4"><h2 className="font-semibold">অনুমোদন ও অডিট</h2><p className="mt-1 text-sm text-muted-foreground">কোনো অনুমোদন অনুরোধ নেই।</p></section>;
  return <section className="space-y-3 rounded-xl border bg-card p-4">
    <div><h2 className="font-display text-lg font-bold">অনুমোদন ও অডিট ট্রেইল</h2><p className="text-xs text-muted-foreground">কে, কখন, কী সিদ্ধান্ত নিয়েছেন—প্রতিটি ধাপ সংরক্ষিত থাকে।</p></div>
    {visible.map((r) => {
      const canConfirm = !isAdmin && r.status === "pending_sr";
      const canFinalize = isAdmin && r.status === "awaiting_admin_finalize";
      const canDecide = isAdmin && r.request_type !== "stock_issue" && r.status === "pending_admin";
      const ev = events.filter((e) => e.request_id === r.id);
      const payload = r.payload ?? {};
      const itemLines = Array.isArray(payload["items"]) ? payload["items"] as PayloadItem[] : [];
      const cashAmount = Number(payload["amount"] ?? 0);
      const knownItems = itemLines.map((item) => {
        const product = item.product_id ? productById.get(item.product_id) : undefined;
        const qty = Number(item.qty ?? item.imeis?.length ?? 0);
        const catalogPrice = Number(product?.price ?? 0);
        const unitPrice = Number(item.unit_price ?? catalogPrice);
        return { item, name: product?.name ?? item.product_id ?? "অজানা পণ্য", qty, unitPrice, lineTotal: unitPrice > 0 ? qty * unitPrice : null, hasExplicitPrice: item.unit_price != null };
      });
      const pricedTotal = knownItems.reduce((sum, line) => sum + (line.lineTotal ?? 0), 0);
      const allPricesKnown = knownItems.every((line) => line.lineTotal != null);
      return <article key={r.id} className="space-y-3 rounded-lg border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><b>{label(r.request_type)}</b><span className="rounded-full bg-muted px-2 py-1 text-xs">{statusLabel(r.status)}</span></div>
        <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
          <span>SR: <b className="text-foreground">{profileById.get(r.salesman_id) ?? r.salesman_id}</b></span>
          <span>অনুরোধকারী: <b className="text-foreground">{profileById.get(r.created_by) ?? r.created_by}</b></span>
          <span>অনুরোধের সময়: {dateTime(r.created_at)}</span>
          <span>অনুরোধ ID: {r.id}</span>
        </div>
        {r.request_type === "cash_deposit" ? (
          <div className="rounded-md bg-muted/50 p-3">
            <p className="text-xs font-semibold text-muted-foreground">নগদ জমার বিবরণ</p>
            <div className="mt-1 grid gap-1 sm:grid-cols-2">
              <p className="text-lg font-bold">{money(cashAmount)}</p>
              <p className="text-sm">মাধ্যম: {String(payload["method"] ?? "cash")}</p>
              <p className="text-sm">তারিখ: {String(payload["date"] ?? "—")}</p>
              <p className="text-sm">নোট: {String(payload["note"] ?? "কোনো নোট নেই")}</p>
            </div>
          </div>
        ) : (
          <div className="space-y-2 rounded-md bg-muted/50 p-3">
            <div className="flex items-center justify-between gap-2"><p className="text-xs font-semibold text-muted-foreground">{r.request_type === "stock_issue" ? "ইস্যু করা পণ্য" : "ফেরত দেওয়া পণ্য"} · {knownItems.length} ধরনের পণ্য</p><span className="text-xs text-muted-foreground">মোট পরিমাণ: {knownItems.reduce((sum, line) => sum + line.qty, 0)} পিস</span></div>
            {knownItems.length === 0 ? <p className="text-sm text-muted-foreground">পণ্যের বিবরণ পাওয়া যায়নি।</p> : knownItems.map(({ item, name, qty, unitPrice, lineTotal, hasExplicitPrice }, index) => (
              <div key={item.product_id ?? index} className="space-y-1 border-b pb-2 last:border-0 last:pb-0">
                <div className="flex flex-wrap items-start justify-between gap-2"><b className="text-sm">{index + 1}. {name}</b><b className="text-sm">{qty} পিস</b></div>
                {lineTotal != null && <p className="text-xs text-muted-foreground">একক মূল্য: {money(unitPrice)} · মোট: <b className="text-foreground">{money(lineTotal)}</b>{!hasExplicitPrice ? " (বর্তমান ক্যাটালগ মূল্য অনুযায়ী আনুমানিক)" : ""}</p>}
                {Array.isArray(item.imeis) && item.imeis.length > 0 && <p className="break-all text-xs text-muted-foreground">IMEI ({item.imeis.length}): {item.imeis.join(", ")}</p>}
                {item.damaged != null && <p className="text-xs text-muted-foreground">অবস্থা: {item.damaged ? "ক্ষতিগ্রস্ত" : "ভালো"}</p>}
              </div>
            ))}
            {allPricesKnown && knownItems.length > 0 && <div className="flex justify-between border-t pt-2 text-sm font-semibold"><span>মোট আনুমানিক মূল্য</span><span>{money(pricedTotal)}</span></div>}
            <p className="text-xs text-muted-foreground">ইস্যু/ফেরতের ক্ষেত্রে মূল্য দেখানো হলে সেটি পণ্যের বর্তমান ক্যাটালগ মূল্যের ভিত্তিতে; এটি হিসাব/স্টক পরিমাণের বিকল্প নয়।</p>
          </div>
        )}
        {r.reason && <p className="text-sm">অনুরোধের কারণ: {r.reason}</p>}
        {r.decision_reason && <p className="text-sm">সিদ্ধান্তের কারণ: {r.decision_reason}</p>}
        {r.sr_confirmed_at && <p className="text-xs text-muted-foreground">SR গ্রহণ/হস্তান্তর নিশ্চিত করেছেন: {profileById.get(r.sr_confirmed_by ?? "") ?? r.sr_confirmed_by} · {dateTime(r.sr_confirmed_at)}</p>}
        {r.decided_at && <p className="text-xs text-muted-foreground">Admin সিদ্ধান্ত: {profileById.get(r.decided_by ?? "") ?? r.decided_by} · {dateTime(r.decided_at)}</p>}
        {r.result_ref && <p className="text-xs text-muted-foreground">চূড়ান্ত ডকুমেন্ট: {r.result_ref}</p>}
        {(canDecide || canConfirm) && <Input value={decisionReason} onChange={(e) => setDecisionReason(e.target.value)} placeholder="সিদ্ধান্তের কারণ (কমপক্ষে ৩ অক্ষর)" />}
        <div className="flex flex-wrap gap-2">
          {canConfirm && <><Button size="sm" disabled={busyId === r.id} onClick={() => act(r.id,"confirm")}>{r.request_type === "stock_issue" ? "পণ্য বুঝে পেয়েছি" : r.request_type === "stock_return" ? "ফেরত পণ্য বুঝিয়ে দিয়েছি" : "নগদ জমা দিয়েছি"}</Button><Button size="sm" variant="destructive" disabled={busyId === r.id || decisionReason.trim().length < 3} onClick={() => act(r.id,"reject_issue")}>অনুরোধ প্রত্যাখ্যান</Button></>}
          {canFinalize && <Button size="sm" disabled={busyId === r.id} onClick={() => act(r.id,"finalize")}>{r.request_type === "stock_issue" ? "পণ্য বরাদ্দ চূড়ান্ত করুন" : r.request_type === "stock_return" ? "ফেরত পণ্য গ্রহণ চূড়ান্ত করুন" : "নগদ জমা চূড়ান্ত করুন"}</Button>}
          {canDecide && <><Button size="sm" disabled={busyId === r.id || decisionReason.trim().length < 3} onClick={() => act(r.id,"approve")}>অনুমোদন</Button><Button size="sm" variant="destructive" disabled={busyId === r.id || decisionReason.trim().length < 3} onClick={() => act(r.id,"reject")}>প্রত্যাখ্যান</Button></>}
        </div>
        {ev.length > 0 && <div className="border-t pt-2"><p className="mb-1 text-xs font-semibold">সিদ্ধান্তের অডিট ইতিহাস</p>{ev.map((e) => <p key={e.id} className="text-xs text-muted-foreground">{dateTime(e.created_at)} · {e.action} · {profileById.get(e.actor_id) ?? e.actor_id}{e.reason ? ` · কারণ: ${e.reason}` : ""}</p>)}</div>}
      </article>;
    })}
  </section>;
}
