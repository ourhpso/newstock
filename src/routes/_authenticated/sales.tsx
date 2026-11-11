import { pageHead } from "@/lib/page-head";
import { createFileRoute } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Printer } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useMe, useRetailers, useRetailerLedgers, useSalesmanSummary, useSalesmen } from "@/lib/me";
import { useT } from "@/lib/i18n";
import { money } from "@/lib/imei";
import { useBusiness } from "@/lib/business";
import { useOnline } from "@/lib/offline";
import { rpc } from "@/lib/rpc";
import { fetchSaleItems } from "@/lib/receipt";
import { PrintSheet, SaleReceiptDoc } from "@/components/PrintDocs";
import { CartBuilder, type CartLine } from "@/components/CartBuilder";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageTitle } from "@/components/Stat";
import { SearchHistoryBar } from "@/components/SearchHistoryBar";

export const Route = createFileRoute("/_authenticated/sales")({
  head: () => pageHead("বিক্রি", "FIROZA ENTERPRISE retailer sales, payments and invoices."),
  component: Sales,
});

const todayDhaka = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" });

function Sales() {
  const { t } = useT();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data: retailers = [] } = useRetailers();
  const { data: ledgers = [] } = useRetailerLedgers();
  const { data: summary } = useSalesmanSummary(me?.id);
  const { data: salesmen = [] } = useSalesmen();
  const online = useOnline();
  const { data: creditExceptions = [] } = useQuery<any[]>({
    queryKey: ["credit-limit-exceptions"],
    queryFn: async () => {
      const { data, error } = await (supabase as any).from("credit_limit_exceptions").select("*").order("created_at", { ascending: false }).limit(100);
      if (error) throw error;
      return data ?? [];
    },
  });
  const { data: creditExceptionEvents = [] } = useQuery<any[]>({
    queryKey: ["credit-limit-exception-events"],
    queryFn: async () => {
      const { data, error } = await (supabase as any).from("credit_limit_exception_events").select("*").order("created_at", { ascending: false }).limit(300);
      if (error) throw error;
      return data ?? [];
    },
  });
  const [business] = useBusiness();
  const online = useOnline();
  const [rid, setRid] = useState("");
  const [retailerSearch,setRetailerSearch]=useState("");
  const filteredRetailers=retailers.filter(r=>!retailerSearch.trim()||[r.name,r.phone,r.address].some(v=>String(v??"").toLowerCase().includes(retailerSearch.trim().toLowerCase())));
  const [paid, setPaid] = useState("");
  const [discount, setDiscount] = useState("");
  const [discountMode, setDiscountMode] = useState<"fixed" | "percent">("fixed");
  const [exceptionReason, setExceptionReason] = useState("");
  const [exceptionId, setExceptionId] = useState<string | null>(null);
  const [adminDecisionReason, setAdminDecisionReason] = useState("");
  const [date, setDate] = useState(todayDhaka());
  const [busy, setBusy] = useState(false);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [lastSale, setLastSale] = useState<{ id: string; docNo: string | undefined; retailerId: string; total: number; paid: number; discount: number; date: string } | null>(null);
  const [printDoc, setPrintDoc] = useState<ReactNode | null>(null);
  const cartTotal = cart.reduce((a, l) => a + l.qty * l.unit_price, 0);
  const discountValue = Number(discount || 0);
  const disc = discountMode === "percent" ? Math.round(cartTotal * discountValue) / 100 : discountValue;
  const total = cartTotal - disc;
  const paidN = Number(paid || 0);
  const held = summary?.products.filter((p) => p.hand > 0).map((p) => p.product_id) ?? [];
  const ledger = ledgers.find((l) => l.id === rid);
  const needsCreditApproval = !!ledger && ledger.credit_limit !== null && ledger.due + Math.max(0, total - paidN) > ledger.credit_limit;
  const activeException = creditExceptions.find((x) => x.id === exceptionId && x.retailer_id === rid) ?? creditExceptions.find((x) => x.retailer_id === rid && (x.status === "approved" || x.status === "pending" || x.status === "rejected"));
  const invalid = !rid || !cart.length || busy || disc < 0 || disc > cartTotal || (discountMode === "percent" && discountValue > 100) || paidN < 0 || paidN > total || cart.some((l) => !(l.unit_price > 0)) || (needsCreditApproval && activeException?.status !== "approved");

  async function submit() {
    if (busy || !me?.active || (!me.isAdmin && !me.permissions.sales)) return;
    if (cart.some((l) => !(l.unit_price > 0))) { toast.error(t("price")); return; }
    setBusy(true);
    try {
      if (!online) { toast.error("বিক্রি সম্পন্ন করতে ইন্টারনেট সংযোগ প্রয়োজন।"); return; }
      const result = await rpc<string>("record_sale_v2", {
        _retailer: rid,
        _items: cart.map((l) => ({ product_id: l.product_id, qty: l.qty, unit_price: l.unit_price, imeis: l.imeis })),
        _paid: paidN, _discount_mode: discountMode, _discount_value: discountValue,
        _date: date || null, _exception_id: needsCreditApproval && activeException?.status === "approved" ? activeException.id : null,
        _op: crypto.randomUUID(),
      });
      if (result.error) { toast.error(result.error.message); return; }
      toast.success(t("done"));
      const saleId = result.data as string;
      const { data: row } = await supabase.from("sales").select("invoice_no,total,paid,discount,txn_date").eq("id", saleId).maybeSingle();
      setLastSale({
        id: saleId,
        docNo: row?.invoice_no ?? undefined,
        retailerId: rid,
        total: row ? Number(row.total) : total,
        paid: row ? Number(row.paid) : paidN,
        discount: row ? Number(row.discount ?? 0) : disc,
        date: row?.txn_date ?? date,
      });
      setCart([]); setPaid(""); setDiscount(""); setDiscountMode("fixed"); setExceptionId(null); setExceptionReason("");
      qc.invalidateQueries();
    } finally {
      setBusy(false);
    }
  }

  async function requestCreditException() {
    if (!me || !rid || !cart.length || exceptionReason.trim().length < 3 || !online) return;
    const result = await rpc<string>("request_credit_limit_exception", {
      _retailer: rid,
      _items: cart.map((l) => ({ product_id: l.product_id, qty: l.qty, unit_price: l.unit_price, imeis: l.imeis })),
      _paid: paidN, _discount_mode: discountMode, _discount_value: discountValue,
      _date: date || null, _reason: exceptionReason.trim(),
    });
    if (result.error) { toast.error(result.error.message); return; }
    setExceptionId(result.data as string);
    setExceptionReason("");
    toast.success("Credit-limit exception request sent to Admin.");
    qc.invalidateQueries({ queryKey: ["credit-limit-exceptions"] });
  }

  async function decideCreditException(id: string, approved: boolean) {
    if (adminDecisionReason.trim().length < 3) { toast.error("সিদ্ধান্তের কারণ লিখুন"); return; }
    const result = await rpc("decide_credit_limit_exception", { _request: id, _approved: approved, _reason: adminDecisionReason.trim() });
    if (result.error) { toast.error(result.error.message); return; }
    setAdminDecisionReason("");
    toast.success(approved ? "Credit exception approved" : "Credit exception rejected");
    qc.invalidateQueries({ queryKey: ["credit-limit-exceptions"] });
  }

  async function printReceipt() {
    if (!lastSale) return;
    const r = retailers.find((x) => x.id === lastSale.retailerId);
    const items = await fetchSaleItems(lastSale.id);
    setPrintDoc(
      <SaleReceiptDoc b={business} appName={t("appName")} saleId={lastSale.id} docNo={lastSale.docNo} date={lastSale.date}
        retailerName={r?.name ?? ""} retailerMeta={r?.phone ?? undefined}
        items={items} total={lastSale.total} paid={lastSale.paid} discount={lastSale.discount} />,
    );
  }

  if (!me) return null;
  return (
    <div className="space-y-4">
      <PageTitle>{t("sales")}</PageTitle>
      {lastSale && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-success bg-success/10 p-3">
          <span className="text-sm font-semibold">{t("done")}{lastSale.docNo ? ` · ${lastSale.docNo}` : ""} · {money(lastSale.total)}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={printReceipt}><Printer className="mr-1 h-4 w-4" />{t("printReceipt")}</Button>
            <Button size="sm" variant="ghost" onClick={() => setLastSale(null)}>✕</Button>
          </div>
        </div>
      )}
      {me.isAdmin && creditExceptions.map((x) => {
        const retailer = retailers.find((r) => r.id === x.retailer_id);
        const salesman = salesmen.find((v) => v.id === x.salesman_id);
        return <div key={x.id} className="space-y-2 rounded-xl border bg-card p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><b>Credit-limit approval · {retailer?.name ?? x.retailer_id}</b><span className="rounded-full bg-muted px-2 py-1 text-xs">{x.status}</span></div>
          <p className="text-sm text-muted-foreground">SR: {salesman?.full_name ?? x.salesman_id} · Current due: {money(Number(x.current_due))} · Over limit: {money(Number(x.over_limit_amount))}</p>
          <p className="text-sm">Reason: {x.reason}</p>
          {x.status === "pending" && <><Input value={adminDecisionReason} onChange={(e) => setAdminDecisionReason(e.target.value)} placeholder="Decision reason (at least 3 characters)" />
          <div className="flex gap-2"><Button size="sm" disabled={adminDecisionReason.trim().length < 3} onClick={() => decideCreditException(x.id,true)}>Approve</Button><Button size="sm" variant="destructive" disabled={adminDecisionReason.trim().length < 3} onClick={() => decideCreditException(x.id,false)}>Reject</Button></div></>}
          {x.decided_at && <p className="text-xs text-muted-foreground">Decision: {x.decided_by} · {new Date(x.decided_at).toLocaleString("en-GB")} · {x.decision_reason}</p>}
          {creditExceptionEvents.filter((e) => e.exception_id === x.id).map((e) => <p key={e.id} className="text-xs text-muted-foreground">{new Date(e.created_at).toLocaleString("en-GB")} · {e.action} · {e.actor_id} · {e.reason ?? ""}</p>)}
        </div>;
      })}
      <SearchHistoryBar value={retailerSearch} onChange={setRetailerSearch} historyKey="sales-retailers" placeholder="Search customer/dealer name or phone…"/>
      <Select value={rid} onValueChange={setRid}>
        <SelectTrigger className="w-full sm:w-72"><SelectValue placeholder={t("selectRetailer")} /></SelectTrigger>
        <SelectContent>{filteredRetailers.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}{r.phone ? " · "+r.phone : ""}</SelectItem>)}</SelectContent>
      </Select>
      {ledger && (
        <p className="text-sm text-muted-foreground">
          {t("due")}: <b className="text-destructive">{money(ledger.due)}</b>
          {ledger.credit_limit !== null && <> · {t("creditLimit")}: {money(ledger.credit_limit)}</>}
        </p>
      )}
      <CartBuilder mode="sale" salesmanId={me.id} cart={cart} setCart={setCart} editPrice onlyProductIds={held} />
      {needsCreditApproval && <div className="space-y-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3">
        <p className="text-sm font-semibold">এই বিক্রিতে রিটেইলারের ক্রেডিট সীমা অতিক্রম হবে। Admin অনুমোদন ছাড়া বিক্রি সম্পন্ন হবে না।</p>
        <p className="text-xs text-muted-foreground">বর্তমান বকেয়া: {money(ledger?.due ?? 0)} · সীমা: {money(ledger?.credit_limit ?? 0)} · সীমার অতিরিক্ত: {money(Math.max(0,(ledger?.due ?? 0)+total-paidN-(ledger?.credit_limit ?? 0)))}</p>
        {activeException?.status === "approved" ? <p className="text-sm font-semibold text-success">Admin অনুমোদন দিয়েছেন। এখন বিক্রি সম্পন্ন করতে পারবেন।</p> : activeException?.status === "pending" ? <p className="text-sm">অনুমোদনের অপেক্ষায় · Request: {activeException.id}</p> : <><Input value={exceptionReason} onChange={(e) => setExceptionReason(e.target.value)} placeholder="ক্রেডিট সীমা ছাড়ের কারণ লিখুন" /><Button type="button" variant="secondary" disabled={exceptionReason.trim().length < 3 || !online} onClick={requestCreditException}>Admin-এর অনুমোদন চান</Button></>}
      </div>}

      <div className="grid grid-cols-2 gap-3 rounded-xl border bg-card p-4 sm:grid-cols-4">
        <div className="space-y-1"><Label>{t("date")}</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="space-y-1"><Label>{t("discount")}</Label><div className="flex gap-1"><Select value={discountMode} onValueChange={(v) => setDiscountMode(v as "fixed" | "percent")}><SelectTrigger className="w-24"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="fixed">৳</SelectItem><SelectItem value="percent">%</SelectItem></SelectContent></Select><Input type="number" min={0} max={discountMode === "percent" ? 100 : undefined} value={discount} onChange={(e) => setDiscount(e.target.value)} /></div></div>
        <div className="space-y-1"><Label>{t("paid")}</Label><Input type="number" min={0} value={paid} onChange={(e) => setPaid(e.target.value)} /></div>
        <div className="text-right"><div className="text-xs text-muted-foreground">{t("due")}</div><div className="font-display text-2xl font-bold text-destructive">{money(total - paidN)}</div></div>
      </div>
      <Button size="lg" className="w-full" disabled={(!me.isAdmin && !me.permissions.sales) || invalid} onClick={submit}>{t("confirm")}</Button>
      {printDoc && <PrintSheet onDone={() => setPrintDoc(null)}>{printDoc}</PrintSheet>}
    </div>
  );
}
