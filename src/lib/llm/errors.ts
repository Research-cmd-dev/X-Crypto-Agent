/** Raised when the model declines a request (refusal / safety). Kept for compat. */
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
