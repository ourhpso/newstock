import { useMe, useSalesmanSummary } from "@/lib/me";
import { useT } from "@/lib/i18n";
import { formatInteger, money } from "@/lib/imei";
import { Stat } from "./Stat";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function SalesmanSummary({ salesmanId }: { salesmanId: string }) {
  const { t } = useT();
  const { data: me } = useMe();
  const { data, isPending, isError, error, refetch } = useSalesmanSummary(salesmanId);
  if (isPending) return <p className="text-sm text-muted-foreground">হিসাব ও পণ্যের তথ্য লোড হচ্ছে…</p>;
  if (isError) return <div className="flex flex-wrap items-center gap-2 text-sm text-destructive"><span>তথ্য আনা যায়নি: {(error as Error).message}</span><button type="button" className="underline" onClick={() => refetch()}>আবার চেষ্টা করুন</button></div>;
  if (!data) return <p className="text-sm text-muted-foreground">হিসাবের তথ্য পাওয়া যায়নি।</p>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label={t("sales")} value={money(data.salesTotal)} to="/sales" />
        <Stat label={t("cashInHand")} value={money(data.cashInHand)} tone="accent" to="/settlement" />
        <Stat label={t("deposited")} value={money(data.deposited)} tone="good" to="/settlement" />
        <Stat label={t("retailerDue")} value={money(data.retailerDue)} tone="bad" to="/retailers" />
        <Stat label={t("goodsValue")} value={money(data.products.reduce((a, p) => a + p.value, 0))} to="/settlement" />
      </div>
      <div className="rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("products")}</TableHead>
              <TableHead>{t("issued")}</TableHead>
              <TableHead>{t("sold")}</TableHead>
              <TableHead>{t("returned")}</TableHead>
              <TableHead>{t("damaged")}</TableHead>
              <TableHead>{t("inHand")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.products.length === 0 && (
              <TableRow><TableCell colSpan={6} className="space-y-1 py-5 text-center text-muted-foreground">
                <div className="font-semibold">{me?.isAdmin ? "এই এস আর-এর নামে এখনো পণ্য বরাদ্দ হয়নি" : t("srNoStockTitle")}</div>
                <div className="text-xs">{me?.isAdmin ? "মাল দেওয়া পেইজ থেকে পণ্য বরাদ্দ পাঠান। এস আর গ্রহণ নিশ্চিত করার পর এখানে স্টক দেখা যাবে।" : t("srNoStockHelp")}</div>
              </TableCell></TableRow>
            )}
            {data.products.map((p) => (
              <TableRow key={p.product_id}>
                <TableCell className="font-medium">{p.name}</TableCell>
                <TableCell>{formatInteger(p.issued)}</TableCell>
                <TableCell>{formatInteger(p.sold)}</TableCell>
                <TableCell>{formatInteger(p.returned)}</TableCell>
                <TableCell>{formatInteger(p.damaged)}</TableCell>
                <TableCell className="font-bold">{formatInteger(p.hand)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
