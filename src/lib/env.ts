import { z } from "zod";

/**
 * Server-side environment. Validated lazily so the Next.js client bundle and
 * `next build` never require secrets to be present — only the code paths that
 * actually touch a service (jobs, API routes, scripts) call `serverEnv()`.
 */
const serverSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  CLAUDE_MODEL: z.string().min(1).default("claude-opus-4-8"),

  X_API_BEARER_TOKEN: z.string().min(1, "X_API_BEARER_TOKEN is required"),

  GITHUB_TOKEN: z.string().optional(),
  COINGECKO_API_KEY: z.string().optional(),

  // On-chain providers for the Solana memecoin funnel (optional → mock fallback).
  GMGN_API_KEY: z.string().optional(),
  BIRDEYE_API_KEY: z.string().optional(),
  BITQUERY_API_KEY: z.string().optional(),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | null = null;

/** Parse + cache the server environment. Throws a readable error if invalid. */
export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid server environment:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/**
 * Public (browser-safe) environment. Only NEXT_PUBLIC_* values. These are
 * inlined by Next.js at build time, so read them directly.
 */
export const publicEnv = {
  SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
};
