import { useT } from "@/lib/i18n";
import type { Business } from "@/lib/business";

export type DetailedReportRow = {
  date: string; salesman: string; retailer: string; type: string; reference: string;
  product: string; qty: number; debit: number; credit: number; note?: string;
};

export function DetailedReportDoc({ business, title, period, rows, totals }: {
  business: Business; title: string; period: string; rows: DetailedReportRow[];
  totals: { sales: number; collections: number; returns: number; deposits: number; stockIssued: number; stockReturned: number };
}) {
  const { t } = useT();
  const money = (n: number) => "৳" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  const date = (s: string) => new Date(s).toLocaleDateString("en-GB", { timeZone: "Asia/Dhaka" });
  const th: React.CSSProperties = { border: "1px solid #94a3b8", background: "#0f766e", color: "white", padding: "5px", textAlign: "left", fontSize: 10 };
  const td: React.CSSProperties = { border: "1px solid #cbd5e1", padding: "4px 5px", fontSize: 9 };
  return <div style={{ color: "#0f172a", fontFamily: "Arial,sans-serif" }}>
    <header style={{ textAlign: "center", borderBottom: "3px double #0f766e", paddingBottom: 8, marginBottom: 10 }}>
      <h1 style={{ fontSize: 22, color: "#0f766e", margin: 0 }}>{business.name || "Business Report"}</h1>
      <div style={{ fontSize: 10 }}>{[business.address,business.phone].filter(Boolean).join(" · ")}</div>
      <h2 style={{ fontSize: 15, margin: "8px 0 2px" }}>{title}</h2>
      <div style={{ fontSize: 10 }}>{period}</div>
    </header>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6, marginBottom: 10 }}>
      {[[t("sales"),totals.sales],[t("collectPayment"),totals.collections],[t("salesReturn"),totals.returns],[t("deposit"),totals.deposits],[t("stockIssue"),totals.stockIssued],[t("returnGoods"),totals.stockReturned]].map(([label,value])=><div key={String(label)} style={{ border:"1px solid #cbd5e1", padding:6 }}><div style={{fontSize:9}}>{label}</div><b style={{fontSize:12}}>{money(Number(value))}</b></div>)}
    </div>
    <table style={{ width:"100%", borderCollapse:"collapse" }}>
      <thead><tr>{["Date","SR / Salesman","Customer / Dealer","Type","Reference","Product / Details","Qty","Debit","Credit"].map(x=><th key={x} style={th}>{x}</th>)}</tr></thead>
      <tbody>{rows.map((r,i)=><tr key={i}>{[date(r.date),r.salesman,r.retailer,r.type,r.reference,r.product,r.qty || "",money(r.debit),money(r.credit)].map((v,j)=><td key={j} style={td}>{v}</td>)}</tr>)}</tbody>
    </table>
    <footer style={{ marginTop:24, display:"flex", justifyContent:"space-between", fontSize:10 }}><span>Prepared: {new Date().toLocaleString("en-GB", { timeZone:"Asia/Dhaka" })}</span><span>Authorized Signature __________________</span></footer>
  </div>;
}
