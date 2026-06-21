import { supabaseServer } from "@/lib/supabase/server";

/** Pluggable cache backend (Supabase in prod, in-memory in tests). */
export interface CacheStore {
  get(key: string): Promise<unknown | null>;
  set(key: string, namespace: string, value: unknown, ttlSec: number): Promise<void>;
}

/** Supabase-backed TTL cache (the `provider_cache` table). */
export function supabaseCacheStore(): CacheStore {
  return {
    async get(key) {
      const sb = supabaseServer();
      const { data } = await sb
        .from("provider_cache")
        .select("value, expires_at")
        .eq("key", key)
        .maybeSingle();
      if (!data) return null;
      if (new Date(data.expires_at as string).getTime() <= Date.now()) return null;
      return data.value;
    },
    async set(key, namespace, value, ttlSec) {
      const sb = supabaseServer();
      const expires_at = new Date(Date.now() + ttlSec * 1000).toISOString();
      await sb
        .from("provider_cache")
        .upsert({ key, namespace, value, expires_at }, { onConflict: "key" });
    },
  };
}

/** In-memory store (for tests / single-process use). */
export function memoryCacheStore(): CacheStore {
  const map = new Map<string, { value: unknown; expiresAt: number }>();
  return {
    async get(key) {
      const hit = map.get(key);
      if (!hit) return null;
      if (hit.expiresAt <= Date.now()) {
        map.delete(key);
        return null;
      }
      return hit.value;
    },
    async set(key, _namespace, value, ttlSec) {
      map.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
    },
  };
}

let defaultStore: CacheStore | null = null;

/** Override the default store (used by tests). */
export function setCacheStore(store: CacheStore | null): void {
  defaultStore = store;
}

function store(): CacheStore {
  return (defaultStore ??= supabaseCacheStore());
}

/**
 * Memoize an async provider call in the shared cache. Keyed by
 * `<namespace>:<id>`, with a TTL. FAILS OPEN — any cache error (e.g. Supabase
 * not configured in a mock run) falls through to calling `fn` directly, so
 * caching never breaks the pipeline.
 */
export async function cached<T>(
  namespace: string,
  id: string,
  ttlSec: number,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${namespace}:${id}`;
  try {
    const hit = await store().get(key);
    if (hit !== null && hit !== undefined) return hit as T;
  } catch {
    // ignore cache read errors — fall through to fn
  }

  const value = await fn();

  try {
    await store().set(key, namespace, value, ttlSec);
  } catch {
    // ignore cache write errors
  }
  return value;
}
