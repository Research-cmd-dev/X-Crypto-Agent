import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, claudeModel } from "@/lib/anthropic/client";
import { AgentRefusalError } from "@/lib/anthropic/errors";

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
 * Run a single structured-output completion via forced tool use: Claude emits
 * its answer as the input to a one-off tool whose JSON Schema is derived from
 * `schema`, which we then validate with Zod.
 *
 * We deliberately use non-strict tool use rather than grammar-constrained
 * (strict) structured outputs: the report schemas are large enough that the
 * strict-output grammar compiler rejects them ("the compiled grammar is too
 * large"). Tool use has no such limit. Orchestrator nodes are failure-tolerant
 * and scores are clamped downstream, so an occasional out-of-shape field
 * degrades a single slice rather than aborting the run.
 *
 * Throws AgentRefusalError on a safety refusal, or a plain Error if no tool
 * output came back / validation failed.
 */
export async function parseStructured<S extends z.ZodType>({
  agent,
  schema,
  system,
  prompt,
  maxTokens = 4096,
}: StructuredOptions<S>): Promise<z.infer<S>> {
  const client = anthropic();
  const toolName = `emit_${agent.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 64);
  const inputSchema = z.toJSONSchema(schema, {
    target: "draft-2020-12",
  }) as unknown as Anthropic.Tool.InputSchema;

  const message = await client.messages.create({
    model: claudeModel(),
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: prompt }],
    tools: [
      {
        name: toolName,
        description: `Emit the structured ${agent} analysis result.`,
        input_schema: inputSchema,
      },
    ],
    tool_choice: { type: "tool", name: toolName },
  });

  if (message.stop_reason === "refusal") {
    throw new AgentRefusalError(agent);
  }

  const block = message.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error(`Agent "${agent}" returned no structured tool output`);
  }
  return schema.parse(block.input) as z.infer<S>;
}
