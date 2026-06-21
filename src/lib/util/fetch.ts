function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * fetch with backoff on 429 / 5xx. Honors the `retry-after` header when present.
 * Returns the final Response (even if still an error) so callers handle status.
 */
export async function fetchWithRetry(
  input: string | URL,
  init?: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const { retries = 3, baseDelayMs = 1000, maxDelayMs = 30_000 } = opts;

  let res: Response | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    res = await fetch(input, init);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === retries) return res;

    const retryAfter = Number(res.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, maxDelayMs)
      : Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
    await sleep(delay + Math.random() * 250); // jitter
  }
  // Unreachable, but satisfies the type checker.
  return res as Response;
}

/**
 * Run `fn` over `items` with bounded concurrency, preserving input order.
 * Used to keep discovery from hammering the X API when resolving many handles.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
