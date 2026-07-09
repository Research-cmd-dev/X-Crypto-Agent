import { serverEnv } from "@/lib/env";

/**
 * Configured xAI / Grok client using the official OpenAI SDK (compatible).
 * Base URL: https://api.x.ai/v1
 * Uses XAI_API_KEY and GROK_MODEL.
 *
 * Grok supports built-in `web_search` tool (via Responses API) + function
 * calling for structured synthesis.
 *
 * We use dynamic import for the OpenAI class to ensure consistent behavior
 * (ESM/CJS interop) with responses.create + built-in tools.
 */
let cached: any = null;
let OpenAIClass: any = null;

async function getOpenAIClass() {
  if (!OpenAIClass) {
    const mod = await import("openai");
    OpenAIClass = mod.default || mod;
  }
  return OpenAIClass;
}

export async function grokClient() {
  if (cached) return cached;
  const OpenAI = await getOpenAIClass();
  cached = new OpenAI({
    apiKey: serverEnv().XAI_API_KEY,
    baseURL: "https://api.x.ai/v1",
  });
  return cached;
}

export function grokModel(): string {
  return serverEnv().GROK_MODEL;
}

// Legacy sync aliases (will break if used, but kept for reference; main code uses async now)
export { grokModel as claudeModel };
// Note: anthropic/grokClient is now async - callers were updated.
