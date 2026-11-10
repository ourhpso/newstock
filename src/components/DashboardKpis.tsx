import { Stat } from "@/components/Stat";
import { useT } from "@/lib/i18n";
import { formatInteger, money } from "@/lib/imei";
import type { DashboardInsights } from "@/lib/dashboard";

export function DashboardKpis({ data, isAdmin }: { data: DashboardInsights; isAdmin: boolean }) {
  const { t } = useT();
  return <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
    <Stat label={t("todaySales")} value={money(data.todaySales)} />
    <Stat label={t("monthSales")} value={money(data.monthSales)} />
    <Stat label={t("sales")} value={money(data.salesTotal)} />
    <Stat label={t("totalCollected")} value={money(data.collected)} tone="good" />
    <Stat label={t("cashInHand")} value={money(data.cashInHand)} tone="accent" />
    <Stat label={t("deposited")} value={money(data.deposited)} tone="good" />
    <Stat label={t("retailerDue")} value={money(data.retailerDue)} tone="bad" />
    <Stat label={t("overdueBalance")} value={money(data.overdueTotal)} tone="bad" />
    {isAdmin && <><Stat label={t("warehouseStock")} value={formatInteger(data.warehouseQty ?? 0)} /><Stat label={t("warehouseValue")} value={money(data.warehouseValue)} /></>}
    <Stat label={t("inHand")} value={formatInteger(data.heldQty)} />
    <Stat label={t("goodsValue")} value={money(data.heldValue)} />
    <Stat label={t("returned")} value={formatInteger(data.returnedQty)} />
    <Stat label={t("damaged")} value={formatInteger(data.damagedQty)} tone="bad" />
    <Stat label={t("retailerCount")} value={formatInteger(data.retailerCount)} />
    <Stat label={t("invoiceCount")} value={formatInteger(data.invoiceCount)} />
    {isAdmin && <><Stat label={t("activeSalesmen")} value={formatInteger(data.activeSalesmen)} /><Stat label={t("lowStockProducts")} value={formatInteger(data.lowStock.length)} tone={data.lowStock.length ? "bad" : "good"} /></>}
  </div>;
}