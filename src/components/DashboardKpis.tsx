import { Stat } from "@/components/Stat";
import { useT } from "@/lib/i18n";
import { formatInteger, money } from "@/lib/imei";
import type { DashboardInsights } from "@/lib/dashboard";

export function DashboardKpis({ data, isAdmin }: { data: DashboardInsights; isAdmin: boolean }) {
  const { t } = useT();
  return <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
    <Stat label={t("todaySales")} value={money(data.todaySales)} to="/sales" />
    <Stat label={t("monthSales")} value={money(data.monthSales)} to="/sales" />
    <Stat label={t("sales")} value={money(data.salesTotal)} to="/sales" />
    <Stat label={t("totalCollected")} value={money(data.collected)} tone="good" to="/settlement" />
    <Stat label={t("cashInHand")} value={money(data.cashInHand)} tone="accent" to="/settlement" />
    <Stat label={t("deposited")} value={money(data.deposited)} tone="good" to="/settlement" />
    <Stat label={t("retailerDue")} value={money(data.retailerDue)} tone="bad" to="/retailers" />
    <Stat label={t("overdueBalance")} value={money(data.overdueTotal)} tone="bad" to="/retailers" />
    {isAdmin && <><Stat label={t("warehouseStock")} value={formatInteger(data.warehouseQty ?? 0)} to="/products" /><Stat label={t("warehouseValue")} value={money(data.warehouseValue)} to="/products" /></>}
    <Stat label={t("inHand")} value={formatInteger(data.heldQty)} to="/stock-issue" />
    <Stat label={t("goodsValue")} value={money(data.heldValue)} to="/stock-issue" />
    <Stat label={t("returned")} value={formatInteger(data.returnedQty)} to="/stock-issue" />
    <Stat label={t("damaged")} value={formatInteger(data.damagedQty)} tone="bad" to="/stock-issue" />
    <Stat label={t("retailerCount")} value={formatInteger(data.retailerCount)} to="/retailers" />
    <Stat label={t("invoiceCount")} value={formatInteger(data.invoiceCount)} to="/sales" />
    {isAdmin && <><Stat label={t("activeSalesmen")} value={formatInteger(data.activeSalesmen)} to="/salesmen" /><Stat label={t("lowStockProducts")} value={formatInteger(data.lowStock.length)} tone={data.lowStock.length ? "bad" : "good"} to="/products" /></>}
  </div>;
}
