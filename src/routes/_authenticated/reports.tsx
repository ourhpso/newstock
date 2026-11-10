import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileSpreadsheet, Printer, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useMe, useProducts, useRetailers, useSalesmen, type SalesmanSummaryData } from "@/lib/me";
import { rpc } from "@/lib/rpc";
import { useT } from "@/lib/i18n";
import { formatDate, formatInteger, money } from "@/lib/imei";
import { exportExcelWorkbook } from "@/lib/export";
import { useBusiness } from "@/lib/business";
import { PrintSheet } from "@/components/PrintDocs";
import { DetailedReportDoc, type DetailedReportRow } from "@/components/DetailedReportDoc";
import { PageTitle } from "@/components/Stat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Sale = { id:string; salesman_id:string; retailer_id:string; invoice_no:string|null; total:number; paid:number; discount:number; txn_date:string; created_at:string };
type Payment = { id:string; salesman_id:string; retailer_id:string; receipt_no:string|null; amount:number; method:string; note:string|null; txn_date:string; created_at:string };
type Return = { id:string; salesman_id:string; retailer_id:string; doc_no:string|null; total:number; txn_date:string; created_at:string };
type Deposit = { id:string; salesman_id:string; receipt_no:string|null; amount:number; method:string; note:string|null; txn_date:string; created_at:string };
type Movement = { id:string; salesman_id:string; product_id:string; retailer_id:string|null; sale_id:string|null; kind:string; qty:number; unit_price:number; imei:string|null; batch_no:string|null; txn_date:string; created_at:string };
type Dataset = { sales:Sale[]; payments:Payment[]; returns:Return[]; deposits:Deposit[]; movements:Movement[] };
const today = () => new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Dhaka"});
const monthStart = () => today().slice(0,8)+"01";
const TYPES = ["sale","collection","retailer_return","deposit","issue","stock_return","damage","sale_return"] as const;
type ReportType = typeof TYPES[number];
const labels: Record<ReportType,string> = { sale:"Sales",collection:"Collections",retailer_return:"Retailer returns",deposit:"SR deposits",issue:"Stock issued",stock_return:"Stock returned",damage:"Damaged stock",sale_return:"Sales return stock" };

export const Route = createFileRoute("/_authenticated/reports")({
  head: () => ({ meta:[{title:"Salesman Reports | NewStock"}] }),
  component: SalesmanReports,
});

function SalesmanReports() {
  const {t}=useT();
  const {data:me}=useMe();
  const {data:salesmen=[]}=useSalesmen();
  const {data:retailers=[]}=useRetailers();
  const {data:products=[]}=useProducts();
  const {data:brands=[]}=useQuery({queryKey:["product-brands"],queryFn:async()=>{const {data,error}=await supabase.from("product_brands").select("id,name");if(error)throw error;return data??[];}});
  const {data:models=[]}=useQuery({queryKey:["product-models"],queryFn:async()=>{const {data,error}=await supabase.from("product_models").select("id,name");if(error)throw error;return data??[];}});
  const [business]=useBusiness();
  const [from,setFrom]=useState(monthStart());
  const [to,setTo]=useState(today());
  const [salesmanId,setSalesmanId]=useState("all");
  const [retailerId,setRetailerId]=useState("all");
  const [selectedTypes,setSelectedTypes]=useState<ReportType[]>([...TYPES]);
  const [printDoc,setPrintDoc]=useState<ReactNode|null>(null);
  const effectiveSalesman=me?.isAdmin?(salesmanId==="all"?null:salesmanId):me?.id??null;
  const query=useQuery({
    queryKey:["detailed-salesman-report",me?.id,effectiveSalesman,retailerId,from,to],
    enabled:!!me && !!from && !!to && from<=to,
    queryFn:async():Promise<Dataset>=>{
      const all=async<T,>(table:string,columns:string):Promise<T[]>=>{
        const result:T[]=[];
        for(let offset=0;offset<100000;offset+=1000){
          let q:any=supabase.from(table).select(columns).gte("txn_date",from).lte("txn_date",to).order("txn_date",{ascending:true}).range(offset,offset+999);
          if(effectiveSalesman) q=q.eq("salesman_id",effectiveSalesman);
          if(retailerId!=="all" && ["sales","retailer_payments","retailer_returns","stock_movements"].includes(table)) q=q.eq("retailer_id",retailerId);
          const {data,error}=await q;
          if(error) throw new Error(error.message);
          const batch=(data??[]) as T[];
          result.push(...batch);
          if(batch.length<1000) break;
        }
        return result;
      };
      const [sales,payments,returns,deposits,movements]=await Promise.all([
        all<Sale>("sales","id,salesman_id,retailer_id,invoice_no,total,paid,discount,txn_date,created_at"),
        all<Payment>("retailer_payments","id,salesman_id,retailer_id,receipt_no,amount,method,note,txn_date,created_at"),
        all<Return>("retailer_returns","id,salesman_id,retailer_id,doc_no,total,txn_date,created_at"),
        retailerId==="all"?all<Deposit>("deposits","id,salesman_id,receipt_no,amount,method,note,txn_date,created_at"):Promise.resolve([]),
        all<Movement>("stock_movements","id,salesman_id,product_id,retailer_id,sale_id,kind,qty,unit_price,imei,batch_no,txn_date,created_at"),
      ]);
      return {sales,payments,returns,deposits,movements};
    },
  });
  const data=query.data;
  const summaryQuery=useQuery({
    queryKey:["detailed-report-account-snapshot",me?.id,effectiveSalesman,salesmen.map(s=>s.id).join(",")],
    enabled:!!me && (!me.isAdmin || salesmen.length>0),
    queryFn:async()=>{
      const ids=effectiveSalesman?[effectiveSalesman]:me?.isAdmin?salesmen.map(s=>s.id):me?[me.id]:[];
      const summaries=await Promise.all(ids.map(async id=>{
        const {data,error}=await rpc<SalesmanSummaryData>("salesman_summary",{_salesman:id});
        if(error)throw new Error(error.message);
        return data;
      }));
      const valid=summaries.filter((x):x is SalesmanSummaryData=>!!x);
      return valid.reduce((a,s)=>({
        salesTotal:a.salesTotal+s.salesTotal,cashInHand:a.cashInHand+s.cashInHand,
        retailerDue:a.retailerDue+s.retailerDue,returnsTotal:a.returnsTotal+s.returnsTotal,
        deposited:a.deposited+s.deposited,owesDealer:a.owesDealer+s.owesDealer,
        goodsValue:a.goodsValue+s.products.reduce((n,p)=>n+p.value,0),
        products:a.products+s.products.filter(p=>p.hand>0).length,
      }),{salesTotal:0,cashInHand:0,retailerDue:0,returnsTotal:0,deposited:0,owesDealer:0,goodsValue:0,products:0});
    },
  });
  const rows=useMemo(()=>{
    if(!data)return [] as DetailedReportRow[];
    const salesmanName=(id:string)=>salesmen.find(s=>s.id===id)?.full_name??(id===me?.id?me?.profile?.full_name??me?.email??"Me":id.slice(0,8));
    const retailerName=(id:string|null)=>id?retailers.find(r=>r.id===id)?.name??"—":"—";
    const productName=(id:string)=>{const p=products.find(p=>p.id===id);if(!p)return "Product";const brand=brands.find(b=>b.id===p.brand_id)?.name;const model=models.find(m=>m.id===p.model_id)?.name;return [brand,model,p.name].filter(Boolean).join(" · ");};
    const out:DetailedReportRow[]=[];
    if(selectedTypes.includes("sale")) for(const s of data.sales) out.push({date:s.txn_date??s.created_at,salesman:salesmanName(s.salesman_id),retailer:retailerName(s.retailer_id),type:labels.sale,reference:s.invoice_no??s.id.slice(0,8),product:"Invoice total",qty:0,debit:Number(s.total),credit:Number(s.paid),note:s.discount?"Discount "+money(s.discount):""});
    if(selectedTypes.includes("collection")) for(const p of data.payments) out.push({date:p.txn_date??p.created_at,salesman:salesmanName(p.salesman_id),retailer:retailerName(p.retailer_id),type:labels.collection,reference:p.receipt_no??p.id.slice(0,8),product:p.method,qty:0,debit:0,credit:Number(p.amount),note:p.note??""});
    if(selectedTypes.includes("retailer_return")) for(const r of data.returns) out.push({date:r.txn_date??r.created_at,salesman:salesmanName(r.salesman_id),retailer:retailerName(r.retailer_id),type:labels.retailer_return,reference:r.doc_no??r.id.slice(0,8),product:"Account credit",qty:0,debit:0,credit:Number(r.total)});
    if(selectedTypes.includes("deposit")) for(const d of data.deposits) out.push({date:d.txn_date??d.created_at,salesman:salesmanName(d.salesman_id),retailer:"Office / Dealer house",type:labels.deposit,reference:d.receipt_no??d.id.slice(0,8),product:d.method,qty:0,debit:0,credit:Number(d.amount),note:d.note??""});
    const movementKinds:Record<string,ReportType>={sale:"sale",issue:"issue",return:"stock_return",damage:"damage",sale_return:"sale_return"};
    for(const m of data.movements){const type=movementKinds[m.kind];if(!type||!selectedTypes.includes(type))continue;out.push({date:m.txn_date??m.created_at,salesman:salesmanName(m.salesman_id),retailer:retailerName(m.retailer_id),type:labels[type],reference:m.batch_no??m.sale_id?.slice(0,8)??m.id.slice(0,8),product:productName(m.product_id)+(m.imei?" · IMEI "+m.imei:""),qty:Number(m.qty),debit:m.kind==="issue"?Number(m.qty)*Number(m.unit_price):0,credit:m.kind==="return"||m.kind==="sale_return"?Number(m.qty)*Number(m.unit_price):0,note:m.kind==="damage"?"Damaged":m.kind==="sale"?"Unit price "+money(m.unit_price):""});}
    return out.sort((a,b)=>a.date.localeCompare(b.date));
  },[data,selectedTypes,salesmen,retailers,products,brands,models,me]);
  const totals=useMemo(()=>{
    if(!data)return {sales:0,collections:0,returns:0,deposits:0,stockIssued:0,stockReturned:0};
    return {
      sales:selectedTypes.includes("sale")?data.sales.reduce((a,r)=>a+Number(r.total),0):0,
      collections:selectedTypes.includes("collection")?data.payments.reduce((a,r)=>a+Number(r.amount),0):0,
      returns:selectedTypes.includes("retailer_return")?data.returns.reduce((a,r)=>a+Number(r.total),0):0,
      deposits:selectedTypes.includes("deposit")?data.deposits.reduce((a,r)=>a+Number(r.amount),0):0,
      stockIssued:selectedTypes.includes("issue")?data.movements.filter(r=>r.kind==="issue").reduce((a,r)=>a+Number(r.qty)*Number(r.unit_price),0):0,
      stockReturned:selectedTypes.includes("stock_return")?data.movements.filter(r=>r.kind==="return"||r.kind==="sale_return").reduce((a,r)=>a+Number(r.qty)*Number(r.unit_price),0):0,
    };
  },[data,selectedTypes]);
  const title=me?.isAdmin?(effectiveSalesman?salesmen.find(s=>s.id===effectiveSalesman)?.full_name??"Salesman report":"Joint salesman report"):"My sales & account report";
  function exportExcel(){
    if(!data)return;
    const summary=[["Report",title],["From",from],["To",to],["Sales",totals.sales],["Collections",totals.collections],["Retailer returns",totals.returns],["Deposits",totals.deposits],["Issued stock value",totals.stockIssued],["Returned stock value",totals.stockReturned],["Current sales total",summaryQuery.data?.salesTotal??0],["Current cash in hand",summaryQuery.data?.cashInHand??0],["Current retailer due",summaryQuery.data?.retailerDue??0],["Current deposited",summaryQuery.data?.deposited??0],["Current goods value in hand",summaryQuery.data?.goodsValue??0],["Current products in hand",summaryQuery.data?.products??0]];
    const transactions=[["Date","Salesman","Retailer / Dealer","Transaction","Reference","Product / Details","Quantity","Debit","Credit","Note"],...rows.map(r=>[formatDate(r.date),r.salesman,r.retailer,r.type,r.reference,r.product,r.qty,r.debit,r.credit,r.note??""])];
    const customers=[["Retailer","Salesman","Sales","Paid at sale","Collections","Returns","Outstanding"]];
    const customerIds=[...new Set(data.sales.map(s=>s.retailer_id).concat(data.payments.map(p=>p.retailer_id),data.returns.map(r=>r.retailer_id)))];
    for(const id of customerIds){const retailer=retailers.find(r=>r.id===id);const sales=data.sales.filter(r=>r.retailer_id===id);const pays=data.payments.filter(r=>r.retailer_id===id);const rets=data.returns.filter(r=>r.retailer_id===id);customers.push([retailer?.name??id,salesmen.find(s=>s.id===retailer?.salesman_id)?.full_name??"",sales.reduce((a,r)=>a+Number(r.total),0),sales.reduce((a,r)=>a+Number(r.paid),0),pays.reduce((a,r)=>a+Number(r.amount),0),rets.reduce((a,r)=>a+Number(r.total),0),sales.reduce((a,r)=>a+Number(r.total)-Number(r.paid),0)-pays.reduce((a,r)=>a+Number(r.amount),0)-rets.reduce((a,r)=>a+Number(r.total),0)]);}
    const stock=[["Date","Salesman","Product","Movement","Reference","Qty","Unit price","Value","IMEI"],...data.movements.filter(m=>m.kind!=="sale"||selectedTypes.includes("sale")).filter(m=>m.kind!=="issue"||selectedTypes.includes("issue")).filter(m=>m.kind!=="return"||selectedTypes.includes("stock_return")).filter(m=>m.kind!=="damage"||selectedTypes.includes("damage")).filter(m=>m.kind!=="sale_return"||selectedTypes.includes("sale_return")).map(m=>[formatDate(m.txn_date),salesmen.find(s=>s.id===m.salesman_id)?.full_name??"",[brands.find(b=>b.id===products.find(p=>p.id===m.product_id)?.brand_id)?.name,models.find(x=>x.id===products.find(p=>p.id===m.product_id)?.model_id)?.name,products.find(p=>p.id===m.product_id)?.name].filter(Boolean).join(" · "),m.kind,m.batch_no??"",Number(m.qty),Number(m.unit_price),Number(m.qty)*Number(m.unit_price),m.imei??""])];
    void exportExcelWorkbook("salesman-report-"+from+"-"+to+".xls",[{name:"Summary",rows:summary},{name:"Transactions",rows:transactions},{name:"Retailer ledgers",rows:customers},{name:"Stock movements",rows:stock}],title);
  }
  function printReport(){setPrintDoc(<DetailedReportDoc business={business} title={title} period={from+" — "+to} rows={rows} totals={totals}/>);}
  const toggleType=(type:ReportType)=>setSelectedTypes(old=>old.includes(type)?old.filter(x=>x!==type):[...old,type]);
  if(!me)return null;
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-2"><PageTitle>{t("reports")}</PageTitle><Button variant="outline" size="sm" onClick={()=>query.refetch()}><RefreshCw className="mr-1 h-4 w-4"/>{t("retry")}</Button></div>
    <section className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
      {me.isAdmin&&<div className="space-y-1"><Label>{t("salesmen")}</Label><Select value={salesmanId} onValueChange={setSalesmanId}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="all">All salesmen · Joint report</SelectItem>{salesmen.map(s=><SelectItem key={s.id} value={s.id}>{s.full_name}</SelectItem>)}</SelectContent></Select></div>}
      <div className="space-y-1"><Label>{t("date")} · From</Label><Input type="date" value={from} max={to} onChange={e=>setFrom(e.target.value)}/></div>
      <div className="space-y-1"><Label>{t("date")} · To</Label><Input type="date" value={to} min={from} onChange={e=>setTo(e.target.value)}/></div>
      <div className="space-y-1"><Label>{t("retailers")}</Label><Select value={retailerId} onValueChange={setRetailerId}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="all">All customers / dealers</SelectItem>{retailers.map(r=><SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}</SelectContent></Select></div>
    </section>
    <section className="space-y-2 rounded-xl border bg-card p-4"><h2 className="font-semibold">Customize report · Transaction types</h2><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{TYPES.map(type=><label key={type} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selectedTypes.includes(type)} onChange={()=>toggleType(type)}/>{labels[type]}</label>)}</div><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={()=>setSelectedTypes([...TYPES])}>Select all</Button><Button size="sm" variant="outline" onClick={()=>setSelectedTypes([])}>Clear</Button></div></section>
    <section className="space-y-3"><div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{[[t("sales"),totals.sales],[t("collectPayment"),totals.collections],[t("salesReturn"),totals.returns],[t("deposit"),totals.deposits],["Issued stock value",totals.stockIssued],["Returned stock value",totals.stockReturned]].map(([label,value])=><div key={String(label)} className="rounded-xl border bg-card p-3"><div className="text-xs text-muted-foreground">{label}</div><div className="font-display text-lg font-bold">{money(Number(value))}</div></div>)}</div><h2 className="font-semibold">Current account snapshot · All-time</h2><div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{[["Sales total",summaryQuery.data?.salesTotal??0],["Cash in hand",summaryQuery.data?.cashInHand??0],["Retailer due",summaryQuery.data?.retailerDue??0],["Deposited",summaryQuery.data?.deposited??0],["Goods value in hand",summaryQuery.data?.goodsValue??0],["Products with stock",summaryQuery.data?.products??0]].map(([label,value])=><div key={String(label)} className="rounded-xl border bg-accent/20 p-3"><div className="text-xs text-muted-foreground">{label}</div><div className="font-display text-lg font-bold">{typeof value==="number" && String(label)==="Products with stock"?formatInteger(value):money(Number(value))}</div></div>)}</div></section>
    <div className="flex flex-wrap gap-2"><Button disabled={!data||query.isFetching||!rows.length} onClick={exportExcel}><FileSpreadsheet className="mr-1 h-4 w-4"/>Export Excel</Button><Button variant="secondary" disabled={!data||query.isFetching||!rows.length} onClick={printReport}><Printer className="mr-1 h-4 w-4"/>{t("print")} / PDF</Button></div>
    {query.isPending?<p>{t("loading")}</p>:query.isError?<p className="text-destructive">{query.error.message}</p>:<div className="overflow-x-auto rounded-xl border bg-card"><table className="w-full min-w-[850px] text-sm"><thead className="bg-muted"><tr>{["Date","Salesman","Retailer","Type","Reference","Product / Details","Qty","Debit","Credit"].map(x=><th key={x} className="p-2 text-left">{x}</th>)}</tr></thead><tbody>{rows.map((r,i)=><tr key={i} className="border-t"><td className="p-2">{formatDate(r.date)}</td><td className="p-2">{r.salesman}</td><td className="p-2">{r.retailer}</td><td className="p-2">{r.type}</td><td className="p-2">{r.reference}</td><td className="p-2">{r.product}</td><td className="p-2 text-right">{formatInteger(r.qty)}</td><td className="p-2 text-right">{money(r.debit)}</td><td className="p-2 text-right">{money(r.credit)}</td></tr>)}{!rows.length&&<tr><td colSpan={9} className="p-6 text-center text-muted-foreground">{t("noData")}</td></tr>}</tbody></table></div>}
    {printDoc&&<PrintSheet onDone={()=>setPrintDoc(null)}>{printDoc}</PrintSheet>}
  </div>;
}
