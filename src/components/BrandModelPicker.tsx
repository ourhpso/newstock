import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useProducts } from "@/lib/me";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type ProductBrand = { id: string; name: string };
export type ProductModel = { id: string; brand_id: string; name: string };
function recentIds(key:string):string[]{try{const x=JSON.parse(localStorage.getItem("newstock:recent:"+key)||"[]");return Array.isArray(x)?x.filter((v):v is string=>typeof v==="string"):[]}catch{return []}}
function rememberId(key:string,id:string){try{localStorage.setItem("newstock:recent:"+key,JSON.stringify([id,...recentIds(key).filter(x=>x!==id)].slice(0,6)))}catch{}}
function recentFirst<T extends {id:string}>(items:T[],key:string){const ids=recentIds(key);return [...items].sort((a,b)=>{const ai=ids.indexOf(a.id),bi=ids.indexOf(b.id);return (ai<0?999:ai)-(bi<0?999:bi)})}
function recentChips<T extends {id:string;name:string}>(items:T[],key:string,onPick:(id:string)=>void){const ids=recentIds(key);return ids.map(id=>items.find(x=>x.id===id)).filter((x):x is T=>!!x).slice(0,4).map(x=><Button key={x.id} type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={()=>onPick(x.id)}>{x.name}</Button>)}

export function useProductCatalog() {
  const db = supabase as any;
  const brands = useQuery<ProductBrand[]>({
    queryKey: ["product-brands"],
    queryFn: async () => {
      const { data, error } = await db.from("product_brands").select("id,name").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
  const models = useQuery<ProductModel[]>({
    queryKey: ["product-models"],
    queryFn: async () => {
      const { data, error } = await db.from("product_models").select("id,brand_id,name").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
  return { brands: brands.data ?? [], models: models.data ?? [], isLoading: brands.isLoading || models.isLoading };
}

export function useProductLabel() {
  const { data: products = [] } = useProducts();
  const { brands, models } = useProductCatalog();
  return (productId: string) => {
    const p = products.find((x) => x.id === productId);
    if (!p) return "";
    const brand = brands.find((b) => b.id === (p as any).brand_id)?.name ?? "OTHER";
    const model = models.find((m) => m.id === (p as any).model_id)?.name ?? p.model ?? "";
    return [brand, model || p.name].filter(Boolean).join(" ");
  };
}

/** Cascading brand -> model -> stocked product selector. Admins can extend the catalog inline. */
export function BrandModelProductPicker({
  value, onChange, allowManage = false, placeholder = "Select product", showStock = true, onlyProductIds, excludeSmartphones = false, stockByProductId,
}: {
  value: string;
  onChange: (productId: string) => void;
  allowManage?: boolean;
  placeholder?: string;
  showStock?: boolean;
  onlyProductIds?: string[];
  excludeSmartphones?: boolean;
  stockByProductId?: Record<string, number>;
}) {
  const db = supabase as any;
  const qc = useQueryClient();
  const { data: products = [] } = useProducts();
  const { brands, models } = useProductCatalog();
  const selected = products.find((p) => p.id === value) as any;
  const [brandId, setBrandId] = useState(selected?.brand_id ?? "");
  const [modelId, setModelId] = useState(selected?.model_id ?? "");
  const [newBrand, setNewBrand] = useState("");
  const [newModel, setNewModel] = useState("");
  useEffect(() => {
    if (selected) { setBrandId(selected.brand_id ?? ""); setModelId(selected.model_id ?? ""); }
  }, [selected?.id, selected?.brand_id, selected?.model_id]);
  const { data: counts = {} } = useQuery<Record<string, number>>({
    queryKey: ["imei-counts"],
    queryFn: async () => {
      const { data, error } = await db.rpc("distribution_stock_counts");
      if (error) throw error;
      return (data ?? {}) as Record<string, number>;
    },
  });
  const otherBrandId = brands.find((b) => b.name === "OTHER")?.id;
  const brandModels = models.filter((m) => m.brand_id === brandId);
  const brandProducts = products.filter((p) => ((p as any).brand_id === brandId || (brandId === otherBrandId && !(p as any).brand_id)) && (!onlyProductIds || onlyProductIds.includes(p.id)) && (!excludeSmartphones || !p.is_smartphone));
  const productModelName = (p: any) => String(p.model ?? p.name).trim().toLowerCase();
  const availableModels = brandModels.filter((m) => brandProducts.some((p) => (p as any).model_id === m.id || (!(p as any).model_id && productModelName(p) === m.name.trim().toLowerCase())));
  const matchingModels = brandModels.filter((m) => m.id === modelId);
  const matchingProducts = brandProducts.filter((p) => (p as any).model_id === modelId || (!(p as any).model_id && matchingModels.some((m) => productModelName(p) === m.name.trim().toLowerCase())));
  async function addBrand() {
    const name = newBrand.trim().toUpperCase();
    if (!name) return;
    const { data, error } = await db.from("product_brands").insert({ name }).select("id").single();
    if (error) { toast.error(error.message); return; }
    await qc.invalidateQueries({ queryKey: ["product-brands"] });
    setBrandId(data.id); setModelId(""); onChange("");
    setNewBrand("");
    toast.success("Brand added");
  }
  async function addModel() {
    const name = newModel.trim();
    if (!brandId || !name) return;
    const { data, error } = await db.from("product_models").insert({ brand_id: brandId, name }).select("id").single();
    if (error) { toast.error(error.message); return; }
    await qc.invalidateQueries({ queryKey: ["product-models"] });
    setModelId(data.id); onChange("");
    setNewModel("");
    toast.success("Model added");
  }
  return (
    <div className="grid gap-2">
      {recentChips(brands,"brand",(v)=>{setBrandId(v);setModelId("");onChange("");}) .length>0 && <div className="flex flex-wrap gap-1">{recentChips(brands,"brand",(v)=>{setBrandId(v);setModelId("");onChange("");})}</div>}
      <Select value={brandId} onValueChange={(v) => { setBrandId(v); rememberId("brand",v); setModelId(""); onChange(""); }}>
        <SelectTrigger><SelectValue placeholder="Brand" /></SelectTrigger>
        <SelectContent>{recentFirst(brands,"brand").map((b) => <SelectItem key={b.id} value={b.id}>{recentIds("brand").includes(b.id)?"↻ ":""}{b.name}</SelectItem>)}</SelectContent>
      </Select>
      {allowManage && (
        <div className="flex gap-2">
          <Input value={newBrand} onChange={(e) => setNewBrand(e.target.value)} placeholder="Add another brand" />
          <Button type="button" size="sm" variant="outline" onClick={addBrand} disabled={!newBrand.trim()}>+</Button>
        </div>
      )}
      {brandId && recentChips(availableModels,"model:"+brandId,(v)=>{setModelId(v);onChange("");}).length>0 && <div className="flex flex-wrap gap-1">{recentChips(availableModels,"model:"+brandId,(v)=>{setModelId(v);onChange("");})}</div>}
      <Select value={modelId} disabled={!brandId} onValueChange={(v) => { setModelId(v); rememberId("model:"+brandId,v); onChange(""); }}>
        <SelectTrigger><SelectValue placeholder="Model" /></SelectTrigger>
        <SelectContent>{recentFirst(availableModels,"model:"+brandId).map((m) => <SelectItem key={m.id} value={m.id}>{recentIds("model:"+brandId).includes(m.id)?"↻ ":""}{m.name}</SelectItem>)}</SelectContent>
      </Select>
      {allowManage && brandId && (
        <div className="flex gap-2">
          <Input value={newModel} onChange={(e) => setNewModel(e.target.value)} placeholder="Add model for selected brand" />
          <Button type="button" size="sm" variant="outline" onClick={addModel} disabled={!newModel.trim()}>+</Button>
        </div>
      )}
      {modelId && recentChips(matchingProducts,"product",(v)=>{rememberId("product",v);onChange(v);}).length>0 && <div className="flex flex-wrap gap-1">{recentChips(matchingProducts,"product",(v)=>{rememberId("product",v);onChange(v);})}</div>}
      <Select value={value} disabled={!modelId} onValueChange={(v)=>{rememberId("product",v);onChange(v);}}> 
        <SelectTrigger><SelectValue placeholder={placeholder} /></SelectTrigger>
        <SelectContent>
          {recentFirst(matchingProducts,"product").map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {(p as any).name} {showStock ? `· Stock: ${stockByProductId?.[p.id] ?? (p.is_smartphone ? counts[p.id] ?? 0 : p.stock_qty)}` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function BrandModelFields({
  brandId, modelId, onBrandChange, onModelChange, allowManage = false,
}: {
  brandId: string;
  modelId: string;
  onBrandChange: (id: string) => void;
  onModelChange: (id: string) => void;
  allowManage?: boolean;
}) {
  const db = supabase as any;
  const qc = useQueryClient();
  const { brands, models } = useProductCatalog();
  const [newBrand, setNewBrand] = useState("");
  const [newModel, setNewModel] = useState("");
  async function addBrand() {
    const name = newBrand.trim().toUpperCase();
    if (!name) return;
    const { data, error } = await db.from("product_brands").insert({ name }).select("id").single();
    if (error) { toast.error(error.message); return; }
    await qc.invalidateQueries({ queryKey: ["product-brands"] });
    onBrandChange(data.id); onModelChange(""); setNewBrand("");
  }
  async function addModel() {
    const name = newModel.trim();
    if (!brandId || !name) return;
    const { data, error } = await db.from("product_models").insert({ brand_id: brandId, name }).select("id").single();
    if (error) { toast.error(error.message); return; }
    await qc.invalidateQueries({ queryKey: ["product-models"] });
    onModelChange(data.id); setNewModel("");
  }
  return (
    <div className="grid gap-2">
      {recentChips(brands,"brand",(v)=>{onBrandChange(v);onModelChange("");}).length>0 && <div className="flex flex-wrap gap-1">{recentChips(brands,"brand",(v)=>{onBrandChange(v);onModelChange("");})}</div>}
      <Select value={brandId} onValueChange={(v) => { rememberId("brand",v); onBrandChange(v); onModelChange(""); }}>
        <SelectTrigger><SelectValue placeholder="Brand" /></SelectTrigger>
        <SelectContent>{brands.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
      </Select>
      {allowManage && <div className="flex gap-2"><Input value={newBrand} onChange={(e) => setNewBrand(e.target.value)} placeholder="Add another brand" /><Button type="button" size="sm" variant="outline" onClick={addBrand} disabled={!newBrand.trim()}>+</Button></div>}
      {brandId && recentChips(models.filter((m)=>m.brand_id===brandId),"model:"+brandId,onModelChange).length>0 && <div className="flex flex-wrap gap-1">{recentChips(models.filter((m)=>m.brand_id===brandId),"model:"+brandId,onModelChange)}</div>}
      <Select value={modelId} disabled={!brandId} onValueChange={(v) => { rememberId("model:"+brandId,v); onModelChange(v); }}>
        <SelectTrigger><SelectValue placeholder="Model" /></SelectTrigger>
        <SelectContent>{models.filter((m) => m.brand_id === brandId).map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}</SelectContent>
      </Select>
      {allowManage && brandId && <div className="flex gap-2"><Input value={newModel} onChange={(e) => setNewModel(e.target.value)} placeholder="Add model for selected brand" /><Button type="button" size="sm" variant="outline" onClick={addModel} disabled={!newModel.trim()}>+</Button></div>}
    </div>
  );
}
