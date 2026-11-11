import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";

/**
 * Business query snapshots are isolated per authenticated Supabase user.
 * No shared/global cache is restored before a user identity is known.
 */
export const CACHE_BUSTER = "v2";
const CACHE_PREFIX = "rq-cache-v2:";

export function cacheKeyForUser(userId: string): string {
  return `${CACHE_PREFIX}${userId}`;
}

export function createAppPersister(userId: string) {
  if (typeof window === "undefined" || !userId) return null;
  return createSyncStoragePersister({
    storage: window.localStorage,
    key: cacheKeyForUser(userId),
    throttleTime: 1000,
  });
}

export function clearLegacySharedCache(): void {
  if (typeof window === "undefined") return;
  try {
    // Remove the old unscoped v1 cache; it must never be restored by this version.
    window.localStorage.removeItem("rq-cache-v1");
  } catch {
    // Ignore unavailable browser storage.
  }
}

export function clearUserCache(userId: string): void {
  if (typeof window === "undefined" || !userId) return;
  try {
    window.localStorage.removeItem(cacheKeyForUser(userId));
  } catch {
    // Storage may be disabled; in-memory QueryClient is still cleared on auth changes.
  }
}

export function shouldPersistQuery(query: { state: { status: string }; queryKey: readonly unknown[] }): boolean {
  if (query.state.status !== "success") return false;
  const key = String(query.queryKey[0] ?? "");
  return key !== "me" && !key.includes("risk") && !key.startsWith("user-access");
}

/** Used by the offline first-open gate; only a user-scoped cache counts. */
export function hasCachedData(userId?: string | null): boolean {
  if (typeof window === "undefined" || !userId) return false;
  try {
    return window.localStorage.getItem(cacheKeyForUser(userId)) !== null;
  } catch {
    return false;
  }
}
