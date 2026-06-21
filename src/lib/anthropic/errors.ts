/** Raised when Claude declines a request (stop_reason === "refusal"). */
export class AgentRefusalError extends Error {
  constructor(
    public readonly agent: string,
    public readonly category?: string | null,
    public readonly explanation?: string | null,
  ) {
    super(
      `Agent "${agent}" refused${category ? ` (${category})` : ""}${
        explanation ? `: ${explanation}` : ""
      }`,
    );
    this.name = "AgentRefusalError";
  }
}
