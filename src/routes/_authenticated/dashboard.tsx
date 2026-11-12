import { pageHead } from "@/lib/page-head";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useMe, useSalesmen, useSalesmanSummary } from "@/lib/me";
import { useT } from "@/lib/i18n";
import { money } from "@/lib/imei";
import { PageTitle } from "@/components/Stat";
import { DashboardAlerts } from "@/components/DashboardAlerts";
import { DashboardKpis } from "@/components/DashboardKpis";
import { DealerRiskList } from "@/components/DealerRiskList";
import { useDashboardInsights } from "@/lib/dashboard";
import { SalesmanSummary } from "@/components/SalesmanSummary";
import { SrLocationShare } from "@/components/SrLocationShare";
import { Button } from "@/components/ui/button";
import { FileSpreadsheet } from "lucide-react";
import { exportCsv } from "@/lib/export";
import { ActivityHistory } from "@/components/ActivityHistory";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => pageHead("ড্যাশবোর্ড", "FIROZA ENTERPRISE stock, sales, deposits and retailer balances."),
  component: Dashboard,
});

function Dashboard() {
  const { data: me } = useMe();
  const { t } = useT();
  const insights = useDashboardInsights();
  if (!me) return null;
  if (insights.isPending) return <p role="status">{t("loading")}</p>;
  if (insights.isError || !insights.data) return <div className="space-y-3"><p className="text-destructive">{t("loadFailed")}</p><Button onClick={() => insights.refetch()}>{t("retry")}</Button></div>;
  if (!me.isAdmin) {
    return (
      <div className="space-y-6">
        <PageTitle>{t("dashboard")}</PageTitle>
        <SrWorkGuide salesmanId={me.id} retailerCount={insights.data.retailerCount} />
        <DashboardAlerts data={insights.data} isAdmin={false} />
        <DashboardKpis data={insights.data} isAdmin={false} />
        <SrLocationShare salesmanId={me.id} />
        <SalesmanSummary salesmanId={me.id} />
        <ActivityHistory />
      </div>
    );
  }
  return <AdminDash />;
}

function AdminDash() {
  const { t } = useT();
  const { data: insights } = useDashboardInsights();
  const { data: salesmen = [] } = useSalesmen();
  const { data: agg } = useQuery({
    queryKey: ["admin-agg"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("distribution_dashboard");
      if (error) throw error;
      return data as unknown as { inStock: number; withSales: number; damaged: number; salesTotal: number; due: number; deposited: number; salesBy: Record<string, number>; paidBy: Record<string, number>; collectedBy: Record<string, number>; depBy: Record<string, number> };
    },
  });
  function exportSummary() {
    const rows: (string | number)[][] = [[t("salesmen"), t("sales"), t("deposited"), t("cashInHand")]];
    for (const s of salesmen) {
      const cash = (agg?.paidBy[s.id] ?? 0) + (agg?.collectedBy[s.id] ?? 0) - (agg?.depBy[s.id] ?? 0);
      rows.push([s.full_name, Math.round(agg?.salesBy[s.id] ?? 0), Math.round(agg?.depBy[s.id] ?? 0), Math.round(cash)]);
    }
    rows.push([], [t("sales"), Math.round(agg?.salesTotal ?? 0)], [t("deposited"), Math.round(agg?.deposited ?? 0)], [t("retailerDue"), Math.round(agg?.due ?? 0)]);
    exportCsv("dashboard-summary.csv", rows, t("dashboard"));
  }
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:flex sm:justify-between">
        <PageTitle>{t("dashboard")}</PageTitle>
        <Button size="sm" variant="secondary" onClick={exportSummary} disabled={!agg}>
          <FileSpreadsheet className="mr-1 h-4 w-4" />{t("export")}
        </Button>
      </div>
      {insights && <DashboardKpis data={insights} isAdmin />}
      <ActivityHistory />
      <div className="rounded-xl border bg-card p-4">
        <h2 className="mb-3 font-display font-bold">{t("salesmen")}</h2>
        <div className="grid gap-2">
          {salesmen.map((s) => {
            const cash = (agg?.paidBy[s.id] ?? 0) + (agg?.collectedBy[s.id] ?? 0) - (agg?.depBy[s.id] ?? 0);
            return (
              <Link key={s.id} to="/salesmen" className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2 text-sm transition-colors hover:bg-accent/40">
                <span className="font-semibold">{s.full_name}</span>
                <span>{t("sales")}: {money(agg?.salesBy[s.id])}</span>
                <span>{t("deposited")}: {money(agg?.depBy[s.id])}</span>
                <span className="font-bold text-accent-foreground">{t("cashInHand")}: {money(cash)}</span>
              </Link>
            );
          })}
          {salesmen.length === 0 && <p className="text-sm text-muted-foreground">{t("noData")}</p>}
        </div>
      </div>
      {insights && <><DashboardAlerts data={insights} isAdmin /><DealerRiskList /></>}
    </div>
  );
}


function SrWorkGuide({ salesmanId, retailerCount }: { salesmanId: string; retailerCount: number }) {
  const { t } = useT();
  const { data } = useSalesmanSummary(salesmanId);
  const tasks = [
    ...(data && data.products.length === 0 ? [{ title: t("srNoStockTitle"), detail: t("srNoStockHelp") }] : []),
    ...(retailerCount === 0 ? [{ title: t("srNoRetailerTitle"), detail: t("srNoRetailerHelp") }] : []),
    ...(data && data.cashInHand > 0 ? [{ title: t("srDepositTitle"), detail: t("srDepositHelp") }] : []),
    ...(data && data.products.some((p) => p.hand > 0) ? [{ title: t("srReturnTitle"), detail: t("srReturnHelp") }] : []),
  ];
  if (!tasks.length) return null;
  return <section className="space-y-3 rounded-xl border bg-card p-4">
    <h2 className="font-display font-bold">{t("srWorkTitle")}</h2>
    <div className="grid gap-2 sm:grid-cols-2">
      {tasks.map((task) => <div key={task.title} className="rounded-lg bg-muted p-3">
        <p className="font-semibold">{task.title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{task.detail}</p>
      </div>)}
    </div>
  </section>;
}
