import { z } from "zod";
import { grokClient, grokModel } from "@/lib/llm/client";
import { AgentRefusalError } from "@/lib/llm/errors";

export interface StructuredOptions<S extends z.ZodType> {
  /** Name used in error messages / logging + the emitted tool name. */
  agent: string;
  schema: S;
  system: string;
  /** The user-turn prompt (typically evidence + the analysis task). */
  prompt: string;
  maxTokens?: number;
}

/**
 * Run a single structured-output completion via forced tool (function) use:
 * Grok emits its answer as the arguments to a one-off function whose JSON
 * Schema is derived from `schema`, which we then validate with Zod.
 *
 * Uses xAI Responses API + custom function tool (forced via tool_choice).
 * We use tool calling (not strict JSON mode) for the same reason as before:
 * large complex schemas are more reliable this way. Failure-tolerant downstream.
 *
 * Throws AgentRefusalError (if surfaced) or Error on missing/ invalid output.
 */
export async function parseStructured<S extends z.ZodType>({
  agent,
  schema,
  system,
  prompt,
  maxTokens = 2048, // lowered default to control costs; complex schemas still fit
}: StructuredOptions<S>): Promise<z.infer<S>> {
  const client = await grokClient();
  const toolName = `emit_${agent.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 64);

  // Convert Zod -> JSON Schema (compatible with function parameters)
  const parameters = z.toJSONSchema(schema, { target: "draft-2020-12" });

  // Use chat.completions for reliable custom function calling / forced tool.
  // (Responses API is preferred for built-in tools like web_search; chat.completions
  // has more consistent support for forcing a specific function in the current SDK.)
  const response = await client.chat.completions.create({
    model: grokModel(),
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: toolName,
          description: `Emit the structured ${agent} analysis result as JSON.`,
          parameters,
        },
      },
    ],
    tool_choice: { type: "function", function: { name: toolName } },
    max_tokens: maxTokens,
  });

  const choice = response.choices?.[0];
  const message = choice?.message;
  let toolCall = message?.tool_calls?.find((t: any) => t.function?.name === toolName) || message?.tool_calls?.[0];

  if (!toolCall && (choice as any)?.message?.function_call) {
    toolCall = (choice as any).message.function_call;
  }

  if (!toolCall) {
    // Last resort: model may have returned plain text JSON
    const text = message?.content || "";
    if (text) {
      try {
        const parsed = JSON.parse(text.trim().replace(/^```json|```$/g, "").trim());
        return schema.parse(parsed);
      } catch {}
    }
    throw new Error(`Agent "${agent}" returned no structured tool output`);
  }

  // Extract arguments (standard chat.completions shape)
  const argsRaw = toolCall.function?.arguments || "{}";
  let args: any = typeof argsRaw === "string" ? JSON.parse(argsRaw) : argsRaw;

  return schema.parse(args) as z.infer<S>;
}
