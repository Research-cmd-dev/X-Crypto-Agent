import Anthropic from "@anthropic-ai/sdk";
import { serverEnv } from "@/lib/env";

/**
 * Configured Anthropic client. The SDK automatically respects ANTHROPIC_BASE_URL
 * if set (proxy / gateway). Model defaults to claude-opus-4-8 via env.
 *
 * Note: this project targets @anthropic-ai/sdk 0.70.x, where structured outputs
 * and web tools live under the `client.beta.messages` namespace.
 */
let cached: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (cached) return cached;
  cached = new Anthropic({ apiKey: serverEnv().ANTHROPIC_API_KEY });
  return cached;
}

export function claudeModel(): string {
  return serverEnv().CLAUDE_MODEL;
}

// Beta flags required by the features we use on this SDK version.
export const BETA_STRUCTURED_OUTPUTS = "structured-outputs-2025-11-13";
export const BETA_WEB_FETCH = "web-fetch-2025-09-10";
