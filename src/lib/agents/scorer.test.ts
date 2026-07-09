import { describe, it, expect } from "vitest";
import { runScorer, deriveStructuralRedFlags } from "@/lib/agents/scorer";
import { makeReport } from "@/lib/schema/fixtures";

describe("runScorer + structural flags", () => {
  it("adds structural no_github / no_website flags and merges with existing", () => {
    const report = makeReport({
      github: { url: null, detected: false, score: 0, activity: "", stars: null, relevance: "", recentCommits: null, contributors: null, notes: "" },
      website: { url: null, detected: false, score: 0, design: "", documentation: "", roadmap: "", teamInfo: "", githubLinksOnSite: [], notes: "" },
      redFlags: [{ severity: "med", code: "bot_engagement", message: "Looks fake." }],
    });
    const { scores, redFlags } = runScorer(report);
    const codes = redFlags.map((f) => f.code);
    expect(codes).toContain("no_github");
    expect(codes).toContain("no_website");
    expect(codes).toContain("bot_engagement");
    expect(scores.overall).toBeGreaterThanOrEqual(0);
  });

  it("adds low_follower_quality flag when quality is very poor", () => {
    const report = makeReport({
      profile: { followerQuality: { score: 10, notes: "purchased" } },
    });
    const flags = deriveStructuralRedFlags(report);
    expect(flags.some((f) => f.code === "low_follower_quality")).toBe(true);
  });

  it("produces a valid breakdown even for a minimal report", () => {
    const { scores } = runScorer(makeReport());
    expect(["High", "Monitor", "Avoid"]).toContain(scores.verdict);
    expect(scores.overall).toBeGreaterThanOrEqual(0);
    expect(scores.overall).toBeLessThanOrEqual(100);
  });
});
