import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useProducts } from "@/lib/me";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type ProductBrand = { id: string; name: string };
export type ProductModel = { id: string; brand_id: string; name: string };

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
    const brand = brands.find((b) => b.id === (p as any).brand_id)?.name;
    const model = models.find((m) => m.id === (p as any).model_id)?.name ?? p.model ?? "";
    return [brand, model || p.name].filter(Boolean).join(" ");
  };
}

/** Cascading brand -> model -> stocked product selector. Admins can extend the catalog inline. */
export function BrandModelProductPicker({
  value, onChange, allowManage = false, placeholder = "Select product", showStock = true,
}: {
  value: string;
  onChange: (productId: string) => void;
  allowManage?: boolean;
  placeholder?: string;
  showStock?: boolean;
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
  const [counts, setCounts] = useState<Record<string, number>>({});
  useMemo(() => {
    if (selected) { setBrandId(selected.brand_id ?? ""); setModelId(selected.model_id ?? ""); }
  }, [selected?.id, selected?.brand_id, selected?.model_id]);
  useMemo(() => {
    let active = true;
    db.rpc("distribution_stock_counts").then(({ data, error }: any) => {
      if (active && !error && data && typeof data === "object") setCounts(data as Record<string, number>);
    });
    return () => { active = false; };
  }, []);
  const brandModels = models.filter((m) => m.brand_id === brandId);
  const brandProducts = products.filter((p) => (p as any).brand_id === brandId);
  const availableModels = brandModels.filter((m) => brandProducts.some((p) => (p as any).model_id === m.id));
  const matchingProducts = brandProducts.filter((p) => (p as any).model_id === modelId);
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
      <Select value={brandId} onValueChange={(v) => { setBrandId(v); setModelId(""); onChange(""); }}>
        <SelectTrigger><SelectValue placeholder="Brand" /></SelectTrigger>
        <SelectContent>{brands.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
      </Select>
      {allowManage && (
        <div className="flex gap-2">
          <Input value={newBrand} onChange={(e) => setNewBrand(e.target.value)} placeholder="Add another brand" />
          <Button type="button" size="sm" variant="outline" onClick={addBrand} disabled={!newBrand.trim()}>+</Button>
        </div>
      )}
      <Select value={modelId} disabled={!brandId} onValueChange={(v) => { setModelId(v); onChange(""); }}>
        <SelectTrigger><SelectValue placeholder="Model" /></SelectTrigger>
        <SelectContent>{availableModels.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}</SelectContent>
      </Select>
      {allowManage && brandId && (
        <div className="flex gap-2">
          <Input value={newModel} onChange={(e) => setNewModel(e.target.value)} placeholder="Add model for selected brand" />
          <Button type="button" size="sm" variant="outline" onClick={addModel} disabled={!newModel.trim()}>+</Button>
        </div>
      )}
      <Select value={value} disabled={!modelId} onValueChange={onChange}>
        <SelectTrigger><SelectValue placeholder={placeholder} /></SelectTrigger>
        <SelectContent>
          {matchingProducts.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {(p as any).name} {showStock ? `· Stock: ${p.is_smartphone ? counts[p.id] ?? 0 : p.stock_qty}` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
