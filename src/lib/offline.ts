import { useSyncExternalStore } from "react";
import { supabase } from "@/integrations/supabase/client";
import { rpc } from "@/lib/rpc";

/**
 * Offline entry queue (v2).
 *
 * Every entry carries a stable UUID that is sent to the database as the
 * operation's client_op_id, so a replay after a lost response can never
 * create a duplicate: the RPCs return the original record instead.
 * Entries are bound to the user who created them and only replay in that
 * user's session. A failed entry no longer blocks the queue — it stays
 * visible with its error, can be retried, or removed one by one in Settings.
 */

export type QueuedOp =
  | { kind: "record_sale"; payload: { _retailer: string; _items: unknown[]; _paid: number; _discount: number; _date: string | null } }
  | { kind: "return_stock"; payload: { _salesman: string; _items: unknown[]; _date: string | null } }
  | { kind: "issue_stock"; payload: { _salesman: string; _items: unknown[]; _date: string | null } }
  | { kind: "retailer_return"; payload: { _retailer: string; _items: unknown[]; _date: string | null } }
  | { kind: "deposit"; payload: { _salesman: string; _amount: number; _method: string; _note: string | null; _date: string | null } }
  | { kind: "retailer_payment"; payload: { _retailer: string; _amount: number; _method: string; _note: string | null; _date: string | null } }
  | { kind: "add_retailer"; payload: { name: string; phone: string; address: string; salesman_id: string; credit_limit?: number | null; due_days?: number } };

export type QueueEntry = {
  id: string;
  createdAt: string;
  userId: string | null;
  attempts: number;
  lastError: string | null;
  op: QueuedOp;
};

const LEGACY_QUEUE_KEY = "offline-queue-v1";
const QUEUE_PREFIX = "offline-queue-v2:";
const ACTIVE_QUEUE_USER_KEY = "offline-queue-active-user";

function activeQueueUserId(): string | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage.getItem(ACTIVE_QUEUE_USER_KEY); } catch { return null; }
}

function queueKey(userId: string): string {
  return QUEUE_PREFIX + userId;
}

export function setActiveQueueUser(userId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (userId) window.localStorage.setItem(ACTIVE_QUEUE_USER_KEY, userId);
    else window.localStorage.removeItem(ACTIVE_QUEUE_USER_KEY);
  } catch { /* Storage may be unavailable; callers can pass an explicit user id. */ }
}
const listeners = new Set<() => void>();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function emit() {
  for (const l of listeners) l();
}

type RawEntry = Partial<QueueEntry> & { op: QueuedOp };

/**
 * Upgrade a pre-v2 payload to the current shape. v1 entries used insert-style
 * field names for deposits/payments and had no discount/date fields; replaying
 * them unchanged would fail against the validated RPCs forever.
 */
function convertLegacyOp(op: QueuedOp): { op: QueuedOp; changed: boolean } {
  const p = (op?.payload ?? {}) as Record<string, unknown>;
  switch (op?.kind) {
    case "record_sale":
      if (p["_discount"] === undefined)
        return { changed: true, op: { kind: "record_sale", payload: { _retailer: p["_retailer"] as string, _items: p["_items"] as unknown[], _paid: p["_paid"] as number, _discount: 0, _date: null } } };
      break;
    case "issue_stock":
    case "return_stock":
      if (p["_date"] === undefined)
        return { changed: true, op: { kind: op.kind, payload: { _salesman: p["_salesman"] as string, _items: p["_items"] as unknown[], _date: null } } };
      break;
    case "deposit":
      if (p["salesman_id"] !== undefined)
        return { changed: true, op: { kind: "deposit", payload: { _salesman: p["salesman_id"] as string, _amount: p["amount"] as number, _method: "cash", _note: (p["note"] as string | null) ?? null, _date: null } } };
      break;
    case "retailer_payment":
      if (p["retailer_id"] !== undefined)
        return { changed: true, op: { kind: "retailer_payment", payload: { _retailer: p["retailer_id"] as string, _amount: p["amount"] as number, _method: "cash", _note: null, _date: null } } };
      break;
  }
  return { op, changed: false };
}

function normalize(raw: RawEntry): { entry: QueueEntry; changed: boolean } {
  const idOk = !!raw.id && UUID_RE.test(raw.id);
  const { op, changed: opChanged } = convertLegacyOp(raw.op);
  return {
    changed: !idOk || opChanged,
    entry: {
      id: idOk ? (raw.id as string) : newId(),
      createdAt: raw.createdAt ?? new Date().toISOString(),
      userId: raw.userId ?? null,
      attempts: raw.attempts ?? 0,
      lastError: raw.lastError ?? null,
      op,
    },
  };
}

export function getQueue(userId: string | null = activeQueueUserId()): QueueEntry[] {
  if (typeof window === "undefined" || !userId) return [];
  try {
    const key = queueKey(userId);
    const raw = window.localStorage.getItem(key);
    const scoped = raw ? (JSON.parse(raw) as RawEntry[]).map(normalize) : [];
    const entries = scoped.map((x) => x.entry).filter((entry) => entry.userId === userId);

    // Import only explicitly-owned legacy records. Unowned records remain
    // quarantined in v1; they are never shown or replayed for any account.
    const legacyRaw = window.localStorage.getItem(LEGACY_QUEUE_KEY);
    if (legacyRaw) {
      try {
        const legacy = (JSON.parse(legacyRaw) as RawEntry[]).map(normalize);
        const known = new Set(entries.map((entry) => entry.id));
        for (const part of legacy) {
          if (part.entry.userId === userId && !known.has(part.entry.id)) {
            entries.push(part.entry);
            known.add(part.entry.id);
          }
        }
      } catch { /* Keep malformed legacy data quarantined and untouched. */ }
    }

    // Persist this account's migrated records before removing only its rows
    // from the shared legacy key. Other accounts and unowned rows are retained.
    window.localStorage.setItem(key, JSON.stringify(entries));
    if (legacyRaw) {
      try {
        const legacyRows = JSON.parse(legacyRaw) as RawEntry[];
        window.localStorage.setItem(
          LEGACY_QUEUE_KEY,
          JSON.stringify(legacyRows.filter((row) => row.userId !== userId)),
        );
      } catch { /* Leave the legacy source intact if it cannot be safely parsed. */ }
    }
    return entries;
  } catch {
    return [];
  }
}

function saveQueue(entries: QueueEntry[], userId: string | null = activeQueueUserId()) {
  if (!userId) throw new Error("An authenticated user is required for the offline queue.");
  const owned = entries.filter((entry) => entry.userId === userId);
  window.localStorage.setItem(queueKey(userId), JSON.stringify(owned));
  emit();
}

export function enqueueOp(op: QueuedOp, userId: string | null = activeQueueUserId()): QueueEntry {
  if (!userId) throw new Error("Sign in is required before saving offline transactions.");
  const entry: QueueEntry = { id: newId(), createdAt: new Date().toISOString(), userId, attempts: 0, lastError: null, op };
  saveQueue([...getQueue(userId), entry], userId);
  return entry;
}

export function removeQueueEntry(id: string, userId: string | null = activeQueueUserId()) {
  if (!userId) return;
  saveQueue(getQueue(userId).filter((entry) => entry.id !== id), userId);
}
/** True when a failure came from the network being unavailable, not from a server-side rejection. */
export function isNetworkFailure(error: unknown, offline: boolean): boolean {
  if (offline) return true;
  const msg = String((error as { message?: string } | null)?.message ?? error ?? "").toLowerCase();
  return msg.includes("failed to fetch") || msg.includes("networkerror") || msg.includes("fetch failed") || msg.includes("network request failed");
}

/** Run one entry against the validated RPCs; the entry id is the idempotency key. */
async function runEntry(entry: QueueEntry) {
  const op = entry.op;
  switch (op.kind) {
    case "record_sale":
      return await rpc("record_sale", { ...op.payload, _op: entry.id });
    case "return_stock":
      return await rpc("submit_workflow_request", {
        _kind: "return", _salesman: op.payload._salesman,
        _payload: { items: op.payload._items, date: op.payload._date },
        _reason: "Offline return submitted for SR/Admin approval", _op: entry.id,
      });
    case "issue_stock":
      return await rpc("submit_workflow_request", {
        _kind: "issue", _salesman: op.payload._salesman,
        _payload: { items: op.payload._items, date: op.payload._date },
        _reason: "Offline stock issue awaiting SR receipt confirmation", _op: entry.id,
      });
    case "retailer_return":
      return await rpc("record_retailer_return", { ...op.payload, _op: entry.id });
    case "deposit":
      return await rpc("submit_workflow_request", {
        _kind: "deposit", _salesman: op.payload._salesman,
        _payload: { amount: op.payload._amount, method: op.payload._method, note: op.payload._note, date: op.payload._date },
        _reason: op.payload._note || "Offline cash handover submitted for SR/Admin approval", _op: entry.id,
      });
    case "retailer_payment":
      return await rpc("record_retailer_payment", { ...op.payload, _op: entry.id });
    case "add_retailer": {
      const ins = await supabase.from("retailers").insert({ ...op.payload, client_op_id: entry.id });
      // A replay after a lost response hits the unique client_op_id: success, not an error.
      if (ins.error && (ins.error as { code?: string }).code === "23505") return { data: null, error: null };
      return ins;
    }
  }
}

/**
 * Execute a mutation; when the network is down, store it in the queue instead.
 * The same entry id is used for the live attempt and any later replay, so a
 * request that committed but whose response was lost cannot double-apply.
 * Returns "done" | "queued" | { error } so callers can toast accordingly.
 */
export type RunResult = { s: "done"; data: unknown } | { s: "queued" } | { s: "error"; error: string };

export async function runOrQueue(op: QueuedOp, offline: boolean, userId: string | null = null): Promise<RunResult> {
  if (!userId) return { s: "error", error: "Sign in is required before saving or syncing offline transactions." };
  const entry: QueueEntry = { id: newId(), createdAt: new Date().toISOString(), userId, attempts: 0, lastError: null, op };
  if (!offline) {
    const { data, error } = await runEntry(entry);
    if (!error) return { s: "done", data };
    if (!isNetworkFailure(error, false)) return { s: "error", error: error.message };
  }
  saveQueue([...getQueue(userId), entry], userId);
  return { s: "queued" };
}

/**
 * Replay queued entries in order. Entries belonging to another user are
 * skipped (left for their owner's session). A rejected entry records its
 * error and stays in the queue without blocking the entries behind it.
 */
export type ReplayResult = { synced: number; failed: number; firstError: string | null };
const replayInFlight = new Map<string, Promise<ReplayResult>>();
export function replayQueue(currentUserId: string | null = activeQueueUserId()): Promise<ReplayResult> {
  // Never replay legacy/unowned queue entries or any entries while signed out.
  if (!currentUserId) return Promise.resolve({ synced: 0, failed: 0, firstError: null });
  const existing = replayInFlight.get(currentUserId);
  if (existing) return existing;
  const pending = replayQueueOnce(currentUserId).finally(() => {
    if (replayInFlight.get(currentUserId) === pending) replayInFlight.delete(currentUserId);
  });
  replayInFlight.set(currentUserId, pending);
  return pending;
}
async function replayQueueOnce(currentUserId: string | null): Promise<ReplayResult> {
  const entries = getQueue(currentUserId);
  const done = new Set<string>();
  const updates = new Map<string, QueueEntry>();
  let synced = 0;
  let failed = 0;
  let firstError: string | null = null;
  for (const entry of entries) {
    // Strict equality: null/legacy entries are quarantined, never sent to Supabase.
    if (!entry.userId || entry.userId !== currentUserId) continue;
    // A different account may sign in while a replay is in progress.
    const { data: sessionData } = await supabase.auth.getSession();
    if (sessionData.session?.user?.id !== currentUserId) break;
    const { error } = await runEntry(entry);
    if (error) {
      failed += 1;
      firstError ??= error.message;
      updates.set(entry.id, { ...entry, attempts: entry.attempts + 1, lastError: error.message });
    } else {
      synced += 1;
      done.add(entry.id);
    }
  }
  saveQueue(getQueue(currentUserId).filter((e) => !done.has(e.id)).map((e) => updates.get(e.id) ?? e), currentUserId);
  return { synced, failed, firstError };
}

/** Reactive pending-entry count for the header badge. */
export function usePendingSyncCount(userId: string | null = activeQueueUserId()): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => getQueue(userId).length,
    () => 0,
  );
}

/** Reactive browser online/offline status. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("online", cb);
      window.addEventListener("offline", cb);
      return () => {
        window.removeEventListener("online", cb);
        window.removeEventListener("offline", cb);
      };
    },
    () => (typeof navigator === "undefined" ? true : navigator.onLine),
    () => true,
  );
}
