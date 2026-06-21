import type { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import {
  anthropic,
  claudeModel,
  BETA_STRUCTURED_OUTPUTS,
} from "@/lib/anthropic/client";
import { AgentRefusalError } from "@/lib/anthropic/errors";

export interface StructuredOptions<S extends z.ZodType> {
  /** Name used in error messages / logging. */
  agent: string;
  schema: S;
  system: string;
  /** The user-turn prompt (typically evidence + the analysis task). */
  prompt: string;
  maxTokens?: number;
}

/**
 * Run a single structured-output completion: Claude returns JSON validated
 * against `schema`. Throws AgentRefusalError on a safety refusal, or a plain
 * Error if no parsed output came back.
 */
export async function parseStructured<S extends z.ZodType>({
  agent,
  schema,
  system,
  prompt,
  maxTokens = 4096,
}: StructuredOptions<S>): Promise<z.infer<S>> {
  const client = anthropic();
  const message = await client.beta.messages.parse({
    model: claudeModel(),
    max_tokens: maxTokens,
    // System prompt is stable across candidates → cache it to cut cost.
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: prompt }],
    output_format: betaZodOutputFormat(schema),
    betas: [BETA_STRUCTURED_OUTPUTS],
  });

  if (message.stop_reason === "refusal") {
    throw new AgentRefusalError(agent);
  }

  const parsed = message.parsed_output;
  if (parsed == null) {
    throw new Error(`Agent "${agent}" returned no parsed structured output`);
  }
  return parsed as z.infer<S>;
}
