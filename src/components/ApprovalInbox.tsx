import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { rpc } from "@/lib/rpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type ApprovalRequest = {
  id: string; request_type: "stock_issue" | "stock_return" | "cash_deposit";
  salesman_id: string; created_by: string; payload: Record<string, unknown>;
  reason: string; status: string; result_ref: string | null; created_at: string;
  sr_confirmed_at: string | null; decided_at: string | null; decision_reason: string | null;
};
type ApprovalEvent = { id: string; request_id: string; actor_id: string; action: string; reason: string | null; created_at: string };

export function ApprovalInbox({ isAdmin, salesmanId }: { isAdmin: boolean; salesmanId: string }) {
  const qc = useQueryClient();
  const [decisionReason, setDecisionReason] = useState("");
  const [busyId, setBusyId] = useState("");
  const { data: requests = [], isLoading } = useQuery({
    queryKey: ["approval-requests"],
    queryFn: async () => {
      const { data, error } = await (supabase as any).from("approval_requests").select("*").order("created_at", { ascending: false }).limit(100);
      if (error) throw error;
      return (data ?? []) as ApprovalRequest[];
    },
  });
  const { data: events = [] } = useQuery({
    queryKey: ["approval-events"],
    queryFn: async () => {
      const { data, error } = await (supabase as any).from("approval_events").select("*").order("created_at", { ascending: false }).limit(300);
      if (error) throw error;
      return (data ?? []) as ApprovalEvent[];
    },
  });
  const visible = requests.filter((r) => isAdmin || r.salesman_id === salesmanId);
  async function act(id: string, action: "confirm" | "reject_issue" | "approve" | "reject" | "finalize") {
    if (busyId) return;
    setBusyId(id);
    try {
      let result: { error: { message: string } | null; data: unknown };
      if (action === "confirm") result = await rpc("confirm_stock_issue_receipt", { _request: id });
      else if (action === "reject_issue") result = await rpc("reject_stock_issue_request", { _request: id, _reason: decisionReason.trim() });
      else if (action === "finalize") result = await rpc("finalize_workflow_request", { _request: id });
      else result = await rpc("decide_workflow_request", { _request: id, _approved: action === "approve", _reason: decisionReason.trim() });
      if (result.error) { toast.error(result.error.message); return; }
      toast.success(action === "confirm" ? "Receipt confirmation saved" : action === "reject" || action === "reject_issue" ? "Request rejected" : "Approval completed");
      setDecisionReason("");
      await Promise.all([qc.invalidateQueries({ queryKey: ["approval-requests"] }), qc.invalidateQueries({ queryKey: ["approval-events"] }), qc.invalidateQueries()]);
    } finally { setBusyId(""); }
  }
  const label = (type: ApprovalRequest["request_type"]) => type === "stock_issue" ? "পণ্য ইস্যু" : type === "stock_return" ? "অবিক্রীত পণ্য ফেরত" : "নগদ জমা";
  const statusLabel = (status: string) => ({ pending_sr: "SR গ্রহণ নিশ্চিত করবে", awaiting_admin_finalize: "SR নিশ্চিত করেছে — Admin চূড়ান্ত করবেন", pending_admin: "Admin অনুমোদনের অপেক্ষায়", completed: "সম্পন্ন", rejected: "প্রত্যাখ্যাত" } as Record<string, string>)[status] ?? status;
  if (isLoading) return <section className="rounded-xl border p-4 text-sm text-muted-foreground">Approval requests loading…</section>;
  if (!visible.length) return <section className="rounded-xl border p-4"><h2 className="font-semibold">অনুমোদন ও অডিট</h2><p className="mt-1 text-sm text-muted-foreground">কোনো অনুমোদন অনুরোধ নেই।</p></section>;
  return <section className="space-y-3 rounded-xl border bg-card p-4">
    <div><h2 className="font-display text-lg font-bold">অনুমোদন ও অডিট ট্রেইল</h2><p className="text-xs text-muted-foreground">কে, কখন, কী সিদ্ধান্ত নিয়েছেন—প্রতিটি ধাপ সংরক্ষিত থাকে।</p></div>
    {visible.map((r) => {
      const canConfirm = !isAdmin && r.request_type === "stock_issue" && r.status === "pending_sr";
      const canFinalize = isAdmin && r.request_type === "stock_issue" && r.status === "awaiting_admin_finalize";
      const canDecide = isAdmin && r.request_type !== "stock_issue" && r.status === "pending_admin";
      const ev = events.filter((e) => e.request_id === r.id);
      const payload = r.payload ?? {};
      const detail = r.request_type === "cash_deposit" ? `Amount: ${String(payload["amount"] ?? "")} · ${String(payload["method"] ?? "cash")}` : `Items: ${Array.isArray(payload["items"]) ? payload["items"].length : 0}`;
      return <article key={r.id} className="space-y-2 rounded-lg border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><b>{label(r.request_type)}</b><span className="rounded-full bg-muted px-2 py-1 text-xs">{statusLabel(r.status)}</span></div>
        <div className="text-xs text-muted-foreground">SR: {r.salesman_id} · {new Date(r.created_at).toLocaleString("en-GB")} · {detail}</div>
        {r.reason && <p className="text-sm">কারণ: {r.reason}</p>}
        {r.decision_reason && <p className="text-sm">সিদ্ধান্তের কারণ: {r.decision_reason}</p>}{r.result_ref && <p className="text-xs text-muted-foreground">Final document: {r.result_ref}</p>}
        {(canDecide || canFinalize || canConfirm) && <Input value={decisionReason} onChange={(e) => setDecisionReason(e.target.value)} placeholder="সিদ্ধান্তের কারণ (কমপক্ষে ৩ অক্ষর)" />}
        <div className="flex flex-wrap gap-2">
          {canConfirm && <><Button size="sm" disabled={busyId === r.id} onClick={() => act(r.id,"confirm")}>পণ্য গ্রহণ নিশ্চিত</Button><Button size="sm" variant="destructive" disabled={busyId === r.id || decisionReason.trim().length < 3} onClick={() => act(r.id,"reject_issue")}>পণ্য গ্রহণ প্রত্যাখ্যান</Button></>}
          {canFinalize && <Button size="sm" disabled={busyId === r.id} onClick={() => act(r.id,"finalize")}>চূড়ান্তভাবে স্টক যোগ করুন</Button>}
          {canDecide && <><Button size="sm" disabled={busyId === r.id || decisionReason.trim().length < 3} onClick={() => act(r.id,"approve")}>অনুমোদন</Button><Button size="sm" variant="destructive" disabled={busyId === r.id || decisionReason.trim().length < 3} onClick={() => act(r.id,"reject")}>প্রত্যাখ্যান</Button></>}
        </div>
        {ev.length > 0 && <div className="border-t pt-2"><p className="mb-1 text-xs font-semibold">Audit history</p>{ev.map((e) => <p key={e.id} className="text-xs text-muted-foreground">{new Date(e.created_at).toLocaleString("en-GB")} · {e.action} · {e.actor_id}{e.reason ? ` · ${e.reason}` : ""}</p>)}</div>}
      </article>;
    })}
  </section>;
}
