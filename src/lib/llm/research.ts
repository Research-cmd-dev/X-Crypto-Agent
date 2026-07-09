import OpenAI from "openai";
import { grokClient, grokModel } from "@/lib/llm/client";

// Simple in-memory research cache (keyed by normalized prompt + domains).
// Keeps costs down by avoiding duplicate web research on same targets.
const researchCache = new Map<string, { result: string; ts: number }>();
const CACHE_TTL_MS = 1000 * 60 * 60 * 2; // 2 hours

function cacheKey(prompt: string, domains?: string[]): string {
  const norm = prompt.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
  const d = (domains || []).sort().join(',');
  return `${norm}|${d}`;
}

export interface ResearchOptions {
  system: string;
  prompt: string;
  maxTokens?: number;
  /** Max search tool uses (passed via tool config if supported). */
  maxUses?: number;
  /** Ignored for Grok (its web_search does browsing); kept for signature compat. */
  allowFetch?: boolean;
  /** Restrict searches to these domains. */
  allowedDomains?: string[];
}

/**
 * Phase 1 of the two-phase agent pattern: let Grok research using its built-in
 * server-side `web_search` tool (real-time web + page browse) and return the
 * gathered evidence as plain text. A second `parseStructured` call then turns
 * that evidence into the validated report slice.
 *
 * Grok's web_search is analogous (and often stronger for crypto/X topics) to the
 * previous Claude web_search + web_fetch betas.
 */
export async function researchText({
  system,
  prompt,
  maxTokens = 4096,
  allowedDomains,
}: ResearchOptions): Promise<string> {
  const key = cacheKey(prompt, allowedDomains);
  const cached = researchCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.result;
  }

  const client = await grokClient();

  const tools: any[] = [
    {
      type: "web_search",
      ...(allowedDomains ? { filters: { allowed_domains: allowedDomains } } : {}),
    },
  ];

  const input: OpenAI.Responses.ResponseInputItem[] = [
    { role: "system", content: system },
    { role: "user", content: prompt },
  ];

  const response = await client.responses.create({
    model: grokModel(),
    input,
    tools,
    max_output_tokens: maxTokens,
  });

  // Grok Responses returns synthesized text after server-side tool execution.
  // Prefer output_text when present; fall back to concatenating text parts.
  const anyResp = response as any;

  // Common happy paths for xAI Responses (final synthesized text after server-side web_search)
  let result = '';
  if (typeof anyResp.output_text === "string" && anyResp.output_text.trim()) {
    result = anyResp.output_text.trim();
  } else if (Array.isArray(anyResp.output)) {
    const parts: string[] = [];
    for (const item of anyResp.output) {
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      if (item?.type === "text" || item?.type === "message") {
        const c = item.content;
        if (typeof c === "string") parts.push(c);
        else if (Array.isArray(c)) {
          for (const p of c) {
            if (p?.type === "text" && typeof p.text === "string") parts.push(p.text);
            else if (typeof p === "string") parts.push(p);
          }
        }
      } else if (item?.type === "output_text" || item?.text) {
        parts.push(item.text || item.output_text);
      }
    }
    result = parts.filter(Boolean).join("\n").trim();
  } else {
    const candidate = anyResp.text || anyResp.content || anyResp.output_text;
    if (typeof candidate === "string" && candidate.trim()) result = candidate.trim();
  }

  if (!result && anyResp.citations) {
    result = (JSON.stringify({ text: anyResp.citations }) || "").trim();
  }
  if (!result) {
    result = (JSON.stringify(response) || "").trim();
  }

  researchCache.set(key, { result, ts: Date.now() });
  return result;
}
