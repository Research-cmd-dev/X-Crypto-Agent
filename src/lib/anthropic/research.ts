import type Anthropic from "@anthropic-ai/sdk";
import {
  anthropic,
  claudeModel,
  BETA_WEB_FETCH,
} from "@/lib/anthropic/client";

export interface ResearchOptions {
  system: string;
  prompt: string;
  maxTokens?: number;
  /** Max web_search invocations. */
  maxUses?: number;
  /** Allow Claude to fetch full page content (web_fetch). */
  allowFetch?: boolean;
  /** Restrict searches/fetches to these domains, if provided. */
  allowedDomains?: string[];
}

const MAX_PAUSE_CONTINUATIONS = 4;

/**
 * Phase 1 of the two-phase agent pattern: let Claude research with the
 * server-side web_search / web_fetch tools and return the gathered evidence as
 * plain text. A second `parseStructured` call then turns that evidence into the
 * validated report slice. Keeping research and formatting in separate calls
 * avoids mixing tool-use with forced structured output.
 */
export async function researchText({
  system,
  prompt,
  maxTokens = 4096,
  maxUses = 5,
  allowFetch = true,
  allowedDomains,
}: ResearchOptions): Promise<string> {
  const client = anthropic();

  const tools: Anthropic.Beta.BetaToolUnion[] = [
    {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: maxUses,
      ...(allowedDomains ? { allowed_domains: allowedDomains } : {}),
    },
  ];
  if (allowFetch) {
    tools.push({
      type: "web_fetch_20250910",
      name: "web_fetch",
      ...(allowedDomains ? { allowed_domains: allowedDomains } : {}),
    });
  }

  const betas = allowFetch ? [BETA_WEB_FETCH] : [];
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: prompt },
  ];

  let response = await client.beta.messages.create({
    model: claudeModel(),
    max_tokens: maxTokens,
    // Stable system prompt → cache it to cut cost across candidates.
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    tools,
    messages,
    betas,
  });

  // Server-side tools may pause a long turn; re-send to continue.
  let guard = 0;
  while (response.stop_reason === "pause_turn" && guard++ < MAX_PAUSE_CONTINUATIONS) {
    messages.push({
      role: "assistant",
      // Response blocks are accepted as assistant input by the API on resume.
      content: response.content as unknown as Anthropic.Beta.BetaContentBlockParam[],
    });
    response = await client.beta.messages.create({
      model: claudeModel(),
      max_tokens: maxTokens,
      system,
      tools,
      messages,
      betas,
    });
  }

  return response.content
    .filter(
      (b): b is Anthropic.Beta.BetaTextBlock => b.type === "text",
    )
    .map((b) => b.text)
    .join("\n")
    .trim();
}
