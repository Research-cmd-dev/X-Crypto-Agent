import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cached, memoryCacheStore, setCacheStore } from "@/lib/cache/store";

describe("cached", () => {
  beforeEach(() => setCacheStore(memoryCacheStore()));
  afterEach(() => setCacheStore(null));

  it("calls fn on miss and serves from cache on hit", async () => {
    const fn = vi.fn(async () => ({ value: 42 }));
    const a = await cached("ns", "k", 60, fn);
    const b = await cached("ns", "k", 60, fn);
    expect(a).toEqual({ value: 42 });
    expect(b).toEqual({ value: 42 });
    expect(fn).toHaveBeenCalledTimes(1); // second call served from cache
  });

  it("re-calls fn after the TTL expires", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn(async () => Math.random());
      await cached("ns", "k", 1, fn);
      vi.advanceTimersByTime(1500); // past the 1s TTL
      await cached("ns", "k", 1, fn);
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails open: returns fn result even if the store throws", async () => {
    setCacheStore({
      get: async () => {
        throw new Error("store down");
      },
      set: async () => {
        throw new Error("store down");
      },
    });
    const result = await cached("ns", "k", 60, async () => "ok");
    expect(result).toBe("ok");
  });

  it("keys by namespace + id (no cross-namespace collisions)", async () => {
    const a = await cached("nsA", "same", 60, async () => "A");
    const b = await cached("nsB", "same", 60, async () => "B");
    expect(a).toBe("A");
    expect(b).toBe("B");
  });
});
