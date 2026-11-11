import { pageHead } from "@/lib/page-head";
import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { requireAdmin, useProducts } from "@/lib/me";
import { rpc } from "@/lib/rpc";
import { useT } from "@/lib/i18n";
import { formatInteger, isValidImeiFormat, money } from "@/lib/imei";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageTitle } from "@/components/Stat";
import { BrandModelProductPicker } from "@/components/BrandModelPicker";
import { SearchHistoryBar } from "@/components/SearchHistoryBar";
import { ImeiScanner } from "@/components/ImeiScanner";

export const Route = createFileRoute("/_authenticated/purchases")({
  beforeLoad: requireAdmin,
  head: () => pageHead("ক্রয়", "FIROZA ENTERPRISE purchases, suppliers and payables."),
  component: Purchases,
});

const todayDhaka = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" });
const METHODS = ["cash", "bank", "bkash", "nagad"] as const;

function createOperationId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return window.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

type ItemRow = { product_id: string; cost: string; qty: string; imeis: string };

function Purchases() {
  const { t } = useT();
  const qc = useQueryClient();
  const { data: products = [] } = useProducts();
  const [supplierForm, setSupplierForm] = useState({ name: "", phone: "", address: "" });
  const [historySearch, setHistorySearch] = useState("");
  const [historySupplier, setHistorySupplier] = useState("all");
  const [historyFrom, setHistoryFrom] = useState("");
  const [historyTo, setHistoryTo] = useState("");
  const [supplierSearch, setSupplierSearch] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [date, setDate] = useState(todayDhaka());
  const [paid, setPaid] = useState("");
  const [items, setItems] = useState<ItemRow[]>([{ product_id: "", cost: "", qty: "1", imeis: "" }]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  function appendPurchaseImei(index: number, imei: string): { ok: boolean; message: string } {
    const current = itemsRef.current;
    const row = current[index];
    if (!row) return { ok: false, message: t("selectProduct") };
    const existing = row.imeis.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
    if (existing.includes(imei)) return { ok: false, message: t("duplicateImei") };
    const next = [...current];
    next[index] = { ...row, imeis: row.imeis.trim() ? row.imeis.trim() + "\n" + imei : imei };
    itemsRef.current = next;
    setItems(next);
    return { ok: true, message: products.find((product) => product.id === row.product_id)?.name ?? "IMEI added" };
  }
  const [busy, setBusy] = useState(false);
  const purchaseOp = useRef<string | null>(null);
  if (!purchaseOp.current) purchaseOp.current = createOperationId();
  const payOp = useRef<string | null>(null);
  if (!payOp.current) payOp.current = createOperationId();
  const [payAmt, setPayAmt] = useState("");
  const [payMethod, setPayMethod] = useState<string>("cash");
  const [paySupplier, setPaySupplier] = useState("");

  const { data: suppliers = [] } = useQuery({
    queryKey: ["suppliers"],
    queryFn: async () => {
      const { data, error } = await supabase.from("suppliers").select("*").order("name");
      if (error) throw error;
      return data;
    },
  });
  const { data: purchases = [] } = useQuery({
    queryKey: ["purchases"],
    queryFn: async () => {
      const { data, error } = await supabase.from("purchases").select("*").order("created_at", { ascending: false }).limit(200);
      if (error) throw error;
      return data;
    },
  });
  const { data: supplierPayments = [] } = useQuery({
    queryKey: ["supplier-payments"],
    queryFn: async () => {
      const { data, error } = await supabase.from("supplier_payments").select("*").order("created_at", { ascending: false }).limit(500);
      if (error) throw error;
      return data;
    },
  });

  // Dues come from the server-side supplier_due() over ALL rows; summing the
  // capped history queries in the browser would silently understate them.
  const { data: supplierDues } = useQuery({
    queryKey: ["supplier-dues", suppliers.map((x) => x.id).join(",")],
    enabled: suppliers.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(suppliers.map(async (x) => {
        const { data, error } = await supabase.rpc("supplier_due", { _supplier: x.id });
        if (error) throw error;
        return [x.id, Number(data ?? 0)] as const;
      }));
      // TanStack Query's structural sharing treats Map as a plain object and
      // can replace it with {}, so keep cached query data JSON-serializable.
      return Object.fromEntries(entries);
    },
  });
  const dueOf = (id: string) => supplierDues?.[id] ?? 0;
  const visibleSuppliers = suppliers.filter(s => !supplierSearch.trim() || [s.name,s.phone,s.address].some(v => String(v??"").toLowerCase().includes(supplierSearch.trim().toLowerCase())));
  const visiblePurchases = purchases.filter(p => { const supplier=suppliers.find(s=>s.id===p.supplier_id); const q=historySearch.trim().toLowerCase(); return (!q || [p.doc_no,supplier?.name].some(v=>String(v??"").toLowerCase().includes(q))) && (historySupplier==="all" || p.supplier_id===historySupplier) && (!historyFrom || p.txn_date>=historyFrom) && (!historyTo || p.txn_date<=historyTo); });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["suppliers"] });
    qc.invalidateQueries({ queryKey: ["purchases"] });
    qc.invalidateQueries({ queryKey: ["supplier-payments"] });
    qc.invalidateQueries({ queryKey: ["supplier-dues"] });
    qc.invalidateQueries({ queryKey: ["products"] });
    qc.invalidateQueries({ queryKey: ["imei-counts"] });
    qc.invalidateQueries({ queryKey: ["dashboard-insights"] });
  };

  async function addSupplier(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await supabase.from("suppliers").insert(supplierForm);
    if (error) { toast.error(error.message); return; }
    setSupplierForm({ name: "", phone: "", address: "" });
    toast.success(t("done"));
    refresh();
  }

  function itemTotal(row: ItemRow): number {
    const p = products.find((x) => x.id === row.product_id);
    if (!p) return 0;
    const count = p.is_smartphone ? [...new Set(row.imeis.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))].length : Number(row.qty || 0);
    return count * Number(row.cost || 0);
  }
  const grandTotal = items.reduce((a, r) => a + itemTotal(r), 0);

  async function submitPurchase(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !supplierId) return;
    if (items.some((r) => !r.product_id)) { toast.error(t("selectProduct")); return; }
    const built: ({ product_id: string; cost_price: number; imeis: string[] } | { product_id: string; cost_price: number; qty: number })[] = [];
    for (const row of items) {
      const p = products.find((x) => x.id === row.product_id);
      if (!p) { toast.error(t("selectProduct")); return; }
      const cost = Number(row.cost);
      if (!Number.isFinite(cost) || cost <= 0) { toast.error(t("costPrice")); return; }
      if (p.is_smartphone) {
        const imeis = row.imeis.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
        if (!imeis.length) { toast.error(t("imeiWrong")); return; }
        const invalid = imeis.filter((imei) => !isValidImeiFormat(imei));
        if (invalid.length) { toast.error(`${t("imeiWrong")} ${invalid.join(", ")}`); return; }
        built.push({ product_id: p.id, cost_price: cost, imeis });
      } else {
        const qty = Number(row.qty);
        if (!Number.isInteger(qty) || qty <= 0) { toast.error(t("qty")); return; }
        built.push({ product_id: p.id, cost_price: cost, qty });
      }
    }
    const allImeis = built.flatMap((b) => ("imeis" in b ? b.imeis : []));
    if (new Set(allImeis).size !== allImeis.length) { toast.error(t("duplicateImei")); return; }
    const total = built.reduce((sum, line) => sum + ("imeis" in line ? line.imeis.length : line.qty) * line.cost_price, 0);
    const paidAmount = Number(paid || 0);
    if (!Number.isFinite(paidAmount) || paidAmount < 0 || paidAmount > total) { toast.error(t("paid")); return; }
    if (!date) { toast.error(t("date")); return; }
    setBusy(true);
    try {
      const { error } = await rpc("record_purchase", { _supplier: supplierId, _items: built, _paid: paidAmount, _date: date, _op: purchaseOp.current ?? undefined });
      if (error) { toast.error(error.message); return; }
      toast.success(t("done"));
      purchaseOp.current = null;
      setItems([{ product_id: "", cost: "", qty: "1", imeis: "" }]);
      setPaid("");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  }

  async function submitSupplierPayment(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !paySupplier) return;
    const n = Number(payAmt || 0);
    if (!Number.isFinite(n) || n <= 0 || n > dueOf(paySupplier)) { toast.error(`${t("supplierDue")}: ${money(dueOf(paySupplier))}`); return; }
    setBusy(true);
    try {
      const { error } = await rpc("record_supplier_payment", { _supplier: paySupplier, _amount: n, _method: payMethod, _note: null, _date: todayDhaka(), _op: payOp.current ?? undefined });
      if (error) { toast.error(error.message); return; }
      toast.success(t("done"));
      payOp.current = null;
      setPayAmt("");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <PageTitle>{t("purchases")}</PageTitle>

      <form onSubmit={addSupplier} className="grid gap-3 rounded-xl border bg-card p-4 md:grid-cols-4">
        <Input required list="recent-suppliers" placeholder={`${t("supplier")} · ${t("name")}`} value={supplierForm.name} onChange={(e) => setSupplierForm({ ...supplierForm, name: e.target.value })} />
        <Input placeholder={t("phone")} value={supplierForm.phone} onChange={(e) => setSupplierForm({ ...supplierForm, phone: e.target.value })} />
        <Input placeholder={t("address")} value={supplierForm.address} onChange={(e) => setSupplierForm({ ...supplierForm, address: e.target.value })} />
        <Button>{t("add")}</Button>
        <datalist id="recent-suppliers">{suppliers.slice(0,12).map(s=><option key={s.id} value={s.name}/>)}</datalist>
      </form>

      <form onSubmit={submitPurchase} className="space-y-3 rounded-xl border bg-card p-4">
        <h2 className="font-display text-lg font-bold">{t("purchases")}</h2>
        <SearchHistoryBar value={supplierSearch} onChange={setSupplierSearch} historyKey="suppliers" placeholder="Find supplier by name, phone or address…"/>
        <div className="grid gap-2 sm:grid-cols-3">
          <Select value={supplierId} onValueChange={setSupplierId}>
            <SelectTrigger><SelectValue placeholder={t("supplier")} /></SelectTrigger>
            <SelectContent>{visibleSuppliers.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
          <div className="space-y-1"><Label>{t("date")}</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="space-y-1"><Label>{t("paid")}</Label><Input type="number" min={0} step="0.01" value={paid} onChange={(e) => setPaid(e.target.value)} /></div>
        </div>
        {items.map((row, i) => {
          const p = products.find((x) => x.id === row.product_id);
          return (
            <div key={i} className="grid gap-2 rounded-lg bg-muted p-3 sm:grid-cols-[minmax(0,1fr)_8rem_7rem_auto]">
              <BrandModelProductPicker value={row.product_id} placeholder={t("selectProduct")} onChange={(v) => { const next = [...items]; const prod = products.find((x) => x.id === v); next[i] = { ...row, product_id: v, cost: row.cost || String(prod?.cost_price ?? "") }; setItems(next); }} />
              <Input type="number" min={0.01} step="0.01" placeholder={t("costPrice")} value={row.cost} onChange={(e) => { const next = [...items]; next[i] = { ...row, cost: e.target.value }; setItems(next); }} />
              {p?.is_smartphone
                ? <span className="self-center text-sm text-muted-foreground">{row.imeis.split(/[\s,]+/).filter(Boolean).length} IMEI</span>
                : <Input type="number" min={1} step={1} placeholder={t("qty")} value={row.qty} onChange={(e) => { const next = [...items]; next[i] = { ...row, qty: e.target.value }; setItems(next); }} />}
              <Button type="button" size="sm" variant="ghost" onClick={() => setItems(items.filter((_, x) => x !== i))}>✕</Button>
              {p?.is_smartphone && (
                <div className="sm:col-span-4 space-y-2">
                  <Label>IMEI barcode scan / manual entry</Label>
                  <ImeiScanner validate={async (imei) => appendPurchaseImei(i, imei)} />
                  <Textarea rows={3} placeholder="One IMEI per line (or comma separated)" value={row.imeis} onChange={(e) => { const next = [...items]; next[i] = { ...row, imeis: e.target.value }; setItems(next); }} />
                </div>
              )}
            </div>
          );
        })}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => setItems([...items, { product_id: "", cost: "", qty: "1", imeis: "" }])}>+ {t("add")}</Button>
          <span className="font-display text-lg font-bold">{t("total")}: {money(grandTotal)}</span>
        </div>
        <Button className="w-full" disabled={busy || !supplierId || grandTotal <= 0}>{t("confirm")}</Button>
      </form>

      <section className="space-y-3 rounded-xl border bg-card p-4">
        <h2 className="font-display text-lg font-bold">{t("suppliers")} · {t("supplierDue")}</h2>
        <form onSubmit={submitSupplierPayment} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_9rem_auto]">
          <Select value={paySupplier} onValueChange={setPaySupplier}>
            <SelectTrigger><SelectValue placeholder={t("supplier")} /></SelectTrigger>
            <SelectContent>{visibleSuppliers.map((s) => <SelectItem key={s.id} value={s.id}>{s.name} · {money(dueOf(s.id))}</SelectItem>)}</SelectContent>
          </Select>
          <Input type="number" min={0.01} step="0.01" placeholder={t("amount")} value={payAmt} onChange={(e) => setPayAmt(e.target.value)} />
          <Select value={payMethod} onValueChange={setPayMethod}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{METHODS.map((m) => <SelectItem key={m} value={m}>{t(m)}</SelectItem>)}</SelectContent>
          </Select>
          <Button disabled={busy}>{t("paid")}</Button>
        </form>
        <div className="space-y-1 text-sm">
          {suppliers.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-2 rounded bg-muted px-2 py-1">
              <span className="min-w-0 flex-1 truncate">{s.name}{s.phone ? ` · ${s.phone}` : ""}</span>
              <span className="shrink-0 font-semibold text-destructive">{money(dueOf(s.id))}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-2 rounded-xl border bg-card p-4">
        <h2 className="font-display text-lg font-bold">{t("history")}</h2>
        <SearchHistoryBar value={historySearch} onChange={setHistorySearch} historyKey="purchase-history" placeholder="Search purchase no. or supplier…">
          <Select value={historySupplier} onValueChange={setHistorySupplier}><SelectTrigger className="w-[180px]"><SelectValue placeholder="Supplier"/></SelectTrigger><SelectContent><SelectItem value="all">All suppliers</SelectItem>{suppliers.map(s=><SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent></Select>
          <Input className="w-auto" type="date" value={historyFrom} onChange={e=>setHistoryFrom(e.target.value)}/><Input className="w-auto" type="date" value={historyTo} onChange={e=>setHistoryTo(e.target.value)}/>
        </SearchHistoryBar>
        <div className="space-y-1 text-sm">
          {visiblePurchases.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-2 rounded bg-muted px-2 py-1">
              <span className="min-w-0 flex-1 truncate">{p.doc_no ?? ""} · {suppliers.find((s) => s.id === p.supplier_id)?.name ?? ""}</span>
              <span className="shrink-0 text-muted-foreground">{p.txn_date}</span>
              <span className="shrink-0">{t("total")} {money(p.total)} · {t("paid")} {money(p.paid)}</span>
            </div>
          ))}
          {visiblePurchases.length === 0 && <p className="text-muted-foreground">{t("noData")}</p>}
        </div>
      </section>
    </div>
  );
}
