import { useQuery, type QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { DEFAULT_PERMISSIONS, type AccessPermissions } from "@/lib/access";
import { rpc, type RetailerLedger } from "@/lib/rpc";

export type Me = { id: string; email: string | undefined; isAdmin: boolean; active: boolean; permissions: AccessPermissions; profile: { full_name: string; active: boolean } | null };

/**
 * Current user + role, cached so guards and pages share one fetch.
 * Session is read locally (getSession) — real access control stays in RLS.
 */
export const meQueryOptions = {
  queryKey: ["me"],
  staleTime: 60_000,
  queryFn: async (): Promise<Me | null> => {
    const { data: s } = await supabase.auth.getSession();
    const user = s.session?.user;
    if (!user) return null;
    const [{ data: roles }, { data: profile }, { data: override }] = await Promise.all([
      supabase.from("user_roles").select("role").eq("user_id", user.id),
      supabase.from("profiles").select("full_name,active").eq("id", user.id).maybeSingle(),
      supabase.from("user_permission_overrides").select("permissions").eq("user_id", user.id).maybeSingle(),
    ]);
    const isAdmin = !!roles?.some((r) => r.role === "admin");
    const active = profile?.active === true;
    const permissions = { ...DEFAULT_PERMISSIONS };
    const saved = override?.permissions;
    if (saved && typeof saved === "object" && !Array.isArray(saved)) for (const key of Object.keys(permissions) as (keyof AccessPermissions)[]) if (typeof saved[key] === "boolean") permissions[key] = saved[key];
    if (!active) for (const key of Object.keys(permissions) as (keyof AccessPermissions)[]) permissions[key] = false;
    return { id: user.id, email: user.email, isAdmin: active && isAdmin, active, permissions, profile };
  },
};

/** Route guard: only admins may proceed; salesmen are sent to their dashboard. Reuses the cached "me" query. */
export async function requireAdmin({ context }: { context: { queryClient: QueryClient } }) {
  // Role/permission state is never trusted from a previous offline session.
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    throw new Error("ইন্টারনেট সংযোগ ছাড়া প্রশাসনিক অনুমতি যাচাই করা যাবে না। সংযোগ ফিরলে আবার চেষ্টা করুন।");
  }
  const me = await context.queryClient.fetchQuery({ ...meQueryOptions, staleTime: 0 });
  if (!me) throw redirect({ to: "/auth" });
  if (!me.isAdmin) throw redirect({ to: "/dashboard" });
}

export function useMe() {
  return useQuery({ ...meQueryOptions, refetchInterval: 30_000 });
}

export function useSalesmen() {
  return useQuery({
    queryKey: ["salesmen"],
    queryFn: async () => {
      const { data: roles } = await supabase.from("user_roles").select("user_id").eq("role", "salesman");
      const ids = (roles ?? []).map((r) => r.user_id);
      if (!ids.length) return [];
      const { data } = await supabase.from("profiles").select("*").in("id", ids).order("full_name");
      return data ?? [];
    },
  });
}

export function useProducts() {
  return useQuery({
    queryKey: ["products"],
    queryFn: async () => {
      const { data, error } = await supabase.from("products").select("*").order("name");
      if (error) throw error;
      return data;
    },
  });
}

/** Per-product holding and account summary for a salesman (server-side, uncapped). */
export type SalesmanSummaryData = {
  products: { product_id: string; name: string; isSmart: boolean; issued: number; sold: number; returned: number; damaged: number; hand: number; value: number }[];
  handImeis: { imei: string; product_id: string; status: string }[];
  salesTotal: number;
  cashInHand: number;
  retailerDue: number;
  returnsTotal: number;
  deposited: number;
  deposits: { id: string; salesman_id: string; amount: number; method: string | null; note: string | null; receipt_no: string | null; txn_date: string | null; client_op_id: string | null; created_at: string }[];
  owesDealer: number;
};

export function useSalesmanSummary(salesmanId: string | undefined) {
  return useQuery({
    enabled: !!salesmanId,
    queryKey: ["summary", salesmanId],
    queryFn: async (): Promise<SalesmanSummaryData> => {
      if (!salesmanId) throw new Error("Salesman required");
      const { data, error } = await rpc<SalesmanSummaryData>("salesman_summary", { _salesman: salesmanId });
      if (error) throw new Error(error.message);
      if (!data) throw new Error("Summary unavailable");
      return data;
    },
  });
}

export function useRetailers() {
  return useQuery({
    queryKey: ["retailers"],
    queryFn: async () => (await supabase.from("retailers").select("*").order("name")).data ?? [],
  });
}

/** Authoritative per-retailer balances from the database (sales - paid - collections - returns). */
export function useRetailerLedgers() {
  return useQuery({
    queryKey: ["retailer-ledgers"],
    queryFn: async () => {
      const { data, error } = await rpc<RetailerLedger[]>("retailer_ledgers");
      if (error) throw new Error(error.message);
      return (data ?? []).map((r) => ({ ...r, sales_total: Number(r.sales_total), paid_at_sale: Number(r.paid_at_sale), collected: Number(r.collected), returns_total: Number(r.returns_total), due: Number(r.due), credit_limit: r.credit_limit === null ? null : Number(r.credit_limit) }));
    },
  });
}
