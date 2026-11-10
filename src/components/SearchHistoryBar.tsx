import { useEffect, useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, X, History } from "lucide-react";

function readRecent(key: string): string[] {
  try { const value = JSON.parse(localStorage.getItem("newstock:recent:"+key) || "[]"); return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string").slice(0, 6) : []; } catch { return []; }
}
function saveRecent(key: string, value: string) {
  const v=value.trim(); if(!v) return;
  try { localStorage.setItem("newstock:recent:"+key, JSON.stringify([v,...readRecent(key).filter(x=>x.toLowerCase()!==v.toLowerCase())].slice(0,6))); } catch {}
}
export function SearchHistoryBar({value,onChange,historyKey,placeholder,children}:{value:string;onChange:(v:string)=>void;historyKey:string;placeholder:string;children?:ReactNode}) {
  const [recent,setRecent]=useState<string[]>([]);
  useEffect(()=>{setRecent(readRecent(historyKey));},[historyKey]);
  const remember=()=>{if(value.trim()){saveRecent(historyKey,value);setRecent(readRecent(historyKey));}};
  return <div className="space-y-2 rounded-xl border bg-card p-3">
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[220px] flex-1"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"/><Input className="pl-9" value={value} placeholder={placeholder} onChange={e=>onChange(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")remember();}} onBlur={remember}/>{value&&<Button type="button" size="icon" variant="ghost" className="absolute right-1 top-1 h-7 w-7" onClick={()=>onChange("")}><X className="h-4 w-4"/></Button>}</div>
      {children}
    </div>
    {recent.length>0&&<div className="flex flex-wrap items-center gap-1.5 text-xs"><span className="flex items-center gap-1 text-muted-foreground"><History className="h-3 w-3"/>Recent</span>{recent.map(x=><Button key={x} type="button" size="sm" variant="outline" className="h-7 px-2" onClick={()=>onChange(x)}>{x}</Button>)}</div>}
  </div>;
}
