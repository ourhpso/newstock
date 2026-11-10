import { pageHead } from "@/lib/page-head";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useProducts, requireAdmin } from "@/lib/me";
import { useT } from "@/lib/i18n";
import { formatInteger, isValidImeiFormat, money } from "@/lib/imei";
import { Button } from "@/components/ui/button";
import { FileSpreadsheet, FileUp, Download } from "lucide-react";
import { exportCsv } from "@/lib/export";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageTitle } from "@/components/Stat";
import { useQuery } from "@tanstack/react-query";
import { RecordActions } from "@/components/RecordActions";
import { rpc } from "@/lib/rpc";
import { BrandModelFields, useProductCatalog } from "@/components/BrandModelPicker";
import { SearchHistoryBar } from "@/components/SearchHistoryBar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DialogFooter } from "@/components/ui/dialog";

export const Route = createFileRoute("/_authenticated/products")({
  beforeLoad: requireAdmin,
  head: () => pageHead("প্রোডাক্ট", "FIROZA ENTERPRISE products, phone stock and IMEI inventory."),
  component: Products,
});

function Products() {
  const { t } = useT();
  const qc = useQueryClient();
  const { data: products = [] } = useProducts();
  const { brands, models } = useProductCatalog();
  const [search, setSearch] = useState("");
  const [filterBrand, setFilterBrand] = useState("all");
  const [stockFilter, setStockFilter] = useState("all");
  const [brandId, setBrandId] = useState("");
  const [modelId, setModelId] = useState("");
  const { data: counts = {} } = useQuery({
    queryKey: ["imei-counts"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("distribution_stock_counts");
      if (error) throw error;
      return data as Record<string, number>;
    },
  });
  const [f, setF] = useState({ price: "", is_smartphone: true, stock_qty: "" });
  const [imeiFor, setImeiFor] = useState<string | null>(null);
  const [imeiText, setImeiText] = useState("");
  const [imeiCost, setImeiCost] = useState("");
  const [addQty, setAddQty] = useState<Record<string, string>>({});
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [savingLimit, setSavingLimit] = useState<string | null>(null);
  const filteredProducts = products.filter((p) => {
    const brand = brands.find((b) => b.id === (p as any).brand_id)?.name ?? "";
    const model = models.find((m) => m.id === (p as any).model_id)?.name ?? p.model ?? "";
    const q = search.trim().toLowerCase();
    const matchesText = !q || [p.name, p.model, brand, model].some((v) => String(v ?? "").toLowerCase().includes(q));
    const qty = p.is_smartphone ? counts[p.id] ?? 0 : p.stock_qty;
    return matchesText && (filterBrand === "all" || (p as any).brand_id === filterBrand) && (stockFilter === "all" || (stockFilter === "in" ? qty > 0 : qty <= 0));
  });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["products"] }); qc.invalidateQueries({ queryKey: ["imei-counts"] }); qc.invalidateQueries({ queryKey: ["dashboard-insights"] }); };

  async function saveLimit(id: string, current: number) {
    const raw = limits[id] ?? String(current);
    const limit = Number(raw);
    if (!raw.trim() || !Number.isInteger(limit) || limit < 0) { toast.error(t("invalidThreshold")); return; }
    setSavingLimit(id);
    const { error } = await supabase.from("products").update({ low_stock_threshold: limit }).eq("id", id);
    setSavingLimit(null);
    if (error) { toast.error(error.message); return; }
    toast.success(t("done"));
    refresh();
  }

  const [adding, setAdding] = useState(false);
  const [savingImeis, setSavingImeis] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importRows, setImportRows] = useState<Array<{brand:string;model:string;price:number;is_smartphone:boolean;stock_qty:number;brand_id:string;model_id:string;error?:string}>>([]);
  const [importing, setImporting] = useState(false);
  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (adding) return;
    const brand = brands.find((x) => x.id === brandId);
    const model = models.find((x) => x.id === modelId && x.brand_id === brandId);
    const name = brand && model ? `${brand.name} ${model.name}` : "";
    const price = Number(f.price);
    const opening = f.is_smartphone ? 0 : Number(f.stock_qty || 0);
    if (!brandId || !modelId || !name || !Number.isFinite(price) || price < 0 || !Number.isInteger(opening) || opening < 0) {
      toast.error(t("invalidThreshold"));
      return;
    }
    setAdding(true);
    try {
      // Products always start at zero stock; opening stock enters through
      // receive_stock so the movement ledger can reconcile from day one.
      const { data, error } = await supabase.from("products").insert({
        name, model: model?.name ?? null, brand_id: brandId, model_id: modelId, price, is_smartphone: f.is_smartphone, stock_qty: 0,
      }).select("id").single();
      if (error) { toast.error(error.message); return; }
      if (opening > 0 && data) {
        const { error: stockError } = await rpc("receive_stock", { _product: data.id, _qty: opening, _kind: "opening", _reason: "Opening stock at product creation", _date: null, _op: null });
        if (stockError) {
          // The product now exists — do NOT invite a resubmit (it would create
          // a duplicate). Stock can be added from the product card's ± box.
          toast.error(`${stockError.message} — ${t("productCreatedNoStock")}`);
          setF({ price: "", is_smartphone: true, stock_qty: "" }); setBrandId(""); setModelId("");
          refresh();
          return;
        }
      }
      setF({ price: "", is_smartphone: true, stock_qty: "" }); setBrandId(""); setModelId("");
      toast.success(t("done"));
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setAdding(false);
    }
  }

  async function saveImeis() {
    if (!imeiFor || savingImeis) return;
    const raw = imeiText.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const list = [...new Set(raw)];
    const cost = Number(imeiCost);
    const bad = raw.filter((i) => !isValidImeiFormat(i));
    if (!list.length) { toast.error(t("imeiWrong")); return; }
    if (raw.length !== list.length) { toast.error(t("duplicateImei")); return; }
    if (bad.length) { navigator.vibrate?.(300); toast.error(`${t("imeiWrong")} ${bad.join(", ")}`); return; }
    if (!Number.isFinite(cost) || cost <= 0) { toast.error(t("invalidThreshold")); return; }
    setSavingImeis(true);
    try {
      const { error } = await rpc("register_imeis", { _product: imeiFor, _imeis: list, _cost: cost });
      if (error) { toast.error(error.message); return; }
      toast.success(`${list.length} IMEI ${t("done")}`);
      setImeiFor(null); setImeiText(""); setImeiCost(""); refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally { setSavingImeis(false); }
  }

  async function addStock(id: string) {
    const n = Number(addQty[id] || 0);
    if (!Number.isInteger(n) || n === 0) { toast.error(t("invalidThreshold")); return; }
    // Signed adjustment through the validated function; writes a movement every time.
    try {
      const { error } = await rpc("receive_stock", { _product: id, _qty: n, _kind: "adjustment", _reason: "Manual stock adjustment", _date: null, _op: null });
      if (error) { toast.error(error.message); return; }
      setAddQty({ ...addQty, [id]: "" });
      toast.success(t("done"));
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function exportStock() {
    const XLSX = await import("xlsx");
    const rows = products.map((p) => ({
      Brand: brands.find((b) => b.id === (p as any).brand_id)?.name ?? "OTHER",
      Model: models.find((m) => m.id === (p as any).model_id)?.name ?? p.model ?? p.name,
      Price: Number(p.price),
      Type: p.is_smartphone ? "Smartphone" : "Button phone",
      Stock: p.is_smartphone ? counts[p.id] ?? 0 : p.stock_qty,
    }));
    const sheet = XLSX.utils.json_to_sheet(rows);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Products");
    XLSX.writeFile(book, "stock-list.xlsx");
  }

  async function readImport(file: File) {
    try {
      const XLSX = await import("xlsx");
      const data = await file.arrayBuffer();
      const book = XLSX.read(data, { type: "array" });
      const sheet = book.Sheets[book.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
      const rows = raw.map((r, index) => {
        const get = (...keys: string[]) => {
          const key = Object.keys(r).find((k) => keys.includes(k.trim().toLowerCase()));
          return key ? r[key] : "";
        };
        const brand = String(get("brand", "ব্র্যান্ড")).trim();
        const model = String(get("model", "মডেল", "product", "product name", "name", "প্রোডাক্ট")).trim();
        const price = Number(get("price", "selling price", "বিক্রয় মূল্য"));
        const type = String(get("type", "item type", "ধরন")).trim().toLowerCase();
        const is_smartphone = ["smartphone", "smart phone", "smart", "স্মার্টফোন"].includes(type);
        const stockRaw = get("stock", "stock qty", "quantity", "qty", "স্টক");
        const stock_qty = stockRaw === "" ? 0 : Number(stockRaw);
        const b = brands.find((x) => x.name.toLowerCase() === brand.toLowerCase());
        const m = models.find((x) => x.brand_id === b?.id && x.name.toLowerCase() === model.toLowerCase());
        let error = "";
        if (!brand || !model) error = "Brand and model are required";
        else if (!b) error = "Brand not found in catalog";
        else if (!m) error = "Model not found for this brand";
        else if (!Number.isFinite(price) || price < 0) error = "Invalid price";
        else if (!Number.isInteger(stock_qty) || stock_qty < 0) error = "Stock must be a whole number ≥ 0";
        else if (is_smartphone && stock_qty > 0) error = "Smartphone stock must be imported via IMEI purchase";
        return { brand, model, price, is_smartphone, stock_qty, brand_id: b?.id ?? "", model_id: m?.id ?? "", error: error || undefined, row: index + 2 };
      }).filter((r) => r.brand || r.model || r.price);
      setImportRows(rows);
      setImportOpen(true);
      if (!rows.length) toast.error("No product rows found in the first worksheet");
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
  }

  async function confirmImport() {
    const valid = importRows.filter((r) => !r.error);
    if (!valid.length || importing) return;
    setImporting(true);
    let created = 0, failed = 0;
    for (const row of valid) {
      const { data, error } = await supabase.from("products").insert({
        name: `${row.brand} ${row.model}`, model: row.model, brand_id: row.brand_id, model_id: row.model_id,
        price: row.price, is_smartphone: row.is_smartphone, stock_qty: 0,
      }).select("id").single();
      if (error || !data) { failed++; continue; }
      if (!row.is_smartphone && row.stock_qty > 0) {
        const { error: stockError } = await rpc("receive_stock", { _product: data.id, _qty: row.stock_qty, _kind: "opening", _reason: "Opening stock imported from Excel", _date: null, _op: null });
        if (stockError) { failed++; created++; continue; }
      }
      created++;
    }
    setImporting(false);
    setImportOpen(false);
    setImportRows([]);
    refresh();
    toast.success(`${created} products created; ${failed} rows need review`);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PageTitle>{t("products")}</PageTitle>
        <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => document.getElementById("products-excel-import")?.click()}><FileUp className="mr-1 h-4 w-4" />Import Excel</Button><input id="products-excel-import" type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (file) void readImport(file); e.currentTarget.value = ""; }} /><Button size="sm" variant="secondary" onClick={exportStock} disabled={!products.length}><FileSpreadsheet className="mr-1 h-4 w-4" />Export Excel</Button></div>
      </div>
      <SearchHistoryBar value={search} onChange={setSearch} historyKey="products" placeholder="Search product, brand or model…"><Select value={filterBrand} onValueChange={setFilterBrand}><SelectTrigger className="w-[160px]"><SelectValue placeholder="Brand"/></SelectTrigger><SelectContent><SelectItem value="all">All brands</SelectItem>{brands.map(b=><SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent></Select><Select value={stockFilter} onValueChange={setStockFilter}><SelectTrigger className="w-[150px]"><SelectValue placeholder="Stock"/></SelectTrigger><SelectContent><SelectItem value="all">All stock</SelectItem><SelectItem value="in">In stock</SelectItem><SelectItem value="out">Out of stock</SelectItem></SelectContent></Select></SearchHistoryBar>
      <form onSubmit={add} className="grid gap-3 rounded-xl border bg-card p-4 md:grid-cols-6">
        <BrandModelFields brandId={brandId} modelId={modelId} onBrandChange={setBrandId} onModelChange={setModelId} allowManage />
        <Input required type="number" min={0} step="0.01" placeholder={t("price")} value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
        <label className="flex items-center gap-2 text-sm"><Switch checked={f.is_smartphone} onCheckedChange={(v) => setF({ ...f, is_smartphone: v })} />{f.is_smartphone ? t("smartphone") : t("buttonPhone")}</label>
        {!f.is_smartphone ? <Input type="number" min={0} step={1} placeholder={t("stock")} value={f.stock_qty} onChange={(e) => setF({ ...f, stock_qty: e.target.value })} /> : <div />}
        <Button disabled={adding}>{t("add")}</Button>
      </form>
      <div className="grid gap-3 md:grid-cols-2">
        {products.map((p) => (
          <div key={p.id} className="rounded-xl border bg-card p-4">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
              <div className="min-w-0 break-words">
                <div className="font-display text-lg font-bold">{brands.find((b) => b.id === (p as any).brand_id)?.name ?? "OTHER"} {models.find((m) => m.id === (p as any).model_id)?.name ?? p.model ?? p.name} <span className="text-sm font-normal text-muted-foreground">{p.name}</span></div>
                <div className="text-sm text-muted-foreground">{p.is_smartphone ? t("smartphone") : t("buttonPhone")} · {money(p.price)} · {t("costPrice")} {money(p.cost_price)}</div>
                <ProductCatalogAssignment product={p} onSaved={refresh} />
              </div>
              <div className="text-right"><div className="text-xs text-muted-foreground">{t("stock")}</div><div className="font-display text-2xl font-bold">{formatInteger(p.is_smartphone ? counts[p.id] ?? 0 : p.stock_qty)}</div></div>
            </div>
            <div className="mt-3 flex gap-2">
              <RecordActions table="products" id={p.id} fields={[{ key: "name", label: "name", value: p.name }, { key: "model", label: "model", value: p.model }, { key: "price", label: "price", value: Number(p.price), type: "number" }]} />
              {p.is_smartphone ? (
                <Button size="sm" variant="secondary" onClick={() => setImeiFor(p.id)}>{t("addImei")}</Button>
              ) : (
                <>
                  <Input className="h-8 w-24" type="number" step={1} value={addQty[p.id] ?? ""} onChange={(e) => setAddQty({ ...addQty, [p.id]: e.target.value })} />
                  <Button size="sm" variant="secondary" onClick={() => addStock(p.id)}>± {t("adjustment")}</Button>
                </>
              )}
            </div>
            <div className="mt-3 border-t pt-3">
              <Label htmlFor={`limit-${p.id}`}>{t("stockThreshold")}</Label>
              <div className="mt-1 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <Input id={`limit-${p.id}`} type="number" min={0} step={1} value={limits[p.id] ?? String(p.low_stock_threshold)} onChange={(e) => setLimits({ ...limits, [p.id]: e.target.value })} />
                <Button size="sm" variant="outline" disabled={savingLimit === p.id} onClick={() => saveLimit(p.id, p.low_stock_threshold)}>{t("save")}</Button>
              </div>
              {p.low_stock_threshold === 0 && <p className="mt-1 text-xs text-muted-foreground">{t("thresholdUnset")}</p>}
            </div>
          </div>
        ))}
      </div>
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>Excel import preview</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">Only existing Brand and Model catalog entries are accepted. Smartphone IMEI stock must be entered through purchase/IMEI registration.</p>
          <div className="max-h-[55vh] overflow-auto rounded border">
            <table className="w-full text-sm"><thead className="sticky top-0 bg-muted"><tr><th className="p-2 text-left">Brand</th><th className="p-2 text-left">Model</th><th className="p-2 text-right">Price</th><th className="p-2 text-right">Stock</th><th className="p-2 text-left">Validation</th></tr></thead><tbody>
              {importRows.map((r,i)=><tr key={i} className="border-t"><td className="p-2">{r.brand}</td><td className="p-2">{r.model}</td><td className="p-2 text-right">{r.price}</td><td className="p-2 text-right">{r.stock_qty}</td><td className={r.error?"p-2 text-destructive":"p-2 text-emerald-600"}>{r.error ?? "Ready"}</td></tr>)}
            </tbody></table>
          </div>
          <DialogFooter><Button type="button" variant="outline" onClick={()=>setImportOpen(false)}>Cancel</Button><Button type="button" disabled={importing || !importRows.some(r=>!r.error)} onClick={confirmImport}>{importing?"Importing…":`Import ${importRows.filter(r=>!r.error).length} products`}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!imeiFor} onOpenChange={(o) => !o && setImeiFor(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t("addImei")}</DialogTitle></DialogHeader>
          <Label>{t("imeiList")}</Label>
          <Textarea rows={8} value={imeiText} onChange={(e) => setImeiText(e.target.value)} />
          <div className="space-y-1"><Label>{t("costPrice")}</Label><Input type="number" min={0.01} step="0.01" value={imeiCost} onChange={(e) => setImeiCost(e.target.value)} /></div>
          <Button disabled={savingImeis} onClick={saveImeis}>{t("save")}</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProductCatalogAssignment({ product, onSaved }: { product: any; onSaved: () => void }) {
  const [brandId, setBrandId] = useState(product.brand_id ?? "");
  const [modelId, setModelId] = useState(product.model_id ?? "");
  const [saving, setSaving] = useState(false);
  async function save() {
    if (!brandId || !modelId || saving) return;
    setSaving(true);
    const { data: brand } = await (supabase as any).from("product_brands").select("name").eq("id", brandId).single();
    const { data: model } = await (supabase as any).from("product_models").select("name").eq("id", modelId).eq("brand_id", brandId).single();
    if (!brand || !model) { toast.error("Select a valid brand and model"); setSaving(false); return; }
    const { error } = await supabase.from("products").update({ brand_id: brandId, model_id: modelId, model: model.name, name: `${brand.name} ${model.name}` }).eq("id", product.id);
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Product brand/model updated");
    onSaved();
  }
  return (
    <div className="mt-2 space-y-2">
      <BrandModelFields brandId={brandId} modelId={modelId} onBrandChange={setBrandId} onModelChange={setModelId} allowManage />
      <Button type="button" size="sm" variant="outline" disabled={!brandId || !modelId || saving} onClick={save}>Save brand/model</Button>
    </div>
  );
}
